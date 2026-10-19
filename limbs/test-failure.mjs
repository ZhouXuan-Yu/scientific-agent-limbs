/**
 * test-failure —— 故障注入验收（L5.2）。
 *
 * 目的：现有验收几乎全是正常路径。这个脚本专测「出错时系统是否正确地报错」，
 * 而不是静默通过或卡死。每个用例都断言「失败被正确识别」，而不是「功能能用」。
 *
 * 六类故障：
 *   1. Zotero 写用过期的 If-Unmodified-Since-Version
 *   2. 任务单做非法状态迁移（done -> running）
 *   3. sweep 对 queued 超时只报告，不擅自置 failed
 *   4. dispatch 对五分钟内重复投递拒绝
 *   5. wait-turn 在事件日志不存在时正确超时而非崩溃
 *   6. setState 对不存在的任务单报错而非静默创建
 *
 * 用法：node test-failure.mjs
 */

import { spawnSync } from "node:child_process";
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { ensureRunning, write, api } from "./zotero-core.mjs";
import { create, setState, load, patchTask, sweep, ROOT } from "./tasks.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;

let failed = 0;
const created = [];
let zoteroItem = null;

function check(name, ok, detail = "") {
  if (!ok) failed++;
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}\n`);
}

function throws(fn) {
  try {
    fn();
    return { threw: false };
  } catch (ex) {
    return { threw: true, msg: String(ex?.message || ex) };
  }
}

/* ---------------- 1. Zotero 版本冲突 ---------------- */

try {
  const run = await ensureRunning();
  if (!run.running) {
    check("zotero available", false, run.note || "not running");
  } else {
    const c = await write("/api/users/0/items", {
      method: "POST",
      body: [{ itemType: "note", note: "limbs failure-injection test", tags: [{ tag: "limbs-failure-test" }] }],
    });
    const s = c.json?.successful?.["0"];
    if (!s?.key) {
      check("create fixture item", false, c.text?.slice(0, 120) || `status=${c.status}`);
    } else {
      zoteroItem = s.key;
      const v = s.version;
      const stale = await write(`/api/users/0/items/${zoteroItem}`, {
        method: "PATCH",
        version: Math.max(0, v - 5),
        body: { tags: [{ tag: "should-not-apply" }] },
      });
      check(
        "stale version rejected",
        !stale.ok,
        `status=${stale.status} expected 412/409`,
      );

      // 反证：用正确 version 应该成功，否则说明失败不是版本造成的
      const fresh = await write(`/api/users/0/items/${zoteroItem}`, {
        method: "PATCH",
        version: v,
        body: { tags: [{ tag: "limbs-failure-test" }, { tag: "applied-ok" }] },
      });
      check("correct version accepted (control)", fresh.ok, `status=${fresh.status}`);
    }
  }
} catch (ex) {
  check("zotero section", false, String(ex?.message || ex));
}

/* ---------------- 2. 非法状态迁移 ---------------- */

const t1 = create({
  title: "故障注入-状态机",
  goal: "验证非法迁移被拒绝",
  acceptance: ["done 之后不可回退"],
  limb: "local",
});
created.push(t1.id);
setState(t1.id, "dispatched");
setState(t1.id, "running");
setState(t1.id, "done");
const back = throws(() => setState(t1.id, "running"));
check("done -> running rejected", back.threw, back.msg || "");

/* ---------------- 3. queued 超时只报告 ---------------- */

const t2 = create({
  title: "故障注入-未下发超时",
  goal: "验证 queued 超时不擅自置 failed",
  acceptance: ["保持在 queued"],
  limb: "local",
  deadlineMinutes: 0,
});
created.push(t2.id);
const sw = sweep({});
const stalledHit = sw.stalled.some((x) => x.id === t2.id);
const stillQueued = load(t2.id).state === "queued";
check("overdue queued reported as stalled", stalledHit);
check("overdue queued not auto-failed", stillQueued, `state=${load(t2.id).state}`);

/* ---------------- 4. dispatch 幂等 ---------------- */

const t3 = create({
  title: "故障注入-重复投递",
  goal: "验证五分钟内重复 dispatch 被拒",
  acceptance: ["第二次返回 exit 2"],
  limb: "dsh",
});
created.push(t3.id);
setState(t3.id, "dispatched");
patchTask(t3.id, { lastDispatchedAt: new Date().toISOString() });

const dup = spawnSync(NODE, [join(HERE, "dispatch.mjs"), "--task", t3.id], {
  encoding: "utf8",
  timeout: 30000,
});
check("duplicate dispatch refused", dup.status === 2, `exit=${dup.status}`);
check(
  "refusal names the guard window",
  String(dup.stdout || "").includes("duplicate dispatch refused"),
  String(dup.stdout || "").slice(0, 60).replace(/\s+/g, " "),
);

/* ---------------- 5. 日志不存在时 wait-turn 的行为 ---------------- */

const missingLog = spawnSync(
  NODE,
  [join(HERE, "wait-turn.mjs"), "--session", "session-does-not-exist", "--timeout", "2", "--interval", "500"],
  {
    encoding: "utf8",
    timeout: 30000,
    env: { ...process.env, HANA_BRIDGE_LOG: "C:/definitely/not/a/real/path/log.jsonl" },
  },
);
check("missing log: exits with timeout code", missingLog.status === 1, `exit=${missingLog.status}`);
check(
  "missing log: no crash trace",
  !String(missingLog.stderr || "").includes("Error:"),
  String(missingLog.stderr || "").slice(0, 60) || "clean",
);

/* ---------------- 6. 不存在的任务单 ---------------- */

const ghost = throws(() => load("T19990101-99-ffff"));
check("missing task rejected", ghost.threw, ghost.msg || "");
const ghostSet = throws(() => setState("T19990101-99-ffff", "dispatched"));
check("missing task set rejected", ghostSet.threw, ghostSet.msg || "");

/* ---------------- 清理 ---------------- */

if (zoteroItem) {
  try {
    const cur = await api(`/api/users/0/items/${zoteroItem}`);
    const ver = cur.json?.version;
    const del = await write(`/api/users/0/items/${zoteroItem}`, { method: "DELETE", version: ver });
    check("cleanup zotero fixture", del.ok || del.status === 404, `status=${del.status}`);
  } catch (ex) {
    check("cleanup zotero fixture", false, String(ex?.message || ex));
  }
}

for (const id of created) {
  try {
    rmSync(join(ROOT, `${id}.json`), { force: true });
    rmSync(join(ROOT, id), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
const leftovers = created.filter((id) => existsSync(join(ROOT, `${id}.json`)));
check("cleanup task fixtures", leftovers.length === 0, leftovers.join(",") || "all removed");

process.stdout.write(`\n${failed === 0 ? "RESULT: ALL PASS" : `RESULT: ${failed} FAILED`}\n`);
process.exitCode = failed === 0 ? 0 : 1;
