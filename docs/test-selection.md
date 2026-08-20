# 测试选层与证据门禁

本页解释 Issue #59 / QA-01 的可执行合同。机器唯一事实源是 [验证矩阵](verification-matrix.json) 的 `selection_policy` 与 `evidence_contract`；本页不能替代 CI 输出或验证记录。

## Changed path 选择

CI 先对完整 `base → merge-ref` diff 使用统一分类器，再选择最低证据层级。分类优先级为：文档、发布、Feishu/LLM 适配、测试/CI、Web、Desktop、服务/数据/运行时、unknown。

| 变更路径 | 最低目标层级 | 最低门禁 | 说明 |
|---|---:|---|---|
| `docs/**`、入口文档 | L0 | docs generate/check/test | 只能证明文档和仓库元数据一致 |
| tests、fixtures、已明确匹配测试命名的 `scripts/**`、`.github/**`、测试配置 | L1 | docs + check + lifecycle + E2E | 未明确识别的脚本按 unknown/full/high-risk 处理，测试改动不能缩小产品门禁 |
| QA/证据/CI 控制脚本（`scripts/ci-*`、`evidence-record-policy`、`docs-check`、Playwright evidence/inventory/verifier、`run-ci-command`） | L4 | full + contract replay + exact provenance + manual review | 代码内置 floor，配置只能提高不能降低；不得改成 test-ci-only/docs-only |
| `apps/server/**`、`apps/url-policy/**`、根运行配置 | L2 | docs + check + lifecycle + E2E | 服务/SQLite/运行配置需执行集成检查 |
| Feishu 或 LLM integration | L3 | 上述门禁 + contract/replay/scope 或 redaction 证据 | Mock/replay 不等于真实 provider |
| `apps/web/**` | L4 | 上述门禁 + 两个浏览器 project 的完整 E2E | 浏览器 Mock 不等于 Electron |
| `apps/desktop/**` | L5 | 上述门禁 + lifecycle + 精确包的 Windows Smoke | Ubuntu CI 不能自行声称 Windows L5 |
| `release/**`、打包配置 | L5 | artifact hash/source binding + Windows Smoke | hash 不能替代实际安装运行 |
| unknown、绝对路径、父目录逃逸、空 diff 或 mixed | 按最高风险处理 | 完整门禁 + 人工复核 | `claim_authorized=false`，不能由窄证据授权 broad L5/L6 |

unknown 和 mixed path 必须保守选择完整门禁；它们不能被 manifest 修改成 docs-only。另有一组代码内置的 protected control-plane 路径：`AGENTS.md`、`docs/verification-matrix.json`、`docs/docs-manifest.json`、`docs/decision-register.json`、`docs/domain-contracts.json`、`docs/security_and_privacy.md`、`docs/test-selection.md`、`docs/product-rules/**`、`package.json`、`package-lock.json`、`.github/workflows/**`，以及 CI 计划、选层策略、证据合同和 docs-check 脚本及其测试。任何 protected 路径变化都强制完整门禁和人工复核，即使可配置策略把它分类为 docs-only；策略 schema、受控 evidence 名称、path-rule 形状、category floor 及 unknown/mixed fail-closed 语义也会在加载和 docs-check 时深度校验。`ci-plan.json` 会记录分类、最低层级、所需证据和人工复核标记。

Vitest inventory 默认执行三个 workspace 的完整清单：`npm test`。需要定向回归时必须显式指定 workspace，例如 `npm test -- --workspace server`；单文件回归使用 `npm test -- --workspace server --file tests/app.test.ts`。workspace 只能是 `server`、`web` 或 `desktop`，文件必须是该 workspace 内已经存在的测试文件；空目标、未知 workspace、非法路径和非测试文件都会 fail-closed。CI 仍只调用无参数的全量 inventory。

`.github/workflows/ci.yml`、`scripts/run-vitest-inventory.mjs`、CI 选择器/inventory/verifier/checker 及其测试属于 `qa-control-plane`，最低 L4、完整门禁和人工复核；release workflow 仍为 release L5，普通测试文件仍为 `test-ci-only`。

空 diff 也固定为 `full/L6/highRisk/manualReviewRequired/claimAuthorized=false`，不可借空列表或 docs command 形成授权。

## 完全本地 exact mode

Issue #111 的本地执行使用完整 `--base`、`--head`、`--merge` SHA。`ci-plan.mjs local` 和 `local-verification.mjs` 会检查 Git 对象存在、当前 HEAD 与 candidate head 一致、worktree clean、virtual merge 的 parent 严格为 `[base, head]`，以及声明 tree 与 `git merge-tree --write-tree base head` 一致。所有 changed paths 仍经过本页同一选择器；local mode 不能绕过 protected control-plane、unknown/mixed、Web L4 或 desktop/release Windows L5 floor。

本地 evidence 是独立的 `local_exact_verification` schema，不伪装成 GitHub Actions run/job。它保存完整 provenance、Git 重算 changed paths、canonical plan/gates、命令、退出码、守恒计数、pass/fail/skip/zero-test、环境版本、脱敏日志与 artifact hash，并绑定 candidate fingerprint、generation、CAS pointer 与 payload digest。`validate --evidence` 会重新读取日志、核对 hash、重验 Git provenance、changed-path plan 和 required commands；失败、跳过、零测试、dirty/head drift、缺产物、replay/replacement、旧绿覆盖新失败或敏感/绝对路径泄漏一律 fail-closed。GitHub PR green check 不再替代这套本地证据；Lead 仍必须完成独立 Reviewer、机械合入和后续 integration tip 验证。

如果已有历史 generation 但 current pointer 缺失或损坏，local verification 默认停止；只有明确的人读 legacy recovery 才能加 `--recover-missing-pointer`，并且恢复不会删除历史或把旧失败伪装成 current。lease/guard 创建、release、stale reclaim 和 pointer publish 都必须使用完整 identity 与 generation CAS；测试注入 A-D 只允许在 deterministic unit tests 中启用。

## Skip 语义

- `none`：没有跳过；空 inventory 或没有执行不能冒充通过。
- `capability`：当前环境不具备目标能力，例如 Linux runner 没有 Windows 安装器；只表示限制，不提高 attained level。
- `platform`：当前操作系统或 runner 不支持；只表示限制，不提高 attained level。
- `not_executed`：应执行但没有执行或证据缺失；必须 fail-closed，不能写成 `passed`。

每条新增或修改的验证记录都必须写 `evidence_contract_version=1`、`skip_classification` 和人读 `skips`；`status=none` 必须使用空 kinds，`status=present` 必须使用唯一且不含 `none` 的 kinds；未改变的历史记录可 grandfathered，但“未取得层级”必须与限制保持一致。

## Exact evidence provenance

需要授权当前候选的记录，必须绑定：

- `source_commit`：行为/产品源码来源，不用文档提交冒充；
- `record_commit`：证据记录载体，可使用 `pull_request_<n>_pending`，不能自引用当前记录提交；
- `provenance.mode`：`exact_merge_ref_ci`、`local_run` 或 `not_run`；
- exact CI 记录的 `base_commit`、`head_commit`、`merge_ref`、`parents=[base,head]`、`tree`、`run_id`、`job_id`、`environment` 和 `command`；本地 checker 只绑定声明的 run/job identity 与本地 Git 对象，不能证明 GitHub Actions 的真实存在、SUCCESS、event、head_sha 或 merge checkout，最终授权仍需 PR body/Lead 远端核验；
- exact mode 的四个 commit/tree 字段必须是 40 位 SHA，parents 必须恰好是 `[base_commit, head_commit]`；`run_id`/`job_id` 必须是受控的正整数 GitHub Actions 身份，attained exact evidence 的 `head_commit` 必须等于 `source_commit`；对象可用时还要核对 merge-ref 的真实 parents/tree 及 source/head 对象；
- local run 至少绑定 `head_commit`、`run_id`、`environment`、`command`，parents 必须精确为空数组，并明确 CI 字段为 `not_applicable`；
- 未运行记录的 provenance 全部使用 `not_run` sentinel，不能保留模糊的“稍后补充”。

记录中的 `run_id`、`environment` 和 `command_or_scenario` 必须分别与 provenance 的同名 `run_id`、`environment` 和 `command` 交叉绑定；命令和环境只做首尾裁剪及连续空白归一化，不接受“记录了另一条命令”的旁路证据。

Playwright inventory 必须与实际执行的 project、test id、数量逐项相等；`test.skip`、`test.fixme`、runtime skip、空 project 和 runner error 都会使证据失败。Artifact hash 只证明产物身份/完整性；没有同一精确 hash 的实际安装运行，最多是 L0 完整性，不能是 L5。Synthetic、Mock、contract、replay 和浏览器证据最高 L4；真实租户/provider 的 L6 必须另有实际授权运行。
