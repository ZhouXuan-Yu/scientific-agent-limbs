/**
 * health —— 大脑-四肢桥接层 L0.3：两端统一自检。
 *
 * 一条命令同时报告：
 *   [左腿] DSH     端口 / 会话数 / 本次是否被自动拉起
 *   [记忆] Zotero  版本 / 顶层条目数 / 库版本 / 本次是否被自动拉起
 *
 * 用法：
 *   node health.mjs               # 探活；确认不通才拉起
 *   node health.mjs --no-start    # 只探活，绝不拉起，纯诊断
 *   node health.mjs --json        # 机器可读
 *
 * 退出码：0 = 两端都 ok；1 = 有任意一端不通。
 *
 * 关键设计（来自 2026-10-19 一次真实事故）：
 *   DSH 是单实例应用，误判「未运行」而拉起会让旧实例退出、正在跑的任务中断。
 *   所以这里先用多轮探活自己下结论，确认活着就完全不碰 ensureRunning。
 */

import { connect } from "node:net";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const noStart = args.includes("--no-start");

// 两端 core 的 AUTOSTART 都是模块加载时求值的常量，必须在动态 import 之前设好环境变量。
if (noStart) {
  process.env.DSH_NO_AUTOSTART = "1";
  process.env.ZOTERO_NO_AUTOSTART = "1";
}

const t0 = Date.now();

/* --------------------------- 探活 --------------------------- */

function probe(port, timeoutMs = 1500) {
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
    const sock = connect({ host: "127.0.0.1", port });
    sock.on("connect", () => finish(true));
    sock.on("error", () => finish(false));
    setTimeout(() => finish(false), timeoutMs);
  });
}

/** 多轮探活：任一轮通即算活着。单轮失败不足以判定死亡。 */
async function robustProbe(port, rounds = 3, gapMs = 400) {
  for (let i = 0; i < rounds; i++) {
    if (await probe(port)) return true;
    if (i < rounds - 1) await new Promise((r) => setTimeout(r, gapMs));
  }
  return false;
}

/* --------------------------- 两侧检查 --------------------------- */

const zoteroMod = await import("./zotero-core.mjs");
const dshMod = await import("../DSH-Desktop-Bridge/bin/dsh-core.mjs");

async function checkDsh() {
  const s = Date.now();
  let launch = null;
  try {
    launch = dshMod.lastLaunch();
  } catch {
    launch = null;
  }

  let started = false;
  let note = null;

  if (launch && (await robustProbe(launch.port))) {
    // 已确认在跑。刻意不调用 ensureRunning，避免其内部探活误判把 DSH 重启掉。
  } else if (noStart) {
    return {
      ok: false,
      port: launch?.port ?? null,
      sessions: null,
      started: false,
      note: "unreachable; --no-start so no launch attempted",
      ms: Date.now() - s,
    };
  } else {
    const run = await dshMod.ensureRunning(90000);
    launch = run.launch || launch;
    started = !!run.started;
    note = run.note || null;
    if (!run.launch) {
      return {
        ok: false,
        port: null,
        sessions: null,
        started,
        note: note || "dsh unreachable",
        ms: Date.now() - s,
      };
    }
  }

  let sessions = null;
  let sessionErr = null;
  try {
    const r = await dshMod.listSessions();
    sessions = (r.items || []).length;
  } catch (ex) {
    sessionErr = String(ex?.message || ex);
  }

  return {
    ok: true,
    port: launch?.port ?? null,
    sessions,
    sessionErr,
    started,
    note,
    ms: Date.now() - s,
  };
}

async function checkZotero() {
  const s = Date.now();
  try {
    const h = await zoteroMod.health(noStart ? { autostart: false, timeoutMs: 1 } : {});
    return { ...h, ms: Date.now() - s };
  } catch (ex) {
    return { ok: false, error: String(ex?.message || ex), ms: Date.now() - s };
  }
}

// 串行执行：两个都是 GUI 应用，同时拉起容易互相抢焦点。
const dsh = await checkDsh();
const zotero = await checkZotero();
const allOk = !!dsh.ok && !!zotero.ok;

if (asJson) {
  process.stdout.write(
    JSON.stringify(
      { ok: allOk, checkedAt: new Date().toISOString(), elapsedMs: Date.now() - t0, dsh, zotero },
      null,
      2,
    ) + "\n",
  );
} else {
  const pad = (s, n) => String(s).padEnd(n, " ");
  const tag = (o) => (o ? "ok  " : "FAIL");
  const line = "-".repeat(62);
  const rows = [];
  rows.push(`${pad("Hana", 8)}${pad(tag(true), 6)}agent process, this session`);
  rows.push(
    `${pad("DSH", 8)}${pad(tag(dsh.ok), 6)}` +
      (dsh.ok
        ? `port=${dsh.port}  sessions=${dsh.sessions ?? "?"}  started=${dsh.started}`
        : `${dsh.error || dsh.note || "unreachable"}`),
  );
  rows.push(
    `${pad("Zotero", 8)}${pad(tag(zotero.ok), 6)}` +
      (zotero.ok
        ? `v${zotero.version}  topItems=${zotero.topItems}  libVersion=${zotero.libraryVersion}  started=${zotero.started}`
        : `${zotero.error || zotero.note || "unreachable"}`),
  );
  const notes = [dsh.note, zotero.note].filter(Boolean);
  process.stdout.write(
    `limbs health  ${new Date().toISOString()}\n${line}\n${rows.join("\n")}\n${line}\n` +
      (notes.length ? `notes: ${notes.join(" | ")}\n` : "") +
      `RESULT: ${allOk ? "OK (both limbs alive)" : "DEGRADED"}\n` +
      `elapsed ${Date.now() - t0} ms${noStart ? "  [no-start mode]" : ""}\n`,
  );
}

process.exitCode = allOk ? 0 : 1;
