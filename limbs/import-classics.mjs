/**
 * import-classics —— 把稿件方法链路引用的六条经典文献导入 Zotero（L4.1 第二步）。
 *
 * 元数据来源（双重）：
 *   1. 标题、年份、发表处、页码：research/60-writing/references.md 的登记行（已核实记录）
 *   2. 作者名单：arXiv 官方 API 实取（2026-10-19），写入前逐一核对标题一致
 *
 * 每个条目在 extra 里写入 `RefsID: R-0xx`，作为与引用登记表的显式绑定，
 * 比靠标题匹配更稳，也方便日后用 Zotero 搜索定位。
 *
 * 用法：
 *   node import-classics.mjs --dry        # 只打印将要创建的条目
 *   node import-classics.mjs --only R-029 # 只导一条，用来试水
 *   node import-classics.mjs              # 导全部
 */

import { ensureRunning, write, api } from "./zotero-core.mjs";

const ITEMS = [
  {
    refsId: "R-025",
    arxiv: "1906.07413",
    title: "Learning Imbalanced Datasets with Label-Distribution-Aware Margin Loss",
    authors: ["Kaidi Cao", "Colin Wei", "Adrien Gaidon", "Nikos Arechiga", "Tengyu Ma"],
    year: "2019",
    venue: "Advances in Neural Information Processing Systems 32 (NeurIPS 2019)",
    pages: null,
  },
  {
    refsId: "R-026",
    arxiv: "1901.05555",
    title: "Class-Balanced Loss Based on Effective Number of Samples",
    authors: ["Yin Cui", "Menglin Jia", "Tsung-Yi Lin", "Yang Song", "Serge Belongie"],
    year: "2019",
    venue: "Proceedings of the IEEE/CVF Conference on Computer Vision and Pattern Recognition (CVPR 2019)",
    pages: "9268-9277",
  },
  {
    refsId: "R-027",
    arxiv: "1708.02002",
    title: "Focal Loss for Dense Object Detection",
    authors: ["Tsung-Yi Lin", "Priya Goyal", "Ross Girshick", "Kaiming He", "Piotr Dollár"],
    year: "2017",
    venue: "Proceedings of the IEEE International Conference on Computer Vision (ICCV 2017)",
    pages: "2980-2988",
  },
  {
    refsId: "R-028",
    arxiv: "2004.11362",
    title: "Supervised Contrastive Learning",
    authors: [
      "Prannay Khosla",
      "Piotr Teterwak",
      "Chen Wang",
      "Aaron Sarna",
      "Yonglong Tian",
      "Phillip Isola",
      "Aaron Maschinot",
      "Ce Liu",
      "Dilip Krishnan",
    ],
    year: "2020",
    venue: "Advances in Neural Information Processing Systems 33 (NeurIPS 2020)",
    pages: "18661-18673",
  },
  {
    refsId: "R-029",
    arxiv: "1512.03385",
    title: "Deep Residual Learning for Image Recognition",
    authors: ["Kaiming He", "Xiangyu Zhang", "Shaoqing Ren", "Jian Sun"],
    year: "2016",
    venue: "Proceedings of the IEEE Conference on Computer Vision and Pattern Recognition (CVPR 2016)",
    pages: "770-778",
  },
  {
    refsId: "R-030",
    arxiv: "2201.03545",
    title: "A ConvNet for the 2020s",
    authors: ["Zhuang Liu", "Hanzi Mao", "Chao-Yuan Wu", "Christoph Feichtenhofer", "Trevor Darrell", "Saining Xie"],
    year: "2022",
    venue: "Proceedings of the IEEE/CVF Conference on Computer Vision and Pattern Recognition (CVPR 2022)",
    pages: "11976-11986",
  },
];

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const onlyIdx = args.indexOf("--only");
const only = onlyIdx >= 0 ? args[onlyIdx + 1] : null;

function splitName(full) {
  const parts = full.trim().split(/\s+/);
  if (parts.length === 1) return { firstName: "", lastName: parts[0] };
  return { firstName: parts.slice(0, -1).join(" "), lastName: parts[parts.length - 1] };
}

function toItem(it) {
  return {
    itemType: "conferencePaper",
    title: it.title,
    creators: it.authors.map((a) => ({ creatorType: "author", ...splitName(a) })),
    date: it.year,
    proceedingsTitle: it.venue,
    ...(it.pages ? { pages: it.pages } : {}),
    DOI: `10.48550/arXiv.${it.arxiv}`,
    url: `https://arxiv.org/abs/${it.arxiv}`,
    extra: `arXiv:${it.arxiv}\nRefsID: ${it.refsId}`,
  };
}

const targets = only ? ITEMS.filter((i) => i.refsId === only) : ITEMS;
if (!targets.length) {
  process.stdout.write(JSON.stringify({ error: `no such refsId: ${only}` }) + "\n");
  process.exit(2);
}

if (dry) {
  process.stdout.write(JSON.stringify(targets.map(toItem), null, 2) + "\n");
} else {
  const run = await ensureRunning();
  if (!run.running) {
    process.stdout.write(JSON.stringify({ error: run.note || "Zotero not running" }) + "\n");
    process.exit(1);
  }

  // 先查重：库里若已有同标题条目，跳过，不制造重复。
  const existing = await api("/api/users/0/items/top?limit=200");
  const norm = (s) => String(s || "").toLowerCase().replace(/[\s\u3000\W]+/g, "");
  const have = new Map((existing.json || []).map((x) => [norm(x.data?.title), x.key]));

  const created = [];
  for (const it of targets) {
    const dup = have.get(norm(it.title));
    if (dup) {
      created.push({ refsId: it.refsId, skipped: true, existingKey: dup, title: it.title });
      continue;
    }
    const r = await write("/api/users/0/items", { method: "POST", body: [toItem(it)] });
    const s = r.json?.successful?.["0"];
    created.push({
      refsId: it.refsId,
      ok: r.ok && !!s,
      key: s?.key ?? null,
      status: r.status,
      title: it.title,
      error: r.ok ? null : r.text?.slice(0, 200),
    });
  }

  process.stdout.write(JSON.stringify({ created }, null, 2) + "\n");
}
