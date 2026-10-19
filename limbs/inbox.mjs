/**
 * inbox —— DSH 完成信号的消费端（L2.1 的读侧）。
 *
 * 事实（2026-10-19 实测）：
 *   hana-bridge 插件把会话事件写到
 *   %APPDATA%\dsh-desktop\harness\logs\hana-bridge-events.jsonl
 *   每轮结束时写一行 {"kind":"turn/end", sessionId, turn, reasonKind, text}
 *   这是判断「末端何时干完」的唯一权威依据，不需要 HTTP 回调，也不需要轮询 DSH 内部状态。
 *
 * 用法：
 *   node inbox.mjs             # 读上次之后的新完成事件
 *   node inbox.mjs --all       # 读全部历史 turn/end
 *   node inbox.mjs --json      # 机器可读
 *   node inbox.mjs --reset     # 把偏移重置到文件末尾（丢弃积压）
 *
 * 偏移按行号保存，日志被清空或轮转时自动回退到 0，不会读到错位内容。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { audit } from "./audit.mjs";
import { config } from "./config.mjs";

const C = config();
const LOG = process.env.HANA_BRIDGE_LOG || C.dsh.bridgeLogPath;
const STATE_DIR = C.stateDir;
const OFFSET_FILE = join(STATE_DIR, "inbox-offset.json");

const args = process.argv.slice(2);
const all = args.includes("--all");
const asJson = args.includes("--json");
const reset = args.includes("--reset");

function loadOffset() {
  try {
    const c = JSON.parse(readFileSync(OFFSET_FILE, "utf8"));
    if (typeof c?.line === "number") return c.line;
  } catch {
    /* 首次运行 */
  }
  return 0;
}

function saveOffset(line) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(OFFSET_FILE, JSON.stringify({ line, savedAt: new Date().toISOString() }), "utf8");
  } catch {
    /* 写不了偏移就下次重读，不影响正确性 */
  }
}

if (!existsSync(LOG)) {
  process.stdout.write(JSON.stringify({ error: "log not found", path: LOG }) + "\n");
  process.exitCode = 1;
} else {
  const raw = readFileSync(LOG, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim());

  let offset = all ? 0 : loadOffset();
  // 文件被清空或轮转后，旧偏移会越界，直接回退
  if (offset > lines.length) offset = 0;

  if (reset) {
    saveOffset(lines.length);
    process.stdout.write(JSON.stringify({ reset: true, offset: lines.length, total: lines.length }) + "\n");
  } else {
    const events = [];
    let malformed = 0;
    for (let i = offset; i < lines.length; i++) {
      try {
        const o = JSON.parse(lines[i]);
        if (o && o.kind === "turn/end") events.push(o);
      } catch {
        malformed++;
      }
    }
    saveOffset(lines.length);

    if (events.length > 0) {
      audit("inbox", "consume", {
        target: `offset ${offset}->${lines.length}`,
        ok: true,
        detail: { scanned: lines.length - offset, newTurnEnds: events.length },
      });
    }

    if (asJson) {
      process.stdout.write(
        JSON.stringify(
          {
            scanned: lines.length - offset,
            malformed,
            newTurnEnds: events.length,
            offsetBefore: offset,
            offsetAfter: lines.length,
            events,
          },
          null,
          2,
        ) + "\n",
      );
    } else {
      process.stdout.write(
        `inbox  scanned=${lines.length - offset}  newTurnEnds=${events.length}  offset ${offset} -> ${lines.length}\n`,
      );
      for (const e of events) {
        const flag = e.reasonKind === "error" ? "ERROR" : "DONE ";
        process.stdout.write(
          `${flag}  ${e.at}  session=${e.sessionId}  turn=${e.turn ?? "?"}  chars=${e.textChars}\n`,
        );
        if (e.text) {
          const oneLine = String(e.text).replace(/\s+/g, " ").slice(0, 220);
          process.stdout.write(`       ${oneLine}\n`);
        }
      }
      if (events.length === 0) process.stdout.write("(no new completion events)\n");
    }
  }
}
