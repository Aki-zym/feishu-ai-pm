# 完全本地 exact verification

Issue #111 / QA-02 把验证执行放在隔离 Orca worktree 内，不使用 GitHub-hosted 或 self-hosted Actions runner。机器证据格式见 [local-verification-schema.json](local-verification-schema.json)，执行与校验入口是 `scripts/local-verification.mjs`。

## 运行

必须提供完整 40 位 `base`、`head` 和 virtual merge SHA；当前 worktree 必须 clean，且当前 `HEAD` 必须等于 candidate `head`。virtual merge 必须是恰好 `[base, head]` 两个 parent，树必须等于 `git merge-tree --write-tree base head`。

```powershell
node scripts/ci-plan.mjs local --base <base-sha> --head <head-sha> --merge <virtual-merge-sha>
node scripts/local-verification.mjs local --base <base-sha> --head <head-sha> --merge <virtual-merge-sha>
node scripts/local-verification.mjs validate --evidence ci-artifacts/local-verification.json
```

如果已有 `generations/` 历史但 current pointer 缺失或损坏，默认会停止并要求人工确认；只有一次性 recovery 才可显式使用 `--recover-missing-pointer`。恢复只对旧 pointer 做不可变 hard-link/copy snapshot，并写入带 hash/size/metadata 的 recovery manifest；原 source pointer 保持原位，绝不删除、移动或覆盖。恢复会建立确定性的 `recovery-<source-digest>` epoch，新链必须显式用 `--epoch <recovery-...>` 读取或继续运行；CLI 不会静默选择“最新” recovery 文件。

证据会记录 exact provenance、由 Git 重算的完整 changed paths、fail-closed 选层、canonical required gate、命令/退出码/计数、时间、Node/npm/Git/OS、脱敏日志 hash、产物 hash 和 candidate fingerprint。根对象及所有嵌套对象都拒绝未知字段；`requiresTests` 时必须有非零且守恒的计数，成功命令必须 `exitCode=0`、`passed=total`、`failed=skipped=0`。日志只保存脱敏内容；token、原始飞书内容、生产数据、绝对个人路径和 URL userinfo 会被拒绝。失败、跳过、零测试、缺失产物、dirty worktree、head/path/plan/gate drift、树/parent 不匹配和 hash 篡改不能形成授权证据。

docs-only 仍只能运行文档门禁；代码、测试、配置、QA control-plane、mixed 和 unknown 路径仍选择完整门禁。Web 至少 L4；desktop/release 至少 Windows L5。Windows L5 只在真实 Windows 本地环境执行，平台不支持时记录为 skip 并保持 fail-closed，不能升级证据层级。

## 发布与并发安全

每次运行先把不可变 evidence 和脱敏日志写入唯一 `generation/runId` history 目录，再在发布前以 `verifyGit=true`、`requireFiles=true` 重验完整文件、hash、provenance、changed-path plan 和 required gates。失败命令、skip、zero-test、truncated 日志或任一 hash/文件错误只保留 history，绝不推进 current pointer/root。

发布使用 no-replace 的 durable link（临时文件先写完并 `flush/fsync`）和按 generation 不可变的 root slot：`root-slots/<generation>.json` 与选定 epoch 下的 `pointers/epochs/<epoch>/<generation>.json` 都只创建一次，不执行 `rm(destination) → rename` 覆盖。reader 只接受显式 epoch 内完整且互相绑定的 generation，并校验连续 `previousGeneration` CAS 链；未选 epoch 的 legacy/损坏 pointer、partial、candidate replacement/replay 或并发旧 writer 会 fail-closed，旧绿结果不能覆盖新的失败。lease identity 位于 `leases/<generation>-<token>/lease.json`，heartbeat pulse、released/reclaimed tombstone 和 reclaim guard 都在同一 identity 下以完整 JSON、flush/fsync、atomic no-replace 发布；`lease-refs/<generation>.json` 只作为 generation/previousGeneration CAS 引用。release/reclaim 只写旧 identity 的不可变状态，不删除或移动共享 current，也不接触 replacement identity。ownerId/token/runId/generation、pid 和 canonical UTC 时间的 grammar 必须完整匹配；空/半写/unknown/malformed/clock rollback、旧 owner 延迟发布和双 reclaimer 均 fail-closed，恰一 writer 可成功。

QA-02 的 deterministic publication injection 仅由测试启用：A（candidate publish 前中断）、B（reclaim state 前 replacement identity）、C（release compare 前 replacement identity）、D（pointer publish 前 lease state replacement），以及 recovery manifest 完成后的同字节/异 identity replacement、copy fallback 和双 recoverer。受控回归、至少两代失败 history 与最终成功 current 链见 [Issue #111 publication fixture](qa/issue111-publication-review-fixture.json)，可用 `node scripts/local-verification-fixture.mjs` 在干净 worktree 直接重算 hash；它只记录合成 L4 的预期关系，不包含生产日志、secret、绝对路径或正式 Release 证据。

空 diff 不是 docs-only：必须选择 `full`、`L6`、`highRisk=true`、`manualReviewRequired=true`、`claimAuthorized=false`。

## 协作与切换边界

GitHub PR green check 不再是本地 exact evidence；当前 authoritative carrier 是完整本地 evidence + 独立 Reviewer + mechanical Merger。强制顺序是：停云端触发 → 处理 required checks/rulesets → 迁移 PR 携带 local exact evidence → Developer → Reviewer → Merger → Lead ordinary merge → Merger Worker 对新的 integration tip 重新生成并验证 local exact evidence → post-merge evidence 成功后才标记稳定或关闭相关 Issue。Lead 尚未执行 workflow 或 branch-protection cutover；在未来打开迁移 PR 前，必须先完成前两步。此 Issue 的 feature branch push 仅用于保存代码，不创建 PR；当前 `.github/workflows/ci.yml` 的 push 分支只有 `main` 与 `integration/m1-test-20260815`，因此该 feature branch push 不触发 push CI。

本地 synthetic/mock/browser 证据不等于真实 Feishu/LLM/provider、生产数据或正式 Windows Release 证据；这些边界继续由现有 L0–L6、隐私、人工复核和 release authorization 合同约束。
