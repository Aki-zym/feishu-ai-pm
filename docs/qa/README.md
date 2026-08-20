# 界面验收

> 2026-08-17 PRIV-001 schema-v6 amendment：保留 v5 migration identity/checksum，新增 durable lifecycle fencing 与 backup cleanup intent。新增回归覆盖双 AppDatabase 进程 interposition、旧 stop actor 不覆盖新 start actor，以及 manifest 删除成功、sqlite 删除失败后的 cleanup recovery；证据只来自 synthetic SQLite/service/virtual adapter。

> 本页是按里程碑追加的历史 QA 记录，不代表当前分支。当前可引用证据只查 [验证矩阵](../verification-matrix.md)，并以验证 ID、commit、run、环境和限制为准。

本目录保存无真实数据的本地空壳截图。Dashboard 对照 `docs/design/dashboard-concept.png`；设置页对照 `docs/design/settings-concept-desktop.png` 和 `docs/design/settings-concept-mobile.png`。

## 2026-08-17 Issue #39 FSH-01：scope 三态与 Token/配置代际

本轮只使用虚拟 token、Mock Feishu client、合成 vault、临时配置目录和本地测试；没有真实飞书租户、OAuth 凭证、生产数据库或原文。

| 检查项 | 结果 |
|---|---|
| Scope 三态 | `feishuScopeUpdateOf` 覆盖 omitted、显式空集合和非空去重替换；非法 scope/envelope fail-closed；refresh 未返回 scope 时保留旧值，明确空 scope 保存为空集合并清空本地门禁 |
| Refresh 并发 | 同一身份的 durable lease 只允许一个 provider 调用；原子 snapshot、generation/CAS、token fingerprint、provider_started recovery_required 与迟到响应 fence 保持一致 |
| 配置代际 | settings/secrets 通过跨进程 lock-directory、generation/CAS 和 journaled writer 串行提交；坏 generation/settings/secrets、坏 LKG 或缺失 lease fail-closed |
| 重新授权 | 只有同一 identity 的新 generation、不同且非空 refresh fingerprint 才能解除 recovery_required；相同/空白 fingerprint、仅 access/scope/expiry/app secret 变化不能重放 provider |
| 证据边界 | 本地 synthetic/Mock L1-L4；真实 OAuth/provider rotation、租户 scope 缩权、生产 vault 和 Windows L5/L6 未运行 |
## 2026-08-16 Issue #34 PRIV-001：隐私生命周期与受管备份

补充回归：privacy suite 当前为 35 tests，新增 active claim 冲突阻断、expiry/reclaim、malformed/clock rollback fail-closed 与 retention/update 零写入断言。

本轮仅使用合成 SQLite、Fastify inject、虚拟时钟/适配器与浏览器 Mock；不连接真实飞书、LLM、provider 或生产数据。PRIV-001 在 DATA-03 v4 之后保留 dedicated schema v5 identity/checksum，并新增连续 schema v6 durable fencing/cleanup intent。

| 检查项 | 结果 |
|---|---|
| migration | `privacy.test.ts` 33 passed：v4→v5→v6 精确升级、partial v5/v6 拒绝、注入失败恢复原字节、重开幂等；双进程 fencing、旧 actor compensation、cleanup intent recovery、恢复登记/留存执行/停采集补偿/孤立备份清理回归通过；`database-migrations.test.ts` 92、`runtime-v3-migration.test.ts` 3 通过 |
| 生命周期 | 停止采集/撤销本地授权/留存状态可见；停止后迟到来源回调 fail-closed 且不写入；撤权不等于硬删除；恢复入口仅登记已验证备份并明确需要重启 |
| 导出/硬删除 | 导出 scope/format/idempotency fence、显式关系/运行时/授权投影、provider/raw/secret/绝对路径排除；二次确认与 CAS 硬删除按固定表清单清理，仅保留无内容 proof/hash/count/time 和必要私有审计 |
| 备份/恢复 | 受管备份身份、manifest、sha256、schema v5/v6/v7/v8、侧车/路径/损坏校验 fail-closed；硬删除暂存受管备份并在事务失败时尝试逐文件恢复；cleanup intent 可在 partial finalize 后枚举/验证/恢复；在线恢复返回 `requiresRestart`，真实替换需服务退出维护入口 |
| 证据边界 | 仅 synthetic L2-L4；真实 Feishu OAuth 撤权、第三方平台备份残留、Windows 文件锁/安装升级、法律合规和 L5/L6 未验证；当前 PR exact head/merge/run 由 PR #98 body 绑定 |

当前组合产品快照为 `1b5fd6ae58701b699b2afa7dc6259ae54247289725011f91cc4ff83f6dc4e1a4`（81 个文件）；更早段落中的 DATA-03 fingerprint 仅是历史 source evidence。

## 2026-08-16 Issue #85 / PROD-07：日历事实与候选规则评估

本轮只使用 `docs/product-rules/PROD-07-calendar-classification.json` 中的脱敏合成夹具和结构化合同 checker，不连接真实飞书、LLM 或生产数据，不修改 `apps/**` 分类实现。规则要求普通提醒、仅出席、全天/重复、节假日、生日和订阅日历保留 Calendar 事实；明确主人责任+动作+交付物/截止点才进入待确认候选；责任不明只进入主人确认提示；会议 action item 优先来自纪要/明确消息。

量化目标：事实保留率 100%；事实型事件误报候选噪声率 0%；明确交付候选召回率 100%；责任不明批量候选数量 0；候选解释覆盖率 100%；重复系列候选倍增不超过 1。桌面与窄屏 route/解释一致只是后续实现验收目标，本 Issue 尚未实现或验证 UI 分类行为。该记录的 PROD-07 证据上限严格为 L0：整仓 CI/Playwright 只能说明回归未破坏，不能升级为规则已在 UI 或生产分类中运行；不代表生产行为已上线或真实日历租户已验收；证据 ID：`VER-ISSUE85-PROD07-L0-20260816`。
## 2026-08-16 Issue #37 DATA-03：候选版本 CAS 与刷新代际

本轮仅使用当前 integration `integration/m1-test-20260815` @ `79f97d9505364fc5acbb9816fc77490e0b2e0211` 之上的合成 SQLite、Fastify inject、虚拟适配器与浏览器 Mock；不连接真实飞书、LLM、provider 或生产数据。DATA-03 行为提交为 `7cbb899017bcb5d577f3648442719ff4fa2d1efc`，其 5603404 基线仅作历史 source evidence；当前产品 fingerprint 为 `1b5fd6ae58701b699b2afa7dc6259ae54247289725011f91cc4ff83f6dc4e1a4`，纳入 `81` 个文件。

| 检查项 | 结果 |
|---|---|
| schema/CAS | DATA-03 dedicated v4 为 `candidate_request.version` 提供默认 `1` 与存量精确回填；缺失/非法 expectedVersion 返回 400，过期版本返回 409 和安全 current DTO；candidate/thread/task/group 冲突以及审计/通知失败均逐值回滚，不自动 winner 或重放 mutation |
| 线程归并 CAS | `setCandidateMergePrimary`、`splitCandidateMerge` 强制 `expectedThreadVersion`；confirm merge 对 current/target thread 使用快照/版本 fence；旧线程版本、target drift、缺失线程版本均有 409/400 回归 |
| UI mutation/refresh | CandidatesPage 复用 `resource-state.ts` 的每资源 generation/operation id；mutation 成功先落 canonical DTO，再 refresh。refresh 失败固定显示“写入已成功，但列表未刷新”，旧卡禁用且只允许 refresh retry，不重放 mutation |
| 定向服务/迁移 | `data-03-candidate-version.test.ts`：4 passed；`data-03-candidate-cas.test.ts`：15 passed；`runtime-v3-migration.test.ts`、`data-02-relations.test.ts`、`database-migrations.test.ts`：104 passed；`multi-demand-units.test.ts`：19 passed；`runtime-thread-memory.test.ts`：99 passed |
| 完整本地 suites | server：612 passed；web：26 passed；desktop：134 passed；server/web/desktop typecheck 通过；`npm run check` 通过；lifecycle：5/5；Playwright inventory：86（桌面 44、移动 42），E2E：86/86，verify：86/86 |
 | 证据边界 | 当前仍为 Draft 候选；exact head/merge-ref/parents/tree/run/job 待推送后由 PR #100 body 绑定。浏览器最多 L4，不证明 Windows/Electron L5 或真实租户/provider L6 |

## 2026-08-16 Issue #51：异步读取状态与连接健康

本轮使用本地规则/Mock、内存 SQLite 和合成浏览器响应，不连接真实飞书、真实 LLM 或生产数据。Browser 插件不可用，因此使用仓库 Playwright；桌面 Chromium 与 Pixel 7 各执行一遍。所有测试由 `tests/e2e/fixtures.ts` 统一捕获 `pageerror`，本轮无 pageerror。

本轮 behavior/source commit：`18ea5ea606cc5bc31e31ae68d6aa52b3f5a37fc8`；PR #83 合入时 integration tip 为 `integration/m1-test-20260815` @ `ad75b68687356a4782779b34ec35c60db68e05ea`，当前 integration tip 为 `9dfdfc65e0331cc4eabfe2510fc6e2974493576b`。本节旧 merge commit、旧 fingerprint 与旧 CI 仅作历史；当前组合候选产品 fingerprint 以 [当前状态](../current-state.md) 与验证矩阵为准。

| 检查项 | 结果 |
|---|---|
| 共享资源状态合同 | `idle/loading/success-empty/success-data/error/stale`；首次失败不进入空状态，刷新失败保留上次成功数据并标记“数据可能已过期”；统一 resource-level latest-operation fence 只允许最新读取或 mutation 提交 |
| 工作台 | Dashboard 与提醒分区独立读取；工作台失败可重试，提醒失败不阻塞已读工作台数据 |
| 候选、任务、排期、归档 | 首次加载、失败、成功为空和陈旧刷新均有不同文案；失败不渲染条件空状态 |
| 设置分区 | 配置、主人信息、自动维护、连接健康和系统就绪状态使用独立请求与明确错误提示；Settings 以 ResourceState 数据为唯一读取事实源；主人刷新、来源同步、监听动作、自动维护模式和监控范围保存不会被旧读取覆盖；健康安全 DTO 不暴露 `details_json`，重试不会改变任何对外动作权限 |
| 响应式 | 桌面宽屏与 Pixel 7 无横向溢出；状态条和重试按钮在窄屏纵向排列 |
| 定向 E2E | `npx playwright test tests/e2e/app.spec.ts --grep "Issue #51"`：20 passed（桌面 10、Pixel 7 10），0 skipped；覆盖失败不为空、设置分区失败、陈旧保留、重试、旧读取迟到不覆盖 mutation 结果与最新请求胜出 |
| 完整回归 | `npm run check`：docs/domain 21 passed、1 个 Windows 符号链接平台跳过；CI policy 31、matcher 10、server 532、web 23、desktop 128；typecheck/build/desktop artifact/provenance verify 通过；`npm run test:e2e:lifecycle`：5/5；完整 Playwright：82 passed、0 skipped（desktop 42、Pixel 7 40，备用端口 `4510/4512`） |
| 文档与门禁 | 历史记录：`npm run docs:generate -- --base e4c2b1335664429e354015b2131427dc277f0c7b`、`npm run docs:check`、docs test、changed-path gate、`git diff --check`、`npm run test:e2e:inventory` 和 `npm run test:e2e:verify` 通过；当前 PR #82 候选以 `9dfdfc65e0331cc4eabfe2510fc6e2974493576b` 重新绑定 |
| 定向前端检查 | `npm run typecheck -w @ai-pm/web` 通过；`npm run test -w @ai-pm/web`：23 passed；`git diff --check` 通过 |

真实租户/provider 健康、Electron/NSIS 安装包和 L5/L6 验收不在本轮范围内。
## 2026-08-16 Issue #55 OUT-01：M1 draft-only approval/outbox

本轮只使用合成 SQLite、Fastify inject、虚拟适配器和本地浏览器代码；不连接真实飞书、LLM、provider 或生产数据。M1 永久 draft-only：只能生成、审阅、修改或废止本地草稿，不能发送或自动执行。

| 检查项 | 结果 |
|---|---|
| 生成幂等 | 相同 task version + action type + canonical payload hash 重复请求复用同一 approval/outbox；新 payload 或版本会终止旧 awaiting 草稿再创建新草稿 |
| 失效闭环 | 删除任务、候选撤销/任务无效化在同一 SQLite transaction 内终止关联 approval/outbox；来源、task_event、correction_event 和其他审计保留；恢复不重开旧草稿 |
| DTO/API | approval/outbox 只返回固定 allowlist 元数据、draft/rejected/obsolete 状态和 `externally_sent=false`，不返回 payload/provider/raw；没有 send mutation 或 consumer |
| UI | 任务详情显示“对外草稿”“待主人审阅”“已拒绝”“已失效”，文案明确未发送，不提供发送按钮 |
| 证据边界 | `VER-ISSUE55-DRAFT-ONLY-L4-20260816`；synthetic L4 only，不代表真实 provider、生产数据、Windows L5 或租户 L6 |

## 2026-08-16 Issue #42 RUN-01：Runtime 恢复与关闭边界

本轮只使用本地 SQLite、合成 Runtime 工作项、可控时钟和故障注入；没有连接真实飞书、LLM provider 或生产数据。定向合同测试覆盖 timeout→AbortSignal、checkpoint 原子落库、租约过期旧 worker 拒绝、停止后 mutation 零写入、精确 job+lease fence、shutdown 审计终结，以及历史 `external.send` claim/幂等结构在 M1 `forbidden` policy 下不建 claim、不调用 provider 的回归；生产级 PmService 回归覆盖上下文/provider/reprocess checkpoint 复用、revision/source-set 不匹配重跑和旧 owner reclaim 隔离。

| 检查项 | 结果 |
|---|---|
| 定向合同 | `runtime-run01.test.ts`：18 passed；`runtime-v3-migration.test.ts`：3 passed |
| 服务与迁移回归 | server：593 passed；SQLite migrations：92 passed；runtime-thread-memory：99 passed；DATA-02 relations：9 passed |
| 完整门禁 | `npm run check`：docs 21 passed / 1 platform skip、CI policy 31、matcher 10、server 593、web 23、desktop 133；typecheck/build/desktop artifact/provenance verify 通过；`npm run test:e2e:lifecycle`：5/5 |
| Playwright | inventory 84（desktop 43、mobile 41）；带 `E2E_EVIDENCE=1` 的完整 Playwright 84 passed / 0 skipped；execution verifier 84/84 |
| 文档与差异 | `npm run docs:generate`、`npm run docs:check`、`npm run docs:test` 与 `git diff --check` 通过 |
| 阶段恢复 | provider 完成 checkpoint 与 SQLite 工具审计同一事务；结构失败/临时降级不复用 provisional checkpoint |
| 超时与取消 | Runtime 超时或关闭先 abort 底层可取消调用；在途 Promise 不在当前进程内重试 |
| 租约与 generation | 旧 lease、取消和已停止 generation 不能 checkpoint、完成或写入关闭后的数据库；job 关联工具缺少 exact lease 会在审计前拒绝，缺失进程内 fence 的旧审计不能写 completed/failed；shutdown 只释放精确 job+lease 对 |
| 冻结 schema | 未记账的 `runtime_tool_call.idempotency_key` partial v0 在 backup/mutation 前拒绝，原库 bytes/rows/schema 保持不变 |
| 对外动作 | M1 `external.send` 固定 `forbidden`：即使 approved=true 或有幂等键也在 callback/provider 前拒绝，callback 计数为 0；历史 ready/sent/approved 只作兼容展示，不能恢复执行 |
| 真实环境限制 | L2/L3 合成验证；不证明真实 provider、真实租户或 Windows L5 行为 |

## 对照项目

| 检查项 | 设计基准 | 当前实现 |
|---|---|---|
| 信息结构 | 左侧导航、中间列表、右侧详情 | 保持一致 |
| 候选与任务 | 候选单独收件，接受后进入正式任务 | 保持一致 |
| 候选详情 | 时间范围、背景、希望验证、Describe、为什么被识别；只展示 AI 摘要和证据标签，不直接展示聊天正文 | 保持一致 |
| 色彩与容器 | 真白主背景、浅蓝灰导航、克制蓝色、列表为主 | 保持一致 |
| 对外动作 | 明确“待主人审阅（草稿）”，不自动发送 | 保持一致 |
| 响应式 | 桌面详情抽屉、手机完整宽度 | 已验证 |

## 2026-08-12 设置、候选收件箱与任务生命周期验收

Browser 插件在当前会话不可用，因此按前端调试约定使用仓库 Playwright 流程，并用桌面桥接 Mock 截取真实 EXE 形态；临时截图不提交到仓库。

| 检查项 | 结果 |
|---|---|
| 设置页桌面形态 | 连接总览、五来源列表、飞书/模型主面板和折叠设置均可见；无相关控制台错误 |
| 设置页手机形态 | 来源与按钮可操作，无横向溢出；配置表单保持可编辑 |
| Scope 权限指南 | 图文步骤、批量权限 JSON、复制和自动填入可用；JSON 与 OAuth scope 用途明确区分 |
| 候选五项解释 | 时间范围和四项解释固定可见；unknown 显示“未推断出”，AI 原因不冒充来源事实 |
| 候选回收站 | 活动候选可移入回收站；回收站可查看并恢复；来源和正式任务关联保留 |
| 候选按钮布局 | 桌面底部横向换行；Pixel 7 两列按钮不重叠，忽略候选恢复入口在内容流下方 |
| scope 缺失门禁 | 缺少用户 OAuth scope 时不请求飞书消息 API、不推进游标，并显示需要管理员批准 |
| 证据标签 | 只有能回查到实际消息或可读文档片段的文本才保留 fact/document；模型幻觉降为 inferred |
| 文档背景 | Docx、Wiki→Docx、无权限、不支持、失效、stale、版本变化、历史来源回填与旧结果防覆盖均有自动测试 |
| 时间推断 | 相对截止日期不虚构开始时间；非法日期回退未知 |
| 模型输入边界 | 最多 8 篇文档、单篇 8,000 字、正文合计 12,000 字、最终输入 20,000 字 |
| 首次配置 | `deepseek` Provider 保存后不再被改写为 `openai_compatible` |
| 私人计划 | 开始/完成可保存、列表与日历同步、可清除 |
| 删除与恢复 | 删除进入回收站，来源保留；恢复后重新进入正式台账 |
| 对外动作边界 | 整个任务生命周期不新增 approval，不触发 external-actions |
| 手机任务详情 | 已修复底部操作栏遮挡“纠错”标签的问题 |
| 自动门禁 | `npm run check`：server 161、web 3、desktop 7；`npm run test:e2e`：25 passed、7 skipped。候选回收站 E2E 已覆盖桌面流程与 Pixel 7 布局，移动端写库流程按设计跳过 |
| 安全门禁 | `npm audit --audit-level=high`：0 vulnerabilities；变更文件敏感信息与个人绝对路径扫描均为 0 |
| Windows 安装包 | Issue #7 / Draft PR #8 当前应用源码构建；SHA-256 `CE80FE7CD175DA35DCDFB13BEACDC666C6171C34D71697B4A7594974DA52C4DC` |
| 隔离安装 Smoke | 安装、启动和桌面桥接通过；现有快捷方式未变化；测试版已执行卸载 |
| 签名与发布 | Authenticode `NotSigned`，仅供内部验证；尚未上传 GitHub Release |

实现没有复制设计图里的假日期，也没有使用“企业微信”等错误来源文字；页面统一使用当前日期和虚拟来源类型。

设置页本轮视觉验收目标为 1440×900、1100×720、Pixel 7 和 320×568；默认折叠态与权限指南展开态都必须无裁切、无横向溢出。Browser 插件不可用时使用仓库 Playwright，并对照概念图与最新截图执行 `view_image` 复核。

## 2026-08-12 Issue #11：AI 自动维护与任务记忆管理

Browser 插件在当前会话不可用，因此使用仓库 Playwright。定向流程同时覆盖 1440×900 桌面 Chromium 与 Pixel 7；完整门禁和安装包事实在本节最终收口时填写。

| 检查项 | 结果 |
|---|---|
| 自动修改审计 | 显示字段前后值、来源、DeepSeek 模型、关联/更新双重置信度、策略原因和版本 |
| 撤销与冲突 | 最新 AI 修改可撤销并保留原审计；后续版本覆盖时服务端拒绝撤销 |
| 完整编辑 | 标题、Describe、下一步、风险、等待原因、状态和私人计划可统一保存并递增版本 |
| 自动化控制 | 全局可在“AI 自动维护 / 仅建议”切换；单任务可暂停/恢复，来源继续保存 |
| 通知互斥 | 自动应用后只有自动修改提醒；待确认时只有确认提醒；工作台点击后标已读并打开正确任务 |
| 连续消息边界 | 同一会话同一次完整分页扫描批量判断；分页失败只保存来源、不分类、不推进游标；跨轮询/WebSocket 延迟聚合明确未实现 |
| 任务记忆 | SQLite 是唯一真源；可清理系统托管的旧投影并重建，未知文件保留，投影失败不回滚正式任务 |
| 参考路径 | 可解除绑定和引用快照；真实工作目录不删除、不移动、不修改 |
| 外部动作边界 | 自动维护不新增 Outbox，不发送消息，不执行任务或任意 SQL/Shell |
| 桌面布局 | 任务抽屉整体自然滚动；“持续更新”标签和摘要内按钮均可点击，不被固定区域遮挡 |
| 手机布局 | Pixel 7 无横向溢出或按钮重叠，完整流程通过 |
| 定向 E2E | `npx playwright test tests/e2e/app.spec.ts -g "Issue #11"`：4 passed，覆盖桌面 Chromium 与 Pixel 7 |
| 完整门禁 | `npm run check`：server 208、web 3、desktop 7；`npm run test:e2e`：29 passed、7 skipped；`npm audit --audit-level=high`：0 vulnerabilities；`git diff --check`、敏感信息与个人绝对路径扫描通过 |
| Windows 安装包 | `release/Feishu-AI-PM-0.2.0-x64-Setup.exe`，101,691,706 字节，SHA-256 `DD609BC1782D19539E6BA00645CF2B6522CBCDBB28FA6D424074CA636F1B3EC8`；Authenticode `NotSigned`，尚未上传 GitHub Release |
| Issue #11 隔离安装 Smoke | 独立应用名、App ID 和数据目录；安装/应用退出码均为 0，桌面桥接通过，现有快捷方式未变化，隔离测试版已卸载 |

## 2026-08-13 Issue #13：候选归并与主人主体识别

Browser 插件在当前会话不可用，因此按前端调试规范使用仓库 Playwright。定向流程同时覆盖 1440×900 桌面 Chromium 与 Pixel 7。

| 检查项 | 结果 |
|---|---|
| 真实案例 | “924 版本看板与埋点需求流程咨询”作为流程背景，“众筹箱功能提交次数分析”作为主人需要推进的主体，高置信归并为一张卡 |
| 独立交付 | 同一私聊、时间接近但交付目标不同的两条消息不会自动归并 |
| 低置信建议 | 保留两张候选，显示目标标题和主体选择；确认前禁止接受，可确认合并或明确保留为两件事 |
| 人工纠正 | 接受前可更换主体、拆分来源；确认、否决、换主体和拆分均写入私人纠错审计 |
| 整组处理 | 接受只建立一个任务并关联全部来源；暂存、忽略、回收站和恢复均作用于整组 |
| 模型最小化 | 只发送匿名 `c1/c2` 和受限摘要；真实候选/线程/快照 ID、路径和凭证不进入模型输入 |
| 非法模型输出 | 未知、重复、漏评或主体字段不完整时整次分类安全降级，不产生归并结果 |
| 旧库迁移 | 旧 `candidate_request` 自动增加 `merged_into_candidate_id / merged_at`，旧数据保持不变 |
| 外部动作边界 | 归并、换主体和拆分只修改私人 SQLite 关联，不新增 Outbox；不以归并摘要替换 `source_event` 当前授权来源状态（该行仍可因来源编辑/撤回而更新） |
| 定向服务端 | `llm.test.ts + runtime-thread-memory.test.ts + app.test.ts`：107 passed |
| 定向 E2E | `npx playwright test tests/e2e/app.spec.ts -g "Issue #13|候选操作按钮"`：6 passed，桌面与 Pixel 7 均无横向溢出 |
| 完整门禁 | `npm run check`：server 218、web 3、desktop 7；`npm run test:e2e`：33 passed、7 skipped；`npm audit --audit-level=high`：0 vulnerabilities；`git diff --check` 通过 |
| 过期建议 | 候选、线程、组成员或页面版本变化后，旧确认返回 409，归并与审计均零写入 |
| 明确否决 | “保留为两件事”写入持久排除；来源更新并重新判断后，同一候选对仍不进入建议或自动归并 |
| 连续消息拆分 | 一个候选代表多条连续原消息时，拆分会整批迁移来源、参与人和最后活动时间，并将旧线程修订置为 stale |
| Windows 安装包 | `release/Feishu-AI-PM-0.2.0-x64-Setup.exe`，101,716,460 字节，SHA-256 `89DF84BBD949982D7FD4F0D238B828D6EB3FAEE69830750D737333829EB7334B`；Authenticode `NotSigned`，尚未上传 GitHub Release |
| Issue #13 隔离安装 Smoke | 独立应用名、App ID 和数据目录；安装/应用退出码均为 0，桌面桥接通过，现有快捷方式未变化，隔离测试版已卸载 |

## 2026-08-13 Issue #15：结构恢复、背景补扫与多需求单元

本节记录验收合同；最终完整测试数字和安装包事实只在本分支门禁完成后填写。

| 检查项 | 结果 |
|---|---|
| 结构失败恢复 | 无效 JSON、缺字段和非法多需求结构有限修复/重试；最终失败进入 Runtime 退避，不固化为“不是需求” |
| 漏单补扫 | 仅在已启用会话内向前回看最多 72 小时、3 页，遵守人员硬起点，不推进正常同步游标 |
| 主人消息边界 | 主人发言只保存为 `contextOnly` 背景，不单独形成候选 |
| 多需求拆分 | 同一分类批次最多拆成 8 个需求单元；同一原始消息可支撑多个单元 |
| 四层 ID | `source_event_id → demand_unit_id → requirement_thread_id → task_id` 职责独立，可从 Runtime checkpoint 恢复 |
| Revision fence | 模型判断期间来源变化时本轮零写入并自动重跑；旧多单元结果不被无 `units` 降级输出覆盖 |
| 淘汰与历史 | 新结果移除旧单元时，未接受候选退出活动收件箱；已接受任务与来源审计继续保留 |
| 单元隔离 | 归并、拆分、改挂和纠错只移动目标单元；共享来源仍被其他单元使用时继续保留 |
| 候选 UI | 每张卡只代表模型成功整理出的具体需求；结构失败不生成 0% 占位卡，旧占位自动隐藏；窄屏不得横向溢出或挤压操作按钮 |
| 服务端定向测试 | `multi-demand-units.test.ts`：14 passed；`npm run check` 服务端 328 passed |
| 完整门禁 | `npm run check`：server 328、web 3、desktop 7；`npm run test:e2e`：35 passed、7 skipped；`git diff --check` 通过 |
| 真实租户边界 | 代码与 Mock/契约测试不代表真实飞书历史范围、限流和 3 页补扫已经验收 |

本轮候选和任务页面的隐私验收补充：

- 来源展开区显示来源摘要、来源类型、需求角色和 AI 归类依据，不渲染聊天正文；正文只在本地来源审计中保留。
- 模型结构化输出失败时，只保留来源、脱敏校验路径和 Runtime 状态，不创建候选任务卡；不得把规则 fallback 复制的原文写入 `title`、`background`、`describe` 或来源摘要。
- 连续消息应回到同一 `requirement_thread` / `demand_unit`，而不是按每条消息增加候选卡；只有 `new_demand` 才能新建候选。

## 2026-08-14 Issue #23：需求线程中心化与分阶段语义更新

本轮验证重点是“完整对话回放”，不是单条关键词断言。测试适配器使用 `kind: live` 的结构化模型形态，但不连接真实 LLM；服务端仍实际执行候选快照、完整评分、hash、版本和自动策略门禁。

| 场景 | 验收结果 |
|---|---|
| 无回复链的唯一线程承接 | 后续短句进入原任务，不增加候选 |
| 同一私聊两个需求交错 | A/B 分别更新，不能串线 |
| 待接受候选收到补充 | 原候选增加来源并更新候选修订，不生成第二张卡 |
| 两个候选分数接近 | 任务零写入，建立 `needs_confirmation` 和可见提醒 |
| 明确“另一个新需求” | 保持拆分，创建第二张候选 |
| 跨 30 天明确引用旧任务 | 通过稳定标题和候选快照恢复原线程 |
| 跨 30 天无明确引用 | 不自动归属，来源进入待确认 |
| “3-4 个版本” | 只更新推进状态，不伪造具体日历日期 |
| 重复投递同一来源 | 不重复任务版本、提案或来源关系 |
| 低置信语义动作 | 转为待确认，不自动完成或修改任务 |

定向服务端结果：`runtime-thread-memory.test.ts` 87 passed（其中含上述 10 个回放）。最终完整门禁：`npm run check` 的 server 328、web 3、desktop 7 全部通过；`npm run test:e2e` 为 35 passed、7 skipped；`npm audit --audit-level=high` 为 0 vulnerabilities。真实飞书租户和真实 LLM 凭证未在本轮使用，不能据此声称真实连接验收完成。

## 2026-08-14 PR #24：真实结构失败与手动同步修复

| 检查项 | 结果 |
|---|---|
| DeepSeek 结构兼容 | 提示词升级为 `demand_intake_v7`；消息动作、需求摘要、正式任务关联、候选归并、任务补丁和主人意图分别使用小 Schema |
| 阶段失败隔离 | 非法 JSON 与字段类型错误都携带阶段名和固定示例修复；次要阶段连续失败只返回安全的未选择/无补丁，核心需求不消失 |
| 主人与日期安全 | 模型只收到服务端验证后的脱敏 `current_sender_role`；时间文字无法在当前来源回查时不解析、不进入重要日期 |
| 来源引用 | 单需求和多需求都校验匿名来源编号；未知或重复编号不能建候选 |
| 失败候选边界 | 模型结构失败只保留来源、脱敏校验路径和 Runtime 工作项，不创建 `0%` 候选；旧占位列表隐藏 |
| 真实五轮对话 | 使用实际 `OpenAICompatibleClassifier` 和 DeepSeek 兼容 HTTP 回放；“提出需求 → 主人问背景 → 两次补充 → 主人确认下周一”最终只生成 1 个任务，状态为进行中并写入 2026-08-17 截止时间，规则降级为 0 |
| 手动同步 | 后台轮次运行时，手动入口等待结束后真实补跑；页面不再误报配置问题 |
| 私聊关注范围 | 新发现人员默认不关注；“关注所有人”立即启用当前已发现人员，未保存的群聊选择继续保留，以后新发现人员仍默认关闭 |
| 本轮定向验证 | server/web 类型检查通过；飞书范围、后台同步与 API 定向测试 61 passed；设置页桌面与 Pixel 7 回归 2 passed |
| 完整门禁 | `npm run check`：server 342、web 3、desktop 7；`npm run test:e2e`：37 passed、7 skipped；`npm audit --audit-level=high`：0 vulnerabilities |
| 安装 Smoke | 隔离应用安装退出码 0、应用退出码 0、现有快捷方式未变化 |
| 正式安装包 | 101,814,729 字节；SHA-256 `1A2141E124685213DBDD940E525C33CBF693EE8FDDDF460347C4AD374E654950`；Authenticode `NotSigned`；通过 Git LFS 纳入仓库，本轮未重新执行隔离安装冒烟 |

## 2026-08-14 Issue #52：任务详情身份竞态

本轮只使用浏览器开发载体和虚拟 API 响应，不连接真实飞书、真实 LLM 或生产数据。

| 检查项 | 结果 |
|---|---|
| A → B 切换 | B 路由生效后立即隐藏 A 详情、编辑表单和危险操作 |
| A 迟到响应 | A 的延迟响应由路由 ID + generation 丢弃，不能覆盖已显示的 B |
| B 加载失败 | 只显示 B 的加载错误，不恢复 A，也不开放编辑、删除或对外草稿入口 |
| 前进 / 后退 | 回到 A、再前进到 B 时各自重新加载；内部 mutation 只发往当前 B |
| 定向类型检查 | 根工作区 server、web、desktop 类型检查通过 |
| 定向 E2E | desktop Chromium 与 Pixel 7 共 4 passed；使用虚拟慢响应、503 和 history 导航 |
| 未验证 | 真实 Electron 壳层的前进 / 后退与实际 IPC 时序；本轮浏览器结果不能替代该验收 |

## 2026-08-16 Issue #33：SEC-02 Prompt Injection 边界（Draft 候选）

本切片只使用本地 Mock/自定义 classifier、合成 message/calendar/minutes/Docx-Wiki normalized source 和内存 SQLite；没有真实飞书、LLM provider、租户、生产数据库或外部发送。服务端在 adapter 返回后重新执行严格 schema、主人身份、匿名来源/候选集、CAS/approval、置信度和文本 ID guard；未知字段、越界置信度、真实 ID grammar、伪造 owner/tool 请求和跨来源 source key 不会进入业务写入路径。

| 检查项 | 结果 |
|---|---|
| 定向服务端合同 | `llm.test.ts` 与 `sec-02-prompt-injection.test.ts`：当前工作树通过；覆盖递归未知键、owner impersonation、凭证/Feishu ID/裸 UUID/长 hex/受控 prefix+canonical UUID 清洗、普通连字符业务文本保留、越界置信度、reprocess 同一 guard、候选集/主人身份/approval/outbox 边界，以及 Runtime result/checkpoint 只保存安全 projection、初始/多单元/reprocess/HTTP sender name 脱敏、Feishu/UUID/credential/path/URL/email 在 maxChars 截断边界前完整识别、直接命中 bounded Unicode property tail guard 和有界超长 custom-adapter 输入（本地 server inventory 615 tests；完整门禁以最新 PR body 为准） |
| 当前基线 | `integration/m1-test-20260815` @ `5603404d98621a9d30a99ddc0def2283678d1341`；PR #88 保持 Draft/Open，exact head/merge-ref/run/job 以后续 PR body 为准 |
| 证据上限 | synthetic L1-L4；不声称真实 provider、真实租户、生产数据、Windows L5 或 L6 |

## 2026-08-16 Issue #31：正式模拟消息路由隔离与 fail-closed 测试入口

本轮只使用本地合成数据、Fastify inject、内存 SQLite 和生产构建产物扫描；没有连接真实飞书、真实 LLM、生产数据库或真实聊天原文。

| 检查项 | 结果 |
|---|---|
| 现状核对 | Draft PR #71 的 behavior exact base 为 `41604640804c19e4d50a0027d85eb0eaf12d73e8`、behavior head 为 `2b7f72ab8cca71bd0a26e4688d660fd9da585b82`；behavior/source 为 `a337d8d122c3fd1b8994ba491d85c98ffe226e59`，exact merge 为 `a577b431017ca5a787906efa087f258cd82837bc`（parents 为该 base/head），GitHub Actions run/job `31922195012/95103779717` 已成功。base 已有正式 `buildApp`/Electron 路由 404；PR 新增的 test helper 守卫仍待合入 integration |
| 本地辅助证据 | `local-issue31-route-20260816-01`：Windows local worktree 的定向与完整检查；仅作辅助，不冒充 PR 最终授权 |
| 正式装配 | `buildApp` 默认对 `POST /api/dev/simulate-message` 返回 404，来源事实和候选均保持 0；正式人工补录 `/api/corrections` 仍可用 |
| 测试入口（PR #71 候选） | 只有调用方显式传入 `testOnly: true`，并同时提供 `nodeEnv=test`、`databaseProvider=sqlite`、`databaseUrl=:memory:` 才注册；非测试装配会抛错且不注册路由；该 helper 守卫尚未合入 integration |
| 定向服务端 | `npm run test -w @ai-pm/server -- tests/app.test.ts tests/mature.test.ts tests/owner-information.test.ts`：48 passed、0 skipped |
| 类型与构建 | server typecheck、server build 通过；`apps/server/dist`、`apps/web/dist` 和 `apps/desktop/dist` 扫描不到 `simulate-message`、`simulated-message-route` 或“虚拟消息”字符串 |
| 完整代码门禁 | `npm run check`：docs 21 passed / 1 platform symlink skip、CI policy 31、matcher 10、server 523、web 20、desktop 125；类型检查、三包构建、桌面 bundle verifier 和 provenance 全部通过 |
| 生命周期 | `npm run test:e2e:lifecycle`：正常 nonce/ACK、ready 后 code 0、ACK 前 code 0、端口冲突、启动失败共 5 场景通过，运行目录均保持 0 → 0 |
| 全量浏览器 E2E | `npm run test:e2e`：desktop Chromium 与 Pixel 7 共 62 passed、0 skipped；覆盖设置页不暴露模拟入口和独立测试服务装配 |
| 证据边界 | exact merge-ref CI 与本地辅助记录只证明 synthetic L2 装配/API 合同；不证明 Windows Electron/NSIS L5、真实飞书/LLM L6 或生产数据行为。当前或未来 docs-only head 的 CI freshness 以 PR #71 body 最新 exact base/head/merge-ref/run/job 为准 |

## 2026-08-15 Issue #60：集成分支浏览器 E2E 状态隔离

本轮只使用人工构造的虚拟数据和本地规则/Mock，不连接真实飞书或真实 LLM。

| 检查项 | 结果 |
|---|---|
| 集成基线 | `integration/m1-test-20260815` 的 `e62f6c40b7c15403c320cdc3a57c8252e5761abd`；包含 #73 当前状态/验证矩阵治理、#72 日志脱敏加固、#52 任务详情竞态及其它已进入集成验收的改动；#71 在该基线已有正式 `buildApp`/Electron 路由 404 边界，但 PR 新增的 test helper fail-closed 守卫仍未合入 |
| Project 隔离 | 桌面宽屏与 Pixel 7 分别使用专用端口、内存 SQLite 和任务记忆目录；每轮使用唯一运行根，两套 browser project 可并行运行 |
| 测试装配边界 | 双服务只启动 `apps/server/tests/e2e-server.ts`；`npm run check` 保留正式 `/api/dev/simulate-message` 为 404、来源和候选均为 0 的合同 |
| 生命周期 | run token 绑定子服务、controller 与 Playwright 的 IPC readiness；双方使用单一 lifecycle phase，shutdown nonce 经过 `requested → accepted` ACK 门禁；ACK 前或未请求的退出均失败；先请求优雅关闭并有界等待、必要时强杀，确认退出后才删除目录 |
| 前置强断言 | 候选接受测试先通过测试 API 建立唯一候选，强断言响应、候选对象和卡片存在，不再使用条件空过 |
| Mobile 写流程 | 候选接受、证据展示、候选删除恢复、任务计划/修改/删除恢复和持续更新均在 Pixel 7 执行；不把浏览器注入的 Electron 桥接 Mock 当作 L5 验收 |
| 时序稳定性 | 两处固定延时改为由测试显式释放的响应门，加载态与忙碌态不再依赖机器速度 |
| Browser bridge 适用矩阵 | 23 条通用应用路径在桌面 Chromium 与 Pixel 7 各执行一次；首次配置保留并规范化 DeepSeek Provider、安全模拟模式强制 `rule_mock` 且关闭真实飞书和扫描两项仅由桌面 browser bridge Mock 执行。后两项是 L4-local 合同，不是 Electron L5 |
| 浏览器错误门禁 | `pageerror` 和非白名单 `console.error` 会使测试失败；#52 规则显式绑定当前 `testId`、精确文本、`GET`、pathname `/api/tasks/issue52-history-b`、空 search、503 和 `expectedCount=1`。fixture 共用的纯 Map matcher 分别校验响应和被消费错误；`tests/unit/expected-event-matcher.test.ts` 的 10 条自动合同覆盖正常、重复、错接口、额外接口、额外 query、缺失与 scope 错配 |
| Matcher 单测 | `npm run test:e2e:matcher`：10 passed、0 skipped；命令已纳入 `npm run check`，CI 日志可独立看到通过数量 |
| 定向组合回归 | B1 两项 desktop bridge 与 B3 的 #52 desktop/mobile 共 4 passed；候选接受、正式设置页无模拟入口的既有合同继续包含在完整 E2E |
| 完整代码门禁 | `npm run check`：matcher 10、server 387、web 8、desktop 7，类型检查、单元/合同测试和构建全部通过；server 包含 #72 的 redaction、mature 和 Feishu 合同 |
| 生命周期故障注入 | `npm run test:e2e:lifecycle`：正常 nonce/ACK 关闭、ready 后 code 0、ACK 前 code 0、端口冲突、注入启动失败共 5 场景通过；每场景运行目录集合均保持 7 → 7；该探针已加入 CI |
| 全量浏览器 E2E | `npm run test:e2e`：48 passed、0 skipped，24.6 秒（本地 Windows，3 workers） |
| 载体边界 | Pixel 7 是 L4 浏览器响应式证据；不是 Electron/NSIS L5 Smoke，也不代表真实飞书/LLM 的 L6 验收 |
| 未验证 | Windows 安装包、Electron L5、真实飞书租户和真实 LLM L6 |

## 2026-08-16 Issue #45 Draft：默认来源最小化与主人核验

当前 fetch 事实：integration 当前为 `4870585a39fabf215dbf51ee02b994c839e57e9b`；本节候选临时 stacked 在未合入的 #33 / PR #88 head `74cfa3fc1b7754338313494379170b6fb2b7c99d`，本轮普通 merge 已吸收该 integration tip；#33 合入后仍需按真实 integration tip 重绑。

本节记录 Issue #45 / PROD-01 在 `integration/m1-test-20260815` tip `4870585a39fabf215dbf51ee02b994c839e57e9b` 上普通 stacked merge Issue #33 / PR #88 head `74cfa3fc1b7754338313494379170b6fb2b7c99d` 后的行为/source `38b8a1d21338cddc77ca59a419ed7cb1b83702fe`；#33 尚未合入 integration，产品 fingerprint、文件数和 exact merge provenance 在本轮 docs generate 后以 `docs/docs-manifest.json`、`docs/verification-matrix.json` 和 PR #92 body 为准。候选仍为 Draft/Open，最终 PR head、merge-ref、parents/tree 与 exact CI 以 PR #92 body 最新 provenance 为准。所有数据为内存 SQLite、Fastify inject、Mock 和脱敏合成夹具，不连接真实飞书、真实 LLM、生产数据库或生产数据。

| 检查项 | 结果 |
|---|---|
| 默认来源 DTO | 候选列表与操作回执、任务列表/详情/工作台/日历/提醒、重新整理和纠错回执、主人信息使用严格 allowlist；正文、来源稳定 ID、sender/外部 ID、provider/model/prompt、文档 URL/ID、参考路径、纠错 before/after/note 和 Runtime 原始错误均不进入默认响应 |
| 受控来源核验 | `POST /api/tasks/:id/sources/:scope/verify` 只接受严格 `{ confirmed: true }`；服务端重新校验任务↔来源关系，返回 `local_snapshot_verified` / `local_snapshot_unavailable`、受控 reason/provider_status、快照捕获时间和最多 280 字递归脱敏 excerpt，并写入 `source.verification.completed` 私有审计；`external_action=none` 且 outbox 为零 |
| 负例合同 | 未确认请求、未知字段和无效 opaque scope fail-closed；只对达到长度门槛的整段/近整段复制、精确/NFKC/跨空白复现、结构化 Feishu/Docx token、UUID、owner raw error、source ID、URL/路径、纠错快照/note、候选 `timeRange.sourceText`、Runtime 原始错误和 proposal/provider 字段不回显；普通共享词不触发 fallback；公开提案策略版本只允许受控值、策略原因固定；与来源无关的主人任务编辑仍完整回显 |
| 正例合同 | 中文/英文派生摘要、短来源词对应的合法摘要、短标题和常用短语可以保留；候选列表、任务详情、线程选项、合并选项及拒绝归并 mutation 均保留安全摘要且不泄露来源正文 |
| 定向证据 | SEC-02/PROD-01/runtime：`sec-02-prompt-injection.test.ts` 15、`llm.test.ts` 76、`source-privacy.test.ts` 9、`runtime-thread-memory.test.ts` 99，共 199 passed；`database-migrations.test.ts` 92/92、server typecheck 和 `git diff --check` 通过 |
| 完整门禁 | `npm run check`：docs 27 passed / 1 Windows symlink capability skip、CI policy 58、matcher 10、server 643、web 26、desktop 134；lifecycle 5/5；Playwright inventory 86（desktop 44 / mobile 42）、E2E 86 passed / 0 skipped、verifier 86/86；docs generate/check/test、changed-path gate 和 `git diff --check` 通过；exact-head CI 仍以 PR #92 最新 provenance 为准 |
| 证据边界 | 当前只声明 synthetic L1-L4；不代表真实飞书/LLM、生产数据、Windows Electron/NSIS L5 或真实租户/provider L6 |

## 2026-08-16 Issue #46 Draft：失败来源收件箱与幂等重试

本节记录 Issue #46 在当前 `integration/m1-test-20260815` tip `9dfdfc65e0331cc4eabfe2510fc6e2974493576b` 上普通 merge 后的验证；behavior/source commit 为 `c12255dd3fb7fb6fee75bcd3ed301326bb178290`，当前 merge/docs provenance 仍以 PR #82 body 最新 exact base/head/merge-ref/run/job 为准。旧 ad75、e4c2、旧 head、旧 merge-ref 和旧 CI 仅作历史，不作为当前授权。所有数据为脱敏合成数据和 Mock，不连接真实飞书、真实 LLM 或生产数据。

| 检查项 | 结果 |
|---|---|
| 服务端失败可见性与脱敏 | 定向服务集成测试 17 passed；失败来源只返回来源类型、阶段、固定错误码、状态、尝试次数和 Runtime 状态，不返回正文、外部 ID 或 provider 原始响应 |
| 定向来源与 Runtime 恢复 | source-failure 19 passed；source-failure + Runtime recovery/owner state machine 132 passed；覆盖 classify_source/classify_source_batch 缺少 owning source 的列表/action 零写入、非分类 job 零写入、错误 source set/revision/link/duplicate 零写入及合法 classify_source/batch 脱敏失败 |
| 关系边界与零写入 | 覆盖 A→B job 错绑、缺失来源、错误派生 ID、payload revision/source set/重复 ID 不一致、`job_source_link` 不一致；owner_decision/reprocess_candidate 失败不写 failure_inbox、correction_event 或候选业务状态；关系失效项不进 DTO，重试/归档/忽略返回固定脱敏 404，来源、候选、线程、任务、提案、事件和 correction_event 均零写入；合法旧 revision 仍显示 stale |
| 幂等重试与恢复 | 覆盖重复点击、同一 Runtime job、恢复后 resolved、私有审计和归档 CAS；重试不创建第二个分类任务、不触发对外动作 |
| 完整代码门禁与 E2E | 当前 integration tip 合入及 Issue #29 provider-before-snapshot 修复后的本地复跑：`npm run check` docs 24 passed / 1 symlink capability skip、CI policy 31、matcher 10、server 610、web 23、desktop 134；lifecycle 5/5；inventory 84（desktop 43 / mobile 41）；full Playwright 84 passed / 0 skipped；verifier desktop 43/43、mobile 41/41；docs generate/check/test、changed-path gate 和 `git diff --check` 通过 |
| Exact-head CI | 新 merge/docs head 推送后，最终 head、merge-ref、parents、tree、run/job 与 terminal SUCCESS 以 PR #82 body 最新 exact provenance 为准；verification record 保留 `record_commit=pull_request_82_pending`，不把 provenance commit 自引用为实现来源 |
| 未验证 | Windows Electron/NSIS L5 与真实租户/provider L6 仍需在最终分支验证；本轮不连接真实飞书、LLM、生产数据库或生产数据 |

## 2026-08-15 Issue #49：工作台上海自然日与独立统计

本轮使用内存 SQLite、合成任务与浏览器 Mock，不连接真实飞书、真实 LLM 或生产数据。

| 检查项 | 结果 |
|---|---|
| 上海自然日 | 覆盖上海 00:00 / 23:59、UTC 跨日、跨月和跨年；查询使用半开区间 |
| 日期与状态合同 | 覆盖上海 00:00 / 23:59、UTC 跨日、跨月、跨年及显式跨日区间；completed、archived、invalidated 与软删除任务均不进入“今天待推进” |
| 独立统计 | 候选 9 / 今日 11 / 等待 10 / 进行中 1 / 逾期 3，各自条件不同且列表仍限制为 6 / 8 / 8 |
| 页面模式 | 不再固定显示虚拟数据；按 API 显示本地模拟或外部适配器已配置 |
| L1 / L2 | 上海时间与演示排期 6 passed；Dashboard 服务集成 21 passed；Web 9 passed |
| L4 | desktop Chromium 与 Pixel 7 共 4 passed，覆盖加载、独立数量、空状态、503 与刷新重试 |
| 未验证 | Windows Electron / NSIS L5 与真实租户/provider L6；浏览器 Mock 不能替代真实环境 |

## 2026-08-15 Issue #57：外链策略验证来源更正

本节只更正验证证据的提交归属，不改变 URL policy、IPC、页面反馈或产品能力。所有验证继续使用合成 URL、内存数据与 browser bridge Mock；未打开真实网址，未连接真实飞书、真实 LLM 或生产数据。

| 检查项 | 结果 |
|---|---|
| 冻结基线 | `integration/m1-test-20260815` @ `c872c0f9534b1a8b7ad2fcde9551efcba503ad46` |
| 精确 source commit | `10a42dba8a0955ed13075ac6df5713cac3a2ddae`；该提交在 `8a793261...` 的实现与既有测试之上，新增第 14 条 web URL+format 库存所需的 document bridge / OAuth 隔离合同 |
| 记录 commit | `5de44f56bbb0c41f592cceeef45dd7b7872f498f`；该提交实际包含本次 source 更正、生成视图输入、当前状态说明与本 QA 记录，不使用自引用 SHA |
| 产品等价参照 | `10a42dba8a0955ed13075ac6df5713cac3a2ddae`；这里只说明产品源码指纹等价，不以 selector 排除测试或文档来外推其提交归属 |
| 本地验证库存 | URL policy/desktop 109；web URL+format 14；Shanghai/app/service lifecycle 31；`npm run check` 中 matcher 10、server 394、web 16、desktop 109；lifecycle 5/5；完整 E2E 54/54 |
| 证据层级 | 最多 L4；未运行真实 Electron `shell.openExternal`、安装 EXE、系统默认浏览器或真实租户/provider 跳转，未取得 L5/L6 |

## 2026-08-15 六个获批 PR 的 integration 组合回归

本轮在隔离工作树中把 PR #74、#76、#77、#78、#79、#67 的已批准精确 head 组合到冻结基线 `c872c0f9534b1a8b7ad2fcde9551efcba503ad46`。这里只记录本地组合证据；最终远端授权仍以推送后的 integration SHA 与 GitHub Actions run 为准。

| 检查项 | 结果 |
|---|---|
| 组合整理 source | `32485c4dc335b4b258629b70f1d49d5a563eff71`；处理桌面构建验证顺序、Vitest inventory 输出目录和 ADR 编号冲突，没有修改六项获批产品行为 |
| 依赖安装 | `npm ci` 通过，0 vulnerabilities |
| 完整代码门禁 | `npm run check` 通过：docs 21 passed / 1 Windows symlink capability skip；CI policy 31；matcher 10；server 523；web 20；desktop 127；三端 typecheck/build、desktop bundle verifier 与 E2E build provenance 均通过 |
| 生命周期 | `npm run test:e2e:lifecycle`：5/5；每个场景运行目录均保持 0 → 0 |
| 浏览器组合回归 | `npm run test:e2e`：62 passed / 0 skipped；覆盖桌面 Chromium 与 Pixel 7 |
| 简化复核 | 未发现冲突标记、第二套迁移解释器、第二套 snapshot/date validator 或重复 CI 状态机；组合修复仅连接已有单一路径 |
| 证据层级 | 最高 L4；另有独立 Smoke fallback（安装/启动/退出/卸载路径），不等同完整 Windows installed Electron/NSIS L5；未连接真实飞书、LLM、生产数据或取得 L6 |

## 2026-08-15 Issue #80：旧库保留、新库启动与桌面失败可见性

本轮仅使用临时 synthetic userData、桌面纯函数合同和隔离安装 Smoke，不读取、复制或迁移真实用户数据库，不连接真实飞书、真实 LLM 或生产数据。

| 检查项 | 结果 |
|---|---|
| 新库路径 | `apps/desktop/src/database-path.test.ts`：1 passed；当前文件固定为 `data/ai-pm-v1.sqlite`，历史 `data/ai-pm.sqlite` 路径仅用于存在性提示 |
| 精确产品/构建 source | `f9e77aec70aaa846047f987672c9171e0790846a`；这是正式安装包对应的产品实现来源，不是后续 PR 证据 head |
| artifact/record carrier | 已知 carrier ancestor `3dcd9d0779542a7f3b6beebe73048273a0eff68a`；`VER-PACKAGE-020.record_commit` 使用 `pull_request_81_pending`，避免同一提交自引用 |
| 产品投影 | selector `apps-workspace-default-include-v1`；`77` files；fingerprint `79c8f0bcc50df16ce0a515c5872027170f26c99c61776691c4b780f1038b83fe`；当前 DATA-02 merge `f080463cd43db63456b4408e18e7b0582666054f` 与该投影对应，正式包仍绑定历史 product/build source `f9e77aec70aaa846047f987672c9171e0790846a` |
| PR evidence freshness | PR #81 最终 docs/evidence head、merge-ref、parents 与 run/job 只写入 PR body，不替代产品/构建 source |
| 旧库保留 | 隔离 Smoke 创建 synthetic sentinel，启动后旧文件 SHA-256 不变，未读取/迁移/重命名/删除；新库建立并可重启，配置中的 synthetic appId 保留 |
| 服务端迁移合同 | `apps/server/tests/database-migrations.test.ts`：92 passed；这是受控维护/合成合同，不代表桌面自动兼容真实历史库 |
| 桌面启动错误 | `apps/desktop/src/startup-errors.test.ts`：2 passed；DatabaseUpgradeError 与未知异常均只产生固定脱敏提示，bootstrap 清理并退出 |
| 类型检查 | server、desktop 定向 typecheck 通过 |
| 安装 Smoke | 独立 Smoke 变体安装、正常启动/退出/卸载通过；旧库 sentinel 场景输出固定提示并以新库启动，重启通过；未知新库错误输出固定脱敏标记并退出；现有快捷方式未变化 |
| 未验证 | 真实历史数据库迁移/导入、Windows 文件锁/reparse L5、Authenticode 签名、真实飞书/LLM L6 |

## 2026-08-16 Issue #56：桌面生命周期 Phase 1（当前 integration base）

本轮将当时 `integration/m1-test-20260815` @ `ad75b68687356a4782779b34ec35c60db68e05ea` 普通合入 Issue #56 候选；旧 `e4c2b1335664429e354015b2131427dc277f0c7b`、`f7bdf11bf2578f130f2443c6f67d6d004b82b394` 仅作为历史 base。候选只增加桌面生命周期、受控故障注入和 Smoke 合同，不重复引入或修改 Issue #80 的 database-path、server migration、ADR 或正式 release 证据。测试使用 synthetic temporary userData，不读取真实 `%APPDATA%` 或真实数据库，不连接真实飞书、LLM 或生产数据。

## Issue #62 REL-01 Windows L5 门禁基础设施

| 项目 | 当前状态 |
|---|---|
| Release manifest | `docs/release-manifest.json` 已绑定版本、pending source/artifact/workflow、Electron/Node/schema/config compatibility、signature、Smoke 场景和 viewport 合同；当前 `authorization=false` |
| Manifest checker | `scripts/release-manifest.mjs` 对 SHA、run/job、artifact、签名 thumbprint/timestamp、Smoke evidence 和 1440/320/980×680 尺寸 fail-closed |
| Windows workflow | `.github/workflows/release-l5.yml` 在 exact source 上构建隔离 NSIS，并运行严格安装/生命周期/卸载 Smoke；Ubuntu CI 不冒充 L5 |
| Synthetic harness | `scripts/release-l5-harness.mjs` 覆盖 N-1→N、数据保留重装、downgrade 拒绝、坏库/迁移/磁盘/文件锁/config/断网/auth/429/分页故障；外部能力仅 synthetic adapter |
| 签名与发布 | 当前证书/Authenticode/timestamp 缺失，manifest 明确 `NotSigned`、`Smoke=not_run`、`authorization=false`；未发布 GitHub Release |
| 尚未完成 | 真实签名包、同一 hash 的 Windows L5 Smoke、真实文件锁/reparse 与升级回退验收；不关闭 Issue #62 |

| 检查项 | 结果 |
|---|---|
| behavior/source | `a2b35f1e0042c95808f3e0df53fc24c350b15c3a`；当前产品投影 `80` files / fingerprint `58061eb32be2e3e4439acc3918e016e36112499be7ab1fd6d71fd408f25d417a` |
| 状态机 | `DesktopLifecycle` 单一串行队列；`starting → ready` 发生在 BrowserWindow `loadURL` 完成后；启动中请求 shutdown 会排队并最终 `stopped`；失败统一 `failed → shutting_down → stopped` |
| 清理路径 | `DesktopLifecycle → requestShutdown → disposeCore` 单一链；Runtime recovery 停止后才关闭 Fastify/SQLite；`quitting` 只控制窗口行为，`shutdownRequested`/`shutdownComplete` 仅保护请求与完成通知 |
| 生命周期单测 | `apps/desktop/src/lifecycle.test.ts` 与 `startup-errors.test.ts`：5 + 2 passed |
| lifecycle 探针 | `npm run test:e2e:lifecycle`：5/5；覆盖启动中并发 shutdown、startup-core、reload failure、OAuth 降级和正常退出 |
| Playwright | `npm run test:e2e`：82 passed / 0 skipped |
| fresh Smoke | 由 docs-only exact source `9fae562871e295b41c5f9c52fb0712ad0b61fad3` 构建的纯 Issue #56 + 当前 integration 临时 Data-PM-Smoke NSIS；EXE 101885177 bytes，SHA-256 `6C9FB60AFCEF61D6F74C28F8F901159508858F2F0270360ECE057E48F4CF6DDF`；blockmap 106610 bytes，SHA-256 `000708CC0086DF0485F92A92421A8BCA6B6752741F32F1CE14496ED6D7EF3857`；normal exit 0、startup-core exit 1、reload exit 1、OAuth degradation exit 0、legacy/restart exit 0、damaged-database bootstrap exit 1；每个场景确认安装目录 Electron 主/子进程退出，超时 fallback 使用 `taskkill /T` |
| 证据边界 | 仅 synthetic L2；不等同正式 release/L5、签名、真实 provider、真实用户数据库或 L6 |

## 2026-08-16 Issue #29：stale 主人判断 fail-closed

本轮使用内存 SQLite、Fastify inject、虚拟分类器/Runtime 和脱敏合成消息，不连接真实飞书、LLM、生产数据库或生产数据。验证只证明服务端 L2 合同；行为/source head `31115970d0beda52cef286a827106a8dcbc20d29` 与产品 fingerprint `a1af1c9d62ff257ebf78c1bbd91ec2190cef2e1f62caf393615cfbc5ad35fad9`（80 files）已复核，当前 docs-only exact head/merge-ref/CI 待推送后重新取得；仍保留 Draft/Open 与独立复核边界。

| 检查项 | 结果 |
|---|---|
| behavior/source | `31115970d0beda52cef286a827106a8dcbc20d29`；产品投影 `80` files / fingerprint `a1af1c9d62ff257ebf78c1bbd91ec2190cef2e1f62caf393615cfbc5ad35fad9`；verification record 使用 `pull_request_93_pending` 避免自引用；最终远端 freshness 以 Draft PR #93 新 exact provenance 为准 |
| Runtime payload fence | owner-target snapshot 与 owner-decision payload 写入均校验当前 lease owner、未过期 `locked_until`、`cancel_requested_at IS NULL`，并要求 `changes = 1`；旧 owner 接管后不能覆盖新 owner payload |
| stale 证据边界 | 删除/回收站/作废使用可证明退休时间；ignored 候选若没有历史退休时间保持 review；同会话但无 source/thread/root/parent/session 强关系或同 source linked decision 的 legacy orphan 保持 review；合法零目标快照不重扫后来候选，重启/重试确认空快照时只写 noop 且不生成 pending action，首次真正未关联消息仍保留 review |
| 目标一致性 | accepted snapshot 必须同时匹配 candidate state、accepted_task_id、task/thread id、version、status；变化即 fail-closed |
| 事务与恢复 | stale UPDATE/审计注入失败时 candidate/task/decision/notification/correction 全部回滚；恢复候选或任务不复活旧 stale decision，只有新主人消息或显式新 retry 才产生新审计 |
| 定向与全量 | `owner-message-state-machine.test.ts`：42 passed；server 全量：616 passed；`npm run check`：docs 24 passed / 1 platform capability skip、CI policy 31、matcher 10、web 23、desktop 134、typecheck/build/artifact verifier 通过；lifecycle 5/5；Playwright inventory 84（desktop 43、Pixel 7 41），完整 E2E 84 passed / 0 skipped；execution verifier 84/84；docs generate/check/test、domain-contract check 和 `git diff --check` 通过 |
| exact provenance | 当前 docs-only head 尚未推送，fresh exact base/head/merge-ref/tree/parents/run/job 由 PR #93 body 在推送后绑定。`479103a33fb8a1a9385d268e76db33bc627e36f2`、`8ef8104acc4341b09aaa04ab41c64059dc8e50cd`、`31964658362/95208259159` 明确仅为 historical source evidence，不得作为 current candidate freshness；此前 behavior candidate 的 `31115970d0beda52cef286a827106a8dcbc20d29` / merge-ref `b70be4232c97fa201de91138a9bee3ec6735cf32` / CI `31966731364/95212932295` 也仅代表 docs commit 前的行为候选 |
| 未验证 | 独立复核、Draft→Ready、批准、合入和发布均未进行；Windows Electron/NSIS L5、真实 Feishu/LLM/provider/生产数据 L6 未验证 |
