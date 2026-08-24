# 架构边界

PRIV-001 v6 并发约束：active claim 默认阻止冲突 update，过期只能完整 identity CAS reclaim；provider call 前执行最终 durable fence，旧 actor 的 finalize/compensation 不能覆盖新版本。

> 2026-08-17 PRIV-001 schema-v6 amendment：v5 migration identity/checksum 保持原样；v6 新增跨进程 lifecycle claim/fencing、owner/capability/intent binding、版本 CAS 与 durable backup cleanup intent。副作用前先 claim，finalize/compensation 再验证 token/version；受管备份 manifest 已删而 sqlite 删除失败时仍可恢复。

M1 的产品与治理决策以 [DEC-01](decision-register.md) 为唯一登记入口：SQLite、draft-only、上海自然日和日历候选责任门、隐私删除顺序、PR/独立复核及真实试点 gate 均不可由实现者自行改写。来源事实、生成摘要和文件活动继续保持不同语义；当前证据不替代 L5/L6 真实环境验收。

PROD-07 进一步固定日历入口的语义：日历事件先作为来源事实/提醒保存；运行时仅当 `explicit_owner_responsibility + action + deliverable_or_deadline` 三项同时成立时才允许进入 `candidate_review`，否则走 `calendar_fact` 或责任不明的 `owner_confirmation`。过滤为非任务不删除来源；会议占位不单独推断 action item，纪要或明确消息必须重新提供可追溯依据。路由解释只保留固定代码、有限证据字段和来源引用，不暴露原始日历 payload、参会人目录或正文。

## 推荐主链

```text
飞书 / 日历 / 妙记 / 人工来源
  → 原始来源耐久保存
  → 单条候选生成
  → 待确认候选归并与主人主体识别
  → 高置信自动归并 / 低置信主人确认
  → 接受为一个正式任务
  → 后续来源关联与内部任务维护
```

`candidate_merge` 只处理尚未接受的候选；`thread_association` 处理来源与已有正式任务的归属。两者分别建模，避免候选归并破坏正式任务更新链。

## 推荐主链

```text
系统主人 OAuth 个人信息流
├─ 自动发现既有 P2P → 默认关闭 / 主人选择 → 周期读取对方来信
├─ 主人群列表发现 → 明确选择群 → 本地匹配 @主人
├─ 日历增量
└─ 妙记增量
                ↓ 主入口
        耐久 inbox 与幂等去重
                ↑ 补充入口
   机器人私聊 / 明确需求群 / 人工补录
                ↓
      原始来源与 source_context
                ↓
       来源/文档复合 revision
                ↓
       AI 判断、关联与结构化提案
          ↓                 ↓
 强证据自动维护内部任务   歧义/弱证据待确认
          ↓                 ↓
    私人 PM 网页与审计  主人纠正/撤销/选择归属
```

飞书企业自建应用负责 OAuth、权限和 API；机器人不再是主要交互媒介。完整裁决见 [ADR 0002](adr/0002-owner-information-first.md)。

## Windows 桌面运行方式

```text
Electron React renderer
        ↓ 受限 preload IPC
Fastify inject / PmService（不监听固定本地端口）
        ↓
SQLite / 飞书适配器 / LLM 适配器 / 只读工作区
```

Fastify继续用于浏览器开发、自动测试和未来需要的飞书回调入口；正式 EXE 内部不要求用户单独启动 Web 服务。桌面数据库和加密配置均存放在当前 Windows 用户的应用数据目录。

正式服务端与 Electron 使用的 `buildApp` 默认只装配产品 API，不注册 `/api/dev/simulate-message`。该开发夹具只能由自动测试在创建 App 时显式开启，不能通过 `NODE_ENV`、内存数据库、浏览器模式或 renderer 开关隐式获得。正式人工补录走 `/api/corrections`，沿用来源、候选、幂等与主人确认主链。

### 浏览器 E2E 隔离

Playwright 的桌面宽屏和 Pixel 7 项目分别连接独立的本地 Fastify 进程。父进程直接启动 `apps/server/tests/e2e-server.ts`，由测试目录中的显式装配注册 `/api/dev/simulate-message`；正式 `src`、构建产物和 Electron 不包含该路由。每个进程使用专用端口、进程内 SQLite 和独立任务记忆目录，每轮测试再生成唯一运行根目录；启动脚本强制关闭真实飞书、真实 LLM 和工作区读写。

父控制器只接受携带本轮 run token 的 IPC 就绪消息，不用端口上任意 HTTP 200 代替启动身份确认。Controller 与 Playwright 各自只维护一个显式 lifecycle phase；Playwright 发送一次性 shutdown nonce，controller 进入 `shutdown-requested` 后只有在 ACK 实际发送成功时才进入 `shutdown-accepted`，Playwright 也只有收到匹配 run token 与 nonce 的 ACK 才接受正常退出。ready 后、ACK 前或未请求时，任何 controller 或子进程退出（包括退出码 0）都会让全局门禁失败。清理阶段先通过 IPC 请求子进程关闭并有界等待，超时才强制终止；确认进程退出后才重试删除本轮目录，避免 Windows 文件锁和同一 checkout 的前后轮状态冲突。自动探针分别覆盖正常 ACK 关闭、ready 后意外 code 0、ACK 前意外 code 0、端口冲突和注入启动失败，并逐场景比较运行目录集合。两个项目可并行运行，但不会共享候选、任务或文件投影状态。

这一级验证的是 L4 浏览器页面与本地 Mock/虚拟数据闭环。23 条通用应用路径同时进入桌面 Chromium 与 Pixel 7；首次配置保留并规范化 DeepSeek Provider、选择安全模拟模式强制 `rule_mock` 且关闭真实飞书连接与扫描两项只进入桌面 browser bridge Mock 适用矩阵。该 Mock 不经过真实 Electron main/preload、safeStorage、NSIS 安装和 Windows 桌面桥接，Pixel 7 也只表示移动 viewport 下的 React 页面行为；二者都不能替代 L5 Electron EXE Smoke，更不能替代真实飞书/LLM 的 L6 验收。

### CI 选择与失败日志边界

Pull Request CI 先使用 [测试选层与证据门禁](test-selection.md) 对完整 `base → merge-ref` diff 分类，再选择最低 L0–L6 目标。只有全部路径明确为纯文档时才缩短为 L0 文档门禁；测试、脚本、依赖、CI、server/data/runtime、Feishu/LLM、web、desktop 和 release 变化继续执行完整源码检查、生命周期探针和浏览器 E2E。mixed、unknown、绝对路径、父目录逃逸和空 diff 一律 fail-closed 到完整门禁，并标记人工复核，不能用窄证据授权 broad L5/L6。changed-path 选择只决定本轮门禁，不改变 L0–L6 的证据含义，也不能替代产品源码 fingerprint 检查。

CI 在 Pull Request merge ref 上运行，并核对 checkout 的双亲与事件中的 base/head，不能用 head-only 结果代替组合结果。完整门禁只构建一次 web/server/desktop；测试专用 server 装配继续直接运行源码，浏览器服务消费本轮 web 构建，并在启动前核对当前 commit、源码状态与 web/server 完整产物树 hash，避免重复构建或误用旧文件。各测试包必须由测试运行器报告至少一条通过测试，不使用 `passWithNoTests` 把缺失或全跳过测试写成通过。

每条当前证据还必须遵守 `evidence_contract`：exact CI 绑定 base/head/merge-ref/parents/tree/run/job/environment/command；四个 SHA 字段必须为完整对象标识，parents 严格为 `[base, head]`，attained exact evidence 的 source 必须等于 head；对象可用时还会读取 merge-ref 实际 parents/tree 和 source/head 对象，但本地 checker 不证明 GitHub Actions run/job 的存在、SUCCESS、event、head_sha 或 merge checkout，最终授权仍需 PR body/Lead 远端核验。记录与 provenance 的 run/environment/command 必须交叉一致；local run 明确 CI 字段为 `not_applicable` 且 parents 精确为空数组；未运行记录使用 `not_run` sentinel。provenance/skip 对象拒绝未知字段，`capability`/`platform` skip 与 `not_executed` 分开，后者必定 fail-closed。Artifact hash 只证明身份，不等同 Windows Smoke；synthetic/Mock/replay/browser 最高 L4，真实租户/provider 的 L6 必须另有实际授权运行。

当前 workflow 不上传任何失败 artifact，也不跨 job 保留 Playwright report、trace、screenshot 或测试日志。Playwright/Vitest machine JSON 只在 runner 临时工作区供同 job 清单核验，job 结束后自然销毁。生命周期和 E2E 的命令包装器不直接转发子进程 stdout/stderr，也不把原文写入磁盘；它用固定大小分块和有界跨块上下文扫描输出，不累积完整原文、不落盘或回显，只向 Actions 写固定字段摘要。敏感关键字、URL userinfo、绝对路径、控制字节或无效 UTF-8 只形成布尔观察信号，不回显匹配内容；包装器自己的同步错误同样只输出固定说明，不输出错误消息或堆栈。该边界降低本 workflow 误保留日志的风险，但不声称能阻止恶意 PR 自己向 Actions 输出内容；安全失败附件方案需要独立威胁建模和评审后再实现。

桌面程序在已保存真实飞书配置时会自动启动个人信息流 Runner；首次 OAuth 成功后会立即接续一次主人身份刷新和增量同步。设置页自动展示主人 OAuth 发现的既有 P2P，但新发现人员默认不关注；主人可逐个选择或一键关注当前已发现人员，群聊仍按群名选择。页面不暴露 `chat_id`，每个人和群都有独立游标、最近成功和错误。普通私聊采用周期轮询，超过 50 个已关注目标时每轮扫描近期 40 个与最久未扫 10 个；群聊只读取明确选择群并持久化真实 `@主人` 消息。“保存并开始授权”会先保存当前飞书表单，再创建唯一有效的一次性 state；Electron main 使用本机加密保存的 App Secret 完成服务端 Token 交换，不向 renderer 暴露凭证。设置保存会先停止旧 Runner、关闭旧数据库，再按新配置重建；完全退出和重启会等待 OAuth 回调服务、Runner 与飞书长连接停止后再释放数据库。

所有系统浏览器跳转都使用共享的纯函数 URL policy。候选页 renderer 先校验原始文档地址；拒绝值不进入 bridge，允许值只以 policy 返回的规范 URL 进入 document-only preload。Electron main 使用同一 policy 再次独立验证后才调用 `shell.openExternal`。OAuth 保持独立、无通用 URL 参数的 IPC，由 main 从本地服务取得授权 URL；只允许官方 `accounts.feishu.cn` / `accounts.larksuite.com` 精确端点，并要求程序实际生成的五个 query 参数各出现一次、类型和值满足合同，fragment 一律拒绝。文档仅允许 `feishu.cn` / `larksuite.com` 本域或子域下精确的 HTTPS `docx|wiki|sheets/<token>`，不接受 query、fragment、尾斜线或额外路径。非 HTTPS、自定义协议、用户名密码、控制字符、原始或编码反斜线、异常或多层编码、超长值、非标准端口、本机/私网、相似域和未声明组件均 fail-closed。`setWindowOpenHandler` 和 `will-navigate` 只拒绝并把结构化结果送回页面；拒绝结果包含固定 `reason/errorCode` 与人读说明，页面展示 `errorCode` 供主人排障，但不包含原 URL。该结果可供后续 `OBS-01` 接线，本 Issue 不新增持久日志或 trace ID。OAuth 本机回调继续由独立的 `127.0.0.1` HTTP listener 合同处理，不能经文档外链入口打开。任务记忆目录继续走校验后的 `shell.openPath`，reference path 不是可点击外链。

## 数据真源

### Cindy 可信来源 receipt 边界

Cindy 入库现在固定为两步：`save_pm_sources` 先把来源事实提交到 SQLite，服务端再返回 opaque `source_receipt`；`submit_pm_decisions` 只能引用 receipts 和结构化决定，不能重传 raw sources。Bearer 集成令牌只用于 HTTP 鉴权；插件另行持久化稳定连接账号锚点和独立 receipt 校验密钥，服务端对账号锚点做域分离摘要后绑定 owner scope。Bearer 轮换不改变旧 receipt、来源身份或保存/决策幂等，请求 body 不接受 owner/account 字段。

schema v9 在既有 `source_event` / `source_event_revision` 之上增加稳定来源身份、处理状态、请求幂等、关系图和 receipt 摘要。receipt 由服务端随机 nonce 与独立 receipt 密钥生成，数据库只保存 nonce 和 receipt 摘要，不保存可直接使用的 receipt。可比较 provider revision 只允许 RFC3339 `modified_at` 与非负整数 `sequence`，低版本不能恢复为 current；无可比较 revision 的异内容更新 fail-closed。整批关系在同一事务内完成未知引用、重复、跨账号、失效和成环校验，任一失败都在提交前回滚，保持零写入。v8→v9 任一迁移操作失败会终止启动并恢复完整 v8，生产装配也不提供可绕过 receipts 的 raw intake/seed 路由。

旧 `source_event` 和 revision 迁移后默认 `legacy_read_only`，不会自动进入新决策。只有能够从历史 metadata 形成稳定 provider/source kind/message identity 的记录才建立只读身份映射；Cindy 重新读取后在原来源上追加新的 current revision 并签发 receipt。无法形成稳定身份的旧来源继续隔离。

首期采用自有最小领域层，至少包含：

```text
source_event
source_context
owner_profile
information_source_state
feishu_monitor_target
source_demand_unit
source_demand_unit_source
candidate_request
candidate_revision
requirement_thread
requirement_thread_source
requirement_thread_revision
requirement_thread_unit
task_update_proposal
ai_decision_log
task
task_source_link
task_event
correction_event
notification
reminder
reference_binding
memory_projection
app_setting
approval
job / runtime_checkpoint / runtime_tool_call / outbox
```

原始来源和正式任务状态保存在系统数据库中。飞书任务、多维表格或机器人卡片只能是提醒或投影视图，不能成为第二个可编辑真源。

`source_context` 保存消息中识别到的飞书文档背景：受限正文片段、内容哈希、文档版本、读取状态、freshness、完整性和最近成功时间。它是来源的派生上下文，不是新的主信息源。`ai_decision_log` 保存 provider、model、prompt 版本、输入哈希、复合 revision、耗时与结构化结果元数据，不保存普通日志中不需要的完整原文。前端候选卡和任务详情只读取 `describe`、字段依据和审计元数据；聊天正文仍只在受控本地来源审计中保存，不作为页面摘要直接渲染。PROD-01 在 route/service 边界为候选、任务和主人响应建立严格 allowlist DTO；候选操作、任务列表/详情/工作台/日历/提醒、重新整理和纠错均由公开投影重新装配，不直接返回数据库行或内部审计快照。任务修改和自动维护回执仍重新读取完整严格 TaskDetail，不能以最小列表 DTO 替代页面所需关系集合；ISO 排期、状态和风险等结构化字段按自身 schema 校验，不进入自由文本清洗。默认来源只带 opaque `source_scope`、来源类型、完整性、发生时间和摘要可用性，不带正文、来源稳定 ID、外部 ID、文档 URL/ID、参考路径、纠错 before/after/note 或 Runtime/provider 原始错误。主人主动核验时，服务端重新校验 task↔source 关系、确认字段和作用域；当前只核验本地保存快照，返回有界脱敏片段、`local_snapshot_verified`/`local_snapshot_unavailable`、受控 `provider_status` 和快照捕获时间，并写私有审计；该流程不创建 outbox 或任何外部动作，也不声称实时 provider 权限或撤回状态。

`source_demand_unit` 保存一次分类中识别出的具体需求，`source_demand_unit_source` 保存该单元实际使用的原始来源，`requirement_thread_unit` 把需求单元唯一挂到一条持续需求线。四层 ID 不可混用：`source_event_id` 是消息事实，`demand_unit_id` 是消息里的具体需求，`requirement_thread_id` 是持续讨论，`task_id` 是主人接受后的正式任务。

## 受控 PM Runtime 与需求线程

```text
source_event（先落库）
        ↓
job：幂等键 → lease → attempts/backoff → checkpoint
        ↓
requirement_thread + revision
        ↓
candidate_revision / task_update_proposal
        ↓ 自动策略门
强证据且版本一致       歧义/弱证据/降级/冲突
        ↓                         ↓
AI 自动应用内部 patch          主人待确认
        ↓                         ↓
task.version + task_event + 前后快照
        ↓
memory_projection（可重建文件夹）
```

- `job` 是执行层记录，不能替代业务 `task_id` 或 `thread_id`。同一来源和分类 revision 只允许一套运行记录；进程重启后由过期 lease 恢复，临时失败按指数退避，取消是终态。
- 周期 Runner 只在 `available_at` 到期后重试，避免重叠扫描反复轰击模型；明确的人工重试才会唤醒退避中的失败 job。工具 Promise 超时时不会在当前调用内立即重试，避免与尚未结束的底层操作重叠。
- RUN-02 复用同一 Runtime 生命周期和 job fence：过期 lease 接管会在同一 SQLite 事务内终结旧 `allowed` tool_call，再暴露新 owner；活动 lease、取消、关闭和 owner 替换都不能被接管或迟到回调绕过。连续 schema v8 新增 `provider_retry_cooldown`，以 provider key 的原子 max deadline 在多个 Runtime 与进程重启之间共享；provider 调用前先检查 durable deadline。严格 `Retry-After` 与既有 cooldown 是最早重试下界，每个 caller 仅在该下界之上增加本地正向 jitter，额外 jitter 不写回共享 deadline，避免同步风暴和等待时间被并发 caller 反复推高。typed retry signal、optional stage 隔离和 stale callback guard 保持 fail-closed。
- RUN-01 的 Runtime 恢复顺序是“已持久化的来源上下文 → provider 完成 checkpoint → 单一 SQLite 业务提交”。`runtime_checkpoint.state_json` 对每个可恢复阶段保存 `step`、来源 ID、分类 revision 和受控 continuation；只有标记为可复用的结构化结果才会跳过 provider，结构失败/临时降级仍回到 durable retry。上下文和 provider checkpoint 命中时从 SQLite 派生缓存继续，不重做已完成的读取或模型阶段。
- 每次 provider/tool 调用都携带 `AbortSignal`；超时先 abort 底层调用再结束当前 Runtime 工具，不能在同一 Promise 仍在途时启动进程内重试。Runtime lease 的预算覆盖最坏的分阶段 provider 重试，并在调用期间有界续租；工具成功或失败的审计终结、checkpoint 和外部 claim 都在同一 SQLite 事务内以精确 job 状态、lease owner、取消标记和 lease expiry 原子校验，租约失效、取消或 generation 关闭后的旧 worker 只得到受控 lease-lost，不能写入 completed/failed、checkpoint 或业务结果。
- 关闭先停止新 Runtime 工作、abort 在途调用，再执行有界等待；只释放当前 Runtime 实际持有的 lease，不能误伤并行 worker；超时也会把 generation 标记为 stopped。迟到回调只能得到拒绝结果，不能写入已关闭数据库。RUN-01 保留 `external.send` 的 claim/幂等恢复结构作为历史审计兼容和未来独立发送 Issue 的边界材料，但 M1 的 code-owned policy 固定为 `forbidden`：即使 `approved=true` 或存在幂等键，也不会建立外部 claim、调用 provider 或执行 caller callback。
- 工具策略分为只读、受控内部更新、需审批和禁止，并保存输入哈希与结果状态。受控内部更新只能调用固定的私人任务 patch，不获得任意 SQL、Shell、文件写入或外发能力；HTTP 诊断视图只返回白名单摘要，不返回 payload、checkpoint state 或工具结果 JSON。
- 线程关联优先使用飞书 `root_id` / `parent_id`，其次才使用同会话、参与人、时间窗和对话续接表达。除“补充”外，“可以”“什么时候要”“策划案在哪”等短确认、排期和资料交接在 30 分钟内、且只有一个近期需求时可承接；明确“另一个/新需求”会阻断续接。已接受正式任务的后续来源继续使用 `thread_association`；歧义归属进入 `needs_confirmation`。
- 尚未接受的候选使用独立 `candidate_merge` 契约：模型判断是否同一需求、哪条是主人需要推进的主体，以及每条来源属于主体交付、背景、约束或流程咨询。高置信结果经服务端完整评分、快照、唯一目标和主体角色门禁后自动归并；低置信只展示建议。
- 连续消息的批量判断以“同一会话、同一次完整分页扫描”为边界；只有整页读取完成后才提交该批次。跨轮询和实时 WebSocket 暂不等待延迟消息再聚合，但分别生成的待确认候选会再次进入 `candidate_merge`，因此仍可能归并成同一需求。批次聚合不改变页面展示边界：页面显示摘要和归类依据，不直接展示聊天正文。
- FSH-03 的 WebSocket 回调采用 durable-inbox-before-ack：先在一个 SQLite 事务中以 `external_id` 幂等写入 `source_event`，并将去重身份绑定到 `owner_scope + metadata.sourceScope + source_type + conversation_id`，取得带 source ID、capture time 和 dedup 状态的 `DurableEventReceipt`，再允许 SDK 返回确认。commit 前失败、无效 receipt、未知 chat type、foreign owner/source scope、跨入口/会话碰撞或未授权群均 fail-closed；确认失败由平台重投，兼容重复/并发投递不会重复建立来源，也不会改写已提交的渠道 provenance。提交后 Runtime 分类是独立恢复阶段，进程在“来源已提交、job 尚未创建”窗口退出时，启动恢复只处理显式 `bot_supplement/primary` orphan rows。
- 批量分类允许返回最多 8 个匿名需求单元。每个单元声明使用的匿名来源键；同一来源可以属于多个单元。模型没有拆分必要时可返回旧格式，但已有多单元结果不得被一次无 `units` 的降级结果覆盖。
- DeepSeek 使用 `demand_intake_v7` 分阶段小结构：普通消息以 `message_action` 路由，再按动作和候选上下文并行调用 `demand_details`、`thread_association`、`candidate_merge` 或 `task_update`；经稳定 ID 验证的主人消息直接调用小型 `owner_intent`。每个阶段只返回 3—8 个核心字段；服务端负责默认值、匿名 ID 还原、日期换算、候选选择和最终业务对象合成。
- 每个阶段正文先经过 JSON 提取、固定示例修复和 Zod 校验。普通消息的动作或新需求摘要失败时，Runtime 保存失败状态、退避时间和恢复 checkpoint，不生成“非需求”结论；主人意图提取失败同样保留来源等待重试。主人意图已经成功但候选关联不唯一时，独立 `owner_decision` 保留为待确认并显示“尚未执行”，不能被后续关联失败抹掉。模型运行期间来源 revision 变化时，事务零写入并以新版本重新判断。
- Issue #29：主人判断在分类开始时保存服务端目标快照，并把候选忽略/回收站删除、任务删除或作废作为统一退休边界。尚未完成的 `queued/running/review/failed` 判断只保留 `stale` 审计；延迟返回或重试不得重新绑定退休目标，任务恢复也不会自动执行旧判断。Runtime payload 写入同时校验当前 lease owner、未过期 `locked_until`、`cancel_requested_at IS NULL`，且必须单行命中；旧租约或取消中的 worker 不能覆盖新 owner。显式零目标快照在首次处理时仍可保留真正未关联消息的 `review`，但重启/重试确认同一耐久空快照后只写 `noop` 审计且不生成待处理提醒。ignored 候选没有可证明的历史退休时间时不推断 stale；启动对账仅处理可证明关联已退休目标的 legacy orphan，没有 source/thread/root/parent/session 强关系或同 source 历史 linked decision 的真正歧义继续进入待确认。accepted snapshot 还必须匹配 candidate state、accepted task、task/thread ID、version 和 status。`listPendingOwnerActions` 只返回当前候选/任务仍可处理的动作。
- 可选的线程/候选关联阶段对受控 transport、429/5xx 和结构错误做阶段级隔离；核心动作和任务补丁成功时保留 `partial/repaired` 结果并记录固定错误码，所有可用关联阶段都失败时才回到安全重试。fallback 或规则 Mock 只表示受控降级，不冒充真实 provider 成功。
- 当前发言角色由服务端根据稳定主人 ID 验证后，以脱敏 `current_sender_role` 传入模型；模型看不到真实用户 ID，也不能把需求方的“可以”解释成主人承诺。模型返回的时间文字必须能在当前分类来源中回查，程序才会解析日期并写入语义结果。
- 疑似补充消息可触发会话内向前补扫：只读当前已启用目标，受 72 小时、3 页和人员硬起点限制，不推进正常游标。主人发送的消息作为 `conversationContext`，不得单独形成候选；截断或权限不足会标记背景不完整。
- 主人发送的消息只有在 sender ID 匹配已授权 `owner_profile` 的稳定 `open_id / union_id / user_id` 后才进入主人分类链，并作为独立 singleton 处理，不会创建普通候选。`isOwnerMessage`、`senderRole` 和模型输出都只是线索，不能替代服务端身份授权。模型返回的 `owner_intent` 只表示主人对当前需求的承接、排期确认、索要资料、继续推进、拒绝或转交意图；服务端再按回复链、父消息、会话、已有线程/来源关系和唯一候选选择目标，模型不能直接指定数据库记录。
- 主人状态机的自动动作使用独立 `owner_decision` 记录和 `owner_decision` Runtime job。意图置信度必须达到 `0.90`；更低结果只写 `review`。候选承接、任务 patch、候选拒绝/转交都在单一 SQLite 事务中执行，并校验来源 revision、目标快照、任务/线程版本和 Runtime lease；排期只在原消息或有界前文能解析出明确日期时写入，普通数字范围先排除，主人仅回复“可以”但无法确认日期时保留待确认。
- 同一周期内的多条主人消息不会合并成一个分类批次，而是按 `occurred_at` 逐条判断，避免后一条索要资料覆盖前一条承接或排期确认。Runtime 恢复会重开未完成的主人判断，幂等键保证重启、重复投递和租约恢复不会重复建立任务或追加时间线。
- 后续来源先生成 `candidate_revision` 与 `task_update_proposal`；提案统一保存基准任务/线程版本、JSON patch、来源证据、provider、model、prompt 版本、关联置信度、更新置信度、fallback 状态和策略版本。自动、主人批准和重新整理都复用同一创建与应用事务，不能由 AI 冒充主人 actor。
- 默认自动应用要求同时满足：关联唯一；回复链、明确 `session` 或主人已确认归属等强证据；模型未降级；关联和更新置信度达到安全阈值；任务/线程版本未变化；任务未删除、作废或暂停；计划时间不是待确认推测。任一门禁失败都保留来源并降级为待确认。
- `in_progress / waiting / review` 等内部状态可在明确来源证据下自动更新。`completed / archived` 需要明确完成、取消或不再处理的证据并生成重点提示；任务删除、判定非需求和物理清除数据不进入自动 patch 白名单。
- 每次自动应用保存任务、线程和候选的应用前后快照、应用后的任务/线程版本、来源和 `task_event_id`。同一旧版本的其他待确认提案立即失效，不能覆盖新版本。
- 通知以来源/提案为互斥键：自动应用成功会归档对应“请确认更新”，并只生成 `auto-update:*` 提醒；安全门未通过时只生成确认提醒。完成或归档另生成重点核对提醒。工作台“需要关注”是这些私人提醒的统一入口。
- 工作台 API 以服务端生成的 `asOf` 和 `Asia/Shanghai` 半开自然日区间 `[00:00, 次日 00:00)` 计算“今天推进”，同时返回 `todayDate/timezone/dataMode`。已有单点时间锚落在区间内时纳入；同时存在 `planned_start_at/planned_due_at` 时，只要显式区间与当天重叠也纳入，因此跨日任务会出现在其覆盖的上海自然日。`completed` 不计入待推进，`archived` 默认隐藏。候选、今日计划、等待、进行中和逾期使用各自独立 `COUNT`，展示列表的 `LIMIT` 不参与总数。本 Issue 只落实 Dashboard；排期日历按每个覆盖日展开的剩余实现属于 Issue #50。
- 排期日历 API 同样返回服务端生成的 `asOf`、固定 `timezone=Asia/Shanghai`、已分组 `days`，以及固定脱敏的 `warning/omittedCount`。共享日期工具单次解析有效计划区间 `[planned_start_at, planned_due_at)`，同时产生 day keys、规范化展示锚点和清洗后的 start/due/schedule；Calendar 专用 DTO 只包含 `id/title/status/next_step` 与这些安全展示字段，不复用通用 Task 序列化。任务进入每个相交的上海自然日，结束恰为次日 00:00 时不进入右侧日期；`start == end` 兼容为 start 所在单日的点事件，`start > end` 是异常区间。展开前必须得到正的安全整数，且统一最多 366 个上海自然日。普通任务编辑、主人消息排期、`status_or_schedule_wrong` 中实际修改排期的纠错、task-update-proposal 应用，以及自动更新撤销恢复 `before_snapshot` 时，都会在对应事务写入前复用同一 validator，拒绝反向或超限区间。撤销边界先以同一个 Zod parser 强解析持久化 before/after JSON：根必须是对象，实际恢复的 task/thread/candidate 字段必须存在且符合领域类型/枚举，`schedule_at/planned_start_at/planned_due_at/completed_at/archived_at/last_activity_at` 只接受与正常 PATCH 相同的 ISO datetime string 或 `null`；对象采用 strip 语义，兼容的额外历史字段不会进入恢复对象。parser 之后再核对 task 与可选 thread。candidate-linked 只允许唯一 previous revision 的状态转移：before 必须携带非空 previous ID，after 必须归一为 `null`；previous 必须属于同 candidate、处于 `superseded` 且完整 payload 等于 before candidate，applied current revision payload 必须等于 after candidate/current candidate；before candidate.state、after candidate.state 和撤销前 candidate_request.state 也必须三方相等。candidate_request 恢复 SQL 不接受 snapshot state，只恢复 revision 承载的内容字段；事务后还会独立确认主表 business state 保持撤销前权威值。普通新来源和主人关联提案不切换其唯一 current revision，而以 candidate-less 方式保留任务/线程更新证据。事务内 applied current → superseded 与 previous → current 均要求单行命中，并最终确认同 candidate 恰好一个 current、其 payload 与 candidate_request 一致。任何损坏或错配都在 transaction、ID/时间生成和 SQL/audit 写入前返回固定脱敏冲突，task、proposal、thread、candidate、全部相关 revisions 和 task_event 保持零变化。最后才调用唯一上海日期 validator。只改状态或下一步时不会因既有历史坏排期被无关阻塞。历史读取逐任务隔离超限、反向和三锚点全坏记录，不回显坏值或异常；只有一个可用时间时，按 `planned_start_at → planned_due_at → schedule_at` 中首个可解析的有效锚点确定单日。renderer 只消费服务端安全 DTO，不自行用本机时区选择锚点或展开区间。`completed` 继续显示在其计划日；`archived`、`record_state=invalidated` 和软删除任务默认不进入日历。
- 撤销不是删除审计，而是新的主人操作：只有目标 AI 修改仍是任务最新版本时，才原子恢复任务、线程和候选状态，并继续递增版本、写入 `ai_update_reverted` 时间线。存在后续人工或 AI 修改时返回冲突，要求主人编辑最新任务。
- `app_setting` 保存全局自动维护模式；`task.auto_update_paused` 保存单任务暂停。暂停只阻止自动应用，来源、提案和审计继续耐久保存。
- `memory_projection` 只是 SQLite 真源的可重建投影。AI 自动修改、主人编辑、纠错、删除和恢复都会触发重建；失败显示为可见错误并可重试，不回滚正式任务。清理重建只删除 manifest 或旧索引明确登记的系统托管文件，未知文件和用户附件保留。
- 实际工作目录仍仅保存只读 `reference path` 元数据。解除引用只删除 `reference_binding` 和级联的 `reference_snapshot`，不对真实目录执行读取以外的动作，也不修改全局目录授权。
- “打开任务记忆目录”只存在于 Electron IPC：renderer 只能传 `task_id`，主进程从 SQLite 读取投影根目录和相对路径，重新执行根目录、路径逃逸、符号链接、存在性和目录类型校验后才调用 Windows 文件资源管理器；HTTP API 不返回绝对根路径。

### Issue #23：消息动作与需求线程中心化

连续对话不再把 `is_data_request` 当作唯一入口。LLM 先输出受约束的 `message_action`：`new_demand`、`update_existing`、`context_only`、`owner_action`、`decline_or_delegate` 或 `uncertain`，并可同时返回稀疏 `semanticAnalysis`。服务端再按消息角色、匿名候选快照、完整评分、候选集 hash、线程/任务版本、时间锚点和自动化策略复核；模型不能直接写入真实 ID 或数据库。

- `new_demand` 才能进入候选创建链；`update_existing` 和 `context_only` 只能挂到已验证的需求线程，不能凭关键词新建卡。
- 待接受候选使用独立 `candidate_merge` 校验；通过快照和高置信门后，后续消息追加到原 `demand_unit_id` 的来源链，不制造第二张卡。旧版没有需求单元的候选会在首次持续更新时安全升级到单元图。
- 无法唯一归属、动作置信度不足、模型降级或来源 revision 变化时，原始来源仍保留，建立 `needs_confirmation` 单元和可见通知；不会静默丢失，也不会随机修改任务。
- 模型结构失败最终降级时，来源和 Runtime 工作项仍保留，但不创建候选；旧版中性的待重试占位在列表层隐藏。不得把规则分类复制的聊天原文当作 AI 摘要显示在候选或任务页面。
- 日期文本按每条来源自己的 `occurred_at` 解析，再选最新的明确日期证据；模型只能提供日期语义（截止、开始、窗口或参考），不能用模型臆测的 ISO 时间覆盖程序解析。
- 主人消息仍走独立 `owner_decision` 状态机；`owner_action` / `decline_or_delegate` 不得绕过主人身份和版本安全门进入普通线程写入。

### PR #24：DeepSeek 分阶段结构化判断

DeepSeek 的 `json_object` 只作为合法 JSON 传输层，不等同于完整业务 Schema 保证。主链因此不再让模型一次生成候选、关联、主人意图、时间和任务补丁的超大对象，而是先路由、再按动作调用小 Schema。CLI 方案只会把同一 API 问题搬到额外进程中，并增加安装、启动和上下文同步成本，因此不作为桌面版默认依赖。未来若具体网关稳定支持严格 JSON Schema 或严格 Tool Calling，可在保持相同阶段合同的前提下做能力探测和替换，不允许重新合并成大 Schema。

### Issue #33：SEC-02 不可信数据与适配器后置守卫

若已有候选在 Runtime 重试时再次触发非法多需求单元边界，允许其进入 `retry_waiting` 这一受控恢复状态，但只能更新候选控制字段和固定脱敏恢复记录；候选修订、需求单元/线程/任务/提案/审批/outbox 等业务关系逐值零写入，也不得触发外部动作。

来源正文、标题、参与人文字和文档摘录只能作为 data message 进入模型，不能改变 system contract、主人身份、候选集、真实 ID、CAS/approval 或 outbound tool 权限。每个 classifier adapter 返回后，`enforceUntrustedClassificationBoundary` 以服务端事实重新投影固定字段：严格递归 schema 拒绝未知键，匿名 source/candidate 只允许引用输入集合，非有限或越界置信度降为 0/null/uncertain，关联/归并整体失效；写入前还会阻止 owner-only action、候选越界和未授权状态。初始分类与 reprocess 只有该安全 projection 才能进入 Runtime `result_json` 或 `state_json`，因此 crash recovery/replay 不会复用原始 provider 对象；proposer/candidate/thread 生成的 sender name 也走同一 ID/凭证 grammar。摘要、理由、证据和嵌套数组统一经过凭证、Feishu/Docx/Wiki token、裸 UUID、32–64 位 hex，以及受控 prefix + `_` + canonical UUID 的仓库内部 ID grammar 清洗，同时保留普通连字符业务文本。该 Issue 不负责 PROD-01/#45 的公共 DTO 最小化、主人核验 UI 或 TaskDrawer/CandidatesPage。

## 任务生命周期

- `planned_start_at` 和 `planned_due_at` 是系统主人的私人计划时间；旧 `schedule_at` 只作为历史数据兼容读取，不再承担唯一排期字段。
- 任务详情统一编辑标题、Describe、下一步、风险、等待原因、状态和私人计划时间。完成时间不得早于开始时间；AI 自动更新、主人编辑、修改计划、删除、恢复和撤销均使用任务版本检查，旧页面不能静默覆盖新修改。
- 任务详情把当前路由 `taskId`、加载 generation 和返回详情 ID 绑定为同一请求身份。路由变化时先清空旧详情与表单；迟到响应不得写回。所有 mutation 和桌面异步入口在发起前及返回后复核该身份，加载失败时不保留上一任务的操作能力。
- `deleted_at` 表示可恢复软删除。回收站任务从工作台、普通任务列表、日历和提醒中移除，但任务、来源、时间线、纠错和 `reference_binding` 继续保留。
- `candidate_request.deleted_at` 采用同样的可恢复软删除语义。未接受候选只处理自身；已接受候选与 `accepted_task_id` 指向的正式任务共享回收状态，删除或恢复必须在同一 SQLite 事务中同步写入双方，避免一边活动、一边已删除。回收站候选不能继续接受、暂存、忽略、纠错或重新整理；来源、审计和需求线程继续保留。
- `candidate_request.merged_into_candidate_id / merged_at` 只表达候选组的展示和整组操作关系；非主体候选和每条 `source_event` 仍独立存在。
- 多需求模式下，候选、线程和更新提案携带 `demand_unit_id`。归并、拆分和人工改挂只移动当前需求单元；共享来源在原线程仍被其他单元使用时必须保留。`requirement_thread_unit(demand_unit_id)` 使用唯一约束防止一个单元同时归属多条线程。
- `requirement_thread.primary_source_event_id / primary_reason / primary_confidence` 保存当前主体及依据；`requirement_thread_source.source_role / role_reason` 保存每条来源在需求中的角色。
- 候选归并、主人确认、明确否决、更换主体和拆分都在单个 SQLite 事务中完成，并向 `correction_event` 追加前后状态。低置信建议绑定双方候选、线程版本、候选快照和组成员；主人确认还携带当前页面线程版本，任一变化都会返回冲突。明确否决写入规范化候选对排除表，模型候选集和自动应用门双重跳过；拆分按候选的完整连续消息批次迁移并重算两边线程。整组接受只创建一个任务，并把线程内全部来源写入 `task_source_link`。
- 删除、候选撤销或任务无效化时，会在同一 SQLite 事务内把关联的 awaiting approval 标记为 rejected，并把关联 awaiting/ready outbox 标记为兼容终态 failed；来源、task_event、correction_event 和其他审计继续保留。恢复任务不会重新激活此前作废的草稿。
- 软删除不是隐私硬删除；聊天原文、派生摘要和个人数据的永久清除继续走独立隐私流程。完整裁决见 [ADR 0003](adr/0003-private-planning-and-task-trash.md)。

## 可靠性

Issue #39 的 OAuth 配置合同集中在 `integration-contracts.ts`、`feishu.ts` 和桌面 `config-store.ts`：scope 明确区分 omitted、`set([])` 与 `set(values)`，非法 envelope/token fail-closed；完整 OAuth snapshot 在一个 vault 锁内取得，刷新按 vault/逻辑身份使用进程内 singleflight 和跨进程 durable refresh lease，租约原子绑定 generation、refresh token 指纹、owner、owner 进程和 fencing token，provider 调用只允许在有效排他租约内发生，第二实例等待并复用赢家结果或 fail-closed，过期且 owner 已退出才可接管；provider 已开始但结果不确定时固定为 `recovery_required`，相同或无法证明变化的凭据不能重放，只有锁内持久化的新 generation 与不同 refresh fingerprint 才能由重新授权覆盖旧 marker 并取得新 lease。token 保存必须通过带 lease fence 的 config generation/CAS，不能回退到逐 key 写入，CAS 或租约丢失不得伪报成功。settings 与加密 secrets 由跨进程 lock-directory 保护的同一事务提交，journal 和 last-known-good 副本用于进程中断后的恢复；坏 journal/LKG、坏 generation、缺失 settings 或坏 secrets 均拒绝读取和更新，不把 defaults 与旧 secrets 混合；generation 变化会丢弃迟到身份响应，不覆盖 owner profile、scope、cursor 或来源状态。该本地机制只提供 L1-L3 合成证据，真实 OAuth scope 缩权与旋转 token provider 行为仍是 L5/L6 未运行项。

Issue #40 的 Feishu 错误分类和详情阻塞判断集中在 `feishu.ts`。只有真实 `Error` 或受控 `cause` 携带传输错误 allowlist 时才进入 transient 重试；普通响应对象即使带有 `ECONNRESET` 等非数字 code，也按非法业务响应 fail-closed 处理。Calendar 事件详情、Minutes 详情/AI artifacts/Transcript 的重试耗尽统一计入本轮 failure，不能降级成仅详情失败的 partial；permission/denied 等已授权业务结果仍可按原合同 partial。durable ingest 成功前不写入新的来源版本或同步状态，失败时保留旧 cursor、watermark、checkpoint 和 `last_success_at`。

本规则的当前合成证据为 `VER-ISSUE40-FSH02-L3-20260816`，仅覆盖 Mock/契约与内存 SQLite；不代表 Windows 安装 L5 或真实飞书租户/provider L6。

运行日志、连接健康与诊断导出共用版本化递归脱敏模块。`app_log` 和 `integration_health` 在写入 SQLite 前清理，日志/连接健康 API 与诊断导出在读取时再次清理，用于覆盖旧数据或旁路写入。当前 schema 版本为 `1`：字段白名单同时约束值类型，只有固定 schema key 输出受控规范名，其他动态 key 改用对象内唯一短编号，避免原 key 泄漏、别名覆盖和 prototype pollution；数组不继承父字段的 primitive 权限。数组、`Error`、URL 与 Proxy 通过受控 descriptor/intrinsic 分类，accessor、类型错配、未知结构和遍历异常只返回可 JSON 序列化的占位符。共享预算同时约束值节点与输出 key，普通对象 own-key 发现和原 key 扫描仍可能随输入规模增长；该能力只改变现有字段的安全表示，不扩大诊断采集范围。

对象术语、数据权威、状态机、CAS/恢复、错误结果和 ADR supersession 只维护在 `docs/domain-contracts.json`，Markdown 为完整生成视图。合同 checker 将 TypeScript 状态、Runtime job、fresh-schema SQLite CHECK、ADR 元数据和验证引用交叉检查；它只提供静态 L0/L1 证明，运行时门禁与迁移能力必须引用各自验证记录。

SQLite schema 升级由单一有序 declarative operation interpreter 执行，供服务端受控维护流程和合成测试使用。Electron 桌面不把该路径用于已有用户文件：它固定把 `data/ai-pm-v1.sqlite` 作为当前库，仅在该新路径不存在时初始化规范 schema；旧 `data/ai-pm.sqlite` 只做存在性检测，原样保留，不打开、不迁移、不重命名、不删除。发现旧文件时显示固定脱敏提示。新库仍受 integrity、外键、schema、账本、版本和降级门禁保护；若新库启动失败，Electron 会清理核心、显示固定脱敏错误并退出，避免只留下无窗口后台进程。详细决定见 ADR-0008；当前自动证据为合成 SQLite L2/L4，不能替代 Windows 安装升级 L5。

Issue #36 DATA-02 的 schema v2 关系层在 `task_source_link` 中保存精确 task↔demand_unit↔source 边，并以 `(demand_unit_id, source_event_id)` 组合外键拒绝“两个真实存在但不属于同一需求单元”的交叉错链。明确边允许同一 task/source 对应多个 demand unit；无法消歧的历史 nullable 边保持原行并进入 durable `data_integrity_gap`。需求单元删除/更新采用 `NO ACTION` fail-closed，task/source 原有 cascade 只删除对应来源边，不把明确需求单元静默降为 NULL。审计闭包采用有界单调 fixpoint，gap 查询使用结构化精确列。`/api/audit-chain` 的 filters、sources、demand_units、candidates、threads、tasks、source_demand_units、thread_units、thread_sources、task_source_links、ai_decisions、owner_decisions、task_events、corrections、integrity_gaps 每个集合都使用独立固定字段投影；只保留内部 ID/链接、受控枚举/状态、布尔/数值、hash、版本和时间，未知枚举映射为 `unknown`，不返回原文、provider/raw JSON、外部标识、record_id 或任何自由文本字段。

Issue #37 DATA-03 在 RUN-01 v3 之后使用连续 schema v4，为 `candidate_request` 增加 `version INTEGER NOT NULL DEFAULT 1`；旧候选精确回填 1，v4 迁移重启幂等，部分 schema、checksum、约束或中途故障在账本推进前 fail-closed 并恢复迁移前数据库。候选删除/恢复、接受/暂存/忽略、线程归属、归并确认/否决/换主体/拆分、来源重试、reprocess、纠错和内部 classifier/recovery 更新都使用 candidate version CAS；跨对象操作同时校验 thread/task version，归并组校验成员版本 hash。API 缺少或非法 expectedVersion 返回 400，过期返回 409 和显式安全 current DTO；事务中任一业务、审计、通知或关系写入失败逐值回滚。CandidatesPage 复用 `resource-state.ts`，按资源 generation/operation id 丢弃迟到 mutation、refresh 和页面切换回调，成功先落 canonical response，refresh 失败只重试读取，不重放 mutation。
Issue #34 PRIV-001 在 DATA-03 v4 之后使用连续 schema v5，新增隐私控制、留存、导出、删除请求、受管备份和私有审计表，并以连续 schema v6 增加跨进程 lifecycle claim/fencing、owner/capability/intent binding、版本 CAS、recovery 状态和 backup cleanup intent；v5 descriptor/checksum 与 v1-v4 identity 保持原样。停止采集与本地授权撤销后，主人可选受控导出并以二次确认/CAS 发起硬删除。硬删除按固定内容表清单清除 source/derived/task graph、索引、日志、缓存和 Outbox，只保留不含正文的删除 proof/hash/count/time 与必要审计；副作用前必须完成 durable claim，finalize/compensation 再验同一 token/version，旧 actor 不得覆盖新 actor。未知表、未知 schema、损坏或路径逃逸备份、CAS 冲突和中途异常均 fail-closed，不覆盖正在打开的数据库；backup manifest 已删而 sqlite 删除失败时仍保留可枚举、可验证、可恢复的 cleanup intent。恢复校验在线只返回受控 `requiresRestart`，真实替换需服务退出后的维护入口；真实 OAuth/平台备份/Windows L5-L6 仍未验证。

Issue #38 DATA-04 在 PRIV-001 v6 之后使用连续 schema v7：`source_event_revision` 是 append-only 来源修订账本，`source_event.current_revision_id` 只是受控 current pointer，edit/recall 不覆盖历史正文；canonical revision hash 绑定 owner scope、source_event_id 和全部持久化回放字段，source append、current pointer 与 decision reference 在同一 SQLite transaction 内以 revision-generation CAS/fencing 发布。AI decision/job 持久化含 revision hashes 的有序 revision 集及 revision/prompt/model-config hash；无法重建精确原始输入的 legacy decision 明确 unreplayable，禁止伪造 hashes。Replay route 只负责入口层 capability、固定 intent、`app://local` origin 和 CSRF 预检；服务层必须从 durable current capability 状态独立复核 token/CSRF hash、owner/decision/source scope、expiry、revoked/consumed/replay 状态，并以 CAS 原子消费，不能由 caller-supplied binding 或 route-only 校验绕过。逐 revision constant-time 校验 payload/reference hash、source identity、顺序和授权范围；缺失/伪造/过期/重放 capability、篡改、删除、重复/乱序引用、CAS/FK/迁移或隐私删除失败均 fail-closed 且不泄漏正文或产生业务写入。PRIV-001 的 export/retention/hard-delete/backup/restore 覆盖 revision 与 replay reference，删除后不得留下可重建正文副本。证据仅为 synthetic SQLite/Mock/local browser L2-L4，不证明真实 provider history 或外部平台删除。

同步 API 的最小可观测边界由服务层统一组装，不复制各 Runner 的业务逻辑。一次同步包含后端生成的 `operation_id` 和入口生成的 `request_id`，整体 outcome 只取 `success / partial_success / skipped / failure`；每个来源只返回固定枚举来源名、同样的四态、白名单计数、耗时、固定 `error_code` 和固定消息，聚合/单来源接口均不返回 Runner 原对象或主人身份。单来源先判断 Runner 入口是否存在：不存在才返回 `adapter_unavailable/skipped`；入口被调用后返回 `null/undefined` 仍进入唯一的 `normalizeSyncResult`，并固定为该真实来源的 `OBS_INVALID_SOURCE_RESULT/failure`。fulfilled 结果只读取普通对象的 own data descriptor；`skipped=false` 至少需要一个合法计数且不能携带 skip-only reason，`skipped=true` 要求所有计数为 0 且 reason 命中受控 `Map`。getter、Proxy/revoked Proxy、数组、primitive、空/未知对象、非有限/负数/小数计数、矛盾 shape 和原型键 reason 均 fail-closed，不会抹掉其他来源成功。聚合同步使用 `Promise.allSettled`，rejected 来源固定计为一个 failure，也不会回传 raw exception。设置页只消费 safe envelope，并明确显示四态。

`/api/health` 保留 liveness，同时新增 readiness：SQLite 缺表、关闭或任何受控查询异常统一为 `not_ready / DATABASE_UNAVAILABLE`，已启用来源授权/权限/部分/错误状态或失败 Runtime job 为 `degraded`，其余为 `ready`。诊断每次只计算一次 readiness 并复用；不可读时不继续采集数据库计数或错误行。release identity 只包含应用版本、格式校验后的可选 commit/build identity 和脱敏 schema 版本；Electron 以 `app.getVersion()` 注入版本，构建脚本从当前 Git `HEAD` 取得并校验 commit 后编译成只读常量，桌面运行时 `process.env.BUILD_IDENTITY` 不参与。普通 desktop build 在没有可信 Git 值时仍编译 `null`；CI 的根 `npm run check` 会在最新 desktop build 后运行独立 verifier，读取实际 `dist/main.cjs` 并确认 exact HEAD 已嵌入、placeholder 和运行时环境读取路径均不存在。

- 应用事件第一步写入耐久 `inbox`，再异步调用模型。
- 来源落库、线程关联、模型判断和记忆投影分别有可重试边界；模型或文件系统失败不会删除已保存来源，也不会把半成品写成正式任务。
- 分类失败会在来源自身的受控元数据中建立脱敏 `failure_inbox` 记录，并和原 Runtime job 的 source/revision 绑定；`failure_inbox` 是服务端保留的内部键，新建或增量来源的 normalized metadata 会统一过滤该键，增量 merge 保留数据库中已有的合法内部记录；既有畸形项按严格 schema fail-closed 丢弃，不进入 DTO。服务端还会用单一关系校验器核对记录派生 ID、所有来源存在且包含当前拥有者、Runtime job 类型、原始 payload revision/source set 和 `job_source_link`；关系失效的记录从列表中省略，直接重试/归档/忽略返回固定脱敏 404 且不写入 job、来源、候选或审计。来源当前 revision 变化不会使关系有效的旧记录消失，只会显示为 stale 并拒绝覆盖新版本。失败来源收件箱只展示来源类型、发生时间、阶段、固定 `error_code`、Runtime 状态和陈旧性，不展示聊天正文、外部 ID 或模型原始响应。主人重试使用同一 source/revision 和原 job 的 CAS 状态转换；重复点击只唤醒同一排队工作项，不创建第二个分类任务。成功、再次失败和归档都追加私有审计记录，任何状态都不触发对外动作。
- 飞书文档背景在来源落库后补充；文档读取失败不能回滚来源。Docx 元数据在正文读取前后复核 revision，来源与文档组成复合版本，模型提交结果前再次校验。
- 普通私聊不做空关键词或伪全量扫描。系统分页发现主人 OAuth 可见的既有 P2P，以对方 `open_id` 为长期标识并内部缓存 `chat_id`；新发现人员默认关闭，主人选择后才读取。主人自己发出的消息不会建立普通候选。
- 普通私聊和群聊 `@我` 先做来源级 OAuth scope 门禁。缺少必要 scope 时只更新 `admin_required/restricted` 健康状态，不调用会话、联系人或消息 API，也不推进目标游标；重新授权后从已有安全水位继续。刷新 Token 未返回 scope 时沿用此前已验证权限，新授权明确返回空 scope 时清空旧权限。
- Owner message、calendar、minutes 三类 runner 共享 durable scope 的解析、规范化和 required-scope policy。calendar 需要 `calendar:calendar:readonly`，minutes 需要四项 `minutes:*` 读取/导出权限；durable scope 缺失或格式不可信时，所有三类 runner 在 provider、游标、来源、候选等副作用之前 fail-closed，仅更新受控授权状态。该 gate 不读取 stale token/scope，也不把重复或大小写错误的 scope 当作授权。
- 群列表只用于发现可选择对象；`message.list` 只读取主人明确选择的群，非 `@主人` 消息不持久化。人员、群聊、日历和妙记均使用独立游标、重叠时间窗、外部 ID 去重和周期对账。
- 飞书 SDK 返回值必须先经过统一业务码守卫再读取 `data`：即使 HTTP 为 200，只要业务 `code` 非零或格式非法就按失败处理。已确认业务码采用集中映射，HTTP 状态只作补充，平台 `msg` 不参与稳定分类；非法或超长 code 归为 `UNKNOWN/business`。真实 `Error` 或受控 `cause` 只有携带明确传输错误 allowlist 时才归为 transient，普通响应对象的非数字 code 不得伪装成网络错误。单个逻辑用户 API 调用内，到期前预刷新与未授权恢复刷新共享一次预算，最多刷新一次。分页任一页或日历/妙记详情接口失败时保留旧游标/检查点；已返回页只保存来源事实，不提交不完整批次进行分类。运行诊断只记录受控业务码、错误类别和格式校验后的请求 ID。
- 新发现个人 P2P 和新群都默认不启用；“关注所有人”只作用于当前已发现人员，已有人工选择不会因刷新或重启改变。重新启用使用硬起点，不补收未关注期间消息。单一目标失败只记录该目标错误，不阻塞其他目标；切换系统主人后，旧主人目标不会继续运行。
- 机器人事件只作为实时补充，不能替代用户身份同步。
- LLM 连接检查必须验证目标 JSON，而不是只看 HTTP 200。DeepSeek V4 使用无 thinking 的结构化输出；空正文、仅推理正文和长度截断会重试，最终失败时保留来源和 Runtime 工作项，但不创建候选卡，也不把本地规则复制的原文当成模型摘要。
- 文档背景按 5 分钟到期刷新；临时失败保留成功缓存并明确标记 stale。单篇本地片段最多 8,000 字，最多 8 篇进入判断，文档正文合计最多 12,000 字，最终结构化模型输入最多 20,000 字。
- 文档变化可更新未接受候选；已接受任务只产生主人私人复核提醒，不自动修改任务、不新增 Outbox。
- 模型不可用、结构化输出失败、版本冲突、弱关联、时间待确认或自动维护暂停时，来源仍保留，提案降级为待处理，不盲目覆盖或丢弃。
- 人工纠正和撤销作为新的审计事实保存；后续判断可读取受控纠错信号，不能删除或改写原 AI 事件来掩盖错误。
- 对外动作入口在 M1 只形成本地 `approval/outbox` 草稿：API/UI 明确显示“草稿、待主人审阅、已拒绝、已失效”，DTO 只返回 allowlist 元数据，不返回 payload/provider/raw 内容；没有 approve/send mutation、provider consumer 或自动发送路径。相同 task version、action type 和 canonical payload 会幂等复用同一草稿；新版本/目标会终止旧草稿后新建。真实发送必须另开 Issue 并重新完成安全验收。
- 任务、机器人和后台可能同时更新时使用版本检查，避免静默覆盖。
- 私人计划、删除和恢复只改变本机台账，不向需求方发送消息，也不自动承诺时间。

## 工作区联动

- 系统任务目录可以保存 `task_id`、索引和 `reference path`。
- 关联的真实工作目录默认只读。
- 文件变化只能更新活动线索或候选产物，不自动修改任务完成状态。

## 仍待决定

前端、后端、SQLite 访问方式和 Electron 本地桥接已由 ADR 0001 与现有实现确定。试点部署、原文保留期限、隐私硬删除、回收站保留期限、多设备同步和真实租户权限仍记录在 `open_decisions.md`。
