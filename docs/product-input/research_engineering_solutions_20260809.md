# 飞书个人 AI PM 成熟工程方案调研

状态：已完成

研究起始：2026-08-09

## 1. 研究目标

为已经收口的产品行为原型寻找成熟工程积木，覆盖：

1. 飞书消息、群聊、日历、会议、文档和文件接入；
2. 候选需求、正式任务、排期和状态台账；
3. 完整原始来源、`describe` 和长期工作记忆；
4. Agent 工作区 `reference path` 与文件变化信号；
5. 纠错、提示词版本、回归评测和审计；
6. 多用户隔离、权限、可靠性和后续运维。

本调研只形成能力比较与技术建议，不创建软件、不安装组件、不调用真实 API。

### 结论类型

- **官方事实**：API、事件、权限、许可、部署依赖和协议能力，均以官方文档、官方 GitHub 或标准规范为依据。
- **工程建议**：本文对系统分层、组件采用顺序和真源边界的综合裁决。
- **待验证假设**：真实企业权限获批、实际 API 月额度、原文留存合同、同租户试点接受度和本地桥接器安全性，必须在未来实施项目验证。

## 2. 完成标准

本轮研究完成时，应能够回答：

- 哪些产品目标已有官方能力直接支持；
- 哪些目标需要自有领域层，不能交给飞书或第三方任务系统；
- 每一层有哪些成熟候选、推荐采用什么、暂缓什么；
- 推荐方案的权限、可靠性、许可、部署和锁定风险；
- 后续实施项目可以按什么顺序做最小验证。

## 3. 评估原则

| 维度 | 判断问题 |
|---|---|
| 产品匹配 | 是否直接服务“私人记忆、候选任务、对外门禁、人工确认” |
| 官方能力 | 是否有稳定 API、事件、Webhook、SDK 或导出能力 |
| 数据控制 | 能否自托管；聊天原文、个人规则和访问令牌存在哪里 |
| 可追溯 | 是否保留来源、历史版本、纠错和审计记录 |
| 可靠性 | 是否支持幂等、重试、对账、失败恢复和版本回退 |
| Agent 兼容 | 是否可以通过文件合同、Hook、MCP、SDK 或 API 接入 |
| 运维成本 | 部署、升级、监控和数据迁移是否超出当前阶段价值 |
| 许可与锁定 | 开源许可、商业功能边界和供应商依赖是否可接受 |

## 4. 首要架构判断

当前不建议把任一第三方产品直接定义为“整个 AI PM 的唯一真源”。需要拆成六层：

```text
飞书消息、日历、会议、文档事件
                ↓
       原始事件与来源记录层
                ↓
   任务领域层：候选、角色、承诺、状态
        ↓                    ↓
飞书/Plane 等执行界面     describe / 检索记忆
        ↓                    ↓
         机器人提醒、查询与人工确认
                ↓
     Trace、纠错、评测与版本升级
```

各层职责：

- **原始来源层**：保存消息、会议、日历、文件等稳定来源键和允许保留的原文，是不可被 AI 摘要覆盖的事实依据。
- **任务领域层**：保存候选、正式任务、提出人、负责人、范围、承诺、状态、可见性和纠错事件。
- **执行界面**：飞书多维表格、飞书任务或 Plane 等，只展示和操作必要的任务投影。
- **派生记忆层**：维护 `describe`、召回索引和用户偏好，不裁定事实。
- **工作区桥接层**：只保存并读取用户授权的 `reference path`，不复制或修改真实工作文件。
- **评测审计层**：记录模型、提示词、规则、来源、判断、人工纠正和版本升级结果。

## 5. 飞书官方能力核验

### 5.1 已有成熟积木

| 目标 | 官方能力 | 当前判断 |
|---|---|---|
| 机器人私聊与应用可见群聊 | 消息事件、群消息敏感权限、官方 SDK 长连接 | 事件入口成熟，但收到后必须立即耐久落盘并按消息业务键去重 |
| 系统主人的人际私聊 | 用户身份列出 P2P 会话、搜索消息和读取历史 | 只能按周期查询实现近实时捕捉；当前没有覆盖全部人际私聊的实时事件流 |
| 历史消息回查 | 用户身份读取单聊和群聊历史 | 定向回查可行；不能直接假设拥有无缺口的连续归档流 |
| 群与成员身份 | 群管理、成员 ID、创建和邀请 | 按需拉群可行；身份和应用所在群范围受限 |
| 日历与排期 | 日历、日程、忙闲查询、增量同步 | 能支撑内部时间建议和正式日程镜像 |
| 会议与妙记 | 会议信息、参会人、纪要、逐字稿和 AI 产物接口 | 会后捕捉可行，但高级权限和资源阅读权是关键门槛 |
| 文档与文件 | 文件元数据、搜索、Docx 内容和链接 | 适合保存引用并按需总结，不适合假设全盘实时索引 |
| 飞书任务 | 任务、子任务、负责人、提醒、评论、字段和附件 | 适合用户执行面，不适合单独承载完整后台领域模型 |
| 多维表格 | 自定义字段、批量记录、视图和记录事件 | 适合低成本结构化执行面或早期台账投影 |

### 5.2 可靠性要求

- 对上游事件按“可能重复”处理，第一跳写入耐久 inbox，再用稳定业务键幂等去重；消息优先使用 `message_id`。
- 不能只依赖事件推送。机器人对话可事件触发；系统主人的人际私聊只能周期查询；聊天、日历、文档和会议都需要查询接口定期对账。
- 用户 OAuth 刷新凭证需要安全滚动保存；实际有效权限以 token 返回范围为准。
- 敏感聊天、妙记导出和高级权限需要管理员审核，必须先做最小权限验证，不能根据文档直接假设获批。

### 5.3 飞书执行面选择

| 选择 | 优势 | 局限 | 当前定位 |
|---|---|---|---|
| 多维表格 | 飞书原生、字段和视图灵活、接入成本低 | 权限与事件细节复杂；不适合完整原文、决策历史和 Agent Trace | 第一阶段任务投影首选 |
| 飞书任务 | 提醒和个人执行体验自然 | 列表和应用身份范围有限，领域字段不足 | 只镜像真正需要执行和提醒的事项 |
| 自建任务界面 | 能完整表达私人记忆和可见性门禁 | 研发和运维成本最高 | 产品成熟后再评估 |

### 5.4 应用与租户模式

| 使用方式 | 适合的飞书应用 | 工程含义 |
|---|---|---|
| 朋友加入同一个专用飞书团队 | 企业自建应用 | 最快试点方式；审核链短，所有用户处于同一租户 |
| 朋友保留各自企业身份 | 商店应用 | 需要 ISV、平台审核、企业管理员安装和完整多租户隔离 |
| 每个朋友自行创建一套应用 | 多套自建应用 | 可以复用后端逻辑，但凭证、权限和数据必须逐租户隔离 |
| 测试企业 | 仅用于封闭测试 | 不能替代正式跨租户分发 |

当前建议：**朋友试点优先要求加入同一个专用租户，采用企业自建应用。** 跨租户商店化作为独立阶段评估，不能把自建应用方案直接外推。

跨租户必须至少按 `tenant_key + open_id` 隔离身份、token、任务、原文、Prompt 规则和工作区授权。

### 5.5 Agent CLI、Channel SDK 与 MCP

| 官方积木 | 最适合承担 | 不适合承担 |
|---|---|---|
| Agent CLI | 单用户私人 Agent 的飞书工具层、OAuth、结构化查询和个人工作区操作 | 多人群机器人后端、可靠事件入口、完整台账和长期事件存储 |
| Channel SDK | 机器人入口、事件解析、流式回复、卡片和媒体交互 | 任务真源、历史补漏和长期记忆 |
| OpenAPI SDK | 底层稳定 API 调用、分页、错误和认证 | 独立提供完整 Agent 产品行为 |
| OpenAPI MCP（Beta） | 实验性 Agent 工具连接 | 当前不应作为唯一工程底座 |

Agent CLI 以用户身份执行，适合私人助手场景。多人机器人不能直接复用个人用户 token；机器人入口身份和个人 Agent 执行身份必须分离。

2026-08-09 对官方仓库 commit `7be2476` 的源码审计进一步确认：

- CLI 的 WebSocket Source 使用 AppID/AppSecret 接应用事件，不是用户全部私聊的实时订阅器。
- Event Bus、去重和两层缓冲均为内存对象；背压时明确丢弃最旧事件，没有事件级 ACK、offset 或 replay。
- Source Handler 在把事件推入内存链后即返回成功；据事件回调语义推断，后续 Bus 或业务处理失败不会再触发飞书平台重投。
- 通用 HTTP RetryTransport 默认不自动重试；分页在后续页失败时可能停止并仍返回部分结果。
- 用户 token 自动刷新、并发锁和系统密钥保存较成熟，适合单机单用户；普通 profile 不是多人账户池。
- Sidecar wire protocol 可复用，但官方 multi-tenant server 明确只是 demo。

完整证据见 [feishu_cli_source_audit_20260809.md](feishu_cli_source_audit_20260809.md)。因此 CLI 只能作为可替换的个人查询/操作适配器，不能成为可靠 PM 后端。

### 5.6 实施前 P0 验证

1. 确定第一阶段是否接受“所有试用者加入同一专用租户”；不接受则按商店应用重新评估。
2. 用普通管理员和普通用户实测历史单聊、全部群消息、日历、文档和妙记高级权限能否获批。
3. 实测断网、进程重启、重复事件、token 失效、后续页部分失败和超过飞书自动重试窗口后的 API 对账补漏。
4. 明确原文保存范围、期限、访问者、退出删除和 OAuth 撤销后的处理合同。
5. 在飞书管理后台核验 2026-08 的真实月 API 额度；公开页面存在阶段性额度说明，不能直接用于预算。
6. 明确 CLI 私人身份、机器人身份和后台应用身份之间的 token 隔离。
7. 验证用户私聊周期扫描的延迟与调用量，并确认产品接受“机器人即时、自然私聊近实时”的差异。

### 5.7 成本信号

- 官方 CLI 和 SDK 自身采用宽松开源许可，不构成主要软件授权成本。
- 飞书公开资料主要提供套餐调用额度和限流信息，没有足够稳定的统一按次价格表；实际额度需在管理后台确认。
- 跨租户商店应用可能涉及 ISV 认证、平台审核、企业安装、服务商义务和后台可见费用，必须作为独立商业化成本评估。
- 主要运行成本将来自 LLM、数据库、日志/评测、服务器和可能的本地桥接器维护。

## 6. 任务系统候选

### 6.1 Plane

- 开源、自托管，提供 REST API、Webhook、OAuth、MCP 和 Agent 集成。
- Work Item、评论、页面和外链适合承接 AI 生成的任务投影。
- Community 使用 AGPLv3；通过网络提供修改后的服务时需要审查源码提供义务。完整自托管还包含 Web、Admin、API、Worker、定时任务、WebSocket、PostgreSQL、Redis/Valkey、RabbitMQ 和对象存储等组件。
- 迭代较快，Community 与 Commercial 发布周期、功能边界和 API 迁移需要固定版本并做契约测试。

判断：**可选的成熟工单界面，不作为当前任务真源。** 只有飞书多维表格明显限制个人 PM 体验，并且有人能承担持续运维、备份、升级和 AGPL 合规时，再进入 Plane 工程验证。

### 6.2 OpenProject

- 成熟自托管项目管理系统，API、带签名 Webhook、Docker 和 Kubernetes 路径完整。
- 流程和权限严谨，但对个人 AI PM 偏重。

判断：**当前不采用。** 借鉴其部署、升级和 Webhook 安全模式；只有产品未来演变为正式多人重流程平台时再重新评估。

### 6.3 当前任务层建议

第一阶段建议：

> 自有最小任务领域层作为真源，多维表格作为飞书内任务投影，飞书任务只同步需要提醒的执行事项。

Plane 作为第二候选，在以下条件出现时验证：

- 多维表格无法提供足够清晰的个人 PM 体验；
- 需要成熟评论、附件、历史、权限和独立 Web 界面；
- 团队愿意承担自托管与 AGPL 合规成本。

最小领域真源只需要先覆盖：

```text
source_event
task
task_source_link
decision_event
correction_event
projection_cursor
```

内部 `task_id` 不能使用飞书 `record_id` 或 Plane Work Item ID，确保任务界面可以替换。

## 7. 工作记忆候选

### 7.1 原始事件库 + PostgreSQL 检索

原始消息、会议、日历、文档和纠错事件必须先进入稳定来源层。第一阶段可以使用关系字段、全文检索和可选向量索引完成“按任务、人物、时间和关键词”召回。

判断：这是最低复杂度、最容易审计的基础方案。任何专用记忆框架只能建立在它之上。

### 7.2 Mem0

- 提供独立长期记忆服务、REST/SDK、自托管、历史和审计能力。
- 适合提取用户偏好、长期事实和跨任务召回。
- 记忆经过 LLM 提取、去重和压缩，不能替代原始聊天或任务真源。

判断：**可选。** 自托管还需要 LLM、Embedding、PostgreSQL/pgvector、认证和审计；OSS 与托管版在时间推理、衰减、Webhook、导出和高可用能力上存在差异。先验证普通结构化检索是否已经满足需求，再决定是否引入。

### 7.3 Letta

- Memory Block、归档记忆和外部 RAG 的分层值得借鉴。
- 同时接管 Agent 状态、工具、提示词和对话循环，当前产品并不需要完整 Agent 运行时。

判断：借鉴记忆分层，不直接作为 AI PM 底座。

### 7.4 Graphiti

- Episode、来源、事实有效时间和失效时间适合处理“旧判断被新信息纠正”。
- 图数据库、实体消歧和 LLM 抽取会显著增加复杂度。

判断：先借鉴来源与 supersede 模式；跨项目关系和时间冲突成为核心问题后再验证。

### 7.5 LangGraph

- Checkpoint、暂停审批、历史、重放和分叉适合复杂多步 Agent 流程。
- 它不是任务系统，也不是完整长期记忆产品。

判断：只有出现复杂审批、长流程暂停恢复和纠错重放时再引入；简单消息识别与台账更新不应先上 LangGraph。

## 8. 提示词、纠错和评测

### Langfuse

- 支持自托管 Trace、不可变 Prompt 版本、标签、Diff、回滚、Dataset、实验、人工标注和 LLM Judge。
- 可以将一次任务判断绑定到具体 Prompt 版本、模型、来源和人工反馈。

判断：**可选，不在第一阶段自托管。** Langfuse 的核心能力成熟，但自托管需要 Web、Worker、PostgreSQL、ClickHouse、Redis 和对象存储；部分 RBAC、数据保留、审计和服务端脱敏属于商业功能。规则正文和发布审批先留在 Git，出现大量线上 Trace 和评测需求后再选择 Cloud 或托管实例。

### Promptfoo

- 适合把“任务关联错误、角色识别错误、范围变化漏检”等案例固化成可在 CI 中重复运行的回归测试。

判断：**未来实施第一阶段推荐采用 CLI 模式。** Prompt、规则和纠错案例放在 Git，在本地或 CI 中固定版本运行；不把社区自托管 Server 当生产多人服务。只运行可信仓库内容，并使用受限模型凭证。

### 最小决策审计字段

```text
decision_id
source_event_ids
task_id
describe_version
prompt_name + prompt_version
policy_version
model
trace_id
output
human_verdict
supersedes_decision_id
created_at
```

## 9. Agent 工作区桥接

### 9.1 三类连接方式

| 方式 | 优势 | 局限 | 推荐定位 |
|---|---|---|---|
| Agent 主动回传 | 隐私边界清楚；能直接表达开始、需要输入、校验和完成等语义 | Agent 离线后无法让 PM 随时回查；不同工具事件不同 | 日常进度默认来源 |
| 本地只读桥接器 | 可以按需读取未提交文件和实际目录状态；适配面最广 | 需要本地客户端、目录授权、安全更新和多平台维护 | 信息不足时的按需深读 |
| Git 或云端同步 | 版本可复现、审计清楚、协作成熟 | 只覆盖已同步内容；不适合私密或临时文件 | 可选的长期工程证据 |

当前推荐组合：

> Agent 主动回传 `describe` 与显式状态；信息不足时通过本地桥接器按需只读；适合共享的项目再用 Git 保存持久快照。

### 9.2 不同 Agent 的适配判断

| Agent / 协议 | 工作区特征 | 适配判断 |
|---|---|---|
| Claude Code | 本地项目文件、Hooks、MCP 和 Skills 较完整 | Hook 转统一事件，MCP 提供按需查询；Skills 只保存行为规则 |
| ChatDev 2.x | 本地共享 workspace、附件、SDK 和产物接口 | 较接近现成工作区运行时，但仍需补用户、任务和目录隔离 |
| Coze | 云端工作流、异步执行和 `file_id` | 不能直接读取本地路径，需要上传/下载和运行状态 adapter |
| MCP | 跨工具的 Tools、Resources 和长任务扩展 | 适合作为能力协议，不提供真实文件权限，也不承担 PM 长期状态 |
| Git | 工作树、暂存区、commit 和分支 | 适合持久证据，不能单独表达需求、阻塞或业务完成 |

### 9.3 统一 reference 合同

飞书后端不保存 `C:\\Users\\...` 等真实绝对路径，只保存稳定逻辑引用：

```text
workspace URI + relative path + revision + kind + mime type
```

示意：

```text
workspace://ws_123/docs/report.md
revision: sha256:...
kind: file
```

真实本地路径、Coze `file_id`、ChatDev artifact ID、Git commit 或 MCP resource URI 保存在工具私有 binding 中，不直接暴露给模型或飞书消息。

权限单独保存：

```text
workspace_id
path_prefix
operations: read
expires_at
```

本地桥接器需要解析真实路径后再次校验其仍位于授权根目录，拒绝 `..`、符号链接逃逸和未授权网络路径。默认只读，写入或执行必须是另一份短期授权。

### 9.4 文件与进度的边界

文件变化可以可靠记录：新增、修改、删除、Git 状态、产物位置和明确校验结果。它只能弱推断“最近有活动”或“可能出现阶段产物”，不能单独判断任务完成、质量正确、用户验收、阻塞原因、优先级或交付日期。

因此统一事件只更新证据和活动：

```text
run.started
artifact.changed
checkpoint.reached
validation.passed / validation.failed
needs_input
run.completed / run.failed
```

正式任务状态仍由显式 Agent 事件、检查结果和人工确认共同决定。MCP 普通进度通知只服务单次请求，不能直接承担 PM 的长期状态；长期运行需要自己的持久 `run_id` 或成熟任务扩展。

## 10. 流程编排与可靠性

### 10.1 候选比较

| 方案 | 耐久性与恢复 | 人工确认 | 运维与许可 | 当前定位 |
|---|---|---|---|---|
| PostgreSQL inbox/job/outbox | 单库事务、租约、重试、死信和对账可满足第一阶段；细节需自行约定 | `awaiting_approval` 状态与飞书按钮回调简单直接 | 最低；PostgreSQL License | 第一阶段首选 |
| Temporal | 事件历史、持久 Timer、Activity 重试、Schedule、Signal/Update 和运行版本控制最完整 | 适合等待数天后的确认与恢复 | 自建需 Server、数据库、Worker 和监控；Server MIT | 跨服务长流程复杂后引入 |
| LangGraph OSS | Checkpoint、Interrupt、历史和分叉适合多步 AI 流程 | AI 审批体验好，但副作用需独立幂等 | 库本身轻；完整运行仍需 Worker、Scheduler 和监控；MIT | 只放在 AI 判断步骤 |
| n8n | Wait 和 queue mode 可保存执行，但核心业务 exactly-once 仍需自行保证 | 表单、Wait 和运营交互方便 | queue mode 需要 PostgreSQL、Redis、Worker；Sustainable Use License | 外围集成，不做任务真源 |

### 10.2 第一阶段可靠性合同

1. 飞书事件入口只做验签、稳定业务键写入 inbox 和快速确认，LLM 判断全部异步执行。
2. `event_id`、`message_id`、`effect_key` 等关键字段建立唯一约束；外部 API 副作用仍需幂等键。
3. job 保存 `attempts`、`next_run_at`、租约、指数退避和死信状态。
4. outbox 解决“领域状态已写入但消息或投影未发送”的双写问题；消费者仍需幂等。
5. 每日提醒、事件补漏和多维表格对账都生成数据库 job，不依赖进程内定时器。
6. 人工确认保存 `approval_id`、状态、过期时间和按钮回调；等待数天后可以恢复。
7. 每次判断开始时固定 `prompt_revision_id`、Prompt 哈希、模型和规则版本，不能只引用“当前提示词”。

### 10.3 升级条件

- 出现多步 LLM 推理、工具调用、审批和纠错重放时，在单个 job 内加入 LangGraph。
- 出现大量跨服务补偿、长时间等待、复杂重试、运行中升级或自制状态机频繁出错时，用 Temporal 替换 job 编排层。
- n8n 只承接低风险 SaaS 串接、运营维护和临时通知，核心状态必须写回领域真源。
- Temporal、LangGraph 和 n8n 的执行历史都不是聊天、任务或工作记忆真源。

## 11. 当前推荐组合

| 层 | 当前首选 | 备选或后续 |
|---|---|---|
| 飞书接入 | 同一专用租户的企业自建应用 + Channel SDK / OpenAPI SDK | Agent CLI 仅作私人 Agent 工具层；OpenAPI MCP Beta 继续观察 |
| 原始来源与领域真源 | 自有最小事件与任务模型 | 不交给多维表格、Plane 或记忆框架独占 |
| 飞书内执行面 | 多维表格任务投影 + 飞书任务提醒镜像 | Plane 独立 PM 界面 |
| 日常记忆 | 版本化 `describe` + 结构化/全文检索 | 证明召回不足后再加 Mem0 |
| 复杂关系记忆 | 暂不引入 | Graphiti |
| Agent 工作流 | 简单事件处理与人工门禁 | LangGraph / Temporal 条件成熟后引入 |
| 评测审计 | Git 规则版本 + Promptfoo CLI 回归 | Trace 规模变大后再加 Langfuse |
| 工作区文件 | Agent 主动回传 + 手工 reference binding + 逻辑 `workspace://` 引用 | 信息不足后再加本地只读桥接器；适合共享时使用 Git 持久快照 |

### 最低成本组合

```text
任务和判断真源：自有最小领域表
用户界面：飞书消息 + 多维表格
执行提醒：飞书任务镜像
完整聊天：原始事件存储
提示词和规则：Git
回归评测：Promptfoo CLI
派生长期记忆：暂不部署
线上 Trace 平台：暂不自托管
```

该组合避免在第一阶段同时维护 RabbitMQ、Redis、ClickHouse、对象存储、图数据库和多套独立升级链。

### 多维表格投影写入要求

- 不把多维表格当唯一真源；所有人工修改转成 `correction_event` 后再重新投影。
- 使用写入幂等键和串行队列，避免同表并发写入冲突。
- 公式字段变化不会可靠触发记录事件，关键状态不得只依赖公式。
- 定期进行领域真源与多维表格的全量对账。
- Plane 与多维表格不能同时作为可编辑真源；若以后采用 Plane，多维表格应降为只读或有限命令投影。

## 12. 三阶段建议

### 阶段 1：权限与最小闭环验证

先确认关键假设，再验证单用户最小闭环；不制作完整产品。

权限与可靠性验证：

- 选择同一专用飞书租户和企业自建应用。
- 实测历史私聊、全部群消息、个人日历、文档、妙记和文件权限是否能获批。
- 验证重复事件、断网、token 失效、进程重启和 API 对账补漏。
- 明确完整原文的保存范围、期限、访问、退出删除和租户隔离合同。
- 核验实际月 API 额度和限流，不依据阶段性公开额度直接预算。

最小闭环推荐组合：

```text
飞书自建应用 + Channel/OpenAPI SDK
PostgreSQL source_event / task / decision / correction
inbox / job / outbox
多维表格任务投影 + 飞书任务提醒
Git 中的 Prompt 和规则
Promptfoo CLI 回归测试
Agent 主动回传 + 手工 reference path
```

明确不加入：Plane、Mem0、Langfuse 自托管、Temporal、Graphiti、OpenProject、复杂本地桥接器。

通过标准：用户授权与管理员审核真实可行，事件补漏不产生重复任务，原文留存合同得到确认；一名用户可以完成需求发现、候选确认、任务投影、日历提醒、纠错回归和工作文件引用闭环。

### 阶段 2：朋友试点

- 所有试用者先加入同一专用飞书租户；每个用户的消息、任务、规则和 reference 授权严格隔离。
- 增加本地只读桥接器，采用向外 HTTPS/WSS 连接和显式目录授权。
- 增加完整删除、导出、权限撤销、失败补录、备份和恢复流程。
- Trace 数量和调试需求明显增加后，再选择 Langfuse Cloud/托管实例；语义召回确实不足后再验证 Mem0。
- 多维表格无法满足个人 PM 体验后再评估 Plane，且只能有一个可编辑任务真源。

通过标准：多名用户连续使用后，任务归属、权限、纠错、事件补漏和删除均可审计，没有跨用户泄漏。

### 阶段 3：跨租户与规模化

- 跨企业使用改为商店应用，补齐 ISV、管理员安装、`tenant_key`、每租户 token、计费和客服义务。
- 长流程和跨服务恢复复杂后引入 Temporal；多步 AI 审批流程成熟后引入 LangGraph。
- 跨项目时间关系成为真实需求后再验证 Graphiti；多人正式项目管理成为核心后再采用 Plane。
- 将本地桥接器、Agent adapter、更新机制和安全审计作为独立客户端产品治理。

通过标准：租户隔离、升级、可靠性、成本和权限审核都可以按正式服务标准运营。

## 13. 许可与运维裁决

| 组件 | 开源/商业边界 | 运维负担 | 当前裁决 |
|---|---|---:|---|
| Plane Community | AGPLv3；商业版是独立功能线 | 高 | OPTIONAL |
| OpenProject Community | GPLv3；Enterprise 提供付费附加能力 | 高 | AVOID 当前阶段 |
| Mem0 OSS | Apache-2.0；托管版能力更完整 | 中 | OPTIONAL 派生记忆 |
| Langfuse OSS | 核心 MIT；`ee/` 为商业许可 | 很高 | OPTIONAL，不自托管首期 |
| Promptfoo CLI | MIT；团队服务和生产多用户能力商业化 | 低 | ADOPT CLI |
| 自有最小领域层 | 自有代码与普通数据库 | 中 | ADOPT |

## 14. 暂不采用的设计

- 不让 LLM 摘要覆盖或替代原始聊天。
- 不把飞书任务、多维表格或 Plane 直接当成完整系统真源。
- 不因文件创建或修改自动判断任务完成。
- 不在第一阶段引入图数据库、完整 Agent 运行时或复杂工作流引擎。
- 不让系统复制、移动、归档或修改 Agent 工作区中的真实文件。
- 不让 n8n、Temporal、LangGraph 的执行历史替代任务和聊天真源。
- 不把个人 Agent CLI 的用户 token 暴露给多人机器人或共享群聊。

## 15. 主要官方来源

### 飞书

- [接收消息](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive?lang=zh-CN)
- [获取会话历史消息](https://open.feishu.cn/document/server-docs/im-v1/message/list?lang=zh-CN)
- [事件订阅概述](https://open.feishu.cn/document/server-docs/event-subscription-guide/overview?lang=zh-CN)
- [日历资源介绍](https://open.feishu.cn/document/server-docs/calendar-v4/calendar/introduction?lang=zh-CN)
- [视频会议概述](https://open.feishu.cn/document/server-docs/vc-v1/video-conferencing-overview?lang=zh-CN)
- [任务概述](https://open.feishu.cn/document/task-v2/overview)
- [多维表格概述](https://open.feishu.cn/document/server-docs/docs/bitable-v1/bitable-overview?lang=zh-CN)
- [飞书官方 CLI](https://github.com/larksuite/cli)
- [飞书应用类型概述](https://open.feishu.cn/document/home/app-types-introduction/overview)
- [自建应用与商店应用](https://open.feishu.cn/document/home/app-types-introduction/self-built-apps-and-store-apps)
- [飞书 Channel SDK](https://open.feishu.cn/document/mcp_open_tools/integrating-agents-with-feishu/integrate-feishu-channel)
- [飞书 OpenAPI MCP](https://github.com/larksuite/lark-openapi-mcp)
- [自建应用 API 调用额度](https://open.feishu.cn/document/uAjLw4CM/ugTN1YjL4UTN24CO1UjN/platform-updates-/custom-app-api-call-limit)

### 任务与记忆

- [Plane Developers](https://developers.plane.so/)
- [Plane Architecture](https://developers.plane.so/self-hosting/plane-architecture)
- [Plane Editions and Versions](https://developers.plane.so/self-hosting/editions-and-versions)
- [Plane AGPLv3 License](https://github.com/makeplane/plane/blob/preview/LICENSE.txt)
- [OpenProject API and Webhooks](https://www.openproject.org/docs/system-admin-guide/api-and-webhooks/)
- [Mem0 REST API](https://docs.mem0.ai/open-source/features/rest-api)
- [Mem0 OSS Setup](https://docs.mem0.ai/open-source/setup)
- [Mem0 Platform vs OSS](https://docs.mem0.ai/platform/platform-vs-oss)
- [Letta Memory Blocks](https://docs.letta.com/guides/core-concepts/memory/memory-blocks)
- [Graphiti Adding Episodes](https://help.getzep.com/graphiti/core-concepts/adding-episodes)
- [LangGraph Persistence](https://docs.langchain.com/oss/python/langgraph/persistence)
- [Langfuse Prompt Version Control](https://langfuse.com/docs/prompt-management/features/prompt-version-control)
- [Langfuse Enterprise License](https://github.com/langfuse/langfuse/blob/main/ee/LICENSE)
- [Langfuse v3 to v4 Upgrade](https://langfuse.com/self-hosting/upgrade/upgrade-guides/upgrade-v3-to-v4)
- [Promptfoo GitHub](https://github.com/promptfoo/promptfoo)
- [Promptfoo Security](https://github.com/promptfoo/promptfoo/security)

### Agent 工作区与协议

- [Claude Code Hooks](https://code.claude.com/docs/en/hooks)
- [Claude Code MCP](https://code.claude.com/docs/en/mcp)
- [Claude Code Skills](https://code.claude.com/docs/en/skills)
- [Coze Upload files](https://www.coze.com/docs/developer_guides/upload_files)
- [Coze Run workflows](https://www.coze.com/docs/developer_guides/workflow_run)
- [ChatDev Python SDK](https://github.com/OpenBMB/ChatDev/blob/main/runtime/sdk.py)
- [ChatDev shared code_workspace](https://github.com/OpenBMB/ChatDev/blob/main/docs/user_guide/en/nodes/python.md)
- [ChatDev workspace artifact hook](https://github.com/OpenBMB/ChatDev/blob/main/workflow/hooks/workspace_artifact.py)
- [MCP Resources 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/server/resources)
- [MCP Tasks extension](https://modelcontextprotocol.io/extensions/tasks/overview)
- [MCP Roots 2026-07-28（已弃用）](https://modelcontextprotocol.io/specification/2026-07-28/client/roots)
- [MCP Authorization Security Considerations](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations)
- [MCP Progress](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/progress)
- [Git status Porcelain v2](https://git-scm.com/docs/git-status#_porcelain_format_version_2)
- [Git fsmonitor daemon](https://git-scm.com/docs/git-fsmonitor--daemon)

### 编排与可靠性

- [AWS Transactional Outbox Pattern](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html)
- [PostgreSQL SELECT / SKIP LOCKED](https://www.postgresql.org/docs/current/sql-select.html)
- [PostgreSQL INSERT / ON CONFLICT](https://www.postgresql.org/docs/current/sql-insert.html)
- [Temporal Timers](https://docs.temporal.io/workflow-execution/timers-delays)
- [Temporal Retry Policies](https://docs.temporal.io/encyclopedia/retry-policies)
- [Temporal Workflow Message Passing](https://docs.temporal.io/encyclopedia/workflow-message-passing)
- [Temporal Worker Versioning](https://docs.temporal.io/worker-versioning)
- [LangGraph Interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts)
- [LangGraph Backwards Compatibility](https://docs.langchain.com/oss/python/langgraph/backward-compatibility)
- [n8n Wait](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.wait)
- [n8n Queue Mode](https://docs.n8n.io/deploy/host-n8n/configure-n8n/scaling/enable-queue-mode)
- [n8n Sustainable Use License](https://docs.n8n.io/privacy-and-security/sustainable-use-license)

## 16. 最终裁决与剩余 P0

工程方案调研已经可以给出明确裁决：

- **未来实施首期推荐采用**：飞书同租户自建应用、官方 Channel/OpenAPI SDK、自有最小领域层、PostgreSQL inbox/job/outbox、多维表格投影、飞书任务提醒、Git 规则、Promptfoo CLI、逻辑 reference URI 和 Agent 主动回传。
- **条件采用**：本地只读桥接器、Plane、Mem0、Langfuse、LangGraph、Temporal、Graphiti、Git 持久快照。
- **当前不采用**：OpenProject、n8n 核心编排、OpenAPI MCP Beta 作为唯一底座、图数据库首发、完整 Agent 运行时首发。

实施前仍必须真实验证：

1. 全部私聊与群消息权限是否获批及能否可靠补历史；
2. 原文长期留存、删除、退出和组织政策；
3. 2026-08 实际 API 月额度和跨接口调用量；
4. 同一专用租户是否被试用者接受；
5. Windows/macOS 本地只读桥接器的目录授权与安全更新方式。

这些是未来实施项目的 P0 验证，不影响本调研对成熟工程方案的比较结论。
