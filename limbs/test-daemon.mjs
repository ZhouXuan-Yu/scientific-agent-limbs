/**
 * test-daemon —— L2.2 验收：状态守护。
 *
 * 测三件事：
 *   1. 卡在 dispatched 但事件日志显示已完成的任务，能被推进到 running
 *   2. 同一轮不会被重复推进（幂等）
 *   3. 摘要里的 pendingReview 正确列出等人工核对的任务
 *
 * 不测常驻模式。常驻靠 --once 的循环复用，单轮正确即可。
 *
 * 用法：node test-daemon.mjs
 */

import { spawnSync } from "node:child_process";
import { rmSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { create, setState, load, patchTask, ROOT } from "./tasks.mjs";
import { turnEnds } from "./events.mjs";
import { config } from "./config.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;
const STATE_FILE = join(config().stateDir, "daemon-state.json");

let failed = 0;
const created = [];

function check(name, ok, detail = "") {
  if (!ok) failed++;
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}\n`);
}

function runDaemon(args) {
  return spawnSync(NODE, [join(HERE, "daemon.mjs"), ...args], { encoding: "utf8", timeout: 60000 });
}

/* ---------------- 前置：找一个真实存在的 turn/end 作为素材 ---------------- */

const ends = turnEnds();
if (ends.length === 0) {
  process.stdout.write("SKIP: 事件日志里没有任何 turn/end，无法构造场景\n");
  process.exit(2);
}
const sample = ends[ends.length - 1];
check("fixture: found a turn/end to replay", !!sample?.sessionId, `session=${sample.sessionId} turn=${sample.turn}`);

/* ---------------- 构造：dispatched 但实际已完成 ---------------- */

const t = create({
  title: "验证 daemon 推进卡住的任务",
  goal: "确认卡在 dispatched 的任务能被事件日志推进到 running。",
  acceptance: ["daemon 一轮后状态为 running"],
  limb: "dsh",
});
created.push(t.id);
setState(t.id, "dispatched");
const before = new Date(new Date(sample.at).getTime() - 1000).toISOString();
patchTask(t.id, { sessionId: sample.sessionId, lastDispatchedAt: before });

check("fixture: task stuck at dispatched", load(t.id).state === "dispatched");

/* ---------------- 第一轮 ---------------- */

const r1 = runDaemon(["--once"]);
check("daemon --once exits cleanly", r1.status === 0, `exit=${r1.status}`);
const after1 = load(t.id);
check("stuck task advanced to running", after1.state === "running", `state=${after1.state}`);
check(
  "advancement recorded in notes",
  (after1.notes || []).some((n) => n.includes("daemon: turn")),
  (after1.notes || []).slice(-1)[0] || "",
);

/* ---------------- 幂等：再跑一轮不应重复推进 ---------------- */

const notesBefore = (after1.notes || []).length;
const r2 = runDaemon(["--once"]);
check("second cycle exits cleanly", r2.status === 0, `exit=${r2.status}`);
const after2 = load(t.id);
check(
  "no duplicate advancement",
  (after2.notes || []).length === notesBefore,
  `notes ${notesBefore} -> ${(after2.notes || []).length}`,
);

/* ---------------- 摘要 ---------------- */

let state = null;
try {
  state = JSON.parse(readFileSync(STATE_FILE, "utf8"));
} catch (ex) {
  check("daemon state file readable", false, String(ex?.message || ex));
}
if (state) {
  check("state file has cycle count", typeof state.cycles === "number" && state.cycles >= 2, `cycles=${state.cycles}`);
  check(
    "pendingReview lists the running task",
    (state.pendingReview || []).some((x) => x.id === t.id),
    `count=${(state.pendingReview || []).length}`,
  );
  check(
    "report is readable without running a cycle",
    (() => {
      const r = runDaemon(["--report"]);
      return r.status === 0 && String(r.stdout).includes("pendingReview");
    })(),
  );
}

/* ---------------- 清理 ---------------- */

for (const id of created) {
  try {
    rmSync(join(ROOT, `${id}.json`), { force: true });
    rmSync(join(ROOT, id), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
check("cleanup", created.every((id) => !existsSync(join(ROOT, `${id}.json`))));

process.stdout.write(`\n${failed === 0 ? "RESULT: ALL PASS" : `RESULT: ${failed} FAILED`}\n`);
process.exitCode = failed === 0 ? 0 : 1;
