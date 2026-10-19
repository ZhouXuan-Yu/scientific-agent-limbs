/**
 * audit —— 统一审计日志（L5.1）。
 *
 * 解决的问题：七个工具各说各话，出问题时只看得到「结果不对」，
 * 看不到「哪一步、什么时候、用什么参数、花了多久、为什么失败」。
 *
 * 形态：一行一个 JSON，按天分片，落在 limbs/_audit/audit-YYYYMMDD.jsonl。
 * 选 JSONL 不选数据库：人可以直接读，机器可以直接 parse，追加不阻塞。
 *
 * 纪律：
 *   - 写日志失败绝不影响主流程（全部 try/catch 吞掉）
 *   - 只记动作与结果，不记业务内容全文（避免日志膨胀成第二份数据）
 *   - 失败必须带 error 字段，否则这个日志没有诊断价值
 *
 * 用法：
 *   node audit.mjs tail -n 20
 *   node audit.mjs query --actor tasks --action setState
 *   node audit.mjs stats
 *   node audit.mjs since 2026-10-19T08:00:00Z
 */

import { appendFileSync, mkdirSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.mjs";

export const AUDIT_DIR = process.env.LIMBS_AUDIT_DIR || config().paths.audit;

function dayStamp(d = new Date()) {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

function dayFile(d = new Date()) {
  return join(AUDIT_DIR, `audit-${dayStamp(d)}.jsonl`);
}

/**
 * 记一条审计。
 * @param {string} actor  谁做的：zotero-core / tasks / dsh / refs / inbox / health
 * @param {string} action 做了什么：launch / write / create / setState / send / consume / link
 * @param {object} opts   { target, ok, ms, detail, error }
 */
export function audit(actor, action, opts = {}) {
  try {
    const { target = null, ok = true, ms = null, detail = null, error = null } = opts;
    const rec = {
      ts: new Date().toISOString(),
      actor,
      action,
      target,
      ok,
      ms,
    };
    if (error) rec.error = String(error).slice(0, 400);
    if (detail && typeof detail === "object") rec.detail = detail;
    mkdirSync(AUDIT_DIR, { recursive: true });
    appendFileSync(dayFile(), JSON.stringify(rec) + "\n", "utf8");
    return rec;
  } catch {
    return null; // 审计不可用不影响主流程
  }
}

/** 包一个动作，自动记耗时与成败。异常照常抛出。 */
export async function traced(actor, action, opts, fn) {
  const t0 = Date.now();
  try {
    const r = await fn();
    audit(actor, action, { ...opts, ok: true, ms: Date.now() - t0 });
    return r;
  } catch (ex) {
    audit(actor, action, { ...opts, ok: false, ms: Date.now() - t0, error: ex?.message || ex });
    throw ex;
  }
}

/* --------------------------- 查询 --------------------------- */

export function readAll() {
  if (!existsSync(AUDIT_DIR)) return [];
  const files = readdirSync(AUDIT_DIR).filter((f) => /^audit-\d{8}\.jsonl$/.test(f)).sort();
  const out = [];
  for (const f of files) {
    for (const line of readFileSync(join(AUDIT_DIR, f), "utf8").split("\n")) {
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

function arg(name, dflt) {
  // 同时接受 --n 与 -n，避免因横线数量差异默默走默认值。
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

const invoked = process.argv[1] ? process.argv[1].replace(/\\/g, "/") : "";
if (invoked.endsWith("/audit.mjs")) {
  const cmd = process.argv[2] || "stats";
  const all = readAll();

  if (cmd === "tail") {
    const n = Number(arg("n", 20));
    out(all.slice(-n));
  } else if (cmd === "query") {
    const actor = arg("actor");
    const action = arg("action");
    const okOnly = arg("ok");
    const rows = all.filter(
      (r) =>
        (!actor || r.actor === actor) &&
        (!action || r.action === action) &&
        (okOnly === undefined || r.ok === (okOnly === true || okOnly === "true")),
    );
    out({ count: rows.length, rows: rows.slice(-100) });
  } else if (cmd === "since") {
    const t = String(process.argv[3] || "");
    out(all.filter((r) => r.ts >= t));
  } else if (cmd === "stats") {
    const byActor = {};
    const failures = [];
    for (const r of all) {
      const k = `${r.actor}/${r.action}`;
      byActor[k] = byActor[k] || { ok: 0, fail: 0, totalMs: 0 };
      if (r.ok) byActor[k].ok++;
      else {
        byActor[k].fail++;
        if (failures.length < 20) failures.push({ ts: r.ts, actor: r.actor, action: r.action, error: r.error });
      }
      if (typeof r.ms === "number") byActor[k].totalMs += r.ms;
    }
    out({ records: all.length, byActor, recentFailures: failures });
  } else if (cmd === "files") {
    out(existsSync(AUDIT_DIR) ? readdirSync(AUDIT_DIR) : []);
  } else {
    out({ error: "unknown command", usage: "node audit.mjs [tail|query|since|stats|files]" });
    process.exitCode = 2;
  }
}
