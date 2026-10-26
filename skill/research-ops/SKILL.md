---
name: research-ops
description: 科研任务编排器。用一条命令把任务下发到 DSH 桌面端的 ds-bot 科研团队（总管 Chief + 选题/实验/写作/图表/审稿/小研），等结果回来，验收归档；同时可直连本地 Zotero 查条目、取全文、核引用、盘点文献库。当用户说「把这个交给团队」「让 DSH 做」「下发任务」「查 Zotero」「核对引用」「盘点文献库」「看看团队进度」「跑个文献汇总」时使用。不负责：DSH 自身配置（用 dsh-control）、不需要团队的简单问答。
---

# 科研任务编排：Zotero + DSH 团队

一套已经跑通的链路：**任一 CLI 智能体当大脑 → DSH 上的 ds-bot 团队执行 → 结果回流 → 验收归档**。所有命令都是 `node` 调 `.mjs`，无需安装依赖，无需联网。

## 路径常量

先设定一次，后面所有命令都用它：

```powershell
$L="C:\Users\ZhouXuan\Desktop\OH-WorkSpace\limbs"
```

配置文件 `limbs\config.json` 里存着本机绝对路径（workspace、Zotero 端口、DSH 路径、群聊 session）。换机器只改这一个文件。

## 第一步：每次开新对话先自检

不要跳过。链路任一环断了，后面的任务会静默失败。

```powershell
node "$L\health.mjs" --json
```

返回各组件状态。`ok: false` 时看具体哪一项：

```powershell
node "$L\diag-dsh.mjs"      # DSH 端口、进程、bridge 是否在跑
node "$L\probe.mjs"          # 往 Chief 发一条探针，看通道通不通
node "$L\zotero-core.mjs"    # 无参数=ping，返回版本、条目数
```

**然后必查僵尸任务。**这是最容易把人卡住的地方：

```powershell
node "$L\tasks.mjs" list | Select-String "running"
node "$L\daemon.mjs" --once --max-cycles 1      # 会列出 pendingReview
```

群里已跑完但没验收的任务、或中途断掉的任务，会一直停在 `running`，把串行门禁锁死，之后所有 dispatch 都报 `another task is still active`。

处理办法，按顺序试：

1. `tasks.mjs show <ID>` 看产物是否齐全。齐全就 `set <ID> --state done --sync` 结单。
2. 产物不全但确实要放弃：`set <ID> --state cancelled`。
3. 确实还在跑（`dsh_list` 里对应 session 的 running 为 true）：等它。

注意状态机不能跳级：`queued` 不能直接置 `done`，只能 `cancelled`；要置 `done` 必须先经过 `dispatched` 或 `running`。

Zotero 没起会自动拉起（最长 90 秒）。仍失败的话，检查 Zotero 设置 → 高级 → 勾选「Allow other applications on this computer to communicate with Zotero」。

## 六个标准动作

### 1. 查 Zotero

```powershell
node "$L\zotero-core.mjs" ping              # 存活 + 版本 + 条目数
node "$L\zotero-core.mjs" status            # 更详细的状态
node "$L\zotero-core.mjs" collections       # 列出所有分类及条目数
node "$L\zotero-core.mjs" open              # 启动 Zotero（已在跑则跳过）
```

直接在代码里调 API（读写条目、拿全文）用 `zotero-core.mjs` 的导出：

```js
import * as z from "file:///C:/Users/ZhouXuan/Desktop/OH-WorkSpace/limbs/zotero-core.mjs";
const r = await z.api("/api/users/0/collections/7736B99W/items/top?limit=50");
// z.fulltext(itemKey) 取某条的 PDF 全文，z.children(key) 取子附件
```

### 2. 建任务单

任务单是一份 JSON，写清四件事：**做什么、怎么算做完、东西放哪、多久交**。

```json
{
  "title": "一句话标题",
  "goal": "要达成的目标，说明输入材料在哪",
  "acceptance": ["验收标准 1", "验收标准 2"],
  "limb": "bot",
  "deadlineMinutes": 60
}
```

```powershell
node "$L\tasks.mjs" create --file spec.json
```

返回任务号（形如 `T20261020-03-9777`）。任务目录建在 Bot workspace 的 `tasks\<任务号>\`。

**验收标准怎么写决定成品质量。** 反面例子：「分析这些论文」。正面例子：

- 每条结论必须指到原文行号
- 把「作者自称」与「独立判断」分开写
- 现成方法的使用不算创新，除非原文主张首次或实质改进
- 无法确认的写「待确认」，不得编造

只要留一个含糊的地方，AI 就会按自己的理解补。把规则写死，它才真不这么做。

### 3. 投递

```powershell
node "$L\dispatch.mjs" --task T20261020-03-9777 --via room --timeout 3600
```

| 参数 | 说明 |
|---|---|
| `--via room` | 投进群聊，Chief 接单后自行拆解分工。**默认用这个** |
| `--via bot` | 只发给某个 Bot（配 `--session`） |
| `--via new` | 新建会话，用于一次性独立任务 |
| `--timeout` | 秒。到点仍未完成会返回当前进度而非空手而归 |
| `--force` | 已有活跃任务时强制投递（会破坏串行门禁，慎用） |

投递前会自动检查是否有活跃任务。**同一时间只允许一个**，因为群聊只有一个，并行任务的消息会混。

长中文任务不要拼在命令里（会被截断），必须写进文件再投：

```powershell
node "$L\dispatch.mjs" --task <ID> --via room --text-file prompt.txt
```

### 4. 等结果

`dispatch` 本身会阻塞到完成。若想先干别的再回来收：

```powershell
node "$L\wait-turn.mjs" --session session-3284d835-7582-4707-9e00-d91c0c428bcb --timeout 1800
```

**群聊投递拿不到回执，这是必然的。**实测结论：无论是 MCP 的 `dsh_send`、bridge 的 `dsh.mjs send`，还是直接调 DSH 接口，往群聊投递后返回的 `text` 都是空字符串，`dsh_read` 也读不到。原因不是通道坏了——群聊不把成员发言写进 session 的 assistant message，而是写进 room 的 log。所以：

- **投递成功 ≠ 拿到回复**。返回空字符串只说明消息进了队列。
- 要确认是否真收到，只能查 room log 或 inbox。

看收件箱（所有 Bot 的回复汇总）：

```powershell
node "$L\inbox.mjs"              # 只看新的
node "$L\inbox.mjs" --all        # 全部
node "$L\inbox.mjs" --files      # 带产物路径
node "$L\inbox.mjs" --reset      # 清空未读标记
```

看群聊逐条记录：

```powershell
node "$L\botstate.mjs" room      # 群聊概要
node "$L\botstate.mjs" log       # 最近的消息流水
```

**完成判据是三信号**：群聊序号 + 各成员轮次 + 产物文件 mtime/size 三者同时静止，且没有 session 在跑，持续 90 秒才算完成。只看群聊会漏掉私下干活，只看文件会漏掉过程。理论依据是分布式终止检测。

### 5. 验收

**不要拿到结果就结单。** 先核：

```powershell
node "$L\tasks.mjs" show <ID>          # 任务详情 + 产物清单
node "$L\tasks.mjs" verify <ID>        # 自动核验收标准
```

核完再结：

```powershell
node "$L\tasks.mjs" set <ID> --state done --sync
```

`--sync` 会把产物从 Bot workspace 复制回 `OH-WorkSpace\tasks\<ID>\`，并更新任务索引。用 `--file note.json` 附验收意见。

验收要真核，不是走过场。典型该抓的问题：

- 声称「已核对」但实际只抽了一部分
- 把作者自述的创新当成客观判断
- 数字没有行号出处
- 引用了没读过的文献

### 6. 归档

```powershell
node "$L\tasks.mjs" list                    # 所有任务
node "$L\tasks.mjs" list --state done       # 按状态过滤
node "$L\tasks.mjs" sync                    # 批量同步产物
node "$L\tasks.mjs" sweep                   # 清理过期任务
node "$L\tasks.mjs" find <关键词>            # 按标题/产物搜
node "$L\tasks.mjs" render <ID>             # 渲染成可读格式
```

## 命令速查表

| 模块 | 用途 | 常用命令 |
|---|---|---|
| `health.mjs` | 全链路自检 | `--json` `--no-start` |
| `diag-dsh.mjs` | DSH 端口/进程诊断 | 无参数 |
| `probe.mjs` | 通道探针 | 无参数 |
| `zotero-core.mjs` | Zotero API | `ping` `status` `collections` `open` `authorize` |
| `tasks.mjs` | 任务单 | `create` `list` `show` `set` `verify` `sync` `sweep` `find` `render` |
| `dispatch.mjs` | 投递 | `--task` `--via` `--timeout` `--text-file` `--force` |
| `wait-turn.mjs` | 等回合结束 | `--session` `--timeout` |
| `inbox.mjs` | 收件箱 | `--all` `--files` `--reset` `--json` |
| `botstate.mjs` | 群聊状态 | `room` `log` |
| `events.mjs` | bridge 事件 | `files` `count` |
| `refs.mjs` | 引用核验 | `link` `check` `trace` `mention` `status` `cards` |
| `audit.mjs` | 操作审计 | `tail` `query` `since` `stats` `files` |
| `daemon.mjs` | 常驻轮询 | `--once` `--interval` `--max-cycles` `--report` |
| `import-classics.mjs` | 导入文献 | `--dry` `--only` |
| `fetch-arxiv.mjs` | 抓 arXiv | 后接查询参数 |

## 三种常用任务模板

### A. 文献汇总（十篇以上进团队）

```
goal: 十篇全文放在 fulltext/，文件名即条目号。提炼各自技术路线，做一张对比表。
acceptance:
  - 每篇一行，列包括方法、数据集、指标、局限
  - 每个数字后面标原文行号
  - 原文没写指标的写「未报告」，不得估算
  - 无法确认的写「待确认」
```

### B. 引用核验（不需要团队，直接自己跑）

```powershell
node "$L\refs.mjs" check      # 核已注册引用
node "$L\refs.mjs" trace      # 追某条引用的来源
node "$L\refs.mjs" status     # 引用图谱概况
```

原则：一条引用要至少两个独立来源确认；只有二手摘要不算核实；查不到就写「尚未完成外部验证」，不写「没人做过」。

### C. Zotero 盘点

先 `collections` 拿分类 key，再用 API 拉条目：

```js
const col = await z.api("/api/users/0/collections/<KEY>/items/top?limit=100");
for (const it of col.json) {
  const kids = await z.children(it.key);
  const hasPDF = kids.some(k => k.data.contentType === "application/pdf");
}
```

报数时分开写「有全文」和「只有条目」，不要合并成一个数字。

## 通道对比：四条路各管什么

实测过四条通道，用途不同，不要混用：

| 通道 | 能做什么 | 拿得到回复吗 | 适合什么 |
|---|---|---|---|
| **limbs dispatch** | 建单、投递、等、回收产物、改状态 | 能，有三信号判定和产物清单 | **正式任务，默认用这个** |
| **MCP `dsh_send`** | 直接投消息到指定 session | 私聊能，群聊不能（返回空） | 临时问一句、测通道 |
| **bridge `dsh.mjs send`** | 同上，命令行版 | 同上 | 不想装 MCP 时用 |
| **`dshana` app** | 起一个 DSH 子智能体 | 能 | 需要独立上下文的一次性任务 |

**关键差异**：limbs 会等你到真正完成（三信号静止 90 秒）并回收产物；MCP 和 bridge 只保证消息进了队列。要结果必须自己查 room log。

往群聊投递后，验证方式：

```powershell
node "$L\botstate.mjs" room          # 看 seq 有没有涨
node "$L\botstate.mjs" log           # 看最后几条是谁说的什么
```

## 失败处理

**命令没返回不等于系统坏了。** 本机 PowerShell 对内联命令有损：多行、含 `$` 变量、嵌套引号或中文会被截断。硬规则：

- 复杂逻辑先写成 ASCII 的 `.ps1`，再 `powershell -NoProfile -ExecutionPolicy Bypass -File <路径>`
- 单次调用保持短小，不阻塞超过 30 秒
- 长任务后台投递 + 短轮询

**投递成功但没回复**：先 `botstate.mjs room` 看群聊有没有动静，再 `diag-dsh.mjs` 看端口，最后 `probe.mjs` 发探针。三者都排除，才考虑重启 DSH。

**任务卡住**：`tasks.mjs show <ID>` 看状态是 `dispatched` 还是 `running`。`running` 时间长通常是在读大文件，别急着取消。

## 硬规则

1. **不许编造。** 数字、行号、文献、DOI 都必须有出处。查不到写「未检索到」，不写「不存在」。
2. **不许把使用当创新。** 用了 Otsu、KNN、孪生网络本身不是贡献，除非原文主张首次或实质改进。
3. **不许跳过验收。** 团队会退修，但也会犯「声称核对实际抽查」的错。产物要自己抽检。
4. **串行执行。** 同一时间一个活跃任务，`--force` 只在明确知道后果时用。
5. **归属分清。** DSH 是 DeepSeek 的，ds-bot 是社区开源的，本仓库写的是中间连接层和技能包。对外表述不要混。
6. **AI 是辅助。** 读文献、核引用、记实验可以做；研究问题、方法选择、结论解释由人定。

## 当前团队

群聊 `科研论文组`，7 个成员：

| Bot | 职责 |
|---|---|
| Chief | 接单、拆解、分工、验收、退修 |
| 小研 | 文献检索、引用核验、精读 |
| 选题 | 研究问题生成与评估 |
| 实验 | 实验设计与复现 |
| 写作 | 论文结构与正文 |
| 图表 | 科研绘图 |
| 审稿 | 独立审稿，只挑问题不改稿 |

每个 Bot 的详细技能包在 `OH-WorkSpace\skills-for-bots\`，用 `apply-skills.mjs` 写入，改完立即生效。
