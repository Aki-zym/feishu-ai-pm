# 飞书接入说明

## 当前实现

TooManyTasks 当前的飞书扫描路径由独立 `apps/server` 使用官方 `@larksuiteoapi/node-sdk@1.73.0` 调用 Aily OpenAPI。浏览器设置页保存 Aily 应用配置并发起飞书用户 OAuth；App Secret、access token 和 refresh token 进入本机 AES-256-GCM 凭证库，服务端在 Token 接近过期时自动刷新。Cindy 插件不接收这些凭证，只读取自动生成的本机集成令牌并调用 `/api/integrations/cindy/scan`。

Aily Prompt 只包含 `window_start`、`window_end`、Asia/Shanghai 时区和检索要求。服务端通过 `POST /open-apis/aily/v1/agents/{agent_id}/chats` 发起流式对话，逐事件解析 `start`、`message_delta` 和 `done`；只有 `Completed` 终态算成功。返回文本保存为最多一条 `source_kind=aily_summary` 的派生来源，来源键稳定为 `aily-summary:<window_id>`，同时保存窗口覆盖时间、Agent 标识和生成时间。该来源只代表 Aily 的摘要线索，不能冒充逐条飞书原文。

扫描规则固定为：先由本机服务持久化认领窗口，再由 Aily 成功返回有内容后启动 Cindy intake errand；Aily 返回 `NO_NEW_INFORMATION` 时以 `result_kind=empty_window` 提交空窗口并推进游标；Aily 调用失败、Token 失效、权限失败、超时、Cindy errand 失败或没有服务端成功回执时保持旧游标。服务端执行窗口指纹幂等、来源关系和 `update_task.expected_version` CAS。

以下旧的 OAuth、个人信息流、机器人事件和直接 Feishu adapter 章节属于历史实现/能力边界记录，不是 TooManyTasks 当前扫描链。

已接入的只读能力：

- 系统主人身份：OAuth 后通过 `authen.v1.userInfo.get` 保存 `open_id / union_id / user_id / tenant_key`，用于匹配 `@主人`。
- 个人信息源能力状态：分别记录普通私聊、`@我`、日历、妙记和机器人补充入口的授权范围、同步方式、最近成功和错误。
- 机器人私聊事件：通过 `EventDispatcher + WSClient` 接收 `im.message.receive_v1`。
- 机器人补充群：WebSocket 实时事件 + 可选周期补漏；群 ID 只属于机器人补充入口。空列表时拒绝所有群事件，不会扩大为全租户监听。
- 人员发现与选择：用户身份用最近 P2P 会话列表或联系人姓名搜索展示候选；主人确认后，本地只保存对方 `open_id` 和显示信息，不要求用户填写 `chat_id`。
- P2P 发现与普通私聊：使用主人用户身份分页读取 `types=p2p` 的既有会话，保存对方 `open_id` 并缓存 `chat_id`；缺少会话 ID 时再用 `chat_p2p/batch_query` 解析。新发现 P2P 默认不关注，主人逐个选择或点击“关注所有人”启用当前名单后，才把对方发来的消息送入主链；主人自己发送的消息不建候选。
- 群聊 `@主人`：用户身份列出主人所在群，主人按群名选择后再读取该群近期历史，本地按 mentions 匹配主人；非 `@主人` 消息不会创建来源。该用户身份主链不要求机器人在群内。
- 消息历史分页：每个人和群使用独立游标、重叠时间窗与 `source_event.external_id` 去重；一个目标失败不阻塞其他目标。未关注的个人不读取，重新启用不补未关注期间历史；新群仍默认不启用。
- 业务响应守卫：所有应用身份和用户身份读取都在消费 `data/items` 前检查飞书业务 `code`。HTTP 200 但业务码非零或格式非法仍是失败，不能解释为空列表或成功页。
- 统一 transport/business parser 只在真实 `Error` 或受控 `cause` 携带明确 allowlist（如 `ECONNRESET`、`ECONNREFUSED`、`ENOTFOUND`、`EAI_AGAIN`、`ETIMEDOUT`、`UND_ERR_CONNECT_TIMEOUT`、`AbortError` 或 `fetch failed`）时分类为 transient；普通响应对象的同名字符串 code 仍是非法 business。Calendar/Minutes 详情阶段的 transport 重试耗尽返回 `failure`，不降级为 partial，也不推进旧 cursor、watermark、checkpoint 或 `last_success_at`；permission/denied 仍按既有 partial 合同处理。该规则仅有 Mock/契约证据，索引为 `VER-ISSUE40-FSH02-L3-20260816`。
- 主日历与日程：使用 `calendar.v4.calendar.primary`、`calendar.v4.calendarEvent.list` 和 `calendar.v4.calendarEvent.get`，需要用户 OAuth；当前代码已实现首次分页、后续 `sync_token` 增量、失败保留旧游标、受控游标重建、详情/参与者补取和来源版本去重，并把 `is_all_day`、系列键、日历类型、主人角色/响应和纪要/明确消息关联标记写入受控元数据。运行时按 PROD-07 将普通提醒、仅出席、全天/重复、节假日、生日和订阅日历保留为 Calendar 来源事实；只有明确主人责任、动作和交付物/截止点才进入待确认候选，责任不明只提示主人确认；会议 action item 必须有纪要或明确消息依据。该切片仅有合成 SQLite/虚拟适配器证据，真实字段、权限和租户行为仍需目标租户验收。
- 会议纪要/妙记：使用用户 OAuth 的 `minutes.v1.minute.search`、`minute.get`、`minute.artifacts` 和限量 `minuteTranscript.get`；平时按创建时间重叠窗口分页扫描，每次运行会检查是否距上次全量对账已超过 24 小时，以 `minute_token` 幂等，并将详情、行动项和受限转写摘要的哈希作为来源版本。无权限、未完成或转写不可导出时保留受限来源，不把完整转写写入普通日志。
- 消息内飞书文档背景：Docx 使用 `docx.v1.document.get` 与 `docx.v1.document.rawContent`；Wiki 先使用 `wiki.v2.space.getNode` 解析真实对象，再仅在目标是 Docx 时读取正文。Sheet、Base、旧版 Doc、File 和 Slides 当前只记录链接类型与受限状态，不读取正文。

当前主人消息 Runner 已实现 P2P/群列表分页、姓名搜索、`open_id → chat_id` 解析、每目标首次水位、重叠时间窗、`message_id` 去重、Token 刷新、限流重试、失败不推进游标和目标级健康状态。没有选择人员或群时只登记发现结果，不读取正文；群内非 `@主人` 消息只在内存匹配后丢弃，不写数据库或普通日志。模型首次失败时，已落库来源会在下一次重叠扫描中重新判断。日历和妙记自动增量 Runner 均已接入统一同步周期。代码尚未代表真实租户验收：联系人搜索、P2P/群历史权限、实际可读范围、限流、撤回/删除、妙记转写导出和 Docx/Wiki 文档读取表现仍需在目标租户验证。

飞书同步结果必须在服务端统一归一为 `success / partial_success / skipped / failure`；来源级错误只允许固定错误码和脱敏说明，不能把 HTTP 200 业务错误当成空成功或推进游标。当前所有证据均为 Mock/契约测试，真实租户范围与供应商返回形态仍待 L6 验收。
分页任一页或详情接口返回业务错误时，本轮保持进入扫描前的游标/检查点。已经成功返回的页面可以只保存不可变来源事实，但不把不完整批次送入需求分类；下一轮仍从旧水位和重叠窗口重试。列表、消息、日历和妙记业务错误使用统一 `FEISHU_API_ERROR`，最近错误只显示受控的业务 `code`、分类和请求 ID，不保存飞书原始错误说明或响应正文。外部业务码只接受可规范化的安全整数；非法、超长或带空白的值以 `UNKNOWN/business` 记录，不能进入错误摘要。
分页任一页返回业务错误时，本轮保持进入扫描前的游标。已经成功返回的页面只保存受控的最新授权来源状态，不把不完整批次送入需求分类；下一轮仍从旧水位和重叠窗口重试。`source_event` 按 `external_id` 维护最新状态，编辑/撤回可原地更新，当前没有 append-only revision/history。列表和消息业务错误使用统一 `FEISHU_API_ERROR`，最近错误只显示受控的业务 `code`、分类和请求 ID，不保存飞书原始错误说明或响应正文。外部业务码只接受可规范化的安全整数；非法、超长或带空白的值以 `UNKNOWN/business` 记录，不能进入错误摘要。`source_event.external_id` 仅用于业务去重/关联，不默认进入诊断、API 同步结果或原值展示；身份类外部 ID（如 `user_id`、`tenant_id`、`message_id`、`calendar_id`、`open_id`、`union_id`、`chat_id`、`conversation_id`、`document_id`）默认禁止外泄。`provider_request_id` 仅在现有格式校验和脱敏规则允许的受控诊断场景展示，且不得携带 token、请求/响应正文或 URL。

稳定分类采用集中白名单：`99991400 → rate_limit`、`230027 → permission`、`99991663/99991664 → authorization`；HTTP 401/403/429/5xx 分别作为 authorization/permission/rate_limit/transient 的补充。真实 `Error` 或受控 `cause` 只有携带明确传输错误 allowlist（`ECONNRESET`、`ECONNREFUSED`、`ENOTFOUND`、`EAI_AGAIN`、`ETIMEDOUT`、`UND_ERR_CONNECT_TIMEOUT`、`AbortError`、`fetch failed`）时才归入 transient；普通响应对象的同名字符串 code 仍是非法业务错误。前两项有飞书官方接口/频控文档依据，后两项沿用仓库既有用户 Token 失效契约，真实租户语义仍未验证。未列出的合法数字 code 保持 `business`，不根据英文、中文或其他本地化 `msg` 猜测类别。权限和不可重试业务错误需主人处理配置后重试；限流和临时错误会保留为可重试错误，按后续同步周期或已有退避恢复。详情接口若返回 HTTP 200 非零或非法业务码，也按失败处理并保留旧游标，不降级成“受限详情已成功”。

Issue #15 增加单来源背景补扫接口：当已保存消息疑似缺少前文时，只在对应的已启用人员或群内读取消息之前最多 72 小时、3 页，并受人员重新启用硬起点限制。该读取不更新正常游标；分页截断、目标变化、权限不足或接口失败会返回背景不完整。补扫得到的主人发送消息会耐久保存为 `contextOnly` 背景；它不会生成普通候选，但正常同步拿到的主人消息会进入独立的主人意图分类链。

主人消息 Runner 会在每个来源开始前检查已授权 scope。普通私聊需要 `im:chat:read`、消息只读权限和 `im:message.p2p_msg:get_as_user`；群聊 `@我` 将最后一项替换为 `im:message.group_msg:get_as_user`。缺少 scope 时，程序把来源标记为 `admin_required`、目标标记为 `restricted`，安全结束本轮，不调用飞书会话/联系人/消息接口，不推进游标，也不把权限错误误写成网络失败。开放平台批准并发布权限后，重新 OAuth，再点击对应来源的“重新同步”。

日历与妙记 Runner 复用同一份 durable `granted_scopes_json` 解析器和 required-scope 表，不使用旧 Token、缓存或配置声明作授权回退。日历必须具备 `calendar:calendar:readonly`；妙记必须同时具备 `minutes:minutes.search:read`、`minutes:minutes.basic:read`、`minutes:minutes.artifacts:read` 和 `minutes:minutes.transcript:export`。缺失列、`null`、空值、非法 JSON/类型、非法 scope、大小写不符或权限不完整时统一 fail-closed：只记录脱敏的 `admin_required/scope_required` 状态，不调用 provider，不创建/读取/推进游标，不写来源、版本或候选；重新授权后从原有安全水位继续。重复 scope 只做规范化去重，不能代替缺失权限。

刷新 Token 若没有返回新的 scope 字段，会保留此前已验证的权限；新授权若明确返回空 scope，则清除旧 scope，避免把旧授权范围误用到新 Token。单个逻辑用户 API 调用只允许一次刷新：到期前预刷新和 API 未授权后的恢复刷新共享同一预算；预刷新已发生后若 API 仍返回未授权，则直接返回该授权错误，不再请求或刷新；预刷新失败时不调用业务 API，并保留旧令牌。此前由空 `query` 触发的消息搜索 HTTP 400 已移除，当前主链不再使用空关键词搜索。

所有 Runner 的来源回调都会先写入 SQLite `source_event`，再交给受控 `PmRuntime`。Runtime 以来源和分类 revision 做幂等，记录 lease、attempt、指数退避、checkpoint 和失败状态；因此进程重启或模型暂时失败不会丢掉已保存的来源当前记录，也不会重复建立多条候选。`source_event` 以 `external_id` 维护最新授权状态，编辑/撤回可能原地更新，当前没有 append-only 历史。周期重叠扫描不会绕过退避，只有明确的人工重试调用才会提前唤醒失败判断。

模型无效 JSON、字段结构错误或非法 `units` 会进入有限修复/重试；`units: []` 明确表示无需拆分。最终仍失败时只保存来源、脱敏校验路径和可恢复 Runtime 工作项，不写入“非需求”或 `0%` 占位候选。批量判断可返回最多 8 个需求单元，每个单元用匿名来源键声明证据；服务端再映射到本地 `demand_unit_id`，并分别关联 `requirement_thread_id` 与已有 `task_id`。模型输入不包含这些真实 ID、会话 ID 或本地路径。

消息后续补充会保存到 `requirement_thread_source`，并按 `root_id`、`parent_id`、会话和参与人建立线程修订。需求方消息按原有安全门生成带版本和证据的 `task_update_proposal`；主人消息另生成 `owner_decision`，在高置信、唯一目标和版本一致时可直接维护私人任务状态、计划、等待原因与时间线，仍不会向外发消息。只有 `new_demand` 才增加候选，`update_existing` / `context_only` 会回到已有需求线程；无法唯一关联时进入待确认。两条路径都刷新 SQLite 真源和可重建任务记忆投影；任务目录不会改变真实工作目录。

设置页先显示连接总览，再展示“选择要关注的个人和群聊”：现有 P2P 会自动发现但默认不关注，主人可逐个选择或点击“关注所有人”立即启用当前名单；以后新发现的人仍保持关闭。姓名搜索只辅助确认身份，不因搜索本身开始读取。群聊可按群名过滤并明确选择。页面不展示真实 `open_id/chat_id`。下方紧凑列表继续展示普通私聊、`@我`、日历、妙记和机器人补充入口的状态、权限范围、最近成功和最近错误；五类来源都保留独立同步。机器人补充群 ID、补漏开关和运行控制位于按需高级设置，与主人选择的群完全分开。

外发消息在 M1 仅形成待确认的本地 `approval/outbox` 草稿和审计；当前没有发送执行路径。未来若接入发送适配器，必须另行定义主人确认门禁和对外范围；不能把 `ready/sent` schema 状态描述为当前可发送能力。

如果一条候选已经被接受为正式任务，主人后来确认它并不是需求，可以在任务详情中选择“这不是需求”。系统会把任务标记为无效并归档，但保留原始聊天、来源链、版本和纠错审计；不会删除文件，也不会发送任何外部消息。

## 重要权限边界

程序支持“自动发现主人 OAuth 可见的既有 P2P，由主人选择后接收新消息”，不等于监控飞书中的全部私聊：

1. 主人完成 OAuth 后，程序分页读取开放平台实际返回的 `types=p2p` 会话。
2. 程序以对方 `open_id` 为本地标识，缓存或解析既有 P2P `chat_id`；新会话默认不关注，主人可逐个选择或一键启用当前列表。
3. 程序只周期读取已关注会话，并把对方发送的新消息送入候选判断；重新启用人员不补收未关注期间历史。
4. 没有既有 P2P、未被主人关注、权限不足、已经撤权或 API 未返回的会话不会读取，也不会显示成“已同步”。

普通人际私聊没有主人级实时消息事件，因此这条链采用周期轮询。`search:message` 的空关键词、Chrome 插件、本地飞书数据库和 CLI 常驻进程都不是替代方案。平台或租户无法读取时，继续使用机器人私聊、转发和人工补录。真实租户是否能列出目标 P2P、读取历史和稳定轮询仍需单独验收。

## OAuth 流程

1. 在设置中填写 App ID、App Secret、回调地址和权限范围。
2. 打开“允许真实飞书连接”。
3. 点击“保存并开始授权”时，程序会先保存并加载当前飞书配置，再打开最新授权页。未启用或 App ID/App Secret 未填写时，程序会留在本页说明缺少项，不会向 Windows 打开伪协议链接。
4. 本地回调校验一次性 `state`，使用官方 SDK 的 OAuth v3 Token 入口和 App Secret 换取 user access token 与 refresh token。当前不发送 PKCE `code_challenge/code_verifier`：飞书官方将 PKCE 定义为可选参数，桌面主进程已经承担服务端凭证交换；此前两端 PKCE 状态被平台判定不一致并返回 `20049`。每次新授权会废弃旧 state，state 只可使用一次且 10 分钟后失效。
5. 授权地址会强制包含 `offline_access`；若飞书没有返回 refresh token，程序不会把授权误报为可长期后台同步。
6. 令牌通过 Windows 安全凭证存储加密保存；refresh token 轮换时原子替换。

Scope 响应采用三态合同：provider 省略 `scope` 时保留已验证的本地权限；明确返回空字符串时保存 `set([])` 并清空本地授权门禁；非空值规范化、去重后替换旧值。显式 `null`、非字符串数组元素、非法 token 或非法三态 envelope 统一返回固定 `FEISHU_SCOPE_INVALID` 并拒绝继续授权。Token vault 必须同时提供完整 `readSnapshot`（generation、access/refresh、expiry、scope 在同一锁内读取）与 `setManyAtomic`，缺少 CAS 能力时不再退回逐 key 写入。同一 vault/逻辑身份的 refresh 使用进程内 singleflight 加跨进程 durable refresh lease：provider 调用前先取得排他租约，租约原子绑定 generation、refresh token 指纹、owner、owner PID 与 fencing token，并在请求期间有界续租；第二实例等待并复用赢家结果或 fail-closed，不会再次调用 provider；过期租约仅在 owner 进程已退出时接管；provider 已开始但结果不确定时固定为 `recovery_required`，相同或无法证明变化的凭据不能重放，只有锁内持久化的新 generation 与不同 refresh fingerprint 才能由重新授权覆盖旧 marker 并取得新 lease；带 lease fence 的 CAS 拒绝旧 owner 写入。桌面 settings 与加密 secrets 通过跨进程 lock-directory、单调 `config-generation`、CAS、journal 和 last-known-good 副本串行提交；坏 journal/LKG、坏 generation、缺失 settings 或坏 secrets 均拒绝读取和更新，不会用 defaults 与旧 secrets 混读；generation 变化时迟到 owner 身份响应也不会写入 owner profile、scope 或同步状态。该机制只证明本地合成合同，不证明真实租户的 scope 缩权或 OAuth 轮换顺序（L5/L6）。

授权失败时，服务端只把脱敏诊断写入本地日志和回调响应：阶段（换 Token / 刷新 Token / 读取主人身份）、飞书官方业务 `code`、HTTP 状态、错误类别和限长官方说明。授权码、state、access token、refresh token、App Secret、请求正文均不会写入日志或页面。换 Token 成功后，主人身份读取失败会单独返回“令牌已保存”，不会把已成功授权误报成完全失败。

如果 OAuth scope 配置为空，授权地址仍会强制加入 `offline_access` 以支持长期同步，但不会凭空获得联系人搜索、P2P/群消息、日历或妙记权限；实际 scope 必须以目标租户开放平台已申请并批准的列表为准。推荐 scope 包含 `contact:user:search`、`im:chat:read`、`im:message:readonly`、`im:message.p2p_msg:get_as_user` 和 `im:message.group_msg:get_as_user`；不再请求用于空关键词方案的 `search:message`。

权限指南同时提供两段不同用途的文本：开放平台“批量权限 JSON”用于申请权限，其中 `user` 是主人个人信息流、`tenant` 只用于可选机器人；OAuth scope 是授权 URL 请求的空格分隔 user scope。两者不能互换。程序会显示申请 scope 与当前 Token 已返回 scope 的差异，但不能代替管理员批准、发布版本和重新授权。

当前默认回调地址是：

```text
http://127.0.0.1:4311/oauth/feishu/callback
```

## 监听与扫描

- 已保存真实飞书配置时，Windows 桌面程序启动后会自动启动个人信息流和机器人补充入口；首次 OAuth 成功后会立即刷新主人身份并触发一次统一同步，不要求用户把“启动监听”当作日常入口。
- 重复启动调用是幂等的；设置重载会先停止旧 Runner，完全退出会等待定时器和飞书长连接停止后再关闭本地数据库。
- 普通私聊不做关键词搜索。每轮只读取本地已启用人员：优先使用缓存的 P2P `chat_id`，失效时再用对方 `open_id` 解析；主人自己发送的消息不建候选。
- 人员和群列表周期刷新负责发现范围：新 P2P 默认关闭；主人逐个选择或点击“关注所有人”启用当前列表，新群仍只登记并在明确选择后读取正文。已关注私聊超过 50 个时，每轮采用“近期 40 + 最久未扫 10”，并将来源状态显示为部分扫描。
- 群聊 `@主人` 只对主人明确选择的群读取近期历史，再本地匹配 mentions；该用户身份路径不要求机器人在群内。
- WebSocket 只处理机器人可见的事件订阅，不承担主人个人私聊或任意群的全量监控。
- WebSocket 事件先在本地 SQLite `source_event` 中完成耐久写入，并返回 `DurableEventReceipt` 后，SDK 回调才允许返回确认；事务失败、无效回执、来源/主人 scope 不匹配或未授权群消息均拒绝确认，让平台重投。相同 `external_id` 的重复与并发投递按 `owner_scope + sourceScope + source_type + conversation_id` 来源身份幂等处理；跨身份碰撞 fail-closed 且不修改已有行或 metadata，兼容重复也不覆盖不可变渠道 provenance。提交后分类失败只进入 Runtime 恢复，不影响已保存原始来源。
- 进程可能在来源提交后、Runtime 工作项创建前退出；重启恢复只扫描明确标记 `sourceScope=bot_supplement`、`ownerScope=primary` 且没有未完成分类工作的来源，按发生时间和 external ID 有界重放。轮询历史消息不带这些 WebSocket 标记，避免被错误纳入 orphan recovery。
- 机器人补充群与主人 `@我` 选择范围完全分离：补充入口使用 `FEISHU_GROUP_IDS`，主人来源使用数据库中的群选择，并只保存真实 `@主人` 命中。
- 扫描使用重叠时间窗，消息仍以 `message_id` 去重。
- 疑似补充消息的背景补扫与正常扫描分离：不推进游标，不突破人员硬起点，最多 72 小时和 3 页；不完整状态进入候选提示。
- 扫描失败、限流、权限不足和游标异常会进入集成健康日志。
- 若健康状态显示 `FEISHU_API_ERROR`，先按受控 `category` 判断是权限、限流、临时服务还是其他/未知业务错误；保留格式校验后的请求 ID 供管理员定位。修复权限或等待退避后重新同步，程序会从旧游标重试，不需要人工修改水位。当前只读取响应体中的 request ID 字段，尚未验证或声明覆盖真实 `x-tt-logid`/header。
- 文件变化、日历变化和消息内容都只是来源线索，不能自动把任务改成完成。

## 工作目录授权

- 本地绝对路径必须由桌面原生目录选择器加入白名单。
- 服务端只读扫描会拒绝白名单之外的目录；只保存条目元数据，不复制或修改文件。
- 撤销白名单后，已有 reference path 仍作为历史引用保留，但后续检查会返回未授权。

## 妙记转写返回方式

妙记文字导出接口返回的是 SDK 可读流。服务端只读取受限大小的文本摘要并返回给本地页面，不把 SDK 流对象直接序列化，也不把完整会议原文写入普通运行日志。

## 文档背景与版本处理

- 来源消息先写入 `source_event`，随后再解析飞书文档链接；文档接口失败不会丢失来源或阻断候选。
- 升级前已经保存、但尚未生成 `source_context` 的历史消息会被受限回填：只选择确实包含 Docx/Wiki 链接且没有背景记录的来源，并与到期刷新交错处理，每轮合计最多 50 条；普通消息和其他文档类型不会进入该回填扫描。
- Docx/Wiki→Docx 成功读取后，本地只保存最多 8,000 字的背景片段、内容哈希、文档版本、完整性、freshness 和最近成功时间。
- 临时网络/服务错误且已有缓存时保留上次成功内容并标记 `stale`；明确无权限、删除或链接失效时不继续使用旧正文。
- 来源正文与文档背景组成复合 revision。读取前后 revision 不一致时重试，模型写入前再次检查，防止旧文档或旧判断覆盖新版本。
- 文档变化可重新整理仍待确认的候选。候选已经接受为正式任务时，只生成给系统主人的私人复核提醒，不自动改任务，也不创建 Outbox。
- 模型自报的“来源事实”必须能在实际发送给模型的消息文本中逐字回查；“文档内容”必须能在实际发送的可读文档片段中回查。无法回查的概括或推测统一降为“AI 整理·待确认”，不会冒充事实标签。

## 关于飞书 CLI

本地调研中的飞书 CLI 实际二进制命令名是 `lark-cli`。它适合人工调用和调试，不作为 EXE 的长期后台监听器。长期监听由官方开放平台事件订阅、SDK 长连接和周期扫描承担。

## 尚未真实验收的事项

2026-08-11 已在本机完成基础 OAuth、Token 加密保存和系统主人身份读取的真实连接验收。以下能力仍受目标租户权限、管理员批准和实际数据范围影响，尚不能标为真实验收完成：

- 应用权限和可用范围是否覆盖目标租户。
- 联系人姓名搜索和最近 P2P 列表在目标账号中的实际范围、同名辅助信息与分页。
- 自动发现 P2P 的真实覆盖与返回顺序、`open_id → P2P chat_id` 解析、历史消息、发送者区分、撤回/删除、限流和大联系人列表的轮转延迟。
- 已选择群在主人用户身份和批准权限下能否读取历史及 mentions；该主链不要求机器人入群。
- 用户 OAuth 是否能读取消息内 Docx、Wiki→Docx，及文档 revision、撤权和临时错误在目标租户中的真实表现。
- 事件订阅配置、长连接稳定性和断线重连。
- 飞书租户的限流、审计和数据留存要求。

安装、首次连接、权限配置、常见错误和无凭证验收步骤见 [Windows 安装与首次连接指南](user-guide.md)。
