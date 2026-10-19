/**
 * events —— hana-bridge 事件日志的统一读取层。
 *
 * 问题：插件把 50 多个会话的事件全写进一个 jsonl，读取方每次 readFileSync 全文。
 * 351KB 时是 9 毫秒，长到几十 MB 之后每次等待都要读一遍，越来越慢。
 *
 * 方案：
 *   写入侧按天分片 hana-bridge-events-YYYYMMDD.jsonl
 *   读取侧只读最近 N 天的分片，外加兼容旧的单文件（不再增长，可择机归档）
 *
 * 关键约束：同一轮的事件（assistant/message 和 turn/end）可能跨零点分到两个文件，
 * 所以默认读 3 天，不是 1 天。
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { config } from "./config.mjs";

const LOG_PATH = process.env.HANA_BRIDGE_LOG || config().dsh.bridgeLogPath;
const DIR = dirname(LOG_PATH);
const SHARD_RE = /^hana-bridge-events-\d{8}\.jsonl$/;

/** 要读的文件列表：旧单文件在前（历史），分片按日期升序在后。 */
export function eventFiles({ days = 3 } = {}) {
  const files = [];
  if (existsSync(LOG_PATH) && basename(LOG_PATH) === "hana-bridge-events.jsonl") {
    files.push(LOG_PATH);
  }
  if (existsSync(DIR)) {
    const shards = readdirSync(DIR).filter((f) => SHARD_RE.test(f)).sort();
    files.push(...shards.slice(-days).map((f) => join(DIR, f)));
  }
  return files;
}

/** 读全部事件对象（已解析），坏行跳过。 */
export function readEvents({ days = 3 } = {}) {
  const out = [];
  for (const f of eventFiles({ days })) {
    let text;
    try {
      text = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t));
      } catch {
        /* 跳过坏行 */
      }
    }
  }
  return out;
}

/** 只取 turn/end，可选按会话过滤。 */
export function turnEnds({ sessions = null, days = 3 } = {}) {
  const set = sessions ? new Set(sessions) : null;
  return readEvents({ days }).filter(
    (o) => o && o.kind === "turn/end" && (!set || (o.sessionId && set.has(o.sessionId))),
  );
}

/** 每个会话当前最大的 turn 号，用作等待基线。 */
export function maxTurns({ sessions = null, days = 3 } = {}) {
  const map = new Map();
  for (const e of turnEnds({ sessions, days })) {
    map.set(e.sessionId, Math.max(map.get(e.sessionId) || 0, Number(e.turn) || 0));
  }
  return map;
}

/** 诊断：当前读的是哪几个文件、各多大。 */
export function stats({ days = 3 } = {}) {
  return eventFiles({ days }).map((f) => {
    let bytes = 0;
    try {
      bytes = readFileSync(f).length;
    } catch {
      /* ignore */
    }
    return { file: f, bytes };
  });
}

const invoked = process.argv[1] ? process.argv[1].replace(/\\/g, "/") : "";
if (invoked.endsWith("/events.mjs")) {
  const cmd = process.argv[2] || "files";
  if (cmd === "files") {
    process.stdout.write(JSON.stringify(stats(), null, 2) + "\n");
  } else if (cmd === "count") {
    const ev = readEvents();
    const kinds = {};
    for (const e of ev) kinds[e.kind || "?"] = (kinds[e.kind || "?"] || 0) + 1;
    process.stdout.write(JSON.stringify({ total: ev.length, kinds }, null, 2) + "\n");
  } else {
    process.stdout.write(JSON.stringify({ error: "unknown command", usage: "node events.mjs [files|count]" }) + "\n");
    process.exitCode = 2;
  }
}
