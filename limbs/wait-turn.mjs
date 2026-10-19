/**
 * wait-turn —— 等一个或多个 DSH 会话的下一轮结束（L2.1 的推送侧）。
 *
 * 为什么要有这个：大脑不能靠猜「干完了没」。DSH 的 turn/end 会落进
 * hana-bridge 事件日志，但事件到达时不会主动叫醒任何人。
 * 把这个「等」做成一个阻塞命令，它就能作为后台任务被 wait_for_tasks 等，
 * 从而在事件到达的那一刻把大脑唤醒 —— 不需要平台级执行注入。
 *
 * 判据：该 sessionId 的 turn 号大于启动时的基线。turn 号单调递增，不依赖时间戳。
 *
 * 用法：
 *   node wait-turn.mjs --session session-xxx [--timeout 600]
 *   node wait-turn.mjs --session s1 --session s2 --session s3        # 任一完成即返回
 *   node wait-turn.mjs --sessions s1,s2,s3 --mode all                # 等全部完成
 *
 * 退出码：0 = 达成条件；1 = 超时；2 = 参数错误
 * 输出一行 JSON，便于调用方直接解析。
 */

import { readFileSync, existsSync } from "node:fs";
import { config } from "./config.mjs";

const LOG = process.env.HANA_BRIDGE_LOG || config().dsh.bridgeLogPath;

function arg(name, dflt) {
  for (const flag of [`--${name}`, `-${name}`]) {
    const i = process.argv.indexOf(flag);
    if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) return process.argv[i + 1];
    if (i >= 0) return true;
  }
  return dflt;
}

/** 收集所有同名参数（--session 可重复）。 */
function argAll(name) {
  const out = [];
  process.argv.forEach((v, i) => {
    if (v === `--${name}` && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) {
      out.push(process.argv[i + 1]);
    }
  });
  return out;
}

const sessions = argAll("session");
const multi = arg("sessions");
if (multi && multi !== true) sessions.push(...String(multi).split(",").map((s) => s.trim()).filter(Boolean));
const unique = [...new Set(sessions)];

if (unique.length === 0) {
  process.stdout.write(JSON.stringify({ error: "need --session or --sessions" }) + "\n");
  process.exit(2);
}

const mode = String(arg("mode", "any"));
if (mode !== "any" && mode !== "all") {
  process.stdout.write(JSON.stringify({ error: "mode must be any|all" }) + "\n");
  process.exit(2);
}

const timeoutSec = Number(arg("timeout", 600));
const pollMs = Number(arg("interval", 2000));
const deadline = Date.now() + timeoutSec * 1000;
const t0 = Date.now();

/** 扫一遍日志，按会话归集 turn/end。 */
function scan() {
  const map = new Map();
  if (!existsSync(LOG)) return map;
  for (const line of readFileSync(LOG, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t);
      if (o.kind !== "turn/end" || !o.sessionId) continue;
      if (!unique.includes(o.sessionId)) continue;
      const arr = map.get(o.sessionId) || [];
      arr.push(o);
      map.set(o.sessionId, arr);
    } catch {
      /* 跳过坏行 */
    }
  }
  return map;
}

const initial = scan();
const baseline = new Map();
for (const sid of unique) {
  const arr = initial.get(sid) || [];
  baseline.set(sid, arr.reduce((m, e) => Math.max(m, Number(e.turn) || 0), 0));
}

process.stdout.write(
  JSON.stringify({
    phase: "watching",
    mode,
    sessions: unique,
    baseline: Object.fromEntries(baseline),
    timeoutSec,
  }) + "\n",
);

const hits = new Map(); // sid -> event

function collect() {
  const now = scan();
  for (const sid of unique) {
    if (hits.has(sid)) continue;
    const base = baseline.get(sid) || 0;
    const found = (now.get(sid) || []).find((e) => (Number(e.turn) || 0) > base);
    if (found) hits.set(sid, found);
  }
  if (mode === "any") return hits.size > 0;
  return hits.size === unique.length;
}

while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, pollMs));
  if (collect()) {
    process.stdout.write(
      JSON.stringify({
        phase: "hit",
        mode,
        waitedMs: Date.now() - t0,
        hits: [...hits.entries()].map(([sid, e]) => ({
          sessionId: sid,
          turn: e.turn,
          at: e.at,
          reasonKind: e.reasonKind ?? null,
          textChars: e.textChars ?? null,
          text: e.text ?? null,
        })),
        pending: unique.filter((s) => !hits.has(s)),
      }) + "\n",
    );
    process.exit(0);
  }
}

process.stdout.write(
  JSON.stringify({
    phase: "timeout",
    mode,
    waitedMs: Date.now() - t0,
    hits: [...hits.entries()].map(([sid, e]) => ({ sessionId: sid, turn: e.turn, at: e.at })),
    pending: unique.filter((s) => !hits.has(s)),
  }) + "\n",
);
process.exit(1);
