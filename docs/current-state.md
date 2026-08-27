# 当前状态

> 当前运行入口（2026-08-27）：独立 `apps/server` 监听 `127.0.0.1:4310`，管理 Aily OAuth、TokenStore、官方 `@larksuiteoapi/node-sdk@1.73.0`、20 分钟扫描调度、schema v9 SQLite inbox 和 `apps/web` 任务台。根目录 `AGENT_INSTALL.md` 提供从 GitHub clone 到用户自有飞书应用、Aily Agent、OAuth、Cindy 插件和首次扫描验收的完整 Agent 安装合同。Cindy `plugins/cindy-pm-intake` `0.7.0` 是薄控制插件，只快速触发手动扫描，并每 5 分钟领取一条 ready 摘要派 intake errand。旧桌面壳、安装包、XD Feishu、飞书 MCP 和旧 Feishu/LLM 分类链只作为历史证据保留。

> 2026-08-18 FSH-03 candidate refresh：PR #108 / Issue #38 及其 docs follow-up 的 integration provenance 属于历史证据；当前工作树未绑定 live integration tip。当前 product-source fingerprint 以本轮 docs 生成结果为准；v1-v7 descriptor/checksum 与行为保持连续。

> 这是仓库中回答“现在是什么”的唯一人读入口。机器入口、生成视图和历史位置由 [文档清单](docs-manifest.json) 声明；测试数字、运行环境和安装包 hash 只以 [验证矩阵](verification-matrix.md) 中的验证 ID 为准。

## 当前实现快照

- 原始审计快照日期：`2026-08-14`；该日期只表示 Issue #63 首次审计当时的文档快照，不能证明后续组合分支或 CI。
- 组合重基线日期：`2026-08-15`；组合基线 `integration/m1-test-20260815` @ `635290379de2688187988692ecb619c9c109e100` 仅作历史快照。当前工作树未绑定 live integration tip，integration 声明类型为 `unbound`，当前分支的 integration provenance 需在真实合入后重新绑定。历史冻结产品基线为 `c872c0f9534b1a8b7ad2fcde9551efcba503ad46`。
- PR #81 最新精确事件 base：同一分支在该 PR 中的事件 base 为 `integration/m1-test-20260815` @ `f7bdf11bf2578f130f2443c6f67d6d004b82b394`；它是本次 exact merge/event 证据的起点，不替代提交基线快照。
- Issue #59 QA-01 已由 PR #90 纳入 integration，PR #107 补齐严格声明与 integration push 第一父提交例外；本修复继续使用上述 committed snapshot，并由 CI 额外绑定 GitHub 关联已合入 PR head、merge tree 与 live merge freshness，不把未来 merge SHA 追写回提交文档。
- Issue #62 REL-01（验证 ID `VER-ISSUE62-REL01-GATE-20260816`）的 Windows L5 release-gate 基础设施已实现，但正式 owner-authorized 证书、signed artifact、GitHub Release 与 signed N-1/N upgrade/rollback 仍是外部阻塞；manifest 对 unsigned temporary smoke 保持 `authorization=false` / `pending`。
- Issue #111 QA-02 已完成并 POST_MERGE_STABLE：完全本地 exact verification 以隔离 worktree、完整 base/head/virtual-merge/tree、Git 重算 changed-path/plan、canonical required gates、严格 schema、守恒计数、脱敏日志、环境版本、artifact/log hash、唯一 generation/lock/CAS pointer 和 candidate fingerprint 为边界；本地 evidence 不伪装成 GitHub Actions，仍不声明真实租户或 Windows L5/L6。Issue #111 已关闭。
- PR #84 合入前的 exact integration base：`integration/m1-test-20260815` @ `ad75b68687356a4782779b34ec35c60db68e05ea`；旧 `e4c2b1335664429e354015b2131427dc277f0c7b` 与 `f7bdf11bf2578f130f2443c6f67d6d004b82b394` 仅作为历史候选 base，不能用于最终批准。
- 上一轮候选产品源码快照为 `product-source-sha256-v1` / `6e2e398e6471fbbd7b08ba128a6bf518736139bd5ba6f4e895ae2367c2586dd9`，纳入 `84` 个文件；该历史 source 与当前合并候选投影分层记录。Issue #80 正式包的产品/构建 source 仍为 `f9e77aec70aaa846047f987672c9171e0790846a`。
- 当前候选产品源码权威指纹以本轮 `docs:generate` 结果为准；本轮包含独立 TooManyTasks OAuth/TokenStore/Aily SDK、持久窗口和 Cindy 薄插件入库合同。本轮 exact evidence 必须以机器清单中的 fingerprint 与 live integration tip 一致为前提。

- 产品路径选择器：`apps-workspace-default-include-v1`。
- 产品/构建 source commit：`f9e77aec70aaa846047f987672c9171e0790846a`；它是正式安装包所对应的产品实现来源，不是本轮 PR 证据 head。
- PR #81、PR #83、PR #84 与旧 PR #82 的最终 docs/evidence head、merge-ref、parents 与 run/job 只用于历史证据新鲜度，写在各自 PR body，不替代产品/构建 source；PR #86 / Issue #36 与 PR #87 / Issue #42 已合入/关闭，PR #87 的 exact head、merge-ref、parents 与 run/job 仅作为历史 provenance。PR #86 当前 base 为 `integration/m1-test-20260815` @ `ebe682aeae067bbf08a6f38ea39de17adceb9ac0`，仅作历史 provenance。
- Issue #29 目标快照竞态修复行为/source 为 `60e10b1f1f9df0c9580772487e07b623e600a03e`；该提交是基于当前 integration tip 的普通 merge，包含 owner snapshot schema/CAS 兼容和退休目标 stale 结算修复。最终 exact head/merge-ref/tree/parents/run/job 以 PR #93 body 绑定；旧 head/CI 仅作 historical evidence。
- Issue #45 / PROD-01 已由 PR #92 合入并 POST_MERGE_STABLE；默认候选、任务、线程、提案、主人信息和操作回执使用严格最小 DTO，不返回来源正文、稳定/外部 ID、provider/raw error 或未经核验自由文本。安全派生摘要仅对长度门槛的整段/近整段复制、NFKC/跨空白复现、结构化 Feishu/Docx token、URL/路径、UUID 和 secret-like token fail-closed；主人核验仍为显式、task-scoped、私有审计且 `external_action: none`，仅核验本地保存快照并返回带时间的 provider unknown/last-known 状态。验证 ID 为 `VER-ISSUE45-PROD01-SOURCE-PRIVACY-L4-20260816`；证据仅 synthetic/local L2-L4，不外推真实租户、provider、Windows L5 或 L6。
- 产品阶段：`M1：本机任务库与 Cindy 插件入口维护`。
- Issue #40 的 PR #68 已合入且 Issue 已关闭。
- 当前使用入口：独立 TooManyTasks + 浏览器 + Cindy 薄插件，默认地址为 `http://127.0.0.1:4310`。
- 当前阶段名称：`独立任务台与 Cindy 薄插件`；当前载体：`TooManyTasks 本机服务 + Cindy 薄插件 + SQLite`；当前 artifact 验证 ID：`VER-AILY-SDK-ISOLATED-20260827`。
- TooManyTasks 扫描链：服务端 20 分钟 scheduler 或 Cindy 手动命令 → 后台窗口 Prompt 与官方 Aily SDK → Aily 派生摘要 → SQLite `aily_summary_inbox` → Cindy 插件 5 分钟轮询 → 固定 `sessionKey: "intake"` 的 errand → `get_pm_tasks` + `submit_intake` → SQLite 事务原子标记 inbox completed。Aily 空摘要写入 completed 空窗审计并推进扫描游标；Aily 失败不推进扫描游标；Cindy 失败进入 inbox 退避，不阻塞后续 Aily 窗口。
- TooManyTasks 本轮本地合成验证：`VER-AILY-SDK-ISOLATED-20260827`，覆盖服务端 OAuth/TokenStore、SSE、窗口、插件 API 边界、脱敏、SQLite 合同、薄插件打包，以及 Agent 首次安装脚本的配置、状态、私有集成令牌和隔离生命周期；真实飞书后台应用创建、真实 Aily Agent 创建与发布、真实 OAuth、真实 Cindy 宿主安装和 Windows L5/L6 仍未验证。
- 当前浏览器设置页管理 Aily 应用配置、用户 OAuth 和本机任务库运行选项；Cindy 插件不启动后台，也不保存任何 Aily 或集成凭证。
- Windows Electron EXE 属于遗留载体，仅用于安装包证据和维护验证；React 网页界面继续由浏览器入口提供。
- 产品版本：`0.2.0`。
- server Vitest 门禁固定使用 single-thread threads pool、`--no-file-parallelism` 与单 worker；默认 5 秒 test timeout 仍保留，不通过提高 timeout 掩盖迁移或 worker 收尾问题。JSON 报告只有在子进程真实 zero exit、无失败测试且至少有一项通过时才算通过。





commit 只提供精确产品快照的导航线索，可能因后续 squash/merge 改变；机器每次都以确定性的产品源码指纹比对被审工作树，并与 [文档清单](docs-manifest.json) 和 [验证事实源](verification-matrix.json) 交叉检查。产品源码或运行配置变化时，三处必须一起更新，否则 CI 失败。当前候选产品投影算法为 `product-source-sha256-v1`，选择器为 `apps-workspace-default-include-v1`，fingerprint 为 `20d905583d11ae5ca220bee5f2e1ffbf61349947859c9e8989f12ca4d34c0ed0`，纳入 `53` 个文件，快照日期为 `2026-08-15`；本轮暂不绑定等价参照 commit。当前 exact base/head/merge-ref/parents/tree/run/job 只以本轮 Draft PR provenance 为准，不把历史 PR 的 CI 当作当前候选授权。
Issue #42 RUN-01 已合入 integration；Runtime 支持可复用 provider checkpoint、SQLite 工具审计原子落库、AbortSignal、有界续租和 exact lease fence，失效或迟到回调不能写入完成状态、checkpoint 或业务结果。RUN-01 的 `external.send` claim/幂等恢复仅作为历史审计兼容和未来独立发送 Issue 的保留结构，M1 当前 policy 永久固定为 `forbidden`：即使 `approved=true` 或存在幂等键，也不创建外部 claim、不调用 provider、不执行 callback。当前 v1/v2 schema identity 与 DATA-02 v2 合同保持不变，RUN-01 使用连续 v3 migration；正式验证 ID、commit、环境与限制以已合入 PR #87 的历史 provenance 为准，不代表真实 provider、飞书租户或 Windows L5。


## 产品最高边界

- 系统只自动发现、记录和管理任务，不自动执行数据分析或其他业务任务。
- 系统主人以外的人能看到的内容都属于对外动作，必须由系统主人确认。
- 飞书原文是来源事实，`describe` 是可重新生成的使用层摘要。
- 文件变化只能形成活动线索或候选产物，不能证明任务完成。

## DEC-01 负责人决策基线

Issue #66 的 7 条负责人决策已登记在 [DEC-01](decision-register.md)，机器事实源为 [decision-register.json](decision-register.json)。该登记固定 M1 SQLite、draft-only、上海自然日与日历候选边界、PR/独立复核、分阶段隐私删除和真实试点门禁；未决租户权限、隐私保留和规模触发项必须由主人决定，不得默认实现。当前登记的证据上限为 L0/L2/L4，L5 Windows 与 L6 真实飞书/LLM/provider 仍未验证。


M1 与首轮试点固定为 draft-only；当前没有发送执行路径，只生成待主人审阅草稿和审计。旧库中的 approved/ready/sent 只作历史或 obsolete 展示，不能重新变为可执行发送；真实发送必须另开 Issue 并重新完成安全验收。main 与 integration 只通过 Pull Request 合入；安全改动需独立复核并由项目负责人最终批准。

## 当前主链

```text
TooManyTasks 定时调度或 Cindy 手动扫描
  → apps/server 使用官方 Aily SDK
  → 独立服务写入 SQLite inbox
  → Cindy Worker 每 5 分钟领取 ready 摘要
  → 固定 `sessionKey: "intake"` 的 Cindy errand
  → Cindy 读取本地 `get_pm_tasks` 快照并调用 `submit_intake`
  → 候选、需求线程或待确认记录
  → 系统主人接受为私人任务
  → 高置信内部维护，歧义和弱证据等待主人确认
  → SQLite 真账本与可重建任务记忆投影
```

人工补录与任务台操作仍直接进入本机服务；它们不改变扫描阶段的 Aily 独立授权边界。

详细行为和安全门见 [实施说明](implementation_brief.md)、[架构边界](architecture.md)、[安全与隐私](security_and_privacy.md) 与 [飞书接入说明](feishu-integration.md)。

## 事实源摘要

- 当前扫描保存的是 Aily 返回的派生摘要，带窗口、Agent 和生成时间标记，不能冒充逐条飞书原文；历史直接来源记录仍按原有合同保留。
- 当前 M1 实现使用本地 SQLite 保存来源、任务和审计；`describe`、文档上下文和任务记忆文件均是派生或可重建内容。
- 真实工作目录只通过 `reference path` 只读关联；系统不修改真实工作文件，也不依据文件活动自动完成任务。
- M1、主人单机试用和首个受控单用户试点继续使用 SQLite；只有多人、多设备或远程服务需求出现时才触发 PostgreSQL 评审。迁移与恢复合同见 [ADR 0008](adr/0008-versioned-sqlite-migrations.md)，开放项见 [待决定事项](open_decisions.md) 与 [Issue #66](https://github.com/Aki-zym/feishu-ai-pm/issues/66)。

对象级数据权威、状态机、错误合同和 ADR supersession 以 [领域合同](domain-contracts.md) 为准，本页不复制第二套定义。

## Windows 遗留安装包

本节只记录 Windows Electron/EXE 遗留载体的安装包和验证事实；当前使用从上面的独立 TooManyTasks、浏览器和 Cindy 薄插件入口开始。

- 文件：`release/Feishu-AI-PM-0.2.0-x64-Setup.exe`。
- 产品/构建 source commit：`f9e77aec70aaa846047f987672c9171e0790846a`；artifact/record carrier ancestor：`3dcd9d0779542a7f3b6beebe73048273a0eff68a`。

本轮 exact product/build source 已重建正式 x64 NSIS，并对该精确包执行独立 Smoke（合成 userData；安装、启动、退出、旧库保留、新库重启、受控启动失败和卸载路径通过）；PR #81 后续 docs-only head、merge-ref 和 run/job 只证明证据 freshness，不改变包的 source 或 fingerprint。未取得签名或真实用户数据库升级证据。版本升级、签名、升级回退和 GitHub Release 门禁属于 [Issue #62](https://github.com/Aki-zym/feishu-ai-pm/issues/62)。

## Issue #56 Phase 1 候选

- 生命周期 behavior/source：`a2b35f1e0042c95808f3e0df53fc24c350b15c3a`；最新 fresh Smoke 由 docs-only exact source `9fae562871e295b41c5f9c52fb0712ad0b61fad3` 构建，产品投影等价；该 Issue #56 候选当时基于 exact integration base `ad75b68687356a4782779b34ec35c60db68e05ea`，产品 fingerprint `58061eb32be2e3e4439acc3918e016e36112499be7ab1fd6d71fd408f25d417a`，`80` files；integration 引用见上方提交基线快照。
- 清理边界：`DesktopLifecycle → requestShutdown → disposeCore` 是唯一资源关闭链；`quitting` 只控制窗口关闭时隐藏或退出，`shutdownRequested` 防止重复进入退出请求，`shutdownComplete` 防止重复完成通知，不构成第二套状态机。
- Smoke 使用当前 integration 与纯 Issue #56 源码重新构建的临时 NSIS 包；不修改 Issue #80 的 database-path、server migration 或正式安装包证据。

## 验证状态

验证层级沿用 [Issue #59](https://github.com/Aki-zym/feishu-ai-pm/issues/59) 的 L0–L6 定义；changed-path 选择、skip 分类和 exact evidence provenance 以 [测试选层与证据门禁](test-selection.md)、`docs/verification-matrix.json.selection_policy` 和 `evidence_contract` 为准。当前可引用的记录：

- Issue #59 门禁修复：exact provenance 现在要求完整 base/head/merge/tree SHA、`parents=[base,head]`、声明的 GitHub Actions run/job identity、attained exact 的 source=head、record↔provenance 交叉绑定及可用 Git 对象的真实 parents/tree 校验；本地 checker 不证明远端 repository、workflow/check、run/job、SUCCESS、event、head_sha 或 merge checkout，最终授权仍需 PR body 与 Lead anti-drift 远端 verifier 核验；远端 verifier 使用真实 GitHub API shape（run.name、job.workflow_name 可选、head commit 的 exact check-run ID，并读取 exact check-run API 对象校验 API URL、name、head/status/conclusion 和受控 details_url），apiBase 仅允许受控的 https://api.github.com 根地址且禁止重定向或 foreign host；私有仓库仅在显式 token 或 `GITHUB_TOKEN`/`GH_TOKEN` 存在时发送 Bearer header，token 不落盘或回显；无 token 的公共仓库仍可请求，401/403/404、网络或权限不可用时只能是 unavailable，不能授权通过。policy source、manifest、package、workflow、CI/证据/docs-check validator 变化强制 full + manual review，不能通过 docs-only 策略自我降级；`npm test` 默认执行三 workspace 全量 inventory，定向测试必须显式指定 workspace/测试文件并对非法目标 fail-closed。

- Issue #31 模拟消息路由隔离：历史 PR #71 记录了 `buildApp`/Electron 404 与来源/候选零写入边界；该 helper 候选仍待 PR 合入 integration，不证明 Windows 安装 EXE 或真实租户/provider。
- 已安装 EXE 的真实系统浏览器外链策略：`VER-EXTERNAL-LINK-REAL-EXE`（目标 L5；未运行；合成单元/浏览器 Mock 不能替代）。

完整字段和限制见 [验证矩阵](verification-matrix.md)。Mock、契约、回放、浏览器 E2E 和安装包构建都不能替代 L6 真实租户/provider 验收。

## 开放问题

- Aily Agent 的已发布技能、用户 Token 权限、消息/日历/文档/知识库覆盖、限流和撤权行为仍需在独立 TooManyTasks + Cindy 薄插件真实端到端验收；本地合成测试不能替代该验收。
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
