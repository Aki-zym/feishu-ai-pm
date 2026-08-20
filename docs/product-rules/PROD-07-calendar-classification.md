<!-- 此文件由 scripts/prod-07-calendar-contract-check.mjs --write 根据 PROD-07-calendar-classification.json 生成。不要手工修改。 -->

# PROD-07：日历事实与任务候选分类规则

- 状态：`contract_only`；负责人：`product_owner`；最后复核：`2026-08-16`
- 生效目标：M1 / 首个受控单用户试点 / calendar source classification
- 范围：本文件只定义产品规则、合成验收夹具和后续实现输入输出；本 Issue 不修改生产分类行为。
- PROD-07 证据上限：`L0`；本 Issue 只有合同/静态夹具证据。整仓 CI/Playwright 仅作为回归门禁，不证明规则已在 UI 或生产分类中实现；不声明 L5/L6。

## 三条产品路径

| 路径 | 用户可见含义 | 生成候选 | 需主人确认 | 保留来源 |
| --- | --- | --- | --- | --- |
| calendar_fact | 时间事实或提醒，保留在 Calendar 来源和日历展示中 | 否 | 否 | 是 |
| candidate_review | 明确责任、动作和交付物/截止点，生成一个待主人确认的候选 | 是 | 是 | 是 |
| owner_confirmation | 有行动迹象但责任或交付边界不完整，只提示主人确认，不批量制造候选 | 否 | 是 | 是 |

## 角色规则

| 角色 | 默认路径 | 规则 | 角色本身不等于任务 |
| --- | --- | --- | --- |
| organizer | calendar_fact | 仅当正文明确主人负责动作且同时有交付物或截止点 | 是 |
| required_attendee | calendar_fact | 仅出席不构成候选；需要主人责任、动作和交付信号 | 是 |
| optional_attendee | calendar_fact | 仅在正文明确主人交付责任时进入后续规则 | 是 |
| no_response | calendar_fact | 不得因未响应推断主人需要执行；责任不明时只走确认提示 | 是 |

## 事件类型规则

| 事件类型 | 默认路径 | 原因 |
| --- | --- | --- |
| ordinary_reminder | calendar_fact | 普通提醒只是时间事实 |
| attendance_only | calendar_fact | 仅出席不等于主人有交付责任 |
| meeting_placeholder | calendar_fact | 会议占位不能单独推断 action item |
| all_day | calendar_fact | 全天属性不增加任务责任 |
| recurring | calendar_fact | 重复属性不增加任务责任，后续实现需按系列去重 |
| holiday | calendar_fact | 节假日是订阅或时间事实 |
| birthday | calendar_fact | 生日提醒默认不是交付任务 |
| subscribed_calendar | calendar_fact | 订阅日历默认只提供事实 |
| explicit_owner_delivery | candidate_review | 明确主人责任、动作和交付物或截止点 |
| minutes_action_item | candidate_review | 纪要或明确消息提供了可追溯 action item |
| ambiguous_action | owner_confirmation | 有行动词但责任或交付边界不完整 |

## 进入候选的硬条件

必须同时满足：`explicit_owner_responsibility` + `action` + `deliverable_or_deadline`。

动作词：准备、提交、评审、确认、交付、整理、回复、更新、跟进
主人责任信号：我负责、由我、请我、主人需要、我来提交、我来确认
交付物/截止点信号：报告、名单、文档、结果、方案、截止、到期、之前完成、周一前、明天前
非任务信号：仅供参考、提醒一下、欢迎参加、可选参加、生日快乐、节假日、订阅日历、例会

不确定路径合同：route=owner_confirmation；scope=single_event；candidate_created=false；source_retained=true；bulk_candidate_creation=false；required_fields=missing_signal_code、source_reference；forbidden_fields=raw_source_content、global_calendar_filter、source_deletion
会议来源合同：placeholder_route=calendar_fact；placeholder_is_action=false；action_item_sources=minutes、explicit_message；requires_all_candidate_signals=true；source_retained=true；scope=event_then_explicit_related_source
解释合同：calendar_fact[required=none;forbidden=raw_source_content、provider_payload、attendee_directory;raw_content_allowed=false;free_text_allowed=false;scope=none]；candidate_review[required=owner_responsibility、action、deliverable_or_deadline、source_reference;forbidden=raw_source_content、provider_payload、attendee_directory;raw_content_allowed=false;free_text_allowed=false;scope=redacted_explanation]；owner_confirmation[required=missing_signal_code、source_reference;forbidden=raw_source_content、provider_payload、attendee_directory;raw_content_allowed=false;free_text_allowed=false;scope=redacted_explanation]

## 纠错边界

- 入口：这只是提醒
- 当前事件：current_event_only
- 重复系列：explicit_owner_selection_only
- 学习范围：same_event_family_only
- 重分类：derived_state_only
- 来源变更：forbidden
- 审计：private_correction_event_required
- 全局过滤：false
- 全局删除来源：false
- 新 revision：true
- 幂等：operation_id_required

## 合成验收夹具与指标

| 夹具组 | 输入 | 路径 | 候选 | 待确认 | 保留来源 | 最大噪声率 |
| --- | ---: | --- | ---: | ---: | ---: | ---: |
| ordinary-reminders-50 | 50 | calendar_fact | 0 | 0 | 50 | 0 |
| explicit-delivery-10 | 10 | candidate_review | 10 | 0 | 10 | 0 |
| uncertain-responsibility-10 | 10 | owner_confirmation | 0 | 10 | 10 | 0 |
| repeat-series-12 | 12 | calendar_fact | 0 | 0 | 12 | 0 |

- 事实保留率最低：1
- 事实误报候选噪声率最高：0
- 明确交付候选召回率最低：1
- 责任不明批量候选最高：0
- 候选解释覆盖率最低：1
- 重复系列候选倍增最高：1
- 后续实现验收目标：桌面/窄屏 route 与解释保持一致（当前 Issue 未实现或验证 UI 分类行为）

### 可见验收

- Calendar 中仍能看到被判为事实/提醒的事件，候选页不出现同一事件。
- 候选卡解释主人责任、动作、交付物/截止点和来源依据；责任不明显示待确认原因。
- 后续实现验收目标：桌面与窄屏使用相同 route 和解释，不把 Calendar 事实写成任务；本 Issue 尚未实现或验证 UI 分类行为。
- “这只是提醒”只影响主人选择的事件或系列，来源、审计和其他事件不被删除。

## 合成示例

| ID | 类型 | 事件 | 预期路径 | 生成候选 | 解释模板 | 解释 |
| --- | --- | --- | --- | --- | --- | --- |
| negative-reminder-01 | negative | 周例会提醒 | calendar_fact | 否 | `calendar_reminder` | 仅提醒，不包含主人动作或交付物。 |
| negative-attendance-01 | negative | 数据周会 | calendar_fact | 否 | `calendar_attendance_only` | 仅出席，不推断任务。 |
| negative-all-day-01 | negative | 公司节假日 | calendar_fact | 否 | `calendar_all_day` | 全天和节假日属性不是交付责任。 |
| negative-recurring-01 | negative | 每周提醒：查看周报 | calendar_fact | 否 | `calendar_recurring` | 重复属性和查看提示不足以证明交付。 |
| negative-subscription-01 | negative | 订阅日历：生日提醒 | calendar_fact | 否 | `calendar_subscription` | 订阅日历和生日默认只保留事实。 |
| negative-meeting-01 | negative | 项目同步会议 | calendar_fact | 否 | `calendar_meeting_placeholder` | 会议占位不能单独推断 action item。 |
| positive-delivery-01 | positive | 提交活动复盘 | candidate_review | 是 | `candidate_explicit_delivery` | 主人责任：我负责；动作：提交；交付物/截止点：复盘报告、周五前。 |
| positive-prepare-01 | positive | 准备评审材料 | candidate_review | 是 | `candidate_prepare` | 明确主人动作和交付截止点，进入待确认候选。 |
| positive-minutes-01 | positive | 纪要 action item：确认埋点名单 | candidate_review | 是 | `candidate_minutes_action_item` | action item 来自纪要并带有主人责任和截止点。 |
| positive-message-01 | positive | 更新方案并回复 | candidate_review | 是 | `candidate_explicit_message` | 即使是可选参与者，正文已明确主人动作和交付截止点。 |
| boundary-ambiguous-01 | boundary | 评审准备 | owner_confirmation | 否 | `confirmation_missing_owner_or_delivery` | 有动作词但没有闭合主人责任和交付物/截止点，只提示确认。 |
| boundary-no-response-01 | boundary | 请确认谁来提交 | owner_confirmation | 否 | `confirmation_missing_owner` | 有交付但责任不明，不直接制造候选。 |
| boundary-meeting-without-minutes-01 | boundary | 产品评审 | owner_confirmation | 否 | `confirmation_meeting_without_source` | 会议占位和孤立动作词不足以形成候选。 |

## 后续实现输入/输出边界

- 最小日历 DTO：`event_key_for_dedupe`、`start_at`、`end_at`、`timezone`、`is_all_day`、`recurrence_or_series_key`、`calendar_kind`、`title_or_bounded_description`、`owner_role`、`owner_response`、`has_minutes_or_explicit_message_reference`
- 规范化输出：`route`、`source_retained`、`candidate_created`、`requires_owner_confirmation`、`explanation_code`、`evidence_fields`、`correction_scope`
- 禁止请求/暴露：full_attendee_directory、raw_user_ids、full_meeting_transcript、raw_calendar_payload、provider_or_model_prompt、source_deletion_as_filtering
- 生产行为：`not_changed_by_issue_85`
