# 协作、交接与治理

本文件把 Issue、隔离工作区、Draft PR、独立复核和发布拆成可恢复的步骤。它是仓库内的流程合同，不代表 GitHub 已经启用同等强度的服务器门禁。

## RACI 与权限

| 工作 | 产品主人 | 开发者/Worker | 独立 Reviewer | QA/证据负责人 | 发布负责人 | Merge authority（Lead/维护者） |
|---|---|---|---|---|---|---|
| 确认 Issue 范围、用户结果和未决产品选择 | A/R | C | C | C | I | C |
| 实现与本地回归 | C | R | C | C | I | I |
| 证据层级、changed-path、provenance 和未运行项 | I | C | C | A/R | I | I |
| 独立复核安全、边界和验收 | I | I | A/R | C | I | I |
| 标记 Ready | C | I | C | C | I | A/R |
| 合入 `integration/m1-test-20260815` | C | I | C | C | I | A/R |
| 构建、签名、发布 Release | A（确认可见结果） | I | I | C | A/R | C |

规则：

- 开发者不能自审、Approve、Ready、merge 或 release 自己的改动。
- Reviewer 可以指出问题或要求修改，但不能用自己的复核替代产品主人确认，也不能把测试通过写成 Ready 或已合入。
- 只有产品主人确认用户结果和对外动作边界后，Merge authority 才能标记 Ready 并合入 `integration/m1-test-20260815`；禁止直接推送 `main`。
- Release 必须在 merge 之后单独发生。发布负责人不能用发布动作代替合并审阅。
- 真实对外动作仍需系统主人明确确认；M1 与首轮试点保持 draft-only。
- `CODEOWNERS` 是审阅路由，不等于独立性证明。当前只确认到一个 GitHub owner，因此不能声称已形成两人独立复核。

## 可恢复 SOP

1. **恢复现场**：读取当前 Issue、PR 和 handoff；核对 `git status`、当前分支、工作区列表和 exact base。先保存差异或建立可恢复副本，不覆盖未知脏改动。
2. **主人确认 Issue**：确认目标、非目标、验收、外部动作边界和依赖；没有确认的产品选择保持未决。
3. **隔离工作区**：为一个 Issue 建一个 branch、一个 worktree、一个 Draft PR。记录 branch、base branch/SHA、依赖 PR 和合并顺序。
4. **选择证据层级**：对完整 base→HEAD changed paths 运行 `node scripts/ci-plan.mjs`；unknown、mixed、high-risk 一律扩大门禁并要求人工复核。
5. **实现**：只修改 Issue 范围内的文件。若是 stacked PR，父分支前进时用普通 merge 合入新父分支；不能 rebase 或 force-push（也不得 force-push）。
6. **同步文档影响**：更新 README/current-state、稳定合同、验证事实源或明确写出“不适用”；不要把旧 run、旧 base 或 artifact hash 当作当前授权。
7. **写 handoff**：把 [handoff 模板](docs/handoff-template.md) 复制为被忽略的 `.handoff/current.md`，填写 dirty paths、已读材料、精确证据、证据上限、测试已运行/未运行、依赖和下一步。
8. **创建 Draft PR**：PR 只 `Refs #<issue>`；正文写明 base/head、临时依赖、合并顺序、rebind 规则、测试和未验证项。保持 Draft/Open。
9. **独立复核**：由另一角色检查产品边界、隐私、安全、证据和回退；发现问题先修改，不以作者自检代替复核。
10. **主人合入、另行发布**：产品主人确认结果后，Merge authority 才能 Ready/merge 到 integration；父 PR 合入后，子 PR 必须 rebind 到 integration 并取得新的 exact CI。发布负责人随后单独处理构建、签名和 Release。

## GitHub 配置查询边界

2026-08-16T19:22:35+08:00 通过 `gh api` 只读查询：

- `repos/guanchen-dotcom/feishu-ai-pm/branches/integration%2Fm1-test-20260815/protection`
- `repos/guanchen-dotcom/feishu-ai-pm/branches/main/protection`
- `repos/guanchen-dotcom/feishu-ai-pm/rulesets`

三个接口均返回 HTTP 403：`Upgrade to GitHub Pro or make this repository public to enable this feature.` 因此本 Issue 不声称已验证 branch protection、required review 或 rulesets；仓库管理员仍须在有权限的平台界面/API 中独立确认。文件内流程是人工门禁和审阅约定，不能伪装成服务器强制配置。

## 与产品边界的关系

- 系统只发现、记录和管理任务，不自动执行。
- 任何系统主人以外的人可见的内容都属于对外动作，必须由系统主人确认。
- 来源事实与生成摘要保持分离；文件变化只能说明活动或候选产物，不能证明任务完成。
- 本治理切片不连接真实飞书、LLM、生产数据或 Windows L5/L6；合成/Mock 证据最高按实际运行环境记录。

## 相关入口

- [handoff 模板](docs/handoff-template.md)
- [stacked PR 规则与示例](docs/stacked-pr.md)
- [CODEOWNERS](.github/CODEOWNERS)
- [当前状态](docs/current-state.md)
