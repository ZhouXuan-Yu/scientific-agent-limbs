# 更新日志

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

当前处于 `1.x`：核心接口（任务单 schema、dispatch 的三种 via、botstate 的读取约定）保持向后兼容；破坏性变更会升 `2.0`。

---

## [1.0.0] - 2026-10-20

首个可用版本。当时十二个模块，零第三方依赖；此后陆续增至 16 个模块 + 5 个自测脚本。

### 核心

- **任务单状态机**：六状态，非法迁移拒绝，`done` 必须人工核对后置位
- **下发闭环**：`dispatch.mjs` 支持 `--via room`（群聊，负责人派单）/ `--via bot`（私聊）/ 新建会话三种
- **完成判定**：三条信号（群聊 seq、成员 session turns、产物目录 mtime+size）同时静止且无 session 在跑，持续 90 秒。依据分布式终止检测
- **成员回复回收**：`memberReplies()` 读每个成员在群内的隐藏 session，补上群聊日志看不到的私下工作
- **状态守护**：`daemon.mjs` 清扫超期任务、推进卡死在 dispatched 的任务、留摘要
- **文献四层回链**：`refs.mjs`，R 号主键 + Zotero key 外键 + 精读卡 + 草稿标记
- **统一审计**：`audit.mjs`，按天分片 JSONL，含耗时与失败原因
- **配置外置**：`config.mjs`，全仓零硬编码，环境变量优先

### 桌面集成

- **Zotero**：拉起、探活、本地 API 读写。写操作需运行时授权（Zotero 10+ 本地 API key）
- **DSH**：RPC 凭证链、会话创建与命名、模型选择、取消
- **hana-bridge 插件**：把每轮 `turn/end` 按天分片落盘

### 团队

- 七个角色的技能包（`skills-for-bots/`），通过 `apply-skills.mjs` 写成各 Bot 的 instructions
- 串行门禁：同一时间只允许一个活跃任务，避免群聊消息混在一起

### 验证

| 项 | 结果 |
|---|---|
| 任务单状态机 | 18 项自测全过 |
| 故障注入 | 13 项全过（含 412 版本冲突与对照组） |
| 并发不串 | 三路并行 12 项判据全过 |
| 看护 | 11 项（含幂等） |
| Zotero 读写 | 创建/读回/PATCH/删除全通过 |
| 端到端下发 | 90.9 秒 |
| 完成信号唤醒 | 8.06 秒 |

### 真实任务

- 十篇学位论文（62 万字）→ 12 列对比表，含技术分期与五条争议
- 五条引用核验 → 抓出两条「记录说无 DOI 实际有」
- 单篇精读卡 → 派单、执行、验收、退修、复核五步完整

### 首次发布修复的问题

- 单轮探活误判导致重复拉起 → 改为三轮探活 + 进程守卫
- 产物按相对路径落到 DSH 的 launch-root → 改绝对路径 + 显式 cwd
- 群聊消息误查 `exchanges` 得出「通道不通」的错误结论 → 正确字段是 `rooms[].log`
- 只等第一个 `turn/end` 会提前返回 → 改三信号判据
- 并发调用各自 spawn → 进程内单飞
- 无效 collection key 不报错而返回全库 → `collectionStats()` 先验 key
- `unassigned` 变量作用域导致 dispatch 收尾崩溃 → 已修，并把「语法检查不算验证」写进发布流程

---

## 待办（下一个版本优先看这些）

按影响面排序：

1. **多会话等待的调度** —— 一个 `wait-turn` 只盯一个会话，三任务并行要挂三个
2. **产物归档规则** —— `sync` 要手工触发，理想是结单时自动扫
3. **长周期稳定性** —— `daemon` 连续跑 8 小时的行为没有实测过
4. **文献匹配的鲁棒性** —— 现在靠标题字面，中文简称和「作者+年份」式提及会漏
5. **群聊多任务的归属** —— 串行门禁能避免，但并发是真实需求
6. **Windows 之外** —— 当前实现依赖 PowerShell 与桌面 GUI，跨平台要重写拉起层

---

## 发布流程

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File limbs\release.ps1 -Message "feat: ..."
```

一句做三件事：同步源文件到 `_repo/scientific-agent-limbs`、提交、推到 `origin main`。

规矩：

- 先跑完整流程再发版，语法检查不算验证
- 新增模块必须加进 `build-repo.ps1` 的列表
- `config.json`、`_audit/`、`tasks/T*` 永不入库
- 改接口在 CHANGELOG 里标「破坏性变更」
- 打 tag 时同步更新这一份文件
