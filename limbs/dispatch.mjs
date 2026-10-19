/**
 * dispatch —— 任务单的完整下发闭环（L1.2 + L2.1 + L3.1 的收口）。
 *
 * 一条命令做完四件事：
 *   1. 读任务单，渲染成固定格式的下发文本
 *   2. 异步投递到 DSH（不阻塞在 DSH 的 RPC 上）
 *   3. 阻塞等 turn/end 事件落到 hana-bridge 日志（事件驱动，不是轮询 DSH 状态）
 *   4. 把会话号与回报写回任务单，状态推进到 running
 *
 * 边界：不置 done。done 必须由大脑逐条核对验收标准后手工置位，
 * 这是 SCHEMA.md 定死的规矩，dispatch 不越权。
 *
 * 用法：
 *   node dispatch.mjs --task T20261019-05-xxxx [--session session-xxx] [--timeout 600]
 *
 * 退出码：0 = 收到回报；1 = 超时未收到；2 = 参数或状态错误
 */

import { readFileSync, existsSync } from "node:fs";
import {
  rpc,
  submit,
  DEFAULT_PROVIDER,
  DEFAULT_MODEL,
} from "../DSH-Desktop-Bridge/bin/dsh-core.mjs";
import { load, setState, render } from "./tasks.mjs";
import { audit } from "./audit.mjs";
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

function out(o) {
  process.stdout.write(JSON.stringify(o, null, 2) + "\n");
}

/** 该会话当前最大 turn 号。turn 号单调递增，用它做基线比时间戳可靠。 */
function maxTurn(sid) {
  if (!existsSync(LOG)) return 0;
  let m = 0;
  for (const line of readFileSync(LOG, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t);
      if (o.kind === "turn/end" && o.sessionId === sid) m = Math.max(m, Number(o.turn) || 0);
    } catch {
      /* 跳过坏行 */
    }
  }
  return m;
}

const taskId = arg("task");
if (!taskId || taskId === true) {
  out({ error: "need --task" });
  process.exit(2);
}
const timeoutSec = Number(arg("timeout", 600));
const pollMs = Number(arg("interval", 2000));

let task;
try {
  task = load(String(taskId));
} catch (ex) {
  out({ error: String(ex?.message || ex) });
  process.exit(2);
}
if (task.state !== "queued" && task.state !== "dispatched") {
  out({ error: `task state is ${task.state}; dispatch only accepts queued or dispatched`, taskId });
  process.exit(2);
}

const t0 = Date.now();

/* 1. 会话 */
let sid = arg("session");
const reused = !!(sid && sid !== true);
if (!reused) {
  const created = await rpc("session/create", { request: {} });
  sid = created.sessionId;
  await rpc("session/selectModel", {
    request: { sessionId: sid, provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL },
  });
}
sid = String(sid);

const baseline = maxTurn(sid);

/* 2. 投递 */
const prompt = render(task);
await submit(sid, prompt);
audit("dispatch", "submit", {
  target: taskId,
  ok: true,
  detail: { sessionId: sid, reusedSession: reused, promptChars: prompt.length },
});

if (task.state === "queued") {
  setState(taskId, "dispatched", { sessionId: sid, note: `dispatch -> ${sid}` });
}

/* 3. 等事件 */
const deadline = Date.now() + timeoutSec * 1000;
let hit = null;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, pollMs));
  if (!existsSync(LOG)) continue;
  for (const line of readFileSync(LOG, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t);
      if (o.kind === "turn/end" && o.sessionId === sid && (Number(o.turn) || 0) > baseline) {
        hit = o;
        break;
      }
    } catch {
      /* 跳过坏行 */
    }
  }
  if (hit) break;
}

const elapsed = Date.now() - t0;

if (!hit) {
  audit("dispatch", "timeout", {
    target: taskId,
    ok: false,
    ms: elapsed,
    detail: { sessionId: sid, timeoutSec },
    error: "no turn/end within timeout",
  });
  out({ taskId, sessionId: sid, phase: "timeout", timeoutSec, elapsedMs: elapsed, baselineTurn: baseline });
  process.exit(1);
}

/* 4. 回写 */
setState(taskId, "running", { sessionId: sid, note: `turn ${hit.turn} completed in ${elapsed}ms` });
audit("dispatch", "complete", {
  target: taskId,
  ok: true,
  ms: elapsed,
  detail: { sessionId: sid, turn: hit.turn, textChars: hit.textChars },
});

out({
  taskId,
  sessionId: sid,
  phase: "returned",
  turn: hit.turn,
  elapsedMs: elapsed,
  text: hit.text,
  next: "逐条核对验收标准后，用 tasks.mjs set --state done 结单",
});
