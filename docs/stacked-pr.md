# Stacked PR 规则与通用 metadata

Stacked PR 只是一种临时依赖表达方式，不改变“一项工作对应一个 Issue、一个分支和一个 Draft PR”。合同验证结构和类型；当前 Issue、PR、分支、SHA 与平台状态由 PR body 记录，不能写进 checker 的固定常量。

## 必须记录的 metadata

下面的 fenced YAML 是通用结构合同。`issue`、`pr` 和 `dependency.pr` 是正整数且 Issue/PR 编号不同；branch 必须是 `agent/` 分支名；temporary base 必须带当前父分支名和 40 位 SHA；dependency state 必须来自受控枚举；merge order 只表达 PR，必须包含 `dependency.pr` 在前、当前 `pr` 在后，不能用 `issue` 代替子 PR；parent 合入后必须 rebind 到 integration、刷新 exact provenance、等待 pull-request synchronize CI，并禁止 force push。

```yaml
issue: 65
pr: 91
branch: agent/issue-65-gov-01
temporary_base:
  branch: agent/issue-59-qa-01
  sha: 92eccd190753752324ee78bf4a3fd564b36f2519
dependency:
  pr: 90
  state: draft_open
merge_order: [90, 91]
after_parent_merge:
  rebind_base: integration/m1-test-20260815
  refresh_exact_provenance: true
  required_ci: pull_request_synchronize_exact_merge_ref
  force_push: forbidden
```

## 示例快照（仅示例，不代表当前 active 实例）

以下实例是 historical/example，只证明可以表达不同 Issue/PR/父分支组合；它们不替代当前 PR body，也不要求未来 active 状态永远匹配它们。

### Example A：父 PR 尚未合入

```yaml
issue: 65
pr: 91
branch: agent/issue-65-gov-01
temporary_base:
  branch: agent/issue-59-qa-01
  sha: 92eccd190753752324ee78bf4a3fd564b36f2519
dependency:
  pr: 90
  state: draft_open
merge_order: [90, 91]
after_parent_merge:
  rebind_base: integration/m1-test-20260815
  refresh_exact_provenance: true
  required_ci: pull_request_synchronize_exact_merge_ref
  force_push: forbidden
```

### Example B：父 PR 已合入，等待 rebind

```yaml
issue: 72
pr: 104
branch: agent/issue-72-observability
temporary_base:
  branch: agent/issue-71-runtime
  sha: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
dependency:
  pr: 101
  state: merged
merge_order: [101, 104]
after_parent_merge:
  rebind_base: integration/m1-test-20260815
  refresh_exact_provenance: true
  required_ci: pull_request_synchronize_exact_merge_ref
  force_push: forbidden
```

父分支前进时，先 fetch 并核对新的 exact head，再把父分支**普通 merge**到子分支；不 rebase、不 force-push、不修改父 PR。父 PR 合入后，子 PR 必须改回 `integration/<target>`，重新取得 base/head/merge-ref/tree/parents/run/job 和 fresh exact CI。依赖关闭、改变范围或无法合入时暂停子 PR并报告，不伪造独立性。

## PR body 最小示例

```text
Refs #<issue>

Stacked on PR #<dependency-pr> (<dependency-state>).
- temporary base: <parent-branch> @ <exact parent head>
- merge order: PR #<dependency-pr> -> PR #<pr>
- after parent merges: rebind base to integration/m1-test-20260815 and obtain fresh exact merge-ref CI
- no rebase / no force-push / no main
```

Merge 与 release 分离：父子 PR 合入只改变仓库代码；构建、签名、上传和对外发布必须另由发布负责人在主人确认后执行。
