/**
 * diag-dsh —— 安全诊断：在禁止自动拉起的前提下，看 ensureRunning 如何判定当前 DSH 状态。
 * 不改动任何东西，不会启动新实例。
 */
process.env.DSH_NO_AUTOSTART = "1";

const m = await import("../DSH-Desktop-Bridge/bin/dsh-core.mjs");

let launchRaw = null;
let launchErr = null;
try {
  launchRaw = m.lastLaunch();
} catch (ex) {
  launchErr = String(ex?.message || ex);
}

const run = await m.ensureRunning(1);

let sessions = null;
let sessionErr = null;
try {
  const r = await m.listSessions();
  sessions = (r.items || []).length;
} catch (ex) {
  sessionErr = String(ex?.message || ex);
}

process.stdout.write(
  JSON.stringify(
    {
      logPath: m.LOG_PATH,
      lastLaunch: launchRaw,
      lastLaunchError: launchErr,
      ensureRunning: run,
      sessions,
      sessionErr,
    },
    null,
    2,
  ) + "\n",
);
