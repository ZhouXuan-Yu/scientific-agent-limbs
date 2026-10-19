/**
 * fetch-arxiv —— 从 arXiv 官方 API 取元数据，用于补全引用登记表缺失的作者字段。
 * 只读，不写任何本地库。
 * 用法：node fetch-arxiv.mjs 1512.03385 1708.02002 ...
 */

const ids = process.argv.slice(2);
if (!ids.length) {
  process.stdout.write(JSON.stringify({ error: "no ids" }) + "\n");
  process.exit(2);
}

const url = `https://export.arxiv.org/api/query?id_list=${ids.join(",")}&max_results=${ids.length}`;

function pick(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return m ? m[1].replace(/\s+/g, " ").trim() : null;
}

function all(block, tag) {
  const out = [];
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "g");
  let m;
  while ((m = re.exec(block))) out.push(m[1].replace(/\s+/g, " ").trim());
  return out;
}

const res = await fetch(url, { headers: { "user-agent": "hana-limbs/1.0" } });
const xml = await res.text();

const entries = xml.split("<entry>").slice(1);
const out = [];
for (const e of entries) {
  const rawAuthors = all(e, "name");
  const published = pick(e, "published");
  out.push({
    arxivId: (pick(e, "id") || "").split("/abs/").pop(),
    title: pick(e, "title"),
    authors: rawAuthors,
    published: published,
    year: published ? published.slice(0, 4) : null,
    doi: pick(e, "arxiv:doi"),
    primaryCategory: (e.match(/term="([^"]+)"/) || [])[1] || null,
  });
}

process.stdout.write(JSON.stringify({ httpStatus: res.status, count: out.length, entries: out }, null, 2) + "\n");
