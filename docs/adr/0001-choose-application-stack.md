---
id: ADR-0001
title: 首版采用 TypeScript 单仓库、React、Fastify 与本地 SQLite
status: superseded-in-part
date: 2026-08-09
owner: 架构负责人
scope: M0 技术栈与本地事实库
supersedes: []
superseded_by: [ADR-0007]
evidence: [VER-ISSUE64-CONTRACT-L1-20260815]
---

# ADR 0001：首版采用 TypeScript 单仓库、React、Fastify 与本地 SQLite

状态：技术栈决定仍有效；M1 数据库门禁已由 ADR-0007 收窄

日期：2026-08-09

## 决定

首个可运行空壳采用：

```text
TypeScript 单仓库
├─ React + Vite：私人 PM 页面
├─ Fastify：本地 API 与未来飞书回调入口
└─ Node 24 内置 SQLite：本地事实库与自动测试
```

> 旧条款“正式试点仍以 PostgreSQL 作为目标数据库”已被 ADR-0007 收窄：M1 单用户试点继续使用 SQLite；PostgreSQL 仅保留为负责人未来裁决的选项。

## 为什么这样选

1. 飞书官方 Node SDK、网页和后台可以共用 TypeScript，后续多人协作只维护一种主要语言。
2. React 适合实现候选收件、查询视图、右侧详情和排期页面；Fastify 足够承担首期轻量 API。
3. 本地 SQLite 让非工程背景的项目负责人可以先直接运行和体验；首版不需要可靠的跨进程队列。
4. 飞书、LLM、PostgreSQL 和工作区读取都通过接口保留，空壳测试不会产生外部网络副作用。

## 当前明确不采用

- 不 fork Vikunja、Plane 或 OpenProject。
- 不引入微服务、Kafka、Redis、Temporal、LangGraph 或完整 Agent 框架。
- 不用文件变化判断任务完成。
- 不允许任何对外动作绕过人工确认。

## 升级条件（保留）

真实飞书 PoC 开始前，将数据库适配器切换为 PostgreSQL，并实现耐久 inbox/job/outbox；只有当后台任务规模和恢复需求被真实验证后，再选择 pg-boss 或更复杂的编排方案。

该段是未来评估条件，不是当前 M1 的实施门禁。
