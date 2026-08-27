---
id: ADR-0009-aily-derived-intake-contracts
title: Aily 派生摘要驱动的任务入库合同
status: accepted
date: 2026-08-27
owner: 产品负责人 / 插件与后端负责人
scope: TooManyTasks 服务端 Aily SDK 扫描链
supersedes: []
evidence: [VER-AILY-SDK-ISOLATED-20260827]
---

# ADR 0009：Aily 派生摘要驱动的任务入库合同

## 背景

TooManyTasks 需要由独立服务端中的官方 Aily SDK 按时间窗口总结飞书信息，再由 Cindy 结合本地任务快照判断任务变化。Aily 的返回是跨来源、经过模型整理的派生文本，不能按逐条飞书原文处理；扫描失败和重试也必须保持窗口边界与入库幂等。

## 决定

1. 扫描链固定为 `TooManyTasks 20 分钟调度或 Cindy 手动触发 → 服务端 Aily SDK → SQLite aily_summary_inbox → Cindy 5 分钟轮询 → 固定 intake errand → get_pm_tasks → submit_intake → SQLite`。Aily Prompt 只接收窗口、时区和检索要求；Cindy 不读取飞书、不调用飞书工具，也不调用扫描工具。
2. `source_kind=aily_summary` 是受控来源类型。它保存 Aily 返回文本、窗口起止时间、Agent 标识和生成时间，并设置 `derivedEvidence=true`、`completeness=limited`。数据库现有 `source_type=manual` 仅作为兼容枚举值，调用方必须优先识别 `source_kind`。
3. Cindy 可根据 Aily 摘要和本地任务快照提出 `create_candidate`、`update_task`、`skip` 或 `needs_owner`。`update_task` 保留 A 方案，必须携带任务 `task_key` 与快照中的 `expected_version`，并由服务端在同一事务内执行 CAS、来源关系和需求单元校验。
4. 每个窗口最多生成一条 Aily inbox 记录和一条后续派生来源，来源键为 `aily-summary:<window_id>`。`window_id` 唯一；相同窗口正文 hash、Agent、窗口或结果类型变化时返回冲突。
5. schema v9 的 `aily_summary_inbox` 固定 `ready / claimed / retry_waiting / completed / failed` 五态。领取租约为 10 分钟，失败按 1、2、5、10、20 分钟退避，最多五次。claim token 原值只存在于插件内存，SQLite 仅保存 SHA-256。
6. Aily 摘要写入 inbox 与独立扫描游标推进在同一事务；Aily 失败、权限失效或超时不推进。空窗口直接写入 completed 审计记录。Cindy 的来源/候选/任务写入与 inbox completed 在另一事务；Cindy 失败不回滚摘要，也不阻塞后续扫描窗口。
7. `submit_intake` 验证 inbox id、窗口、摘要 hash、Agent、生成时间、领取租约和 claim token。服务端回执已经确认事务完成时，Cindy 最终文本缺少或损坏 JSON 不能把已完成窗口重新判成失败。
8. Aily SSE 解析采用有限事件数、字节数、单事件缓存和摘要长度；收到 `done` 后停止消费并关闭流。只有 `Completed` 终态、合法 `start` 和合法 `done` 才算成功。

## 原因

该合同保留 Aily 的检索能力，同时把模型摘要放回 SQLite 来源、CAS 和事务边界内。它允许私人任务台及时反映已由 Cindy 判断明确的任务变化，也避免将摘要伪装成原文或因网络重试产生重复来源、候选和任务事件。

## 限制

- 当前 Cindy 宿主的 `agent.errand` 公共请求没有提供插件级工具白名单字段，因此 TooManyTasks 只能通过 errand 提示、插件工具合同和服务端认证约束限制可用路径，不能在本仓库内证明宿主不会向 errand 暴露其它工具。
- Aily 的摘要完整性取决于 Agent 的已发布技能和用户授权范围；`limited` 只说明它是派生摘要，不代表覆盖了窗口内全部飞书信息。
- `source_type=manual` 仍存在于 SQLite 兼容枚举中；新增代码不能据此把 Aily 来源当作人工逐条补录。
- 真实 TooManyTasks OAuth、真实租户覆盖范围、Cindy 宿主 errand 和生产发布包验收不由本地契约测试代替。

## 重新评估条件

- Cindy 宿主公开稳定的 errand 工具白名单或等价的宿主级会话隔离合同。
- 需要逐条飞书原文、云文档正文或可验证引用时，Aily 摘要不再满足来源合同。
- TooManyTasks 进入多人、多设备或远程服务形态，需要重新评估 SQLite 窗口持久化与本地 secret binding。
- Aily OpenAPI、SSE 终态或用户授权合同发生变化。
