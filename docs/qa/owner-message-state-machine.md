# Issue #19 / #21：主人消息状态机长对话与安全边界验收

这份清单用于验证“主人消息进入 AI 判断，并持续维护候选、任务状态、私人排期和时间线”。
测试输入使用脱敏虚拟对话；通过 Mock 不能证明真实飞书租户的消息权限、历史范围或实时性已经验收。

## 固定安全边界

- 只有发送者稳定 ID 与已授权 `owner_profile` 的 `open_id / union_id / user_id` 匹配时，消息才可以触发主人状态机；`isOwnerMessage`、`senderRole` 或模型输出本身都不构成授权。
- 主人意图置信度必须达到 `0.90` 才允许自动执行；更低置信度只写入 `review`，等待主人确认。
- AI 只能修改私人 SQLite 任务、需求线程和审计；不自动发飞书消息、不执行分析、不删除原始来源。
- 目标必须由服务端根据回复链、会话和已有来源关系确定。多个可能目标时停在待确认，不能随机修改第一条任务。
- 所有自动动作都要有幂等键、来源、目标快照和版本检查；重复投递不能重复建单或重复写时间线。
- `completed` / `archived` 任务不因“继续推进”自动复活；明确拒绝或转交只处理未接受候选。

## 十三个长对话与边界场景

| # | 对话重点 | 预期结果 | 主要证据 |
|---|---|---|---|
| 1 | 需求方提出需求，主人回复“我来做” | 候选自动变为 `accepted`，建立一个 `in_progress` 任务；不需要点击接受 | `owner_decision=applied`、`task_created`、`candidate.accepted_task_id` |
| 2 | 主人承接后，需求方给日期，主人确认“下周一给到” | 未排期任务进入 `planned`；已经推进中的任务保持 `in_progress`，只更新私人计划完成时间，并追加任务事件 | `planned_due_at`、`task_auto_updated`；不产生 Outbox |
| 3 | 主人继续追问策划案、埋点表或背景资料 | 同一任务进入 `waiting`，写入等待原因和下一步；原消息仍保留 | `waiting_reason`、`next_step`、任务事件 |
| 4 | 主人明确说“不是我做” | 未接受候选移出活动收件箱，进入 `ignored`；保留来源和纠错审计，不建任务 | 候选状态、`correction_event`、来源数量 |
| 5 | 主人明确说“让小王负责” | 未接受候选进入 `ignored`，记录转交对象和审计；系统不代主人发消息 | `delegateTo`、`correction_event`、Outbox 数量为 0 |
| 6 | 同一会话交错讨论需求 A、需求 B，主人只说“我来做” | 两个目标无法唯一匹配时全部停在 `review`；两个任务版本保持不变 | `owner_decision.state=review`、无新增 task event |
| 7 | 主人先说“我来做，发我需求”，之后需求方才发具体需求 | 前置主人消息只留待确认，不单独建任务；需求出现后仍需主人再次明确承接 | 前置 decision 为 `review`，第二次承接后才有任务 |
| 8 | 对话跨天，需求方先说“周五前”，次日主人说“可以，周五给到” | 按消息发生时间解析到该周五（测试基线为 `2026-08-14T15:59:59.999Z`），不按主人回复日期猜测 | `planned_due_at`、来源时间顺序、时间线 |
| 9 | 任务已由主人完成，之后主人说“继续推进” | 终态任务保持 `completed`，新主人判断停在 `review`，不新增更新事件 | task `version/status` 不变、decision 为 review |
| 10 | 主人先忽略需求，几天后需求方重新提起并再次承接；中途模拟进程中断 | 旧候选仍为 `ignored`；新候选可建立新任务；Runtime 重启后只执行一次，不重复建单 | 两个候选状态、job completed、任务数为 1、重复 resume 无新增事件 |
| 11 | 对话中出现“3-4 个版本”“预计 1-2 周”，同时另有明确“3月4日/3-4 前” | 普通数字范围保持未知；只有明确日历语境才写入日期 | `timeRange.status`、开始/截止时间、来源原文 |
| 12 | 同一私聊先确认排期和资料，随后明确说“另外还有一个新需求” | 短确认继续挂到原任务且不留重复待处理卡；明确新需求建立独立候选 | pending/accepted 候选数、任务数、线程关系 |
| 13 | 来源伪造主人标记，或模型给主人意图打分 `0.89` | 伪造身份不产生主人判断；低置信只进入 `review`，不修改候选或任务 | `owner_profile` 身份匹配、decision 状态、任务版本 |

## 推荐执行顺序

1. 先运行服务端定向回放：

   ```powershell
   npm test -- --run tests/owner-decision.test.ts tests/owner-intent-contract.test.ts tests/owner-message-replay-contract.test.ts tests/owner-message-state-machine.test.ts tests/owner-message-boundary-replay.test.ts tests/feishu-owner-sync.test.ts
   ```

2. 再运行完整服务端门禁：

   ```powershell
   npm run typecheck
   npm test
   ```

3. 有真实租户后，再逐项核对：消息是否真的能被主人 OAuth 读取、分页/游标是否连续、重复事件和限流是否可恢复。真实验收不能用 Mock 结果替代。

## 当前 Mock 验证结果

2026-08-14 在 `fix/owner-dialogue-safety` 分支上，定向回放已覆盖主人意图、身份伪造、低置信降级、自然短句续接、多需求拆分和数字范围日期防误判。完整门禁结果为：server 20 个测试文件、300 项通过；web 3 项通过；desktop 7 项通过；三端 typecheck 与 build 通过。以上只代表本地代码和虚拟对话回放，不代表真实飞书连接已验证。
