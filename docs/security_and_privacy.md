# 安全与隐私

PRIV-001 v6 的 active claim 会阻止冲突主人状态推进；lease 过期只能经完整 identity/token/version/timestamp CAS reclaim，畸形时间戳和时钟回拨 fail-closed，provider call 前还要通过最终 heartbeat/token/status/version fence。

> 2026-08-17 PRIV-001 schema-v6 amendment：v5 schema/descriptor/checksum 不改写。跨进程 stop/start/revoke/hard-delete 统一使用持久 operation claim/fencing token 与版本 CAS；backup cleanup intent 在破坏性删除前记录受管 artifact identity/path/hash，partial finalize 可枚举、验证并恢复。证据仅 synthetic/local，不代表真实 Feishu/provider 或 Windows L5/L6。

## 测试证据边界

CI 只消费完整 changed-path diff，并按 [测试选层与证据门禁](test-selection.md) fail-closed 选择最低验证层级。控制 CI 选层和证据校验的 protected control-plane 路径由代码内置，不能通过修改 `verification-matrix.json` 自身降级为 docs-only；其 schema、受控证据名称、exact parents/tree/source 和 record↔provenance 交叉绑定均需机器校验。unknown、mixed、绝对路径和父目录逃逸不能被标成 docs-only；窄的 synthetic/Mock/replay 结果不能授权 broad L5/L6。证据记录必须绑定 source 与 exact provenance，明确区分 capability/platform 限制和 `not_executed`；后者不能写成通过。Artifact SHA-256 只证明产物身份，不代表安装运行或真实用户数据处理。测试夹具仍不得读取真实 `%APPDATA%`、真实用户数据库、聊天原文、token、真实 Feishu/LLM/provider 或生产数据。exact merge-ref 的本地 checker 只验证 Git 对象；可选 GitHub 远端 verifier 必须实际确认 run/job 为 pull_request + completed/success、head SHA、merge-ref 和 `[base,head]` parents/tree。私有仓库远端核验只在显式 token 或 `GITHUB_TOKEN`/`GH_TOKEN` 存在时发送 Bearer header，token 不落盘、不回显；apiBase 只允许受控的 https://api.github.com 根地址，重定向或 foreign host 直接不可用；无 token 的公共仓库仍可请求，401/403/404、网络或权限不可用时结果固定为 `unavailable`，不能伪装为通过。

## 必须遵守

- Issue #66 的隐私、发布和真实试点边界以 [DEC-01 决策登记](decision-register.md) 为准：停止采集/撤权→可选导出→二次确认硬删除；仅保留不含内容的删除证明和必要审计。没有四态、脱敏 identity 完整诊断和真实环境安全验收，不得扩大真实账号试点；Mock/L2/L4 不得冒充 L5/L6。

- 真实 App Secret、用户令牌和模型密钥只放在安全配置系统或本地 `.env`，不能进入 Git。
- M1 与首轮试点固定 draft-only；任何对外动作仍需系统主人明确触发。`main` 与 `integration` 只通过 Pull Request 合入，安全改动必须独立复核并由项目负责人最终批准。
- OUT-01 的 approval/outbox 只保存本地草稿和审计元数据：payload、provider/raw 内容不进入公开 DTO；任务删除、候选撤销或任务无效化与草稿终止在同一 SQLite 事务内完成，失败整体回滚，重复调用安全无副作用。`ready/sent` 仅是旧 schema 兼容值，M1 不注册发送 mutation、consumer 或 provider adapter；真实发送必须另开 Issue 并重新完成主人确认、隐私和真实环境安全验收。
- 开发模拟消息路由不得注册到正式服务端或 Electron App，也不得写入正式数据目录；只有自动测试创建 App 时可以显式开启。人工补录必须使用受控的正式纠错接口，不能依赖开发路由。
- 原始聊天属于敏感数据，默认只允许系统主人和明确授权的后台服务访问。
- 候选收件箱和任务详情遵循最小展示：页面只显示 AI 摘要、字段依据、来源类型和审计元数据，不直接渲染聊天正文；原文仍作为受控本地来源事实保存。
- PROD-01 默认响应使用严格 allowlist 的公开 DTO：候选列表与操作回执、任务列表/详情/工作台/日历/提醒、候选重新整理、纠错读写回执和主人信息均不返回来源正文、来源稳定 ID、sender/外部 ID、provider/model/prompt、文档 URL/ID、参考路径、纠错 before/after/note 或 Runtime 原始错误；候选中的时间只返回规范化区间，不返回模型原始时间短语。任务修改与自动维护回执必须返回完整严格 TaskDetail，ISO 排期、状态和风险按结构化 schema 校验，不能按来源正文 token 清洗。安全派生摘要保留共享业务词、短标题和常用短语，只对达到长度门槛的整段/近整段复制、NFKC/跨空白复现和结构化凭证/URL/路径/外部 ID 做 fail-closed 处理，不以任意五字符重叠抹掉正常摘要。主人核验必须提交固定 `{ confirmed: true }`，并使用 task-scoped opaque `source_scope`；当前实现只核验本地保存快照，返回 `local_snapshot_verified` / `local_snapshot_unavailable`、受控 `provider_status` 与快照捕获时间，写入 `source.verification.completed` 私有审计，且 `external_action` 固定为 `none`，不得声称当前 provider 权限或撤回状态。
- 机器人身份与系统主人的用户身份必须隔离保存和使用。
- 主人自动动作必须由服务端把消息 sender ID 与已授权 `owner_profile` 的 `open_id / union_id / user_id` 匹配；来源 metadata、显示名、`senderRole`、`isOwnerMessage` 或模型自称“主人”都不能单独构成授权。
- 不得用空关键词搜索、浏览器插件、本地客户端数据库或其他方式绕过飞书权限抓取普通私聊。个人单聊只允许在主人 OAuth 实际返回且主人明确关注的既有 P2P 范围内周期读取。群历史只允许读取主人明确选择的群，非 `@主人` 消息不持久化正文。
- 人员以对方 `open_id` 为本地标识，P2P `chat_id` 只作内部缓存；页面、普通日志和 GitHub 产物不得暴露真实用户 ID、群 ID 或会话 ID。
- 新发现个人 P2P 和新群都默认关闭；“关注所有人”只启用当前已发现的人员，不能自动覆盖以后新出现的人。每个目标独立保存读取状态和游标，任何失败不得扩大读取范围。重新启用人员不得补收未关注期间消息。
- 来源级 scope 门禁必须先于飞书 API 调用：缺少普通私聊或群聊所需用户权限时，只写入脱敏健康状态并跳过本轮，不请求会话、联系人或消息正文，也不推进游标；Token 刷新未返回 scope 时保留旧的已验证范围，明确空 scope 的新授权才清空范围。
- 日历与妙记使用同一 canonical durable-scope parser/gate：日历要求 `calendar:calendar:readonly`，妙记要求 `minutes:minutes.search:read`、`minutes:minutes.basic:read`、`minutes:minutes.artifacts:read`、`minutes:minutes.transcript:export`。`granted_scopes_json` 缺失、`null`、空/非法 JSON、非法类型或 scope、大小写不符及权限不足均 fail-closed；门禁先于 provider、游标和业务写入，只允许受控 `admin_required/scope_required` 状态，禁止 stale token/scope fallback 或泄漏受保护来源正文。
- 发送给模型的内容应最小化，并记录使用的模型、提示词版本和来源范围。模型失败后的规则判断只能用于安全分流，不能把消息原文冒充为 AI 摘要写入前端字段。
- SEC-02 截断边界补充：安全投影在 maxChars 前使用有限 lookahead；当敏感值跨越扫描边界而只留下可识别前缀时，由 Unicode property boundary tail guard fail-closed，再执行最终截断。直接覆盖 Feishu/Docx-Wiki/credential/URL/email/path/UUID/hex/private-key canary；普通业务连字符文本仍保留。
- SEC-02 `retry_waiting` 控制面合同：已有候选遇到非法 `units[*].draft.confidence`、未知 shape 或其他 post-adapter boundary rejection 时，只允许更新该候选的 `processing_state`、`processing_job_id`、固定限长脱敏 `processing_error`、`updated_at` 和 CAS `version`；候选业务字段、`candidate_revision`、`source_demand_unit*`、需求线程/线程修订、任务/任务事件、`task_update_proposal`、`owner_decision`、approval/outbox、notification、reminder、reference binding 和 correction 业务记录必须逐值不变。Runtime job/checkpoint/tool-call、`source_event.metadata.failure_inbox`、`ai_decision_log` 与私有 source-failure audit 只允许固定状态、内部 ID、枚举、次数、哈希和脱敏原因，禁止 provider/raw content/system/control/Authorization/Bearer/secret；该状态不得写入 `source_event.metadata.classificationRevision`，不得创建候选修订、需求域关联或任何外部动作。该合同由 SEC-02 retry fixture 直接断言，不能仅由文档放宽。
- 发送给模型的当前发言角色只能由服务端核对稳定主人 ID 后生成脱敏 `current_sender_role`；不得发送真实用户 ID，也不得信任调用方传入的显示名或布尔标记。DeepSeek 分阶段输出中的时间文字必须能回查到当前分类来源，否则按未知处理，不能进入计划或重要日期。
- 分阶段分类允许关联、归并、补丁或主人意图单独失败并关闭该项，但不得因此放宽自动维护门禁；动作路由或新需求摘要失败时仍保留来源并进入 Runtime 恢复，不生成聊天原文假摘要。
- 消息内 Docx/Wiki→Docx 背景只允许在系统主人现有 OAuth 权限内读取；不得绕过文档权限，也不得把“链接可见”当成“正文可读”。
- 本地 `source_context` 最多保存单篇 8,000 字的文档背景片段、哈希、版本和读取状态。Sheet、Base、旧版 Doc、File、Slides 当前只保存链接类型与受限状态，不读取正文。
- 发送给模型时最多使用 8 篇文档，单篇最多 8,000 字、文档正文合计最多 12,000 字、最终结构化输入最多 20,000 字；stale 内容必须明确标成可能过期。
- 日志不得记录完整令牌、完整私聊正文或可直接访问文件的本地绝对路径。
- 运行日志、连接健康、错误摘要和诊断包统一使用版本化递归脱敏。`redactionSchemaVersion: 1` 的白名单同时约束字段和值类型；只有固定 schema key 输出受控规范名，凭证、正文、路径、外部 ID 和未知动态 key 使用当前对象内唯一的短编号，禁止输出原 key 或可逆摘要。别名碰撞不能覆盖已有字段，`__proto__`、`constructor` 和 `prototype` 不能形成输出属性或 prototype pollution。数组元素不继承父字段的标量权限，未知字段、类型错配、accessor、异常 descriptor、Proxy/revoked Proxy 和不支持对象一律 fail-closed。数组只读取 own index data descriptor，`Error` 只读取受限继承链上的 data descriptor，URL 只使用受控 intrinsic；不会执行 getter、实例 `slice` 或 `Symbol.species`，且只有确认的 `http/https/file` URL 输出占位符。Authorization/Bearer、Cookie/Set-Cookie、query、`file://`、Windows/POSIX/UNC 绝对路径、常见凭证键、正文/prompt/response、身份类外部 ID 默认替换为占位符，任何异常都不能回退原值。领域库仅在固定 allowlist 保存 `source_event.external_id`（业务去重/关联）和 `ai_decision_log.provider_request_id`（受控 provider 请求诊断关联）；前者不得默认进入诊断、API 同步结果或原值展示，后者仅在现有格式校验与脱敏规则允许的受控诊断场景展示，且不得携带 token、请求/响应正文或 URL。单次调用共享节点预算，动态 key 为固定前缀加有界编号，固定 key 长度由 schema 约束，因此最终输出同时限制 key 数量与长度；普通对象 own-key 发现和原 key 扫描仍可能随输入规模增长，不能据此声称完整运行时成本有界。日志落库前和 UI/诊断读取时都要执行，且不得以脱敏为由扩大诊断采集范围。
- PRIV-001 已提供主人可见的停止采集、撤销本地授权、受控导出和二次确认硬删除入口。撤权不等于删除；硬删除只能由主人显式触发，使用删除请求的幂等键、确认凭证和 `privacy_control.version` CAS。所有主人敏感路由都必须先通过 owner-bound desktop capability、固定 privacy intent、CSRF token 与 `app://local` origin gate；未授权、错意图、过期或不可信来源在服务层之前拒绝，不返回导出正文、不改变状态、不创建备份。

- DATA-04（连续 schema v7）的 `source_event_revision` 是不可变来源修订账本：ingest/edit/recall 追加 revision，`source_event` 只保留受控 current pointer；canonical revision hash 绑定 owner scope、source_event_id、payload/action/version 等全部持久化回放字段，迁移 backfill 从真实 persisted payload 计算，不使用零占位。source append、current pointer、AI decision reference 和依赖写入在同一 transaction 内受 revision-generation CAS/fencing 保护；revision_set_hash 绑定 ordered revision hashes。legacy decision 缺少 exact prompt/model/config/revision inputs 时只保留明确 unreplayable 状态，禁止补造 hash。Replay route 的 capability、固定 intent、`app://local` origin、CSRF 预检不能替代服务层授权：服务必须从 durable current capability store 独立校验 token/CSRF hash、owner/decision/source scope、expiry、revoked/consumed 状态，并以 CAS 原子消费；缺失 binding、caller-forged hash、错 owner/intent/origin/CSRF、缺引用、内容/source_event_id/hash 篡改、重复/乱序、foreign owner 或 legacy 状态均 fail-closed，不读取后来 current source、泄漏正文或产生业务写入。导出、留存、硬删除、备份/恢复覆盖 revision 与 replay reference；删除后只保留无内容 proof/audit。当前仅有 synthetic SQLite/Mock/local browser L2-L4 证据，真实 Feishu edit/recall、LLM、生产数据、Windows L5/L6 仍未验证。
- Cindy trusted-source schema v9 的 `source_receipt` 只证明来源经当前已认证的 Cindy 本机插件入口落库，不证明主机级 MCP provenance。Bearer 只负责 HTTP 鉴权；插件首次启动时分别生成并持久化稳定连接账号锚点和至少 32 字节的独立 receipt 密钥，服务端不使用 Bearer hash 作为账号身份，也不使用 Bearer 本身签发 receipt。Bearer 轮换后旧 receipt、来源身份和幂等记录继续有效；不同账号锚点仍 fail-closed。body 自报 owner/account 字段由 strict schema 拒绝。receipt 至少使用 32 字节服务端随机 nonce，经 keyed derivation 形成不可预测 base64url 句柄；SQLite 只保存 nonce 与 receipt SHA-256 摘要，不把 receipt、稳定 message ID、外部 ID 或内部来源 ID 放进普通 DTO、普通日志或主人日常页面。未知、跨账号、旧 revision、superseded、revoked、invalid 或 legacy receipt 均 fail-closed。保存请求、来源 revision、关系图和决定分别在 SQLite 事务中原子处理；保存成功后的 Agent 中断不会回滚来源，决定失败不会删除已保存来源。生产服务与插件内嵌 Runtime 均不注册 raw-source intake/seed 路由；测试 seed 仅允许 `NODE_ENV=test` + SQLite `:memory:`，并完整经过 sources→decisions 合同。
- schema v10 不持久化原始 sender/chat/thread 技术 ID；服务端按 owner/account 域分离生成内部引用。display name 仅作为“MCP 回显后安全清洗的显示名”，不是法定身份认证；非字符串、对象、数组、空值、控制/Bidi 污染一律安全清洗或回退“需求方”。只有主人私有候选/任务来源投影可显示该名称；公共来源 DTO、普通日志和诊断继续不含姓名、技术 ID、receipt 或正文。关系跨 account、chat、thread、owner 或失效 revision 时整批回滚。无 thread/reply 的批次还必须含明确主人事实并限制为 20 条/60 分钟；thread/reply 限 100 条/4 小时。

### PRIV-001 对象生命周期矩阵

|对象类别|权威源|留存与导出|停止采集/撤权|硬删除|备份与恢复|
|---|---|---|---|---|---|
|来源事实：`source_event`、`source_context`、`source_demand_unit` 及关系|受授权来源与 SQLite 当前事实行|按 source 留存策略；主人可选 `sources`/`all` 导出|停止受管同步；撤权清理本地游标、scope 与令牌|硬删除时清除正文、片段、需求单元和来源关系；分类/纠错不能单独擦除来源事实|受管 SQLite 备份包含这些行；恢复只接受同实例、校验通过的备份并需服务退出维护替换|
|派生 PM 图：候选、线程、任务、关系、修订、通知、Outbox|SQLite 领域表与审计关系|按 derived 留存策略；主人可选 `tasks`/`all` 导出|不再产生新的采集/派生写入；撤权不等于删除|事务内清除候选/线程/任务、引用、缓存、通知、草稿与派生审计载荷|与主库同备份；损坏、身份不匹配或侧车文件拒绝恢复|
|运行与诊断：job、checkpoint、tool call、provider_retry_cooldown、日志、健康、游标|SQLite 运行事实表|按 diagnostics 留存策略；仅导出受控状态/计数/时间字段|停止后不得继续排队或持久化来源回调|硬删除清除运行、冷却、日志、健康和缓存行，不保留原文或 provider payload|备份仅作为受保护数据副本；硬删除先暂存并清除受管备份，失败尝试逐文件回滚|
|隐私控制与证明：`privacy_control`、`privacy_deletion`、`privacy_audit_event`|SQLite 私有控制/审计表|保留必要状态、计数、hash、时间和内部关联；不导出正文或原始载荷|记录 stopped/revoked 状态；不代替平台侧撤权证明|仅保留不含内容的删除证明和必要私有审计|`privacy_backup` 仅保存受管元数据；在线恢复登记幂等且明确 `requiresRestart`，不替换打开中的 SQLite|

这张矩阵只描述本地 synthetic L2-L4 合同；真实 Feishu OAuth 撤权、平台备份残留、Windows 文件锁/安装环境与法律合规仍需主人在真实环境中单独核验，不能由本地测试推导。
- 硬删除事务会清理来源正文、文档片段、候选/线程/任务、关系、索引、日志、缓存和 Outbox 等内容/派生数据，并在业务写入前以受控路径 grammar、root containment 和 symlink/junction fail-closed 规则暂存 `TASK_MEMORY_ROOT` 下的任务记忆投影（`task.json`、`brief.md`、`sources.md`、`updates` 与登记的派生文件）。未知文件、路径逃逸或任一 DB/FS/审计失败都会恢复原文件并保持业务零部分写入；SQLite commit 未确认前不会 finalize quarantine。commit 后的部分 finalize、完成审计或补偿失败不会被吞掉，而会在 `privacy_deletion` 中持久化 `PRIVACY_DELETE_CLEANUP_PENDING`、`PRIVACY_DELETE_FINALIZE_COMMIT_PENDING` 或 `PRIVACY_DELETE_RECOVERY_REQUIRED`，保留可恢复状态；成功只保留 `privacy_deletion`、`privacy_audit_event` 中不含内容的状态、计数、hash、时间和必要关联，不留下可重建正文副本。CAS 冲突保持 `pending_confirmation`。
- 导出是主人主动选择的 JSON，scope 只能是 `all/sources/tasks/audit`，同一幂等键复用原 payload/hash，不因重复请求新增完成审计。受管备份可创建和校验，但在线 HTTP 校验只返回 `requiresRestart=true`；实际替换打开中的 SQLite 必须在服务退出后的维护入口执行。
- SQLite 备份包含与主库相同的来源、任务和审计，必须按同等敏感数据保护；该版本的 Electron 桌面不会自动打开或迁移既有 `ai-pm.sqlite`。桌面只使用新的 `ai-pm-v1.sqlite`，旧文件只做存在性检测并原样保留，配置和加密凭证目录不变。公开 `DatabaseUpgradeError` 只序列化受控 name/stage/message，未知启动异常使用固定脱敏消息；错误边界不输出绝对路径、SQLite/OS 原文、记录值、secret 或底层 cause。服务端迁移/备份合同仍由单一解释器和受管 validator 保护，未知 schema、约束冲突或失败均 fail-closed；这些维护路径不构成桌面旧库兼容承诺。真实 Windows 文件锁、祖先 reparse 权限行为和已安装 EXE 的完整升级验收仍是 L5 待验，不能从合成测试外推。
- PRIV-001 在 DATA-03 v4 之后使用连续 schema v5，并新增连续 schema v6；v5 descriptor/checksum 与 v1-v4 identity/checksum 保持不变，v6 持久化跨进程 lifecycle claim/fencing、owner/capability/intent binding、版本 CAS、recovery 状态和 backup cleanup intent。v5 备份 manifest、实例身份、sha256、文件名时间和 schema identity 必须全部匹配。缺表、未知表、损坏内容、侧车文件、路径逃逸、外库备份或校验失败均在写入前拒绝，不覆盖当前库；不存在的 `backups` 目录按空集合处理，存在的目录必须由完整受管 `.sqlite`/manifest 成对集合组成，未知 `.sqlite`、`-wal`/`-shm`、临时文件、目录和孤立 sidecar 一律 fail-closed。硬删除会将受管备份移出管理命名空间并标记 rejected，数据库事务失败时尝试逐文件恢复；备份恢复必须在服务退出后的受控维护流程完成。若备份元数据事务失败且 discard 也失败，受管 `.sqlite` 只能以 content-free `*.sqlite.pending-cleanup.json` durable marker 留存；该 marker 与文件/manifest/hash 成对校验，可枚举、可恢复且不能被 `verify` 当作有效备份，硬删除暂存成功后一起清理。删除 request/confirm 还要求真实系统主人授权、受信任桌面 capability 和 CSRF/origin 校验；confirmation hash 持久绑定当前主人身份、桌面 capability 摘要、固定删除意图和 deletion id，并在 stopFeishu/provider revoke 前完成 token、状态、expiry、expected-version 与 CAS 校验；loopback/CORS 与 confirmation token 不能单独认证本机进程，confirmation token 过期或重放会被拒绝。Windows 文件锁/reparse、真实用户历史库、真实 Feishu OAuth 撤权、平台备份残留和完整安装升级仍未验证。
- DATA-02 的 durable `data_integrity_gap` 不依赖会被 retention 清理的 `app_log`；它保存结构化 source/demand/candidate/thread/task/record/reason/status 与 correction linkage，普通日志清理不会擦除历史缺口。`task_source_link` 的组合外键阻止跨需求单元错链，nullable legacy edge 只在无法消歧时保留并 fail-closed；审计查询使用精确结构化列，不使用 `LIKE` 或原文匹配。安全 audit DTO 对 15 个审计集合逐一使用固定 allowlist，只返回符合内部 ID grammar 的内部 ID/关系链接、受控枚举/状态、布尔/数值、hash、版本和时间；不合规 ID 映射为 `unknown` 或 `null`，未知枚举映射为 `unknown`，禁止 source content、sender/discovery/reason/title/next_step/proposer、record_id、external_id、conversation_id、source_url、metadata/provider raw、before_json、after_json、summary 和自由文本 note。
- DATA-03 的候选版本是 SQLite v4 的唯一修订 CAS。所有候选写入口都必须携带并校验当前 candidate version；线程归属、任务关联和归并组还要校验对应 thread/task version 或成员版本 hash。缺失/非法版本只能返回 400，过期版本返回 409 和安全 current DTO；不自动覆盖、不自动 winner、不自动重放，事务中任何候选、线程、任务、审计或通知失败都保持逐值零写入。候选页的 resource generation 只允许最新 mutation/refresh 回调发布结果，迟到响应和重复点击会被丢弃；synthetic L2-L4 证据不代表真实租户/provider 或 Windows L5/L6。
- 任务“删除”默认是可恢复软删除：来源、时间线、纠错和 `reference path` 仍然保留。它不能替代原文、派生摘要和个人数据的永久清除流程。
- 软删除不等于隐私硬删除。回收站只改变任务/候选的私人记录状态；主人必须经过“停止采集/撤权 → 可选导出 → 二次确认硬删除”流程，不能用清理运行日志或回收站代替硬删除。
- `/api/privacy/retention/run` 只按固定 source/derived/diagnostics 时间列清理到期内容并受 `privacy_control.version` CAS 保护；`/api/privacy/backup/restore` 只登记已验证的受管备份、写入一次 `backup_restored` 审计并返回 `requiresRestart`，不会在线替换打开中的 SQLite。停采集、撤权和硬删除在外部运行时/本地令牌动作失败或数据库事务失败时执行受控补偿；真实平台撤权与服务退出后的文件替换仍需主人在真实环境核验。
- 候选“删除”同样是可恢复软删除：未接受候选只归档候选通知并关闭未分配线程；已接受候选与正式任务在同一事务中同步删除或恢复。不删除 `source_event`、审计或任务关联；回收站中的候选不能继续触发模型整理或正式任务操作。
- 私人计划、软删除和恢复只能修改系统主人的本机台账，不能自动通知需求方、恢复旧外发草稿或形成新的 Outbox。
- 停止采集会关闭所有受管来源状态并让后续同步返回固定 `PRIVACY_COLLECTION_STOPPED`；撤销本地授权还会清理本地授权相关游标和 scope 状态，但不宣称已经撤销 Feishu 平台侧权限。重新 OAuth 只恢复授权状态，不自动绕过主人重新启动采集的选择。
- 已接受任务的文档发生更新时，只能生成给系统主人的私人复核提醒；不得自动改写任务、承诺时间或创建 Outbox。
- AI 自动维护只允许修改私人 PM 内部白名单字段和需求线程，不得借此执行任务、调用任意 SQL/Shell、发送消息、形成外部承诺、删除任务、判定非需求或物理清除数据。
- 自动应用必须通过唯一关联、强证据、模型未降级、双重置信度、任务/线程版本、全局模式和单任务暂停门禁；推测时间、弱关联、歧义、版本冲突和模型异常一律降级为待确认，不能以“尽量自动”为由放宽。
- 主人状态机另设 `0.90` 意图置信度下限；低于阈值、非有限数值或主人身份不匹配时不得自动修改候选、任务或时间线，只能保留待确认记录。
- `completed / archived` 只有来源明确表达完成、取消或不再处理时才可自动写入，并必须重点提示和支持撤销。聊天里的“最终版”、文件出现或模型猜测本身不能证明完成。
- 每次 AI 修改必须保存不可静默覆盖的来源证据、模型与 prompt 版本、关联/更新置信度、原因、策略版本、应用前后快照和 `task_event_id`。普通日志仍不得保存完整聊天、提示词、模型回复或令牌。
- 同一次分页扫描可以把同一会话的连续消息合并后判断，但每条原始消息仍以独立 `source_event` 保存和审计；不得用批次摘要替换或覆盖来源事实。跨轮询和 WebSocket 暂不做延迟聚合。页面仍只显示摘要和审计信息，不因批次聚合而暴露正文。
- 有界背景补扫只允许读取主人已经启用的会话，并受人员硬起点、72 小时窗口和最多 3 页限制；补扫不推进正常同步游标。主人发言可作为需求背景，但不得单独创建候选。
- 多需求分类只向模型发送匿名来源键和受限文本；真实 `source_event_id`、`demand_unit_id`、`requirement_thread_id`、`task_id`、会话 ID、路径和凭证不得进入模型输入。
- 待确认候选归并时，模型只接收最多 6 个匿名编号（如 `c1/c2`）及受限标题、背景、希望验证、Describe、时间新旧和关系信号；真实候选 ID、线程 ID、快照 revision、本地路径和凭证不得进入模型输入。
- 服务端拒绝未知、重复、漏评候选，不完整候选集、fallback 结果、过期快照、已接受、已删除、已归并或状态变化的目标；人工确认还必须匹配建议 ID、页面线程版本和双方组成员快照。只有唯一高置信且主体角色为 `owner_delivery` 时才自动归并。
- 主人明确选择“保留为两件事”后，候选对会写入本机持久排除表；后续重新整理、来源新版本和自动归并门都必须尊重该决定，除非未来由主人显式解除。
- 候选归并只新增内部关联。每条 `source_event` 和候选原记录继续独立保留，不能被主体摘要覆盖或物理删除；整组软删除仍不等于隐私硬删除。
- 模型尚未生成有效摘要时不创建候选任务卡；来源和 Runtime 恢复记录继续保留，来源正文不会回填到 `title`、`background`、`describe` 等面向用户字段。
- 一个 `source_event` 可以支撑多个 `demand_unit`。归并、拆分、改挂和纠错只能改变目标单元的内部关系；共享来源仍被其他单元使用时，不能从其线程或任务中一并移除。
- AI 自动归并、主人确认或否决、更换主体和拆分都会追加 `correction_event`。这些操作不新增 Outbox、不发送消息、不执行任务，也不修改真实工作文件。
- 自动应用提醒与待确认提醒必须互斥：同一来源自动应用成功后只保留自动修改提醒，未通过安全门时只保留确认提醒，避免主人误以为同一变更仍需再次审批。
- 撤销 AI 修改只能由系统主人发起，并使用任务版本检查。撤销生成新的私人审计事件，不删除原修改记录；若已存在后续修改，必须拒绝撤销覆盖并要求主人编辑最新任务。
- Runtime 的工具调用必须经过 Tool Registry：只读工具可直接运行，受控内部更新只能执行固定任务 patch，需审批工具必须停在主人确认，任意 Shell、业务 SQL、真实工作目录写入和自动外发均被禁止。Runtime 日志只保存输入哈希、状态和错误摘要；HTTP 视图只返回白名单摘要，不返回 payload、result、checkpoint state 或工具结果原文。
- SQLite 是任务、来源和审计的唯一事实真源；任务记忆目录只是本地可重建投影，采用临时文件和原子替换。投影失败不回滚任务，也不写入用户实际工作目录。清理重建只能删除 manifest 或既有索引明确登记的系统托管文件，不得递归删除整个任务目录或 `updates/`，未知文件和用户附件必须保留。
- 清理或写入投影前必须重新验证任务记忆根目录、任务目录和 `updates` 没有通过符号链接、Windows junction/reparse point 或路径别名越过安全根；任一异常使投影进入可重试错误，不触碰边界外文件。
- `artifacts.json` 只记录当前仍绑定的已授权目录相对路径、大小和修改时间。解除参考路径只删除 SQLite 绑定及级联快照，不得按路径删除、移动、写入或更改真实工作目录，也不撤销其他任务仍在使用的全局目录授权。
- 打开任务记忆目录时，renderer 只能提交 `task_id`；Electron main 从 SQLite 解析真实路径并重新校验根目录、相对路径、符号链接和存在性。HTTP 视图只返回相对路径，不暴露本机绝对根目录。
- Windows EXE 的密钥必须由 Electron main 使用 `safeStorage` 加密；renderer 永远不能读取已保存的密钥明文。
- 桌面页面只能通过 preload 白名单调用本地能力，不能直接获得 Node、文件系统、数据库或任意 IPC 权限。
- 正式分发前必须增加 Windows 代码签名；当前未签名安装包只用于内部验证。
- 隐私能力的自动化证据仅覆盖合成 SQLite、Mock/HTTP 和浏览器 L4；不宣称法律合规、真实 Feishu 撤权、第三方平台备份残留、生产数据或 L5/L6 完整验收。
- Issue #62 的发布 manifest、Windows L5 workflow 和 installer Smoke 必须 fail-closed：无 Authenticode 证书/thumbprint/timestamp、无精确 source/artifact/run/job 绑定或任一安装/卸载/清理阶段失败时，`authorization` 保持 `false`；合成 provider、Ubuntu CI、浏览器 viewport 和 artifact hash 不得冒充 Windows L5。发布门禁不上传原文、数据库、绝对路径、token、证书或私钥。
- OAuth 诊断只允许保存阶段、错误类别、官方错误码、HTTP 状态和限长错误说明；任何授权码、PKCE verifier、access/refresh token、App Secret、请求正文都必须脱敏或丢弃。
- 可观测同步结果不得包含 raw Runner/provider 对象、主人身份、raw exception、原始 URL、请求/响应正文或外部 ID。`operation_id/request_id` 是本机后端生成的 UUID；来源结果只允许固定枚举来源名、四态 outcome、数字计数/耗时、稳定错误码和固定消息。Runner fulfilled 值只读取 own data descriptor；`skipped=false` 必须有合法 own 计数，`skipped=true` 必须全零且 reason 通过受控 own-key 映射。getter、Proxy/revoked Proxy、数组、primitive、空/未知对象、非有限/负数/小数计数、矛盾 shape 与 `__proto__/constructor/prototype` reason 均 fail-closed 为真实来源的 `OBS_INVALID_SOURCE_RESULT`；被调用后返回 `null/undefined` 也不能降成 `adapter_unavailable`。rejected/invalid 来源必须计入 failure，`error_code` 只能是 string 或 `null`。桌面构建身份只允许构建脚本从受控 Git commit 编译注入；无值或不符合受限字符格式时为 `null`，运行时环境、路径或带 query 的字符串不得覆盖。根 `npm run check` 必须在最新桌面 build 后验证实际 bundle 的 exact HEAD、placeholder 消失和运行时环境读取路径不存在。
- 日常列表、分页、详情和消息同步的飞书业务错误只允许持久化可规范化的有限长度整数业务码、集中映射的错误类别和格式校验后的请求 ID；非法、超长、带空白或非数字的外部 code 必须降为 `UNKNOWN`，不得进入错误摘要。真实 `Error` 或受控 `cause` 只有携带明确传输错误 allowlist 时才可重试，普通响应对象的同名字符串 code 仍按业务错误处理。平台原始错误说明、响应正文或消息内容不得持久化，HTTP 200 不得降低这项限制；任一来源 Runner 只有在业务成功后才能推进 cursor/checkpoint。
- FSH-03 的实时事件确认不是“收到回调即确认”：服务端必须先把最小来源事实提交到 SQLite，再返回 `DurableEventReceipt`。失败或范围校验不通过时不确认，允许平台重投；重复和并发事件按 `external_id` 及 `owner_scope + sourceScope + source_type + conversation_id` 兼容身份幂等，跨身份碰撞在 metadata/row 写入前 fail-closed，且兼容重复不得覆盖渠道 provenance。分类失败只写固定、限长的 event type/source ID/error type 诊断并交给 Runtime 恢复。orphan recovery 仅接受 `sourceScope=bot_supplement` 与 `ownerScope=primary` 的服务端标记，轮询来源、foreign owner 或未授权群不会被恢复路径读取。
- 详情阶段的 transport 重试耗尽是同步阻塞失败，不是“只有详情失败”的 partial：Calendar 与 Minutes 都必须保留旧 cursor/watermark/checkpoint/`last_success_at`，已有完整来源不得被失败覆盖，也不得重复 durable ingest。permission/denied 等明确业务结果仍可按既有受限来源 partial 合同处理。该边界由 `VER-ISSUE40-FSH02-L3-20260816` 的合成负例覆盖。
- OAuth scope 使用 omitted / `set([])` / `set(values)` 三态：省略保留本地授权门禁，明确空值清空门禁，非空值替换旧值；null、非法类型、非法 token 和非法 envelope 以固定 `FEISHU_SCOPE_INVALID` 拒绝，不能降级为 omitted/default。完整 token snapshot 在同一 vault 锁内读取；刷新 singleflight、按身份跨进程 durable refresh lease、跨进程 lock-directory、generation/CAS 和 journaled last-known-good 写入共同防止旧 rotating refresh token 或迟到 owner 响应覆盖新 token、scope、owner profile 或同步状态。租约原子记录 generation、refresh token SHA-256 指纹、owner、owner PID 与 fencing token；只有胜者可调用 provider，旧 owner 迟到写入被 lease fence 拒绝，过期租约仅在 owner 进程已退出时接管。provider 已开始但结果不确定时固定为 `recovery_required`；相同或无法证明变化的凭据继续拒绝 provider，只有锁内持久化的新 generation 与不同 refresh fingerprint 才能由重新授权覆盖旧 marker 并取得新 lease。provider 已交换但 CAS/租约丢失时只报告受控失败，不伪报成功；坏 journal/LKG、坏 generation、缺失 settings 或坏 secrets 不读取、不更新、不混合 defaults 与旧 secrets。测试只使用虚拟 token 和本地合成 vault，不取得真实租户 scope 缩权或生产凭证证据。
- 当前桌面 OAuth 使用官方允许的 confidential-client 模式：App Secret 仅由 Electron main 从 `safeStorage` 读取并完成 Token 交换，不向 renderer 暴露；授权回调用一次性 state 防 CSRF，每次新授权废弃旧 state，state 最多保留 10 分钟。当前不发送可选 PKCE 参数，避免授权端和 Token 端状态不一致导致 `20049`。
- 系统浏览器外链默认拒绝。只有系统主人明确点击后，受控用途中的官方飞书/Lark HTTPS OAuth 或 Docx/Wiki/Sheets URL 才可打开。renderer 必须先拒绝不合规文档地址，只能把规范化允许值交给 document-only preload；Electron main 必须再次独立校验。OAuth 只能由独立 IPC 发起，并严格接受程序生成的 `client_id`、本机 `redirect_uri`、`response_type=code`、一次性 UUID `state` 和 scope，各参数只能出现一次；不提供通用 OAuth URL opener。文档只接受精确 `docx|wiki|sheets/<token>`，query、fragment、尾斜线和额外路径全部拒绝。`file:`、`data:`、`javascript:`、自定义协议、HTTP、localhost/私网、带用户名密码、控制字符、原始或编码反斜线、异常或多层编码、超长值、非标准端口、相似域和未声明组件均拒绝。
- 外链拒绝结果只返回固定 `reason/errorCode` 与人读说明，页面显示稳定 `errorCode` 供主人排障；不返回或记录完整 URL、query、fragment、文档 token 或潜在凭证。OBS-01 允许在受控日志中关联本机 operation/request/trace/span ID，但不扩大采集到原 URL、正文、provider payload 或个人路径；真实租户重定向最终地址仍需受控 L6 验收。

## GitHub 禁止内容

- `.env`、密钥、证书和访问令牌。
- 真实聊天导出、会议原文和生产数据库。
- 带敏感正文的测试截图或日志。
- 未脱敏的飞书用户 ID、群 ID、消息 ID 和本地路径。

## 测试数据

开发和自动测试使用人工构造的虚拟对话。若必须复现真实问题，应先脱敏，并把最小必要案例转换为不含身份信息的测试夹具。

Issue #32 的脱敏测试全部使用带 `synthetic-` 标记的合成 canary；没有读取现有日志、数据库或真实供应商返回。字段与禁止内容见 [日志与诊断数据字典](diagnostics.md)。
