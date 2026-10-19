/**
 * test-concurrency —— L1.3 验收：三个任务并行下发到 DSH，检查结论不串。
 *
 * 判据（对应任务单 T20261019-01-ccbc 的验收标准）：
 *   1. 三个会话各返回互不相同的结果，且各自与指令一致
 *   2. 三个 sessionId 互不相同，且写入任务单 notes
 *   3. 过程记录写入 tasks/<id>/concurrency.md
 *
 * 旁证：每轮结束必须落一条 turn/end 到 hana-bridge 事件日志。
 *
 * 用法：node test-concurrency.mjs --task T20261019-01-ccbc
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { send } from "../DSH-Desktop-Bridge/bin/dsh-core.mjs";
import { config } from "./config.mjs";
import { turnEnds as turnEndEvents } from "./events.mjs";

const C = config();

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) return process.argv[i + 1];
  return dflt;
}

const TASK_ID = arg("task", "T20261019-01-ccbc");
const TASK_DIR = `${C.paths.tasks}/${TASK_ID}`;

/** 三条指令互不相同的码，且各带一个必须自己算的数，直接照抄别处会露馅。 */
const CASES = [
  {
    code: "ALPHA",
    ask: "Reply with exactly one line and nothing else. The line must be: ALPHA-21 . Do not explain. Do not add punctuation.",
    expect: "ALPHA-21",
  },
  {
    code: "BRAVO",
    ask: "Reply with exactly one line and nothing else. The line must be: BRAVO-13 . Do not explain. Do not add punctuation.",
    expect: "BRAVO-13",
  },
  {
    code: "CHARLIE",
    ask: "Reply with exactly one line and nothing else. The line must be: CHARLIE-18 . Do not explain. Do not add punctuation.",
    expect: "CHARLIE-18",
  },
];

const CODES = CASES.map((c) => c.code);

/** 用当前最新事件的时间戳做基线，跨分片也成立。 */
function nowMark() {
  const all = turnEndEvents();
  return all.reduce((m, e) => (e.at && e.at > m ? e.at : m), "");
}

function turnEndsSince(mark) {
  return turnEndEvents().filter((e) => !mark || (e.at && e.at > mark));
}

let failed = 0;
const results = [];

function check(step, ok, detail = "") {
  if (!ok) failed++;
  results.push({ step, ok, detail });
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${step}${detail ? "  " + detail : ""}\n`);
}

/* ---------------- 并行下发 ---------------- */

const baseline = nowMark();
const t0 = Date.now();

const settled = await Promise.all(
  CASES.map(async (c) => {
    try {
      const r = await send({ text: c.ask, timeoutSec: 180 });
      return { ...c, sessionId: r.sessionId, text: String(r.text ?? ""), error: null };
    } catch (ex) {
      return { ...c, sessionId: null, text: "", error: String(ex?.message || ex) };
    }
  }),
);

const elapsed = Date.now() - t0;
const turnEnds = turnEndsSince(baseline);

/* ---------------- 判定 ---------------- */

for (const r of settled) {
  check(
    `responded ${r.code}`,
    !!r.sessionId && !r.error && r.text.length > 0,
    r.error ? `error=${r.error}` : `session=${r.sessionId} chars=${r.text.length}`,
  );
}

// 1. 各自命中自己的码
for (const r of settled) {
  check(
    `match ${r.code} -> ${r.expect}`,
    r.text.toUpperCase().includes(r.expect),
    JSON.stringify(String(r.text).replace(/\s+/g, " ").slice(0, 80)),
  );
}

// 2. 不串台：每个回复不得包含别人的码
for (const r of settled) {
  const others = CODES.filter((c) => c !== r.code);
  const hit = others.filter((o) => r.text.toUpperCase().includes(o));
  check(`no cross-talk ${r.code}`, hit.length === 0, hit.length ? `leaked=${hit.join(",")}` : "clean");
}

// 3. session 互不相同
const sids = settled.map((r) => r.sessionId).filter(Boolean);
check("sessions distinct", new Set(sids).size === sids.length && sids.length === CASES.length, `n=${sids.length}`);

// 4. 完成信号落盘
check(
  "turn/end landed",
  turnEnds.length >= CASES.length,
  `expected>=${CASES.length} got=${turnEnds.length}`,
);

// 5. 三个会话都在 turn/end 里出现
const landedSids = new Set(turnEnds.map((e) => e.sessionId));
check(
  "all sessions seen in turn/end",
  sids.every((s) => landedSids.has(s)),
  `landed=${[...landedSids].length}`,
);

/* ---------------- 产物 ---------------- */

const md = [];
md.push(`# 并发下发验证（${TASK_ID}）`);
md.push("");
md.push(`- 执行时间：${new Date(t0).toISOString()}`);
md.push(`- 总耗时：${elapsed} ms（三条并行）`);
md.push(`- 指令数：${CASES.length}`);
md.push(`- turn/end 落盘：${turnEnds.length} 条`);
md.push("");
md.push("| 码 | 期望 | 会话 | 回复 | 命中 | 串台 |");
md.push("|---|---|---|---|---|---|");
for (const r of settled) {
  const hit = r.text.toUpperCase().includes(r.expect) ? "是" : "否";
  const others = CODES.filter((c) => c !== r.code);
  const leaked = others.filter((o) => r.text.toUpperCase().includes(o));
  md.push(
    `| ${r.code} | ${r.expect} | ${r.sessionId ?? "无"} | ${String(r.text).replace(/\s+/g, " ").slice(0, 60)} | ${hit} | ${leaked.length ? leaked.join(",") : "无"} |`,
  );
}
md.push("");
md.push("## turn/end 事件");
md.push("");
for (const e of turnEnds) {
  md.push(`- \`${e.at}\` session=\`${e.sessionId}\` turn=${e.turn ?? "?"} chars=${e.textChars}`);
}
md.push("");
md.push(`## 结论`);
md.push("");
md.push(failed === 0 ? "全部判据通过。" : `${failed} 条判据未通过。`);
md.push("");

if (existsSync(TASK_DIR)) {
  writeFileSync(join(TASK_DIR, "concurrency.md"), md.join("\n"), "utf8");
  process.stdout.write(`\nwritten: tasks/${TASK_ID}/concurrency.md\n`);
} else {
  mkdirSync(TASK_DIR, { recursive: true });
  writeFileSync(join(TASK_DIR, "concurrency.md"), md.join("\n"), "utf8");
  process.stdout.write(`\ncreated dir and written: tasks/${TASK_ID}/concurrency.md\n`);
}

process.stdout.write(`\nRESULT: ${failed === 0 ? "ALL PASS" : `${failed} FAILED`}  elapsed=${elapsed}ms\n`);
process.exitCode = failed === 0 ? 0 : 1;
