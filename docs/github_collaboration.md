# GitHub 协作方式

## QA-01 证据门禁

每个 PR 先按完整 base→merge-ref changed paths 运行统一 CI selector；路径未知、混合或高风险时只能扩大门禁，不能缩小。PR body 和验证记录分开写 behavior/source、evidence/record、exact base/head/merge/tree/parents/run/job/environment；`pull_request_<n>_pending` 只表示记录尚待当前 PR freshness，不是 source SHA，也不能自引用。Draft/Open、独立复核、Ready、批准和合并是不同状态，测试通过不改变协作状态。具体选层与 skip/provenance 规则见 [测试选层与证据门禁](test-selection.md) 和 [Agent 测试 SOP](qa/agent-test-sop.md)。

## 仓库设置

- 使用私有 GitHub 仓库。
- 当前开发工作只允许通过 Pull Request、独立复核和负责人最终批准，普通合入目标是 `integration/m1-test-20260815`；`main` 不是本流程的合入目标，服务器是否强制执行必须以平台事实为准。
- 本地 SOP 要求自动检查失败时不得合并，但本文件不把本地约定写成 GitHub 服务器门禁。
- 真实飞书数据、密钥和个人路径不得进入 Issue、PR、日志或截图。

## GitHub 配置状态

以下是最近一次只读平台查询的结构化事实，不是永久合同快照；未来获得权限后可替换为 `verified`，但必须同时记录 branch、ruleset 和 required-review 证据。

```yaml
status: unavailable
checked_at: 2026-08-16T19:22:35+08:00
http_status: 403
reason: GitHub private-repository protection/ruleset API unavailable at the current plan or permission level; recheck through an authorized platform surface before claiming server enforcement.
```

`unavailable` 不等于已配置或未配置；它只表示当前查询不能提供事实。`verified` 也必须由平台返回的具体证据支持，不能仅凭文档文字自称完成。

## 一项工作的流转

```text
Issue：说明要解决的问题和验收结果
  -> Branch：独立修改，不影响正式版本
  -> Pull Request：展示改动和验证结果
  -> Review：另一人检查产品边界、安全和代码
  -> Merge：仅由 Lead/维护者普通合入 integration/m1-test-20260815
```

Issue、branch、worktree、Draft PR、handoff、独立复核、Ready/merge 和 release 的可恢复 SOP 见 [CONTRIBUTING.md](../CONTRIBUTING.md)。当前治理切片的 handoff 字段见 [handoff 模板](handoff-template.md)，stacked PR 的 base、依赖、合并顺序和 parent 合入后 rebind 见 [stacked PR 规则](stacked-pr.md)。

`CODEOWNERS` 只负责把路径路由给审阅人，不能证明独立性；当前只有一个已确认 GitHub owner，实际独立复核仍需由项目 Lead/主人另行指定。

2026-08-16T19:22:35+08:00 的只读 API 查询（两个目标分支 protection 与 repository rulesets）均因私有仓库平台限制返回 HTTP 403 `Upgrade to GitHub Pro or make this repository public to enable this feature.`。因此本页不声称 required review、branch protection 或 rulesets 已被服务器强制；管理员必须在可用的平台权限下重新核验。

## 分支命名

- `feat/<topic>`：新能力。
- `fix/<topic>`：修复问题。
- `docs/<topic>`：文档与产品合同。
- `chore/<topic>`：工程配置。

## PR 必须回答

1. 用户能够看到什么变化？
2. 是否改变自动化与人工确认边界？
3. 是否涉及聊天原文、令牌或权限？
4. 如何验证，失败时如何回退？
5. 是否同步更新文档？

Stacked PR 还必须回答：临时 base 与 exact SHA、依赖 PR/branch、合并顺序、parent 合入后的 integration rebind、fresh exact CI，以及是否明确禁止 rebase/force-push。

## 文档同步合同

每个可验证里程碑都把代码和人读说明视为同一项交付：

1. `README.md`：当前阶段、已实现能力、待真实验收边界和试用入口。
2. `docs/user-guide.md`：安装、首次配置、实际操作步骤、错误处理和安装包校验值。
3. `docs/architecture.md` / ADR：入口、数据主链或关键技术裁决变化。
4. `docs/feishu-integration.md`：身份、权限、可读范围、同步方式和平台限制变化。
5. `docs/security_and_privacy.md`：令牌、原文、日志、留存或外部动作边界变化。

PR 描述必须列出实际改动的文档；确实不受影响的条目写“不适用”。PR 尚未合并时，GitHub 仓库首页仍展示默认分支 `main` 的 README；评审者应在 PR 的 **Files changed** 或 PR 分支查看新文档。

`release/` 是本地构建目录，不进入 Git。安装包只有在显式创建 GitHub Release 并上传附件后，远程用户才能下载。需要试用的里程碑必须在 PR 记录安装包对应 commit、SHA-256、解压版/安装版冒烟结果和 Release 发布状态。

## 非技术项目负责人的参与方式

项目负责人不需要审查每行代码，只需要在 Issue 或 PR 中确认：用户流程、页面结果、错误处理、权限边界和验收场景是否正确。
