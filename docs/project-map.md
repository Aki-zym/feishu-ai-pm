# 项目地图

先读 [当前状态](current-state.md)。本页只说明“去哪里找”；对象级数据权威、状态机和错误合同以 [领域合同](domain-contracts.md) 为准。

| 区域 | 作用 | 主要实现入口 | 稳定合同 | 测试与证据入口 | 变化时复核的文档 |
|---|---|---|---|---|---|
| Windows 桌面壳 | Electron 生命周期、受限 IPC、本机配置与安装 | `apps/desktop/src/`、`apps/desktop/electron-builder.yml` | `docs/architecture.md`、`docs/security_and_privacy.md` | `apps/desktop/src/*.test.ts`、`scripts/desktop-installer-smoke.mjs` | 使用指南、架构、安全、当前状态、验证矩阵 |
| React 界面 | 工作台、候选、任务、日历、设置与日志 | `apps/web/src/` | `docs/implementation_brief.md`、`docs/user-guide.md` | `apps/web/src/*.test.ts`、`tests/e2e/` | 使用指南、QA；用户流程改变时更新当前状态 |
| 服务与领域行为 | API、候选/任务、Runtime、主人判断和审计 | `apps/server/src/app.ts`、`service.ts`、`runtime.ts`、`domain.ts` | `docs/architecture.md`、相关 ADR | `apps/server/tests/` | 架构、安全、实施说明；能力状态改变时更新当前状态 |
| Cindy 入库插件 | 已授权来源先保存、整批 snapshot 分组、跨窗口候选追加、主人决定与本机 Runtime | `plugins/cindy-pm-intake/`、`apps/server/src/cindy-source.ts`、`cindy-batch.ts` | `docs/architecture.md`、`docs/security_and_privacy.md` | `apps/server/tests/cindy-*.test.ts`、插件 main/runtime/worker 测试 | 当前状态、架构、安全、插件 README、验证矩阵 |
| 当前本地数据层 | SQLite schema、迁移与本地事实记录 | `apps/server/src/database.ts` | `docs/architecture.md`、`docs/security_and_privacy.md` | server 数据库/迁移测试 | 架构、安全；未来数据库方向只记录开放决策 |
| 飞书适配 | OAuth、P2P/群、日历、妙记和文档上下文 | `apps/server/src/integrations/feishu*.ts` | `docs/feishu-integration.md`、`docs/security_and_privacy.md` | `apps/server/tests/feishu*.test.ts` | 飞书接入、安全、使用指南、验证矩阵 |
| LLM 分类 | OpenAI-compatible/DeepSeek 分阶段结构与本地校验 | `apps/server/src/integrations/llm.ts` | `docs/implementation_brief.md`、`docs/adr/0006-staged-semantic-classification.md` | `apps/server/tests/llm.test.ts`、回放测试 | 实施说明、架构、安全、验证矩阵 |
| 任务记忆与 reference | SQLite 派生投影、只读工作目录引用 | `apps/server/src/integrations/workspace.ts`、`service.ts` | `docs/architecture.md`、`docs/security_and_privacy.md` | Runtime/thread memory 与 workspace 测试 | 架构、安全、使用指南 |
| 浏览器 E2E 与 QA | 人工构造数据的跨页面路径、选层和历史验收记录 | `tests/e2e/`、`docs/qa/`、`docs/test-selection.md` | `docs/verification-matrix.json`、`scripts/ci-selection-policy.mjs`、`scripts/evidence-record-policy.mjs` | Playwright inventory/verifier、CI selection、提交内 QA 记录 | 验证矩阵；逐次数字只进入 QA 历史 |
| 完全本地 exact verification | 隔离 worktree 内的 Git 重算选层、canonical gates、严格 schema、generation/lock/CAS 发布、脱敏日志和可重验 evidence | `scripts/ci-plan.mjs`、`scripts/local-verification.mjs` | `docs/local-verification-schema.json`、`docs/local-verification.md` | `scripts/ci-plan.test.mjs`、`scripts/local-verification.test.mjs` | 测试选层、验证矩阵、当前状态和 cutover SOP |
| Windows 产物 | EXE、blockmap、latest.yml 与 LFS | `release/`、`package.json` | `AGENTS.md`、Issue #62 | 产物 hash、Windows 隔离安装 Smoke | 当前状态、验证矩阵、使用指南、CHANGELOG |
| 文档治理 | 唯一 current、地图、验证证据和历史 | `docs/current-state.md`、`docs/docs-manifest.json`、`docs/verification-matrix.json` | `AGENTS.md` | `npm run docs:check` | README、AGENTS、docs/README 与受影响的稳定合同 |
| 领域合同 | 术语、事实层权威、状态机、CAS、错误/outcome 与 ADR 关系 | `docs/domain-contracts.json`、`docs/domain-contracts.md` | `scripts/domain-contracts-check.mjs` | 当前状态、架构、安全、开放决策、README |

## 文档影响规则

机器可读规则位于 [docs-manifest.json](docs-manifest.json)：

- 产品源码或运行配置变化，必须同时更新当前状态、机器清单和验证事实源；CI 无条件重算 `product-source-sha256-v1` 指纹，因此即使 merge 后没有 changed-path base，也会拒绝陈旧快照。
- 实现、测试、脚本、依赖或 CI 变化，要复核验证矩阵中的 commit、run、环境、结果和限制是否仍适用。
- 安装包、桌面构建配置或版本变化，要同步当前状态和精确产物证据；构建不等于安装 Smoke。
- README、AGENTS 或 docs 入口变化，必须继续链接唯一 [当前状态](current-state.md)，不能复制测试数字、包 hash 或历史 Issue 流水账。

changed-path 是“哪些事实源必须同步”的机器门禁，但不替代 [Issue #59](https://github.com/Aki-zym/feishu-ai-pm/issues/59) 的测试选层，也不替代 PR 中逐项写明文档“不适用”。commit 只是可选的实现导航参照；跨 rebase、squash 和 merge 的新鲜度以产品源码 fingerprint 为准。

`product-source-sha256-v1` 使用 `apps-workspace-default-include-v1`：`apps/<workspace>/**` 默认纳入，集中排除测试/fixture、README 与纯文档、依赖目录，以及 `dist`、`build`、`coverage`、缓存和其他确定生成目录。因此 `lib/`、`config/`、`resources/`、`assets/`、`app/` 和未来新增生产目录无需另加 allowlist。根目录另纳入锁文件、共享 TypeScript 配置和环境变量示例；根 `package.json` 只投影产品版本、入口、workspace、运行依赖及启动/构建/打包脚本。普通文件使用 Git clean filter 后的 blob ID（因此 LFS 展开与否、文本换行差异不改变身份），根 package 使用稳定 JSON 投影；最后按仓库相对路径排序并汇总为 SHA-256。排除规则集中在 `scripts/docs-check-policy.mjs`，changed-path 直接复用同一 selector，不能通过修改 manifest 缩小范围。

## 明确边界

- 对象级数据权威、状态机、错误目录和 ADR 修复：Issue #64。
- handoff、RACI、CODEOWNERS 和分支治理：Issue #65。
- L0–L6 最低测试选择、skip/provenance 合同与命令透传：Issue #59。
- Windows 重打包、签名、升级回退和 Release：Issue #62。
- 负责人决策登记：Issue #66。
