# 文档入口

## 唯一当前入口

当前产品入口是 Cindy 插件、`apps/server` 本机服务和 `apps/web` 浏览器任务台。旧桌面壳、安装包和旧分类链仅保留在历史记录中，不属于当前运行路径。

- [当前状态](current-state.md)：唯一“现在是什么”，包含源码基线、阶段、主链、开放问题和验证 ID。
- [项目地图](project-map.md)：按工作区域找到实现、稳定合同、测试位置和文档影响。
- [验证矩阵](verification-matrix.md)：L0–L6、commit、run、环境、result、skips、evidence type 和 artifact hash。
- [运行清单](release-manifest.json)：Cindy 插件、本机 server、web 与 SQLite 的当前运行合同。
- [测试选层与证据门禁](test-selection.md)：changed-path 分类、最低层级、skip 语义和 exact provenance 合同。
- [Agent 测试 SOP](qa/agent-test-sop.md)：协作 Agent 的选层、执行清单和 fail-closed 顺序。
- [完全本地 exact verification](local-verification.md)：本地 runner、证据 schema、验证命令和后续 Actions cutover 边界。
- [DEC-01 决策登记](decision-register.md)：已决定事项、负责人 gate、影响、依赖和不得默认实现的未决事项；事实源为 [decision-register.json](decision-register.json)。
- [PROD-07 日历分类规则](product-rules/PROD-07-calendar-classification.md)：日历事实、待确认候选、责任不明路径、合成夹具和后续实现输入输出；事实源为 [PROD-07-calendar-classification.json](product-rules/PROD-07-calendar-classification.json)。

README、AGENTS 和本页不再复制当前测试数字、安装包 hash 或历史 Issue/PR 流水账。机器入口见 [docs-manifest.json](docs-manifest.json)。

## 按工作类型读取稳定合同

- `implementation_brief.md`：实施项目解决什么问题。
- `architecture.md`：系统组成、数据真源和自动化边界。
- `domain-contracts.md`：Issue #64 统一术语、数据权威、状态机、CAS/恢复、错误目录和 ADR supersession。
- `security_and_privacy.md`：令牌、聊天原文、隐私生命周期、硬删除证明和 GitHub 安全要求。
- `user-guide.md`：Cindy 插件、本机浏览器任务台、人工补录和验收步骤。
- `diagnostics.md`：运行日志与诊断包字段、递归脱敏版本和禁止内容。
- `../CHANGELOG.md`：用户可见历史；逐次验证数字另存 `qa/`。
- `github_collaboration.md`：开发者如何协作。
- `../CONTRIBUTING.md`：RACI、handoff、隔离 worktree、复核/Ready/merge/release 权限和可恢复 SOP。
- `handoff-template.md`：本地交接记录模板；`.handoff/current.md` 及 `*.local.md` 被忽略。
- `stacked-pr.md`：stacked PR 的 base、依赖、合并顺序和 parent 合入后 rebind 合同。
- `open_decisions.md`：编码前仍需确定或验证的事项。
- `decision-register.json`：DEC-01 机器事实源；由 `scripts/decision-register-check.mjs` 校验并生成 Markdown。
- `product-rules/PROD-07-calendar-classification.json`：Issue #85 产品规则事实源；由 `scripts/prod-07-calendar-contract-check.mjs` 校验并生成 Markdown。本 Issue 不修改生产分类行为。
- `adr/`：后续每项重要技术决定的记录位置。
