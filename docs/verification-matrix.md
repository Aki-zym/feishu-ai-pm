<!-- 此文件由 scripts/docs-check.mjs --write 根据 verification-matrix.json 生成。不要手工修改。 -->

# 验证矩阵

机器事实源：[`docs/verification-matrix.json`](verification-matrix.json)。当前产品状态见 [当前状态](current-state.md)。
产品源码快照：日期 `2026-08-15`；等价 commit `null`；算法 `product-source-sha256-v1`；选择器 `apps-workspace-default-include-v1`；文件数 `53`；fingerprint `86d5f1326b3f6b13e7091ed99d2d22f71b9513796f591602dca49acf9c7e0b45`。

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
| VER-ISSUE62-REL01-GATE-20260816 | Windows L5 release manifest、签名授权、精确 artifact provenance、安装升级回退与严格清理门禁基础设施 | L5 | 未取得 | 未运行；未取得证据 | open_validation_item | unverified | not_run | 未取得 |
| VER-EXTERNAL-LINK-REAL-EXE | 已安装 Windows EXE 的 Electron 外链允许、拒绝与可见反馈 | L5 | 未取得 | 未运行；未取得证据 | open_validation_item | unverified | not_run | 未取得 |
| VER-ISSUE45-PROD01-SOURCE-PRIVACY-L4-20260816 | Issue #45 PROD-01 默认来源最小化、严格 DTO 校验、主人主动核验与安全派生摘要 | L4 | 未取得 | 未运行；未取得证据 | open_validation_item | not_run | not_run | 未取得 |
| VER-AILY-SDK-ISOLATED-20260827 | 独立 TooManyTasks OAuth/TokenStore/Aily SDK、SSE、schema v9 摘要 inbox、20 分钟生产调度、5 分钟 Cindy 消费、SQLite/CAS 原子入库与 Agent 首次安装编排合同 | L3 | L3 | 实际运行证据已取得 | synthetic_independent_service_thin_plugin_contract | c31889336997509dfa21a1c3ff9b1845d23ce0e1 | local-aily-agent-install-20260827-06 | 未取得 |

## 证据详情

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

### VER-AILY-SDK-ISOLATED-20260827

- 能力：独立 TooManyTasks OAuth/TokenStore/Aily SDK、SSE、schema v9 摘要 inbox、20 分钟生产调度、5 分钟 Cindy 消费、SQLite/CAS 原子入库与 Agent 首次安装编排合同
- 实现状态：`implemented_pending_commit`
- 目标层级：`L3`；已取得层级：`L3`
- 证据状态：`attained`（实际运行证据已取得）
- 目标真实范围：否；真实环境证据：未取得；scope：`synthetic_local_oauth_tokenstore_aily_sdk_cindy_intake`
- Evidence type：`synthetic_independent_service_thin_plugin_contract`
- Source commit：`c31889336997509dfa21a1c3ff9b1845d23ce0e1`；记录 commit：`pull_request_aily_pending`
- Provenance：mode=`local_run`；base=`not_applicable`；head=`c31889336997509dfa21a1c3ff9b1845d23ce0e1`；merge=`not_applicable`；parents=``；tree=`not_applicable`；run=`local-aily-agent-install-20260827-06`；job=`not_applicable`；environment=macOS Darwin 25.5.0 arm64; Node.js 26.4.0; npm 11.17.0; synthetic SDK/SQLite/Fastify fixtures; no real Feishu tenant, Aily provider, production data or external credentials
- Skip classification：status=`present`；kinds=`capability, platform`；reason=本地合成测试和构建可以验证仓库合同，但当前环境没有真实 Aily/飞书租户、Cindy 宿主 errand 或 Windows L5 载体。
- Run：`local-aily-agent-install-20260827-06`；时间：2026-08-27T22:27:38+08:00；环境：macOS Darwin 25.5.0 arm64; Node.js 26.4.0; npm 11.17.0; synthetic SDK/SQLite/Fastify fixtures; no real Feishu tenant, Aily provider, production data or external credentials
- 命令或场景：npm run test:agent (5/5); isolated lifecycle on temporary config root and port 4399: start, health, generated local integration token, authenticated enable-scan accepted, stop; npm run test:current (plugin 36/36, server 50/50, web 13/13); npm run typecheck; npm run build; npm run build:plugin; npm run docs:test (43/43); git diff --check. Tests cover Agent scope/config validation and redaction, encrypted local credentials, OAuth and refresh, official SDK user-token injection, bounded UTF-8/event SSE parsing, schema v9 fresh/v8 migration, 20-minute scheduler lifecycle and singleflight, atomic inbox persistence/cursor advancement, empty-window audit, Bearer claim, 10-minute lease, reclaim, retry, Cindy five-minute polling, service receipt authority, source provenance, CAS rollback and thin-plugin package allowlist.
- 结果：`passed`；skips：真实 Aily/飞书租户 OAuth、用户 Token 权限覆盖、真实 Cindy 宿主 errand、生产数据、Windows 安装 Smoke L5 和真实 provider/tenant L6 未执行。
- Evidence path：`scripts/agent-runtime.test.mjs`
- 限制 / 未验证：证据覆盖当前工作树的独立服务、加密 TokenStore、官方 SDK/SSE、schema v9 inbox、20 分钟调度、5 分钟薄插件消费、SQLite 事务、本地构建，以及 Agent 安装脚本的配置、脱敏、本机令牌和隔离生命周期合同；记录使用当前已提交基线 commit 并标记 pending commit，提交后需重新绑定 exact source/PR/CI provenance。真实飞书后台创建自建应用、真实 Aily Agent 创建与发布、真实 OAuth、企业管理员审批和真实 Cindy 插件安装仍需在目标用户环境执行。Aily 摘要仍是 limited 的派生证据，真实用户授权可见范围、知识库覆盖、限流、refresh token 轮换、撤权和端到端聊天结果仍需单独验收。

## 使用规则

- “目标层级”只表示计划达到哪里；只有“已取得层级”和“证据状态”才能说明已经得到什么证据。
- `not_run` 明确表示未取得证据；`historical_documented_claim` 只是历史声明、未独立复验，二者都不能显示为真实环境证据已取得。
- Artifact 的 hash 只证明该产物的完整性或身份；不能替代插件、server 或 web 的实际运行证据。
- Mock、契约、回放、浏览器 E2E 和构建产物均不能写成真实外部连接验证。
- 历史测试数字保留在 CHANGELOG / QA；入口文档只引用验证 ID。
