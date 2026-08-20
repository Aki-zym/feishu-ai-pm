# 首期应采用飞书原生入口、最小领域真源和 PostgreSQL 可靠队列

记录日期：2026-08-09

状态：工程调研最终技术建议

详细证据与来源见 [research_engineering_solutions_20260809.md](research_engineering_solutions_20260809.md)，飞书 CLI 源码边界见 [feishu_cli_source_audit_20260809.md](feishu_cli_source_audit_20260809.md)，成熟 PM 源码借鉴见 [research_pm_source_patterns_20260809.md](research_pm_source_patterns_20260809.md)，能力评分见 [../data/engineering_capability_matrix_20260809.md](../data/engineering_capability_matrix_20260809.md)。

## 最终建议

不要寻找一个“大而全产品”直接承担个人 AI PM。推荐采用可替换的分层组合：

```text
飞书消息 / 日历 / 会议 / 文档
              ↓
  快速事件收件箱与幂等去重
              ↓
  原始来源 + 最小任务领域真源
              ↓
  AI 判断、describe、纠错事件
        ↓                 ↓
独立私人 PM 网页       飞书任务提醒
        ↓                 ↓
        机器人查询、确认与每日摘要

手工 reference binding ──→ workspace:// reference
按需本地只读桥接 ─────────────────┘

Git Prompt / Rule + Promptfoo 回归门
```

## 未来实施首期推荐采用

| 位置 | 选择 | 原因 |
|---|---|---|
| 飞书试点 | 同一专用租户的企业自建应用 | 最短审核链和最低多租户复杂度 |
| 机器人入口 | Channel SDK 或稳定 OpenAPI SDK | 消息、卡片和事件入口成熟，身份边界清楚 |
| 系统主人私聊捕捉 | 用户 OAuth + 周期消息查询 + 重叠窗口去重 | CLI 应用事件不能实时订阅用户全部人际私聊，只能实现可补漏的近实时扫描 |
| 系统真源 | 自有最小领域表 | 能表达来源、候选、角色、承诺、纠错和可见性 |
| 可靠处理 | PostgreSQL inbox/job/outbox | 一套数据库即可支持幂等、重试、死信、审批等待和对账 |
| PM 管理界面 | 独立私人网页 | 能表达候选收件、工作台、任务详情、来源时间线和归档，不受表格式界面限制 |
| 可选投影 | 多维表格只读投影 | 只在真实协作需要出现时采用，不承担编辑真源 |
| 执行提醒 | 飞书任务镜像 | 只同步真正需要执行与提醒的事项 |
| 工作记忆 | 原始事件 + 版本化 `describe` + 结构化/全文检索 | 可审计，且不会让摘要取代事实 |
| 纠错回归 | Git + Promptfoo CLI | 成本低、可审查、可固定版本，不需要常驻平台 |
| 工作区联动 | 手工 binding + 逻辑 `workspace://` reference | 只读取文件位置和活动线索，不控制 Agent、不执行任务、不修改真实工作文件 |

最小领域对象建议固定为：

```text
source_event
candidate_request
task
task_source_link
task_event
correction_event
notification / reminder
saved_view / reference_binding
job / outbox / approval
```

## 条件成熟后再采用

| 方案 | 采用条件 |
|---|---|
| 本地只读桥接器 | 手工 reference 和 Agent 主动回传无法满足按需回查 |
| Mem0 | 结构化和全文检索被真实使用证明召回不足 |
| Langfuse | 线上 Trace、评测和调试规模值得承担平台或托管费用 |
| LangGraph | AI 判断形成复杂多步图，需要暂停、修改、重放和工具审批 |
| Temporal | 长等待、跨服务补偿、复杂重试和运行中升级使自制 job 状态机失控 |
| Graphiti | 跨项目关系与事实有效时间成为高频核心需求 |
| Git 快照 | 工作文件本身适合提交并需要长期复现 |

## 当前不采用

- OpenProject：成熟但远超个人 AI PM 的流程和运维需求。
- Plane、Vikunja、OpenProject 或 Super Productivity 作为产品底座：源码审计表明它们只覆盖局部模式，缺少飞书来源、候选确认、提出人、承诺和纠错链；Plane/Vikunja/OpenProject 还需额外评估 AGPL/GPL 义务。
- n8n 作为核心编排：适合外围自动化，不适合承担任务真源和业务幂等。
- OpenAPI MCP Beta 作为唯一飞书底座：能力和兼容边界仍在变化。
- 多维表格与独立 PM 网页同时可编辑：会产生双真源冲突。
- Mem0、Letta 或 Graphiti 作为聊天真源：派生记忆不能替代原文。
- 根据文件变化自动完成任务：文件只证明有活动或候选产物。
- 将个人 Agent CLI 的用户 token 暴露给多人机器人。
- 将 CLI Event Bus 当作可靠收件箱，或直接部署官方 multi-tenant Sidecar demo。
- 仅凭 `--page-all` 成功退出判断消息已经全量读取。
- 将本地绝对路径直接发送到飞书或交给模型长期保存。

## 三阶段路线

### 1. 最小可行性验证

只验证飞书权限、事件补漏、原文留存合同、领域对象、独立 PM 页面信息架构、Promptfoo 回归和手工 reference，不制作完整产品。

### 2. 朋友试点

所有试用者加入同一专用租户；增加用户隔离、删除导出、备份恢复和本地只读桥接器。只有真实痛点出现后才加入 Mem0、Langfuse 或更复杂的团队管理能力。

### 3. 跨租户产品

改为商店应用，补齐 ISV、租户 token、管理员安装、计费和服务义务；复杂编排再引入 Temporal，多步 AI 流程再引入 LangGraph。

## 实施前必须回答

1. 历史私聊和全部群消息权限是否能在真实企业中获批？
2. 完整原文保存多久，用户退出或撤销授权后怎样删除？
3. 2026-08 的真实 API 月额度和限流是多少？
4. 朋友是否接受加入同一个专用飞书租户？
5. 本地桥接器如何在 Windows/macOS 安全授权、更新和撤销？
6. “机器人消息即时发现、系统主人自然私聊近实时发现”的体验差异是否可接受？

这些问题需要未来实施项目通过真实权限和运行验证回答。本设计项目不执行这些验证。

## 一句话裁决

> 首期用飞书承担收件与提醒，用 PostgreSQL 保管事实和可靠状态，用独立私人网页承担 PM 管理；源码只借成熟模式，不 fork 现成 PM，也不让系统自动执行任务。
