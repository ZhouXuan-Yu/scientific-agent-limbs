/**
 * config —— limbs 的统一配置入口。
 *
 * 问题：八个模块各自硬编码绝对路径（D:\Zotero、C:/Users/...）。换机器、换用户、
 * 换 Zotero 安装位置就全废，这是把这个体系复制给别人的第一道墙。
 *
 * 方案：一个 limbs/config.json + 环境变量覆盖 + 内置默认回退。
 *   - config.json 不存在时用默认值（默认值就是开发机上那套，保证本机开箱可用）
 *   - 环境变量优先于配置（LIMBS_WORKSPACE / LIMBS_STATE 等，便于临时切换）
 *   - 所有路径只在这里出现一次，其他模块一律 `config().xxx` 取值
 *
 * 用法：
 *   import { config } from "./config.mjs";
 *   const C = config();
 *   const ROOT = C.paths.tasks;          // 已解析成绝对路径
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const APPDATA = process.env.APPDATA || join(homedir(), "AppData", "Roaming");

/**
 * 默认值按平台通用推导，不含任何用户名或盘符。
 * 真正可用的路径应该写在 config.json 里；这组默认值只是保证模块不崩。
 */
const DEFAULTS = {
  workspace: process.cwd(),
  stateDir: join(homedir(), ".local", "state", "limbs"),
  zotero: {
    exe: "Zotero",
    port: 23119,
    startTimeoutMs: 90000,
  },
  dsh: {
    exe: "DSH Desktop",
    logPath: join(APPDATA, "dsh-desktop", "logs", "harness.log"),
    bridgeLogPath: join(APPDATA, "dsh-desktop", "harness", "logs", "hana-bridge-events.jsonl"),
    provider: "deepseek-official",
    model: "deepseek-flash",
  },
  paths: {
    tasks: "tasks",
    audit: "limbs/_audit",
    cards: "research/40-knowledge/cards",
    references: "research/60-writing/references.md",
    refsMap: "research/60-writing/refs.map.json",
    draft: "research/qinjian-report/draft.md",
  },
};

function deepMerge(base, patch) {
  if (!patch || typeof patch !== "object") return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) ? deepMerge(base?.[k] ?? {}, v) : v;
  }
  return out;
}

/** 相对路径一律相对 workspace 解析，配置里写 "tasks" 和写绝对路径都行。 */
function abs(p, workspace) {
  if (!p) return p;
  return isAbsolute(p) ? p : join(workspace, p);
}

let CACHED = null;

export function config() {
  if (CACHED) return CACHED;

  const configPath = process.env.LIMBS_CONFIG || join(HERE, "config.json");
  let fileCfg = {};
  if (existsSync(configPath)) {
    try {
      fileCfg = JSON.parse(readFileSync(configPath, "utf8"));
    } catch (ex) {
      process.stderr.write(`[limbs] config 解析失败，改用默认值：${String(ex?.message || ex)}\n`);
    }
  }

  const merged = deepMerge(DEFAULTS, fileCfg);
  const workspace = process.env.LIMBS_WORKSPACE || merged.workspace;

  // 路径全部解析成绝对路径，调用方不用再关心相对还是绝对。
  const paths = {};
  for (const [k, v] of Object.entries(merged.paths || {})) paths[k] = abs(v, workspace);
  paths.workspace = workspace;

  CACHED = {
    workspace,
    stateDir: process.env.LIMBS_STATE || merged.stateDir,
    paths,
    zotero: {
      exe: process.env.ZOTERO_EXE || merged.zotero.exe,
      port: Number(process.env.ZOTERO_PORT || merged.zotero.port),
      startTimeoutMs: Number(process.env.ZOTERO_START_TIMEOUT_MS || merged.zotero.startTimeoutMs),
    },
    dsh: {
      exe: process.env.DSH_EXE || merged.dsh.exe,
      logPath: process.env.DSH_LOG || merged.dsh.logPath,
      bridgeLogPath: process.env.HANA_BRIDGE_LOG || merged.dsh.bridgeLogPath,
      provider: merged.dsh.provider,
      model: merged.dsh.model,
    },
    configPath,
    loadedFromFile: existsSync(configPath),
  };
  return CACHED;
}

/** 自检：哪些配置项指向的文件/目录实际不存在。用于换机器后第一时间定位。 */
export function validate() {
  const C = config();
  const checks = [
    ["workspace", C.workspace, "dir"],
    ["zotero.exe", C.zotero.exe, "file"],
    ["dsh.exe", C.dsh.exe, "file"],
    ["dsh.logPath", C.dsh.logPath, "file"],
    ["dsh.bridgeLogPath", C.dsh.bridgeLogPath, "file"],
    ["paths.references", C.paths.references, "file"],
  ];
  return checks.map(([name, path, kind]) => {
    let ok = false;
    try {
      ok = existsSync(path);
    } catch {
      ok = false;
    }
    return { name, path, kind, ok };
  });
}

const invoked = process.argv[1] ? process.argv[1].replace(/\\/g, "/") : "";
if (invoked.endsWith("/config.mjs")) {
  const C = config();
  process.stdout.write(
    JSON.stringify(
      {
        configPath: C.configPath,
        loadedFromFile: C.loadedFromFile,
        resolved: { workspace: C.workspace, stateDir: C.stateDir, paths: C.paths, zotero: C.zotero, dsh: C.dsh },
        checks: validate(),
      },
      null,
      2,
    ) + "\n",
  );
}
