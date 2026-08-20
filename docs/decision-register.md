<!-- 此文件由 scripts/decision-register-check.mjs --write 根据 decision-register.json 生成。不要手工修改。 -->

# DEC-01：M1 产品与治理负责人决策登记

- 状态：`accepted`
- 负责人：`product_owner`
- 最后复核：`2026-08-16`
- 生效范围：M1 / 首个受控单用户试点 / integration/m1-test-20260815
- 本登记范围：本登记只固定 M1 的产品、发布、隐私、验证和协作边界；不实现 #34、#55、#58、#85 的行为。

## 验证边界

- 绑定基线：`06f45f0e47edbc8b599fdf4f9bd94afb402f850d`
- 运行：`pull_request_94_pending`；环境：Behavior/source is bound to commit 06f45f0e47edbc8b599fdf4f9bd94afb402f850d; current candidate and exact CI freshness are bound by PR #94 body / synthetic-document-contract / Node 24 / Windows；结果：`passed`
- 证据上限：`L0`、`L2`、`L4`
- 未验证：L5 Windows 安装验收；L6 真实飞书租户与真实 LLM/provider 验收

## 已决定事项

| ID | 类型 | 决定 | Gate | 依赖 | 解锁 |
| --- | --- | --- | --- | --- | --- |
| DEC-01.1 | database | M1、单机和首个受控单用户试点继续 SQLite；只有出现多人、多设备或远程服务需求时才评估 PostgreSQL。 | owner_confirmed_and_database_independently_reviewed | #66、#35 | #35、#64、#66 |
| DEC-01.2 | release | M1 和首轮试点永久 draft-only；真实发送另开 Issue，并经系统主人确认与真实环境安全验收。 | owner_confirmation_and_real_environment_safety_acceptance_before_external_send | #58、#66 | #58、#66 |
| DEC-01.3 | calendar_and_dates | today 使用 Asia/Shanghai 自然日，右边界不含；跨日覆盖每个自然日；completed 不计今天待推进，archived 默认隐藏可筛选。普通日历默认只是来源事实，只有明确主人责任、动作和交付物或截止点才进候选；责任不明仅提示主人确认。 | owner_confirmed_product_contract | #50、#85、#66 | #50、#85、#66 |
| DEC-01.4 | governance | main 与 integration 仅 PR 合入，负责人最终批准；安全、隐私、数据库和发布变更必须独立复核。 | owner_final_approval_and_independent_review_for_security_privacy_database_release | #65、#66 | #65、#66 |
| DEC-01.5 | privacy | 隐私采用停止采集/撤权→可选导出→二次确认硬删除；仅保留不含内容的删除证明和必要审计。 | owner_second_confirmation_and_privacy_independent_review | #34、#66 | #34、#66 |
| DEC-01.6 | validation | 只有诊断与隐私合同完整、可区分 success/partial/skipped/failure 且具脱敏 operation/request/error/release identity 后，才扩大真实账号试点；Mock/L2/L4 不得替代真实验收。 | diagnostic_and_privacy_contract_complete_before_real_pilot_expansion | #55、#58、#66 | #55、#58、#66 |
| DEC-01.7 | product_boundary | 系统只自动发现、记录和管理任务，不自动执行任务；系统主人以外的人能够看到的内容必须由系统主人确认；来源事实与生成摘要保持区分；文件变化不能证明任务完成。 | non_negotiable_product_boundary | #66 | #34、#55、#58、#85、#66 |

### DEC-01.1：database

- 选项：M1 继续 SQLite；M1 立即切换 PostgreSQL
- 原因：当前目标是可恢复的单机单用户真源；提前切换会扩大部署、迁移和证据范围。
- 影响：用户继续使用本机数据库，不会因多人或远程需求尚未出现而被强制迁移。
- 范围：SQLite 是 M1 任务、来源和审计的唯一事实真源；PostgreSQL 只是未来触发评审的选项。
- 证据：ADR-0007、ADR-0008
- 未验证：L5 真实 Windows 文件锁与安装升级；L6 多人、多设备或远程服务容量与迁移

### DEC-01.2：release

- 选项：M1 与首轮试点永久 draft-only；在 M1 自动发送真实内容
- 原因：生成草稿和审计可以在本地复核，自动对外发送会扩大权限、误发和证据范围。
- 影响：用户看到的是待确认草稿；系统不会替主人发送消息或执行任务。
- 范围：当前只生成待确认 approval/outbox 草稿，不启动真实发送执行路径。
- 证据：ADR-0007、ADR-0008
- 未验证：L5 安装包中的真实外发阻断；L6 真实发送 Issue 的环境安全验收

### DEC-01.3：calendar_and_dates

- 选项：Asia/Shanghai 半开自然日与显式责任候选规则；按设备时区或日历占位默认建候选
- 原因：时间事实不等于任务责任；明确责任和交付物才能避免候选泛滥。
- 影响：普通提醒仍可追溯为日历事实，但不会自动变成任务；有明确责任和交付才会进入候选。
- 范围：该规则固定 M1 的日期展示和日历候选入口；不直接实现 #50 或 #85。
- 证据：ADR-0003
- 未验证：L2/L4 对全部日历类型和跨时区边界的实现覆盖；L6 真实飞书日历权限与字段表现

### DEC-01.4：governance

- 选项：main/integration 只经 PR 合入并独立复核；负责人或 Worker 直接推送并合入
- 原因：把实现、证据和最终授权分开，降低单人误判和不可恢复发布风险。
- 影响：改动先进入可恢复的 Draft PR，负责人决定最终合入和发布。
- 范围：适用于仓库协作、Draft PR、验证证据和 release；不改变 GitHub 服务器配置声明。
- 证据：ADR-0008
- 未验证：GitHub branch protection 的服务器端配置受平台权限限制；单一可用 owner 时的独立性边界

### DEC-01.5：privacy

- 选项：停止采集/撤权→可选导出→二次确认硬删除；立即删除或无限期保留全部内容
- 原因：先阻止新增采集，再让主人有机会导出，最后以明确二次确认完成不可逆删除，同时保留最小可验证证明。
- 影响：主人可以先停采集并选择导出，硬删除需再次确认；删除后不会保留可读内容。
- 范围：删除证明不得包含正文、token、路径或可还原的原始内容；审计保留须是必要且脱敏的。
- 证据：ADR-0003
- 未验证：L2/L4 全链路删除证明与恢复边界；L5/L6 真实文件系统、备份与租户删除验收

### DEC-01.6：validation

- 选项：四态诊断/隐私合同完整后再扩大真实账号试点；用 Mock/L2/L4 代替真实验收
- 原因：本地和浏览器证据只能证明合成边界，不能证明真实租户权限、provider 和发布环境。
- 影响：没有完整脱敏诊断和隐私证据时，试点不会扩大到真实账号范围。
- 范围：当前证据上限为 L0/L2/L4；真实账号扩展属于独立门禁，不由本 Issue 宣称完成。
- 证据：暂无独立运行证据
- 未验证：L5 Windows release evidence；L6 real Feishu/LLM/provider and privacy acceptance

### DEC-01.7：product_boundary

- 选项：只发现、记录和管理任务；对外动作须主人确认；自动执行任务或让文件活动证明完成
- 原因：这是项目最高产品边界，不是可由实现者自行选择的偏好。
- 影响：候选、草稿和任务状态可管理，但不会自动执行或把文件活动当成完成。
- 范围：所有 M1 实现、文档、验证和桌面入口。
- 证据：AGENTS.md、ADR-0007
- 未验证：L5/L6 真实外部动作和安装环境边界

## 待主人决定事项

| ID | 类型 | Gate | 不得默认实现 |
| --- | --- | --- | --- |
| DEC-01-P1 | pilot_access | owner_decision_before_real_pilot | 是 |
| DEC-01-P2 | privacy_retention | owner_decision_before_privacy_release | 是 |
| DEC-01-P3 | multi_device | owner_decision_before_postgresql_or_sync | 是 |

### DEC-01-P1：pilot_access

- 选项：指定试点租户、应用负责人和管理员审批路径；暂不扩大真实账号试点
- 当前状态：待主人选择（不得默认实现）
- 原因：真实租户权限和审批路径尚未取得 L6 证据。
- 影响：在主人选择前，工程实现不得假定真实租户权限已批准。
- 未验证：L6

### DEC-01-P2：privacy_retention

- 选项：确定原文保留期、可见人员和长期备份策略；维持当前最小采集并暂停真实隐私发布
- 当前状态：待主人选择（不得默认实现）
- 原因：永久删除流程已确定方向，但保留期限和备份策略仍未确定。
- 影响：没有主人确认，工程不得自行决定保存多久或谁能看到原文。
- 未验证：L5；L6

### DEC-01-P3：multi_device

- 选项：出现多人/多设备/远程需求后启动 PostgreSQL 评审；保持 M1 本机 SQLite
- 当前状态：待主人选择（不得默认实现）
- 原因：M1 目前没有多人、多设备或远程服务需求证据。
- 影响：工程不会因为想象中的规模需求提前引入远程数据库或同步。
- 未验证：L5；L6

## 产品最高边界

- 系统只发现、记录和管理任务，不自动执行任务。
- 对外可见内容和外部动作必须由系统主人确认。
- 来源事实与生成摘要保持区分；文件变化不能证明任务完成。
