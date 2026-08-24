# 领域合同：术语、权威、状态机与错误结果

> Issue #64 的唯一细粒度事实源是 [domain-contracts.json](domain-contracts.json)。本页由 scripts/domain-contracts-check.mjs --write 生成；不得手写第二套状态、CAS、error/outcome 或终态事实。M1 当前为 SQLite、draft-only；#58 是独立 Draft/future dependency，不把 Mock/L4 升级为真实租户 L6。

## 统一术语与数据权威矩阵

| 术语 | 含义 | 权威源 | 派生/可重建物 | 禁止推断 |
|---|---|---|---|---|
| source_event | 当前授权来源状态；按 external_id 保存当前指针，编辑/撤回追加到 source_event_revision，不覆盖不可变历史；metadata_json.failure_inbox 只保存脱敏重试索引，不替代来源事实；失败记录必须与 owning source、原始 Runtime payload 和 job_source_link 的 source/revision 关系一致，且分类 Runtime job 必须拥有非空 owning source。 | external_source + sqlite_fact | describe、candidate、thread、task、failure inbox view、AI replay references | 不得把 current source_event 当作历史账本，也不得把 revision/content 复制到公共 DTO；关系失效或缺少 owning source 的失败记录不得进入 DTO 或动作写入 |
| candidate | 尚未被主人接受的需求卡。 | sqlite_fact.candidate_request/revision | UI 卡片、通知 | 不得自动当正式任务 |
| thread | 围绕一个需求的持续补充线。 | sqlite_fact.requirement_thread/revision | 线程视图 | closed 的 runtime guard 未由本 checker 证明 |
| task | 主人接受后的私人正式任务。 | sqlite_fact.task/task_event | describe、memory_projection | 文件出现或聊天最终版不证明完成 |
| owner_decision | 主人消息经稳定身份核验后的内部决策记录。 | sqlite_fact.owner_decision + source_event | Runtime job、提醒 | 模型自称主人不构成授权 |
| job | Runtime 可恢复后台工作项。 | sqlite_fact.job + runtime_checkpoint | 日志、结果摘要 | 运行中不代表已完成 |
| approval | 主人对指定动作 payload 的本地草稿审阅记录。 | sqlite_fact.approval | outbox 草稿与安全 DTO | approval 不等于已批准、已发送或已执行 |
| outbox | M1 永久 draft-only 的本地动作草稿；ready/sent 仅为兼容 schema 保留值。 | sqlite_fact.outbox | 草稿状态 DTO 与审计 | 不得把未实现 adapter 写成当前能力 |
| projection | 从 SQLite 事实生成的任务记忆文件。 | sqlite_fact.memory_projection + controlled files | manifest、checksum | 失败不回滚事实、不写真实工作目录 |

权威层顺序固定为：external_source → sqlite_fact → describe → memory_projection → reference_activity。

## 对象状态、转移、CAS 与恢复（机器事实完整投影）

### source_event
- Current：SQLite stores the latest authorized source state keyed by external_id and points to an immutable source_event_revision row; enrichment, edit, withdrawal, or recall updates only the current projection and appends a revision in one transaction guarded by owner_scope and revision_generation CAS. Each revision hash covers source identity and all persisted replay fields; metadata_json.failure_inbox may carry a redacted retry index, but it is not source-content authority.
- Target：An append-only source_event_revision ledger preserves every authorized source observation while source_event.current_revision_id remains a controlled current pointer; ordered AI replay references include each canonical revision hash and legacy decisions without reconstructable inputs remain explicitly unreplayable.
- Gap：Public DTOs and diagnostics must not expose revision content; privacy export, retention, deletion and backup/restore must include revisions and AI replay references. Real Feishu edit/recall, provider history and production-owner scope remain unverified.
- Authority：sqlite_fact.source_event current row plus provider source
- Evidence scope：current=code_path_review；target=manual_contract_only
- Binding：kind=sqlite_table, table=source_event, column=external_id
- Actor：authorized_source_ingest_service
- States：current

| from | to | actor | guard | scope | evidence_scope |
|---|---|---|---|---|---|
| current | current | authorized_source_ingest_service | external_id match or new authorized source; update is scoped to the latest row | current | code_path_review |

- Terminal current：none
- Terminal target：none
- Terminal gap：no append-only history means no immutable terminal source revision
- CAS：external_id UNIQUE + owner_scope/revision_generation CAS + source_event_revision(source_event_id, revision_number/revision_hash) + ordered revision_set_hash
- Recovery：re-capture or provider refresh appends an idempotent revision; AI replay resolves the stored revision IDs, recomputes canonical hashes in constant time, and refuses missing/tampered/foreign/legacy-unreplayable references

### candidate
- Current：Classifier/service may move an unaccepted candidate to ignored; the same SQLite transaction appends an immutable candidate_ignored correction fact for delayed owner-decision retirement; ignored candidates can be restored by owner action. DATA-03 schema v4 adds candidate_request.version with an exact candidate CAS for every candidate mutation; merged groups also carry a deterministic member-version hash. Group delete/restore reads one snapshot and updates every member with its exact version, root relation binding, and accepted_task_id NULL predicate; every UPDATE must change exactly one row before the group's notification archive is applied.
- Target：Only the owner or stable-owner-identity-checked owner_decision service may ignore; ignored is lifecycle terminal.
- Gap：Current classifier path can directly ignore and ignored is recoverable; target owner-only terminal semantics are not implemented in this PR.
- Authority：sqlite_fact.candidate_request + candidate_revision
- Evidence scope：current=code_path_review；target=manual_contract_only
- Binding：kind=typescript_type, name=CandidateState
- Actor：owner_or_stable_owner_identity_checked_owner_decision_service
- States：pending, snoozed, ignored, accepted

| from | to | actor | guard | scope | evidence_scope |
|---|---|---|---|---|---|
| pending | snoozed | owner | candidate is active and not accepted/deleted | current | code_path_review |
| snoozed | pending | owner | snooze time reached or owner resumes | current | code_path_review |
| pending | ignored | classifier_or_service | current classifier path may ignore an unaccepted candidate; append correction/audit | current | code_path_review |
| pending | ignored | owner_or_owner_decision_service | stable owner identity verified; not accepted; append correction/audit | target | manual_contract_only |
| pending | accepted | owner | thread snapshot and candidate revision still match; create task atomically | current | code_path_review |
| snoozed | accepted | owner | same as pending→accepted | current | code_path_review |

- Terminal current：none
- Terminal target：ignored
- Terminal gap：accepted is task-linked and ignored is currently recoverable
- CAS：candidate_request.version + candidate revision/source revision + transaction; accepted_task_id NULL predicate; merged groups require deterministic member-version hash; delete/restore fences each snapshot member by id, root relation, accepted_task_id NULL, version and changes=1 before archiving notifications
- Recovery：ignored remains auditable; accepted can only be corrected through task/correction flow; soft-delete/restore is separate record-state operation

### thread
- Current：Thread statuses are open, needs_confirmation, and closed; service may close an unassigned thread.
- Target：Ambiguous threads require owner confirmation and closed is terminal for the thread lifecycle.
- Gap：Service guard behavior is only reviewed statically here; runtime transition enforcement is not proven by this checker.
- Authority：sqlite_fact.requirement_thread + requirement_thread_revision
- Evidence scope：current=code_path_review；target=manual_contract_only
- Binding：kind=typescript_type, name=RequirementThreadStatus
- Actor：service_after_owner_or_classifier_signal
- States：open, needs_confirmation, closed

| from | to | actor | guard | scope | evidence_scope |
|---|---|---|---|---|---|
| open | needs_confirmation | service | association, date, split, or ownership is ambiguous | current | code_path_review |
| needs_confirmation | open | owner | owner selects a valid proposal with matching snapshot | current | code_path_review |
| open | closed | owner_or_service | no active task and explicit rejection/closure | current | code_path_review |
| needs_confirmation | closed | owner | owner rejects/archives the unresolved thread and no active task | current | code_path_review |

- Terminal current：none
- Terminal target：closed
- Terminal gap：runtime guard enforcement is not proven by static checker
- CAS：version + expected thread version + base_thread_version; stale proposed revisions become stale
- Recovery：closed thread is not reopened by a stale model result; owner creates/accepts a new revision or explicitly reopens through a future contract

### task
- Current：Task status is mutable by owner PATCH; archived can currently be restored by PATCH.
- Target：Archived is the lifecycle terminal; completed is business-complete and may later be archived.
- Gap：Current archived restoration conflicts with strict terminal semantics; this PR records the target without changing service behavior.
- Authority：sqlite_fact.task + task_event
- Evidence scope：current=code_path_review；target=manual_contract_only
- Binding：kind=typescript_type, name=TaskStatus
- Actor：owner_or_gated_internal_automation
- States：unplanned, planned, in_progress, waiting, review, completed, archived

| from | to | actor | guard | scope | evidence_scope |
|---|---|---|---|---|---|
| unplanned | planned | owner | private schedule is explicit or owner-confirmed | current | code_path_review |
| planned | in_progress | owner_or_gated_internal_automation | owner or explicit progress evidence | current | code_path_review |
| in_progress | waiting | owner_or_gated_internal_automation | waiting reason recorded | current | code_path_review |
| waiting | in_progress | owner | owner records resumed work | current | code_path_review |
| in_progress | review | owner_or_gated_internal_automation | review evidence recorded | current | code_path_review |
| review | completed | owner_or_gated_internal_automation | explicit completion evidence; never file activity alone | current | code_path_review |
| completed | archived | owner | owner archive | current | code_path_review |
| unplanned | archived | owner | owner archives without execution | current | code_path_review |

- Terminal current：none
- Terminal target：archived
- Terminal gap：archived is currently restorable through PATCH
- Business-complete：completed
- CAS：task.version in every write; task_update_proposal base_task_version; transaction
- Recovery：completed is business-complete but remains in the lifecycle until archived; owner correction appends a task_event under task.version CAS; soft-delete restore does not rewrite status

### owner_decision
- Current：Owner decision rows have a state CHECK in fresh schema DDL; legacy database migration enforcement is not proven.
- Target：Owner identity and source revision guards must gate application of owner decisions.
- Gap：Static DDL evidence does not prove existing databases were upgraded or service guards always hold.
- Authority：sqlite_fact.owner_decision + source_event
- Evidence scope：current=fresh_schema_ddl_check_only；target=manual_runtime_evidence
- Binding：kind=sqlite_check, table=owner_decision, column=state
- Actor：owner_identity_checked_service
- States：queued, running, applied, review, failed, stale, noop

| from | to | actor | guard | scope | evidence_scope |
|---|---|---|---|---|---|
| queued | running | owner_identity_checked_service | authorized owner source and lease acquired | current | code_path_review |
| failed | running | owner_identity_checked_service | retryable and owner/source snapshot still valid | current | code_path_review |
| running | applied | owner_identity_checked_service | confidence >= 0.90, target versions match, transaction succeeds | current | code_path_review |
| running | review | owner_identity_checked_service | ambiguous/low confidence or approval required | current | code_path_review |
| running | failed | owner_identity_checked_service | retryable processing error | current | code_path_review |
| queued | stale | owner_identity_checked_service | source revision or target snapshot changed | current | code_path_review |
| running | stale | owner_identity_checked_service | CAS/identity guard fails | current | code_path_review |
| queued | noop | owner_identity_checked_service | valid owner message produces no domain change | current | code_path_review |

- Terminal current：none
- Terminal target：applied, review, stale, noop
- Terminal gap：legacy owner_decision rows and service guard enforcement are not fully proven
- CAS：UNIQUE(source_event_id, source_revision) + target task/thread versions + runtime lease
- Recovery：failed may retry; review requires owner action; stale is preserved and never silently replayed

### job
- Current：Runtime persists reusable stage checkpoints beside the job and audit rows; every job-linked tool authorization requires the exact live lease before audit insertion, and job-linked allowed audits cannot finalize without an explicit or active in-memory lease fence. Retryable provider/tool failures carry typed metadata into durable per-job availability; explicit non-retryable optional-stage metadata is preserved through deferred classification and closes the job fail-closed even when a legacy adapter omitted metadata. The cross-runtime/restart provider cooldown store is durable in continuous schema v8 with an atomic provider-key deadline, so concurrent Runtime instances and process restarts share the same cooldown contract. M1 registers external.send with a code-owned forbidden policy, so approval never invokes its callback/provider or creates an external claim; cancelled jobs may still be manually retried to queued, and the job table has no status CHECK.
- Target：Cancelled is terminal unless an explicitly documented retry transition is selected; runtime lease recovery remains explicit.
- Gap：Current cancelled→queued retry prevents strict terminal semantics; RUN-01 adds durable checkpoint reuse, lease fencing, bounded renewal, timeout/shutdown abort and late-write rejection, but does not change that retry behavior.
- Authority：sqlite_fact.job + runtime_checkpoint
- Evidence scope：current=runtime_type_and_code_path_review；target=manual_contract_only
- Binding：kind=runtime_statuses_only, source_file=apps/server/src/runtime.ts, type_name=RuntimeJobStatus, db_constraint_proven=false
- Actor：runtime_worker_or_owner_cancel
- States：queued, running, waiting_approval, completed, failed, cancelled

| from | to | actor | guard | scope | evidence_scope |
|---|---|---|---|---|---|
| queued | running | runtime_worker | available_at reached; attempts/lease CAS | current | code_path_review |
| failed | running | runtime_worker | retryable and attempts < max_attempts | current | code_path_review |
| running | waiting_approval | runtime_worker | tool policy requires owner approval | current | code_path_review |
| waiting_approval | queued | runtime_worker | owner approves and cancel not requested | current | code_path_review |
| running | completed | runtime_worker | lease owner and lease still valid | current | code_path_review |
| running | failed | runtime_worker | error classified retryable/non-retryable | current | code_path_review |
| queued | cancelled | runtime_worker_or_owner_cancel | owner cancellation | current | code_path_review |
| running | cancelled | runtime_worker_or_owner_cancel | cancel request observed | current | code_path_review |
| cancelled | queued | owner | manual retry accepts cancelled job and resets attempts | current | code_path_review |
| cancelled | queued | owner | target contract would require an explicit retry exception to terminal semantics | target | manual_contract_only |

- Terminal current：completed
- Terminal target：completed, cancelled
- Terminal gap：cancelled currently has retry→queued; completed remains terminal in both current and target semantics
- CAS：attempts + lease_owner + locked_until + status predicate; idempotency_key
- Recovery：expired running lease returns to queued/failed according to retry policy; reusable checkpoints skip completed provider/tool stages; failed retries use typed per-job backoff; optional-stage retryable=false remains terminal through recovery; shared provider cooldown is read and extended atomically across Runtime instances and restarts; cancellation and late shutdown callbacks are not replayed

### approval
- Current：Approval 只表示本地草稿待主人审阅；public DTO 显示 draft/rejected/obsolete，payload 不出 DTO，当前没有确认后发送路径。数据库 approved 为兼容保留值，不能解释为当前可发送。
- Target：未来若另开真实发送 Issue，approval 仍必须与 dispatch 分离，并重新完成主人确认、权限和真实环境安全验收。
- Gap：旧库中 approved 的历史语义和真实发送能力不在 M1；本切片只验证 synthetic SQLite/service/API/UI，不证明 L5/L6。
- Authority：sqlite_fact.approval
- Evidence scope：current=fresh_schema_ddl_check_only；target=manual_contract_only
- Binding：kind=sqlite_check, table=approval, column=status
- Actor：owner
- States：awaiting_approval, approved, rejected

| from | to | actor | guard | scope | evidence_scope |
|---|---|---|---|---|---|
| awaiting_approval | rejected | owner_or_service | owner rejects, task/source becomes invalid, or a newer task-version draft replaces it | current | code_path_review |
| awaiting_approval | approved | owner | reserved only; unreachable in M1 draft-only runtime | target | manual_contract_only |

- Terminal current：rejected
- Terminal target：approved, rejected
- Terminal gap：approved remains schema-reserved; no current approval endpoint or external execution path
- CAS：task version + action type + canonical payload hash; status=awaiting_approval predicate; UNIQUE outbox.idempotency_key
- Recovery：rejected drafts remain audit facts; task restore never reopens them; a new task-version/payload request creates a new deterministic draft

### outbox
- Current：Outbox 只保存本地 draft；public DTO 不输出 payload/provider 字段，M1 没有 send mutation、consumer 或 provider 发送副作用。ready/sent 是 schema-reserved 兼容值。
- Target：真实发送必须另开 Issue，经主人明确确认、权限/隐私/诊断合同和真实环境安全验收后单独实现。
- Gap：旧库 ready/sent 兼容映射与 L5/L6 真实发送安全不属于本切片；当前仅验证 synthetic SQLite/service/API/UI。
- Authority：sqlite_fact.outbox
- Evidence scope：current=fresh_schema_ddl_check_only；target=manual_contract_only
- Binding：kind=sqlite_check, table=outbox, column=status
- Actor：owner_approval_then_external_adapter
- States：awaiting_approval, ready, sent, failed

| from | to | actor | guard | scope | evidence_scope |
|---|---|---|---|---|---|
| awaiting_approval | failed | owner_or_service | linked task/source is deleted, invalidated, or a newer draft replaces it; no provider call | current | code_path_review |
| awaiting_approval | ready | owner_approval_then_external_adapter | reserved only; unreachable in M1 draft-only runtime | target | manual_contract_only |
| ready | sent | external_adapter | future explicit-send Issue only; not an M1 behavior claim | target | manual_contract_only |

- Terminal current：failed
- Terminal target：sent
- Terminal gap：public state obsolete maps failed/ready/sent legacy rows; sent remains schema-reserved and is not produced by M1
- CAS：task version + action type + canonical payload hash; status predicate + UNIQUE(idempotency_key); approval foreign key
- Recovery：failed/obsolete drafts stay terminal and auditable; task restore never reopens them; only a new deterministic business request may create a new draft

### projection
- Current：Projection metadata is stored in SQLite and files are rebuilt as derived artifacts.
- Target：Projection failures remain retryable and never mutate SQLite truth or user files.
- Gap：Path/reparse checks are reviewed in code but not proven by this static checker.
- Authority：sqlite_fact.memory_projection metadata; files are derived
- Evidence scope：current=code_path_review；target=manual_runtime_evidence
- Binding：kind=typescript_type, name=MemoryProjectionState
- Actor：service_projection_worker
- States：pending, ready, error

| from | to | actor | guard | scope | evidence_scope |
|---|---|---|---|---|---|
| pending | ready | service_projection_worker | root/path/reparse checks pass and atomic replace succeeds | current | code_path_review |
| pending | error | service_projection_worker | validation, I/O, checksum, or boundary check fails | current | code_path_review |
| error | pending | service_projection_worker | owner requests rebuild or next retry | current | code_path_review |
| ready | pending | service_projection_worker | task facts change or rebuild requested | current | code_path_review |

- Terminal current：none
- Terminal target：none
- Terminal gap：projection is retryable and has no business terminal
- CAS：projection_version + manifest/checksum; atomic temp-file replacement
- Recovery：error never mutates SQLite truth or user files; retry rebuild preserves unknown files

## Hard rules

- 任何 guard 失败都保留来源和审计，不静默覆盖、不把错误降级成成功。
- SEC-02：所有 classifier adapter 与恢复 checkpoint 都是不可信边界；严格递归 schema、匿名来源/候选集合、主人身份、CAS/approval、置信度和文本 ID grammar 必须在服务端 post-adapter 重新校验，越界置信度不得被 clamp 成可信值，关联/归并非法时整体失效且不得触发业务写入；初始分类与 reprocess 只能把安全 projection 写入 Runtime result/checkpoint，sender name 进入 proposer/candidate/thread 及其公开关联视图前也必须经过同一 ID/凭证投影。
- Runtime 工具成功或失败的审计终结、checkpoint 与 external claim 必须在同一 SQLite 事务内以精确 job 状态、lease_owner、cancel_requested_at 和 locked_until 原子校验；租约失效、取消、过期或 owner 替换后的回调只能返回受控 lease-lost，不得写入 completed/failed 审计、checkpoint、外部 claim、job result 或业务状态。
- 任何 jobId 非 null 的 Runtime 工具授权、审计完成/失败、checkpoint 或 external claim 都必须携带同一 exact leaseOwner；缺失、空字符串、过期、取消或 owner 替换在写入前 fail-closed，只有 jobId 为 null 的 standalone tool path 可无 lease。
- Runtime lease assertion 是只读的精确状态检查；任何 checkpoint 插入都必须使用同一 job fence 的条件 INSERT，不能依赖会触发业务更新的无效 UPDATE 或先检查后写入的间隙。
- RUN-02 与 RUN-01 共用同一 lease/lifecycle 路径；过期 lease 接管必须在同一事务内终结旧 allowed tool_call。重试只接受受控 Retry-After 秒数或 HTTP-date，并统一使用指数退避、受控 jitter 和 provider cooldown；非法、过期、超大、权限或输入错误 fail-closed，不得循环或把 fallback/Mock 伪装成 provider 成功。
- Runtime 与 provider 的可重试失败必须通过 typed category、provider/tool cooldown key 和可选 Retry-After 传递；Runtime fail、executeTool 和 service recovery 不得从自由文本推断退避，429、retryable 5xx 与受控 transport failure 即使没有 Retry-After 也必须建立共享 cooldown，并在下一次 provider/tool 调用前等待；持久分类链必须用同一 metadata 写入 durable job.available_at/retryable，不能只在 provider 内部 sleep。
- LLM optional association stages are isolated from the core action, but an explicit typed retryable=false from ProviderHttpError/transport classification must survive stage aggregation, deferred results, checkpoints, Runtime fail and service recovery; missing metadata must never turn that terminal disposition back into queued/retryable. Mixed optional-stage failures remain retryable when any typed stage is retryable; otherwise the job fails closed without duplicate provider calls beyond the bounded max_attempts policy.
- 投影或文件活动不得写入 task.completed；文件变化不能证明任务完成。
- 所有跨对象写入必须在 SQLite 事务内完成，并使用对象声明的 CAS/租约规则。
- DATA-03 使用连续 schema v4 在 candidate_request.version 上提供候选修订 CAS；候选写入口必须在同一 SQLite 事务内校验 expectedVersion，组操作还必须校验成员版本集合 hash，线程/任务关系操作必须校验对应 thread/task version。缺失或非法 expectedVersion 返回 400，过期版本返回 409 和安全 current DTO；任何候选、线程、任务、审计、通知或关系写入失败都逐值回滚，不自动 winner、不自动重放。
- source_event→demand_unit→candidate/thread/task 的关系必须使用精确结构化列和受控外键；共享来源歧义保留原行并写入 durable data_integrity_gap，不得静默覆盖、删除或选 winner。
- Cindy trusted-source schema v9 固定先保存、后判断：save_request_id、稳定身份、provider revision、canonical payload、receipt 摘要和完整关系图在同一 SQLite transaction 内校验并写入；任一非法 client_ref、同 revision 异 hash、低 revision、无 revision 异内容、未知/跨账号/失效 receipt、重复关系或成环都整批零写入。Bearer 只负责 HTTP 鉴权；插件独立持久化稳定连接账号锚点和 receipt 密钥，Bearer 轮换不得改变旧 receipt、来源身份或保存/决策幂等，不同账号锚点继续 fail-closed。body 自报 owner/account 字段拒绝；submit_pm_decisions 只消费 current receipts，不重传 raw sources，生产 buildApp 不注册 raw-source intake 或 seed 路由。旧来源迁移为 legacy_read_only，v8→v9 失败阻止启动并保持完整 v8，只有重新读取形成新 current revision 后才能签发 receipt。
- FSH-03：机器人 WebSocket 回调必须先以 external_id 幂等写入 source_event 并取得 durable receipt，再允许 provider acknowledgement；dedupe identity 绑定 owner_scope、metadata.sourceScope、source_type 和 conversation_id，跨主人/入口/会话碰撞在任何 row 或 metadata mutation 前 fail-closed；兼容重复不得覆盖已提交的渠道 provenance。commit 失败、无效 receipt、foreign owner/source scope 或未授权群必须 fail-closed 并允许重投。重复、并发、乱序和提交后 Runtime job 创建前的重启窗口不得丢来源或重复建立来源；orphan recovery 只扫描明确 bot_supplement/primary 标记且没有未完成分类工作的来源。
- DATA-04 replay 的服务层授权是强制 invariant：route 的 capability/intent/origin/CSRF 预检不能替代 durable current capability 校验；service 必须以 owner/decision/source scope、固定 intent、token/CSRF hash、expiry、revoked/consumed/replay 状态和原子 CAS 消费独立复核，missing/forged/expired/replayed capability fail-closed 且不得泄漏正文或产生业务写入。
- DATA-04 replay 必须由一个 canonical decision-scope 校验器贯穿 decision→ordered revision references→source events→demand unit→candidate/task/thread→owner lineage：每个 reference 的 source_event_id/revision_id 必须与实际行、精确 decision 和 revision hash 一致；decision.source_event_id（若声明）必须是有序引用集合中的 canonical primary source；demand_unit、candidate、task、thread、owner 关系必须来自同一来源摄取链。现有但不相干的 same-owner 或 foreign ID 不构成有效绑定；合法多来源决策必须保留完整有序集合。所有 scope/integrity 检查必须在 capability consumption 前完成，错绑、缺失、重复、乱序、篡改或跨主人时 fail-closed，返回有界脱敏错误，不产生业务/审计写入，也不消耗合法 capability。
- DATA-04 使用连续 schema v7（PRIV-001 已占用 v6）建立 append-only source_event_revision 与 current_revision_id 指针；v1-v6 migration descriptor、identity、checksum 与行为保持连续。canonical revision hash 覆盖 owner scope、source_event_id 与所有持久化回放字段，迁移 backfill 从已存 payload 计算真实 hash，绝不使用零占位；source append/current-pointer publication 与依赖 decision reference 写入在同一 SQLite transaction 内以 revision_generation CAS/fencing 完成。AI decision/job 必须持久化含 revision hashes 的有序 revision set 及 revision_set_hash/prompt_hash/model_config_hash；无法还原原始输入的 legacy decision 明确标记 unreplayable，禁止伪造 hash。回放仅解析已引用 revision，逐行 constant-time 校验 canonical hash、source_event_id、owner scope、顺序与授权能力；缺失、篡改、删除、重复/乱序、foreign reference、CAS/FK/迁移/隐私删除失败均 fail-closed 并保持逐值零写入。PRIV-001 的导出、留存、硬删除、备份/恢复必须覆盖 revision 与 replay reference，删除后不得保留可重建正文副本。证据仅限 synthetic SQLite/Mock/local browser L2-L4，不证明真实 Feishu edit/recall、真实 LLM 或生产数据。
- data_integrity_gap 只能在关系已验证精确修复后按 record_table+record_id+reason 精确关闭，并核对 gap 的 source_event_id、task_id、demand_unit_id 与已修复关系一致；最终 UPDATE 还必须以选中的 gap.id 和 NULL-safe demand_unit_id 作为结构化 fence；与固定私有 correction_event 同事务、幂等绑定；失败、绑定不一致或回滚必须保持 gap open。
- audit-chain API 对 filters、sources、demand_units、candidates、threads、tasks、source_demand_units、thread_units、thread_sources、task_source_links、ai_decisions、owner_decisions、task_events、corrections、integrity_gaps 逐集合显式投影固定字段；只返回符合内部 ID grammar 的内部 ID/关系链接、固定枚举或状态代码、布尔/数值、hash、版本和时间。不合规 ID 映射为 unknown 或 null。禁止 source 原文、sender/discovery/reason/title/next_step/proposer 等用户文本、record_id、provider/model/prompt、任何 provider/raw JSON、task_event.summary、before_json/after_json 和自由 note；未知枚举映射为 unknown，未知自由文本永不回传。
- M1/首轮单用户试点只生成本地 approval/outbox 草稿，状态向用户显示为 draft/待主人审阅、rejected/已拒绝或 obsolete/已失效；不自动发送、不自动执行。数据库中的 approved/ready/sent 仅作旧数据兼容保留值，当前没有发送入口、consumer 或 provider 副作用。任务删除、候选撤销和来源失效必须在同一 SQLite 事务内终止关联 awaiting 草稿；重复生成按 task version + action + canonical payload hash 幂等，保留来源与审计。
- 健康诊断的 UI/API DTO 只暴露固定 allowlist 字段；integration_health.details_json 仅为内部存储，禁止进入 IntegrationHealthDto 或对外 API。
- OBS-01：Runtime job 的 trace_id 必须直接绑定 canonical operation envelope 的 trace_id；operation/request/trace/parent/span identity 在 job payload 中保持同一 envelope，缺失 envelope 时 trace_id 保持 NULL，不得回退为 jobId 或在下游生成无关 trace。健康 readiness 对 freshness、backoff、token 和 disk 等 required dependency 的 unknown/query failure 必须追加稳定 allowlisted reason，并 fail-closed 为 not_ready。
- Feishu OAuth scope 必须区分 omitted、set([]) 和 set(values)；refresh singleflight 与 config generation/CAS 保护旋转 token，事务中断恢复 last-known-good，不得以旧响应覆盖新配置。
- PRIV-001 在 DATA-03 v4 之后使用连续 schema v5，将隐私控制、导出、删除请求、受管备份和私有审计与用户数据图分离，并保留 v1-v4 migration identity/checksum；连续 schema v6 在不改写 v5 descriptor/checksum 的前提下增加跨进程 lifecycle claim/fencing、owner/capability/intent binding、版本 CAS、recovery 状态和 backup cleanup intent。停止采集/撤销授权、可选导出、二次确认硬删除必须由主人显式触发。硬删除只能枚举 taskMemoryRoot 下符合受控 path grammar 且通过 root containment、symlink/reparse fail-closed 的 task.json/brief.md/sources.md/updates 等内容和派生投影，先 stage/quarantine 再协调 SQLite transaction，任一 DB/FS/审计失败都恢复原文件并保持零部分业务写入，成功不留可重建正文副本，只保留无内容 proof/hash/count/time。backups 不存在按 count=0；存在时必须枚举全部文件/目录/sidecar，unknown SQLite、wal/shm、临时文件、目录或不成对文件一律 fail-closed。确认必须先在无外部副作用的 SQLite 读/CAS stage 中校验 request/token/hash/expiry/replay/status/expected-version、持久化 owner/capability/intent 绑定与当前能力完全一致，之后才允许 stopFeishu/provider revoke；stop/start/revoke/hard-delete 的 finalize/compensation 必须再次以同一 durable claim token/version CAS，旧 actor 不得覆盖新 actor。任何 commit、finalize、审计或 rollback/compensation 失败都不得吞错，必须保留可恢复 quarantine 或 durable recovery state（PRIVACY_DELETE_RECOVERY_REQUIRED、PRIVACY_DELETE_CLEANUP_PENDING、PRIVACY_DELETE_FINALIZE_COMMIT_PENDING），禁止静默缺文件或部分业务/审计写入。backup cleanup intent 在 manifest/sqlite 删除前绑定受管 artifact identity/path/hash，manifest 已删而 sqlite 删除失败时仍可枚举、验证、恢复。privacy request/confirm 必须复用 owner authorization、desktop capability 与 CSRF/origin gate，confirmation token 具有效期、单次消费和 owner/intent 绑定；服务端确认 hash 还绑定当前 owner 身份、固定删除 intent、deletion id 与持久化 capability binding，主人身份变化或不同有效能力/意图确认时拒绝，禁止本机进程自助 request+confirm。在线备份校验和恢复登记不替换打开中的 SQLite，实际恢复需要服务退出后的维护入口。真实 Feishu OAuth 撤权、平台备份残留、Windows L5/L6 和法律合规不由 synthetic 证据宣称。
- PROD-01 默认公开 DTO 使用严格 allowlist：候选列表与操作回执、任务列表/详情/工作台/日历/提醒、重新整理、纠错读写回执和主人信息不直接返回数据库行；默认只返回 task-scoped opaque source_scope 与受控展示字段，不返回 source content、来源稳定 ID、sender/外部 ID、provider/model/prompt、文档 URL/ID、reference_path、纠错 before/after/note 或 Runtime 原始错误。公开叙述字段只有在达到长度门槛的整段/近整段原文复制、NFKC/跨空白归一化后的原文复现、结构化 URL/路径/受控 ID/secret-like token 命中时才映射为固定安全说明；语义派生摘要可以保留共享业务词、短标题和常用短语，不用任意五字符或短 n-gram 重叠规则授权或拒绝。与来源无关的主人编辑可以正常显示。公开任务更新提案的 policy_version 只允许 private_task_auto_v1/unknown，policy_reason 固定为服务端策略说明。主人核验必须以 confirmed=true 且 scope 由服务端重新解析任务↔来源关系，最多返回有界递归脱敏片段，追加 source.verification.completed 私有审计并固定 external_action=none。
- PROD-01 默认公开 DTO 使用严格 allowlist：候选列表与操作回执、任务列表/详情/工作台/日历/提醒、重新整理、纠错读写回执和主人信息不直接返回数据库行；默认只返回 task-scoped opaque source_scope 与受控展示字段，不返回 source content、来源稳定 ID、sender/外部 ID、provider/model/prompt、文档 URL/ID、reference_path、纠错 before/after/note 或 Runtime 原始错误。公开叙述字段只有在达到长度门槛的整段/近整段原文复制、NFKC/跨空白归一化后的原文复现、结构化 Feishu/Docx token、URL/路径/受控 ID/secret-like token 命中时才映射为固定安全说明；语义派生摘要可以保留共享业务词、短标题和常用短语，不用任意五字符或短 n-gram 重叠规则授权或拒绝。与来源无关的主人编辑可以正常显示。公开任务更新提案的 policy_version 只允许 private_task_auto_v1/unknown，policy_reason 固定为服务端策略说明。主人核验必须以 confirmed=true 且 scope 由服务端重新解析任务↔来源关系，最多返回有界递归脱敏片段，追加 source.verification.completed 私有审计并固定 external_action=none。
- PROD-01 主人核验状态合同：本实现不执行实时 provider fetch，只核验本地保存快照；DTO 的 status 仅允许 local_snapshot_verified、local_snapshot_unavailable，并同时返回受控 reason、provider_status（unknown 或带时间的 last_known_*）、snapshot_captured_at 和 external_action=none。失败态不返回 excerpt，不创建 completed 审计或 outbox；核验状态判断、私有审计和响应组装在同一事务内完成，审计写入失败必须整体回滚并返回受控错误，不能把快照 metadata 解释成当前权限或撤回事实。

## External ID policy

Allowlist：source_event.external_id（purpose=业务来源去重/关联；storage=sqlite_fact；egress=不得默认进入诊断、API同步结果或原值展示；display_rule=不得公开日志、API原值或公开展示）；ai_decision_log.provider_request_id（purpose=受控 provider 请求诊断关联；storage=sqlite_fact；egress=仅在现有格式校验与脱敏规则允许的受控诊断场景展示，且不得携带 token/body/URL；display_rule=仅允许受控脱敏诊断展示；不得公开日志、API原值或公开展示）
Identity IDs default forbidden：user_id、tenant_id、message_id、calendar_id、open_id、union_id、chat_id、conversation_id、document_id
Forbidden payloads：token、request_body、response_body、url

## Error / outcome catalog

Current outcome：The integrated M1 observability contract exposes one fail-closed sync envelope across service/API/Web with operation_id, request_id, trace_id, parent/span linkage, timestamps, bounded aggregate/source outcomes, freshness and retry metadata. Health separates liveness from dependency readiness; LogsPage and diagnostic bundles expose only correlated, bounded, recursively redacted events and summaries. Malformed sources, contradictory aggregate/counts, unknown fields and uncontrolled readiness reasons remain invalid rather than being rendered.
Target outcome：success: requested operation completed；partial_success: some scoped sources completed and others were safely skipped/failed；skipped: guard intentionally prevented work; no provider call or cursor advance when scope is missing；failure: operation could not complete; source/audit/job remains for retry or review
Gap：Synthetic local validation covers the implemented UI/API/service contracts. Real Feishu/provider behavior, installed Electron/NSIS lifecycle, and production L5/L6 acceptance remain outside this candidate and require separate evidence.
Evidence scope：current=manual_runtime_evidence；target=manual_contract_only

| error_code | outcome | HTTP | 使用场景与恢复 |
|---|---|---:|---|
| INVALID_INPUT | failure | 400 | 修正字段/枚举后重试 |
| UNAUTHORIZED | skipped | 401 | 重新授权或确认主人身份 |
| SCOPE_MISSING | skipped | 403 | 不调用 provider、不推进游标，补齐 scope 后重试 |
| INVALID_SOURCE_RECEIPT | failure | 403 | 重新读取并保存当前同 owner 来源，使用新 receipt |
| NOT_FOUND | failure | 404 | 刷新事实对象 |
| CONFLICT | failure | 409 | 读取最新事实后按 CAS 重试 |
| STALE_REVISION | failure | 409 | 保留当前 generation，重新读取 provider 当前 revision |
| SOURCE_REVISION_AMBIGUOUS | failure | 409 | 重新读取带 modified_at 或 sequence 的来源，或转主人确认 |
| APPROVAL_REQUIRED | skipped | 409 | 停在主人确认并创建/查看 approval |
| RATE_LIMITED | failure | 429 | 仅在 Retry-After 通过严格解析时按 backoff+jitter/cooldown 重试；非法值 fail-closed |
| PROVIDER_UNAVAILABLE | failure | 502 | 保留 job/source 后重试 |
| VALIDATION_FAILED | failure | 422 | 重试或进入 review |
| PROJECTION_BOUNDARY | failure | 409 | 不触碰文件，修复授权后重建 |
| INTERNAL_ERROR | failure | 500 | 只记录脱敏摘要；保留来源/审计并进入重试或人工复核 |

## ADR 元数据与数据库裁决

ADR YAML 必需 keys：id、title、status、date、owner、scope、supersedes、evidence。正文必须包含：决定、限制、重新评估条件。canonical ID 使用 ^ADR-[0-9]{4}(?:-[a-z0-9-]+)?$。

ADR 0007 将 ADR 0001 的 PostgreSQL-before-PoC 条款收窄为 M1 SQLite、draft-only；PostgreSQL 只保留为 M1 之后的负责人裁决项。

## 证据边界

本合同 checker 属于 L0 文档与 L1 静态枚举/DDL/Runtime type 一致性；运行时四态/readiness、服务端受控 SQLite 迁移和 DATA-04 revision/replay 另有 L2-L3 合成证据；OBS-01 的 operation/request/trace/parent/span envelope 只在本地契约与合成跨层测试中证明连续性。桌面不会自动打开或迁移既有用户库，仍不证明全部 service guard、真实 provider、真实 Feishu edit/recall、Windows L5 或真实租户 L6。
