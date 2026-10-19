# limbs 体系说明（移植指南）

这份文档的目标只有一个：让另一个人、或者另一个 AI，读完它能在自己的机器上重建同样一套东西。

`README.md` 是操作手册（怎么用），本文件是想清楚（为什么这样搭、依赖什么、换机器要改哪里）。

## 一、这套东西解决什么问题

一个 AI 智能体如果只会在对话框里说话，它就不能算工作系统。它需要三样东西：

1. 能让外部程序真的动起来（拉起桌面应用、下发任务）
2. 能知道外部程序什么时候做完了（不是猜，是事件）
3. 能留下可追溯的记录（谁在什么时候做了什么，成没成）

这套体系把这三件事做成 12 个可独立运行的小模块，每个模块只依赖 Node 标准库和一个配置文件。

它不是框架，没有依赖注入、没有插件容器、没有抽象层。每个文件是一个能单独跑的命令。

## 二、架构

```
                    ┌─────────────────┐
                    │  大脑（Agent）   │
                    │  判断 / 决策     │
                    └────────┬────────┘
                             │ 命令行 + 文件
        ┌────────────────────┼────────────────────┐
        │                    │                    │
   ┌────▼─────┐        ┌─────▼──────┐      ┌─────▼──────┐
   │ dispatch │        │   tasks    │      │    refs    │
   │ 下发闭环 │        │  任务单    │      │  文献回链  │
   └────┬─────┘        └─────┬──────┘      └─────┬──────┘
        │                    │                    │
        │              ┌─────▼──────┐      ┌─────▼──────┐
        │              │ wait-turn  │      │ zotero-core│
        │              │ 等完成信号 │      │ 拉起+读写  │
        │              └─────┬──────┘      └─────┬──────┘
        │                    │                    │
   ┌────▼─────┐        ┌─────▼──────┐      ┌─────▼──────┐
   │ dsh-core │        │   inbox    │      │   Zotero   │
   │ RPC 下发 │◄───────│ 增量消费   │      │  10+ 本地API│
   └────┬─────┘        └─────┬──────┘      └────────────┘
        │                    │
   ┌────▼─────┐        ┌─────▼──────────┐
   │ DSH 桌面 │───────►│ hana-bridge 插件│
   │  :43129  │ 事件   │ 写 turn/end    │
   └──────────┘        └────────────────┘

   横切：config.mjs（配置）  audit.mjs（审计）  health.mjs（自检）
```

## 三、组件清单

| 文件 | 职责 | 依赖 | 入口 |
|---|---|---|---|
| `config.mjs` / `config.json` | 唯一的配置来源，路径全部在这里解析 | 无 | `node config.mjs` 打印解析结果与存在性检查 |
| `audit.mjs` | 统一审计日志，按天分片 JSONL | config | `node audit.mjs stats` |
| `zotero-core.mjs` | Zotero 拉起、本地 API 读写、写授权 | config / audit | `node zotero-core.mjs status` |
| `dsh-core.mjs` | DSH 凭证链与 RPC（在 `DSH-Desktop-Bridge/bin/`） | config.json（同步读） | 被其他模块 import |
| `health.mjs` | 两端统一自检 | zotero-core / dsh-core | `node health.mjs` |
| `tasks.mjs` | 任务单状态机与产物目录 | config / audit | `node tasks.mjs list` |
| `inbox.mjs` | 增量消费 DSH 完成事件 | config / audit / events | `node inbox.mjs` |
| `events.mjs` | 事件日志统一读取层，跨分片合并 | config | `node events.mjs files` |
| `wait-turn.mjs` | 阻塞等某会话的下一轮结束 | config | `node wait-turn.mjs --session X` |
| `dispatch.mjs` | 任务单下发闭环 | tasks / dsh-core / audit | `node dispatch.mjs --task T...` |
| `refs.mjs` | 文献四层回链 | zotero-core / config / audit | `node refs.mjs status` |
| `import-classics.mjs` | 批量导入文献到 Zotero | zotero-core | `node import-classics.mjs --dry` |
| `fetch-arxiv.mjs` | 从 arXiv API 取元数据 | 网络 | `node fetch-arxiv.mjs 1512.03385` |
| `probe.mjs` / `diag-dsh.mjs` | 端口与判定逻辑诊断 | 无 | 排查用 |
| `test-*.mjs` | 各层验收脚本，自带清理 | 对应模块 | 见 README |
| `test-failure.mjs` | 故障注入，验出错时正确报错 | 全部 | `node test-failure.mjs` |

## 四、外部依赖

| 依赖 | 版本基线 | 为什么必须 |
|---|---|---|
| Node.js | ≥ 20（实测 24.12 / 24.17） | 需要原生 `fetch`、ESM 顶层 await |
| Zotero | **10.0.6 及以上** | 本地 API 的写能力（`POST /api/local/authorize`）只有 Zotero 10+ 才有。Zotero 7–9 的本地 API 只读 |
| DSH Desktop | 实测包版本 0.1.197 | 提供 43129 端口的 RPC 与 `harness.log` 启动行 |
| hana-bridge 插件 | 本仓库 `dsh-plugin/hnabridge` | 订阅 `session/event`，把 `turn/end` 落盘。没有它就没有完成信号 |
| 宿主 Agent | 需具备：执行命令、后台任务化、`wait_for_tasks` | 大脑侧的「推送」是靠把等待做成后台任务实现的 |

不需要的东西：数据库、消息队列、容器、任何第三方 npm 包。全部模块只用 Node 标准库。

## 五、三条主链路

**A. 探活与拉起**

`health.mjs` 先自己三轮 TCP 探活 → 不通则查进程数 → 进程数为 0 才 spawn → 等端口就绪。
进程还在但端口不通时**拒绝 spawn**，因为两个应用都是单实例，spawn 会顶掉正在运行的实例。

**B. 任务下发**

`tasks.mjs create` 建任务单 → `dispatch.mjs` 渲染成固定文本 → `dsh-core.submit` 异步投递 → `hana-bridge` 写 `turn/end` → `dispatch` 轮询该日志 → 命中的同时把任务单推到 `running` → 大脑核对验收标准后手工置 `done`。

`done` 不由脚本置位，这是硬规矩。

**C. 文献回链**

`refs.mjs link` 扫 `references.md` 与 Zotero 顶层条目 → 标题规范化后匹配（精确优先，包含次之，长度比 < 0.6 不算）→ 写 `refs.map.json`。
主键用 R 号（稿件里写的就是它），Zotero key 是可重建的外键。

## 六、换一台机器怎么重建

```bash
# 1. 复制目录（保持相对位置）
#    limbs/                    本仓库
#    tasks/                    任务单数据
#    DSH-Desktop-Bridge/       DSH 桥接
#    research/40-knowledge/cards/    精读卡

# 2. 改配置（唯一必改的文件）
#    编辑 limbs/config.json：workspace、zotero.exe、dsh.exe、日志路径

# 3. 自检
node limbs/config.mjs        # 每一项 ok 才继续
node limbs/health.mjs        # 两端都要 ok

# 4. 验收
node limbs/test-tasks.mjs    # 任务单状态机
node limbs/test-write.mjs    # Zotero 写入（首次会在 Zotero 弹窗，选 Always Allow）
node limbs/refs.mjs status   # 文献回链
```

插件安装（DSH 侧，只需一次）：

```
把 dsh-plugin/hnabridge 目录联接或复制到
%APPDATA%\dsh-desktop\harness\profiles\web\node_modules\hana-bridge
并在该 profile 的 package.json 的 dsh.profile.bundles 里加一行 hana-bridge
```

## 七、配置项

`limbs/config.json` 每一项都可以被环境变量覆盖，便于临时切换：

| 配置 | 环境变量 | 说明 |
|---|---|---|
| `workspace` | `LIMBS_WORKSPACE` | 工作区根目录，相对路径都相对它解析 |
| `stateDir` | `LIMBS_STATE` | cookie、写授权 key、inbox 偏移等状态文件 |
| `paths.*` | 无 | 任务、审计、精读卡、登记表、映射表、稿件的路径 |
| `zotero.exe` | `ZOTERO_EXE` | Zotero 可执行文件 |
| `zotero.port` | `ZOTERO_PORT` | 默认 23119 |
| `dsh.exe` | `DSH_EXE` | DSH Desktop 可执行文件 |
| `dsh.logPath` | `DSH_LOG` | `harness.log`，从中读最后一条启动行换 cookie |
| `dsh.bridgeLogPath` | `HANA_BRIDGE_LOG` | 事件日志，`turn/end` 从这里读 |
| `dsh.provider/model` | 无 | 新建会话时选的模型 |

自动拉起可以用 `ZOTERO_NO_AUTOSTART=1` / `DSH_NO_AUTOSTART=1` 关掉，只探活。

## 八、设计约束

八条完整说明在 `README.md` 的「设计约束」一节，这里只列结论：

1. 探活必须在拉起之前，单轮探活不足以判定死亡
2. 进程还在但端口不通时，绝不 spawn
3. 拉起是可见动作，必须留痕（`notes` 行）
4. 写入需要用户在场（Zotero 本地 key 只能由人在弹窗授权）
5. 依赖桌面会话已登录（锁屏或无人值守时结论不成立）
6. 并发调用必须单飞（同一进程内共用一个 in-flight Promise）
7. 审计不能影响主流程（写日志失败静默）
8. 同名不同物（`dsh.mjs` 和 `dsh-core.mjs` 是两套 send 实现，两边都要接）

## 九、已知局限

不写清这些，别人接过去一定会踩。

| 局限 | 影响 | 现在的处理 |
|---|---|---|
| 一个 `wait-turn` 只盯一个会话 | 三任务并行要挂三个等待任务 | 接受，够用但笨 |
| 「自动唤醒」靠后台任务 + `wait_for_tasks`，不是平台级执行注入 | 宿主要支持后台命令与任务等待 | `loop_control` 那条路走不通（无活跃循环） |
| Zotero 写授权只能人工点 | 全新环境第一次必须有人在 | 选 Always Allow 后 key 长期有效 |
| 事件日志无轮转 | 已解决：按天分片 + 统一读取层，旧单文件兼容 | 2026-10-19 改 |
| 任务会否静默卡死 | 已解决：deadline + sweep，超期自动置 failed | 2026-10-19 改 |
| 重复投递 | 已解决：五分钟门禁 + dispatchToken | 2026-10-19 改 |
| 文献匹配靠标题字面 | 中文简称、作者+年份式提及会漏 | `refs.mjs mention` 只作线索，结论靠人 |
| 精读卡没有自动生成 | 只能手写，无法批量补 | 结构已定，内容属研究工作 |
| 单实例应用被外部重启会中断任务 | DSH 被 spawn 时正在跑的任务会断 | 用进程守卫避免误拉 |
| 全部命令依赖桌面会话 | 无人值守场景不成立 | 明确写死，不假装支持 |

## 十、验收证据

每一层都有对应的实测记录，位置如下：

| 项 | 证据 | 记录 |
|---|---|---|
| L0.1 DSH 自动拉起 | 两次真实唤醒（窗口关闭后拉起，43 会话完好） | README 设计约束一 |
| L0.2 Zotero 自动拉起 | 冷启动 5.4 秒、5.6 秒 | README 事实基线 |
| L0.3 统一自检 | `health.mjs` 热检查 158 毫秒 | — |
| L1.1 Zotero 读写 | 创建/读回/PATCH/DELETE 全通过 | `test-write.mjs` |
| L1.2 下发与回收 | dispatch 端到端 90.9 秒 | `tasks/T20261019-02-1b25.json` |
| L1.3 并发不串 | 两轮 12 项判据全过 | `tasks/T20261019-01-ccbc/concurrency.md` |
| L2.1 回传主动性 | wait-turn 8.06 秒唤醒 | README 完成信号一节 |
| L3.1 任务单规范 | 状态机自测 18 项全过 | `test-tasks.mjs` |
| L4.1 四层回链 | 绑定 27/37，审计出 12 处无标记 | `research/60-writing/ref-audit-20261019.md` |
| L5.1 审计 | 六个动作已接入 | `audit.mjs stats` |
| L5.2 故障注入 | 13 项全过，含版本冲突 412 与对照组 | `test-failure.mjs` |

## 十一、这份体系里没有的东西

说清楚边界同样重要：

- 没有自动重试。失败原因没读明白就重试，只会重复失败。
- 没有优先级队列。排序靠人，不靠字母。
- 没有权限系统。它假设运行者就是机器的主人。
- 没有跨机器同步。所有状态在本机文件里。
- 没有把「研究判断」自动化。选题、方法、结论始终由人定。
