/**
 * hana-bridge —— 装进 DSH 的 host 插件（只读通知版）。
 *
 * 职责边界（刻意保守）：
 *   - 只**订阅**事件并往外写一行 JSON，不拦截、不改写任何决策；
 *   - 审批请求一律 `next()`，即在 DSH 自己的流程里正常处理，界面照旧能应答；
 *   - 卸载时逐个退订。
 *
 * 事件写法取自 DSHana 运行时的同一层 API（已核对源码）：
 *   - 会话事件：`ctx.on("session/event", (session, event) => …)`；
 *     `session` 是会话对象（取 `.id`），`event.type` 才是内层类型，如 `assistant/message`；
 *     工具调用不是独立事件，而是 assistant/message 里 `content[].type === "tool-call"` 的项。
 *   - 审批：`ctx.on("approval/request", (request, next) => …, { global: true, prepend: true })`，
 *     handler 返回值即决策，`next()` 表示不认领、交还 DSH 自己的流程。
 *   - 实测：`ctx.on("<内层事件名>", …)` 会注册成功但永不触发——别用内层类型当事件名。
 *   - 实测：cordis 上下文上直接可取的键极少（只有 `fiber`），服务要走依赖注入。
 *
 * 防洪：每个事件类型只采样前 3 条，之后只统计；assistant/message 除外（每轮都要）。
 * 输出：<DSH_HOME>/logs/hana-bridge-events.jsonl（可用 HANA_BRIDGE_OUT 覆盖）。
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const name = "hana-bridge";
export const inject = [];

const OUT_DIR =
  process.env.HANA_BRIDGE_OUT_DIR || join(process.env.APPDATA || "", "dsh-desktop", "harness", "logs");

/**
 * 按天分片：hana-bridge-events-YYYYMMDD.jsonl。
 * 单一文件会被五十多个会话的事件无限撑大，读取方每次都要读全文。
 * HANA_BRIDGE_OUT 仍可强制写到单文件，仅供调试。
 */
function outPath() {
  if (process.env.HANA_BRIDGE_OUT) return process.env.HANA_BRIDGE_OUT;
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  return join(OUT_DIR, `hana-bridge-events-${stamp}.jsonl`);
}

const SAMPLE_LIMIT = 3;

function write(obj) {
  try {
    const p = outPath();
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, JSON.stringify(obj) + "\n", "utf8");
  } catch {
    /* 写不进去也不该影响 DSH */
  }
}

function brief(v, max = 200) {
  try {
    if (v === null || v === undefined) return null;
    if (typeof v === "string") return v.slice(0, max);
    if (typeof v === "number" || typeof v === "boolean") return v;
    return JSON.stringify(v).slice(0, max);
  } catch {
    return "<unserializable>";
  }
}

function sessionIdOf(a, b) {
  const cands = [a, b];
  for (const c of cands) {
    if (typeof c === "string" && c) return c.slice(0, 64);
    const id = c && c.agent && c.agent.session && c.agent.session.id;
    if (typeof id === "string") return id.slice(0, 64);
    const id2 = c && typeof c.id === "string" ? c.id : null;
    if (id2) return id2.slice(0, 64);
  }
  return null;
}

export function apply(ctx, config = {}) {
  const subs = [];
  const callbackUrl = typeof config.callbackUrl === "string" ? config.callbackUrl.trim() : "";
  const callbackTokenFile = typeof config.callbackTokenFile === "string" ? config.callbackTokenFile : "";
  const callbackSessionIds = Array.isArray(config.callbackSessionIds) ? new Set(config.callbackSessionIds.filter((id) => typeof id === "string")) : new Set();
  let callbackAllowed = false;
  try {
    const url = new URL(callbackUrl);
    callbackAllowed = url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port === "45999" && url.pathname === "/dsh-event" && !url.search && !url.hash;
  } catch {
    /* Callback remains disabled for malformed URLs. */
  }

  async function postProbe(sessionId, event, text) {
    if (!callbackAllowed || !callbackTokenFile || !sessionId || !text || !callbackSessionIds.has(sessionId)) return;
    let callbackToken;
    try { callbackToken = readFileSync(callbackTokenFile, "utf8").trim(); } catch { return; }
    if (callbackToken.length < 32 || callbackToken.length > 256) return;
    const turn = event?.data?.turn;
    const seq = event?.seq;
    const idempotencyKey = `dsh:${sessionId}:${turn ?? seq ?? "unknown"}`;
    try {
      const res = await fetch(callbackUrl, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${callbackToken}` },
        body: JSON.stringify({
          type: "dsh-turn-end",
          at: new Date().toISOString(),
          source: "dsh-desktop-bridge",
          idempotencyKey,
          text,
        }),
      });
      write({ kind: "callback/post", url: callbackUrl, status: res.status, ok: res.ok, idempotencyKey });
    } catch (ex) {
      write({ kind: "callback/fail", url: callbackUrl, error: brief(ex?.message || ex), idempotencyKey });
    }
  }
  const counts = new Map();
  const sampled = new Map();
  const assistantTextByTurn = new Map();

  const sub = (evt, fn, opts) => {
    try {
      const off = opts ? ctx.on(evt, fn, opts) : ctx.on(evt, fn);
      if (typeof off === "function") subs.push(off);
      write({ kind: "subscribe/ok", evt, opts: opts ? Object.keys(opts) : null });
    } catch (ex) {
      write({ kind: "subscribe/fail", evt, error: brief(ex?.message || ex) });
    }
  };

  write({ kind: "plugin/loaded", at: new Date().toISOString(), pid: process.pid, node: process.version });
  try {
    const keys = Object.keys(ctx).sort();
    write({ kind: "ctx/keys", count: keys.length, keys: keys.slice(0, 80) });
  } catch (ex) {
    write({ kind: "ctx/keys-fail", error: brief(ex?.message || ex) });
  }

  // 会话事件：唯一权威入口
  const onSessionEvent = (a, b) => {
    try {
      const sessionId = sessionIdOf(a, b);
      const evt = a && typeof a === "object" && typeof a.type === "string" ? a : b && typeof b === "object" && typeof b.type === "string" ? b : null;
      const type = evt ? evt.type : "<no-type>";
      counts.set(type, (counts.get(type) || 0) + 1);
      const n = sampled.get(type) || 0;

      if (type === "turn/end" && evt) {
        const turn = evt?.data?.turn;
        const turnKey = `${sessionId}:${turn ?? "unknown"}`;
        const record = assistantTextByTurn.get(turnKey);
        const reason = evt?.data?.reason;
        const fallback = reason?.kind === "error" ? `DSH turn failed: ${reason.error?.message || "unknown error"}` : "DSH turn completed without assistant text.";

        // 完成信号落盘：这是「大脑」判断末端何时结束的唯一权威依据。
        // 不依赖 HTTP 回调，落盘即生效，读方按行偏移增量消费。
        write({
          kind: "turn/end",
          at: new Date().toISOString(),
          sessionId,
          turn: turn ?? null,
          reasonKind: reason?.kind ?? null,
          reasonError: reason?.kind === "error" ? brief(reason?.error?.message, 300) : null,
          textChars: (record?.text || "").length,
          text: brief(record?.text || fallback, 800),
        });

        void postProbe(sessionId, evt, record?.text || fallback);
        assistantTextByTurn.delete(turnKey);
      }

      if (type === "assistant/message" && evt) {
        const content = evt?.data?.message?.content;
        const items = Array.isArray(content) ? content : [];
        const texts = items.filter((c) => c && c.type === "text" && typeof c.text === "string").map((c) => c.text);
        const assistantText = texts.join("\n").trim();
        const assistantTurn = evt?.data?.turn;
        if (sessionId && assistantText && assistantTurn !== undefined) assistantTextByTurn.set(`${sessionId}:${assistantTurn}`, { text: assistantText });
        const calls = items.filter((c) => c && c.type === "tool-call");
        write({
          kind: "assistant/message",
          at: new Date().toISOString(),
          sessionId,
          textChars: texts.join("").length,
          text: brief(texts.join("\n"), 300),
          toolCalls: calls.map((c) => ({ callId: brief(c.id ?? c.callId, 48), name: brief(c.name, 48) })),
        });
        return;
      }

      if (n < SAMPLE_LIMIT) {
        sampled.set(type, n + 1);
        write({
          kind: "session/event",
          at: new Date().toISOString(),
          sessionId,
          type,
          sampleNo: n + 1,
          keys: evt && evt.data && typeof evt.data === "object" ? Object.keys(evt.data).slice(0, 12) : null,
          raw: brief(evt, 240),
        });
      } else if (n === SAMPLE_LIMIT) {
        sampled.set(type, n + 1);
        write({ kind: "session/event", at: new Date().toISOString(), type, note: "sampling-stopped" });
      }
    } catch {
      /* 忽略 */
    }
  };

  // 会话事件：唯一权威入口（实测 global 与默认注册都能收到；只留一份，避免重复写入）
  sub("session/event", onSessionEvent, { global: true });

  // 审批请求：只通知，决策交还 DSH 自己的流程
  sub(
    "approval/request",
    (request, next) => {
      try {
        write({
          kind: "approval/request",
          at: new Date().toISOString(),
          sessionId: sessionIdOf(request),
          toolName: brief(request?.toolName ?? request?.name, 64),
          callId: brief(request?.callId, 64),
          reason: brief(typeof request?.reason === "string" ? request.reason : null, 200),
        });
      } catch {
        /* 忽略 */
      }
      return typeof next === "function" ? next() : undefined;
    },
    { global: true, prepend: true },
  );

  return () => {
    for (const off of subs) {
      try {
        off();
      } catch {
        /* 忽略 */
      }
    }
    try {
      write({ kind: "counts", at: new Date().toISOString(), counts: Object.fromEntries(counts) });
    } catch {
      /* 忽略 */
    }
    write({ kind: "plugin/unloaded", at: new Date().toISOString() });
  };
}
