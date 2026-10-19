# scientific-agent-limbs

给 AI 智能体装上手和脚。

一个智能体如果只会在对话框里说话，它就不算工作系统。这套东西解决三件具体的事：让外部程序真的动起来、知道它们什么时候做完了、留下可追溯的记录。

它不做研究判断，不写论文，不替你选题。它只负责把「大脑」和「四肢」之间的那条链路做扎实。

## 它解决什么问题

让 AI 操作桌面软件，通常是这样失败的：

- 程序没开着，调用的第一行就报错，而 AI 不知道要先把程序拉起来
- 拉起了，但不知道要等多久才可用，于是随机失败
- 任务发出去了，不知道对面什么时候干完，只能反复去问
- 干完了，但结果散在几十个会话里，对不上是哪件任务
- 出问题了，只看得到「结果不对」，看不到「哪一步、什么时候、用什么参数」

这套东西每一层都针对上面一条。而且每个结论都有实测记录，没验证的会明确标「未验证」。

## 能力

| 能力 | 模块 | 实测结论 |
|---|---|---|
| 拉起并探活桌面程序 | `zotero-core.mjs` / `dsh-core.mjs` | Zotero 冷启动 5.4 秒；探活三轮重试，避免单次误判 |
| 进程守卫 | 同上 | 进程活着但端口不通时拒绝 spawn，不擅自杀掉你在用的实例 |
| 桌面应用读写 | `zotero-core.mjs` | Zotero 10+ 本地 API 全通：创建/读回/PATCH/DELETE |
| 任务单状态机 | `tasks.mjs` | 六状态，非法迁移拒绝；`done` 必须人工核对后置位 |
| 完成信号 | `inbox.mjs` / `wait-turn.mjs` | DSH 每轮结束落 `turn/end`，8 秒内可唤醒调用方 |
| 一条命令下发 | `dispatch.mjs` | 渲染 → 投递 → 等事件 → 回写，端到端 90.9 秒 |
| 并发不串 | `test-concurrency.mjs` | 三路并行 12 项判据全过，6124 毫秒 |
| 文献四层回链 | `refs.mjs` | R 号 ↔ Zotero key ↔ 精读卡 ↔ 草稿标记 |
| 统一审计 | `audit.mjs` | 六类动作落盘，含耗时与失败原因 |
| 配置外置 | `config.mjs` | 全仓零硬编码，换机器只改一个 JSON |

## 快速开始

前置：Node.js ≥ 20、Zotero 10+、DSH Desktop，以及一个能执行命令并把长任务后台化的宿主 Agent。

```bash
# 1. 复制目录，保持相对位置
#    limbs/  tasks/  dsh-plugin/

# 2. 配置
cp limbs/config.example.json limbs/config.json
#    编辑：workspace、zotero.exe、dsh.exe、两个日志路径

# 3. 自检
node limbs/config.mjs      # 每一项都要 ok
node limbs/health.mjs      # RESULT: OK

# 4. 验收
node limbs/test-tasks.mjs  # 任务单状态机，18 项
```

让 DSH 的完成事件能被收集，还需要装一次插件：

```
dsh-plugin/hnabridge  →  %APPDATA%\dsh-desktop\harness\profiles\web\node_modules\hana-bridge
在该 profile 的 package.json 的 dsh.profile.bundles 里追加 "hana-bridge"
重启 DSH Desktop
```

## 架构

```
大脑（Agent）
   │ dispatch / tasks / refs / health
   ▼
┌──────────────┬──────────────┐
│  dsh-core    │ zotero-core  │   拉起 · 探活 · 读写 · 守卫
└──────┬───────┴──────┬───────┘
       ▼              ▼
  DSH Desktop     Zotero 10+
   43129 RPC       23119 本地 API
       │
       ▼  turn/end
  hana-bridge 插件 ──► 事件日志 ──► wait-turn ──► 唤醒大脑
```

详细设计、依赖版本、重建步骤见 [limbs/ARCHITECTURE.md](limbs/ARCHITECTURE.md)。

## 几条不肯让步的原则

**探活必须在拉起之前，且单轮探活不算数。** 一次连接失败可能只是瞬时抖动，据此拉起会中断正在跑的任务。

**进程还在但端口不通时，绝不 spawn。** 宁可上报「不通」，也不擅自杀掉你正在用的实例。

**任务状态由证据决定，不由自述决定。** 末端说「完成了」不等于完成，`done` 只能由大脑逐条核对验收标准后置位。

**审计不能影响主流程。** 写日志失败一律静默。代价是审计可能有缺口，这个取舍认了。

**没验证的不许说已验证。** 每项能力在文档里都标了证据来源，测过什么、没测什么写清楚。

## 局限

这套东西不是万能的，这几条必须知道：

- 三个应用都是单实例，被外部重启时正在跑的任务会断
- Zotero 写授权只能由人在弹窗点，全新环境第一次必须有人在
- 「自动唤醒」靠后台任务 + 宿主等待机制，不是平台级执行注入
- 一个 `wait-turn` 盯多个会话时，仍需调用方自己调度
- 全部依赖桌面会话已登录，锁屏或无人值守场景不成立
- 文献匹配靠标题字面，中文简称和「作者+年份」式提及会漏

## 许可

MIT。见 [LICENSE](LICENSE)。
