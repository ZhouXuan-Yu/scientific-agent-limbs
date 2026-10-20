/**
 * botstate —— 读 ds-bot 的团队状态（只读，不写）。
 *
 * 关键事实（2026-10-19 实测纠正）：
 *   群聊消息存在 `<bot home>/state.json` 的 `rooms[].log`，**不在 `exchanges`**。
 *   我最初查 exchanges 得出「外部投递不通」的结论是错的，白白绕了一圈。
 *
 * 用途：
 *   - 判断团队任务何时真正结束（轮询 log 的 seq，安静即完成）
 *   - 取出这期间团队说了什么，作为过程证据
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.mjs";

/** ds-bot 的数据目录。默认与 workspace 同级。 */
export function botHome() {
  const ws = config().bot?.workspace || "";
  // workspace 通常是 <home>/workspace，home 是它的上一级
  return process.env.BOT_HOME || (ws ? join(ws, "..") : "");
}

export function statePath() {
  return join(botHome(), "state.json");
}

function readState() {
  const p = statePath();
  if (!existsSync(p)) throw new Error(`bot state not found: ${p}`);
  return JSON.parse(readFileSync(p, "utf8"));
}

function findRoom(s, roomId) {
  const rooms = s.rooms || {};
  const arr = Array.isArray(rooms) ? rooms : Object.values(rooms);
  if (!roomId) return arr[0] || null;
  return arr.find((r) => r.id === roomId) || null;
}

/** 群聊当前状态：seq、成员、公告、日志。 */
export function roomState(roomId) {
  const s = readState();
  const r = findRoom(s, roomId || config().bot?.roomSessionId);
  if (!r) throw new Error(`room not found: ${roomId || "(default)"}`);
  return {
    id: r.id,
    name: r.name,
    admin: r.admin,
    mode: r.mode,
    notice: r.notice || null,
    members: r.members || [],
    // 成员主 session → 群内隐藏 session 的映射。漏了它，memberReplies 就什么都读不到。
    sessions: r.sessions || {},
    seq: r.seq || 0,
    log: r.log || [],
  };
}

/** 自 sinceSeq 之后的新条目。 */
export function roomDelta(roomId, sinceSeq) {
  const r = roomState(roomId);
  return r.log.filter((e) => (e.seq || 0) > sinceSeq).map((e) => ({
    seq: e.seq,
    who: e.who,
    botId: e.botId || null,
    text: String(e.text || ""),
  }));
}

/**
 * 收集群内各成员自己 session 的最新一条助手回复。
 *
 * 为什么要这个：群聊 log 只记录「在群里说的话」。Bot 之间的私下协作不进 log。
 * 2026-10-19 实测：审稿完成了 16 步的完整抽查（含 4 条 MAJOR 意见），
 * 回复就在它自己的 session 里，群聊 seq 停在 Chief 最后一句。只看 log 会漏掉整个审查环节。
 */
export async function memberReplies(roomId, { maxMessages = 6, textLimit = 3000 } = {}) {
  const room = roomState(roomId);
  const hidden = room.sessions || {};
  if (!Object.keys(hidden).length) return [];

  const mod = await import("../DSH-Desktop-Bridge/bin/dsh-core.mjs");
  const list = await mod.rpc("session/list", { _request: {} });
  const items = list.items || [];

  const out = [];
  for (const [mainSid, hiddenSid] of Object.entries(hidden)) {
    const it = items.find((s) => s.sessionId === hiddenSid);
    if (!it?.projections?.asOfSeq) continue;
    try {
      const page = await mod.rpc("session/page", {
        request: {
          address: { kind: "session", sessionId: hiddenSid },
          throughSeq: it.projections.asOfSeq,
          maxMessages,
        },
      });
      const msgs = (page.records || [])
        .map((z) => z.event)
        .filter((e) => e && e.type === "assistant/message");
      const last = msgs[msgs.length - 1];
      if (!last) continue;
      const text = (last.data?.message?.content || [])
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      if (!text.trim()) continue;
      out.push({
        sessionId: hiddenSid,
        mainSession: mainSid,
        title: it.projections.values?.title || null,
        turns: it.projections.values?.sessionStats?.turns ?? null,
        chars: text.length,
        text: text.slice(0, textLimit),
      });
    } catch {
      /* 单个成员读失败不影响其他的 */
    }
  }
  return out;
}

/**
 * 等到群聊日志安静：连续 quietMs 无新增，或总超时。
 * 团队任务有多轮（接单 / 派单 / 执行 / 复核），等第一轮 turn/end 会漏掉大半。
 */
export async function waitQuiet(roomId, sinceSeq, { quietMs = 90000, timeoutMs = 900000, pollMs = 5000 } = {}) {
  const start = Date.now();
  let lastSeq = sinceSeq;
  let lastChange = Date.now();

  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, pollMs));
    let cur;
    try {
      cur = roomState(roomId).seq;
    } catch {
      continue; // 文件正在被写时可能读到半截，下一轮再试
    }
    if (cur !== lastSeq) {
      lastSeq = cur;
      lastChange = Date.now();
      continue;
    }
    if (Date.now() - lastChange >= quietMs) {
      return { quiet: true, seq: lastSeq, waitedMs: Date.now() - start, entries: roomDelta(roomId, sinceSeq) };
    }
  }
  return { quiet: false, seq: lastSeq, waitedMs: Date.now() - start, entries: roomDelta(roomId, sinceSeq) };
}

const invoked = process.argv[1] ? process.argv[1].replace(/\\/g, "/") : "";
if (invoked.endsWith("/botstate.mjs")) {
  const cmd = process.argv[2] || "room";
  try {
    if (cmd === "room") {
      const r = roomState();
      process.stdout.write(
        JSON.stringify(
          {
            id: r.id,
            name: r.name,
            mode: r.mode,
            admin: r.admin,
            members: r.members.length,
            seq: r.seq,
            entries: r.log.length,
            notice: r.notice ? r.notice.slice(0, 120) : null,
          },
          null,
          2,
        ) + "\n",
      );
    } else if (cmd === "log") {
      const r = roomState();
      const n = Number(process.argv[3] || 10);
      process.stdout.write(
        JSON.stringify(r.log.slice(-n).map((e) => ({ seq: e.seq, who: e.who, text: String(e.text || "").slice(0, 300) })), null, 2) +
          "\n",
      );
    } else {
      process.stdout.write(JSON.stringify({ error: "unknown command", usage: "node botstate.mjs [room|log]" }) + "\n");
      process.exitCode = 2;
    }
  } catch (ex) {
    process.stdout.write(JSON.stringify({ error: String(ex?.message || ex) }) + "\n");
    process.exitCode = 1;
  }
}
