/**
 * tasks —— 任务单内核（L3.1）。规范见 tasks/SCHEMA.md。
 *
 * 设计边界：
 *   - 单文件 JSON + 同名产物目录，不引数据库
 *   - CLI 参数只接受 ASCII（id、state、file），任何含中文的内容走 --file 读 UTF-8 JSON
 *     原因：Windows PowerShell 对内联中文参数会截断或改写，2026-10-19 已确认
 *   - 状态只能前进；done 必须由大脑逐条核对验收标准后置位
 *
 * 用法：
 *   node tasks.mjs create --file spec.json
 *   node tasks.mjs list [--state running]
 *   node tasks.mjs show T20261019-01-a3f2
 *   node tasks.mjs set T20261019-01-a3f2 --state running [--file patch.json]
 *   node tasks.mjs render T20261019-01-a3f2
 *   node tasks.mjs verify T20261019-01-a3f2
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { randomBytes } from "node:crypto";
import { audit } from "./audit.mjs";
import { config } from "./config.mjs";

const C = config();
const WORKSPACE = C.workspace;

export const ROOT = config().paths.tasks;
export const STATES = ["queued", "dispatched", "running", "done", "failed", "cancelled"];
export const LIMBS = ["dsh", "local", "zotero", "bot"];

const TRANSITIONS = {
  queued: ["dispatched", "cancelled"],
  dispatched: ["running", "done", "failed", "cancelled"],
  running: ["done", "failed", "cancelled"],
  done: [],
  failed: [],
  cancelled: [],
};

const pad2 = (n) => String(n).padStart(2, "0");
const nowIso = () => new Date().toISOString();
const pathOf = (id) => join(ROOT, `${id}.json`);
const dirOf = (id) => join(ROOT, id);

function todayYmd() {
  const d = new Date();
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
}

function nextSeq(ymd) {
  let max = 0;
  try {
    for (const f of readdirSync(ROOT)) {
      const m = f.match(/^T(\d{8})-(\d{2})-[0-9a-f]{4}\.json$/);
      if (m && m[1] === ymd) max = Math.max(max, Number(m[2]));
    }
  } catch {
    /* 目录还不存在 */
  }
  return max + 1;
}

function newId() {
  const ymd = todayYmd();
  return `T${ymd}-${pad2(nextSeq(ymd))}-${randomBytes(2).toString("hex")}`;
}

/* --------------------------- 读取 --------------------------- */

export function load(id) {
  const p = pathOf(id);
  if (!existsSync(p)) throw new Error(`task not found: ${id}`);
  return JSON.parse(readFileSync(p, "utf8"));
}

export function list({ state } = {}) {
  let files = [];
  try {
    files = readdirSync(ROOT).filter((f) => /^T\d{8}-\d{2}-[0-9a-f]{4}\.json$/.test(f));
  } catch {
    return [];
  }
  const all = files.map((f) => {
    try {
      return JSON.parse(readFileSync(join(ROOT, f), "utf8"));
    } catch {
      return null;
    }
  }).filter(Boolean);
  const filtered = state ? all.filter((t) => t.state === state) : all;
  return filtered.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/* --------------------------- 写入 --------------------------- */

function save(task) {
  task.updatedAt = nowIso();
  writeFileSync(pathOf(task.id), JSON.stringify(task, null, 2) + "\n", "utf8");
  return task;
}

export function create(spec) {
  const t0 = Date.now();
  const missing = ["title", "goal", "acceptance", "limb"].filter((k) => {
    const v = spec[k];
    return v === undefined || v === null || (Array.isArray(v) && v.length === 0) || v === "";
  });
  if (missing.length) throw new Error(`missing required field(s): ${missing.join(", ")}`);
  if (!LIMBS.includes(spec.limb)) throw new Error(`limb must be one of ${LIMBS.join("/")}`);

  const id = newId();
  const ts = nowIso();
  // 任务生命周期上限。到期未完成由 sweep 判为 failed，避免任务静默卡死。
  // deadlineMinutes 传 null 表示不设限（不推荐，但允许）。
  const minutes = spec.deadlineMinutes === null ? null : Number(spec.deadlineMinutes ?? 60);
  const deadline = minutes === null || !Number.isFinite(minutes) ? null : new Date(Date.now() + minutes * 60000).toISOString();
  const task = {
    id,
    title: String(spec.title),
    goal: String(spec.goal),
    acceptance: spec.acceptance.map(String),
    limb: spec.limb,
    assignee: spec.assignee ?? null,
    sessionId: spec.sessionId ?? null,
    state: "queued",
    createdAt: ts,
    updatedAt: ts,
    deadline,
    lastDispatchedAt: null,
    dispatchToken: null,
    artifacts: spec.artifacts ?? [],
    failure: null,
    notes: spec.notes ?? [],
    history: [{ at: ts, from: null, to: "queued", note: "created" }],
  };

  mkdirSync(ROOT, { recursive: true });
  mkdirSync(dirOf(id), { recursive: true });
  save(task);
  audit("tasks", "create", { target: id, ok: true, ms: Date.now() - t0, detail: { limb: task.limb, title: task.title.slice(0, 40) } });
  return task;
}

export function setState(id, to, patch = {}) {
  const t0 = Date.now();
  const task = load(id);
  if (!STATES.includes(to)) throw new Error(`unknown state: ${to}`);
  const allowed = TRANSITIONS[task.state] ?? [];
  if (!allowed.includes(to)) {
    throw new Error(`illegal transition ${task.state} -> ${to} (allowed: ${allowed.join("/") || "none"})`);
  }
  if (to === "failed" && !patch.failure) {
    throw new Error("state=failed requires a failure reason");
  }

  const from = task.state;
  task.state = to;
  if (patch.note) task.notes.push(`${nowIso()} | ${patch.note}`);
  if (patch.failure) task.failure = String(patch.failure);
  if (patch.artifacts?.length) task.artifacts = [...new Set([...task.artifacts, ...patch.artifacts])];
  if (patch.sessionId) task.sessionId = patch.sessionId;
  if (patch.assignee) task.assignee = patch.assignee;
  task.history.push({ at: nowIso(), from, to, note: patch.note ?? null });
  const saved = save(task);
  audit("tasks", "setState", {
    target: id,
    ok: true,
    ms: Date.now() - t0,
    detail: { from, to, hasFailure: !!patch.failure, artifacts: (patch.artifacts || []).length },
  });
  return saved;
}

/* --------------------------- 超时清扫 --------------------------- */

const TERMINAL = new Set(["done", "failed", "cancelled"]);

/**
 * 扫所有非终态任务，超截止时间的分两类处理：
 *   - dispatched / running 超时：置 failed，写清原因。任务已经发出去了，不能假装它还在跑。
 *   - queued 超时：只报告，不改状态。还没下发不算失败，可能只是没排上队。
 * 返回 { failed: [...], stalled: [...] }。
 */
export function sweep({ dryRun = false, now = new Date() } = {}) {
  const failed = [];
  const stalled = [];

  for (const t of list()) {
    if (TERMINAL.has(t.state)) continue;
    if (!t.deadline) continue;
    const due = new Date(t.deadline);
    if (Number.isNaN(due.getTime())) continue;
    if (due > now) continue;

    if (t.state === "queued") {
      stalled.push({ id: t.id, state: t.state, deadline: t.deadline, title: t.title });
      continue;
    }

    if (dryRun) {
      failed.push({ id: t.id, state: t.state, deadline: t.deadline, title: t.title, dryRun: true });
      continue;
    }
    try {
      setState(t.id, "failed", {
        failure: `deadline exceeded: due ${t.deadline}, state was ${t.state}`,
        note: "auto-failed by sweep",
      });
      failed.push({ id: t.id, state: t.state, deadline: t.deadline, title: t.title });
    } catch (ex) {
      stalled.push({ id: t.id, state: t.state, reason: String(ex?.message || ex) });
    }
  }

  audit("tasks", "sweep", { ok: true, detail: { failed: failed.length, stalled: stalled.length, dryRun } });
  return { failed, stalled };
}

/* --------------------------- 产物归档（L3.2） --------------------------- */

function walk(dir, base, acc) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, base, acc);
    else {
      const rel = relative(base, full).replace(/\\/g, "/");
      if (rel === "manifest.json") continue; // 清单不登记自己
      acc.push({ rel, bytes: st.size, mtime: st.mtime.toISOString() });
    }
  }
}

/**
 * 扫描任务目录，生成 manifest.json，并把产物路径写回任务单的 artifacts。
 * 产物路径统一为相对 workspace 的正斜杠形式，便于跨平台和反查。
 */
export function syncArtifacts(id) {
  const t0 = Date.now();
  const task = load(id);
  const dir = dirOf(id);
  if (!existsSync(dir)) throw new Error(`artifact dir not found: ${dir}`);

  const files = [];
  walk(dir, dir, files);
  files.sort((a, b) => (a.rel < b.rel ? -1 : 1));

  const manifest = { taskId: id, generatedAt: nowIso(), fileCount: files.length, files };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");

  task.artifacts = files.map((f) => `tasks/${id}/${f.rel}`);
  save(task);

  audit("tasks", "syncArtifacts", { target: id, ok: true, ms: Date.now() - t0, detail: { files: files.length } });
  return manifest;
}

/** 给定路径片段，反查哪些任务单的产物含它。 */
export function findArtifacts(keyword) {
  const k = String(keyword || "").toLowerCase();
  if (!k) return [];
  const out = [];
  for (const t of list()) {
    const hit = (t.artifacts || []).filter((a) => a.toLowerCase().includes(k));
    if (hit.length) out.push({ id: t.id, state: t.state, title: t.title, matches: hit });
  }
  return out;
}

/** 写任意字段，不做状态迁移。用于 dispatchToken / lastDispatchedAt 这类运行标记。 */
export function patchTask(id, fields) {
  const task = load(id);
  Object.assign(task, fields);
  return save(task);
}

/* --------------------------- 渲染与核对 --------------------------- */

/** 渲染成下发给末端的固定文本。 */
export function render(task) {
  const lines = [];
  lines.push(`[任务单 ${task.id}]`);
  lines.push(`目标：${task.goal}`);
  lines.push(`验收标准：`);
  task.acceptance.forEach((a, i) => lines.push(`${i + 1}. ${a}`));
  // 绝对路径：端的工作目录不一定是 workspace，相对路径会落错地方（2026-10-19 真实发生过）。
  lines.push(`产物目录（绝对路径）：${join(WORKSPACE, "tasks", task.id)}`);
  lines.push(`回报要求：完成后回复做了什么、产物路径、哪条验收标准存疑。`);
  return lines.join("\n");
}

/** 返回待人工核对的验收清单。不做自动判卷。 */
export function verifyChecklist(task) {
  return {
    id: task.id,
    state: task.state,
    acceptance: task.acceptance.map((text, i) => ({ no: i + 1, text, checked: false })),
    artifacts: task.artifacts,
    hint: "逐条核对后，用 set --state done 或 --state failed 结单。",
  };
}

/* --------------------------- CLI --------------------------- */

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) return process.argv[i + 1];
  if (i >= 0) return true;
  return dflt;
}

function readJsonArg(name) {
  const p = arg(name);
  if (!p || p === true) return null;
  return JSON.parse(readFileSync(String(p), "utf8"));
}

function out(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}

const invoked = process.argv[1] ? process.argv[1].replace(/\\/g, "/") : "";
// 必须精确匹配文件名，否则 test-tasks.mjs 这类以 tasks.mjs 结尾的脚本 import 时会误触发 CLI。
if (invoked.endsWith("/tasks.mjs")) {
  const cmd = process.argv[2];
  try {
    if (cmd === "create") {
      const spec = readJsonArg("file");
      if (!spec) throw new Error("create requires --file <spec.json>");
      out(create(spec));
    } else if (cmd === "list") {
      const st = arg("state");
      const rows = list({ state: st && st !== true ? String(st) : undefined });
      out(
        rows.map((t) => ({
          id: t.id,
          state: t.state,
          limb: t.limb,
          assignee: t.assignee,
          title: t.title,
        })),
      );
    } else if (cmd === "show") {
      out(load(String(process.argv[3])));
    } else if (cmd === "set") {
      const id = String(process.argv[3]);
      const to = arg("state");
      if (!to || to === true) throw new Error("set requires --state <state>");
      const saved = setState(id, String(to), readJsonArg("file") || {});
      // --sync 显式触发：扫任务目录，生成 manifest，把产物路径回写 artifacts。
      // 不默认做，因为可能在用户没预期的时候改动任务单内容。
      if (process.argv.includes("--sync")) {
        const m = syncArtifacts(id);
        out({ ...load(id), _sync: { files: m.fileCount, manifest: `tasks/${id}/manifest.json` } });
      } else {
        out(saved);
      }
    } else if (cmd === "render") {
      process.stdout.write(render(load(String(process.argv[3]))) + "\n");
    } else if (cmd === "verify") {
      out(verifyChecklist(load(String(process.argv[3]))));
    } else if (cmd === "sync") {
      out(syncArtifacts(String(process.argv[3])));
    } else if (cmd === "sweep") {
      out(sweep({ dryRun: process.argv.includes("--dry") }));
    } else if (cmd === "find") {
      const rows = findArtifacts(String(process.argv[3] || ""));
      out({ count: rows.length, rows });
    } else {
      out({ error: "unknown command", usage: "node tasks.mjs [create|list|show|set|render|verify|sync|sweep|find]" });
      process.exitCode = 2;
    }
  } catch (ex) {
    audit("tasks", cmd ? String(cmd) : "unknown", { ok: false, error: String(ex?.message || ex) });
    out({ error: String(ex?.message || ex) });
    process.exitCode = 1;
  }
}
