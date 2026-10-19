# limbs —— 大脑-四肢桥接层

Hana 是决策层，DSH 与 Zotero 是执行与记忆末端。这个目录负责让"末端不在线时能被拉起、在线时能被确认"。

没有这一层，大脑会在断腿上盲指挥：以为自己下发了任务，实际对面没在跑。

## 目录

| 文件 | 职责 |
|---|---|
| `config.mjs` / `config.json` | 唯一配置来源，所有路径在这里解析；换机器只改这一个文件 |
| `ARCHITECTURE.md` | 移植指南：依赖、重建步骤、局限、验收证据索引 |
| `zotero-core.mjs` | Zotero 拉起 + 本地 API 内核（对齐 `DSH-Desktop-Bridge/bin/dsh-core.mjs`） |
| `health.mjs` | 两端统一自检，一条命令报 DSH 与 Zotero 状态 |
| `tasks.mjs` | 任务单内核（L3.1），规范见 `tasks/SCHEMA.md` |
| `inbox.mjs` | DSH 完成信号的消费端（L2.1 读侧）：增量读 turn/end |
| `events.mjs` | 事件日志统一读取层：跨天分片合并读，兼容旧单文件 |
| `wait-turn.mjs` | 盯住日志等某个会话的下一轮结束，作为后台任务被 wait_for_tasks 等 |
| `dispatch.mjs` | 任务单下发闭环：渲染 → 异步投递 → 等事件 → 回写 running |
| `daemon.mjs` | 状态守护：清扫超期、推进卡住的任务、留摘要（不置 done） |
| `test-concurrency.mjs` | L1.3 验收：三路并行下发，检查结论不串 |
| `test-failure.mjs` | L5.2 验收：故障注入，验证出错时系统正确报错 |
| `test-daemon.mjs` | L2.2 验收：守护推进与幂等 |
| `refs.mjs` | L4.1 四层回链：R 号 ↔ Zotero key ↔ 精读卡 ↔ 草稿段落 |
| `audit.mjs` | L5.1 统一审计日志：记录每个动作的时间、目标、成败、耗时 |
| `import-classics.mjs` | 把登记表已核题录的文献批量导入 Zotero，extra 写 RefsID |
| `fetch-arxiv.mjs` | 从 arXiv 官方 API 取作者与标题，用于补全回链 |
| `test-tasks.mjs` | 任务单内核自测：状态机、非法迁移、渲染、清理 |
| `test-write.mjs` | Zotero 写入端到端验收（L1.1） |
| `probe.mjs` | 单点 TCP 探活诊断（测端口通不通、几毫秒、几轮） |
| `diag-dsh.mjs` | DSH 侧安全诊断：禁止拉起的前提下看 ensureRunning 如何判定 |

任务单数据在 `OH-WorkSpace/tasks/`，一张单子一个 JSON 加一个同名产物目录。字段与状态机见 `tasks/SCHEMA.md`。

## 事实基线（2026-10-19 实测，非推断）

| 项 | 值 |
|---|---|
| Zotero 可执行文件 | `D:\Zotero\zotero.exe` |
| Zotero 版本 | 10.0.6（BuildID 2026-09-22 12:43:38） |
| Zotero 本地 API | `http://127.0.0.1:23119`，内置 HTTP server，**无需 API key** |
| Zotero 库 | user id 21689344，顶层条目 49，库版本 175，ServerID `6BhrY8p0jQc7` |
| DSH 可执行文件 | `D:\DSH\DSH Desktop\DSH Desktop.exe` |
| DSH 端口 | 43129，凭证从 `%APPDATA%\dsh-desktop\logs\harness.log` 最后一条启动行换 cookie |
| Zotero 冷启动耗时 | 约 5.4 秒（started=true，via spawn） |
| 两端热检查耗时 | 约 158 毫秒 |

Zotero 本地 API 响应头可直接读：`X-Zotero-Version`、`Zotero-Server-ID`、`Total-Results`、`Last-Modified-Version`、`Zotero-Schema-Version`。

### 本地 API 的写入能力（2026-10-19 核官方文档并实测）

Zotero **10+** 的本地 API 开放了 `POST` / `PUT` / `PATCH` / `DELETE`，与 Web API 的写请求格式一致。网上「本地 API 只读」的说法属于 Zotero 7 时代，对 10 已不成立。约束如下：

| 项 | 规则 |
|---|---|
| Server-ID 头 | 每个写请求必须带 `Zotero-Server-ID`，缺失返回 `428` |
| 写 key | 必须带 `Zotero-API-Key`，缺失或失效返回 `401` |
| key 来源 | 运行时申请：`POST /api/local/authorize`，body `{"appName":"..."}`，**必须用户在 Zotero 弹窗里点 Allow / Always Allow** |
| key 生命周期 | 选 Always Allow 返回 `remember:true`，可长期复用；否则 key 一次性，首个写请求后作废 |
| 频控 | 每分钟最多 5 次会弹窗的授权请求，超出返回 `429` + `Retry-After` |
| 撤销 | Zotero 设置 → 高级 → Clear Write Authorizations |
| 副作用 | 写入是普通本地改动，界面立刻可见，下次同步会上传 zotero.org |
| 局部上传 | 二进制 diff 上传不支持，`PATCH .../file` 返回 `405` |

`zotero-core.mjs` 把 Always Allow 得到的 key 按 Server-ID 分区缓存在 `<stateDir>/local-key.json`。换库或换机器时 Server-ID 变化，旧 key 自动不再匹配。

## 用法

```bash
# 两端自检（缺失则自动拉起）
node limbs/health.mjs

# 纯诊断，绝不拉起
node limbs/health.mjs --no-start

# 机器可读
node limbs/health.mjs --json

# 单端
node limbs/zotero-core.mjs status        # 探活+拉起+健康快照
node limbs/zotero-core.mjs ping          # 只探活
node limbs/zotero-core.mjs open          # 确保在运行
node limbs/zotero-core.mjs collections   # 列顶层分类及条目数
node limbs/zotero-core.mjs authorize     # 申请写入授权（Zotero 弹窗，选 Always Allow）
node limbs/test-write.mjs                # L1.1 验收：创建/读回/改标签/删除 端到端
node limbs/test-tasks.mjs                # L3.1 验收：任务单状态机自测
node limbs/test-failure.mjs              # L5.2 验收：六类故障注入
node limbs/test-daemon.mjs               # L2.2 验收：守护推进与幂等

# 文献回链
node limbs/refs.mjs link                           # 扫登记表与 Zotero，重建 refs.map.json
node limbs/refs.mjs status                          # 四层覆盖概览
node limbs/refs.mjs trace R-011                     # 反查一条文献的四层状态
node limbs/refs.mjs mention                         # 找「正文提了但没标引用」的位置
node limbs/refs.mjs check                           # 只做校验
node limbs/import-classics.mjs --dry                # 看将导入哪些条目

# 审计日志
node limbs/audit.mjs stats                          # 按动作汇总成败与耗时
node limbs/audit.mjs tail --n 20                    # 最近 20 条
node limbs/audit.mjs query --actor dsh              # 按工具过滤
node limbs/audit.mjs since 2026-10-19T08:00:00Z      # 从某时刻起

# 任务单
node limbs/inbox.mjs                              # 读 DSH 新的完成事件
node limbs/inbox.mjs --all --json                 # 全部历史，机器可读
node limbs/inbox.mjs --reset                      # 丢弃积压，偏移归零到末尾
node limbs/wait-turn.mjs --session session-xxx --timeout 600   # 阻塞等下一轮结束
node limbs/dispatch.mjs --task T... --timeout 600  # 任务单一条命令下发并等回报
node limbs/dispatch.mjs --task T... --via bot      # 经 ds-bot 团队（Chief）执行
node limbs/daemon.mjs --once                      # 跑一轮状态守护
node limbs/daemon.mjs --report                    # 只看摘要（进场先看这个）
node limbs/daemon.mjs --interval 60               # 常驻（Ctrl-C 退）
node limbs/tasks.mjs list                         # 全部任务
node limbs/tasks.mjs list --state running         # 按状态过滤
node limbs/tasks.mjs create --file spec.json      # 新建（中文内容一律走文件）
node limbs/tasks.mjs show T20261019-01-ccbc       # 看详情
node limbs/tasks.mjs render T20261019-01-ccbc     # 渲染成下发文本
node limbs/tasks.mjs set T... --state running --file patch.json
node limbs/tasks.mjs set T... --state done --file patch.json --sync   # 结单并归档产物
node limbs/tasks.mjs verify T20261019-01-ccbc     # 打验收清单，人工逐条核对
node limbs/tasks.mjs sync T20261019-01-ccbc       # 单独重建产物清单 manifest.json
node limbs/tasks.mjs sweep [--dry]                # 清扫超期任务，超期的置 failed
node limbs/tasks.mjs find concurrency             # 反查哪些任务的产物含该片段

# 端口诊断
node limbs/probe.mjs 23119 3
node limbs/config.mjs                             # 打印解析后的配置 + 存在性检查
```

退出码：`0` 两端都通，`1` 有任意一端不通。

环境变量：`ZOTERO_EXE`、`ZOTERO_PORT`、`ZOTERO_NO_AUTOSTART=1`、`ZOTERO_START_TIMEOUT_MS`、`DSH_NO_AUTOSTART=1`、`HANA_BRIDGE_LOG`。

## 经 ds-bot 团队下发

`dispatch --via bot` 走的是另一条路。先搞清楚一件事实：

**ds-bot 的群聊消息走插件私有通道，外部 RPC 投不进去。** 2026-10-19 实测三条都不通：
往 room 会话 `科研论文组` 投 prompt、往 Chief 的私聊会话投、往 `Chief · 科研论文组` 那份隐藏会话投。
三者都返回 `accepted: true`，但 ds-bot 的 `state.json` 里 exchanges 数量一条没变。

但 Chief 的 session 本身能收外部 prompt，且它能读自己 workspace 里的文件。所以走第四条：

1. 任务写成 JSON 放进 `<bot.workspace>/tasks/<id>.json`
2. 往 Chief 的 session 投一句：「读取该文件并执行，产物写进 `<bot.workspace>/tasks/<id>/`」
3. 等 Chief 的 `turn/end`
4. 把产物从 Bot workspace 回收回工作区任务目录，否则 `sync` 扫不到

实测（2026-10-19）：30.3 秒完成第一轮。中途因某个 Bot 缺 role 字段，Chief 主动停下询问而不是编造，补充确认后 48.2 秒完成。

**代价必须说清**：任务记录不会出现在群聊界面，只会出现在 Chief 的会话里。想在群聊看到，只能人工发一次。

配置项见 `config.json` 的 `bot.workspace` 与 `bot.chiefSessionId`。

## 完成信号

大脑要判断「末端干完了没」，不能靠猜 assistant/message，也不能去轮询 DSH 内部状态。权威依据只有一个：`turn/end` 事件。

`hana-bridge` 插件（装在 DSH 侧，经 junction 链到 `DSH-Desktop-Bridge/dsh-plugin/hnabridge`）在每轮结束时向
`%APPDATA%\dsh-desktop\harness\logs\hana-bridge-events-YYYYMMDD.jsonl` 追加一行（按天分片，避免单文件无限增长）：

```json
{"kind":"turn/end","at":"...","sessionId":"session-...","turn":1,"reasonKind":null,"textChars":2,"text":"ok"}
```

`inbox.mjs` 按事件时间戳增量消费（不是行号，行号在分片下没意义），不重读、不漏读；偏移记录在 `<stateDir>/inbox-offset.json`。切换前的旧单文件仍会读，但不再增长。

**怎么做到「自动唤醒」（2026-10-19 实测）**：`loop_control` 这条路走不通，调用时提示「当前会话没有活跃循环」。改用阻塞命令：`wait-turn.mjs` 盯住日志等某个会话的下一轮结束，它作为后台任务跑，`wait_for_tasks` 在它退出时唤醒大脑。实测 8056 毫秒内捕获到 turn/end，大脑被叫醒并继续处理。

这仍然是「把等待转成可被等待的后台任务」，不是真正的执行注入，但语义上等价：DSH 干完活，大脑不需要人催、不需要轮询 DSH 内部状态就能接上。

局限：一个 wait-turn 只盯一个会话。多任务并行时需要多个等待任务，或者改成盯多个 sessionId 的版本。

## 设计约束

**一、探活必须在拉起之前，且单轮探活不足以判定死亡。**

2026-10-19 两次 `health.mjs` 报 `DSH started=true`（07:45 耗时 60.8 秒，07:53 耗时 14.3 秒）。当时按「误判」定性，后续经当事人确认：两次都是 DSH 窗口被手动关闭、由脚本正常唤醒，**不是误判**。

这个定性错误本身值得记录：单凭「探活失败 + 随后出现新启动行」推不出误判，因为「用户关闭窗口」会产生完全相同的现象。缺少关闭事件这一侧的证据时，不应把结果归因为系统缺陷。

当时已做的加固依然保留，理由是降低未来真误判的概率：

- `dsh-core.mjs` 新增 `portOpenStable`，三轮探活、间隔 400 毫秒
- `health.mjs` 先做三轮鲁棒探活，确认活着就完全不调 `ensureRunning`
- `zotero-core.mjs` 的探活改为 `waitPort(23119, 2500)`

**二、进程还在但端口不通时，绝不 spawn。**

这条不是对上面两次的修补（那两次的拉起是对的），而是补一个尚未发生的缺口：如果进程活着但端口卡住，spawn 会顶掉正在运行的实例，正在跑的任务随之中断；Zotero 则可能抢库锁、弹重复窗口。

现在的判定顺序：端口多轮探活 → 不通则查进程数 → 进程数为 0 才 spawn；进程数大于 0 则再等 15 秒端口，仍不通就返回 `refusing to spawn` 并报错。

取舍明确：宁可上报「不通」，也不擅自杀掉用户正在用的实例。

**三、拉起是可见动作，必须留下痕迹。**

两个 GUI 应用被拉起时会弹窗，可能抢焦点，Zotero 还会触发一次同步。所以 `health.mjs` 输出里保留 `notes` 行，任何自动拉起都会写明方式（`spawn` / `powershell`）。

**四、写入需要用户在场。**

本地 API 的写 key 只能由用户在 Zotero 弹窗里授权，无法预先配置。这意味着「全自动写文库」不成立：第一次必须有人在。选 Always Allow 之后 key 长期有效，后续写请求不再弹窗，但撤销权始终在用户手里。

**五、依赖桌面会话已登录。**

锁屏、远程断连、无人值守场景下，"能拉起"这个结论不成立。这是 Windows GUI 应用的固有限制。

**六、并发调用必须单飞。**

2026-10-19 并发测试首轮，三个 `send` 同时进入 `ensureRunning`，各自都判定未运行并 spawn，输出三行「已自动拉起」。虽然 DSH 单实例锁托住了结果，但同一个实例被反复顶掉没有意义。

修法是在 `dsh-core.mjs` 的 `ensureRunning` 外层加进程内单飞：并发调用共用同一个 in-flight Promise，完成后释放。修复后同一测试从 29883 毫秒降到 6124 毫秒，并且不再出现拉起日志。

这个单飞只在单进程内有效。如果将来从多个 node 进程同时调用，需要文件锁，目前没有这个场景，不做。

**七、审计不能影响主流程。**

所有工具写审计日志都是 try/catch 包围的失败静默。审计模块缺失、目录不可写、磁盘满，都不能让 DSH 下发或 Zotero 写入失败。代价是审计可能有缺口，这个取舍在诊断价值与可用性之间选了后者。

日志按天分片落在 `limbs/_audit/audit-YYYYMMDD.jsonl`，一行一个 JSON，可直接读也可直接 parse。只记动作与结果，不记业务内容全文，避免日志膨胀成第二份数据。

**八、接入时要注意同名不同物。**

首次接入审计时只改了 `dsh-core.mjs` 的 `send`，但 `dsh.mjs` 的命令行有自己一套 `submit` / `waitFor`，根本不走 `dsh-core`。结果 `audit.mjs query --actor dsh` 返回空，而下发本身是成功的。两条路径必须在两边都接，不能只看模块名。

## 验收状态

| 编号 | 事项 | 验收标准 | 状态 |
|---|---|---|---|
| L0.1 | DSH 自动拉起 | 杀掉后自动起来且 `autoStarted: true` | 通过（两次真实唤醒实证：窗口关闭后脚本拉起，43 会话完好） |
| L0.2 | Zotero 自动拉起 | 无进程时自检，23119 就绪并返回条目数 | 通过（2 次冷启动实测） |
| L0.3 | 两端统一自检 | 一条命令输出状态、版本、数据量 | 通过 |
| L1.1 | Zotero 读写 | 读条目、写 tag、挂附件 | 写通：创建 / 读回 / PATCH 改标签 / DELETE 全部 PASS；附件只探测到通道开启（400 为载荷校验拦截），真实文件上传未测 |
| L1.2 | DSH 下发与回收 | 端到端一次成功 | 通 |
| L1.3 | 并发稳定性 | 3 任务并行不串 | 通过（两轮实测，12 项判据全过；单飞修复后 6124 毫秒） |
| L2.1 | 回传主动性 | DSH 结束能主动唤醒大脑 | 通过（wait-turn + wait_for_tasks 实测 8 秒唤醒；dispatch 端到端 90.9 秒收到回报） |
| L2.2 | 状态守护 | 无人看管时状态不说谎 | 通过（11 项：卡住任务自动推进、幂等、摘要可读） |
| L3.1 | 任务单规范 | JSON 含任务号/目标/验收/产物/状态 | 通过（规范 + 内核 + 自测 18 项全过） |
| L3.2 | 产物目录规范 | 按任务号归档可反查 | 部分（目录与产物指针已定义，归档规则待实践检验） |
| L4.1 | 四层回链 | 条目↔精读卡↔草稿可双向追溯 | 部分：四层工具链已跑通，绑定从 21 提至 27；审计发现正文引用标注局部化（12 处无标记）；六张精读卡待建 |
| L5.1 | 日志与审计 | 每个动作留痕，失败可定位 | 通过（覆盖拉起、写库、任务单、下发、消费、建映射；只读操作不记） |
| L5.2 | 故障注入 | 出错时系统正确报错 | 通过（13 项：版本冲突 412、非法迁移、幂等拒绝、日志缺失超时、不存在任务单） |

## 回滚

`dsh-core.mjs` 的改动可用同目录备份还原：

```powershell
Copy-Item "DSH-Desktop-Bridge\bin\dsh-core.mjs.bak-20261019" "DSH-Desktop-Bridge\bin\dsh-core.mjs" -Force
```

`limbs/` 整个目录是新增资产，删除即回到改动前状态，不影响任何既有配置。
