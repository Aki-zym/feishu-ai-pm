<!-- 此文件由 scripts/docs-check.mjs --write 根据 verification-matrix.json 生成。不要手工修改。 -->

# 验证矩阵

机器事实源：[`docs/verification-matrix.json`](verification-matrix.json)。当前产品状态见 [当前状态](current-state.md)。
产品源码快照：日期 `2026-08-15`；等价 commit `null`；算法 `product-source-sha256-v1`；选择器 `apps-workspace-default-include-v1`；文件数 `53`；fingerprint `c4592dc568ae2de6d93b9852cd3308dd8d3f10ca00eef00f483dd6d7ee30d837`。

## L0–L6

层级定义沿用 GitHub Issue #59 (QA-01)，低层级不能替代高层级。

| 层级 | 名称 | 环境 | 不能证明 |
|---|---|---|---|
| L0 | 静态检查 | 文档、脚本和仓库元数据 | 代码运行、安装包行为或真实外部连接 |
| L1 | 单元测试 | 单进程、人工构造输入 | SQLite/服务闭环、浏览器、Windows 安装或真实外部连接 |
| L2 | SQLite / 服务集成 | 本地 SQLite、服务接口和人工构造数据 | 飞书/LLM 真实行为、浏览器或 Windows 安装 |
| L3 | 契约回放 | Mock、契约适配器或脱敏固定回放 | 真实飞书租户、真实 LLM provider 或生产数据 |
| L4 | 独立数据库浏览器 E2E | 本地独立数据库、浏览器和人工构造数据 | Windows 安装生命周期或真实外部连接 |
| L5 | Windows 隔离安装 Smoke | 待验证精确 hash 的 Windows 安装包 | 真实飞书租户或真实 LLM provider |
| L6 | 真实租户 / provider 人工验收 | 明确授权的真实外部环境和受限步骤 | 未列入本次 scope 的其他真实能力 |

## Changed-path 选择门禁

以下规则来自 `verification-matrix.json.selection_policy`，是 CI 选层的唯一机器事实源；unknown、mixed 和 high-risk path 一律 fail-closed，且不能直接授权 broad claim。

| category | minimum level | risk | required evidence | manual review |
|---|---|---|---|---|
| docs-only | L0 | low | docs_check | no |
| test-ci-only | L1 | medium | unit_inventory, exact_provenance | no |
| qa-control-plane | L4 | high | unit_inventory, contract_replay, exact_provenance | yes |
| server-data-runtime | L2 | high | unit_inventory, service_integration, exact_provenance | yes |
| cindy-plugin | L3 | high | contract_replay, scope_guard, exact_provenance | yes |
| web | L4 | high | unit_inventory, browser_e2e, exact_provenance | yes |
| unknown | L6 | high | path_review, exact_provenance | yes |

Path category precedence：docs → QA control → Cindy plugin → test/CI → web → server/data/runtime → unknown。空 diff、绝对路径、父目录逃逸和无法识别路径不属于 docs-only。

## Skip 与 provenance 合同

证据记录合同 schema 1：evidence_status=attained 必须绑定 source_commit、实际 run、environment 和 provenance；新增或修改记录以及所有 attained 记录必须声明 evidence_contract_version=1、严格 provenance/skip 字段集合和 exact sentinel 组合；exact_merge_ref_ci 的本地 checker 仅证明声明的 run/job identity 与本地 Git 对象、parents/tree/source/head 绑定，不证明 GitHub Actions、repository、workflow/check、SUCCESS、event、head_sha 或 merge checkout 的真实性；可选远端 verifier 必须绑定 repository-scoped API 路径、run.repository.full_name（若存在）、run/job、workflow/check、pull_request、terminal SUCCESS、base/head/merge commit objects、merge-ref parents/tree 和 source=head，commit/job 响应不虚构 repository 字段；run 使用真实 name/workflow_id，job.workflow_name 仅在存在时校验；job.check_run_url 必须是受控的 exact check-run ID，直接读取该 ID 的 exact check-run API 对象，不依赖 head commit check-runs 列表或分页，并绑定 API URL、ID、name、head_sha、status/conclusion 和受控 GitHub details_url；apiBase 必须是受控的 https://api.github.com 根地址，禁止重定向或 foreign host；私有仓库只能在显式 token 参数或 GITHUB_TOKEN/GH_TOKEN 环境变量存在时发送 Bearer Authorization，token 不得写入、返回或日志输出；无 token 的公共仓库请求仍可用，401/403/404、网络或权限不可用时固定返回 unavailable；不查询 synthetic merge commit 的 check-runs，merge commit 不需要 check-run；缺少 verifier 或离线时返回 unavailable 而不是授权通过；最终授权必须由 PR body 与 Lead 的远端 anti-drift 核验绑定；not_run/historical 不能声明 attained 或 real environment。

| skip kind | 语义 |
|---|---|
| none | 本轮没有跳过测试；不能用空 inventory 或未执行替代通过。 |
| capability | 环境能力不存在时的明确限制；不等同于测试通过，也不抬高已取得层级。 |
| platform | 当前 runner/操作系统不支持时的明确限制；不等同于测试通过，也不抬高已取得层级。 |
| not_executed | 应执行但未执行或证据缺失；必须 fail-closed，不能写成 passed。 |

## 当前证据索引

| 验证 ID | 能力 | 目标层级 | 已取得层级 | 证据状态 | Evidence type | Source commit | Run | 真实环境证据 |
|---|---|---|---|---|---|---|---|---|
| VER-ISSUE85-PROD07-L0-20260816 | PROD-07 日历事实与任务候选分类产品规则合同及合成夹具 | L0 | L0 | 实际运行证据已取得 | static_document_contract | 4e7eebd979bc1c6de89906d4c74e3d5a1ee7ae5c | local-issue85-prod07-contract-r3-20260816 | 未取得 |
| VER-ISSUE59-QA01-SELECTION-20260816 | QA-01 changed-path → L0-L6 选择、执行清单、skip 语义、exact provenance、integration 普通合并 push 第一父/已合入 PR head/tree 例外与 no-upload 边界 | L4 | L4 | 实际运行证据已取得 | ci_selection_and_evidence_contract | 79ed1142cccceefed7391c605b70752c6610c30d | local-issue59-integration-push-hotfix-20260816-02 | 未取得 |
| VER-ISSUE66-DEC01-L0-20260816 | DEC-01 M1 产品与治理负责人决策登记及结构化文档合同 | L0 | L0 | 实际运行证据已取得 | static_document_contract | 06f45f0e47edbc8b599fdf4f9bd94afb402f850d | pull_request_94_pending | 未取得 |
| VER-PR24-CHECK | PR #24 源码类型检查、自动测试与构建 | L2 | 未取得 | 历史 QA 报告；本次未独立复验 | committed_qa_record | 8b6869b89323a79a31636a1290b9712e2127f0c6 | unrecorded | 未取得 |
| VER-PR24-E2E | PR #24 浏览器端到端主流程 | L4 | 未取得 | 历史 QA 报告；本次未独立复验 | committed_qa_record | 8b6869b89323a79a31636a1290b9712e2127f0c6 | unrecorded | 未取得 |
| VER-ISSUE60-E2E-20260815 | Issue #60 独立浏览器状态、安全 bridge 回归、nonce/ACK 生命周期门禁与 fixture 共用纯 matcher 的精确 console 错误放行 | L4 | L4 | 实际运行证据已取得 | local_synthetic_check_and_browser_e2e | ce12979d6cc3b6d716d152b30a53e8830483950b | local-pr70-b3-committed-matcher-tests-e62f6c4-20260815-01 | 未取得 |
| VER-ISSUE49-DASHBOARD-20260815 | 工作台上海自然日、跨日覆盖与独立统计 | L4 | L4 | 实际运行证据已取得 | synthetic_unit_service_and_browser_tests | 9888124cf03029a379dc88d6ce1edb31dbf40d0f | local-20260815-issue49 | 未取得 |
| VER-ISSUE57-URL-POLICY-20260815 | Issue #57 renderer 预检、document-only IPC、Electron main 二次校验、OAuth/文档组件 allowlist 与脱敏拒绝反馈 | L5 | L4 | 实际运行证据已取得 | local_synthetic_check_and_browser_e2e | 10a42dba8a0955ed13075ac6df5713cac3a2ddae | local-pr74-rebase-c872-20260815-01 | 未取得 |
| VER-DATA01-SQLITE-MIGRATION-20260815 | 版本化 SQLite 迁移、升级前备份、失败恢复与 downgrade gate | L5 | L2 | 实际运行证据已取得 | synthetic_sqlite_integration_run | 4c19de2477efa4166c0d6e8ab71f70d3f8ba2a22 | local-pr76-c872c0f-4c19de2-20260815-07 | 未取得 |
| VER-DATA02-RELATIONS-L2-20260816 | Issue #36 DATA-02 四层关系约束、durable integrity gap 纠正闭环、完整审计链与安全 DTO | L2 | L2 | 实际运行证据已取得 | local_synthetic_sqlite_service_and_migration_tests | 0c0da70741f3ea9fbe42b1e13f7ba97c3e21df91 | pull_request_86_pending | 未取得 |
| VER-DATA03-CANDIDATE-CAS-L2-20260816 | Issue #37 DATA-03 candidate version/CAS、全入口冲突语义与 CandidatesPage 刷新代际 | L2 | L2 | 实际运行证据已取得 | local_synthetic_sqlite_service_http_and_resource_state_tests | 7cbb899017bcb5d577f3648442719ff4fa2d1efc | pull_request_100_pending | 未取得 |
| VER-ISSUE62-REL01-GATE-20260816 | Windows L5 release manifest、签名授权、精确 artifact provenance、安装升级回退与严格清理门禁基础设施 | L5 | 未取得 | 未运行；未取得证据 | open_validation_item | unverified | not_run | 未取得 |
| VER-ISSUE58-OBS-L2-20260815 | Issue #58 最小可观测合同：封闭同步 DTO、四态设置提示、readiness、编译期 release identity、后端 ID 和 canary 非泄漏 | L2 | L2 | 实际运行证据已取得 | local_synthetic_check | 38d3c05e047b341b243efcaa4aeda726c6da9e52 | local-issue58-observability-20260815-04 | 未取得 |
| VER-ISSUE61-CI-20260815 | Issue #61 fail-closed CI 选层、精确 merge-ref、执行清单核验、单次构建复用与 no-upload 受控失败日志 | L4 | L4 | 实际运行证据已取得 | exact_merge_ref_ci_and_local_synthetic_browser_e2e | e311403848cdb51ccbeba4f772ad1f72d2e74ad7 | github-actions-31883329714-job-95008835562 | 未取得 |
| VER-ISSUE50-CALENDAR-20260815 | 排期日历上海自然日、安全 DTO、有界跨日展开、坏数据隔离、纠错与自动更新撤销运行时快照、candidate revision payload/business-state 边界、终态可见性 | L4 | L4 | 实际运行证据已取得 | synthetic_unit_service_and_browser_tests | e6303ec809d5f6e2efae0f578f7a4e0dbbbada6b | local-20260815-issue50 | 未取得 |
| VER-INTEGRATION-BATCH-20260815 | 六个独立批准 PR 在 integration/m1-test-20260815 上的组合兼容性与完整回归 | L4 | L4 | 实际运行证据已取得 | local_exact_integration_check_and_synthetic_browser_e2e | 32485c4dc335b4b258629b70f1d49d5a563eff71 | local-integration-batch-20260815-01 | 未取得 |
| VER-ISSUE40-FSH02-L3-20260816 | Issue #40 FSH-02 飞书业务码统一守卫、transport Error 分类、详情失败阻塞与 cursor/checkpoint 保护 | L3 | L3 | 实际运行证据已取得 | exact_merge_ref_ci_and_local_synthetic_browser_e2e | bb93cfd10c9c2872ec262b9ca1f724f5acc84143 | github-actions-31926031864-job-95113622400 | 未取得 |
| VER-ISSUE56-LIFECYCLE-DRAFT-20260816 | Issue #56 Phase 1 desktop startup, single-instance, config reload, OAuth callback server, tray, runtime recovery and exit lifecycle | L5 | L2 | 实际运行证据已取得 | synthetic_desktop_unit_and_isolated_installer_smoke | 9fae562871e295b41c5f9c52fb0712ad0b61fad3 | local-issue56-lifecycle-smoke-20260816-08 | 未取得 |
| VER-ISSUE51-UI-L4-20260816 | Issue #51 前端异步状态：加载、失败、成功为空、成功有数据、陈旧刷新与集成健康分区 | L4 | L4 | 实际运行证据已取得 | local_synthetic_check_and_browser_e2e | 18ea5ea606cc5bc31e31ae68d6aa52b3f5a37fc8 | local-issue51-ui-20260816-05 | 未取得 |
| VER-PACKAGE-020 | Windows 0.2.0 内部测试安装包 | L5 | L2 | 实际运行证据已取得 | synthetic_user_data_and_isolated_installer_smoke | f9e77aec70aaa846047f987672c9171e0790846a | local-issue80-formal-package-smoke-20260816-01 | 未取得 |
| VER-ISSUE64-CONTRACT-L1-20260815 | Issue #64 领域合同 JSON、完整生成 Markdown 与 checker：术语、数据权威、状态机、CAS/恢复、稳定 error/outcome 与 ADR supersession | L1 | L1 | 实际运行证据已取得 | local_synthetic_schema_and_docs_check | 4c123da777a2914b040cec6d0a654ea07dae9dba | local-issue64-contract-20260815-01 | 未取得 |
| VER-OAUTH-OWNER-20260811 | 飞书 OAuth、Token 保存与系统主人身份读取 | L6 | 未取得 | 历史声明；未独立复验 | historical_documented_claim | unverified | unrecorded | 未取得 |
| VER-LLM-CONNECTION-20260811 | DeepSeek 连接检查 | L6 | 未取得 | 历史声明；未独立复验 | historical_documented_claim | unverified | unrecorded | 未取得 |
| VER-FEISHU-TARGET-TENANT | 目标租户 P2P、群、日历、妙记与 Docx/Wiki 范围 | L6 | 未取得 | 未运行；未取得证据 | open_validation_item | 3a35cb4cd34fa419803daf5019f1ea747c7a8e8f | not_run | 未取得 |
| VER-DIAGNOSTICS-REAL-EXE | 已安装 EXE 对真实供应商错误的诊断包递归脱敏 | L6 | 未取得 | 未运行；未取得证据 | open_validation_item | 3a35cb4cd34fa419803daf5019f1ea747c7a8e8f | not_run | 未取得 |
| VER-ISSUE80-NEW-DATABASE-STARTUP-20260815 | Issue #80 legacy database retention and fresh desktop database startup | L5 | L2 | 实际运行证据已取得 | synthetic_user_data_and_desktop_unit_contract | 01cd36c976b8e85f856e97abb73accf7c96b1245 | local-issue80-new-database-startup-20260815-01 | 未取得 |
| VER-EXTERNAL-LINK-REAL-EXE | 已安装 Windows EXE 的 Electron 外链允许、拒绝与可见反馈 | L5 | 未取得 | 未运行；未取得证据 | open_validation_item | unverified | not_run | 未取得 |
| VER-ISSUE45-PROD01-SOURCE-PRIVACY-L4-20260816 | Issue #45 PROD-01 默认来源最小化、严格 DTO 校验、主人主动核验与安全派生摘要 | L4 | 未取得 | 未运行；未取得证据 | open_validation_item | not_run | not_run | 未取得 |
| VER-ISSUE33-SEC02-L3-20260816 | Issue #33 SEC-02 不可信数据 system contract、严格模型 schema 与服务端 post-adapter guard | L4 | L3 | 实际运行证据已取得 | synthetic_classifier_service_contract | 77b1ab7c90fca0a599ce78d498b3dda4ab852eed | local-issue33-sec02-20260817-rebind-02 | 未取得 |
| VER-ISSUE46-FAILURE-RELATION-L4-20260816 | Issue #46 失败来源收件箱：脱敏、幂等/CAS、来源与 Runtime 关系校验及 stale 保护 | L4 | L4 | 实际运行证据已取得 | local_synthetic_service_pending_exact_merge_ref_ci | c12255dd3fb7fb6fee75bcd3ed301326bb178290 | local-issue46-runtime-failure-fence-20260816-03 | 未取得 |
| VER-ISSUE39-FSH01-L3-20260816 | Issue #39 FSH-01 Feishu scope tri-state and shared durable scope gate for owner message, calendar and minutes runners | L3 | L2 | 实际运行证据已取得 | local_contract_and_scope_gate_fixture | f0dc21392e298cf5bd643284843ecc5dda84e40a | local-20260818-fsh01-scope-gate | 未取得 |
| VER-ISSUE43-DURABLE-RETRY-L4-20260816 | Issue #43 typed provider retry propagation from synthetic provider failure to durable Runtime scheduling and shared cooldown | L4 | L2 | 实际运行证据已取得 | local_exact_sqlite_runtime_browser | 42cef3c8dc5c32b695b6eab2e710f992305eebe7 | local-20260818T115005Z-1675ceaa | 未取得 |
| VER-ISSUE34-PRIVACY-L2-20260817 | Issue #34 PRIV-001 隐私生命周期：停止采集/本地撤权、受控导出、二次确认硬删除、留存执行、受管备份校验/恢复登记与失败补偿 | L4 | L2 | 实际运行证据已取得 | synthetic_sqlite_service_api | b34f7e0a6d7f4ffbe254cd2fa42830ee850d89cb | local-20260817T201429Z-6360d8f7 | 未取得 |
| VER-ISSUE55-DRAFT-ONLY-L4-20260816 | Issue #55 OUT-01 M1 draft-only approval/outbox 状态、原子失效、幂等和安全 DTO/UI | L4 | L4 | 实际运行证据已取得 | local_synthetic_sqlite_service_api_ui | 71653383da6bbb508495f09154b09e386e919d88 | local-issue55-draft-only-20260816-01 | 未取得 |
| VER-ISSUE29-OWNER-RETIREMENT-L2-20260816 | Issue #29 owner-decision retirement, durable call-start target snapshots and fail-closed stale/noop recovery | L2 | L2 | 实际运行证据已取得 | synthetic_sqlite_service_tests | 60e10b1f1f9df0c9580772487e07b623e600a03e | pull_request_93_pending | 未取得 |
| VER-ISSUE65-GOVERNANCE-L0-20260816 | Issue #65 handoff、RACI、CODEOWNERS、stacked PR 和可恢复协作 SOP；integration 声明区分 committed_base_snapshot、PR pending 与 live ref，push merge 第一父例外仅接受明确 snapshot | L0 | L0 | 实际运行证据已取得 | local_synthetic_governance_check | 5403da9477f834f9ac63f50220650f5687a30967 | local-issue65-governance-20260816-05 | 未取得 |
| VER-ISSUE38-DATA04-L4-20260818 | Issue #38 DATA-04 连续 schema v7：不可变来源修订、精确 replay reference、canonical decision-scope binding、CAS/stale fence、隐私生命周期与强制服务层回放授权 | L4 | L4 | 实际运行证据已取得 | synthetic_local_sqlite_service_browser | 108d8eb4031a3ac3d4381516a4ea0205895ac350 | local-20260817T234313Z-18e3b200 | 未取得 |
| VER-ISSUE111-QA02-L4-20260818 | 完全本地 exact verification 的 Git changed-path/plan/gate 重算、严格 schema、计数守恒与 crash-safe generation/lease/CAS evidence 发布；immutable candidate reader、identity-specific lease/reclaim paths 与 A-D publication fencing | L4 | L4 | 实际运行证据已取得 | local_exact_verification_infrastructure | adc56a0ab271228bb3f38d2d5f426f2df9d8d480 | local-20260818T083833Z-d2f27a74 | 未取得 |
| VER-ISSUE41-FSH03-L4-20260818 | Issue #41 FSH-03 飞书 WebSocket durable inbox-before-ack、幂等去重、重启恢复和来源/主人范围 fencing | L4 | L4 | 实际运行证据已取得 | synthetic_local_sqlite_service_contract_browser_regression | dcf3d01ed6ba6fb2a876afc2f86171ab23a010ad | local-issue41-fsh03-20260818-02 | 未取得 |
| VER-AILY-SDK-ISOLATED-20260827 | 独立 TooManyTasks OAuth/TokenStore/Aily SDK、SSE、持久窗口、Cindy 薄插件与 SQLite/CAS 入库合同 | L3 | L3 | 实际运行证据已取得 | synthetic_independent_service_thin_plugin_contract | b3f09335eaa1538e3fae987431def97125dbdd2c | local-aily-sdk-intake-20260827-04 | 未取得 |

## 证据详情

### VER-ISSUE85-PROD07-L0-20260816

- 能力：PROD-07 日历事实与任务候选分类产品规则合同及合成夹具
- 实现状态：`contract_defined_with_runtime_gaps`
- 目标层级：`L0`；已取得层级：`L0`
- 证据状态：`attained`（实际运行证据已取得）
- 目标真实范围：否；真实环境证据：未取得；scope：`synthetic_calendar_fixtures_only`
- Evidence type：`static_document_contract`
- Source commit：`4e7eebd979bc1c6de89906d4c74e3d5a1ee7ae5c`；记录 commit：`pull_request_96_pending`
- Provenance：mode=`local_run`；base=`not_applicable`；head=`4e7eebd979bc1c6de89906d4c74e3d5a1ee7ae5c`；merge=`not_applicable`；parents=``；tree=`not_applicable`；run=`local-issue85-prod07-contract-r3-20260816`；job=`not_applicable`；environment=Windows synthetic worktree; Node.js 24; contract checker; no real Feishu/LLM/provider
- Skip classification：status=`present`；kinds=`capability, platform`；reason=本 Issue 只验证结构化产品合同和合成夹具，不执行生产分类或真实环境验收。
- Run：`local-issue85-prod07-contract-r3-20260816`；时间：2026-08-16T23:59:00+08:00；环境：Windows synthetic worktree; Node.js 24; contract checker; no real Feishu/LLM/provider
- 命令或场景：node scripts/prod-07-calendar-contract-check.mjs; node --test scripts/prod-07-calendar-contract-check.test.mjs (mutation matrix: exact top-level keys, alternate policy, canonical route meaning, role condition, event reason, visible acceptance, exact DTO/output allowlists including auto_execute/calendar_auto_action, unknown/duplicate/missing event types, exact signal replacement/duplicate/cross-contamination, canonical uncertain/explanation/meeting/correction semantic rewrites, decision/correction/example/acceptance extra keys, LF/CRLF generated-view equivalence, write canonical LF, and real Markdown mutation failure); npm run docs:generate; npm run docs:check; npm run docs:test; npm run check; npm run test:e2e:inventory; E2E_EVIDENCE=1 npm run test:e2e; npm run test:e2e:verify; git diff --check
- 结果：`passed`；skips：本 Issue 不修改 apps/** 分类生产行为；不连接真实飞书、LLM、生产数据或 Windows L5/L6。
- Evidence path：`docs/product-rules/PROD-07-calendar-classification.json`
- 限制 / 未验证：只证明 L0 结构化规则、合成正/负/边界例和量化验收指标可被 checker 验证；整仓 npm check/Playwright 若通过也只属于 regression gate，不能升级为 PROD-07 的 UI 或生产分类行为证据；桌面/窄屏 parity 是后续实现验收目标。不证明当前生产分类已按规则运行，不证明真实飞书 Calendar DTO 字段、权限或租户行为。

### VER-ISSUE59-QA01-SELECTION-20260816

- 能力：QA-01 changed-path → L0-L6 选择、执行清单、skip 语义、exact provenance、integration 普通合并 push 第一父/已合入 PR head/tree 例外与 no-upload 边界
- 实现状态：`implemented_draft_candidate`
- 目标层级：`L4`；已取得层级：`L4`
- 证据状态：`attained`（实际运行证据已取得）
- 目标真实范围：否；真实环境证据：未取得；scope：`synthetic_ci_and_browser_only`
- Evidence type：`ci_selection_and_evidence_contract`
- Source commit：`79ed1142cccceefed7391c605b70752c6610c30d`；记录 commit：`pull_request_59_pending`
- Provenance：mode=`local_run`；base=`not_applicable`；head=`79ed1142cccceefed7391c605b70752c6610c30d`；merge=`not_applicable`；parents=``；tree=`not_applicable`；run=`local-issue59-integration-push-hotfix-20260816-02`；job=`not_applicable`；environment=Windows local worktree; Node.js 24.19.0; real temporary Git merge objects; synthetic CI environment variables; Vitest; Playwright Chromium desktop and mobile fixtures
- Skip classification：status=`present`；kinds=`capability, platform`；reason=本地/Ubuntu-equivalent synthetic CI 不提供 Windows 安装载体或真实 provider/tenant
- Run：`local-issue59-integration-push-hotfix-20260816-02`；时间：2026-08-16；环境：Windows local worktree; Node.js 24.19.0; real temporary Git merge objects; synthetic CI environment variables; Vitest; Playwright Chromium desktop and mobile fixtures
- 命令或场景：npm run check (docs 26 passed/1 platform symlink skip; CI policy 58; matcher 10; server 593; web 23; desktop 134; typecheck/build/artifact verification passed); npm run test:e2e:lifecycle (5/5); npm run test:e2e:inventory (84: desktop 43/mobile 41); E2E_EVIDENCE=1 npm run test:e2e (84/84, 0 skipped); npm run test:e2e:verify (43/43 + 41/41); prior real integration push simulation bound event=push, exact integration branch, checkout HEAD=event/live SHA=794fbf1365c2dbd4e52064a27bdb0b19c258691c and declared first parent=79f97d9505364fc5acbb9816fc77490e0b2e0211; this follow-up additionally requires CI_APPROVED_PR_HEAD_SHA to equal the second parent and recomputes merge-tree before recording runtime freshness; negative cases include non-integration branch, wrong checkout HEAD, missing/wrong approved PR head, tree mismatch, single-parent/squash/rebase shape and malformed/octopus ancestry; strict requireDeclaredMatch missing/malformed declarations and manifest/current-state disagreement fail closed; git diff --check
- 结果：`passed`；skips：Windows Electron/NSIS L5 installed Smoke and real Feishu/LLM/tenant/production L6 are capability/platform out of scope; exact PR base/head/merge-ref/run/job pending
- Evidence path：`docs/test-selection.md`
- 限制 / 未验证：Pull request 仍严格要求声明 tip 等于 exact base；仅当 event=push、branch 固定为 integration/m1-test-20260815、checkout HEAD=event SHA=live tip、当前提交恰为两个合法 SHA 父提交、第一父等于 committed snapshot、第二父等于 GitHub API 关联的已合入 PR head 且 merge-tree 与 live tree 一致时允许受控例外；通过 ci-artifacts/integration-provenance.json 记录 live merge freshness，不把未来 merge SHA 追写回提交文档。普通提交、更老祖先、第二父、错误/缺失 approved PR head、错误 event/branch/SHA/HEAD、tree/provenance mismatch、squash/rebase/单父伪装、malformed token 或 octopus ancestry 均 fail-closed；在取得 exact PR head/merge-ref/run/job 及合并后的真实 integration push SUCCESS 前不能关闭 Issue #59。Synthetic CI 最高 L4，不代表 Windows Electron/NSIS L5 或真实 Feishu/LLM/tenant/production L6。

### VER-ISSUE66-DEC01-L0-20260816

- 能力：DEC-01 M1 产品与治理负责人决策登记及结构化文档合同
- 实现状态：`implemented`
- 目标层级：`L0`；已取得层级：`L0`
- 证据状态：`attained`（实际运行证据已取得）
- 目标真实范围：否；真实环境证据：未取得；scope：`synthetic_document_contract`
- Evidence type：`static_document_contract`
- Source commit：`06f45f0e47edbc8b599fdf4f9bd94afb402f850d`；记录 commit：`pull_request_94_pending`
- Provenance：mode=`local_run`；base=`not_applicable`；head=`06f45f0e47edbc8b599fdf4f9bd94afb402f850d`；merge=`not_applicable`；parents=``；tree=`not_applicable`；run=`pull_request_94_pending`；job=`not_applicable`；environment=Behavior/source is bound to commit 06f45f0e47edbc8b599fdf4f9bd94afb402f850d. The committed record uses pull_request_94_pending to avoid self-reference; current candidate, merge-ref and exact CI freshness are bound by PR #94 body. Windows synthetic worktree / Node 24
- Skip classification：status=`present`；kinds=`capability, platform`；reason=历史记录明确列出未覆盖的环境或平台边界。
- Run：`pull_request_94_pending`；时间：2026-08-16T23:00:00+08:00；环境：Behavior/source is bound to commit 06f45f0e47edbc8b599fdf4f9bd94afb402f850d. The committed record uses pull_request_94_pending to avoid self-reference; current candidate, merge-ref and exact CI freshness are bound by PR #94 body. Windows synthetic worktree / Node 24
- 命令或场景：node scripts/decision-register-check.mjs; node --test scripts/decision-register-check.test.mjs; npm run docs:generate; npm run docs:check; npm run docs:test
- 结果：`passed`；skips：提交内不自引用当前 head/merge-ref/run；这些 exact freshness 事实由 PR #94 body 绑定。未运行 L5 Windows 安装或 L6 真实飞书/LLM/provider 验收。
- Evidence path：`docs/decision-register.json`
- 限制 / 未验证：登记只提供 L0 文档合同和合成测试边界；source commit 06f45f0 包含 DEC-01 事实源、生成视图与 checker，当前 docs carrier 和 exact CI 以 PR #94 body 为准；不证明真实租户权限、真实发送、真实删除、Windows 安装或生产数据行为。

### VER-PR24-CHECK

- 能力：PR #24 源码类型检查、自动测试与构建
- 实现状态：`implemented`
- 目标层级：`L2`；已取得层级：`未取得`
- 证据状态：`reported_not_reverified`（历史 QA 报告；本次未独立复验）
- 目标真实范围：否；真实环境证据：未取得；scope：`synthetic_local`
- Evidence type：`committed_qa_record`
- Source commit：`8b6869b89323a79a31636a1290b9712e2127f0c6`；记录 commit：`8b6869b89323a79a31636a1290b9712e2127f0c6`
- Run：`unrecorded`；时间：unrecorded；环境：unrecorded
- 命令或场景：npm run check
- 结果：`reported_passed_not_reverified`；skips：unrecorded
- Evidence path：`docs/qa/README.md`
- 限制 / 未验证：提交内 QA 记录报告 server 342、web 3、desktop 7；本 Issue 未重跑，且该记录不能证明真实飞书、真实 LLM 或 Windows 安装行为。

### VER-PR24-E2E

- 能力：PR #24 浏览器端到端主流程
- 实现状态：`implemented`
- 目标层级：`L4`；已取得层级：`未取得`
- 证据状态：`reported_not_reverified`（历史 QA 报告；本次未独立复验）
- 目标真实范围：否；真实环境证据：未取得；scope：`synthetic_browser_e2e`
- Evidence type：`committed_qa_record`
- Source commit：`8b6869b89323a79a31636a1290b9712e2127f0c6`；记录 commit：`8b6869b89323a79a31636a1290b9712e2127f0c6`
- Run：`unrecorded`；时间：unrecorded；环境：browser environment not recorded
- 命令或场景：npm run test:e2e
- 结果：`reported_passed_not_reverified`；skips：7 mobile write scenarios reported as not applicable
- Evidence path：`docs/qa/README.md`
- 限制 / 未验证：提交内 QA 记录报告 37 passed / 7 skipped；本 Issue 未重跑，不代表真实外部服务或 Windows 安装。

### VER-ISSUE60-E2E-20260815

- 能力：Issue #60 独立浏览器状态、安全 bridge 回归、nonce/ACK 生命周期门禁与 fixture 共用纯 matcher 的精确 console 错误放行
- 实现状态：`implemented`
- 目标层级：`L4`；已取得层级：`L4`
- 证据状态：`attained`（实际运行证据已取得）
- 目标真实范围：否；真实环境证据：未取得；scope：`synthetic_local_and_browser_e2e`
- Evidence type：`local_synthetic_check_and_browser_e2e`
- Source commit：`ce12979d6cc3b6d716d152b30a53e8830483950b`；记录 commit：`pull_request_70_pending`
- Provenance：mode=`local_run`；base=`not_applicable`；head=`ce12979d6cc3b6d716d152b30a53e8830483950b`；merge=`not_applicable`；parents=``；tree=`not_applicable`；run=`local-pr70-b3-committed-matcher-tests-e62f6c4-20260815-01`；job=`not_applicable`；environment=Windows local worktree; Node.js 24.19.0; Playwright Chromium; 3 workers; artificial data and browser bridge Mock
- Skip classification：status=`none`；kinds=``；reason=本记录声明的步骤均已执行。
- Run：`local-pr70-b3-committed-matcher-tests-e62f6c4-20260815-01`；时间：2026-08-15T14:21:51+08:00/2026-08-15T14:23:01+08:00；环境：Windows local worktree; Node.js 24.19.0; Playwright Chromium; 3 workers; artificial data and browser bridge Mock
- 命令或场景：npm run check (includes npm run test:e2e:matcher: 10 committed pure matcher contracts); npm run test:e2e:lifecycle; npm run test:e2e; Issue #52 exact test scope, console text, GET, pathname /api/tasks/issue52-history-b, empty search, 503 and expectedCount=1
- 结果：`passed`；skips：0; 23 common paths run in desktop and Pixel 7 projects, plus 2 desktop-only L4 browser bridge Mock contracts
- Evidence path：`docs/qa/README.md`
- 限制 / 未验证：Only local synthetic L4 evidence. The browser bridge Mock does not exercise Electron main/preload, NSIS installation or Windows desktop integration, and no real Feishu tenant, real LLM provider or production data was connected.

### VER-ISSUE49-DASHBOARD-20260815

- 能力：工作台上海自然日、跨日覆盖与独立统计
- 实现状态：`implemented`
- 目标层级：`L4`；已取得层级：`L4`
- 证据状态：`attained`（实际运行证据已取得）
- 目标真实范围：否；真实环境证据：未取得；scope：`synthetic_local_and_browser`
- Evidence type：`synthetic_unit_service_and_browser_tests`
- Source commit：`9888124cf03029a379dc88d6ce1edb31dbf40d0f`；记录 commit：`pull_request_75_pending`
- Provenance：mode=`local_run`；base=`not_applicable`；head=`9888124cf03029a379dc88d6ce1edb31dbf40d0f`；merge=`not_applicable`；parents=``；tree=`not_applicable`；run=`local-20260815-issue49`；job=`not_applicable`；environment=Windows; Node 24; in-memory SQLite; Playwright desktop Chromium and Pixel 7; Browser plugin unavailable
- Skip classification：status=`present`；kinds=`capability, platform`；reason=历史记录明确列出未覆盖的环境或平台边界。
- Run：`local-20260815-issue49`；时间：2026-08-15；环境：Windows; Node 24; in-memory SQLite; Playwright desktop Chromium and Pixel 7; Browser plugin unavailable
- 命令或场景：server Shanghai boundary, UTC demo seed, spanning interval, completed/archived/invalidated/soft-deleted exclusion and dashboard integration tests; web tests; Playwright full suite and Issue #49 grep
- 结果：`passed`；skips：Windows Electron / NSIS L5 and real tenant/provider L6 not run
- Evidence path：`docs/qa/README.md`
- 限制 / 未验证：人工构造数据和浏览器 Mock 只证明 L1/L2/L4 合同；不证明 Electron、Windows 安装、真实飞书租户、真实 LLM 或生产数据行为。

### VER-ISSUE57-URL-POLICY-20260815

- 能力：Issue #57 renderer 预检、document-only IPC、Electron main 二次校验、OAuth/文档组件 allowlist 与脱敏拒绝反馈
- 实现状态：`implemented`
- 目标层级：`L5`；已取得层级：`L4`
- 证据状态：`attained`（实际运行证据已取得）
- 目标真实范围：否；真实环境证据：未取得；scope：`synthetic_url_policy_ipc_and_browser_mock`
- Evidence type：`local_synthetic_check_and_browser_e2e`
- Source commit：`10a42dba8a0955ed13075ac6df5713cac3a2ddae`；记录 commit：`5de44f56bbb0c41f592cceeef45dd7b7872f498f`
- Provenance：mode=`local_run`；base=`not_applicable`；head=`10a42dba8a0955ed13075ac6df5713cac3a2ddae`；merge=`not_applicable`；parents=``；tree=`not_applicable`；run=`local-pr74-rebase-c872-20260815-01`；job=`not_applicable`；environment=Windows local worktree; Node.js 24.19.0; Playwright Chromium; 3 workers; synthetic URLs and browser bridge Mock; base c872c0f9534b1a8b7ad2fcde9551efcba503ad46
- Skip classification：status=`present`；kinds=`capability, platform`；reason=历史记录明确列出未覆盖的环境或平台边界。
- Run：`local-pr74-rebase-c872-20260815-01`；时间：2026-08-15T18:07:38+08:00/2026-08-15T18:09:56+08:00；环境：Windows local worktree; Node.js 24.19.0; Playwright Chromium; 3 workers; synthetic URLs and browser bridge Mock; base c872c0f9534b1a8b7ad2fcde9551efcba503ad46
- 命令或场景：URL policy/desktop 109; web URL+format 14; Shanghai/app/service-lifecycle 31; npm run check (docs 13 passed/1 Windows symlink-permission skip, matcher 10, server 394, web 16, desktop 109, typecheck/build passed); npm run test:e2e:lifecycle (5 scenarios); npm run test:e2e (54 tests); combined #49 Dashboard, #57 external-link and #60 matcher/lifecycle inventory
- 结果：`passed`；skips：real Electron shell.openExternal, installed EXE, system default browser, real Feishu/Lark tenant domains, provider final redirect and all real network opening
- Evidence path：`apps/desktop/src/external-links.test.ts`
- 限制 / 未验证：Only synthetic and browser Mock evidence up to L4. The combined 54-test browser run preserves #49 and #60 contracts but does not execute real Electron preload/main or the Windows system browser. No real URL, Feishu/Lark tenant, LLM, production data or installer was used.

### VER-DATA01-SQLITE-MIGRATION-20260815

- 能力：版本化 SQLite 迁移、升级前备份、失败恢复与 downgrade gate
- 实现状态：`implemented`
- 目标层级：`L5`；已取得层级：`L2`
- 证据状态：`attained`（实际运行证据已取得）
- 目标真实范围：否；真实环境证据：未取得；scope：`synthetic_temporary_sqlite`
- Evidence type：`synthetic_sqlite_integration_run`
- Source commit：`4c19de2477efa4166c0d6e8ab71f70d3f8ba2a22`；记录 commit：`pull_request_76_pending`
- Provenance：mode=`local_run`；base=`not_applicable`；head=`4c19de2477efa4166c0d6e8ab71f70d3f8ba2a22`；merge=`not_applicable`；parents=``；tree=`not_applicable`；run=`local-pr76-c872c0f-4c19de2-20260815-07`；job=`not_applicable`；environment=Windows local worktree; Node.js 24.19.0; temporary synthetic SQLite fixtures; Playwright Chromium; no real services or production data
- Skip classification：status=`present`；kinds=`capability, platform`；reason=历史记录明确列出未覆盖的环境或平台边界。
- Run：`local-pr76-c872c0f-4c19de2-20260815-07`；时间：2026-08-15T21:43:04+08:00/2026-08-15T21:55:57+08:00；环境：Windows local worktree; Node.js 24.19.0; temporary synthetic SQLite fixtures; Playwright Chromium; no real services or production data
- 命令或场景：database-migrations.test.ts: 90 passed; app legacy migration regression: 21 passed; npm run check: docs 13 passed/1 platform skip, matcher 10 passed, server 484 passed, web 9 passed, desktop 7 passed and build; npm run test:e2e:lifecycle: 5 passed; npm run test:e2e: 52 passed/0 skipped
- 结果：`passed`；skips：Windows file-lock fault injection, disk exhaustion, killed installed EXE, real user database and N-1/N installer downgrade; no real Feishu/LLM/production data
- Evidence path：`docs/qa/README.md`
- 限制 / 未验证：本记录只证明 2026-08-15 临时合成 SQLite 的本地 L2 运行时点；unit ID/key 与关系碰撞、共享来源歧义、双 current 冲突、备份后 operation 失败自动恢复、严格历史 schema、UTC 时间绑定和 mtime 无关保留策略已由合成合同覆盖。浏览器 E2E 只证明 integration 组合 L4 回归，不提高数据库能力层级。本记录不声明随后文档 head 的 CI 状态；最终授权以 PR body 所列最终 base/head/merge-ref/run/job 为准。Windows 文件锁、磁盘耗尽、进程终止、真实用户历史库和安装 EXE 升降级仍未验证。

### VER-DATA02-RELATIONS-L2-20260816

- 能力：Issue #36 DATA-02 四层关系约束、durable integrity gap 纠正闭环、完整审计链与安全 DTO
- 实现状态：`implemented_draft_candidate_on_latest_integration`
- 目标层级：`L2`；已取得层级：`L2`
- 证据状态：`attained`（实际运行证据已取得）
- 目标真实范围：否；真实环境证据：未取得；scope：`synthetic_sqlite_and_virtual_adapters_only`
- Evidence type：`local_synthetic_sqlite_service_and_migration_tests`
- Source commit：`0c0da70741f3ea9fbe42b1e13f7ba97c3e21df91`；记录 commit：`0c0da70741f3ea9fbe42b1e13f7ba97c3e21df91`
- Provenance：mode=`local_run`；base=`not_applicable`；head=`0c0da70741f3ea9fbe42b1e13f7ba97c3e21df91`；merge=`not_applicable`；parents=``；tree=`not_applicable`；run=`pull_request_86_pending`；job=`not_applicable`；environment=Behavior/source and product snapshot evidence are bound to source commit 0c0da70741f3ea9fbe42b1e13f7ba97c3e21df91 and product fingerprint 2cc5a084e585053e4176f0fc8991065fbe4930d3dd5dcc8fed1ab6b11ca0f221. Previous docs/source candidate 18f8d8ba4ffbc389afb7b05dc18d1c0b847695df, merge ref edeb29494ce0160c0fdece616cff23c066085ee5, tree 8738be57106b3e1459db2f2d97b034544b9ac7a9 and CI 31938935008/job 95145158077 are historical/source evidence only. Current candidate freshness is pull_request_86_pending and will be bound by the PR body after this docs commit; Node.js 24; synthetic SQLite; Fastify inject; virtual adapters; Playwright Chromium; no real services or production data
- Skip classification：status=`present`；kinds=`capability, platform`；reason=历史记录明确列出未覆盖的环境或平台边界。
- Run：`pull_request_86_pending`；时间：2026-08-16；环境：Behavior/source and product snapshot evidence are bound to source commit 0c0da70741f3ea9fbe42b1e13f7ba97c3e21df91 and product fingerprint 2cc5a084e585053e4176f0fc8991065fbe4930d3dd5dcc8fed1ab6b11ca0f221. Previous docs/source candidate 18f8d8ba4ffbc389afb7b05dc18d1c0b847695df, merge ref edeb29494ce0160c0fdece616cff23c066085ee5, tree 8738be57106b3e1459db2f2d97b034544b9ac7a9 and CI 31938935008/job 95145158077 are historical/source evidence only. Current candidate freshness is pull_request_86_pending and will be bound by the PR body after this docs commit; Node.js 24; synthetic SQLite; Fastify inject; virtual adapters; Playwright Chromium; no real services or production data
- 命令或场景：Local DATA-02 relations 9 passed; database-migrations 92 passed; multi-demand/service/audit/gap 19 passed, including final UPDATE structural fence mutation, exact task/source/demand mismatch, unrelated correction-event, rollback/idempotency negatives and explicit safe DTO key/canary allowlists across all 15 collections; combined DATA-02/migrations/multi-demand 120 passed; local server full suite 565 passed, web 23 passed, desktop 133 passed, npm run check passed, lifecycle 5/5, Playwright inventory 84 (desktop 43, mobile 41), E2E 84/84, verify 84/84; final candidate freshness is intentionally pending in committed docs and is bound only after the new PR head/merge-ref/run/job are available.
- 结果：`passed`；skips：L5 Windows installed Electron/NSIS, L6 real Feishu/LLM/tenant, real user databases, secrets and production data are out of scope
- Evidence path：`apps/server/tests/multi-demand-units.test.ts`
- 限制 / 未验证：Synthetic SQLite/service and exact CI evidence only. Gap correction is exact, private, idempotent and transactional; audit DTO service and HTTP canaries prove all 15 collections omit provider/model/prompt, AI/owner/user reason, source/candidate/thread/task free text, task event summary, raw payloads and gap record_id. The final UPDATE itself is instrumented against a binding mutation and must report zero changes. The exact CI run does not provide Ready, approval, merge, Windows L5 or real Feishu/LLM L6 evidence.

### VER-DATA03-CANDIDATE-CAS-L2-20260816

- 能力：Issue #37 DATA-03 candidate version/CAS、全入口冲突语义与 CandidatesPage 刷新代际
- 实现状态：`implemented_draft_candidate_on_current_integration`
- 目标层级：`L2`；已取得层级：`L2`
- 证据状态：`attained`（实际运行证据已取得）
- 目标真实范围：否；真实环境证据：未取得；scope：`synthetic_sqlite_mock_browser_only`
- Evidence type：`local_synthetic_sqlite_service_http_and_resource_state_tests`
- Source commit：`7cbb899017bcb5d577f3648442719ff4fa2d1efc`；记录 commit：`pull_request_100_pending`
- Provenance：mode=`local_run`；base=`not_applicable`；head=`7cbb899017bcb5d577f3648442719ff4fa2d1efc`；merge=`not_applicable`；parents=``；tree=`not_applicable`；run=`pull_request_100_pending`；job=`not_applicable`；environment=Current integration base 8bcf3e7a7449cf000256cbe80731d23e32e701fe; behavior commit 7cbb899017bcb5d577f3648442719ff4fa2d1efc; committed DATA-03 candidate with exact PR freshness pending; Node.js 24; synthetic SQLite, Fastify inject, virtual adapters and browser Mock only
- Skip classification：status=`present`；kinds=`capability, platform`；reason=No real Feishu/LLM/provider, production data, secrets, Windows installed Electron/NSIS L5 or real tenant/provider L6; exact PR head/merge-ref/CI remains pending.
- Run：`pull_request_100_pending`；时间：2026-08-16；环境：Current integration base 8bcf3e7a7449cf000256cbe80731d23e32e701fe; behavior commit 7cbb899017bcb5d577f3648442719ff4fa2d1efc; committed DATA-03 candidate with exact PR freshness pending; Node.js 24; synthetic SQLite, Fastify inject, virtual adapters and browser Mock only
- 命令或场景：data-03-candidate-version.test.ts: 4 passed; data-03-candidate-cas.test.ts: 15 passed, including non-root merged-group delete/restore bound to the requested member version, wrong root/member version zero-write negatives, stale member/group hash and changes=0 rollback; runtime-v3-migration/data-02-relations/database-migrations: 104 passed; multi-demand-units.test.ts: 19 passed; runtime-thread-memory.test.ts: 99 passed; server full suite: 612 passed; web suite: 26 passed; desktop suite: 134 passed; server/web/desktop typecheck passed; npm run check passed; lifecycle 5/5; Playwright inventory 86 (desktop 44, mobile 42), E2E 86/86, verify 86/86; exact candidate head/merge-ref/CI freshness remains pending and is authoritative only from PR #100 body
- 结果：`passed`；skips：No real Feishu/LLM/provider, production data, secrets, Windows installed Electron/NSIS L5 or real tenant/provider L6; no exact PR head/merge-ref/CI is asserted in committed docs
- Evidence path：`apps/server/tests/data-03-candidate-cas.test.ts`
- 限制 / 未验证：This is synthetic local L2 evidence for candidate version migration, expectedVersion 400/409 semantics, transactional zero-write conflicts, resource-specific refresh fencing and merged-group per-member delete/restore CAS. Exact candidate head/merge-ref/parents/tree/run/job remains pending and must be bound by PR #100 body. Browser evidence, if later collected, remains at most L4 and cannot prove Windows L5 or real Feishu/LLM L6.

### VER-ISSUE62-REL01-GATE-20260816

- 能力：Windows L5 release manifest、签名授权、精确 artifact provenance、安装升级回退与严格清理门禁基础设施
- 实现状态：`implemented_pending_certificate_and_windows_validation`
- 目标层级：`L5`；已取得层级：`未取得`
- 证据状态：`not_run`（未运行；未取得证据）
- 目标真实范围：否；真实环境证据：未取得；scope：`windows_release_gate_infrastructure`
- Evidence type：`open_validation_item`
- Source commit：`unverified`；记录 commit：`pull_request_62_pending`
- Provenance：mode=`not_run`；base=`not_run`；head=`not_run`；merge=`not_run`；parents=``；tree=`not_run`；run=`not_run`；job=`not_run`；environment=not_run
- Skip classification：status=`present`；kinds=`capability, platform, not_executed`；reason=真实签名证书、Windows L5 runner 与最终 signed-artifact Smoke 尚未提供；当前仅验证 fail-closed 基础设施
- Run：`not_run`；时间：not_run；环境：not_run
- 命令或场景：not_run
- 结果：`not_run`；skips：Authenticode certificate/thumbprint/timestamp, signed exact artifact, complete Windows L5 installer Smoke, real file-lock/reparse, N-1/N downgrade and GitHub Release are not available; external provider cases use synthetic adapters only
- Evidence path：`docs/release-l5.md`
- 限制 / 未验证：本记录只声明可执行的 fail-closed 基础设施，不能授权发布或关闭 Issue #62。此前本地 manifest、18 个 synthetic 场景、installer Smoke 和完整 check 均已执行；Windows L5 exact CI 31978192959/95240745448 因 Vitest server 子进程在 JSON 报告完整写出后仍返回 code 1，未取得成功；本候选保留受控 VITEST_TEST_TIMEOUT_MS=30000 与 VITEST_FILE_PARALLELISM=false，并让 inventory 使用 JSON reporter、serial 模式单 worker（max/min=1）、threads pool 及 singleThread 选项以移除 Windows worker IPC 收尾竞态；数据库迁移合同中一个已知 Windows 慢测试使用 scoped 60000ms test timeout，但 inventory 的通过/失败、跳过、空 inventory 和 child exit 语义未放宽；这些设置不吞错、不减少测试、不用 retry 掩盖失败。新 head 必须重新取得 Windows L5 exact CI。Ubuntu CI、artifact hash、浏览器 1440/320 viewport 与合成 provider 不提升为 Windows L5/L6；必须由真实签名包、同一 hash 的 Windows Smoke 和 exact run/job 重新取得证据。

### VER-ISSUE58-OBS-L2-20260815

- 能力：Issue #58 最小可观测合同：封闭同步 DTO、四态设置提示、readiness、编译期 release identity、后端 ID 和 canary 非泄漏
- 实现状态：`implemented`
- 目标层级：`L2`；已取得层级：`L2`
- 证据状态：`attained`（实际运行证据已取得）
- 目标真实范围：否；真实环境证据：未取得；scope：`synthetic_local`
- Evidence type：`local_synthetic_check`
- Source commit：`38d3c05e047b341b243efcaa4aeda726c6da9e52`；记录 commit：`pull_request_77_pending`
- Provenance：mode=`local_run`；base=`not_applicable`；head=`38d3c05e047b341b243efcaa4aeda726c6da9e52`；merge=`not_applicable`；parents=``；tree=`not_applicable`；run=`local-issue58-observability-20260815-04`；job=`not_applicable`；environment=Windows local worktree; Node.js 24; SQLite memory database; Fastify inject; Playwright Chromium; synthetic fixtures only
- Skip classification：status=`present`；kinds=`capability, platform`；reason=历史记录明确列出未覆盖的环境或平台边界。
- Run：`local-issue58-observability-20260815-04`；时间：2026-08-15T20:20:44+08:00/2026-08-15T20:24:33+08:00；环境：Windows local worktree; Node.js 24; SQLite memory database; Fastify inject; Playwright Chromium; synthetic fixtures only
- 命令或场景：Third-review targeted server 57 passed, including aggregate/single-source sync/async null/undefined, missing runner, sync throw, controlled failure reason and hostile-shape contracts; retained Web four-state 4, desktop identity/artifact 16 and focused UI four-state 6; npm run check (docs 13 passed/1 platform symlink skip, matcher 10 passed, server 409 passed, web 13 passed, desktop 23 passed, typecheck/build/post-build artifact verifier passed); docs changed-path gate; E2E lifecycle 5 scenarios passed; Playwright E2E 58 passed
- 结果：`passed`；skips：targeted 0; npm run check docs tests had 1 platform symlink skip, matcher/server/web/desktop had 0; lifecycle 0; browser E2E 0
- Evidence path：`apps/server/tests/observability.test.ts`
- 限制 / 未验证：Only local synthetic L1/L2 evidence. The post-build check scans the produced desktop bundle but does not launch Electron or install NSIS, so it is not L5. This slice does not provide full UI→IPC→provider→cursor→source→job→task tracing, disk/freshness/backoff/queue readiness, source-level advanced UI, Windows L5 installer evidence, or real Feishu/LLM L6 validation.

### VER-ISSUE61-CI-20260815

- 能力：Issue #61 fail-closed CI 选层、精确 merge-ref、执行清单核验、单次构建复用与 no-upload 受控失败日志
- 实现状态：`implemented_exact_merge_ci_verified`
- 目标层级：`L4`；已取得层级：`L4`
- 证据状态：`attained`（实际运行证据已取得）
- 目标真实范围：否；真实环境证据：未取得；scope：`synthetic_ci_and_browser_only`
- Evidence type：`exact_merge_ref_ci_and_local_synthetic_browser_e2e`
- Source commit：`e311403848cdb51ccbeba4f772ad1f72d2e74ad7`；记录 commit：`pull_request_78_pending`
- Provenance：mode=`local_run`；base=`not_applicable`；head=`e311403848cdb51ccbeba4f772ad1f72d2e74ad7`；merge=`not_applicable`；parents=``；tree=`not_applicable`；run=`github-actions-31883329714-job-95008835562`；job=`not_applicable`；environment=GitHub Actions ubuntu-latest; Node.js 24; exact merge 06ab45a6487ed94f54c9ace6d610b41f02402f43 with parents c872c0f9534b1a8b7ad2fcde9551efcba503ad46 and e311403848cdb51ccbeba4f772ad1f72d2e74ad7; in-memory SQLite; synthetic test servers; Playwright Chromium
- Skip classification：status=`present`；kinds=`capability, platform`；reason=历史记录明确列出未覆盖的环境或平台边界。
- Run：`github-actions-31883329714-job-95008835562`；时间：2026-08-15T11:56:33Z/2026-08-15T11:59:48Z；环境：GitHub Actions ubuntu-latest; Node.js 24; exact merge 06ab45a6487ed94f54c9ace6d610b41f02402f43 with parents c872c0f9534b1a8b7ad2fcde9551efcba503ad46 and e311403848cdb51ccbeba4f772ad1f72d2e74ad7; in-memory SQLite; synthetic test servers; Playwright Chromium
- 命令或场景：exact merge-ref checkout and parent verification; CI policy 31; docs gate; matcher 10; server 394, web 9, desktop 7; one build plus provenance; lifecycle 5; Playwright inventory 52 (desktop 27/mobile 25); E2E 52 passed/0 skipped; post-execution project/count/test-id verifier
- 结果：`passed`；skips：E2E 0 skipped；workflow 不上传失败 artifact/report/trace/screenshot/log；Electron/NSIS L5 and real tenant/provider L6 not run
- Evidence path：`docs/qa/README.md`
- 限制 / 未验证：成功 exact merge CI 证明本 source 的 L0-L4 合同、31 项 CI policy、5 项生命周期和 52 条合成浏览器 E2E。workflow 不上传 artifact/report/trace/screenshot/log；9 项 failure-output 自动合同覆盖 chunk 边界、超大输出、敏感标记、绝对路径、二进制/无效 UTF-8、raw canary、wrapper 错误及 post verifier 缺失证据固定失败输出。本项不声称能阻止恶意 PR 自己向 Actions 写内容；浏览器 Mock 最高为 L4，不证明 Windows Electron/NSIS L5、真实飞书/LLM L6 或生产数据行为。

### VER-ISSUE50-CALENDAR-20260815

- 能力：排期日历上海自然日、安全 DTO、有界跨日展开、坏数据隔离、纠错与自动更新撤销运行时快照、candidate revision payload/business-state 边界、终态可见性
- 实现状态：`implemented`
- 目标层级：`L4`；已取得层级：`L4`
- 证据状态：`attained`（实际运行证据已取得）
- 目标真实范围：否；真实环境证据：未取得；scope：`synthetic_local_and_browser`
- Evidence type：`synthetic_unit_service_and_browser_tests`
- Source commit：`e6303ec809d5f6e2efae0f578f7a4e0dbbbada6b`；记录 commit：`pull_request_67_pending`
- Provenance：mode=`local_run`；base=`not_applicable`；head=`e6303ec809d5f6e2efae0f578f7a4e0dbbbada6b`；merge=`not_applicable`；parents=``；tree=`not_applicable`；run=`local-20260815-issue50`；job=`not_applicable`；environment=Windows; Node 24; in-memory SQLite; Playwright desktop Chromium and Pixel 7; Browser plugin unavailable
- Skip classification：status=`present`；kinds=`capability, platform`；reason=历史记录明确列出未覆盖的环境或平台边界。
- Run：`local-20260815-issue50`；时间：2026-08-15；环境：Windows; Node 24; in-memory SQLite; Playwright desktop Chromium and Pixel 7; Browser plugin unavailable
- 命令或场景：seventh-round targeted server 154 passed; npm run check passed (matcher 10, server 417, web 9, desktop 7); lifecycle 5 scenarios passed; full Playwright 54 passed/0 skipped including #49/#50 desktop and Pixel contracts; contracts include Shanghai half-open 366/367/equal/reverse, sanitized DTO/bad-canary, correction zero-write, one strict before/after snapshot parser, ISO datetime rejection matrix, candidate-linked non-null before previous/null after previous, previous/applied payload equality, before/after/current candidate business-state equality, snapshot state excluded from recovery SQL, authoritative state post-invariant, exactly one current revision matching candidate_request, candidate-less ordinary follow-up/owner association, stripped extra-field canary, fixed redacted 409 and task/proposal/task_event/thread/candidate/all-revisions zero-write rejection
- 结果：`passed`；skips：Windows Electron / NSIS L5 and real Feishu Calendar tenant L6 not run
- Evidence path：`docs/qa/README.md`
- 限制 / 未验证：人工构造任务和浏览器 API Mock 只证明 L1/L2/L4 合同；不证明 Electron、Windows 安装、真实飞书日历租户或生产数据行为。

### VER-INTEGRATION-BATCH-20260815

- 能力：六个独立批准 PR 在 integration/m1-test-20260815 上的组合兼容性与完整回归
- 实现状态：`integrated_locally_pending_remote_ci`
- 目标层级：`L4`；已取得层级：`L4`
- 证据状态：`attained`（实际运行证据已取得）
- 目标真实范围：否；真实环境证据：未取得；scope：`synthetic_local_integration`
- Evidence type：`local_exact_integration_check_and_synthetic_browser_e2e`
- Source commit：`32485c4dc335b4b258629b70f1d49d5a563eff71`；记录 commit：`integration_batch_pending`
- Provenance：mode=`local_run`；base=`not_applicable`；head=`32485c4dc335b4b258629b70f1d49d5a563eff71`；merge=`not_applicable`；parents=``；tree=`not_applicable`；run=`local-integration-batch-20260815-01`；job=`not_applicable`；environment=Windows; Node.js 24; clean isolated integration worktree; in-memory SQLite; synthetic test servers; Playwright desktop Chromium and Pixel 7
- Skip classification：status=`present`；kinds=`capability, platform`；reason=历史记录明确列出未覆盖的环境或平台边界。
- Run：`local-integration-batch-20260815-01`；时间：2026-08-15；环境：Windows; Node.js 24; clean isolated integration worktree; in-memory SQLite; synthetic test servers; Playwright desktop Chromium and Pixel 7
- 命令或场景：merge approved exact heads for PR #74/#76/#77/#78/#79/#67 onto base c872c0f9534b1a8b7ad2fcde9551efcba503ad46; npm ci; npm run check (docs 21 passed/1 platform skip, CI policy 31, matcher 10, server 522, web 20, desktop 125, typecheck/build and desktop bundle verifier passed); npm run test:e2e:lifecycle (5 passed); npm run test:e2e (62 passed/0 skipped)
- 结果：`passed`；skips：GitHub integration-branch CI pending; Windows installed Electron/NSIS L5 and real Feishu/LLM/production L6 not run
- Evidence path：`docs/qa/README.md`
- 限制 / 未验证：该记录证明六项改动在同一隔离 integration 工作树中的 L0-L4 合成组合回归；不证明已安装 Windows EXE、真实文件锁/升级、真实租户、真实 provider 或生产数据。最终远端授权还必须绑定推送后的 integration SHA 与 GitHub Actions run。

### VER-ISSUE40-FSH02-L3-20260816

- 能力：Issue #40 FSH-02 飞书业务码统一守卫、transport Error 分类、详情失败阻塞与 cursor/checkpoint 保护
- 实现状态：`implemented_exact_merge_ci_verified`
- 目标层级：`L3`；已取得层级：`L3`
- 证据状态：`attained`（实际运行证据已取得）
- 目标真实范围：否；真实环境证据：未取得；scope：`synthetic_local_contract`
- Evidence type：`exact_merge_ref_ci_and_local_synthetic_browser_e2e`
- Source commit：`bb93cfd10c9c2872ec262b9ca1f724f5acc84143`；记录 commit：`bb93cfd10c9c2872ec262b9ca1f724f5acc84143`
- Provenance：mode=`local_run`；base=`not_applicable`；head=`bb93cfd10c9c2872ec262b9ca1f724f5acc84143`；merge=`not_applicable`；parents=``；tree=`not_applicable`；run=`github-actions-31926031864-job-95113622400`；job=`not_applicable`；environment=GitHub Actions ubuntu-latest; Node.js 24; exact merge 21a879f256bda33128c6dd6eef0f01fe134319a7 with parents c84e7a7405eac09910cf097c79d0dea40cf2eb37 and bb93cfd10c9c2872ec262b9ca1f724f5acc84143; in-memory SQLite; synthetic SDK/test servers; no real Feishu tenant, LLM or production data
- Skip classification：status=`present`；kinds=`capability, platform`；reason=历史记录明确列出未覆盖的环境或平台边界。
- Run：`github-actions-31926031864-job-95113622400`；时间：2026-08-16；环境：GitHub Actions ubuntu-latest; Node.js 24; exact merge 21a879f256bda33128c6dd6eef0f01fe134319a7 with parents c84e7a7405eac09910cf097c79d0dea40cf2eb37 and bb93cfd10c9c2872ec262b9ca1f724f5acc84143; in-memory SQLite; synthetic SDK/test servers; no real Feishu tenant, LLM or production data
- 命令或场景：Exact merge-ref checkout and parent verification; CI policy 31; docs gates; matcher 10; server 530, web 20, desktop 125; typecheck/build and desktop bundle verifier; lifecycle 5; Playwright inventory/E2E 62 passed/0 skipped; local targeted Feishu parser/Owner/Calendar/Minutes contracts 78 passed, including three-attempt detail transport exhaustion and cursor/watermark/checkpoint preservation
- 结果：`passed`；skips：Docs contract suite has 1 platform symlink-permission skip; Windows installed Electron/NSIS L5 and real Feishu tenant/provider L6 not run
- Evidence path：`apps/server/tests/feishu.test.ts`
- 限制 / 未验证：Exact merge-ref CI 证明本 source 的 L0-L4 合成门禁、明确 transport Error allowlist 和本地 SQLite 同步状态不变量；不证明 Windows 安装包 L5、真实租户/LLM L6、真实权限限流、请求 ID/header 或生产数据行为。

### VER-ISSUE56-LIFECYCLE-DRAFT-20260816

- 能力：Issue #56 Phase 1 desktop startup, single-instance, config reload, OAuth callback server, tray, runtime recovery and exit lifecycle
- 实现状态：`draft_first_phase_locally_verified`
- 目标层级：`L5`；已取得层级：`L2`
- 证据状态：`attained`（实际运行证据已取得）
- 目标真实范围：否；真实环境证据：未取得；scope：`synthetic_temporary_user_data_and_smoke_installer`
- Evidence type：`synthetic_desktop_unit_and_isolated_installer_smoke`
- Source commit：`9fae562871e295b41c5f9c52fb0712ad0b61fad3`；记录 commit：`pull_request_84_pending`
- Provenance：mode=`local_run`；base=`not_applicable`；head=`9fae562871e295b41c5f9c52fb0712ad0b61fad3`；merge=`not_applicable`；parents=``；tree=`not_applicable`；run=`local-issue56-lifecycle-smoke-20260816-08`；job=`not_applicable`；environment=Windows x64 local worktree; Node.js 24; current integration base ad75b68687356a4782779b34ec35c60db68e05ea; exact fresh Smoke source 9fae562871e295b41c5f9c52fb0712ad0b61fad3; behavior source a2b35f1e0042c95808f3e0df53fc24c350b15c3a; isolated Data-PM-Smoke NSIS; synthetic temporary userData; no real services or production data
- Skip classification：status=`present`；kinds=`capability, platform`；reason=历史记录明确列出未覆盖的环境或平台边界。
- Run：`local-issue56-lifecycle-smoke-20260816-08`；时间：2026-08-16；环境：Windows x64 local worktree; Node.js 24; current integration base ad75b68687356a4782779b34ec35c60db68e05ea; exact fresh Smoke source 9fae562871e295b41c5f9c52fb0712ad0b61fad3; behavior source a2b35f1e0042c95808f3e0df53fc24c350b15c3a; isolated Data-PM-Smoke NSIS; synthetic temporary userData; no real services or production data
- 命令或场景：apps/desktop/src/lifecycle.test.ts and startup-errors.test.ts: 5 + 2 passed; npm run check (server 532, web 23, desktop 133; docs 21 passed / 1 platform symlink skip); npm run test:e2e: 82 passed / 0 skipped; npm run test:e2e:lifecycle: 5/5; fresh pure-Issue-56 plus current-integration NSIS smoke package tmp/smoke-release/Feishu-AI-PM-0.2.0-x64-Setup.exe SHA-256 6C9FB60AFCEF61D6F74C28F8F901159508858F2F0270360ECE057E48F4CF6DDF, 101885177 bytes; blockmap SHA-256 000708CC0086DF0485F92A92421A8BCA6B6752741F32F1CE14496ED6D7EF3857, 106610 bytes; installer/normal exit 0, startup-core exit 1, reload exit 1, OAuth degradation exit 0, legacy/restart exit 0, damaged-database bootstrap exit 1; every scenario asserted no Electron process remained under the isolated install directory and timeout cleanup uses taskkill /T
- 结果：`passed`；skips：Complete Windows L5 user acceptance, Windows file-lock/reparse behavior, Authenticode signing, GitHub Release, real-user database, real Feishu/LLM/production data and exact-head CI
- Evidence path：`apps/desktop/src/lifecycle.ts`
- 限制 / 未验证：这是合成 userData 下的本地 L2 证据：覆盖单一生命周期、BrowserWindow load 后 ready、启动中排队 shutdown、正常退出、startup-core/reload 故障、OAuth listener 受控降级和隔离安装目录进程树清理；Smoke 临时目录可能因 Windows EPERM 延迟删除，但所有安装目录 Electron 主/子进程均已由断言确认退出；不证明正式 release 载体、签名、真实 provider、真实用户数据库或 L6。

### VER-ISSUE51-UI-L4-20260816

- 能力：Issue #51 前端异步状态：加载、失败、成功为空、成功有数据、陈旧刷新与集成健康分区
- 实现状态：`implemented_pending_exact_pr_ci`
- 目标层级：`L4`；已取得层级：`L4`
- 证据状态：`attained`（实际运行证据已取得）
- 目标真实范围：否；真实环境证据：未取得；scope：`synthetic_browser_e2e`
- Evidence type：`local_synthetic_check_and_browser_e2e`
- Source commit：`18ea5ea606cc5bc31e31ae68d6aa52b3f5a37fc8`；记录 commit：`5ca9e935b2009fdf09e0cba68f7f2caa1c571331`
- Provenance：mode=`local_run`；base=`not_applicable`；head=`18ea5ea606cc5bc31e31ae68d6aa52b3f5a37fc8`；merge=`not_applicable`；parents=``；tree=`not_applicable`；run=`local-issue51-ui-20260816-05`；job=`not_applicable`；environment=Windows local worktree after PR #83 merged integration tip ad75b68687356a4782779b34ec35c60db68e05ea; Node.js 24; Playwright Chromium desktop 1440x900 and Pixel 7; Mock/HTTP synthetic responses; no real external service
- Skip classification：status=`none`；kinds=``；reason=本记录声明的步骤均已执行。
- Run：`local-issue51-ui-20260816-05`；时间：2026-08-16；环境：Windows local worktree after PR #83 merged integration tip ad75b68687356a4782779b34ec35c60db68e05ea; Node.js 24; Playwright Chromium desktop 1440x900 and Pixel 7; Mock/HTTP synthetic responses; no real external service
- 命令或场景：Historical exact integration checks remain recorded above; the PR #82 candidate must rerun docs/check, full check, lifecycle and Playwright against current integration base 9dfdfc65e0331cc4eabfe2510fc6e2974493576b before exact-head authorization.
- 结果：`passed`；skips：0 targeted skips; Electron/NSIS L5 and real tenant/provider L6 not run
- Evidence path：`docs/qa/README.md`
- 限制 / 未验证：本记录当前仅作已合入 integration 的历史 L4 证据索引；PR #83 的旧 exact-head/merge-ref/run/job 不授权 PR #82。PR #82 必须以当前 base 9dfdfc65e0331cc4eabfe2510fc6e2974493576b 的新 exact merge-ref CI 绑定为准；不代表真实飞书、真实 LLM、Electron/NSIS 安装、Windows L5 或 provider L6。

### VER-PACKAGE-020

- 能力：Windows 0.2.0 内部测试安装包
- 实现状态：`artifact_present_and_isolated_smoke_passed`
- 目标层级：`L5`；已取得层级：`L2`
- 证据状态：`attained`（实际运行证据已取得）
- 目标真实范围：否；真实环境证据：未取得；scope：`synthetic_temporary_user_data_and_exact_formal_installer_smoke`
- Evidence type：`synthetic_user_data_and_isolated_installer_smoke`
- Source commit：`f9e77aec70aaa846047f987672c9171e0790846a`；记录 commit：`pull_request_81_pending`
- Provenance：mode=`local_run`；base=`not_applicable`；head=`f9e77aec70aaa846047f987672c9171e0790846a`；merge=`not_applicable`；parents=``；tree=`not_applicable`；run=`local-issue80-formal-package-smoke-20260816-01`；job=`not_applicable`；environment=Windows x64 local worktree; Node.js 24; exact product/build source f9e77aec70aaa846047f987672c9171e0790846a; artifact/record carrier ancestor 3dcd9d0779542a7f3b6beebe73048273a0eff68a; synthetic temporary userData; no real services or production data
- Skip classification：status=`present`；kinds=`capability, platform`；reason=历史记录明确列出未覆盖的环境或平台边界。
- Run：`local-issue80-formal-package-smoke-20260816-01`；时间：2026-08-16；环境：Windows x64 local worktree; Node.js 24; exact product/build source f9e77aec70aaa846047f987672c9171e0790846a; artifact/record carrier ancestor 3dcd9d0779542a7f3b6beebe73048273a0eff68a; synthetic temporary userData; no real services or production data
- 命令或场景：npm run desktop:dist; node scripts/desktop-installer-smoke.mjs --installer release/Feishu-AI-PM-0.2.0-x64-Setup.exe; formal package installer exit 0, normal app exit 0, legacy/restart exit 0, controlled unknown-startup failure exit 1, old database SHA-256 unchanged, new database created, config preserved, shortcuts unchanged
- 结果：`passed`；skips：Complete Windows L5 user acceptance, Windows file-lock/reparse behavior, Authenticode signing, GitHub Release, real-user upgrade, real Feishu/LLM/production data
- Evidence path：`release/latest.yml`
- 限制 / 未验证：该记录绑定 exact product/build source f9e77aec 与精确包 hash，并包含合成 userData 的安装/启动/退出/卸载 Smoke；artifact 与本条记录首次进入仓库的已知 carrier ancestor 为 3dcd9d0779542a7f3b6beebe73048273a0eff68a，JSON record_commit 使用 pull_request_81_pending 以避免同一提交自引用；PR 最新 evidence head、merge-ref 和 run 只用于 freshness 并记录在 PR #81 body。它仍不证明完整 Windows L5、真实用户数据库升级、签名、发布渠道或真实 provider 行为。
- Artifact：`release/Feishu-AI-PM-0.2.0-x64-Setup.exe`，101881096 bytes，SHA-256 `5D69C9DAD525B4CFDDB68CB64EC99C6109DB4E848D209B365C5D3D3B985A81AA`
- 产物状态：x64；签名 NotSigned；仓库分发 Git LFS

### VER-ISSUE64-CONTRACT-L1-20260815

- 能力：Issue #64 领域合同 JSON、完整生成 Markdown 与 checker：术语、数据权威、状态机、CAS/恢复、稳定 error/outcome 与 ADR supersession
- 实现状态：`contract_defined_with_runtime_gaps`
- 目标层级：`L1`；已取得层级：`L1`
- 证据状态：`attained`（实际运行证据已取得）
- 目标真实范围：否；真实环境证据：未取得；scope：`synthetic_local`
- Evidence type：`local_synthetic_schema_and_docs_check`
- Source commit：`4c123da777a2914b040cec6d0a654ea07dae9dba`；记录 commit：`pull_request_79_pending`
- Provenance：mode=`local_run`；base=`not_applicable`；head=`4c123da777a2914b040cec6d0a654ea07dae9dba`；merge=`not_applicable`；parents=``；tree=`not_applicable`；run=`local-issue64-contract-20260815-01`；job=`not_applicable`；environment=Windows local worktree; Node.js 24; no external tenant/provider
- Skip classification：status=`present`；kinds=`capability, platform`；reason=历史记录明确列出未覆盖的环境或平台边界。
- Run：`local-issue64-contract-20260815-01`；时间：2026-08-15；环境：Windows local worktree; Node.js 24; no external tenant/provider
- 命令或场景：node scripts/domain-contracts-check.test.mjs (binding/authority/scope/outcome/object/Markdown 负例); npm run docs:generate -- --base c872c0f9534b1a8b7ad2fcde9551efcba503ad46; npm run docs:check -- --base c872c0f9534b1a8b7ad2fcde9551efcba503ad46; npm run docs:test; git diff --check
- 结果：`passed`；skips：不证明 service guard、runtime terminal、source_event append-only history、legacy owner_decision CHECK、candidate/task/job/outbox 目标语义；未运行产品 E2E、L4 浏览器、L5 Windows 安装或 L6 真实租户/provider；#58 四态 outcome/readiness/identity 仅为独立 Draft PR 依赖
- Evidence path：`docs/domain-contracts.md`
- 限制 / 未验证：仅取得 L0/L1 静态 JSON、完整生成 Markdown、TS enum、Runtime 状态绑定、精确 fresh-schema DDL、ADR 元数据和验证引用一致性；owner_decision/approval/outbox/source_event 的 DDL 证据只针对 fresh schema，不证明旧库升级；job 明确不证明 SQLite CHECK；不证明 service guard、terminal 恢复行为、append-only 来源历史、#58 实现或真实 provider 结果。

### VER-OAUTH-OWNER-20260811

- 能力：飞书 OAuth、Token 保存与系统主人身份读取
- 实现状态：`implemented`
- 目标层级：`L6`；已取得层级：`未取得`
- 证据状态：`historical_claim_not_reverified`（历史声明；未独立复验）
- 目标真实范围：是；真实环境证据：未取得；scope：`real_external_limited_step`
- Evidence type：`historical_documented_claim`
- Source commit：`unverified`；记录 commit：`8b6869b89323a79a31636a1290b9712e2127f0c6`
- Run：`unrecorded`；时间：2026-08-11 (documented claim; independent run timestamp unrecorded)；环境：local installed EXE; tenant identity and configuration intentionally not recorded
- 命令或场景：basic OAuth, protected Token storage and owner identity read
- 结果：`historical_claim_not_reverified`；skips：P2P/group history, calendar, minutes, documents, revocation and rate limits
- Evidence path：`docs/user-guide.md`
- 限制 / 未验证：只有提交内的人读记录，没有独立 run ID 或脱敏结果 artifact；不得扩大为其他飞书能力已验收。

### VER-LLM-CONNECTION-20260811

- 能力：DeepSeek 连接检查
- 实现状态：`implemented`
- 目标层级：`L6`；已取得层级：`未取得`
- 证据状态：`historical_claim_not_reverified`（历史声明；未独立复验）
- 目标真实范围：是；真实环境证据：未取得；scope：`real_external_limited_step`
- Evidence type：`historical_documented_claim`
- Source commit：`unverified`；记录 commit：`8b6869b89323a79a31636a1290b9712e2127f0c6`
- Run：`unrecorded`；时间：2026-08-11 (documented claim; independent run timestamp unrecorded)；环境：local installed EXE; provider account details intentionally not recorded
- 命令或场景：connection check only
- 结果：`historical_claim_not_reverified`；skips：401/403/429, timeout, cost and dense production dialogue behavior
- Evidence path：`docs/user-guide.md`
- 限制 / 未验证：连接检查不等于真实业务分类链完整验收；缺独立 run ID 和结果 artifact。

### VER-FEISHU-TARGET-TENANT

- 能力：目标租户 P2P、群、日历、妙记与 Docx/Wiki 范围
- 实现状态：`implemented_pending_external_validation`
- 目标层级：`L6`；已取得层级：`未取得`
- 证据状态：`not_run`（未运行；未取得证据）
- 目标真实范围：是；真实环境证据：未取得；scope：`real_external_not_run`
- Evidence type：`open_validation_item`
- Source commit：`3a35cb4cd34fa419803daf5019f1ea747c7a8e8f`；记录 commit：`3a35cb4cd34fa419803daf5019f1ea747c7a8e8f`
- Run：`not_run`；时间：not_run；环境：target tenant not connected
- 命令或场景：not run
- 结果：`not_run`；skips：all target-tenant scope, history, pagination, revocation, limits and failure behavior
- Evidence path：`docs/open_decisions.md`
- 限制 / 未验证：代码、Mock、契约和回放均不能替代该 L6 验收。

### VER-DIAGNOSTICS-REAL-EXE

- 能力：已安装 EXE 对真实供应商错误的诊断包递归脱敏
- 实现状态：`implemented_pending_external_validation`
- 目标层级：`L6`；已取得层级：`未取得`
- 证据状态：`not_run`（未运行；未取得证据）
- 目标真实范围：是；真实环境证据：未取得；scope：`real_external_not_run`
- Evidence type：`open_validation_item`
- Source commit：`3a35cb4cd34fa419803daf5019f1ea747c7a8e8f`；记录 commit：`3a35cb4cd34fa419803daf5019f1ea747c7a8e8f`
- Run：`not_run`；时间：not_run；环境：installed Windows EXE with an authorized real-provider error; not connected
- 命令或场景：not run
- 结果：`not_run`；skips：real provider error payloads, installed EXE read/export path and hostile real-world shapes
- Evidence path：`docs/diagnostics.md`
- 限制 / 未验证：合成敏感夹具、单元测试和本地构建不能替代已安装 EXE 在明确授权真实供应商错误下的 L6 验收。

### VER-ISSUE80-NEW-DATABASE-STARTUP-20260815

- 能力：Issue #80 legacy database retention and fresh desktop database startup
- 实现状态：`implemented_exact_head_ci_success`
- 目标层级：`L5`；已取得层级：`L2`
- 证据状态：`attained`（实际运行证据已取得）
- 目标真实范围：否；真实环境证据：未取得；scope：`synthetic_temporary_user_data_and_isolated_installer_smoke`
- Evidence type：`synthetic_user_data_and_desktop_unit_contract`
- Source commit：`01cd36c976b8e85f856e97abb73accf7c96b1245`；记录 commit：`01cd36c976b8e85f856e97abb73accf7c96b1245`
- Provenance：mode=`local_run`；base=`not_applicable`；head=`01cd36c976b8e85f856e97abb73accf7c96b1245`；merge=`not_applicable`；parents=``；tree=`not_applicable`；run=`local-issue80-new-database-startup-20260815-01`；job=`not_applicable`；environment=Windows local worktree; Node.js 24; temporary synthetic SQLite fixtures; desktop pure formatter tests; no real services or production data
- Skip classification：status=`present`；kinds=`capability, platform`；reason=历史记录明确列出未覆盖的环境或平台边界。
- Run：`local-issue80-new-database-startup-20260815-01`；时间：2026-08-15；环境：Windows local worktree; Node.js 24; temporary synthetic SQLite fixtures; desktop pure formatter tests; no real services or production data
- 命令或场景：database-path.test.ts: 1 passed; startup-errors.test.ts: 2 passed; installer Smoke synthetic userData: old ai-pm.sqlite SHA-256 unchanged, new ai-pm-v1.sqlite created and restarted, config preserved, unknown new-db bootstrap produced fixed redacted failure marker and exited
- 结果：`passed`；skips：Real historical database migration/import, Windows file-lock/reparse behavior, Authenticode signing, real Feishu/LLM/production data
- Evidence path：`docs/qa/README.md`
- 限制 / 未验证：Synthetic userData and isolated Smoke prove only the fresh-file path, old-file byte preservation, configuration retention, restart, and fixed startup error boundary. They do not prove migration/import of a real historical database, complete Windows L5, or real provider L6.

### VER-EXTERNAL-LINK-REAL-EXE

- 能力：已安装 Windows EXE 的 Electron 外链允许、拒绝与可见反馈
- 实现状态：`implemented_pending_windows_validation`
- 目标层级：`L5`；已取得层级：`未取得`
- 证据状态：`not_run`（未运行；未取得证据）
- 目标真实范围：否；真实环境证据：未取得；scope：`windows_installed_exe_not_run`
- Evidence type：`open_validation_item`
- Source commit：`unverified`；记录 commit：`unverified`
- Run：`not_run`；时间：not_run；环境：installed Windows EXE and system default browser; not run
- 命令或场景：not run
- 结果：`not_run`；skips：real Electron shell.openExternal, installed EXE feedback, default browser behavior and provider redirect final address
- Evidence path：`docs/user-guide.md`
- 限制 / 未验证：纯函数、IPC handler、preload/renderer 合同和浏览器 Mock 最多证明到 L4；拒绝结果的固定 reason/errorCode 仅为后续 OBS-01 接线准备，当前未持久化、未形成 operation/trace 链，也没有构建安装包或实际打开网络地址。真实租户文档域与供应商重定向属于另行 L6。

### VER-ISSUE45-PROD01-SOURCE-PRIVACY-L4-20260816

- 能力：Issue #45 PROD-01 默认来源最小化、严格 DTO 校验、主人主动核验与安全派生摘要
- 实现状态：`implemented_pending_exact_local_evidence`
- 目标层级：`L4`；已取得层级：`未取得`
- 证据状态：`not_run`（未运行；未取得证据）
- 目标真实范围：否；真实环境证据：未取得；scope：`synthetic_local_contract`
- Evidence type：`open_validation_item`
- Source commit：`not_run`；记录 commit：`pull_request_92_pending`
- Provenance：mode=`not_run`；base=`not_run`；head=`not_run`；merge=`not_run`；parents=``；tree=`not_run`；run=`not_run`；job=`not_run`；environment=not_run
- Skip classification：status=`present`；kinds=`capability, platform, not_executed`；reason=本轮 immutable local exact evidence 尚未生成；真实 Feishu/provider/tenant/production 与 Windows L5 安装验证不在本地 synthetic 运行范围。
- Run：`not_run`；时间：not_run；环境：not_run
- 命令或场景：not_run
- 结果：`not_run`；skips：本记录在 independent Reviewer、mechanical Merger 和 post-merge integration tip 验证完成前保持 not_run；不授权真实 Feishu、LLM、provider、生产数据库、生产数据、Windows Electron/NSIS L5 或真实租户/provider L6。当前 exact local candidate evidence 由 PR #92 body 携带并单独验证。
- Evidence path：`docs/qa/README.md`
- 限制 / 未验证：Synthetic/local L2-L4 contract scope only. Owner verification remains explicit, task-scoped, audited and external_action none, but proves only local snapshot handling; it does not prove current provider permission or revocation. Exact local evidence is candidate evidence, not a real external environment claim.

### VER-ISSUE33-SEC02-L3-20260816

- 能力：Issue #33 SEC-02 不可信数据 system contract、严格模型 schema 与服务端 post-adapter guard
- 实现状态：`implemented_pending_exact_pr_ci`
- 目标层级：`L4`；已取得层级：`L3`
- 证据状态：`attained`（实际运行证据已取得）
- 目标真实范围：否；真实环境证据：未取得；scope：`synthetic_local_no_external_actions`
- Evidence type：`synthetic_classifier_service_contract`
- Source commit：`77b1ab7c90fca0a599ce78d498b3dda4ab852eed`；记录 commit：`pull_request_88_pending`
- Provenance：mode=`local_run`；base=`not_applicable`；head=`77b1ab7c90fca0a599ce78d498b3dda4ab852eed`；merge=`not_applicable`；parents=``；tree=`not_applicable`；run=`local-issue33-sec02-20260817-rebind-02`；job=`not_applicable`；environment=Windows local worktree after ordinary merge of current integration tip 54c0c1e22f5a0fa78299b45e2401bfd1c8bca55a into SEC-02; Node.js 24; in-memory SQLite; deterministic malicious classifier fixtures across normalized source paths; exact PR #88 merge-ref CI pending
- Skip classification：status=`present`；kinds=`capability, platform`；reason=PR #88 exact merge-ref/pull_request CI 尚未取得；真实 Feishu/provider/tenant/production 与 Windows L5 安装验证不在本地 synthetic 运行范围。
- Run：`local-issue33-sec02-20260817-rebind-02`；时间：2026-08-17；环境：Windows local worktree after ordinary merge of current integration tip 54c0c1e22f5a0fa78299b45e2401bfd1c8bca55a into SEC-02; Node.js 24; in-memory SQLite; deterministic malicious classifier fixtures across normalized source paths; exact PR #88 merge-ref CI pending
- 命令或场景：SEC-02 targeted LLM/classifier and runtime boundary suites; server full suite; npm run check; lifecycle; Playwright inventory/E2E/verify; docs generate/check/test; changed-path gate; git diff --check
- 结果：`passed`；skips：PR #88 exact merge-ref and pull_request CI are pending and authoritative in the latest PR body; no real Feishu, LLM provider, tenant, production database/data, outbound send, Windows L5 or L6 validation
- Evidence path：`docs/qa/README.md`
- 限制 / 未验证：本记录只证明 synthetic L1-L3 contract replay and local service boundary behavior；不把 SEC-02 候选写成 PROD-01/#45 公共 DTO、主人核验 UI 或真实外部环境已验收。source/head/run/merge-ref 的最终远端新鲜度以 PR #88 body 为准，不能由本记录自引用。

### VER-ISSUE46-FAILURE-RELATION-L4-20260816

- 能力：Issue #46 失败来源收件箱：脱敏、幂等/CAS、来源与 Runtime 关系校验及 stale 保护
- 实现状态：`implemented_pending_exact_pr_ci`
- 目标层级：`L4`；已取得层级：`L4`
- 证据状态：`attained`（实际运行证据已取得）
- 目标真实范围：否；真实环境证据：未取得；scope：`synthetic_local_contract`
- Evidence type：`local_synthetic_service_pending_exact_merge_ref_ci`
- Source commit：`c12255dd3fb7fb6fee75bcd3ed301326bb178290`；记录 commit：`pull_request_82_pending`
- Provenance：mode=`local_run`；base=`not_applicable`；head=`c12255dd3fb7fb6fee75bcd3ed301326bb178290`；merge=`not_applicable`；parents=``；tree=`not_applicable`；run=`local-issue46-runtime-failure-fence-20260816-03`；job=`not_applicable`；environment=Windows local worktree after ordinary merge of current integration tip 9dfdfc65e0331cc4eabfe2510fc6e2974493576b; Node.js 24; in-memory SQLite; synthetic classifier/runtime fixtures; exact PR #82 merge-ref CI pending
- Skip classification：status=`present`；kinds=`capability, platform`；reason=历史记录明确列出未覆盖的环境或平台边界。
- Run：`local-issue46-runtime-failure-fence-20260816-03`；时间：2026-08-16；环境：Windows local worktree after ordinary merge of current integration tip 9dfdfc65e0331cc4eabfe2510fc6e2974493576b; Node.js 24; in-memory SQLite; synthetic classifier/runtime fixtures; exact PR #82 merge-ref CI pending
- 命令或场景：19 targeted source-failure tests including classify_source and classify_source_batch NULL owning-source list/action zero-write regressions; 94 Runtime recovery tests; 19 owner state-machine tests; owner_decision/reprocess_candidate zero-write; classify_source source-set/revision/link/duplicate zero-write; valid classify_source and classify_source_batch redacted audit; npm run check; lifecycle; full Playwright; docs generate/check/test; changed-path gate
- 结果：`passed`；skips：No real Feishu, LLM, production database, production data, installed Windows Electron/NSIS L5 Smoke or real-provider L6 validation; exact PR #82 merge-ref CI and final docs/head provenance remain PR-body authoritative
- Evidence path：`docs/qa/README.md`
- 限制 / 未验证：本地 SQLite、Mock、服务合同只证明 synthetic L4；exact merge-ref CI 成功前不能把本记录写成最终远端授权；PR body 是最终 docs/head/source/head/run/merge provenance，不由本记录自引用推导。

### VER-ISSUE39-FSH01-L3-20260816

- 能力：Issue #39 FSH-01 Feishu scope tri-state and shared durable scope gate for owner message, calendar and minutes runners
- 实现状态：`implemented_pending_exact_local_evidence`
- 目标层级：`L3`；已取得层级：`L2`
- 证据状态：`attained`（实际运行证据已取得）
- 目标真实范围：否；真实环境证据：未取得；scope：`synthetic_local_contract`
- Evidence type：`local_contract_and_scope_gate_fixture`
- Source commit：`f0dc21392e298cf5bd643284843ecc5dda84e40a`；记录 commit：`pull_request_89_pending`
- Provenance：mode=`local_run`；base=`not_applicable`；head=`f0dc21392e298cf5bd643284843ecc5dda84e40a`；merge=`not_applicable`；parents=``；tree=`not_applicable`；run=`local-20260818-fsh01-scope-gate`；job=`not_applicable`；environment=Windows; Node.js 24; isolated worktree; synthetic SQLite and virtual Feishu adapters; no real Feishu tenant, OAuth/provider or production data
- Skip classification：status=`present`；kinds=`capability, platform`；reason=Synthetic/local evidence only; real Feishu tenant scope reduction, OAuth/provider calls, production data and Windows L5/L6 are not claimed.
- Run：`local-20260818-fsh01-scope-gate`；时间：2026-08-18；环境：Windows; Node.js 24; isolated worktree; synthetic SQLite and virtual Feishu adapters; no real Feishu tenant, OAuth/provider or production data
- 命令或场景：owner/calendar/minutes shared durable-scope gate focused 83/83; malformed, empty, partial, wrong-case, duplicate and scope-clear concurrency fixtures; broader Feishu refresh/vault/migration suites; typecheck; docs and CI policy gates
- 结果：`passed`；skips：Real Feishu scope reduction/OAuth/provider behavior, production data and Windows L5/L6 not run
- Evidence path：`apps/server/tests/feishu-calendar-sync.test.ts`
- 限制 / 未验证：Synthetic/local contract evidence only; rejected owner/calendar/minutes runs assert zero provider calls, cursor writes and source/candidate business writes; no real tenant, provider, production or Windows L5/L6 claim.

### VER-ISSUE43-DURABLE-RETRY-L4-20260816

- 能力：Issue #43 typed provider retry propagation from synthetic provider failure to durable Runtime scheduling and shared cooldown
- 实现状态：`implemented_local_exact_candidate_pending_independent_review`
- 目标层级：`L4`；已取得层级：`L2`
- 证据状态：`attained`（实际运行证据已取得）
- 目标真实范围：否；真实环境证据：未取得；scope：`synthetic_local_sqlite_provider_fixture_schema_v8`
- Evidence type：`local_exact_sqlite_runtime_browser`
- Source commit：`42cef3c8dc5c32b695b6eab2e710f992305eebe7`；记录 commit：`pull_request_43_pending`
- Provenance：mode=`local_run`；base=`not_applicable`；head=`42cef3c8dc5c32b695b6eab2e710f992305eebe7`；merge=`not_applicable`；parents=``；tree=`not_applicable`；run=`local-20260818T115005Z-1675ceaa`；job=`not_applicable`；environment=Windows local exact worktree; Node.js 24.19.0; npm 11.17.0; synthetic SQLite, virtual provider adapters, virtual clock and Playwright browser fixtures; no real Feishu/LLM/provider, production data or signed release
- Skip classification：status=`present`；kinds=`capability, platform`；reason=Local synthetic evidence does not prove real provider rate limiting, Feishu/LLM tenant behavior, production data, signed Windows installer L5 or provider/tenant L6; exact pull_request merge-ref and CI remain a separate remote provenance gate.
- Run：`local-20260818T115005Z-1675ceaa`；时间：2026-08-18T11:50:05+08:00；环境：Windows local exact worktree; Node.js 24.19.0; npm 11.17.0; synthetic SQLite, virtual provider adapters, virtual clock and Playwright browser fixtures; no real Feishu/LLM/provider, production data or signed release
- 命令或场景：Focused RUN-02 migration/relations 109 passed; runtime/retry 238 passed; owner/source-failure regression 61 passed; npm run check (server 847, web 50, desktop 175, typecheck/build/artifact verification); lifecycle 5/5; Playwright inventory/execution/verify 92/92; git diff --check; exact local publication 7 commands passed with zero failed/skipped/zero-test/truncated
- 结果：`passed`；skips：No real provider rate limiting, Feishu/LLM tenant or production data, signed Windows release, or provider/tenant L6 validation; exact pull_request merge-ref and terminal CI remain authoritative remote gates
- Evidence path：`docs/qa/README.md`
- 限制 / 未验证：Local exact evidence proves the synthetic SQLite/runtime/browser contract and immutable provenance only at attained L2. Issue #43 remains OPEN pending independent review and current exact PR merge-ref/CI; no real provider/tenant, production data, signed Windows installer L5 or L6 evidence is claimed.

### VER-ISSUE34-PRIVACY-L2-20260817

- 能力：Issue #34 PRIV-001 隐私生命周期：停止采集/本地撤权、受控导出、二次确认硬删除、留存执行、受管备份校验/恢复登记与失败补偿
- 实现状态：`implemented_local_exact_candidate_pending_independent_review`
- 目标层级：`L4`；已取得层级：`L2`
- 证据状态：`attained`（实际运行证据已取得）
- 目标真实范围：否；真实环境证据：未取得；scope：`synthetic_local_contract`
- Evidence type：`synthetic_sqlite_service_api`
- Source commit：`b34f7e0a6d7f4ffbe254cd2fa42830ee850d89cb`；记录 commit：`pull_request_98_pending`
- Provenance：mode=`local_run`；base=`not_applicable`；head=`b34f7e0a6d7f4ffbe254cd2fa42830ee850d89cb`；merge=`not_applicable`；parents=``；tree=`not_applicable`；run=`local-20260817T201429Z-6360d8f7`；job=`not_applicable`；environment=Local exact PRIV-001 candidate head b34f7e0a6d7f4ffbe254cd2fa42830ee850d89cb on formal integration base c7fa0228b12e96f6eed071bf5ff6ac489ae49dc7; Node.js 24.19.0; npm 11.17.0; synthetic temporary SQLite; Fastify inject; virtual adapters; local browser fixtures; no real services or production data
- Skip classification：status=`present`；kinds=`capability, platform`；reason=Exact GitHub pull_request merge-ref and terminal CI remain a separate remote provenance claim; real Feishu OAuth, provider calls, platform backup residue, Windows file-lock behavior, legal compliance and L5/L6 are outside synthetic validation.
- Run：`local-20260817T201429Z-6360d8f7`；时间：2026-08-17；环境：Local exact PRIV-001 candidate head b34f7e0a6d7f4ffbe254cd2fa42830ee850d89cb on formal integration base c7fa0228b12e96f6eed071bf5ff6ac489ae49dc7; Node.js 24.19.0; npm 11.17.0; synthetic temporary SQLite; Fastify inject; virtual adapters; local browser fixtures; no real services or production data
- 命令或场景：Focused privacy/migration/DATA-02/DATA-03/RUN-01/SEC-02 suites including expiry/reclaim, malformed/clock rollback and active-update zero-write cases; full server with single-thread pool and default timeout; typecheck/build/artifact; docs and CI policy; lifecycle; Playwright inventory/execution/verify; changed-path and git diff --check
- 结果：`passed`；skips：Exact GitHub refs/pull/98/merge and terminal pull_request CI remain authoritative in the Draft PR body; no real Feishu/provider, production data, installed Windows package or L5/L6 validation
- Evidence path：`apps/server/tests/privacy.test.ts`
- 限制 / 未验证：The local exact evidence covers owner/capability/intent binding, zero side effects before validation, durable v6 claim expiry/reclaim/fencing, recoverable DB/filesystem coordination, strict path and backup enumeration, and non-content proof. It does not authorize the final candidate: independent Reviewer approval and Issue #111 governance remain required, while remote merge-ref/CI facts are recorded separately in the Draft PR body.

### VER-ISSUE55-DRAFT-ONLY-L4-20260816

- 能力：Issue #55 OUT-01 M1 draft-only approval/outbox 状态、原子失效、幂等和安全 DTO/UI
- 实现状态：`implemented_exact_head_ci_success`
- 目标层级：`L4`；已取得层级：`L4`
- 证据状态：`attained`（实际运行证据已取得）
- 目标真实范围：否；真实环境证据：未取得；scope：`synthetic_local_contract`
- Evidence type：`local_synthetic_sqlite_service_api_ui`
- Source commit：`71653383da6bbb508495f09154b09e386e919d88`；记录 commit：`pull_request_99_pending`
- Provenance：mode=`local_run`；base=`not_applicable`；head=`71653383da6bbb508495f09154b09e386e919d88`；merge=`not_applicable`；parents=``；tree=`not_applicable`；run=`local-issue55-draft-only-20260816-01`；job=`not_applicable`；environment=Windows local worktree; Node.js 24; in-memory SQLite; Fastify inject; virtual adapters and Playwright Chromium; synthetic data only
- Skip classification：status=`present`；kinds=`capability, platform`；reason=该 exact CI 不提供真实 provider/tenant/production 环境，也不执行已安装 Windows Electron/NSIS L5 验收。
- Run：`local-issue55-draft-only-20260816-01`；时间：2026-08-16；环境：Windows local worktree; Node.js 24; in-memory SQLite; Fastify inject; virtual adapters and Playwright Chromium; synthetic data only
- 命令或场景：Targeted server contracts: runtime-run01 18 passed, app 26 passed, mature 16 passed, runtime-thread-memory 99 passed (159 selected); full npm run check: server 593, web 23, desktop 134, matcher 10, docs tests 24 passed/1 platform skip, CI policy 31, typecheck/build/artifact verifier passed; lifecycle 5/5; Playwright inventory 84 and execution 84 passed, 0 skipped (desktop 43, mobile 41); task approval/outbox idempotency, reject/obsolete invalidation, rollback-safe lifecycle, redacted DTO, no-send API/UI contracts, and M1 external.send forbidden callback/provider zero-call contract
- 结果：`passed`；skips：No real send, provider consumer, external recipient, production database/data, installed Windows Electron/NSIS L5, real Feishu/LLM/provider L6, or migration of an unknown historical database; approved/ready/sent remain legacy schema-reserved compatibility values
- Evidence path：`docs/qa/README.md`
- 限制 / 未验证：Synthetic SQLite/service/API/UI and regression gates prove only local L4 behavior. M1 permanently remains draft-only; approved=true external.send is forbidden before callback/provider and legacy approved/ready/sent rows cannot resume execution. No claim is made that any message was sent or that a future real-send workflow is safe. Exact PR base/head/merge-ref/tree/parents/run/job remain PR-body authoritative.

### VER-ISSUE29-OWNER-RETIREMENT-L2-20260816

- 能力：Issue #29 owner-decision retirement, durable call-start target snapshots and fail-closed stale/noop recovery
- 实现状态：`implemented_pending_exact_pr_ci`
- 目标层级：`L2`；已取得层级：`L2`
- 证据状态：`attained`（实际运行证据已取得）
- 目标真实范围：否；真实环境证据：未取得；scope：`synthetic_local_contract`
- Evidence type：`synthetic_sqlite_service_tests`
- Source commit：`60e10b1f1f9df0c9580772487e07b623e600a03e`；记录 commit：`pull_request_93_pending`
- Provenance：mode=`local_run`；base=`not_applicable`；head=`60e10b1f1f9df0c9580772487e07b623e600a03e`；merge=`not_applicable`；parents=``；tree=`not_applicable`；run=`pull_request_93_pending`；job=`not_applicable`；environment=Windows local worktree after ordinary merge of integration/m1-test-20260815 @ 54c0c1e22f5a0fa78299b45e2401bfd1c8bca55a; Node.js 24; in-memory SQLite; Fastify inject/service fixtures; synthetic data only
- Skip classification：status=`present`；kinds=`capability, platform`；reason=No real Feishu, LLM, provider, production database/data, installed Windows Electron/NSIS L5 or tenant L6 validation.
- Run：`pull_request_93_pending`；时间：2026-08-17；环境：Windows local worktree after ordinary merge of integration/m1-test-20260815 @ 54c0c1e22f5a0fa78299b45e2401bfd1c8bca55a; Node.js 24; in-memory SQLite; Fastify inject/service fixtures; synthetic data only
- 命令或场景：Focused owner state-machine 42/42; DATA-03 19/19; server full 635/635; web 26/26; desktop 134/134; npm run check passed (matcher 10/10, docs tests 27/28 with 1 platform skip, CI policy 58/58, typecheck/build/artifact verifier); lifecycle 5/5; Playwright inventory/execution 86/86 with 0 skipped (desktop 44, mobile 42); docs generate/check/test and diff-check passed
- 结果：`passed`；skips：Fresh exact pull_request CI, merge-ref/tree/parents and final remote provenance remain PR #93 body authoritative; no real Feishu, LLM, provider, production database/data, installed Windows Electron/NSIS L5 or tenant L6 validation.
- Evidence path：`apps/server/tests/owner-message-state-machine.test.ts`
- 限制 / 未验证：Synthetic SQLite/service evidence proves only the local L2 contract. Owner_decision audit is retained; no automatic execution or external send is enabled. Fresh exact base/head/merge-ref/tree/parents/run/job and final test counts must be bound by Draft PR #93 after the local rerun and exact CI SUCCESS; this does not prove real tenant/provider behavior, Windows installation, or L6 recovery.

### VER-ISSUE65-GOVERNANCE-L0-20260816

- 能力：Issue #65 handoff、RACI、CODEOWNERS、stacked PR 和可恢复协作 SOP；integration 声明区分 committed_base_snapshot、PR pending 与 live ref，push merge 第一父例外仅接受明确 snapshot
- 实现状态：`implemented_pending_exact_pr_ci`
- 目标层级：`L0`；已取得层级：`L0`
- 证据状态：`attained`（实际运行证据已取得）
- 目标真实范围：否；真实环境证据：未取得；scope：`repository_governance_only`
- Evidence type：`local_synthetic_governance_check`
- Source commit：`5403da9477f834f9ac63f50220650f5687a30967`；记录 commit：`pull_request_91_pending`
- Provenance：mode=`local_run`；base=`not_run`；head=`5403da9477f834f9ac63f50220650f5687a30967`；merge=`not_applicable`；parents=``；tree=`not_run`；run=`local-issue65-governance-20260816-05`；job=`not_applicable`；environment=Windows local worktree; Node.js 24.19.0; npm 11.17.0; synthetic repository metadata; Playwright Chromium desktop 1440x900 and mobile Pixel 7
- Skip classification：status=`present`；kinds=`capability, platform`；reason=平台 API 无法提供 branch protection/rulesets 事实；真实外部服务和 Windows L5/L6 不在本地 synthetic 环境。
- Run：`local-issue65-governance-20260816-05`；时间：2026-08-16T20:21:24+08:00；环境：Windows local worktree; Node.js 24.19.0; npm 11.17.0; synthetic repository metadata; Playwright Chromium desktop 1440x900 and mobile Pixel 7
- 命令或场景：node --test scripts/docs-check.test.mjs; npm run governance:test; node scripts/governance-check.mjs; npm run docs:generate; npm run docs:check; npm run docs:test; npm run ci:policy:test; npm run check; npm run typecheck; npm run test:e2e:lifecycle; npm run test:e2e:inventory; npm run check:runtime; E2E_REUSE_BUILD=1 E2E_EVIDENCE=1 npm run test:e2e; npm run test:e2e:verify; git diff --check
- 结果：`passed`；skips：GitHub branch protection/rulesets 只读 API 在 2026-08-16T19:22:35+08:00 返回 HTTP 403 平台限制；不涉及真实 Feishu/LLM/production data、Windows L5 或真实 provider/tenant L6。
- Evidence path：`CONTRIBUTING.md`
- 限制 / 未验证：本地治理、源码、生命周期和合成浏览器证据达到 L0/L4 仅限所列步骤；不能证明 GitHub branch protection、required review、rulesets 已服务器强制，也不能证明真实 Feishu/LLM、生产数据、Windows L5 或真实 provider/tenant L6。提交内使用 pull_request_91_pending 避免自引用；当前 PR 的 exact base/head/merge-ref/tree/parents/run/job 与 terminal SUCCESS 只能由 PR #91 最新 body 和新一轮 pull_request CI 绑定，任何旧 event base 或旧 merge-ref CI 均仅作 historical，不构成当前授权。

### VER-ISSUE38-DATA04-L4-20260818

- 能力：Issue #38 DATA-04 连续 schema v7：不可变来源修订、精确 replay reference、canonical decision-scope binding、CAS/stale fence、隐私生命周期与强制服务层回放授权
- 实现状态：`implemented_pending_independent_review`
- 目标层级：`L4`；已取得层级：`L4`
- 证据状态：`attained`（实际运行证据已取得）
- 目标真实范围：否；真实环境证据：未取得；scope：`synthetic_local_sqlite_service_browser_contract`
- Evidence type：`synthetic_local_sqlite_service_browser`
- Source commit：`108d8eb4031a3ac3d4381516a4ea0205895ac350`；记录 commit：`pull_request_108_pending`
- Provenance：mode=`local_run`；base=`not_applicable`；head=`108d8eb4031a3ac3d4381516a4ea0205895ac350`；merge=`not_applicable`；parents=``；tree=`not_applicable`；run=`local-20260817T234313Z-18e3b200`；job=`not_applicable`；environment=Windows local exact worktree; Node.js 24.19.0; npm 11.17.0; synthetic SQLite/Fastify/Playwright; no real services or production data
- Skip classification：status=`present`；kinds=`capability, platform`；reason=Local exact evidence is synthetic and does not cover real external or Windows L5/L6 environments; independent review and remote PR freshness are separate gates.
- Run：`local-20260817T234313Z-18e3b200`；时间：2026-08-17；环境：Windows local exact worktree; Node.js 24.19.0; npm 11.17.0; synthetic SQLite/Fastify/Playwright; no real services or production data
- 命令或场景：Fresh exact local verification: focused DATA-04/migration/replay/authorization/DATA-02/DATA-03/privacy/RUN-01 suites; direct service and HTTP attack regressions for canonical decision-scope mutations (source/revision/demand-unit/candidate/task/owner lineage), missing/forged/expired/revoked/consumed/wrong-owner/intent/origin/CSRF capability; full docs/CI/runtime/lifecycle/Playwright gates; 0 failed, 0 skipped, 0 zero-test; diff-check
- 结果：`passed`；skips：Independent review and remote PR exact freshness remain pending; no real Feishu, LLM/provider, production data, installed Windows package or L5/L6 validation
- Evidence path：`apps/server/tests/data-04-source-revision.test.ts`
- 限制 / 未验证：本地 exact evidence 只证明 synthetic/local L2-L4；此前一次 Playwright ERR_NO_BUFFER_SPACE 失败运行已保留为历史且未推进 current pointer，随后以 7 个 required gate、0 failed、0 skipped、0 zero-test 的新 run 发布 current pointer。服务层先以 canonical decision-scope 校验 decision→ordered references→source/demand/candidate/task/owner lineage，再消费 durable capability；但独立 Reviewer、远程 PR freshness、真实 Feishu edit/recall、LLM/provider、生产数据、Windows L5/L6 仍未取得。

### VER-ISSUE111-QA02-L4-20260818

- 能力：完全本地 exact verification 的 Git changed-path/plan/gate 重算、严格 schema、计数守恒与 crash-safe generation/lease/CAS evidence 发布；immutable candidate reader、identity-specific lease/reclaim paths 与 A-D publication fencing
- 实现状态：`implemented_pending_independent_review_and_cutover`
- 目标层级：`L4`；已取得层级：`L4`
- 证据状态：`attained`（实际运行证据已取得）
- 目标真实范围：否；真实环境证据：未取得；scope：`local_exact_verification_infrastructure_only`
- Evidence type：`local_exact_verification_infrastructure`
- Source commit：`adc56a0ab271228bb3f38d2d5f426f2df9d8d480`；记录 commit：`pull_request_114_pending`
- Provenance：mode=`local_run`；base=`not_applicable`；head=`adc56a0ab271228bb3f38d2d5f426f2df9d8d480`；merge=`not_applicable`；parents=``；tree=`not_applicable`；run=`local-20260818T083833Z-d2f27a74`；job=`not_applicable`；environment=Windows local exact verification; Node.js 24.19.0; npm 11.17.0; synthetic SQLite/Fastify/Playwright; no real services or production data
- Skip classification：status=`present`；kinds=`capability, platform`；reason=GitHub Actions are disabled and Windows/real external environments are outside local synthetic scope; independent review and post-merge evidence are separate gates.
- Run：`local-20260818T083833Z-d2f27a74`；时间：2026-08-18；环境：Windows local exact verification; Node.js 24.19.0; npm 11.17.0; synthetic SQLite/Fastify/Playwright; no real services or production data
- 命令或场景：Fresh exact current-base local verification: base a487598bcae3630f1c5906c8b384bc8811ee0e29; head adc56a0ab271228bb3f38d2d5f426f2df9d8d480; virtual merge c63678dc01c26517fb59bb18ce0c16e9f4467c43; tree 641921bfdf5403b776f415191520a90e85c06ab5; changed-path/plan recomputation; docs/CI/runtime/lifecycle/Playwright required gates; immutable generation/lease/CAS publication; 7 commands passed, 0 failed, 0 skipped, 0 zero-test
- 结果：`passed`；skips：Independent Reviewer, ordinary merge and post-merge integration evidence remain pending; no real provider, production data, signed Windows Release, L5 or L6 validation.
- Evidence path：`docs/local-verification.md`
- 限制 / 未验证：本项只证明基于 committed integration snapshot a487598bcae3630f1c5906c8b384bc8811ee0e29 的可重验本地 exact evidence 机制和本候选 clean exact publication；virtual merge 仅为本地验证对象，不是 GitHub Actions 或远端合入事实。失败/截断/partial write 只保留历史且不推进 current pointer/root；本次 current generation 20260818083833834-e93c075e / run local-20260818T083833Z-d2f27a74 已通过 7 个 required gate，0 failed、0 skipped、0 zero-test，并绑定 candidate fingerprint 2d8a91b1f566e5266d08b4018a9d27d01cff1cdc6704a4b613414992529310ff。真实 provider、生产数据、签名 Windows L5/L6、独立 Reviewer、普通合入和 post-merge evidence 仍未取得。

### VER-ISSUE41-FSH03-L4-20260818

- 能力：Issue #41 FSH-03 飞书 WebSocket durable inbox-before-ack、幂等去重、重启恢复和来源/主人范围 fencing
- 实现状态：`implemented_pending_independent_review_and_exact_freshness`
- 目标层级：`L4`；已取得层级：`L4`
- 证据状态：`attained`（实际运行证据已取得）
- 目标真实范围：否；真实环境证据：未取得；scope：`synthetic_local_feishu_contract_only`
- Evidence type：`synthetic_local_sqlite_service_contract_browser_regression`
- Source commit：`dcf3d01ed6ba6fb2a876afc2f86171ab23a010ad`；记录 commit：`pull_request_114_pending`
- Provenance：mode=`local_run`；base=`not_applicable`；head=`dcf3d01ed6ba6fb2a876afc2f86171ab23a010ad`；merge=`not_applicable`；parents=``；tree=`not_applicable`；run=`local-issue41-fsh03-20260818-02`；job=`not_applicable`；environment=Windows local worktree; Node.js 24; synthetic SQLite/Fastify/Vitest/Playwright; no real Feishu tenant, provider or production data
- Skip classification：status=`present`；kinds=`capability, platform`；reason=Local synthetic SQLite/service/browser gates cannot provide a real Feishu tenant, external provider, production data or Windows L5 environment.
- Run：`local-issue41-fsh03-20260818-02`；时间：2026-08-18；环境：Windows local worktree; Node.js 24; synthetic SQLite/Fastify/Vitest/Playwright; no real Feishu tenant, provider or production data
- 命令或场景：Focused FSH-03 durable-ack tests: 59/59; npm run check passed (docs 42 passed/1 platform skip, CI policy 63, server 848, web 26, desktop 175, typecheck/build/artifact verification); lifecycle 5/5; Playwright inventory/execution/verification 88/88 (desktop 45, mobile 43, 0 skipped); git diff --check
- 结果：`passed`；skips：No real Feishu WebSocket, tenant permissions, provider/LLM, production database/data, signed Windows installer L5 or tenant/provider L6 validation; independent review, ordinary merge and post-merge evidence remain pending.
- Evidence path：`apps/server/tests/feishu-durable-ack.test.ts`
- 限制 / 未验证：本地证据证明回调等待 durable receipt、commit 前失败不确认、commit 后重复可重试、并发/乱序事实去重、孤儿来源重启恢复及 scope fail-closed；不证明真实飞书长连接 ACK 时序、租户权限、真实 provider/生产数据、Windows L5/L6。独立 Reviewer、普通合入和 post-merge exact evidence 仍待完成。

### VER-AILY-SDK-ISOLATED-20260827

- 能力：独立 TooManyTasks OAuth/TokenStore/Aily SDK、SSE、持久窗口、Cindy 薄插件与 SQLite/CAS 入库合同
- 实现状态：`implemented_pending_commit`
- 目标层级：`L3`；已取得层级：`L3`
- 证据状态：`attained`（实际运行证据已取得）
- 目标真实范围：否；真实环境证据：未取得；scope：`synthetic_local_oauth_tokenstore_aily_sdk_cindy_intake`
- Evidence type：`synthetic_independent_service_thin_plugin_contract`
- Source commit：`b3f09335eaa1538e3fae987431def97125dbdd2c`；记录 commit：`pull_request_aily_pending`
- Provenance：mode=`local_run`；base=`not_applicable`；head=`b3f09335eaa1538e3fae987431def97125dbdd2c`；merge=`not_applicable`；parents=``；tree=`not_applicable`；run=`local-aily-sdk-intake-20260827-04`；job=`not_applicable`；environment=macOS Darwin 25.5.0 arm64; Node.js 26.4.0; npm 11.17.0; synthetic SDK/SQLite/Fastify fixtures; no real Feishu tenant, Aily provider, production data or external credentials
- Skip classification：status=`present`；kinds=`capability, platform`；reason=本地合成测试和构建可以验证仓库合同，但当前环境没有真实 Aily/飞书租户、Cindy 宿主 errand 或 Windows L5 载体。
- Run：`local-aily-sdk-intake-20260827-04`；时间：2026-08-27T16:05:21+08:00；环境：macOS Darwin 25.5.0 arm64; Node.js 26.4.0; npm 11.17.0; synthetic SDK/SQLite/Fastify fixtures; no real Feishu tenant, Aily provider, production data or external credentials
- 命令或场景：npm run typecheck; npm run test:plugin (50/50); npm run test:server:current (42/42); npm run test:web:current (13/13); npm test (server 42, web 13); npm run build; npm run build:plugin; npm run docs:test (43/43); git diff --check. Tests cover encrypted local credentials, blank-by-default App/Agent identity, one-time OAuth state, refresh token renewal and temporary failure retention, official SDK user-token injection, bounded UTF-8/event SSE parsing, Aily/Cindy cursor fencing, empty-window advancement, server receipt authority including contradictory model status, source provenance, CAS and thin-plugin package allowlist.
- 结果：`passed`；skips：真实 Aily/飞书租户 OAuth、用户 Token 权限覆盖、真实 Cindy 宿主 errand、生产数据、Windows 安装 Smoke L5 和真实 provider/tenant L6 未执行。
- Evidence path：`apps/server/tests/aily.test.ts`
- 限制 / 未验证：证据覆盖当前工作树的独立服务、加密 TokenStore、薄插件、SQLite 合同和本地构建；记录使用当前已提交基线 commit 并标记 pending commit，提交后需重新绑定 exact source/PR/CI provenance。Cindy 宿主仍没有稳定的 errand 工具白名单合同，TooManyTasks 也尚未提供独立常驻调度器或安装器。Aily 摘要仍是 limited 的派生证据，真实 Agent 技能、用户授权可见范围、飞书知识库覆盖、限流、refresh token 轮换、撤权和真实端到端聊天结果仍需在用户授权环境中单独验收。

## 使用规则

- “目标层级”只表示计划达到哪里；只有“已取得层级”和“证据状态”才能说明已经得到什么证据。
- `not_run` 明确表示未取得证据；`historical_documented_claim` 只是历史声明、未独立复验，二者都不能显示为真实环境证据已取得。
- Artifact 的 hash 只证明该产物的完整性或身份；不能替代插件、server 或 web 的实际运行证据。
- Mock、契约、回放、浏览器 E2E 和构建产物均不能写成真实外部连接验证。
- 历史测试数字保留在 CHANGELOG / QA；入口文档只引用验证 ID。
