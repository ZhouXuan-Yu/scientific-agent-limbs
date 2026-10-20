# 复刻指南（这份文件是写给 AI 看的）

你把仓库地址发给我，我按这份文件在你这台机器上重建这套体系。每一步都有验证命令，验证不过就停下说明原因，不往下编。

## 开始之前，先确认四件事

```
1. 操作系统    Windows 10/11（当前实现依赖 PowerShell 与桌面 GUI 应用启动）
2. Node.js     >= 20（需要原生 fetch 与 ESM 顶层 await）
3. Zotero      10.0 以上（写能力只有 10+ 有）
4. DSH Desktop 已安装，且能打开设置 → 插件
```

任一项不满足，直接告诉我卡在哪，不要试图绕。

## 第一步：确认 Zotero 的本地 API 已开

Zotero → 设置 → 高级 → 勾选 `Allow other applications on this computer to communicate with Zotero`。

验证：

```bash
curl.exe -s -D - -o NUL "http://127.0.0.1:23119/api/"
```

期望看到 `X-Zotero-Version` 和 `Zotero-Server-ID` 两个响应头。

看不到就是没开，或者 Zotero 没运行。先解决这个，别往下走。

## 第二步：装 DSH 的两个插件

**ds-bot**（科研团队本体）：DSH 设置 → 插件 → 添加 `ds-bot`。

**hana-bridge**（把每轮结束信号落盘）：把仓库的 `dsh-plugin/hnabridge` 目录链到 DSH profile 的 `node_modules/hana-bridge`，再在该 profile 的 `package.json` 的 `dsh.profile.bundles` 里加一行 `hana-bridge`。

装完重启 DSH Desktop。

验证：启动后检查日志目录出现 `hana-bridge-events-YYYYMMDD.jsonl` 这个文件。

## 第三步：建团队

第一次打开 ds-bot 会自动建一个叫 Chief 的 Main Bot。再建六个：小研、选题、实验、写作、图表、审稿。

每个 Bot 的角色与职责照 `README.md` 里的表填。群公告照抄这一段：

> 科研论文组：总管理事（Chief）接单拆解分发；选题负责研究问题生成与体检，文献证据找小研；实验负责实验设计与复现；写作负责论文结构与正文；图表负责论文配图；审稿负责独立审稿与投稿前自检。质量门禁：引用必须核验，未核验的标注「尚未完成外部验证」；含定量结果必须过统计审查；实验结果入稿必须有数据版本、代码提交与随机种子；不得编造文献、DOI、数据；结论必须区分事实、文献、推断、未知。

然后把七份技能包灌进去：

```bash
node skills-for-bots/apply-skills.mjs
```

这个脚本会改 `%APPDATA%\dsh-desktop\harness\bot\state.json`。**改之前先备份这个文件。**

## 第四步：配置

```bash
cp limbs/config.example.json limbs/config.json
```

要改六个值：

| 字段 | 从哪来 |
|---|---|
| `workspace` | 你自己的工作目录绝对路径 |
| `zotero.exe` | Zotero 安装路径，注册表 `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\zotero.exe` 里能查到 |
| `dsh.exe` | DSH Desktop.exe 的路径 |
| `dsh.logPath` | `%APPDATA%\dsh-desktop\logs\harness.log` |
| `dsh.bridgeLogPath` | `%APPDATA%\dsh-desktop\harness\logs\hana-bridge-events.jsonl` |
| `bot.roomSessionId` | 见下一步 |

## 第五步：拿到群聊的 session id

这个是唯一需要手工找的。DSH 里打开科研群聊，在会话列表里找到它的 sessionId；或者在 `%APPDATA%\dsh-desktop\harness\bot\state.json` 里搜 `rooms`，第一条的 `id` 就是。

填进 `config.json` 的 `bot.roomSessionId`，同时把 Chief 的 sessionId 填进 `bot.chiefSessionId`（在同一个文件的 `bots` 里，名字是 Chief 的那条）。

## 第六步：验收

按顺序跑，前一条通过再跑下一条：

```bash
node limbs/config.mjs      # 每一项都要 ok
node limbs/health.mjs      # RESULT: OK
node limbs/test-tasks.mjs  # 任务单状态机，18 项
node limbs/test-failure.mjs # 故障注入，13 项
```

`test-write.mjs` 会在 Zotero 里建一条测试笔记，第一次跑需要你在 Zotero 弹窗里点 **Always Allow**。不想授权写权限就跳过它，只做只读也能跑。

## 第七步：发第一个任务

```bash
node limbs/tasks.mjs create --file my-task.json
node limbs/dispatch.mjs --task T2026... --via room
```

`my-task.json` 照 `tasks/SCHEMA.md` 写。最小的样子：

```json
{
  "title": "一句话说清要做什么",
  "goal": "要达成什么。写清边界和允许的动作。",
  "acceptance": ["可判定的条目一", "可判定的条目二"],
  "limb": "bot",
  "deadlineMinutes": 20
}
```

跑通之后你应该看到：群聊里出现你的任务单，Chief 判断分工，成员执行，`dispatch` 在三信号静止后返回产物。

## 出问题怎么办

| 现象 | 先查什么 |
|---|---|
| `health.mjs` 报 Zotero 不通 | 23119 端口有没有监听；本地 API 有没有开 |
| Zotero 能读不能写 | 没授权写 key。`node limbs/test-write.mjs` 会触发授权弹窗 |
| 群里没反应 | 群聊 sessionId 填对了吗；Bot 是不是都被拉进群了 |
| `dispatch` 一直等到超时 | 看 `botstate.mjs room` 的输出，确认团队有没有接单 |
| 任务完成了但没收到 | 这是「信息回流」要解决的问题，见 README 那一节。先确认 `memberReplies()` 能读到成员 session |

## 复刻到什么程度算成功

不是「跑起来了」就算成功。三条都满足才算：

1. `test-failure.mjs` 全过 —— 出错时系统会正确报错，而不是静默通过
2. 群聊里能看到完整的派单与验收过程 —— 不是一个人从头做到尾
3. 产物里每个数字都能追到来源 —— 不是「看起来对」

第三条最难，也最重要。如果重建出来的系统只能产出「看起来对」的东西，那它和普通 AI 助手没有区别。
