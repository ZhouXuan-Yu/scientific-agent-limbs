/**
 * zotero-core —— 桌面 Zotero 的拉起与本地 API 内核。
 *
 * 与 DSH-Desktop-Bridge/bin/dsh-core.mjs 同构，构成「大脑-四肢」桥接层的 L0 层：
 *   端口探活 → 未通则拉起（spawn → PowerShell 两级）→ 等端口就绪 → 吐健康快照。
 *
 * 事实基线（2026-10-19 实测）：
 *   - Zotero 10.0.6，装于 D:\Zotero\zotero.exe
 *   - 本地 API 由 Zotero 内置 HTTP server 提供，无需 API key，默认 127.0.0.1:23119
 *   - 本地 API 仅在 Zotero 进程存活时可用；进程一关，端口即消失
 *   - 响应头可读版本：X-Zotero-Version、Zotero-Server-ID、Total-Results
 *
 * 使用约定：任何依赖 Zotero 的操作，必须先 await ensureRunning()，再 api()。
 * 环境变量：
 *   ZOTERO_EXE              覆盖可执行文件路径
 *   ZOTERO_PORT             覆盖端口（默认 23119）
 *   ZOTERO_NO_AUTOSTART=1   关闭自动拉起，只探活
 *   ZOTERO_START_TIMEOUT_MS 拉起后等待就绪的上限（默认 90000）
 */

import { spawn } from "node:child_process";
import { connect as netConnect } from "node:net";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { audit } from "./audit.mjs";
import { config } from "./config.mjs";

const C = config();
const ZOTERO_EXE = C.zotero.exe;
const PORT = C.zotero.port;
const AUTOSTART = process.env.ZOTERO_NO_AUTOSTART !== "1";
const BASE = `http://127.0.0.1:${PORT}`;
const DEFAULT_TIMEOUT_MS = C.zotero.startTimeoutMs;
const STATE_DIR = C.stateDir;
const KEY_CACHE = join(STATE_DIR, "local-key.json");

export { PORT, BASE, ZOTERO_EXE };

/* --------------------------- 基础探测 --------------------------- */

/** 端口是否在监听。 */
function portOpen(port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolve(v);
    };
    const sock = netConnect({ host: "127.0.0.1", port });
    sock.on("connect", () => finish(true));
    sock.on("error", () => finish(false));
    setTimeout(() => finish(false), timeoutMs);
  });
}

/** 数 Zotero 进程数。Zotero 10 单实例会拉起多个子进程，只用来看「起没起来」，不用来判活。 */
function zoteroProcessCount() {
  return new Promise((resolve) => {
    try {
      const p = spawn("tasklist", ["/FI", "IMAGENAME eq zotero.exe", "/NH"], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      let out = "";
      p.stdout.on("data", (c) => (out += c.toString()));
      p.on("close", () => resolve((out.match(/zotero\.exe/gi) || []).length));
      p.on("error", () => resolve(-1));
    } catch {
      resolve(-1);
    }
  });
}

async function waitProcessCount(before, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const n = await zoteroProcessCount();
    if (n > Math.max(before, 0)) return true;
    await sleep(400);
  }
  return false;
}

async function waitPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portOpen(port)) return true;
    await sleep(700);
  }
  return false;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* --------------------------- 拉起 --------------------------- */

/** 拉起桌面 Zotero。两级机制：直 spawn → 失败则 PowerShell Start-Process。 */
async function launchZotero() {
  const before = await zoteroProcessCount();
  const t0 = Date.now();
  try {
    const child = spawn(ZOTERO_EXE, [], { detached: true, stdio: "ignore" });
    child.unref();
  } catch {
    /* 交给下一级 */
  }
  if (await waitProcessCount(before, 5000)) {
    audit("zotero-core", "launch", { target: "zotero", ok: true, ms: Date.now() - t0, detail: { how: "spawn" } });
    return "spawn";
  }
  try {
    const ps = spawn(
      "powershell",
      ["-NoProfile", "-Command", `Start-Process -FilePath '${ZOTERO_EXE}'`],
      { detached: true, stdio: "ignore" },
    );
    ps.unref();
  } catch {
    /* 两级都失败就上报 */
  }
  if (await waitProcessCount(before, 8000)) {
    audit("zotero-core", "launch", { target: "zotero", ok: true, ms: Date.now() - t0, detail: { how: "powershell" } });
    return "powershell";
  }
  audit("zotero-core", "launch", { target: "zotero", ok: false, ms: Date.now() - t0, error: "both launch methods failed" });
  return null;
}

/**
 * 确保 Zotero 在运行。已在跑则零副作用直接返回，否则拉起并等本地 API 就绪。
 * @returns {{running:boolean, started:boolean, port:number, note:string|null}}
 */
export async function ensureRunning({ timeoutMs = DEFAULT_TIMEOUT_MS, autostart = AUTOSTART } = {}) {
  // 多轮探活，避免瞬时拒绝误判为「未运行」。Zotero 冷启动会拉起 7 个进程，反复误拉代价高。
  if (await waitPort(PORT, 2500)) {
    return { running: true, started: false, port: PORT, note: null };
  }

  // 进程守卫：进程还在但端口不通时，绝不 spawn。
  // Zotero 启动后是 7 个进程的单实例应用，重复拉起会抢库锁、弹重复窗口。
  const alive = await zoteroProcessCount();
  if (alive > 0) {
    if (await waitPort(PORT, 15000)) {
      return { running: true, started: false, port: PORT, note: "port recovered after wait" };
    }
    return {
      running: false,
      started: false,
      port: PORT,
      note: `Zotero process alive (${alive}) but port ${PORT} not answering; refusing to spawn`,
    };
  }
  if (!autostart) {
    return {
      running: false,
      started: false,
      port: PORT,
      note: "Zotero not running; autostart disabled (ZOTERO_NO_AUTOSTART=1)",
    };
  }
  let how = null;
  try {
    how = await launchZotero();
  } catch (ex) {
    return { running: false, started: false, port: PORT, note: "launch failed: " + String(ex?.message || ex) };
  }
  if (!how) {
    return { running: false, started: false, port: PORT, note: "launch failed both ways; start Zotero manually" };
  }
  const ok = await waitPort(PORT, timeoutMs);
  if (!ok) {
    return {
      running: false,
      started: true,
      port: PORT,
      note: `launched but local API not ready within ${Math.round(timeoutMs / 1000)}s`,
    };
  }
  return { running: true, started: true, port: PORT, note: `auto-launched desktop Zotero (via ${how})` };
}

/* --------------------- 写入：Zotero 10+ 本地 API --------------------- */

/**
 * 写入事实（已核官方文档 2026-10-19，zotero.org/support/dev/web_api/v3/local_api）：
 *   - Zotero 10+ 的本地 API 支持 POST / PUT / PATCH / DELETE
 *   - 每个写请求必须带 Zotero-Server-ID 头，缺失返回 428
 *   - 写请求必须带 Zotero-API-Key（本地 key，与 zotero.org 的 API key 无关）
 *   - 本地 key 只能运行时申请：POST /api/local/authorize → 用户在 Zotero 弹窗里授权
 *   - 用户选 Always Allow 时返回 remember:true，key 可长期复用；否则 key 一次性，首个写请求后作废
 *   - 每分钟最多 5 次会弹窗的授权请求，超出返回 429
 *   - 写操作是普通本地改动，Zotero 界面立刻可见，下次同步会上传 zotero.org
 */

let SERVER_ID = null;

/** 读 Zotero-Server-ID（库身份，用于写请求前置与缓存分区）。 */
export async function serverId({ force = false } = {}) {
  if (SERVER_ID && !force) return SERVER_ID;
  const r = await api("/api/");
  SERVER_ID = r.headers.get("zotero-server-id") || null;
  return SERVER_ID;
}

function cacheKey(key, remember, sid) {
  if (!remember) return false;
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(
      KEY_CACHE,
      JSON.stringify({ key, serverId: sid, savedAt: new Date().toISOString() }),
      "utf8",
    );
    return true;
  } catch {
    return false;
  }
}

/** 读取缓存的本地 key（仅限 Always Allow 授权的那一类）。 */
export function cachedKey(sid) {
  try {
    const c = JSON.parse(readFileSync(KEY_CACHE, "utf8"));
    if (c?.key && (!sid || c.serverId === sid)) return c.key;
  } catch {
    /* 未授权过 */
  }
  return null;
}

/** 清掉缓存的 key（调试或撤销授权后使用）。 */
export function clearCachedKey() {
  try {
    writeFileSync(KEY_CACHE, "{}", "utf8");
    return true;
  } catch {
    return false;
  }
}

/**
 * 申请写入授权。会在 Zotero 弹出确认框，必须由用户在界面上点 Allow / Always Allow。
 * 建议选 Always Allow，否则每次写都要重新弹窗。
 */
export async function authorize({ appName = "Hana Agent", timeoutMs = 180000 } = {}) {
  const sid = await serverId();
  if (!sid) return { ok: false, error: "cannot read Zotero-Server-ID" };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}/api/local/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Zotero-Server-ID": sid },
      body: JSON.stringify({ appName }),
      signal: ctl.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* 非 JSON */
    }
    if (res.status === 403) return { ok: false, denied: true, status: 403, body: text };
    if (!res.ok) return { ok: false, status: res.status, body: text };
    const key = json?.key || null;
    const remember = !!json?.remember;
    return {
      ok: !!key,
      key,
      remember,
      status: res.status,
      cached: key ? cacheKey(key, remember, sid) : false,
      note: remember ? "key reusable (Always Allow)" : "key is single-use; next write needs a new authorize",
    };
  } catch (ex) {
    return { ok: false, error: String(ex?.message || ex), timeoutMs };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 写请求。自动带上 Server-ID 与本地 key。
 * 401 表示没有可用 key 或 key 已被消费，调用方应重新 authorize。
 * version 用于写前校验（If-Unmodified-Since-Version），PATCH/DELETE 建议带上。
 */
export async function write(path, { method = "POST", body, authKey, version } = {}) {
  const t0 = Date.now();
  const sid = await serverId();
  const k = authKey || cachedKey(sid);
  const headers = { "Zotero-Server-ID": sid, "Zotero-API-Version": "3" };
  if (k) headers["Zotero-API-Key"] = k;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (version !== undefined) headers["If-Unmodified-Since-Version"] = String(version);

  const res = await fetch(BASE + (path.startsWith("/") ? path : "/" + path), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON 响应 */
  }
  const out = {
    status: res.status,
    ok: res.ok,
    needsAuth: res.status === 401,
    libraryVersion: Number(res.headers.get("last-modified-version") || 0) || null,
    text,
    json,
  };
  audit("zotero-core", "write", {
    target: path,
    ok: res.ok,
    ms: Date.now() - t0,
    detail: { method, status: res.status, needsAuth: out.needsAuth },
    error: res.ok ? null : `HTTP ${res.status}: ${text.slice(0, 200)}`,
  });
  return out;
}

/* --------------------------- 本地 API --------------------------- */

/**
 * 调本地 API。
 * GET 例：api("/api/users/0/items/top?limit=1")
 * 写例：api("/api/users/0/items", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify([...]) })
 * 注意：本地 API 的写操作要求 Content-Type 为 application/json 且 body 是数组。
 */
export async function api(path, init = {}) {
  const url = /^https?:/i.test(path) ? path : BASE + (path.startsWith("/") ? path : "/" + path);
  const res = await fetch(url, {
    ...init,
    headers: { "Zotero-API-Version": "3", ...(init.headers || {}) },
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON 响应保留 text */
  }
  return { status: res.status, ok: res.ok, headers: res.headers, text, json };
}

/** 只读探活，不触发拉起。 */
export async function ping() {
  const open = await portOpen(PORT);
  return { running: open, port: PORT };
}

/** 健康快照：确保在运行，然后读版本、条目数与库版本。 */
export async function health(opts = {}) {
  const run = await ensureRunning(opts);
  if (!run.running) {
    return { ok: false, ...run, version: null, serverId: null, topItems: null, libraryVersion: null };
  }
  try {
    const r = await api("/api/users/0/items/top?limit=1");
    return {
      ok: r.ok,
      running: true,
      started: run.started,
      note: run.note,
      port: PORT,
      version: r.headers.get("x-zotero-version") || null,
      serverId: r.headers.get("zotero-server-id") || null,
      topItems: Number(r.headers.get("total-results") || 0),
      libraryVersion: r.headers.get("last-modified-version") || null,
    };
  } catch (ex) {
    return {
      ok: false,
      running: true,
      started: run.started,
      note: "api error: " + String(ex?.message || ex),
      port: PORT,
      version: null,
      serverId: null,
      topItems: null,
      libraryVersion: null,
    };
  }
}

/** 列顶层分类（含条目数）。 */
export async function collections({ limit = 100 } = {}) {
  const run = await ensureRunning();
  if (!run.running) throw new Error(run.note || "Zotero not running");
  const r = await api(`/api/users/0/collections?limit=${limit}`);
  if (!r.ok) throw new Error(`collections HTTP ${r.status}`);
  return (r.json || []).map((c) => ({
    key: c.key,
    name: c.data?.name,
    items: c.meta?.numItems ?? 0,
    collections: c.meta?.numCollections ?? 0,
  }));
}

/**
 * 单个分类的真实统计。
 *
 * 为什么要先验 key：Zotero 本地 API 对不存在的 collection key **不返回 404**，
 * 而是静默返回全库条目。2026-10-19 小研实测：错误 key 的 /items/top 返回 55，
 * 而全库基线正是 55。数字看着正常，它却不是任何分类的规模。
 * 只有 /collections/<key> 本身才真 404。
 *
 * 两种口径都给：
 *   numItems / topItems  真正的文献条目数，不含附件、笔记、注释
 *   allObjects           含子条目的对象总数（/items 会连附件一起返回）
 */
export async function collectionStats(key) {
  const run = await ensureRunning();
  if (!run.running) throw new Error(run.note || "Zotero not running");
  if (!key || typeof key !== "string") throw new Error("collectionStats needs a key");

  const meta = await api(`/api/users/0/collections/${key}`);
  if (!meta.ok) {
    throw new Error(`collection ${key} not found (HTTP ${meta.status}) — refusing to guess; a bad key would silently return the whole library`);
  }
  const name = meta.json?.data?.name ?? null;
  const numItems = meta.json?.meta?.numItems ?? null;

  const top = await api(`/api/users/0/collections/${key}/items/top?limit=1`);
  const all = await api(`/api/users/0/collections/${key}/items?limit=1`);
  const topItems = Number(top.headers.get("total-results") || 0);
  const allObjects = Number(all.headers.get("total-results") || 0);

  const out = {
    key,
    name,
    numItems,
    topItems,
    allObjects,
    consistent: numItems !== null && numItems === topItems,
  };
  audit("zotero-core", "collectionStats", {
    target: key,
    ok: out.consistent,
    detail: { name, numItems, topItems, allObjects },
    error: out.consistent ? null : "meta.numItems does not match /items/top Total-Results",
  });
  return out;
}

/* --------------------------- CLI --------------------------- */

function out(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}

const invoked = process.argv[1] ? process.argv[1].replace(/\\/g, "/") : "";
// 精确匹配文件名，避免被同名后缀的脚本误触发。
if (invoked.endsWith("/zotero-core.mjs")) {
  const cmd = process.argv[2] || "status";
  try {
    if (cmd === "ping") {
      out(await ping());
    } else if (cmd === "status") {
      out(await health());
    } else if (cmd === "open") {
      out(await ensureRunning());
    } else if (cmd === "collections") {
      out(await collections());
    } else if (cmd === "authorize") {
      out(await authorize({ appName: process.argv[3] || "Hana Agent" }));
    } else {
      out({ error: "unknown command", usage: "node zotero-core.mjs [status|ping|open|collections|authorize]" });
      process.exitCode = 2;
    }
  } catch (ex) {
    out({ error: String(ex?.message || ex) });
    process.exitCode = 1;
  }
}
