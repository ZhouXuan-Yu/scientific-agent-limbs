/**
 * test-tasks —— L3.1 任务单内核自测：状态机、非法迁移、渲染、清理。
 *
 * 只测内核，不碰任何真实任务。测试产生的任务单在结束时删除。
 * 用法：node test-tasks.mjs
 */

import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { create, setState, load, list, render, verifyChecklist, ROOT, STATES } from "./tasks.mjs";

let failed = 0;
const created = [];

function check(step, cond, detail = "") {
  if (!cond) failed++;
  process.stdout.write(`${cond ? "PASS" : "FAIL"}  ${step}${detail ? "  " + detail : ""}\n`);
}

function throws(fn) {
  try {
    fn();
    return { threw: false };
  } catch (ex) {
    return { threw: true, msg: String(ex?.message || ex) };
  }
}

/* 1. 创建 */
const t = create({
  title: "内核自测任务",
  goal: "验证任务单状态机与渲染，不产生任何实际工作。",
  acceptance: ["状态能从 queued 推进到 done", "done 之后不可回退到 running"],
  limb: "local",
});
created.push(t.id);
check("create", t.state === "queued" && STATES.includes(t.state), t.id);
check("id format", /^T\d{8}-\d{2}-[0-9a-f]{4}$/.test(t.id), t.id);
check("artifact dir created", existsSync(join(ROOT, t.id)));

/* 2. 必填字段校验 */
const miss = throws(() => create({ title: "缺字段", limb: "local" }));
check("reject missing fields", miss.threw, miss.msg || "");

const badLimb = throws(() =>
  create({ title: "坏末端", goal: "x", acceptance: ["y"], limb: "unknown" }),
);
check("reject unknown limb", badLimb.threw, badLimb.msg || "");

/* 3. 正常推进 */
const d = setState(t.id, "dispatched", { note: "self-test dispatch", sessionId: "test-session" });
check("queued -> dispatched", d.state === "dispatched", `sessionId=${d.sessionId}`);

const r = setState(t.id, "running");
check("dispatched -> running", r.state === "running");

const done = setState(t.id, "done", { note: "self-test close" });
check("running -> done", done.state === "done");
check("history recorded", done.history.length === 4, `steps=${done.history.length}`);

/* 4. 非法迁移 */
const back = throws(() => setState(t.id, "running"));
check("reject done -> running", back.threw, back.msg || "");

const skip = throws(() => {
  const t2 = create({ title: "跳步", goal: "x", acceptance: ["y"], limb: "local" });
  created.push(t2.id);
  setState(t2.id, "running");
});
check("reject queued -> running (skips dispatched)", skip.threw, skip.msg || "");

/* 5. failed 必须给原因 */
const noReason = throws(() => {
  const t3 = create({ title: "失败无因", goal: "x", acceptance: ["y"], limb: "local" });
  created.push(t3.id);
  setState(t3.id, "dispatched");
  setState(t3.id, "running");
  setState(t3.id, "failed");
});
check("reject failed without reason", noReason.threw, noReason.msg || "");

/* 6. 渲染与核对清单 */
const text = render(load(t.id));
check("render has id", text.includes(t.id));
check("render has numbered acceptance", text.includes("1. 状态能从 queued 推进到 done"));
check("render has artifact dir", text.includes(`tasks/${t.id}/`));

const cl = verifyChecklist(load(t.id));
check("verify checklist", cl.acceptance.length === 2 && cl.acceptance.every((a) => a.checked === false));

/* 7. 列表 */
const all = list();
check("list includes task", all.some((x) => x.id === t.id), `total=${all.length}`);

/* 8. 清理 */
for (const id of created) {
  try {
    rmSync(join(ROOT, `${id}.json`), { force: true });
    rmSync(join(ROOT, id), { recursive: true, force: true });
  } catch (ex) {
    process.stdout.write(`WARN cleanup ${id}: ${String(ex?.message || ex)}\n`);
  }
}
const leftovers = created.filter((id) => existsSync(join(ROOT, `${id}.json`)));
check("cleanup", leftovers.length === 0, leftovers.join(",") || "all removed");

process.stdout.write(`\n${failed === 0 ? "RESULT: ALL PASS" : `RESULT: ${failed} FAILED`}\n`);
process.exitCode = failed === 0 ? 0 : 1;
