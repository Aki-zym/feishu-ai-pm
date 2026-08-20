# Agent 测试 SOP

这是一项给协作 Agent 的最小执行顺序。它只适用于 synthetic/test fixtures，不允许读取真实 `%APPDATA%`、生产数据库、真实飞书、LLM 或租户数据。

1. 先 fetch 目标 integration，记录 exact base；再计算完整 base→HEAD changed paths，不只看最近提交。
2. 运行 `node scripts/ci-plan.mjs` 或同一 `selectCiPlan`，确认 category、minimum level、required evidence 和 `manualReviewRequired`。unknown/mixed/high-risk 不能选窄门禁；`docs/verification-matrix.json`、manifest、package、workflow、CI/证据/docs-check validator 改动属于 protected control-plane，始终选择 full + manual review。

2a. 完全本地 exact mode 使用 `node scripts/ci-plan.mjs local --base <40位> --head <40位> --merge <40位>`；再运行 `node scripts/local-verification.mjs local ...`。当前 HEAD 必须是 candidate head，virtual merge 必须有 `[base, head]` parent、精确 tree 和 clean worktree；validator 会自行重算 base→virtual-merge diff、plan 和 canonical required gates。若已有 history 但 pointer 缺失/损坏，必须显式加 `--recover-missing-pointer`；恢复生成的 `recovery-<source-digest>` 必须显式通过 `--epoch <recovery-...>` 继续或验证，不能静默选择最新文件。生成后必须运行 `node scripts/local-verification.mjs validate --evidence ci-artifacts/local-verification.json --epoch <recovery-...>`（无 recovery epoch 时省略 `--epoch`）。每次 run 都要有唯一 generation/runId、lock/lease 和 CAS pointer；GitHub PR green check 不替代本地 evidence。

3. Vitest 默认使用 `npm test` 执行 server/web/desktop 全量 inventory；定向回归只能使用 `npm test -- --workspace <server|web|desktop>` 或同时指定 workspace 内的现有测试文件 `--file <path>`。非法、空或跨 workspace 目标必须失败，不能由脚本静默忽略参数。
3. 先生成/检查文档，再运行与选层匹配的命令。任何应执行但未执行的测试写为 `not_executed`，不能写成通过。
4. Playwright 先生成 inventory，再执行；执行报告必须逐 project、逐 test id 与 inventory 对齐，并为 0 skipped。平台能力缺失只能写 `capability`/`platform` 限制。
5. 记录 source、record、base/head/merge/tree、parents、run/job、OS/Node、command、result、skip 和 artifact hash。不要把 artifact hash 写成安装 Smoke。
6. 任何失败、缺字段、unknown field、provenance/changed-path/plan/required-command 不一致、空 inventory、runner error、产物 hash 不匹配、partial write、旧 generation 覆盖或证据超出环境边界都 fail-closed；空 diff 固定 full/L6/high-risk/manual-review/fail-closed。
7. 最终报告只引用当前 exact head/merge-ref/CI；旧 run、旧 base 和 docs-only freshness 只能作为历史。cutover 必须按“停云端触发→required checks/rulesets→迁移 PR 本地 evidence→Reviewer→Merger→Lead ordinary merge→Merger Worker 验证新 integration tip→post-merge evidence 成功后稳定/关闭 Issue”执行。

## 命令入口

`npm run ci:policy:test` 覆盖 changed-path、provenance、skip 和 no-upload 合同；`npm run docs:generate`、`npm run docs:check`、`npm run docs:test` 保持 JSON/Markdown/manifest 一致；完整产品门禁仍使用 `npm run check`。Windows 安装 Smoke 与 L5/L6 只有在实际环境和精确载体均具备时才可记录。
