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

1. 扫描链固定为 `Cindy 定时器或手动扫描 → TooManyTasks 本机 API → 服务端 Aily SDK → 固定 intake errand → get_pm_tasks → submit_intake → SQLite`。Aily Prompt 只接收窗口、时区和检索要求；Cindy 不读取飞书、不调用飞书工具，也不调用扫描工具。
2. `source_kind=aily_summary` 是受控来源类型。它保存 Aily 返回文本、窗口起止时间、Agent 标识和生成时间，并设置 `derivedEvidence=true`、`completeness=limited`。数据库现有 `source_type=manual` 仅作为兼容枚举值，调用方必须优先识别 `source_kind`。
3. Cindy 可根据 Aily 摘要和本地任务快照提出 `create_candidate`、`update_task`、`skip` 或 `needs_owner`。`update_task` 保留 A 方案，必须携带任务 `task_key` 与快照中的 `expected_version`，并由服务端在同一事务内执行 CAS、来源关系和需求单元校验。
4. 每个窗口最多生成一条 Aily 派生来源，键为 `aily-summary:<window_id>`。窗口由本地服务持久化；失败重试复用同一窗口边界和窗口键。相同窗口再次提交时，输入指纹一致才返回幂等结果，指纹变化返回冲突。
5. 空窗口使用显式 `result_kind=empty_window` 合同，`sources` 与 `proposals` 必须为空；服务端记录窗口完成并推进游标。普通入库使用 `result_kind=intake`，必须有至少一条来源。
6. 游标只在服务端成功完成入库事务或显式空窗口事务后推进。Aily 失败、权限失效、超时、errand 失败、服务端冲突或未取得服务端成功回执时，扫描结果保持失败且不由插件主动推进游标。服务端回执已经确认事务完成时，Cindy 最终文本缺少或损坏 JSON 不能把已完成窗口重新判成失败。
7. Aily SSE 解析采用有限事件数、字节数、单事件缓存和摘要长度；收到 `done` 后停止消费并关闭流。只有 `Completed` 终态、合法 `start` 和合法 `done` 才算成功。

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
