# 下载名单

一台干净机器上要准备什么，每一项怎么装、怎么验、能不能自动。

这份文件是清单，不是安装器：仓库里没有一键自检脚本。每一项下面都给了验证命令，装完逐条自己跑。软件装齐之后的关系搭建（插件、config、session id）见 `REPLICATE.md` 第二到第六步。

---

## 必需

| # | 软件 | 版本 | 装在哪 | 下载 | 是否可自动 |
|---|---|---|---|---|---|
| 1 | **Node.js** | ≥ 20（实测 v24.12） | 全局 | https://nodejs.org/zh-cn/download | 可脚本化。`winget install OpenJS.NodeJS.LTS` 或官方 MSI 静默安装；仓库未随附脚本 |
| 2 | **Zotero** | **≥ 10.0** | 全局 | https://www.zotero.org/download | 不能，官网安装包手动装 |
| 3 | **DSH Desktop** | 实测内核 0.2.0-rc.2 | 全局 | 你的分发渠道 | 不能，没有公开分发 |
| 4 | **ds-bot** | ≥ 0.1.7 | DSH 插件 | DSH 设置 → 插件 → 添加 `ds-bot` | 不能，要在 DSH 里装 |
| 5 | **hana-bridge** | 本仓库 | DSH 插件 | 仓库的 `dsh-plugin/hnabridge` | 可脚本化。建目录链接 + 登记 bundle，手工照 REPLICATE.md 第二步做，约两分钟 |

### 为什么 Zotero 必须是 10+

写能力（新建条目、改标签、挂附件）是 Zotero 10 才加的本地 API。7 到 9 的本地 API 只读，装上去能查不能写。

判断方法：Zotero 帮助 → 关于；或 `(Get-Item "C:\Program Files\Zotero\zotero.exe").VersionInfo.ProductVersion`。

### Zotero 装完必须做一个设置

Zotero → 设置 → 高级 → 勾选 **Allow other applications on this computer to communicate with Zotero**。

默认是关的。不勾这一项，端口 23119 不会监听，整套东西连不上文献库。

验证：

```bash
curl.exe -s -D - -o NUL "http://127.0.0.1:23119/api/"
```

看到 `X-Zotero-Version` 和 `Zotero-Server-ID` 两个响应头就算通了。

---

## 可选

| 软件 | 用途 | 下载 | 说明 |
|---|---|---|---|
| ffmpeg | 合成演示 GIF | https://ffmpeg.org/download.html | 只在你自己做演示图时需要，跑流程不需要 |
| Git | 拉仓库、看历史 | https://git-scm.com/download/win | 下载 zip 就不需要 |

---

## 不需要的

明确说明，免得你多装：

- **不需要数据库**。任务单是 JSON 文件，审计是 JSONL，靠文件系统。
- **不需要消息队列**。完成信号走事件日志 + 阻塞等待。
- **不需要 Python**。全部模块是 Node 标准库，零第三方依赖。
- **不需要 `npm install`**。仓库里没有 `package.json` 依赖项。

---

## 装完的顺序

软件装齐了不等于能用，还要建关系。顺序是：

```
1. 启动 DSH，确认它在跑
2. DSH 里装 ds-bot，建 Chief + 小研 + 选题 + 实验 + 写作 + 图表 + 审稿 七个 Bot
3. 建一个群聊，把七个 Bot 拉进去，群公告抄 README 那一节
4. 按 REPLICATE.md 第二步链接 hana-bridge 并在 profile 的 package.json 里登记 bundle，第四步复制 config.example.json 为 config.json
5. 手工填 config.json 的两个 session id（群聊的、Chief 的）
6. 跑 health.mjs 验收
```

第 5 步是唯一无法自动的：session id 是 DSH 建群时才生成的，得从 `%APPDATA%\dsh-desktop\harness\bot\state.json` 的 `rooms` 和 `bots` 里抄，或者在 DSH 会话列表里看。

---

## 出问题先看这里

| 现象 | 原因 | 处理 |
|---|---|---|
| 端口 23119 不监听 | 本地 API 没勾选，或 Zotero 没运行 | 设置 → 高级 → 勾选；启动 Zotero |
| 端口 43129 不监听 | DSH 没启动 | 打开 DSH Desktop；端口以 `harness.log` 最后一行为准，可能不是 43129 |
| 自写的 `.ps1` 报「无法加载，因为在此系统上禁止运行脚本」 | 执行策略 | 用 `powershell -NoProfile -ExecutionPolicy Bypass -File <脚本>` 调用；`.mjs` 走 node，不受此限 |
| 控制台输出中文乱码 | 终端按 ANSI 解码 | 先 `chcp 65001`；存 UTF-8 带 BOM |
| hana-bridge 目录建好了但没生效 | 没重启 DSH | 重启 DSH Desktop，插件在启动时加载 |
| ds-bot 显示 0 个 Bot | 只装了插件没启动过 | 打开一次 ds-bot，它会自动建 Chief |
