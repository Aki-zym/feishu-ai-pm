# 飞书个人 AI 数据 PM

这是一个独立的实施项目。它负责把已经完成的产品设计转成可运行系统，并通过 GitHub 与其他开发者协作。

## 系统只做什么

- 从主人 OAuth 自动发现的既有个人私聊、主人选择的群聊 `@我`、日历、会议内容、机器人补充入口和人工补录中发现任务线索。
- 保留原始来源，生成低密度 `describe`，形成候选工单；候选页和任务详情只展示 AI 摘要与审计信息，聊天正文留在本地来源审计中。
- 对尚未接受的连续候选，AI 判断是否属于同一需求，并识别“系统主人需要推进的主体任务”；背景、约束和流程咨询作为独立来源挂在主体下。
- 由系统主人接受、暂存或忽略候选，再安排私人计划、提醒、跟进、归档或移入回收站。
- 对已接受任务的后续消息，AI 默认在高置信度、唯一归属和版本未变化时自动维护私人任务字段、状态与时间线；系统主人可查看证据、撤销或纠正，也可切换为“仅建议”或暂停单个任务。
- 候选收件箱也支持可恢复软删除：未接受候选只影响自身；已接受候选与对应正式任务共享回收状态，从任一入口删除或恢复都会同步到另一边。来源、通知审计和任务关联继续保留。
- 服务端仍保留版本化 SQLite 迁移、备份与恢复合同，供受控维护流程和合成测试使用；桌面正式启动不再尝试打开或兼容已有 `ai-pm.sqlite`。桌面始终使用新的 `data/ai-pm-v1.sqlite`，只有该路径不存在时才按当前规范 schema 初始化；发现旧文件只显示固定提示“旧数据已保留，当前已使用新数据库”，不读取、迁移、重命名、覆盖或删除旧库。配置和加密凭证目录保持不变。新库仍受版本、checksum、完整性、外键和降级门禁保护；启动错误显示固定脱敏消息并退出，不留下无窗口后台进程。
- 通过只读 `reference path` 了解工作文件的位置和活动线索。

## 系统明确不做什么

- 不自动执行数据分析或其他业务任务。
- 不控制工作 Agent，不修改真实工作文件。
- 不自动对外回复、拉群、排期、共享状态或宣布完成。
- 不由 AI 自动删除任务、判定“这不是需求”或物理清除来源与审计数据。
- 不把文件出现、聊天里的“最终版”或模型判断直接当成正式完成。

2026-08-15 已确认：M1 与首轮试点固定为 draft-only；任何可能让系统主人以外的人看到的动作都必须由主人明确触发，不能由模型、Runner 或后台恢复自动发出。

## 状态入口

PRIV-001 v6 并发补充：active `claimed`/`compensating` claim 默认阻止冲突的 start/update/retention/backup mutation；过期只能以完整 identity/token/version/timestamp CAS reclaim，双 reclaim 只有一个成功，malformed/unknown timestamp 与 clock rollback fail-closed。provider call 前再次执行 heartbeat/token/status/version fence。
本候选的正式 committed integration base snapshot 为 `a487598bcae3630f1c5906c8b384bc8811ee0e29`（PR #113 / Issue #38 文档新鲜度普通合入后的当前基线）；其第一父提交为 `aaaf8ed6693ade9d29b971a340be01e515b94939`，第二父提交为 `5956dda930591d9faaec0b387c7d4bbbb58ad994`。更早 SHA 仅作历史 provenance，当前机器事实以 [当前状态](docs/current-state.md) 和 `docs/docs-manifest.json` 为准。

唯一当前事实入口是 [当前状态](docs/current-state.md)。它绑定源码 commit，并集中说明产品阶段、主链、当前实现、开放问题、安装包对应关系和验证 ID。

负责人已确认的 M1 产品与治理规则统一登记在 [DEC-01 决策登记](docs/decision-register.md)（机器事实源：[docs/decision-register.json](docs/decision-register.json)）。未决事项必须有负责人 gate，不能由实现者默认拍板；当前登记只声明 L0/L2/L4 合成边界，不声明 L5/L6 真实环境验收。

Issue #29 保留 owner_decision 审计并对退休目标 fail-closed：删除、忽略或作废目标后的未完成判断转为 stale，合法空目标快照不可在 provider 等待期间绑定后来候选，畸形快照或 payload 持久化失败在 provider 前停止；恢复任务不会复活旧判断。证据仅限 synthetic SQLite/service L2，最终 exact head/merge-ref/CI 以 Draft PR #93 body 为准。
Issue #85 / PROD-07 运行时切片已实现规则驱动的日历分类：普通日历提醒、仅出席会议、全天/重复、节假日、生日和订阅日历默认保留为 Calendar 来源事实；只有明确主人责任、动作和交付物或截止点才进入待确认候选。`minutes_action_item` 还必须具备当前事件绑定的 exact typed `minutes:<eventId>` 或 `message:<eventId>` 证据；缺失、错误绑定、非 canonical 或 malformed evidence 均 fail-closed 为 `calendar_fact` 且零 candidate。日历来源分类通过 `/api/calendar/sources` 提供受限路由事实，来源记录不会因过滤而删除。规则事实源见 [PROD-07](docs/product-rules/PROD-07-calendar-classification.md)；本切片仅有 synthetic/local L4 evidence，不代表真实租户验收。

Issue #51 已由 PR #83 合入，其 tip、source 与 CI 只作历史 provenance。当前 integration 已包含 PR #86 / Issue #36 DATA-02、PR #87 / Issue #42 RUN-01、PR #94 / Issue #66 DEC-01、PR #99 / Issue #55 OUT-01、PR #90 / Issue #59 QA-01、PR #107 的 provenance follow-up、DATA-03 v4、PR #93 的 owner decision retirement、PR #92 / Issue #45 source privacy、PR #98 / Issue #34 schema-v6 privacy fencing、PR #109 / Issue #85 PROD-07 runtime、PR #108 / Issue #38 DATA-04、PR #89 / Issue #39 FSH-01 与 Issue #111 本地 exact verification 治理；当前正式 integration snapshot 为 `aaaf8ed6693ade9d29b971a340be01e515b94939`，parents 为 [`91615486f6ac56b63857897df2e75d6c4c9f97d1`, `6033c785fe4fda2bba5b653aa7abc8ba3fbd6266`]，tree 为 `a6d7b09e839c254af4fa3aac8003a1dea159506a`。Issue #34、Issue #39、Issue #45、Issue #85 与 Issue #111 已关闭并 POST_MERGE_STABLE。旧 `91615486f6ac56b63857897df2e75d6c4c9f97d1`、`a7c2ea6d9463b903bafd1ef23577c36b02a2aa88` 与更早 SHA 仅作历史 provenance。Issue #33 / SEC-02 仍是 Draft PR #88 候选（验证 ID `VER-ISSUE33-SEC02-L3-20260816`），只负责不可信数据边界，不包含 #45 公共 DTO/UI。Issue #62 / REL-01 的 Windows L5 release-gate 基础设施已实现；正式 owner-authorized 证书、signed artifact、GitHub Release、N-1/N upgrade/rollback 和真实 Windows L5 仍未验证，manifest 保持 `authorization=false` / `pending`，不能据此关闭 Issue #62。当前组合 product fingerprint 以 [当前状态](docs/current-state.md) 与验证矩阵为准。资源状态、Runtime、draft-only、DATA-03、SEC-02、PRIV-001、PROD-01、PROD-07 与 #111 evidence 只来自 Mock、合成 SQLite、local verification fixtures 和浏览器 L2/L4；真实飞书、provider、Electron/NSIS 安装 L5/L6 仍未验证。

Issue #39 FSH-01 的 owner message、calendar、minutes runner 共享 canonical durable-scope parser/gate；calendar 需要 `calendar:calendar:readonly`，minutes 需要四项 `minutes:*` 读取/导出权限，缺失或 malformed durable scope 在 provider、游标、来源和候选副作用之前 fail-closed。证据仅限 synthetic/local，不代表真实租户 scope 缩权或 OAuth/provider 行为。

 Issue #41 FSH-03 的机器人 WebSocket 事件先写入 SQLite `source_event` 并取得 durable receipt，再允许 SDK 回调返回确认；写入失败或回执不完整会抛错，交给飞书重投。重复、并发、乱序和重启后的 orphan source 按 `external_id` 与 `owner_scope + sourceScope + source_type + conversation_id` 的兼容身份去重或恢复；跨身份碰撞 fail-closed 且不修改既有行或 metadata，兼容重复不覆盖渠道 provenance。分类失败只进入有界诊断与 Runtime 恢复，不提前确认、不自动外发。证据仅限 synthetic/local，不代表真实飞书长连接或租户验收。

 Issue #45 / PROD-01 已由 PR #92 合入并 POST_MERGE_STABLE；默认候选、任务、线程、提案、主人信息和操作回执使用严格最小 DTO，不返回来源正文、稳定/外部 ID、provider/raw error 或未经核验自由文本。安全派生摘要仅对长度门槛的整段/近整段复制、NFKC/跨空白复现、结构化 Feishu/Docx token、URL/路径、UUID 和 secret-like token fail-closed；主人核验仍为显式、task-scoped、私有审计且 `external_action: none`，仅核验本地保存快照并返回带时间的 provider unknown/last-known 状态。验证 ID 为 `VER-ISSUE45-PROD01-SOURCE-PRIVACY-L4-20260816`；证据仅 synthetic/local L2-L4，不外推真实租户、provider、Windows L5 或 L6。

Issue #59 QA-01 的 changed-path、L0-L6 选层、skip 语义、exact provenance 和 no-upload 合同由本候选补齐；提交内记录使用 `pull_request_59_pending`，当前 exact head/merge-ref/tree/parents/run/job 只以 PR #90 body 与 exact pull_request CI 为准。证据限 synthetic CI/browser，最高 L4；不声明真实 Feishu/LLM/tenant/production 或 Windows Electron/NSIS L5/L6。

Issue #40 的 PR #68 已合入，Issue 已关闭；其飞书 SDK 响应守卫现已作为当前 integration 基线的一部分保留：HTTP 传输成功但业务 `code` 非零或格式非法时，列表、消息、日历、妙记和用户 OAuth 路径都会在读取 `data` 前失败，不会把错误当成空列表，也不会推进同步游标或检查点；详情接口的同类业务错误同样保留旧水位。稳定分类只使用集中维护的已确认业务码和 HTTP 状态，不依赖可变 `msg`；非法、超长或未知格式的外部 code 只显示 `UNKNOWN`。真实 `Error` 或受控 `cause` 仅在携带明确传输错误 allowlist（如 `ECONNRESET`、`ECONNREFUSED`、`ENOTFOUND`、`EAI_AGAIN`、`ETIMEDOUT`、`UND_ERR_CONNECT_TIMEOUT`、`AbortError` 或 `fetch failed`）时进入临时错误重试；普通响应对象即使有同名字符串 code 仍按业务错误处理。单个逻辑用户 API 调用中，到期前预刷新与未授权后的恢复刷新共享一次预算，最多刷新一次；预刷新失败时不会调用业务 API，也不会改写旧令牌。分页中途失败会保留已抓取来源事实，但不分类不完整批次；健康诊断只保留受控业务码、类别和格式校验后的请求 ID。以上仅通过 Mock/契约测试，真实租户返回结构、请求 ID/header 位置、Token 刷新和恢复表现仍待验证。

历史 Issue #40 代码候选基于 `integration/m1-test-20260815` @ `c84e7a7405eac09910cf097c79d0dea40cf2eb37`，source head 为 `bb93cfd10c9c2872ec262b9ca1f724f5acc84143`，产品指纹为 `a26c8edbf80834f21e601721fdc21501443611ded76b630dc53f00443b7cb0fb`；详情阶段真实 transport Error 重试耗尽会返回 failure，不会降级为 partial，也不会推进 cursor、watermark 或 checkpoint。对应 exact merge-ref 为 `21a879f256bda33128c6dd6eef0f01fe134319a7`，parents 为 `[c84e7a7405eac09910cf097c79d0dea40cf2eb37, bb93cfd10c9c2872ec262b9ca1f724f5acc84143]`，run/job 为 `31926031864/95113622400`；证据索引为 `VER-ISSUE40-FSH02-L3-20260816`。当前组合 base 与 Issue #46 provenance 以 [当前状态](docs/current-state.md)、验证矩阵和 PR #82 body 为准。

Issue #36 DATA-02 在 SQLite schema v2 中补齐 `source_event → demand_unit → candidate/thread/task` 的显式外键与审计边界。`task_source_link` 的显式边同时受 `demand_unit_id` 单列外键和 `(demand_unit_id, source_event_id)` 组合外键约束，要求来源确实属于该需求单元；同一 task/source 可保留多个明确需求单元边，旧版无法消歧的边保持 nullable 并写入 durable `data_integrity_gap`，不静默选择 winner、删除或覆盖。审计链以有界单调 fixpoint 返回完整连通分量，15 个集合均由固定 allowlist DTO 投影，只返回内部链接、受控枚举/状态、数值、hash、版本和时间，不返回任何用户/provider/raw 文本、record_id、自由 reason/title/summary 或任意未来列。RUN-01 在该 v2 基线之上新增连续 v3 migration；RUN-02 的 durable `provider_retry_cooldown` 已使用连续 schema v8 落地；#37 使用 v4、PRIV-001 v5/v6 与 #38 v7 的 migration identity/checksum 保持不变。当前只在合成 SQLite 与虚拟适配器中验证，不能代表真实用户库、Feishu/LLM、Windows L5 或租户 L6。

Issue #43 RUN-02 当前包含 lease 接管、严格 Retry-After、typed retry signal、指数退避+jitter、optional LLM stage 隔离，以及 schema v8 的跨 Runtime/重启 durable provider cooldown。当前仍不宣称 Issue #43 完成；只使用合成 SQLite、虚拟时钟和 provider 回放，不代表真实 provider/飞书、生产数据或 Windows L5/L6。

Issue #34 PRIV-001（验证 ID `VER-ISSUE34-PRIVACY-L2-20260817`）在 DATA-03 v4 之后保留 dedicated v5 schema、descriptor、migration identity/checksum 原样不变，并新增连续 schema v6。v6 持久化跨进程 lifecycle operation claim/fencing token、owner/capability/intent binding、版本 CAS、heartbeat/recovery 状态，以及带 artifact identity/path/hash 的 backup cleanup intent。删除确认先完成 owner/capability/intent/token/CAS/expiry/replay/status/expected-version 的无副作用原子 claim，再停止采集或撤权；finalize/compensation 还必须重新验证同一 token/version，旧 actor 不得覆盖新 actor。所有主人敏感路由都要求 owner-bound desktop capability、固定 intent、CSRF token 和 `app://local` origin，未授权请求不返回导出正文或执行状态/备份动作。受控 quarantine 在 SQLite commit 证明前保持可恢复，finalize、补偿或 rollback 失败写入 durable recovery 状态；backup manifest 删除后 sqlite 失败仍可由 intent 枚举、验证和恢复。taskMemoryRoot 受路径 grammar、root containment 与 symlink/reparse fail-closed 约束；备份目录缺失按 count=0，存在时 unknown SQLite、wal/shm、临时文件、目录和不成对 sidecar 一律拒绝。成功只保留非内容 proof/hash/count/time；真实 Feishu OAuth/provider、平台残留、Windows 文件锁与 L5/L6 仍未验证，PR #98 exact provenance 以 Draft body 与 terminal CI 为准。

Issue #38 DATA-04（PR #108 已普通合入；本 follow-up 负责 post-merge docs freshness，验证 ID `VER-ISSUE38-DATA04-L4-20260818`）现在以 committed integration snapshot `aaaf8ed6693ade9d29b971a340be01e515b94939` 为基线，连续 schema v7 的 exact candidate head/virtual merge/tree 与新的 local exact evidence 绑定；v1-v6 migration descriptor、identity、checksum 与行为保持连续。v7 追加不可变 `source_event_revision` 账本、canonical payload hash、owner scope/revision-generation CAS、受控 `current_revision_id` 指针和精确 ordered AI replay references；legacy decision 缺少原始输入时显式标记 unreplayable，不伪造 prompt/model/config hash。Replay 的 HTTP route 先执行 capability、固定 intent、`app://local` origin 和 CSRF 检查，但服务层还必须独立读取 durable current capability 状态，以 constant-time hash 比对、owner/decision/source scope 校验、expiry/revoked/consumed CAS 防重放；缺少 binding、caller-forged hash、错 owner/intent/origin、CSRF、缺失、篡改、乱序或 foreign reference 均 fail-closed 且不产生业务副作用。privacy export/retention/hard-delete/backup/restore 同步覆盖 revision/reference 行。证据仅限 synthetic SQLite/Mock/local browser L2-L4，不证明真实 Feishu、LLM/provider、生产数据或 Windows L5/L6。

消息中包含飞书 Docx 链接，或 Wiki 链接实际指向 Docx 时，系统会在主人原有权限范围内读取文档标题、版本和受限正文片段，作为需求背景补充到同一条耐久来源链。Sheet、Base、旧版 Doc、File 和 Slides 当前只识别链接类型，不读取正文。临时读取失败会保留上次成功版本并标记“可能已过期”；无权限、失效或不支持会如实显示，原消息不会因此丢失。该能力已经通过 Mock/契约测试，真实租户的 Docx/Wiki 权限和可读范围仍待验收。
当前默认部署决策是：M1、主人单机试用和首个受控单用户试点继续使用 SQLite；只有出现多人、多设备或远程服务需求时，才触发 PostgreSQL 迁移评审。M1 与首轮试点固定为 draft-only，任何对外内容仍须主人确认。

统一术语、对象权威、状态机、CAS/恢复、错误结果与 ADR supersession 以 [领域合同](docs/domain-contracts.md) 为准；当前合同不会把合成测试写成真实飞书、LLM、Windows 安装或生产数据已经验证。

历史 Issue、PR、测试数字和安装包记录只保留在 [CHANGELOG](CHANGELOG.md) 与 [QA 历史](docs/qa/README.md)；不得从历史记录推断当前分支或真实环境状态。

## Windows 桌面版

内部测试包路径：

```text
release/Feishu-AI-PM-0.2.0-x64-Setup.exe
```

精确 source commit、大小、SHA-256、签名、仓库分发、GitHub Release 和 Smoke 状态只查 [当前状态](docs/current-state.md) 中的 `VER-PACKAGE-020`。构建完成不等于安装 Smoke；同名版本的不同 hash 不能互相替代。

设置页会在真实飞书尚未启用、App ID/Secret 尚未填写时直接说明缺少项，不再尝试打开 `disabled://` 这类伪授权地址；点击“保存并开始授权”会自动保存当前飞书配置，并只保留最新授权页有效。OAuth 失败时会回显脱敏的官方错误诊断。模型区域同时给出 DeepSeek 和公司 OpenAI-compatible 网关的填写示例。

Windows EXE 中的 OAuth 和候选文档外链统一经过同一套 URL 安全策略。候选页先在 renderer 拒绝不合规原始地址，只把规范化文档 URL 交给 document-only preload；Electron main 在调用系统浏览器前再次独立校验。OAuth 仍走单独入口，只接受程序实际生成的五个参数；文档只接受 `feishu.cn` / `larksuite.com` 下精确的 HTTPS Docx、Wiki 和 Sheets 两段路径，不接受 query、fragment 或额外路径。被拒绝时页面显示固定错误码和不含完整 URL 的原因，不会静默失败。

正式 EXE 只显示一套真实设置：先看“连接总览”和紧凑的个人信息来源列表，再处理等高的“飞书连接”和“判断模型”主面板；OAuth 回调和 scope 位于飞书主面板，权限图文指南、机器人补充入口、本机目录和清除密钥按需展开。早期用于浏览器开发的“只校验输入格式 / 不会保存”卡片只在没有桌面桥接的开发页面显示，并明确标记为开发模式，避免把运行状态 `configured` 和空白临时表单误读成配置丢失。

人工同步现在统一返回并显示 `success / partial_success / skipped / failure` 四态。同步响应只保留后端生成的操作/请求 ID、固定来源名、安全数字、耗时、稳定错误码和固定消息；主人身份继续由独立状态接口读取，不会混入同步响应。被调用的同步入口即使返回 `null`、`undefined` 或矛盾结果，也会按真实来源显示 failure，不会误报为“入口不可用”或成功。健康与诊断还会区分 `ready / degraded / not_ready`；桌面构建身份只由构建脚本写入，`npm run check` 会在最新桌面 build 后检查正式 bundle，运行时环境变量不能覆盖。

DeepSeek V4 兼容层会显式关闭 thinking，给连接检查和需求分类保留足够的最终 JSON 输出空间，并把空正文、仅推理正文和 `finish_reason=length` 视为可重试失败。`units: []` 会被视为“无需拆分”，不会触发结构失败；连续失败时来源和 Runtime 工作项仍保留，但候选页不生成假任务卡，也不把规则复制的聊天原文当成 AI 摘要。

 Issue #29 的主人判断退休闭环保留全部 `owner_decision` 审计：候选被忽略/移入回收站，或关联任务被删除/作废时，尚未完成的判断会转为 `stale`，不再出现在可处理提醒中。分类开始时保存带 `schemaVersion=1` 的目标快照；合法零目标快照是权威 negative snapshot，不能在 provider 等待期间绑定后来候选，未知/畸形快照和 SQLite payload UPDATE 失败均在 provider 前 fail-closed。若这是重启/重试且耐久快照明确为空，服务只写 `noop` 审计并不生成待处理提醒；首次处理仍保留真正未关联主人消息的 `review`。Runtime payload 写入必须通过当前 lease owner、未过期租约和 cancel fence，旧 worker 不能覆盖新 owner；真实 SQLite 失败注入已证明 providerCalls=0 且不新增 candidate/task/owner_decision/correction。无法证明 ignored 候选的历史退休时间，或只有同会话而无强关系的旧孤儿，均保持待确认；恢复任务不会自动执行旧判断。

在本机重新构建安装包：

```powershell
npm run desktop:dist
```

打包默认使用 `npm install` 已安装的同版本 Electron 运行时，不会为了同一版本再次临时下载 Electron；首次安装依赖本身仍需要正常网络或可用 npm 缓存。

安装后双击“数据 PM”即可使用，不需要单独启动后台或打开浏览器。具体操作见 [Windows 安装与首次连接指南](docs/user-guide.md)。

## 浏览器开发方式

前提：安装 Node.js 24 LTS。

```powershell
npm install
npm run dev
```

然后打开 `http://localhost:5173`。Windows 也可以运行 `scripts/start-local.ps1`。

生产式本地预览：

```powershell
npm run build
npm start
```

然后打开 `http://127.0.0.1:4310`。

## 可以体验什么

- 工作台：按 `Asia/Shanghai` 自然日查看需要确认、今天推进和等待他人的事项；显式开始/完成区间覆盖今天的跨日任务也会进入“今天推进”，已完成不计入待推进、已归档默认隐藏；候选、今日计划、等待、进行中和逾期数量分别从任务事实独立统计，不受页面列表上限影响。
- 候选收件箱：接受、暂存、忽略、移入回收站或恢复虚拟需求；回收站候选不能继续接受或纠错。
- 失败来源收件箱：只显示脱敏失败状态；服务端会校验来源、原始 Runtime job、payload revision/source set 和 `job_source_link` 的一致关系，关系失效的记录从列表和重试/归档入口 fail-closed 隐藏。
- 候选固定展示“时间范围、背景、希望验证、Describe、为什么被识别”；没有可靠信息时明确显示“未推断出”，推测内容标记为“AI 整理·待确认”。
- 同一需求的多条候选只显示一张主体卡；可展开来源角色和主体理由，在接受前更换主体、拆分来源，或处理低置信归并建议。
- 一批连续消息可拆成多个具体需求；每张卡代表一个需求，并显示可回查来源、背景完整性以及结构失败后的恢复/重试状态。
- 消息内 Docx、Wiki→Docx 的文档背景状态、版本和完整性；读取失败不会丢原消息。
- 由主人点击后在系统浏览器打开受信任的飞书文档；未知域、非 HTTPS、内网地址、凭证化 URL、query、fragment、额外路径和未验证跳转会被拒绝并显示原因。
- 全部任务、排期日历、归档、回收站和任务详情；排期日历按 `Asia/Shanghai` 自然日展示，跨日区间会出现在每个覆盖日，结束时间恰为 00:00 时不进入右侧日期；起止相等按单日点事件显示。单个计划最多覆盖 366 个上海自然日；任务编辑、主人消息确认排期、“状态或排期有误”纠错，以及撤销 AI 自动维护时恢复的计划都会拒绝超限或反向区间。自动更新撤销会用同一运行时 parser 强解析前后快照，恢复日期只接受与正常编辑相同的 ISO datetime 或 `null`，并在写入前核对任务、线程、候选与候选修订关联。只有具备唯一 previous revision、且 previous/applied payload 分别与 before/after 候选快照一致的 candidate-linked 更新才能撤销；before/after 候选业务状态还必须与当前主表状态一致，撤销不会从快照改写该状态。普通新来源保持 candidate-less，不会把唯一 current revision 错误切走。损坏或错配只返回固定脱敏冲突，额外历史字段会被剥离，不会部分恢复任务或进入新审计。历史坏数据会逐项隐藏并显示脱敏数量，Calendar 页面只接收清洗后的展示时间，不影响其他正常任务。已完成任务保留在原计划日，已归档、已作废和回收站任务默认隐藏。
- 来源摘要、可审计时间线、对外动作待确认和 `reference path`；来源当前状态可因已授权编辑或撤回而更新，append-only 来源历史尚未实现；聊天正文只在本地审计记录中保留，不在候选卡或任务详情直接展示。
- 同一需求的后续补充、高置信内部自动更新、歧义归属确认、弱证据待确认、AI 最近修改和版本冲突。
- 查看每次 AI 修改的前后值、来源、模型、置信度与原因；未被后续修改覆盖时可一键撤销，也可暂停单任务自动维护。
- 在任务详情完整编辑标题、Describe、下一步、风险、等待原因、状态和私人计划时间，并通过任务版本防止旧页面覆盖新修改。
- 在 Windows EXE 中安全打开或清理重建任务记忆目录；普通重建只清理系统托管文件并保留未知文件，隐私硬删除则先对 `TASK_MEMORY_ROOT` 做完整受控枚举，未知文件、路径逃逸或 symlink/junction 会 fail-closed 并补偿恢复；确认 hash 持久绑定主人身份、受信任桌面 capability、固定删除意图和 deletion id，所有 token/status/CAS 校验在 stop/revoke 前完成，renderer 只传 `task_id`。
- 挂接或解除只读 `reference path`；解除绑定不会触碰真实工作目录。
- 将任务移到回收站并恢复；删除和恢复都不会自动发送外部消息。
- 任务级纠错：误接受的任务可标记为无效并归档，原始来源与审计仍保留。
- 集成设置中的连接总览、个人信息来源状态、飞书、模型和只读工作区入口。
- 个人私聊会自动发现，但默认不关注；可逐个选择或一键关注当前已发现人员。群聊按群名单独选择且只处理真实 `@你`。页面无需填写 `chat_id`。
- 日志按类型、级别和日期筛选，自动按保留天数轮转，并支持脱敏诊断包导出和一键删除运行诊断日志。
- 后端同步接口会明确返回 `success / partial_success / skipped / failure`，并附带后端生成的操作 ID、请求 ID、来源级安全计数和固定错误码；健康与诊断接口同时区分存活、就绪、降级和不可就绪。
- 人工补录：不连接飞书也能把漏掉的需求加入待确认候选；开发和自动测试中的虚拟长对话只在显式测试装配中运行，不进入正式数据目录。

## 验证

```powershell
npm run docs:check
npm run check
npx playwright install chromium
npm run test:e2e
```

浏览器 E2E 的桌面宽屏与 Pixel 7 项目使用独立测试服务、内存数据库和任务记忆目录；生命周期门禁以 run token、shutdown nonce/ACK 和单一状态阶段区分正常关闭与意外退出。预期浏览器错误必须按单测试 scope、精确请求和次数成对消费，响应或错误缺失、重复及错配都会失败；同一纯 matcher 的合同单测随 `npm run check` 自动执行。桌面首次配置的 browser bridge Mock 只证明 L4 本地界面合同，不等于 Electron/NSIS L5。Issue #31 的 behavior/source `a337d8d122c3fd1b8994ba491d85c98ffe226e59` 已由 PR #71 exact merge-ref CI（base `41604640804c19e4d50a0027d85eb0eaf12d73e8`、head `2b7f72ab8cca71bd0a26e4688d660fd9da585b82`、merge `a577b431017ca5a787906efa087f258cd82837bc`、run/job `31922195012/95103779717`）验证；Issue #46 的失败来源写入口在 `c12255dd3fb7fb6fee75bcd3ed301326bb178290` 统一校验来源分类 Runtime 关系、去重来源集合、非分类 job fail-closed 零写入，并拒绝缺少 owning source 的分类失败关系，最终 exact PR #82 provenance 以 PR body 为准。当前或未来 docs-only head 的 freshness 以 PR body 最新 exact base/head/merge-ref/run/job 为准。精确测试数量、commit、环境与 run 只记录在验证矩阵和 QA 历史中。

Pull Request CI 只对经过完整 changed-path 与产品 fingerprint 门禁证明的纯文档变更使用快速文档检查；测试、脚本、CI、运行时代码、桌面和发布变化，以及任何混合或未知路径，都 fail-closed 到完整检查、生命周期探针和浏览器 E2E。完整门禁复用同一轮构建并校验产物来源。当前 CI 失败时不上传 artifact、Playwright report、trace、screenshot 或测试日志；受包装的生命周期/E2E 子进程原文不会直接写入 Actions，也不会落盘，只输出有界观察后的固定成功/失败摘要。安全失败附件需另行设计和评审。

Issue #59 的统一选层、skip/provenance 和 Agent 执行顺序见 [测试选层与证据门禁](docs/test-selection.md) 与 [Agent 测试 SOP](docs/qa/agent-test-sop.md)；unknown/mixed/high-risk changed paths 不能由窄证据授权 L5/L6，CI/证据/docs-check 控制面路径变化始终进入完整门禁和人工复核。Issue #111 的本地 exact evidence 还会重算完整 changed-path/plan/required gate，拒绝未知字段、零测试、删减命令、旧 generation 覆盖新失败和 partial/replay evidence；GitHub PR green check 不再是本地 authoritative evidence。

关键自动检查包括：空消息搜索在 SDK 调用前被拒绝、缺 scope 时不调用消息 API且不推进游标、新 P2P 默认关闭、“关注所有人”只启用当前名单、人工选择不会被刷新覆盖、重新启用不补历史、超过 50 人的有界轮转、姓名搜索不偷开读取、群仍需明确选择、`open_id → chat_id` 解析、每目标独立游标、主人自己发送的 P2P 不建候选、群只保存真实 `@主人`、重复 `message_id` 不重复建单、失败不推进其他目标游标、候选接受后建立正式任务、候选回收站删除/恢复、匿名候选归并、主人主体识别、低置信建议、更换主体、拆分与整组接受、Docx/Wiki 背景读取与权限降级、私人计划、软删除与恢复、高置信自动关联与更新、弱关联安全降级、全局/单任务暂停、AI 修改审计与撤销冲突、完整任务编辑、托管投影清理且未知文件保留、解除引用不触碰真实目录，以及 M1 对外动作只生成 draft-only 本地草稿并显示待主人审阅/已拒绝/已失效；确定性重复请求不堆积等价草稿，删除/无效化会在事务内终止关联 approval/outbox，公开 DTO 不返回 payload/provider/raw，当前没有发送执行路径。普通本地 E2E 仍会先重建网页和服务端；CI 完整门禁则复用同一轮已验证构建，并核对 commit 与关键产物 hash，避免误测旧文件。

上述是可选命令，不代表本分支已经运行。每次结论必须绑定 commit、run、环境、result、skips 和 evidence type；当前证据只查 [验证矩阵](docs/verification-matrix.md)。

## 阅读入口

1. [当前状态](docs/current-state.md)：唯一“现在是什么”。
2. [项目地图](docs/project-map.md)：按工作区域找到实现、合同、测试和文档影响。
3. [文档入口](docs/README.md)：按任务类型选择稳定合同和历史材料。

## 最简单的协作方式

```text
一个开发事项
  -> 建一个 GitHub Issue
  -> 建一个独立分支
  -> 提交 Pull Request
  -> 自动检查；安全改动必须独立复核
  -> 项目负责人最终批准
  -> 通过 Pull Request 合并到 integration 或 main
```

治理细节见 [CONTRIBUTING](CONTRIBUTING.md)、[handoff 模板](docs/handoff-template.md) 和 [stacked PR 规则](docs/stacked-pr.md)。一个 Issue 只使用一个独立 branch/worktree/Draft PR；merge 与 release 分开，CODEOWNERS 路由不等于独立复核证明。

`main` 与 `integration` 都只允许通过 Pull Request 合入，`main` 始终保持可用。真实令牌、聊天原文、导出数据和本地配置不得提交到 GitHub。

