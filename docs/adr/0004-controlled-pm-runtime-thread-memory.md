---
id: ADR-0004
title: 受控 PM Runtime、需求线程与任务记忆投影
status: accepted
date: 2026-08-12
owner: 后端负责人
scope: Runtime、线程和投影
evidence: []
supersedes: []
superseded_by: [ADR-0005]
---

# 0004：受控 PM Runtime、需求线程与任务记忆投影

> 2026-08-12 状态：本 ADR 的 Runtime、耐久来源、版本检查、Tool Registry 和任务记忆决定继续有效；“所有任务更新提案均需主人事前批准”已由 [ADR 0005](0005-ai-auto-task-maintenance.md) 部分取代。

## 问题

消息、日历、妙记和人工补录会持续产生来源。仅靠一次进程内调用，无法保证模型失败、网络中断、进程重启或需求方继续补充时仍然不丢来源、不重复建单，也无法解释任务为什么发生变化。

## 备选方案

1. 直接引入 Temporal、BullMQ、Inngest 或完整 Agent Runtime。
2. 继续把状态放在进程内队列和前端页面。
3. 在现有 SQLite 领域真账本之上自建一层薄 Runtime，并把线程、提案和文件夹作为明确的领域投影。

## 最终决定

当前 Windows 单机阶段选择方案 3：

- `job` 记录执行状态、幂等键、lease、attempt、指数退避、checkpoint、取消和失败恢复；执行 ID 不代替 `task_id` / `thread_id`。
- 来源先写入 `source_event`，再创建 Runtime 工作项。机器人 WebSocket 回调必须等待来源事务提交并取得 durable receipt 后才确认；commit 前失败允许平台重投，重复/并发投递按 `external_id` 幂等。进程在来源提交后、Runtime 工作项创建前退出时，启动恢复只处理显式 bot-supplement/primary orphan rows。周期扫描遵守 `available_at`，显式人工重试才唤醒退避中的失败项。
- `requirement_thread` 保存回复链、会话、参与人和历史修订。多个可能线程进入 `needs_confirmation`，不由模型 hint 直接合并。
- LLM 只生成 `candidate_revision` 与 `task_update_proposal`。提案保存基准任务版本、JSON patch、证据和模型元数据；ADR 0005 允许通过严格安全门的私人内部更新自动应用，其余仍由主人确认。
- 任务记忆目录是 SQLite 的可重建投影，使用原子写入生成 `task.json`、`brief.md`、`sources.md`、`updates/` 和 `artifacts.json`。实际工作目录继续只读。
- Tool Registry 将工具分为只读、需审批和禁止；任意 Shell、业务 SQL、真实工作目录写入和自动外发在当前阶段禁止。

## 原因

这套边界满足本地 EXE 的耐久性和可审计要求，不引入新的服务端部署、队列基础设施或多租户复杂度；同时为以后接入 LangGraph.js、Mastra 或 OpenAI Agents SDK 保留替换编排层的接口。

## 限制与重新评估条件

- 当前 Runtime 仍由本地服务同步驱动，尚未提供跨设备协作和长期分布式 Worker。
- 当前只为 `classify_source` 和 `reprocess_candidate` 提供显式手动重试处理器；新增 job 类型必须先定义安全、幂等的恢复处理器，不能只把失败状态改回排队。
- 任务记忆当前是逐文件临时写入与原子替换，不是整个目录的一次事务切换；SQLite 仍是真源，任何中断都可通过重新投影修复。
- 当出现跨服务长等待、复杂补偿、并发 Worker 或多设备同步时，再评估 Temporal 等持久工作流引擎。
