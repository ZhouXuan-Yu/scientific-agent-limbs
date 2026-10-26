/**
 * artifact-sweep —— 从 Bot 工作区里找回「写错位置」的产物。
 *
 * 背景（2026-10-26 实测）：任务单已经写明产物目录是 tasks/<id>/，团队仍会把
 * 报告写进自己工作区的 research/ 或别处。后果是 tasks show 的产物清单为空、
 * sync 扫不到，外部看起来像「跑了两小时什么都没产出」——而实际上东西都在，
 * 只是没人知道去哪找。
 *
 * 做法：投递前对整个工作区拍一次签名快照，完成后拍第二次，diff 出新增与改动，
 * 把有产出价值的那几类文件搬进任务目录。不依赖团队守约定，也不猜测路径。
 *
 * 边界：只搬文档、数据、图、代码。跳过依赖目录、缓存、任务单本体和状态文件，
 * 避免把 node_modules 或 state.json 一起抄进来。
 */

import { readdirSync, statSync, existsSync, mkdirSync, cpSync } from "node:fs";
import { join, dirname } from "node:path";

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".cache",
  "dist",
  "build",
  "__pycache__",
  ".venv",
  "venv",
]);

const RECOVER_EXT =
  /[.](md|txt|json|csv|tsv|py|mjs|js|yaml|yml|tex|bib|png|jpg|jpeg|svg|pdf|html|docx|xlsx)$/i;

/** 递归记录 相对路径 -> "mtime:size" 签名。深度上限防止扫进大型依赖目录。 */
export function snapshotDir(root, base = root, depth = 0) {
  const map = new Map();
  if (depth > 6 || !existsSync(root)) return map;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return map;
  }
  for (const e of entries) {
    const full = join(root, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      for (const [k, v] of snapshotDir(full, base, depth + 1)) map.set(k, v);
    } else if (e.isFile()) {
      try {
        const st = statSync(full);
        map.set(full.slice(base.length + 1), `${st.mtimeMs}:${st.size}`);
      } catch {
        /* 读不到就跳过，不为一个文件让整次回收失败 */
      }
    }
  }
  return map;
}

/** 新增或被改动的相对路径。 */
export function diffSnapshot(before, after) {
  const changed = [];
  for (const [rel, sig] of after) if (before.get(rel) !== sig) changed.push(rel);
  return changed;
}

/** 判断某个相对路径该不该被搬走。 */
export function isRecoverable(rel, taskId) {
  const owned = join("tasks", taskId);
  if (rel === owned || rel.startsWith(owned + "\\") || rel.startsWith(owned + "/")) return false;
  if (/^tasks[\\/][^\\/]+[.]json$/.test(rel)) return false;
  if (/[\\/](state|config|package-lock)[.]json$/.test(rel)) return false;
  return RECOVER_EXT.test(rel);
}

/** 把差异里该搬的文件搬进 localDir，返回实际搬动的相对路径清单。 */
export function recoverChanged(botWs, localDir, changed, taskId) {
  const copied = [];
  const failed = [];
  for (const rel of changed) {
    if (!isRecoverable(rel, taskId)) continue;
    try {
      const dst = join(localDir, rel);
      mkdirSync(dirname(dst), { recursive: true });
      cpSync(join(botWs, rel), dst, { force: true });
      copied.push(rel);
    } catch (ex) {
      failed.push(`${rel}: ${String(ex?.message || ex)}`);
    }
  }
  return { copied, failed };
}
