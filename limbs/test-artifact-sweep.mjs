/**
 * artifact-sweep 的单元测试。用临时目录造真实结构，不碰真工作区。
 *
 * 覆盖六种情形：
 *   1. 新增文件被识别
 *   2. 改动文件被识别（同路径 mtime/size 变化）
 *   3. 未变文件不被识别
 *   4. 任务自身目录不重复搬（已由 botOutDir 处理）
 *   5. 依赖目录与状态文件被跳过
 *   6. 回收后目标文件内容正确、目录层级保留
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { snapshotDir, diffSnapshot, isRecoverable, recoverChanged } from "./artifact-sweep.mjs";

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? " -> " + detail : ""}`);
  }
}

const root = mkdtempSync(join(tmpdir(), "sweep-"));
const ws = join(root, "ws");
const local = join(root, "local");
const TID = "T20261026-99-0000";

// 初始结构
mkdirSync(join(ws, "research"), { recursive: true });
mkdirSync(join(ws, "tasks", TID), { recursive: true });
mkdirSync(join(ws, "node_modules", "pkg"), { recursive: true });
writeFileSync(join(ws, "research", "old.md"), "old content", "utf8");
writeFileSync(join(ws, "tasks", TID, "existing.md"), "already here", "utf8");
writeFileSync(join(ws, "node_modules", "pkg", "index.js"), "noise", "utf8");
writeFileSync(join(ws, "tasks", "state.json"), "{}", "utf8");

const before = snapshotDir(ws);
console.log(`snapshot: ${before.size} files`);

// 模拟团队干活：新增两处报告、改动一处旧文件
writeFileSync(join(ws, "research", "new-report.md"), "# 新报告\n内容", "utf8");
mkdirSync(join(ws, "research", "deep", "nested"), { recursive: true });
writeFileSync(join(ws, "research", "deep", "nested", "metrics.csv"), "a,b\n1,2", "utf8");
writeFileSync(join(ws, "tasks", TID, "from-task-dir.md"), "in task dir", "utf8");
writeFileSync(join(ws, "research", "old.md"), "old content v2 with more bytes", "utf8");
writeFileSync(join(ws, "node_modules", "pkg", "index.js"), "noise2", "utf8");
writeFileSync(join(ws, "tasks", "state.json"), '{"x":1}', "utf8");
writeFileSync(join(ws, "tasks", `${TID}.json`), '{"id":"x"}', "utf8");
// 确保 mtime 变化（Windows 时钟精度可能不够）
const t = new Date(Date.now() + 2000);
utimesSync(join(ws, "research", "old.md"), t, t);

const after = snapshotDir(ws);
const changed = diffSnapshot(before, after);
console.log(`changed: ${changed.join(" | ")}`);

check("新增文件被识别", changed.includes(join("research", "new-report.md")));
check("嵌套新增被识别", changed.includes(join("research", "deep", "nested", "metrics.csv")));
check("改动文件被识别", changed.includes(join("research", "old.md")));
check("未变文件不被识别", !changed.includes(join("tasks", TID, "existing.md")));
check("node_modules 不进快照", [...after.keys()].every((k) => !k.includes("node_modules")));

check("任务自身目录不重复搬", !isRecoverable(join("tasks", TID, "from-task-dir.md"), TID));
check("任务单本体被跳过", !isRecoverable(join("tasks", `${TID}.json`), TID));
check("state.json 被跳过", !isRecoverable(join("tasks", "state.json"), TID));
check("非产物后缀被跳过", !isRecoverable(join("research", "temp.log"), TID));
check("正常报告可搬", isRecoverable(join("research", "new-report.md"), TID));

const { copied, failed } = recoverChanged(ws, local, changed, TID);
console.log(`copied: ${copied.join(" | ")}`);

check("搬了三个研究文件（含被改动的那份）", copied.length === 3, `got ${copied.length}: ${copied.join(",")}`);
check("无失败项", failed.length === 0, failed.join("; "));
check("新报告落盘", existsSync(join(local, "research", "new-report.md")));
check("嵌套目录保留", existsSync(join(local, "research", "deep", "nested", "metrics.csv")));
check("内容一致", readFileSync(join(local, "research", "new-report.md"), "utf8").includes("新报告"));
check("改动文件被覆盖成新版", readFileSync(join(local, "research", "old.md"), "utf8").includes("v2"));
check("未搬任务目录文件", !existsSync(join(local, "tasks")));

rmSync(root, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
