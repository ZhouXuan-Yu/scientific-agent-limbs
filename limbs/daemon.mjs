/**
 * daemon —— 状态守护（L2.2）。它不做决策，只让状态不说谎。
 *
 * 定位要说清楚：这不是「全自动科研」，是「我不在场时系统不会烂掉」。
 * 它能做三件事：
 *   1. 超期任务置 failed（sweep）
 *   2. dispatch 中途挂掉、状态卡在 dispatched 的任务，检测到完成事件后推进到 running
 *   3. 每轮把发生了什么写进摘要，等我下次进场时一次读完
 *
 * 它不做的事（故意）：
 *   - 不置 done。done 必须人工逐条核对验收标准，这是 SCHEMA 的死规矩。
 *   - 不自动重试。失败原因没读明白就重试，只会重复失败。
 *   - 不叫醒任何人。宿主没有执行注入能力，它只能留摘要。
 *
 * 用法：
 *   node daemon.mjs --once                 # 跑一轮就退（最常用）
 *   node daemon.mjs --report               # 只看摘要，不改任何状态
 *   node daemon.mjs --interval 60 --max-cycles 30
 *
 * 摘要位置：<stateDir>/daemon-state.json
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { list, setState, sweep, patchTask } from "./tasks.mjs";
import { turnEnds } from "./events.mjs";
import { audit } from "./audit.mjs";
import { config } from "./config.mjs";

const STATE_FILE = join(config().stateDir, "daemon-state.json");
const MAX_TRANSITIONS = 100;

function arg(name, dflt) {
  for (const flag of [`--${name}`, `-${name}`]) {
    const i = process.argv.indexOf(flag);
    if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) return process.argv[i + 1];
    if (i >= 0) return true;
  }
  return dflt;
}

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { startedAt: new Date().toISOString(), cycles: 0, transitions: [], lastCycleAt: null };
  }
}

function saveState(s) {
  try {
    mkdirSync(config().stateDir, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(s, null, 2) + "\n", "utf8");
  } catch (ex) {
    process.stderr.write(`[daemon] 摘要写入失败：${String(ex?.message || ex)}\n`);
  }
}

/**
 * 一轮巡检。
 * 返回本轮发生的迁移、超期未下发、以及等人工核对的任务。
 */
function cycle(state) {
  const now = new Date();
  const transitions = [];

  /* 1. 超期清扫 */
  const sw = sweep({ now });
  for (const f of sw.failed) {
    transitions.push({ at: now.toISOString(), taskId: f.id, from: f.state, to: "failed", reason: "deadline" });
  }

  /* 2. 卡在 dispatched 但实际已完成的任务 */
  for (const t of list()) {
    if (t.state !== "dispatched" || !t.sessionId) continue;

    const ends = turnEnds({ sessions: [t.sessionId] });
    const since = t.lastDispatchedAt ? new Date(t.lastDispatchedAt).getTime() : 0;
    const hit = ends
      .filter((e) => e.at && new Date(e.at).getTime() >= since)
      .sort((a, b) => (a.at < b.at ? -1 : 1))
      .pop();
    if (!hit) continue;

    // 幂等：已经在 notes 里记过这一轮就不重复推进
    const marked = (t.notes || []).some((n) => n.includes(`turn ${hit.turn} completed`));
    if (marked) continue;

    try {
      setState(t.id, "running", {
        sessionId: t.sessionId,
        note: `daemon: turn ${hit.turn} completed (observed from event log)`,
      });
      transitions.push({
        at: now.toISOString(),
        taskId: t.id,
        from: "dispatched",
        to: "running",
        reason: `turn ${hit.turn} observed`,
      });
    } catch (ex) {
      transitions.push({
        at: now.toISOString(),
        taskId: t.id,
        from: t.state,
        to: null,
        reason: `transition failed: ${String(ex?.message || ex)}`,
      });
    }
  }

  /* 3. 汇总 */
  const all = list();
  const pendingReview = all
    .filter((t) => t.state === "running")
    .map((t) => ({ id: t.id, title: t.title, sessionId: t.sessionId, deadline: t.deadline }));
  const overdueQueued = sw.stalled;

  return { transitions, pendingReview, overdueQueued, ranAt: now.toISOString() };
}

/* --------------------------- CLI --------------------------- */

function report(state) {
  const s = state;
  process.stdout.write(
    JSON.stringify(
      {
        startedAt: s.startedAt,
        lastCycleAt: s.lastCycleAt,
        cycles: s.cycles,
        pendingReview: s.pendingReview || [],
        overdueQueued: s.overdueQueued || [],
        recentTransitions: (s.transitions || []).slice(-20),
        note: "pendingReview 里的任务已完成但未核对验收标准，done 必须人工置位。",
      },
      null,
      2,
    ) + "\n",
  );
}

const invoked = process.argv[1] ? process.argv[1].replace(/\\/g, "/") : "";
if (invoked.endsWith("/daemon.mjs")) {
  const once = process.argv.includes("--once");
  const reportOnly = process.argv.includes("--report");
  const interval = Number(arg("interval", 60));
  const maxCycles = Number(arg("max-cycles", 0)); // 0 = 不限

  if (reportOnly) {
    report(loadState());
    process.exit(0);
  }

  let state = loadState();
  let cycles = 0;

  const runOnce = () => {
    const r = cycle(state);
    state.cycles = (state.cycles || 0) + 1;
    state.lastCycleAt = r.ranAt;
    state.pendingReview = r.pendingReview;
    state.overdueQueued = r.overdueQueued;
    state.transitions = [...(state.transitions || []), ...r.transitions].slice(-MAX_TRANSITIONS);
    saveState(state);
    cycles++;

    audit("daemon", "cycle", {
      ok: true,
      detail: {
        cycle: state.cycles,
        transitions: r.transitions.length,
        pendingReview: r.pendingReview.length,
        overdueQueued: r.overdueQueued.length,
      },
    });

    process.stdout.write(
      `[daemon] cycle ${state.cycles}  transitions=${r.transitions.length}  pendingReview=${r.pendingReview.length}  overdueQueued=${r.overdueQueued.length}\n`,
    );
    return r;
  };

  if (once) {
    const r = runOnce();
    process.stdout.write(JSON.stringify(r, null, 2) + "\n");
  } else {
    process.stdout.write(`[daemon] started, interval=${interval}s, maxCycles=${maxCycles || "unlimited"}\n`);
    // 常驻模式：每 interval 秒一轮，Ctrl-C 退出
    // 用 setTimeout 链而不是 setInterval，保证一轮跑完再排下一轮，不会堆叠。
    const loop = () => {
      runOnce();
      if (maxCycles > 0 && cycles >= maxCycles) {
        process.stdout.write(`[daemon] reached maxCycles=${maxCycles}, exiting\n`);
        process.exit(0);
      }
      setTimeout(loop, interval * 1000);
    };
    loop();
  }
}
