/**
 * inbox —— DSH 完成信号的消费端（L2.1 的读侧）。
 *
 * 事实（2026-10-19 实测）：
 *   hana-bridge 插件把会话事件按天分片写到
 *   %APPDATA%\dsh-desktop\harness\logs\hana-bridge-events-YYYYMMDD.jsonl
 *   每轮结束时写一行 {"kind":"turn/end", sessionId, turn, reasonKind, text}
 *   这是判断「末端何时干完」的唯一权威依据，不需要 HTTP 回调，也不需要轮询 DSH 内部状态。
 *
 * 偏移语义：记录最后处理过的事件时间戳（不是行号）。
 * 行号在多文件分片下没有意义，时间戳才是稳定的。
 * 旧版 state 文件里的 line 字段会被忽略，首次升级后会重读一次历史事件。
 *
 * 用法：
 *   node inbox.mjs             # 读上次之后的新完成事件
 *   node inbox.mjs --all       # 读全部历史 turn/end
 *   node inbox.mjs --json      # 机器可读
 *   node inbox.mjs --reset     # 把偏移推到最新（丢弃积压）
 *   node inbox.mjs --files     # 看当前读取哪几个分片
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { audit } from "./audit.mjs";
import { config } from "./config.mjs";
import { turnEnds, stats } from "./events.mjs";

const STATE_DIR = config().stateDir;
const OFFSET_FILE = join(STATE_DIR, "inbox-offset.json");

const args = process.argv.slice(2);
const all = args.includes("--all");
const asJson = args.includes("--json");
const reset = args.includes("--reset");
const showFiles = args.includes("--files");

function loadState() {
  try {
    const c = JSON.parse(readFileSync(OFFSET_FILE, "utf8"));
    return { lastTs: typeof c?.lastTs === "string" ? c.lastTs : null };
  } catch {
    return { lastTs: null };
  }
}

function saveState(lastTs) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(OFFSET_FILE, JSON.stringify({ lastTs, savedAt: new Date().toISOString() }), "utf8");
  } catch {
    /* 写不了偏移就下次重读，不影响正确性 */
  }
}

if (showFiles) {
  process.stdout.write(JSON.stringify(stats(), null, 2) + "\n");
} else {
  const events = turnEnds();
  const st = loadState();

  if (reset) {
    const newest = events.reduce((m, e) => (e.at && e.at > m ? e.at : m), "");
    saveState(newest);
    process.stdout.write(JSON.stringify({ reset: true, lastTs: newest, total: events.length }) + "\n");
  } else {
    const fresh = all ? events : events.filter((e) => !st.lastTs || (e.at && e.at > st.lastTs));
    const newest = fresh.reduce((m, e) => (e.at && e.at > m ? e.at : m), st.lastTs || "");
    saveState(newest);

    if (fresh.length > 0) {
      audit("inbox", "consume", {
        target: `lastTs ${st.lastTs ?? "(none)"} -> ${newest}`,
        ok: true,
        detail: { total: events.length, fresh: fresh.length },
      });
    }

    if (asJson) {
      process.stdout.write(
        JSON.stringify(
          { total: events.length, fresh: fresh.length, lastTsBefore: st.lastTs, lastTsAfter: newest, events: fresh },
          null,
          2,
        ) + "\n",
      );
    } else {
      process.stdout.write(
        `inbox  total=${events.length}  fresh=${fresh.length}  lastTs ${st.lastTs ?? "(none)"} -> ${newest}\n`,
      );
      for (const e of fresh) {
        const flag = e.reasonKind === "error" ? "ERROR" : "DONE ";
        process.stdout.write(`${flag}  ${e.at}  session=${e.sessionId}  turn=${e.turn ?? "?"}  chars=${e.textChars}\n`);
        if (e.text) process.stdout.write(`       ${String(e.text).replace(/\s+/g, " ").slice(0, 220)}\n`);
      }
      if (fresh.length === 0) process.stdout.write("(no new completion events)\n");
    }
  }
}
