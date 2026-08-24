# 当前状态

> 2026-08-24 Cindy trusted-source candidate（阶段：Windows 桌面成熟化）：入库 errand 读取来源后先调用 `save_pm_sources` 原子保存到 SQLite，再由 `submit_pm_decisions` 只消费 receipts。Bearer 仅用于 HTTP 鉴权；插件独立保存稳定连接账号锚点和 receipt 密钥，因此 Bearer 轮换不改变旧 receipt、来源身份或幂等记录，不同账号锚点继续 fail-closed。连续 schema v9 增加 provider revision 防回退、批内关系门禁、处理状态和 `legacy_read_only` 前向迁移；v8→v9 失败会阻止启动并恢复完整 v8，生产服务与插件 bundle 均无 raw-source intake/seed 入口。本轮 `product-source-sha256-v1` / `apps-workspace-default-include-v1` 指纹为 `fa07fce14afeb4308aafcf35202390ff193e18b6cdbcad30d90a95453b0d0139`，纳入 `84` 个文件，快照日期沿用组合基线 `2026-08-15`；验证记录为 `VER-LOCAL20260824-001-CINDY-SOURCE-L2-20260824`。当前证据仅 synthetic/local；真实 Cindy errand、真实飞书账号、MCP provenance attestation、真实 token 轮换与生产数据尚未验证。

> 2026-08-18 FSH-03 candidate refresh：PR #108 / Issue #38 及其 docs follow-up 已形成 committed integration snapshot `a487598bcae3630f1c5906c8b384bc8811ee0e29`；当前 live integration tip 为 `635290379de2688187988692ecb619c9c109e100`，本候选已普通重绑该 live tip 并继续实现 FSH-03 durable inbox-before-ack。当前 product-source fingerprint 以本轮 docs 生成结果为准；v1-v7 descriptor/checksum 与行为保持连续。

> 这是仓库中回答“现在是什么”的唯一人读入口。机器入口、生成视图和历史位置由 [文档清单](docs-manifest.json) 声明；测试数字、运行环境和安装包 hash 只以 [验证矩阵](verification-matrix.md) 中的验证 ID 为准。

## 当前实现快照

- 原始审计快照日期：`2026-08-14`；该日期只表示 Issue #63 首次审计当时的文档快照，不能证明后续组合分支或 CI。
- 组合重基线日期：`2026-08-15`；当前 integration tip 为 `integration/m1-test-20260815` @ `635290379de2688187988692ecb619c9c109e100`，这是 PR #114 普通合入后的 authoritative live tip；声明类型为 `live_tip`。其 exact parents/tree/CI 只以本轮 PR body 与 fresh local exact evidence 为准；不会把未来 merge SHA 追写回提交文档。此前 `2c3a2060a870f7d4df9d32fbe5702929100e2bbb`、`a487598bcae3630f1c5906c8b384bc8811ee0e29`、`aaaf8ed6693ade9d29b971a340be01e515b94939`、`a7c2ea6d9463b903bafd1ef23577c36b02a2aa88`、`5e468ed11dd148f59b736a8f5dd0509323f0dfee`、`c7fa0228b12e96f6eed071bf5ff6ac489ae49dc7`、`3532ed0bce9e93a977ba013b2002724c8619cab5`、`afaba4b2beea37a8d7a6ce08a9c460eff2593f00`、`7b791cb7111064056583d5b85c8f7ec08218ea80`、`416fc6340bb62faa25159e4a3a4f831669e3703f`、`15b8f51d2d69093670af9afd581d98774cfc505c`、`34c2f8376fe0de5a07fa33eb0e63a757f39ec891`、`25513a3eb69f9d6f7822633c948fe24fab2f6179`、`8bcf3e7a7449cf000256cbe80731d23e32e701fe`、`794fbf1365c2dbd4e52064a27bdb0b19c258691c`、`5603404d98621a9d30a99ddc0def2283678d1341` 与 `ebe682aeae067bbf08a6f38ea39de17adceb9ac0` 仅作为历史 provenance；历史冻结产品基线为 `c872c0f9534b1a8b7ad2fcde9551efcba503ad46`。
- PR #81 最新精确事件 base：同一分支在该 PR 中的事件 base 为 `integration/m1-test-20260815` @ `f7bdf11bf2578f130f2443c6f67d6d004b82b394`；它是本次 exact merge/event 证据的起点，不替代提交基线快照。
- Issue #59 QA-01 已由 PR #90 纳入 integration，PR #107 补齐严格声明与 integration push 第一父提交例外；本修复继续使用上述 committed snapshot，并由 CI 额外绑定 GitHub 关联已合入 PR head、merge tree 与 live merge freshness，不把未来 merge SHA 追写回提交文档。
- Issue #62 REL-01（验证 ID `VER-ISSUE62-REL01-GATE-20260816`）的 Windows L5 release-gate 基础设施已实现，但正式 owner-authorized 证书、signed artifact、GitHub Release 与 signed N-1/N upgrade/rollback 仍是外部阻塞；manifest 对 unsigned temporary smoke 保持 `authorization=false` / `pending`。
- Issue #111 QA-02 已完成并 POST_MERGE_STABLE：完全本地 exact verification 以隔离 worktree、完整 base/head/virtual-merge/tree、Git 重算 changed-path/plan、canonical required gates、严格 schema、守恒计数、脱敏日志、环境版本、artifact/log hash、唯一 generation/lock/CAS pointer 和 candidate fingerprint 为边界；本地 evidence 不伪装成 GitHub Actions，仍不声明真实租户或 Windows L5/L6。Issue #111 已关闭。
- Issue #111 当前验证事实源记录为 `VER-ISSUE111-QA02-L4-20260818`；该治理已合入并稳定。
- Issue #33 / SEC-02 当前仍为 Draft PR #88 候选（验证 ID `VER-ISSUE33-SEC02-L3-20260816`）：只负责外部内容不可信边界、严格模型 schema、服务端 post-adapter guard、checkpoint/result/诊断安全 projection 与 synthetic malicious fixtures；不包含 #45 公共 DTO/UI。当前候选需基于正式 integration tip 普通 merge，exact head/merge-ref/parents/tree/run/job 以 PR #88 最新 body 为准。
- PR #84 合入前的 exact integration base：`integration/m1-test-20260815` @ `ad75b68687356a4782779b34ec35c60db68e05ea`；旧 `e4c2b1335664429e354015b2131427dc277f0c7b` 与 `f7bdf11bf2578f130f2443c6f67d6d004b82b394` 仅作为历史候选 base，不能用于最终批准。
- 上一轮候选产品源码快照为 `product-source-sha256-v1` / `6e2e398e6471fbbd7b08ba128a6bf518736139bd5ba6f4e895ae2367c2586dd9`，纳入 `84` 个文件；该历史 source 与当前合并候选投影分层记录。Issue #80 正式包的产品/构建 source 仍为 `f9e77aec70aaa846047f987672c9171e0790846a`。
- 当前候选产品源码权威指纹为 `product-source-sha256-v1` / `0f78d1090fcea4452a145ea197f217ddd70506a58f6f4777636a022b26f81041`，纳入 `87` 个文件；除 DATA-04 v7 外，新增 FSH-03 durable WebSocket inbox-before-ack、来源去重身份 fencing 和 orphan recovery。本轮 exact evidence 必须以该 fingerprint 与 live integration tip 一致为前提。
- Issue #41 FSH-03 本候选新增 WebSocket durable-inbox gate：`im.message.receive_v1` 回调等待 `source_event` 事务提交并取得 `DurableEventReceipt` 后才返回；commit 前异常、无效回执或 scope 不匹配均 fail-closed。相同 `external_id` 的重复/并发投递只保留一条来源，但去重身份同时绑定 `owner_scope`、`metadata.sourceScope`、`source_type` 和 `conversation_id`；跨主人、跨入口或跨会话碰撞在任何行/metadata 变化前拒绝，兼容重复不会覆盖已提交的渠道 provenance。分类由 Runtime 幂等键承接；提交后分类窗口崩溃时，启动恢复只扫描明确标记 `sourceScope=bot_supplement`、`ownerScope=primary` 的 orphan source。验证 ID `VER-ISSUE41-FSH03-L4-20260818`；证据为 synthetic/local，真实飞书长连接、租户权限、生产数据、独立 Reviewer、普通合入和 post-merge evidence 尚未取得。

Issue #39 FSH-01（验证 ID `VER-ISSUE39-FSH01-L3-20260816`）的 owner message、calendar、minutes runner 共享 canonical durable-scope parser/gate；calendar 需要 calendar:calendar:readonly，minutes 需要四项 minutes:* 读取/导出权限，缺失或 malformed durable scope 在 provider、游标、来源和候选副作用之前 fail-closed。证据仅限 synthetic/local，不代表真实租户 scope 缩权或 OAuth/provider 行为。
- 产品路径选择器：`apps-workspace-default-include-v1`。
- 产品/构建 source commit：`f9e77aec70aaa846047f987672c9171e0790846a`；它是正式安装包所对应的产品实现来源，不是本轮 PR 证据 head。
- artifact/record carrier ancestor：`3dcd9d0779542a7f3b6beebe73048273a0eff68a`；正式包与本条验证记录自该已知祖先进入仓库，`VER-PACKAGE-020.record_commit` 使用 `pull_request_81_pending` 避免同一提交自引用；当前 product fingerprint 以本轮 merge 后工作树为准。
- PR #81、PR #83、PR #84 与旧 PR #82 的最终 docs/evidence head、merge-ref、parents 与 run/job 只用于历史证据新鲜度，写在各自 PR body，不替代产品/构建 source；PR #86 / Issue #36 与 PR #87 / Issue #42 已合入/关闭，PR #87 的 exact head、merge-ref、parents 与 run/job 仅作为历史 provenance。
- Issue #29 目标快照竞态修复行为/source 为 `60e10b1f1f9df0c9580772487e07b623e600a03e`；该提交是基于当前 integration tip 的普通 merge，包含 owner snapshot schema/CAS 兼容和退休目标 stale 结算修复。最终 exact head/merge-ref/tree/parents/run/job 以 PR #93 body 绑定；旧 head/CI 仅作 historical evidence。
- Issue #45 / PROD-01 已由 PR #92 合入并 POST_MERGE_STABLE；默认候选、任务、线程、提案、主人信息和操作回执使用严格最小 DTO，不返回来源正文、稳定/外部 ID、provider/raw error 或未经核验自由文本。安全派生摘要仅对长度门槛的整段/近整段复制、NFKC/跨空白复现、结构化 Feishu/Docx token、URL/路径、UUID 和 secret-like token fail-closed；主人核验仍为显式、task-scoped、私有审计且 `external_action: none`，仅核验本地保存快照并返回带时间的 provider unknown/last-known 状态。验证 ID 为 `VER-ISSUE45-PROD01-SOURCE-PRIVACY-L4-20260816`；证据仅 synthetic/local L2-L4，不外推真实租户、provider、Windows L5 或 L6。
- 产品阶段：`M1：本机任务库与 Cindy 插件入口维护`。
- Issue #29 的 owner_decision 退休闭环验证 ID 为 `VER-ISSUE29-OWNER-RETIREMENT-L2-20260816`；证据仅限 synthetic SQLite/service L2，不代表真实 provider、飞书租户、生产数据或 Windows L5/L6。
- 当前使用入口：Cindy 插件 + 本机后台 + 浏览器，默认地址为 `http://127.0.0.1:4310`。
- Windows Electron EXE 属于遗留载体，用于安装包证据和维护验证；React 网页界面继续由浏览器入口提供。
- 产品版本：`0.2.0`。
- server Vitest 门禁固定使用 single-thread threads pool、`--no-file-parallelism` 与单 worker；默认 5 秒 test timeout 仍保留，不通过提高 timeout 掩盖迁移或 worker 收尾问题。JSON 报告只有在子进程真实 zero exit、无失败测试且至少有一项通过时才算通过。

本分支基于当前 integration tip，并组合纳入既有桌面生命周期、迁移、可观测、领域合同、自然日排期、旧库启动、前端异步资源状态和永久 draft-only 合同。Issue #43 RUN-02（验证 ID `VER-ISSUE43-DURABLE-RETRY-L4-20260816`）本轮交付 lease 接管、严格 Retry-After、typed retry signal、指数退避+jitter、optional LLM stage 隔离及 non-retryable fail-closed，并以连续 schema v8 持久化 provider cooldown；#34 的 v5/v6 与 #38 的 v7 identity/checksum 保持不变。Issue #43 仍保持开放；本轮已取得 synthetic/local exact evidence，等待独立审查与当前 PR provenance 决策。`buildApp` 和 Electron 不注册 `/api/dev/simulate-message`；Issue #80 的 database-path、server migration、ADR 和 release 证据属于已合入基线。Issue #40 的 PR #68 已合入且 Issue 已关闭，其 parser/transport 错误保护证据仍只使用 Mock/契约测试。Issue #51 的异步资源状态事实由 `VER-ISSUE51-UI-L4-20260816` 记录；Issue #46 的失败来源关系与零写入事实由 `VER-ISSUE46-FAILURE-RELATION-L4-20260816` 记录；Issue #42 RUN-01 已由 PR #87 合入且 Issue 已关闭，相关 exact head/merge-ref/run/job 仅作为历史 provenance，不替代实时 integration ref。Issue #55 的 draft-only 闭环由 `VER-ISSUE55-DRAFT-ONLY-L4-20260816` 记录；Issue #65 GOV-01 的治理合同由 `VER-ISSUE65-GOVERNANCE-L0-20260816` 记录。同步入口只在 adapter 真正不存在时报告 unavailable；CI 对未知或混合路径执行完整门禁。详细历史保留在 [CHANGELOG](../CHANGELOG.md) 与 [QA 记录](qa/README.md)，对象权威和状态边界见 [领域合同](domain-contracts.md)，诊断字段合同见 [日志与诊断数据字典](diagnostics.md)。这些实现事实和合成测试不自动取得新的 L5/L6 证据，运行时证据仅限 synthetic L4，不证明真实飞书、LLM、生产数据库或生产数据。

Issue #36 DATA-02（验证 ID `VER-DATA02-RELATIONS-L2-20260816`）已由 PR #86 合入 integration，当前 behavior/source 与产品 snapshot 证据共同锚定历史 source commit `0c0da70741f3ea9fbe42b1e13f7ba97c3e21df91` 和历史 fingerprint `2cc5a084e585053e4176f0fc8991065fbe4930d3dd5dcc8fed1ab6b11ca0f221`；当前组合工作树 fingerprint 为 `bdfd9b1d0e48ddc3cb992236513ede556b59c081052c9a334435cd643cce5577`。PR #86 当前基线快照为 `integration/m1-test-20260815` @ `ebe682aeae067bbf08a6f38ea39de17adceb9ac0`，仅作为 manifest 对齐的历史 current-base 事实，不替代本候选的 `a487598bcae3630f1c5906c8b384bc8811ee0e29` committed integration snapshot。此前 `18f8d8ba4ffbc389afb7b05dc18d1c0b847695df`、merge-ref `edeb29494ce0160c0fdece616cff23c066085ee5`、tree `8738be57106b3e1459db2f2d97b034544b9ac7a9`、CI `31938935008/95145158077` 仅作为上一轮 source/docs evidence / historical exact run，不是当前候选授权。最终 gap UPDATE 绑定选中 `gap.id`、record/source/task/reason/status 与 NULL-safe `demand_unit_id`，fallback 查询使用同一结构化 fence。安全 audit DTO 对 15 个集合逐一固定投影，只返回内部关系、受控枚举/状态、布尔/数值、hash、版本和时间；所有内部 ID/链接也必须符合受控 grammar，否则映射为 `unknown`/`null`。DATA-02 v2 是 RUN-01 v3 migration 的连续依赖，RUN-01 不改写 v1/v2 descriptor/checksum。

Issue #37 DATA-03（验证 ID `VER-DATA03-CANDIDATE-CAS-L2-20260816`）当前候选基于 `integration/m1-test-20260815` @ `8bcf3e7a7449cf000256cbe80731d23e32e701fe` 的普通 merge，行为提交为 `7cbb899017bcb5d577f3648442719ff4fa2d1efc`，只增加 candidate version/CAS 和 CandidatesPage 刷新代际，不依赖 #45 或其他开放 Issue。RUN-01 已占用 schema v3；DATA-03 使用下一连续 dedicated schema v4，在 `candidate_request.version` 上精确回填既有行 `1` 并保留 v1/v2/v3 identity/checksum。候选 mutation 在同一 SQLite transaction 内校验 candidate/thread/task 版本和合并组成员版本 hash；缺失/非法 expectedVersion 为 HTTP 400，旧版本为 HTTP 409 并只返回安全 current DTO，不自动 winner、不自动重放，任何业务/审计/通知失败逐值回滚。merged group 的 delete/restore 从 snapshot 逐成员携带 root 绑定、accepted_task_id NULL、精确 version 更新，并要求每次 changes=1；任一成员 stale、错绑或更新失败时整个组和 notification 事务回滚。非 root URL 的 expectedVersion 精确绑定 requested member，错误 root/member 版本在 delete/restore 前零写入。Web 复用 `resource-state.ts`，按资源 mutation generation 丢弃迟到回调，成功先接收 canonical response 再 refresh，refresh 失败只重试读取。当前 exact head/merge-ref/parents/tree/run/job 仍采用 `pull_request_100_pending`，最终以 Draft PR body 为准；本候选只使用 synthetic SQLite/Mock/browser L2-L4，不代表真实 Feishu、LLM、生产数据或 Windows L5/L6。

Issue #34 PRIV-001（验证 ID `VER-ISSUE34-PRIVACY-L2-20260817`）在 DATA-03 schema v4 之后保留 dedicated v5 descriptor/checksum 原样不变，并新增连续 v6；v6 持久化跨进程 lifecycle claim/fencing、owner/capability/intent binding、版本 CAS、heartbeat/expiry/recovery 状态和 backup cleanup intent。活跃 claimed/compensating claim 默认阻止所有冲突的 start/update/retention/backup 状态推进；过期 claim 只能以完整 identity/token/version/timestamp CAS 原子 reclaim，双 reclaim 只有一个成功，畸形/未知时间戳和时钟回拨 fail-closed。隐私删除先完成 owner/capability/intent/token/CAS/expiry/replay/status/expected-version 的无副作用原子校验，再停止采集或撤权；provider 前再次 heartbeat/token/status/version fence，finalize、补偿或 rollback 失败写入 durable recovery 状态，不吞掉错误、不留下静默缺口。硬删除严格按 taskMemoryRoot 路径 grammar、root containment 与 symlink/reparse fail-closed 枚举 task.json/brief.md/sources.md/updates 等正文和派生投影；受管备份目录缺失按 count=0，存在时 unknown SQLite、wal/shm、临时文件、目录或不成对 sidecar 一律拒绝。成功只保留非内容 proof/hash/count/time，真实 Feishu OAuth/provider、平台备份残留、Windows 文件锁和 L5/L6 仍未验证；PR #98 的 exact head/merge-ref/tree/parents/run/job 以推送后的 Draft PR body 与 terminal CI 为准。

commit 只提供精确产品快照的导航线索，可能因后续 squash/merge 改变；机器每次都以确定性的产品源码指纹比对被审工作树，并与 [文档清单](docs-manifest.json) 和 [验证事实源](verification-matrix.json) 交叉检查。产品源码或运行配置变化时，三处必须一起更新，否则 CI 失败。当前候选产品投影 fingerprint 为 `596b57af001a973add63baca739f19051d3aa923d07e4b854d2ef99e37c71aa4`；当前纳入 `87` 个文件；本轮暂不绑定等价参照 commit。当前 exact base/head/merge-ref/parents/tree/run/job 只以本轮 Draft PR provenance 为准，不把历史 PR 的 CI 当作当前候选授权。
Issue #42 RUN-01 已合入 integration；Runtime 支持可复用 provider checkpoint、SQLite 工具审计原子落库、AbortSignal、有界续租和 exact lease fence，失效或迟到回调不能写入完成状态、checkpoint 或业务结果。RUN-01 的 `external.send` claim/幂等恢复仅作为历史审计兼容和未来独立发送 Issue 的保留结构，M1 当前 policy 永久固定为 `forbidden`：即使 `approved=true` 或存在幂等键，也不创建外部 claim、不调用 provider、不执行 callback。当前 v1/v2 schema identity 与 DATA-02 v2 合同保持不变，RUN-01 使用连续 v3 migration；正式验证 ID、commit、环境与限制以已合入 PR #87 的历史 provenance 为准，不代表真实 provider、飞书租户或 Windows L5。

Issue #85 PROD-07 的规则合同与合成夹具验证 ID 为 `VER-ISSUE85-PROD07-L0-20260816`；本候选在该合同之上保留 exact typed meeting evidence hard gate、全字段 strict raw grammar、source/revision/lease/CAS/transaction safeguards 和 CalendarPage 320px 行为，新增运行证据只以本次 local exact evidence 为准，不证明真实飞书租户、provider、OAuth、生产数据或 Windows L5/L6。

## 产品最高边界

- 系统只自动发现、记录和管理任务，不自动执行数据分析或其他业务任务。
- 系统主人以外的人能看到的内容都属于对外动作，必须由系统主人确认。
- 飞书原文是来源事实，`describe` 是可重新生成的使用层摘要。
- 文件变化只能形成活动线索或候选产物，不能证明任务完成。

## DEC-01 负责人决策基线

Issue #66 的 7 条负责人决策已登记在 [DEC-01](decision-register.md)，机器事实源为 [decision-register.json](decision-register.json)。该登记固定 M1 SQLite、draft-only、上海自然日与日历候选边界、PR/独立复核、分阶段隐私删除和真实试点门禁；未决租户权限、隐私保留和规模触发项必须由主人决定，不得默认实现。当前登记的证据上限为 L0/L2/L4，L5 Windows 与 L6 真实飞书/LLM/provider 仍未验证。

当前登记的文档合同验证 ID 为 `VER-ISSUE66-DEC01-L0-20260816`；验证事实源见 [验证矩阵](verification-matrix.json)。

M1 与首轮试点固定为 draft-only；当前没有发送执行路径，只生成待主人审阅草稿和审计。旧库中的 approved/ready/sent 只作历史或 obsolete 展示，不能重新变为可执行发送；真实发送必须另开 Issue 并重新完成安全验收。main 与 integration 只通过 Pull Request 合入；安全改动需独立复核并由项目负责人最终批准。

## 当前主链

```text
主人 OAuth 可见且由主人启用的信息源 / 机器人补充入口 / 人工补录
  → 原始来源先耐久保存
  → LLM 分阶段判断消息动作与具体需求
  → 候选、需求线程或待确认记录
  → 系统主人接受为私人任务
  → 高置信内部维护，歧义和弱证据等待主人确认
  → SQLite 真账本与可重建任务记忆投影
```

详细行为和安全门见 [实施说明](implementation_brief.md)、[架构边界](architecture.md)、[安全与隐私](security_and_privacy.md) 与 [飞书接入说明](feishu-integration.md)。

## 事实源摘要

- 飞书原文是外部来源事实；本地只在已授权范围内保存受控来源记录。
- 当前 M1 实现使用本地 SQLite 保存来源、任务和审计；`describe`、文档上下文和任务记忆文件均是派生或可重建内容。
- 真实工作目录只通过 `reference path` 只读关联；系统不修改真实工作文件，也不依据文件活动自动完成任务。
- M1、主人单机试用和首个受控单用户试点继续使用 SQLite；只有多人、多设备或远程服务需求出现时才触发 PostgreSQL 评审。迁移与恢复合同见 [ADR 0008](adr/0008-versioned-sqlite-migrations.md)，开放项见 [待决定事项](open_decisions.md) 与 [Issue #66](https://github.com/Aki-zym/feishu-ai-pm/issues/66)。

对象级数据权威、状态机、错误合同和 ADR supersession 以 [领域合同](domain-contracts.md) 为准，本页不复制第二套定义。

## Windows 遗留安装包

本节只记录 Windows Electron/EXE 遗留载体的安装包和验证事实；当前使用从上面的 Cindy 插件与浏览器入口开始。

- 文件：`release/Feishu-AI-PM-0.2.0-x64-Setup.exe`。
- 产品/构建 source commit：`f9e77aec70aaa846047f987672c9171e0790846a`；artifact/record carrier ancestor：`3dcd9d0779542a7f3b6beebe73048273a0eff68a`。
- 精确大小、SHA-256、签名、发布状态和 Smoke 结果：验证 ID `VER-PACKAGE-020`。

本轮 exact product/build source 已重建正式 x64 NSIS，并对该精确包执行独立 Smoke（合成 userData；安装、启动、退出、旧库保留、新库重启、受控启动失败和卸载路径通过）；PR #81 后续 docs-only head、merge-ref 和 run/job 只证明证据 freshness，不改变包的 source 或 fingerprint。未取得签名或真实用户数据库升级证据。版本升级、签名、升级回退和 GitHub Release 门禁属于 [Issue #62](https://github.com/Aki-zym/feishu-ai-pm/issues/62)。

## Issue #56 Phase 1 候选

- Issue #38 DATA-04（PR #108 已普通合入 integration；本 follow-up 负责 post-merge docs freshness，验证 ID `VER-ISSUE38-DATA04-L4-20260818`）以 committed integration snapshot `aaaf8ed6693ade9d29b971a340be01e515b94939` 为基线，连续 schema v7 的 exact candidate head/virtual merge/tree 与新的 local exact evidence 绑定；迁移从旧 stacked schema-v6 候选改为连续 schema v7。v1-v6 descriptors/identities/checksums 与行为保持连续；v7 以 canonical immutable payload hash 覆盖 source_event_id、owner scope 和全部存储回放字段，source current pointer 与 append 在同一 SQLite transaction/CAS/fencing 内发布，ordered revision-set hash 含 revision hashes，legacy AI decisions 明确 `unreplayable_legacy` 且不伪造 prompt/model/config hash。Replay 先由一个 canonical decision-scope 校验器贯穿 decision→ordered revision references→source events→demand unit→candidate/task/thread→owner lineage，要求声明主来源属于精确多来源集合；现有但不相干的 foreign ID 不构成有效绑定。所有 scope/integrity 检查在 capability consumption 前完成，missing/mismatched/tampered/foreign scope 均 fail-closed、无正文泄漏、无业务或审计副作用且不消耗合法 capability。Replay route 的 capability/intent/origin/CSRF 预检只能缩小入口，服务层还必须从 durable current capability 状态独立校验 owner、decision/source scope、token/CSRF hash、固定 intent、expiry 与 revoked/consumed/replay 状态，并以 CAS 原子消费；missing/forged/expired/replayed capability 或 missing/tampered/foreign reference 均 fail-closed 且不产生业务副作用。privacy export/retention/hard-delete/backup/restore 继续覆盖 revision/reference。Issue #111 local exact evidence 是本轮权威证据，仍仅 synthetic/local L2-L4，不证明真实 Feishu、LLM/provider、生产数据或 Windows L5/L6。
- 生命周期 behavior/source：`a2b35f1e0042c95808f3e0df53fc24c350b15c3a`；最新 fresh Smoke 由 docs-only exact source `9fae562871e295b41c5f9c52fb0712ad0b61fad3` 构建，产品投影等价；该 Issue #56 候选当时基于 exact integration base `ad75b68687356a4782779b34ec35c60db68e05ea`，产品 fingerprint `58061eb32be2e3e4439acc3918e016e36112499be7ab1fd6d71fd408f25d417a`，`80` files；integration 引用见上方提交基线快照。
- 清理边界：`DesktopLifecycle → requestShutdown → disposeCore` 是唯一资源关闭链；`quitting` 只控制窗口关闭时隐藏或退出，`shutdownRequested` 防止重复进入退出请求，`shutdownComplete` 防止重复完成通知，不构成第二套状态机。
- 验证 ID：`VER-ISSUE56-LIFECYCLE-DRAFT-20260816`；仅为 synthetic userData 与隔离 Smoke 的 L2 证据，不是正式 release L5。
- Smoke 使用当前 integration 与纯 Issue #56 源码重新构建的临时 NSIS 包；不修改 Issue #80 的 database-path、server migration 或正式安装包证据。

## 验证状态

验证层级沿用 [Issue #59](https://github.com/Aki-zym/feishu-ai-pm/issues/59) 的 L0–L6 定义；changed-path 选择、skip 分类和 exact evidence provenance 以 [测试选层与证据门禁](test-selection.md)、`docs/verification-matrix.json.selection_policy` 和 `evidence_contract` 为准。当前可引用的记录：

- Issue #55 OUT-01 draft-only 状态闭环：`VER-ISSUE55-DRAFT-ONLY-L4-20260816`。仅证明合成 SQLite/service/API/UI 的草稿幂等、失效终止、脱敏 DTO 和无发送入口；不证明真实 provider、生产数据、Windows L5 或租户 L6。
- Issue #59 QA-01：`VER-ISSUE59-QA01-SELECTION-20260816`（统一 changed-path → L0–L6 选择、inventory/no-upload、skip 和 provenance 合同；本地 synthetic L4 已取得，当前 PR freshness 仍必须绑定 exact base/head/merge-ref/run/job；不提升 synthetic CI 到 Windows L5 或真实 L6）。
- Issue #65 GOV-01：`VER-ISSUE65-GOVERNANCE-L0-20260816`（handoff、RACI、CODEOWNERS、stacked PR 和可恢复协作 SOP；治理证据仅限本地结构检查与合成回归；GitHub branch protection/rulesets 按平台返回事实记录，不把不可用或单 owner 状态夸大为服务器独立复核）。
- Issue #59 门禁修复：exact provenance 现在要求完整 base/head/merge/tree SHA、`parents=[base,head]`、声明的 GitHub Actions run/job identity、attained exact 的 source=head、record↔provenance 交叉绑定及可用 Git 对象的真实 parents/tree 校验；本地 checker 不证明远端 repository、workflow/check、run/job、SUCCESS、event、head_sha 或 merge checkout，最终授权仍需 PR body 与 Lead anti-drift 远端 verifier 核验；远端 verifier 使用真实 GitHub API shape（run.name、job.workflow_name 可选、head commit 的 exact check-run ID，并读取 exact check-run API 对象校验 API URL、name、head/status/conclusion 和受控 details_url），apiBase 仅允许受控的 https://api.github.com 根地址且禁止重定向或 foreign host；私有仓库仅在显式 token 或 `GITHUB_TOKEN`/`GH_TOKEN` 存在时发送 Bearer header，token 不落盘或回显；无 token 的公共仓库仍可请求，401/403/404、网络或权限不可用时只能是 unavailable，不能授权通过。policy source、manifest、package、workflow、CI/证据/docs-check validator 变化强制 full + manual review，不能通过 docs-only 策略自我降级；`npm test` 默认执行三 workspace 全量 inventory，定向测试必须显式指定 workspace/测试文件并对非法目标 fail-closed。

- 源码检查：`VER-PR24-CHECK`（提交内历史 QA 记录，本 Issue 未重跑）。
- 浏览器 E2E：`VER-PR24-E2E`（提交内历史 QA 记录，本 Issue 未重跑）。
- Issue #60 集成组合：`VER-ISSUE60-E2E-20260815`（本地 L4 人工构造数据验证；48 passed、0 skipped；生命周期探针覆盖正常 nonce/ACK、ready 后与 ACK 前 code 0、端口冲突和启动失败；#52 的单次 503 放行由 fixture 共用纯 matcher，并有 10 条随 `npm run check` 执行的精确计数合同单测）。
- 工作台上海自然日、跨日覆盖与独立统计：`VER-ISSUE49-DASHBOARD-20260815`（L4；内存 SQLite 与合成浏览器数据，不代表 Electron 或真实外部连接）。
- Issue #57 外链策略：`VER-ISSUE57-URL-POLICY-20260815`（验证来源 commit `10a42dba8a0955ed13075ac6df5713cac3a2ddae` 已包含声明的完整测试资产，记录 commit 为 `5de44f56bbb0c41f592cceeef45dd7b7872f498f`；组合重基线后的证据仍仅为本地合成/浏览器 Mock L4，不代表真实 Electron、安装 EXE 或租户跳转）。
- Issue #35 SQLite 迁移与受管恢复：`VER-DATA01-SQLITE-MIGRATION-20260815`（合成 SQLite L2；桌面不自动调用该迁移路径）。
- Issue #58 最小可观测合同：`VER-ISSUE58-OBS-L2-20260815`（合成服务 L2 与浏览器 Mock L4；不代表真实 provider 或 Electron/NSIS）。
- Issue #61 CI 证据策略：`VER-ISSUE61-CI-20260815`（exact merge-ref CI、生命周期和浏览器 L4；失败产物不上传，受控摘要不等于阻止恶意代码自行输出）。
- Issue #64 领域合同：`VER-ISSUE64-CONTRACT-L1-20260815`（静态 L1；JSON、生成 Markdown、状态绑定、fresh-schema DDL 和 ADR 一致性，不证明运行时恢复或旧库升级）。
- Issue #40 Feishu 业务码与详情阶段保护：`VER-ISSUE40-FSH02-L3-20260816`（PR #68 已合入、Issue #40 已关闭；Mock/契约与 exact merge-ref CI 的 L3 证据仍不代表真实租户或 provider）。
- Issue #31 模拟消息路由隔离：历史 PR #71 记录了 `buildApp`/Electron 404 与来源/候选零写入边界；该 helper 候选仍待 PR 合入 integration，不证明 Windows 安装 EXE 或真实租户/provider。
- Issue #50 排期日历和安全撤销：`VER-ISSUE50-CALENDAR-20260815`（合成 SQLite/API/浏览器 L4；不代表真实飞书 Calendar 或 Windows 安装）。
- Issue #80 旧库保留与新库启动：`VER-ISSUE80-NEW-DATABASE-STARTUP-20260815`（合成 userData、桌面单元与隔离安装 Smoke L2/L4；证明旧文件 hash 不变、新库可重启、配置保留和固定脱敏错误，不代表真实用户数据库、完整 Windows L5 或真实租户 L6）。
- 六 PR 集成组合：`VER-INTEGRATION-BATCH-20260815`（隔离 integration 工作树的合成 L4；`npm run check`、生命周期 5/5、Playwright 62/0 已通过，远端 integration CI 仍须绑定最终推送 SHA）。
- Windows 包：`VER-PACKAGE-020`（目标 L5；取得 L2 合成 userData/精确包隔离 Smoke，未声称完整 L5 用户验收）。
- 基础 OAuth/主人身份：`VER-OAUTH-OWNER-20260811`（目标 L6；只有历史人读声明，无独立 run ID，未取得可独立复验的证据层级）。
- 模型连接检查：`VER-LLM-CONNECTION-20260811`（目标 L6；只有历史人读声明，无独立 run ID，未取得可独立复验的证据层级）。
- 目标租户完整范围：`VER-FEISHU-TARGET-TENANT`（目标 L6；未运行、未取得证据）。
- 已安装 EXE 的真实供应商错误诊断脱敏：`VER-DIAGNOSTICS-REAL-EXE`（目标 L6；未运行、未取得证据）。
- 已安装 EXE 的真实系统浏览器外链策略：`VER-EXTERNAL-LINK-REAL-EXE`（目标 L5；未运行；合成单元/浏览器 Mock 不能替代）。

完整字段和限制见 [验证矩阵](verification-matrix.md)。Mock、契约、回放、浏览器 E2E 和安装包构建都不能替代 L6 真实租户/provider 验收。

## 开放问题

- 目标租户权限、P2P/群历史范围、日历、妙记、Docx/Wiki、限流、撤权和密集对话仍需 L6 验收。
- 已安装 EXE 对真实供应商错误的诊断读取与导出脱敏仍需 L6 验收；合成夹具不能替代。
- 数据保留、隐私硬删除、用户导出、完整灾备产品和多设备仍未闭环；当前受管迁移备份只解决本机 schema 升级恢复。
- M1 继续 SQLite 已确定；PostgreSQL 只在多人、多设备或远程服务触发后另行评审。对外动作的 draft-only 范围已经固定，开发者不得自行放宽。
- 完整 Windows L5 用户验收、签名、升级回退和发布渠道仍未完成；本轮仅取得精确包的合成 userData/隔离安装 Smoke。
- 完整 UI→IPC→provider→cursor→source→job→task trace、磁盘/新鲜度/backoff/queue readiness 与高级观测 UI 仍不在当前最小可观测范围。
- 真实 Electron `shell.openExternal`、系统默认浏览器行为、租户文档域和服务端重定向最终地址仍需 L5/L6 验收。

开放项的详细原文只维护在 [待决定事项](open_decisions.md) 和对应 GitHub Issue；本页只保留状态摘要。

## 项目与历史入口

- 仓库首页 [README](../README.md) 只说明痛点、能力、用法和文档入口；实现阶段、安装包和验证数字仍以本页为准。
- 从 [项目地图](project-map.md) 查实现目录、稳定合同、测试位置和文档影响。
- 从 [文档入口](README.md) 按工作类型选择必读材料。
- 用户可见历史只进 [CHANGELOG](../CHANGELOG.md)；逐次验证历史只进 [QA 记录](qa/README.md)。
