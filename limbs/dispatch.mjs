/**
 * dispatch —— 任务单的完整下发闭环（L1.2 + L2.1 + L3.1 的收口）。
 *
 * 一条命令做完四件事：
 *   1. 读任务单，渲染成固定格式的下发文本
 *   2. 异步投递到 DSH（不阻塞在 DSH 的 RPC 上）
 *   3. 阻塞等 turn/end 事件落到 hana-bridge 日志（事件驱动，不是轮询 DSH 状态）
 *   4. 把会话号与回报写回任务单，状态推进到 running
 *
 * 边界：不置 done。done 必须由大脑逐条核对验收标准后手工置位，
 * 这是 SCHEMA.md 定死的规矩，dispatch 不越权。
 *
 * 用法：
 *   node dispatch.mjs --task T20261019-05-xxxx [--session session-xxx] [--timeout 600]
 *
 * 退出码：0 = 收到回报；1 = 超时未收到；2 = 参数或状态错误
 */

import { readFileSync, existsSync, readdirSync, mkdirSync, writeFileSync, cpSync } from "node:fs";
import {
  rpc,
  submit,
  DEFAULT_PROVIDER,
  DEFAULT_MODEL,
} from "../DSH-Desktop-Bridge/bin/dsh-core.mjs";
import { load, setState, render, patchTask } from "./tasks.mjs";
import { audit } from "./audit.mjs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { config } from "./config.mjs";
import { turnEnds } from "./events.mjs";

function arg(name, dflt) {
  for (const flag of [`--${name}`, `-${name}`]) {
    const i = process.argv.indexOf(flag);
    if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) return process.argv[i + 1];
    if (i >= 0) return true;
  }
  return dflt;
}

function out(o) {
  process.stdout.write(JSON.stringify(o, null, 2) + "\n");
}

/** 该会话当前最大 turn 号。turn 号单调递增，用它做基线比时间戳可靠。 */
function maxTurn(sid) {
  let m = 0;
  for (const e of turnEnds({ sessions: [sid] })) m = Math.max(m, Number(e.turn) || 0);
  return m;
}

const taskId = arg("task");
if (!taskId || taskId === true) {
  out({ error: "need --task" });
  process.exit(2);
}
const timeoutSec = Number(arg("timeout", 600));
const pollMs = Number(arg("interval", 2000));

let task;
try {
  task = load(String(taskId));
} catch (ex) {
  out({ error: String(ex?.message || ex) });
  process.exit(2);
}
if (task.state !== "queued" && task.state !== "dispatched") {
  out({ error: `task state is ${task.state}; dispatch only accepts queued or dispatched`, taskId });
  process.exit(2);
}

/* 幂等门禁：五分钟内重复投递直接拒绝。
 * 理由：dispatch 中途挂掉后重跑会再发一遍，DSH 会收到重复任务。
 * 要真的重发就显式 --force。 */
const GUARD_MS = 5 * 60 * 1000;
const force = process.argv.includes("--force");
if (!force && task.lastDispatchedAt) {
  const since = Date.now() - new Date(task.lastDispatchedAt).getTime();
  if (since >= 0 && since < GUARD_MS) {
    audit("dispatch", "refused-duplicate", { target: taskId, ok: false, error: "duplicate within guard window" });
    out({
      error: "duplicate dispatch refused",
      taskId,
      lastDispatchedAt: task.lastDispatchedAt,
      sinceMs: since,
      guardMs: GUARD_MS,
      hint: "use --force to override",
    });
    process.exit(2);
  }
}

const dispatchToken = randomBytes(8).toString("hex");

const t0 = Date.now();

/* 0. 经 ds-bot 团队（--via bot）
 * 机制：把任务写成一个 JSON 放进 Bot 的工作目录，再往 Chief 的 session 投一条极简指令让它去读。
 * 为什么这么绕：ds-bot 的群聊消息走插件私有通道，外部 RPC 投不进去（2026-10-19 三条路实测均不通）；
 * 但 Chief 的 session 本身能收外部 prompt，且它能读自己 workspace 里的文件。
 * 代价：任务记录不会出现在群聊界面，只出现在 Chief 的会话里。 */
const via = String(arg("via", "new"));
if (via === "bot") {
  const botCfg = config().bot || {};
  const botWs = botCfg.workspace;
  const chief = botCfg.chiefSessionId;
  if (!botWs || !chief) {
    out({ error: "--via bot requires bot.workspace and bot.chiefSessionId in config.json" });
    process.exit(2);
  }

  const specPath = join(botWs, "tasks", `${taskId}.json`);
  const botOutDir = join(botWs, "tasks", taskId);
  mkdirSync(botOutDir, { recursive: true });
  writeFileSync(
    specPath,
    JSON.stringify(
      {
        id: taskId,
        title: task.title,
        goal: task.goal,
        acceptance: task.acceptance,
        deliverTo: botOutDir,
        boundary:
          "按 goal 与 acceptance 执行。产物一律写进 deliverTo 目录。不要修改任何 Bot 的设置，不要创建或删除 Bot。" +
          "无法完成或有歧义时停下来在回复里说明，不要猜。",
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  const chiefBaseline = maxTurn(chief);
  // 团队分派是显式要求：不写清楚，Chief 会自己一个人干完。
  // 2026-10-19 实测：只写「读文件并执行」，它真的独干了，团队里没有痕迹。
  const brief =
    `读取文件 ${specPath} 并按其中内容执行。产物写进 ${botOutDir}。\n\n` +
    `这是团队任务。先判断由谁执行最合适：需要分派时用 message_bot 把任务交给对应成员，并在回复里写明分工理由；` +
    `如果判断由你自己完成更合适，也要在回复里说明理由。不要无说明地全部自己做。\n\n` +
    `完成后在回复里列出写了哪些文件、哪条验收标准存疑。`;

  await submit(chief, brief);
  patchTask(taskId, { lastDispatchedAt: new Date().toISOString(), dispatchToken });
  if (task.state === "queued") {
    setState(taskId, "dispatched", { sessionId: chief, note: `dispatch via bot -> ${chief}` });
  }
  audit("dispatch", "submit-bot", {
    target: taskId,
    ok: true,
    detail: { chiefSession: chief, specPath, briefChars: brief.length, token: dispatchToken },
  });

  const botDeadline = Date.now() + timeoutSec * 1000;
  let botHit = null;
  while (Date.now() < botDeadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    const fresh = turnEnds({ sessions: [chief] }).filter((e) => (Number(e.turn) || 0) > chiefBaseline);
    if (fresh.length) {
      botHit = fresh[fresh.length - 1];
      break;
    }
  }

  const botElapsed = Date.now() - t0;
  if (!botHit) {
    try {
      setState(taskId, "failed", {
        failure: `bot dispatch: no turn/end within ${timeoutSec}s (chief ${chief})`,
        note: "auto-failed by dispatch timeout",
      });
    } catch {
      /* 状态可能不允许迁移 */
    }
    audit("dispatch", "timeout-bot", { target: taskId, ok: false, ms: botElapsed, detail: { chief } });
    out({ taskId, phase: "timeout", via: "bot", sessionId: chief, elapsedMs: botElapsed });
    process.exit(1);
  }

  // 回收：Bot 写在自己的 workspace，得搬回工作区任务目录，否则 sync 扫不到。
  let recoveredFiles = 0;
  const localDir = join(config().paths.tasks, taskId);
  if (existsSync(botOutDir)) {
    mkdirSync(localDir, { recursive: true });
    try {
      cpSync(botOutDir, localDir, { recursive: true, force: true });
      recoveredFiles = readdirSync(localDir, { withFileTypes: true }).filter((d) => d.isFile()).length;
    } catch (ex) {
      audit("dispatch", "recover-failed", { target: taskId, ok: false, error: String(ex?.message || ex) });
    }
  }

  setState(taskId, "running", { sessionId: chief, note: `bot turn ${botHit.turn} completed in ${botElapsed}ms` });
  audit("dispatch", "complete-bot", {
    target: taskId,
    ok: true,
    ms: botElapsed,
    detail: { turn: botHit.turn, recoveredFiles },
  });

  out({
    taskId,
    phase: "returned",
    via: "bot",
    sessionId: chief,
    turn: botHit.turn,
    elapsedMs: botElapsed,
    text: botHit.text,
    botOutDir,
    recoveredFiles,
    next: "逐条核对验收标准后，用 tasks.mjs set --state done --sync 结单",
  });
  process.exit(0);
}

/* 1. 会话 */
let sid = arg("session");
const reused = !!(sid && sid !== true);
if (!reused) {
  // 必须传 cwd：不传的话 DSH 会用它的 launch-root 作为工作目录，
  // 任务单里的相对路径就会落到那边去（2026-10-19 真实发生过）。
  const created = await rpc("session/create", { request: { cwd: config().workspace } });
  sid = created.sessionId;
  await rpc("session/selectModel", {
    request: { sessionId: sid, provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL },
  });
  // 标题加任务号前缀：会话列表里有几十个，不标就分不清哪个是下发任务。
  // 标题是给人看的溯源入口，比日志和 JSON 更直接。
  try {
    await rpc("session/rename", {
      request: { sessionId: sid, title: `[任务] ${taskId} ${task.title}` },
    });
  } catch (ex) {
    audit("dispatch", "rename-failed", { target: taskId, ok: false, error: String(ex?.message || ex) });
  }
}
sid = String(sid);

const baseline = maxTurn(sid);

/* 2. 投递 */
const prompt = render(task) + `\n\n[dispatch-token: ${dispatchToken}]`;
await submit(sid, prompt);
patchTask(taskId, { lastDispatchedAt: new Date().toISOString(), dispatchToken });
audit("dispatch", "submit", {
  target: taskId,
  ok: true,
  detail: { sessionId: sid, reusedSession: reused, promptChars: prompt.length, token: dispatchToken },
});

if (task.state === "queued") {
  setState(taskId, "dispatched", { sessionId: sid, note: `dispatch -> ${sid}` });
}

/* 3. 等事件 */
const deadline = Date.now() + timeoutSec * 1000;
let hit = null;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, pollMs));
  for (const e of turnEnds({ sessions: [sid] })) {
    if ((Number(e.turn) || 0) > baseline) {
      hit = e;
      break;
    }
  }
  if (hit) break;
}

const elapsed = Date.now() - t0;

if (!hit) {
  audit("dispatch", "timeout", {
    target: taskId,
    ok: false,
    ms: elapsed,
    detail: { sessionId: sid, timeoutSec },
    error: "no turn/end within timeout",
  });
  // 超时不再是「只报错」：任务已经发出去了，不能让它提在 dispatched 不动。
  let stateAfter = null;
  try {
    setState(taskId, "failed", {
      failure: `no turn/end within ${timeoutSec}s (session ${sid})`,
      note: "auto-failed by dispatch timeout",
    });
    stateAfter = "failed";
  } catch (ex) {
    stateAfter = `unchanged: ${String(ex?.message || ex)}`;
  }
  out({
    taskId,
    sessionId: sid,
    phase: "timeout",
    state: stateAfter,
    timeoutSec,
    elapsedMs: elapsed,
    baselineTurn: baseline,
  });
  process.exit(1);
}

/* 4. 回写 */
setState(taskId, "running", { sessionId: sid, note: `turn ${hit.turn} completed in ${elapsed}ms` });

// 产物落点检查：只说完成了不算，得看见文件。
// 缺目录不判失败（任务可能本来就不产出文件），但必须报出来，不能默认成功。
const artifactDir = join(config().paths.tasks, taskId);
let artifactFiles = 0;
let artifactWarning = null;
if (!existsSync(artifactDir)) {
  artifactWarning = `artifact dir missing: ${artifactDir}`;
} else {
  try {
    artifactFiles = readdirSync(artifactDir, { withFileTypes: true }).filter((d) => d.isFile()).length;
    if (artifactFiles === 0) artifactWarning = "artifact dir exists but contains no files at top level";
  } catch (ex) {
    artifactWarning = `cannot read artifact dir: ${String(ex?.message || ex)}`;
  }
}
if (artifactWarning) {
  audit("dispatch", "artifact-missing", { target: taskId, ok: false, error: artifactWarning });
}

audit("dispatch", "complete", {
  target: taskId,
  ok: true,
  ms: elapsed,
  detail: { sessionId: sid, turn: hit.turn, textChars: hit.textChars, artifactFiles },
});

out({
  taskId,
  sessionId: sid,
  phase: "returned",
  turn: hit.turn,
  elapsedMs: elapsed,
  text: hit.text,
  artifactDir,
  artifactFiles,
  ...(artifactWarning ? { artifactWarning } : {}),
  next: "逐条核对验收标准后，用 tasks.mjs set --state done --sync 结单",
});
