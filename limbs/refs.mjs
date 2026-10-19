/**
 * refs —— 文献四层回链工具（L4.1）。
 *
 * 四层结构与主键选择：
 *   L0 Zotero 条目    外键：8 位 key（删了重建会变）
 *   L1 引用登记表     references.md 的 R 号（**主键**，稿件用它）
 *   L2 精读卡         research/40-knowledge/cards/<R-xxx>.md
 *   L3 草稿段落       稿件里的 [R-xxx] 标记
 *
 * 主键用 R 号不用 Zotero key：稿件里写的就是 R 号，且 R 号不随 Zotero 重建而变。
 * Zotero key 作为外键存在 refs.map.json 里，可随时重建。
 *
 * 命令：
 *   node refs.mjs link              # 扫 references.md 与 Zotero，重建 refs.map.json
 *   node refs.mjs check             # 校验稿件里的 [R-xxx] 是否都有登记与映射
 *   node refs.mjs trace R-015       # 反查：该条目被哪些草稿行引用、有无精读卡
 *   node refs.mjs status            # 四层覆盖概览
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { api, ensureRunning } from "./zotero-core.mjs";
import { config } from "./config.mjs";
import { audit } from "./audit.mjs";

const C = config();
const WORKSPACE = C.workspace;
const REFS_MD = C.paths.references;
const MAP_JSON = C.paths.refsMap;
const CARDS_DIR = C.paths.cards;
const DRAFT = C.paths.draft;

/* --------------------------- 文本规范化 --------------------------- */

function norm(s) {
  return String(s)
    .toLowerCase()
    .replace(/[\s\u3000]+/g, "")
    .replace(/[，。、；：？！""''''（）《》〈〉【】\-—–_.,:;!?'"()\[\]{}·/\\]/g, "");
}

/* --------------------------- 解析登记表 --------------------------- */

/** 从 references.md 抽出 R 号与标题。正表与附录 A 表格格式一致，一并抓。 */
function parseReferences() {
  const text = readFileSync(REFS_MD, "utf8");
  const out = new Map();
  for (const line of text.split("\n")) {
    const m = line.match(/^\|\s*(R-\d{3})\s*\|\s*([^|]+?)\s*\|/);
    if (!m) continue;
    const id = m[1];
    const title = m[2].replace(/[*`]/g, "").trim();
    if (!out.has(id)) out.set(id, { id, title, lines: [] });
    out.get(id).lines.push(line);
  }
  return out;
}

/* --------------------------- 取 Zotero 条目 --------------------------- */

async function fetchZotero(limit = 200) {
  const run = await ensureRunning();
  if (!run.running) throw new Error(run.note || "Zotero not running");
  const r = await api(`/api/users/0/items/top?limit=${limit}`);
  if (!r.ok) throw new Error(`zotero HTTP ${r.status}`);
  return (r.json || [])
    .filter((it) => (it.data?.title || "").trim().length > 0)
    .map((it) => ({
      key: it.key,
      title: it.data.title.trim(),
      year: (it.data.date || "").slice(0, 4) || null,
      itemType: it.data.itemType,
      doi: it.data.DOI || null,
      version: it.version,
    }));
}

/* --------------------------- 匹配 --------------------------- */

function match(refTitle, zoteroItems) {
  const a = norm(refTitle);
  if (!a) return null;

  // 1) 规范化后完全相等
  for (const z of zoteroItems) {
    if (norm(z.title) === a) return { z, how: "exact", score: 1 };
  }
  // 2) 一方包含另一方，且长度比不低于 0.6（避免短标题误吞长标题）
  let best = null;
  for (const z of zoteroItems) {
    const b = norm(z.title);
    if (!b) continue;
    const shorter = a.length <= b.length ? a : b;
    const longer = a.length <= b.length ? b : a;
    if (!longer.includes(shorter)) continue;
    const ratio = shorter.length / longer.length;
    if (ratio < 0.6) continue;
    if (!best || ratio > best.score) best = { z, how: "contains", score: ratio };
  }
  return best;
}

/* --------------------------- link --------------------------- */

async function link({ dry = false } = {}) {
  const t0 = Date.now();
  const refs = parseReferences();
  const zotero = await fetchZotero();
  const used = new Set();
  const entries = {};
  const unmatched = [];

  for (const [id, ref] of refs) {
    const hit = match(ref.title, zotero);
    if (hit) {
      used.add(hit.z.key);
      entries[id] = {
        refTitle: ref.title,
        zoteroKey: hit.z.key,
        zoteroTitle: hit.z.title,
        year: hit.z.year,
        doi: hit.z.doi,
        confidence: hit.how,
        score: Number(hit.score.toFixed(3)),
      };
    } else {
      unmatched.push({ id, title: ref.title });
    }
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    primaryKey: "R-number",
    foreignKey: "zoteroKey",
    counts: {
      references: refs.size,
      zoteroTop: zotero.length,
      linked: Object.keys(entries).length,
      unmatched: unmatched.length,
      zoteroUnused: zotero.length - used.size,
    },
    entries,
    unmatched,
    zoteroUnused: zotero.filter((z) => !used.has(z.key)).map((z) => ({ key: z.key, title: z.title, year: z.year })),
  };

  if (!dry) {
    mkdirSync(join(WORKSPACE, "research/60-writing"), { recursive: true });
    writeFileSync(MAP_JSON, JSON.stringify(payload, null, 2) + "\n", "utf8");
    audit("refs", "link", { target: "refs.map.json", ok: true, ms: Date.now() - t0, detail: payload.counts });
  }
  return payload;
}

/* --------------------------- check --------------------------- */

function loadMap() {
  if (!existsSync(MAP_JSON)) throw new Error("refs.map.json 不存在，先跑 refs.mjs link");
  return JSON.parse(readFileSync(MAP_JSON, "utf8"));
}

/** 扫稿件里的 [R-xxx] 标记，返回 {R号: [行号...]} */
function scanDraft() {
  const text = readFileSync(DRAFT, "utf8");
  const hits = new Map();
  text.split("\n").forEach((line, i) => {
    for (const m of line.matchAll(/\[(R-\d{3})\]/g)) {
      const id = m[1];
      if (!hits.has(id)) hits.set(id, []);
      hits.get(id).push(i + 1);
    }
  });
  return hits;
}

function check() {
  const map = loadMap();
  const refs = parseReferences();
  const cited = scanDraft();

  // 硬错误：稿件引用了登记表里根本不存在的号。这是引用事故。
  const problems = [];
  // 软问题：登记表有条目但没绑 Zotero。精读卡可以不依赖 Zotero，所以不算错。
  const warnings = [];
  for (const [id, lines] of cited) {
    if (!refs.has(id)) problems.push({ id, issue: "稿件引用但登记表无此号", lines });
    else if (!map.entries[id]) warnings.push({ id, issue: "登记表有条目但未绑定 Zotero", lines });
  }

  const cardsPresent = existsSync(CARDS_DIR)
    ? new Set(readdirSync(CARDS_DIR).filter((f) => /^R-\d{3}\.md$/.test(f)).map((f) => f.replace(/\.md$/, "")))
    : new Set();
  const noCard = [...cited.keys()].filter((id) => !cardsPresent.has(id));

  return {
    citedCount: cited.size,
    citedIds: [...cited.keys()].sort(),
    registeredCount: refs.size,
    linkedCount: Object.keys(map.entries).length,
    problems,
    warnings,
    missingCards: noCard.sort(),
    cardsPresent: cardsPresent.size,
    ok: problems.length === 0,
  };
}

/** 从标题里抽可搜的关键词。过于通用的词不取，避免满屏误报。 */
function keywords(title) {
  const STOP_EN = new Set([
    "learning", "dataset", "datasets", "recognition", "detection", "image", "images",
    "network", "networks", "comprehensive", "supervised", "towards", "better", "based",
    "large", "scale", "using", "with", "from", "character", "characters",
  ]);
  const STOP_CN = /^(研究|方法|算法|技术|应用|识别|图像|基于|一种|及其|分析|系统|模型)$/;
  const out = new Set();

  for (const w of title.match(/[A-Za-z][A-Za-z-]{5,}/g) || []) {
    if (!STOP_EN.has(w.toLowerCase())) out.add(w.toLowerCase());
  }
  const cn = title.replace(/[^\u4e00-\u9fa5]+/g, "|");
  for (const seg of cn.split("|")) {
    if (seg.length >= 4 && !STOP_CN.test(seg)) out.add(seg);
  }
  return [...out];
}

/**
 * 找「正文提到了某文献、但没标 [R-xxx]」的位置。
 * 判据是标题关键词的字面命中，不涉及语义，因此只用于定位可疑段落，结论必须人工复核。
 */
function mention() {
  const refs = parseReferences();
  const lines = readFileSync(DRAFT, "utf8").split("\n");

  // 先算全局词频：只保留在某条标题中「独一无二」的词。
  // 否则 long-tailed / adversarial 这类多个标题共享的词会互相误报，见 2026-10-19 首跑。
  const kwByRef = new Map();
  const freq = new Map();
  for (const [id, ref] of refs) {
    const kws = keywords(ref.title);
    kwByRef.set(id, kws);
    for (const k of kws) freq.set(k, (freq.get(k) || 0) + 1);
  }

  const out = [];
  for (const [id, ref] of refs) {
    const uniq = (kwByRef.get(id) || []).filter((k) => freq.get(k) === 1);
    if (!uniq.length) continue;
    const hits = [];
    lines.forEach((line, i) => {
      if (line.includes(`[${id}]`)) return; // 已经按规范标了，跳过
      const low = line.toLowerCase();
      for (const k of uniq) {
        if (low.includes(k.toLowerCase())) {
          hits.push({ line: i + 1, kw: k, text: line.trim().slice(0, 90) });
          break;
        }
      }
    });
    if (hits.length) out.push({ id, title: ref.title.slice(0, 46), hitCount: hits.length, hits: hits.slice(0, 4) });
  }
  return out.sort((a, b) => b.hitCount - a.hitCount);
}

/* --------------------------- trace --------------------------- */

function trace(id) {
  const map = loadMap();
  const refs = parseReferences();
  const cited = scanDraft();
  const cardPath = join(CARDS_DIR, `${id}.md`);
  const e = map.entries[id];

  return {
    id,
    registered: refs.has(id),
    refTitle: refs.get(id)?.title ?? null,
    zotero:
      e
        ? { key: e.zoteroKey, title: e.zoteroTitle, year: e.year, doi: e.doi, confidence: e.confidence }
        : null,
    card: existsSync(cardPath) ? cardPath : null,
    citedAtLines: cited.get(id) ?? [],
    closed: !!(refs.has(id) && e && existsSync(cardPath) && (cited.get(id) || []).length > 0),
  };
}

/* --------------------------- CLI --------------------------- */

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) return process.argv[i + 1];
  return dflt;
}

function out(o) {
  process.stdout.write(JSON.stringify(o, null, 2) + "\n");
}

const invoked = process.argv[1] ? process.argv[1].replace(/\\/g, "/") : "";
if (invoked.endsWith("/refs.mjs")) {
  const cmd = process.argv[2] || "status";
  try {
    if (cmd === "link") {
      const r = await link({ dry: process.argv.includes("--dry") });
      out({
        ...r.counts,
        unmatched: r.unmatched.map((u) => `${u.id}  ${u.title.slice(0, 50)}`),
        wrote: process.argv.includes("--dry") ? "dry-run" : MAP_JSON,
      });
    } else if (cmd === "check") {
      out(check());
    } else if (cmd === "trace") {
      out(trace(String(process.argv[3])));
    } else if (cmd === "mention") {
      const m = mention();
      out({ candidates: m.length, items: m });
    } else if (cmd === "status") {
      const c = check();
      out({
        draft: DRAFT.split("/").slice(-1)[0],
        citedIds: c.citedIds,
        registered: c.registeredCount,
        linked: c.linkedCount,
        cardsOnDisk: c.cardsPresent,
        missingCards: c.missingCards,
        problems: c.problems,
        warnings: c.warnings,
        ok: c.ok,
      });
    } else if (cmd === "cards") {
      if (!existsSync(CARDS_DIR)) out({ error: "cards 目录不存在", path: CARDS_DIR });
      else out(readdirSync(CARDS_DIR));
    } else {
      out({ error: "unknown command", usage: "node refs.mjs [link|check|trace|mention|status|cards]" });
      process.exitCode = 2;
    }
  } catch (ex) {
    out({ error: String(ex?.message || ex) });
    process.exitCode = 1;
  }
}
