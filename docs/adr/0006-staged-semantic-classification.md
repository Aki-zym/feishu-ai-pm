---
id: ADR-0006
title: 分阶段小 Schema 承载连续对话语义判断
status: accepted
date: 2026-08-14
owner: LLM/后端负责人
scope: 连续对话分类与关联
supersedes: []
---

# ADR 0006：分阶段小 Schema 承载连续对话语义判断

## 状态

2026-08-14 已决定，PR #24 实施。

## 问题

旧版 `demand_intake_v6` 要求模型一次返回消息动作、需求摘要、任务关联、候选归并、主人意图、日期和任务补丁等完整嵌套对象。DeepSeek 的 `json_object` 能保证返回合法 JSON，但不能保证所有可选字段、类型和枚举都符合项目 Schema；一个次要字段漂移会让整条需求降级。

## 备选方案

1. 继续扩大提示词和失败后整对象修复：改动小，但仍重复同一高复杂度任务。
2. 通过 Codex、Claude Code 或自建 CLI 调用模型：适合离线回放，但没有改变底层结构约束，还会给 EXE 增加安装和进程依赖。
3. 所有网关强制使用严格 Structured Outputs：理想，但当前 DeepSeek 及公司兼容网关能力不一致，不能作为统一前提。
4. 分阶段小 Schema：先判断动作，再按需提取关联、摘要或补丁，由服务端合成。

## 决定

采用方案 4。DeepSeek 继续走兼容性最广的 `chat/completions + json_object`，但每阶段只返回 3—8 个核心字段：

```text
message_action
  ├─ new_demand → demand_details
  ├─ update_existing → thread_association / candidate_merge / task_update
  └─ owner_action / decline_or_delegate → association / owner_intent
```

每个阶段使用固定 Schema、本地 Zod 校验和一次带正确示例的修复。服务端负责匿名 ID 还原、日期换算、默认值、完整评分和业务安全门。当前发言是否为主人也由服务端验证后只传脱敏角色。

动作路由和新需求摘要属于核心阶段；它们失败时来源进入 Runtime 恢复且不生成候选。关联、归并、任务补丁或主人意图属于可独立关闭的阶段；结构失败只返回安全的“未选择/无补丁”，不能拖垮已经成功的核心需求。

## 原因

- 把一次高复杂度生成改成多个边界清楚的小判断。
- 保持对现有 DeepSeek 和公司 OpenAI-compatible 网关的兼容。
- 允许服务端统一承担 ID、日期、版本和状态转换等确定性逻辑。
- CLI 不成为用户安装和网页化的前置条件。

## 代价与限制

- 一条消息通常产生 2—4 次短模型调用，延迟和调用量高于单次大请求。
- 当前仍需本地校验，不能把 `json_object` 当成严格 Schema。
- 次要阶段连续失败时会保留来源但不自动应用该项，需要后续消息或人工复核。
- 真实 DeepSeek 租户仍需用脱敏连续对话验收；Mock 回放不能代替真实凭证验证。

## 重新评估条件

当目标网关稳定支持严格 JSON Schema 或严格 Tool Calling，并且能通过现有五轮回放、阶段失败隔离和隐私门禁时，可以替换单阶段传输方式；阶段合同和服务端合成边界继续保留，不恢复超大单次 Schema。
