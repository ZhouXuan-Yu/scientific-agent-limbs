/**
 * 把 skills-for-bots/ 下的技能包追加到对应 Bot 的 instructions。
 * 幂等：已包含标记串的不重复追加。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const STATE = process.env.APPDATA + "\\dsh-desktop\\harness\\bot\\state.json";
const SKILL_DIR = "C:/Users/ZhouXuan/Desktop/OH-WorkSpace/skills-for-bots";
const MARK = "<!-- skill-pack -->";

const MAP = {
  Chief: "chief.md",
  小研: "xiaoyan.md",
  选题: "xuanti.md",
  实验: "shiyan.md",
  写作: "xiezuo.md",
  图表: "tubiao.md",
  审稿: "shengao.md",
};

const state = JSON.parse(readFileSync(STATE, "utf8"));
const bots = state.bots || {};
const arr = Array.isArray(bots) ? bots : Object.values(bots);

const report = [];
for (const bot of arr) {
  const file = MAP[bot.name];
  if (!file) {
    report.push({ bot: bot.name, action: "skipped (no skill mapped)" });
    continue;
  }
  const path = join(SKILL_DIR, file);
  if (!existsSync(path)) {
    report.push({ bot: bot.name, action: "FAILED (file missing)", file });
    continue;
  }
  const skill = readFileSync(path, "utf8").trim();
  const current = String(bot.instructions || "");
  if (current.includes(MARK)) {
    // 已追加过：替换整段技能包（便于迭代更新）
    const head = current.split(MARK)[0].trimEnd();
    bot.instructions = `${head}\n\n${MARK}\n\n${skill}`;
    report.push({ bot: bot.name, action: "updated (replaced existing pack)", chars: bot.instructions.length });
  } else {
    bot.instructions = `${current}\n\n${MARK}\n\n${skill}`.trim();
    report.push({ bot: bot.name, action: "added", chars: bot.instructions.length, addedChars: skill.length });
  }
}

writeFileSync(STATE, JSON.stringify(state, null, 2) + "\n", "utf8");
console.log(JSON.stringify(report, null, 2));
