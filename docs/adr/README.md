# 架构决策记录

重要技术决定使用独立文件记录。当前记录：

- [0001：选择应用技术栈](0001-choose-application-stack.md)
- [0002：系统主人个人信息流优先](0002-owner-information-first.md)
- [0002：Windows 桌面使用 Electron](0002-use-electron-for-windows-desktop.md)
- [0003：私人计划与任务回收站](0003-private-planning-and-task-trash.md)
- [0004：受控 PM Runtime、需求线程与任务记忆投影](0004-controlled-pm-runtime-thread-memory.md)
- [0005：AI 自动维护私人任务，主人事后监督](0005-ai-auto-task-maintenance.md)（部分取代 0004 的逐条事前审批）
- [0006：分阶段小 Schema 承载连续对话语义判断](0006-staged-semantic-classification.md)
- [0007：M1 单用户试点继续使用 SQLite，并以领域合同约束 draft-only](0007-m1-sqlite-draft-only-and-contracts.md)
- [0008：当前 SQLite 使用版本化迁移与可恢复升级](0008-versioned-sqlite-migrations.md)

其中两个历史 `0002-*.md` 文件分别使用 `ADR-0002-owner-information-first` 与 `ADR-0002-electron`，文件名和旧标题不再作为新编号依据。

每份记录至少说明：问题、备选方案、最终决定、原因、限制和以后什么情况下重新评估。
