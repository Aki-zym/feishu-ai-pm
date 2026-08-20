---
id: ADR-0007
title: M1 单用户试点继续使用 SQLite，并以领域合同约束 draft-only
status: accepted
date: 2026-08-15
owner: 产品负责人 / 架构负责人
scope: M1 单用户试点、Issue #64 领域合同
supersedes: [ADR-0001#正式试点 PostgreSQL 条款]
evidence: [VER-ISSUE60-E2E-20260815, VER-ISSUE64-CONTRACT-L1-20260815]
---

# ADR 0007：M1 单用户试点继续使用 SQLite，并以领域合同约束 draft-only

## 问题

ADR 0001 的 PostgreSQL-before-PoC 条款与当前 M1 本地 SQLite 事实并列存在，容易让实现者误以为必须切库；状态、错误和权威层也缺少单一合同。

## 决定

1. M1/首轮单用户试点继续使用 SQLite；SQLite 是任务、来源和审计的唯一事实真源。
2. `describe`、任务记忆 projection 和 reference activity 都是派生/线索层，不能覆盖原文或改变任务完成状态。
3. M1 只在本机生成待确认 `approval/outbox` 草稿和审计，不自动发送；`ready/sent` 仅为 schema-reserved，不能声称主人确认后当前即可发送。本 ADR 不实现 #58 或真实 provider 连接。
4. PostgreSQL 只作为未来扩展选项，须由负责人另行裁决并提供迁移、恢复和并发证据后才可替换 SQLite。

## 为什么

单用户 M1 的可复核目标是桌面本地可靠性和合同一致性。提前切换 PostgreSQL 会扩大部署与证据范围，不能替代当前需求。

## 限制与重新评估

本 ADR 不承诺多设备、多人租户、生产队列或 L6 provider 结果；当试点规模、恢复需求或负责人批准改变时，新增 ADR 说明迁移计划，不能静默修改本 ADR。
