# 源码审计表明应自建轻量 PM 内核，并组合四个成熟项目的局部模式

记录日期：2026-08-09

状态：源码级借鉴调研收口

## 一句话结论

当前系统不适合直接 fork 任一现成 PM。推荐自建面向“自动记录与 PM 管理”的最小领域层，并分别借鉴 Plane 的候选收件、Vikunja 的查询视图与提醒、OpenProject 的不可覆盖时间线、Super Productivity 的个人工作台与归档恢复。

这些项目都没有完整表达我们的核心对象：飞书原始来源、谁向我提出、候选确认、低密度 `describe`、对外承诺、AI 纠错和只读 `reference path`。因此源码只作为设计证据，不直接变成系统底座。

## 审计范围与版本

本轮只读浅克隆官方仓库，固定提交后检查数据模型、服务、视图状态和前端详情结构；未安装依赖、未运行服务、未修改上游源码。

| 项目 | 固定提交 | 许可证 | 本轮主要用途 |
|---|---|---|---|
| Vikunja | `9403ed15264e414605c523b0c16ef28703e9915e` | AGPL-3.0 | 任务集合、Saved Filter、视图投影、提醒与关系 |
| Plane | `31853ab2b8b7810c59dc30d22e52c8f4b5a71a47` | AGPL-3.0-only | Intake、通知、活动时间线、Saved View、右侧详情 |
| Super Productivity | `204ac0ebfc6f89125c9b0dd83f7887135ffcca9a` | MIT | Today 工作台、Planner、详情状态、归档恢复 |
| OpenProject | `13a6ac07c764660f9383cd47310279a8b5f5c528` | GPL-3.0 | Journal、通知原因、个人提醒、Query、Split View |

本轮曾在工作区 `tmp/` 建立只读浅克隆，完成提交、许可证和关键路径核验后已移出当前仓库，避免干扰仓库检查器。长期证据固定为上表 commit 和下文源码路径，不依赖临时目录持续存在。

## 最值得吸收的八个源码模式

### 1. 候选需求与正式任务必须分层

Plane 的 `IntakeIssue` 单独维护 `Pending / Rejected / Snoozed / Accepted / Duplicate`，并记录重复目标、外部来源和外部 ID：

- `apps/api/plane/db/models/intake.py`
- `apps/api/plane/app/views/intake/base.py`

这证明“新发现的需求”不应直接进入普通任务列表。

我们的采用方式比 Plane 更严格：

```text
source_event
    -> candidate_request
        -> 接受后创建 task，并保留 candidate/source 链接
```

不直接把候选等同于正式任务，原因是飞书聊天可能被误判、重复识别、跨多段消息补充或重新关联。

### 2. 当前任务快照与不可覆盖时间线分开

OpenProject 以 `WorkPackage` 保存当前状态，以 `Journal` 保存逐版本变化。`Journal` 具有唯一版本约束、有效时间、变更原因和 `restricted` 可见性：

- `app/models/work_package.rb`
- `app/models/journal.rb`
- `db/migrate/tables/journals.rb`

Plane 也把 Issue 当前状态与 Activity/Comment 拆开：

- `apps/api/plane/db/models/issue.py`
- `apps/api/plane/app/views/issue/activity.py`

我们的任务正文只保存当前结论；范围、排期、风险、承诺、纠错和完成确认均追加为 `task_event`，不能通过覆盖正文抹掉历史。

### 3. 候选收件箱与任务通知必须是两个对象

Plane 的 Notification 单独维护已读、稍后提醒和归档时间；OpenProject 的 Notification 记录原因、接收者、触发者、资源和对应 Journal：

- `apps/api/plane/db/models/notification.py`
- `app/models/notification.rb`
- `db/migrate/tables/notifications.rb`

因此：

- 候选收件箱回答“这是不是一个新任务”；
- 通知入口回答“已有任务发生了什么”。

通知至少需要 `reason / task_id / task_event_id / recipient / read_at / snoozed_until / archived_at`，并按“用户＋事件＋原因”去重。

### 4. 今日、等待、风险等页面应当是查询，不是不同任务表

Vikunja 的 Saved Filter 保存任务集合条件；Plane 的 Issue View 保存筛选、排序、布局和字段；OpenProject 的 Query 保存 filters、columns、sort 和 group：

- `pkg/models/saved_filters.go`
- `pkg/models/task_collection.go`
- `apps/api/plane/db/models/view.py`
- `app/models/query.rb`

我们的“今日、待排期、进行中、等待他人、风险、逾期”都应查询同一份 `task` 真源。首版提供固定视图，确认真实需要后才允许用户自定义。

不采用 Vikunja 将 Saved Filter 映射成负数项目 ID 的兼容技巧；使用独立 `saved_view` 对象。

### 5. 工作台成员由任务事实派生，个人排序单独保存

Super Productivity 的 Today 不是普通标签：任务是否属于今天由 `dueDay` 等事实决定，Today 内只保存人工排序；Planner 也将日期成员和日期内排序分开：

- `src/app/features/tag/tag.const.ts`
- `src/app/features/work-context/store/work-context.selectors.ts`
- `src/app/features/planner/store/planner.reducer.ts`
- `src/app/features/planner/store/planner.selectors.ts`

我们的工作台同样不保存一份“今日任务副本”。系统根据排期、截止时间、状态和风险派生成员；用户拖动后的个人顺序另存，不修改任务事实。

### 6. 任务详情采用桌面侧栏、移动端完整页和按需加载

Plane 的 Peek 支持侧边、弹窗和全屏；OpenProject 的 Split View 保留列表上下文，并把 Overview、Activity、Files、Relations 等做成可扩展标签；Vikunja 的详情按需增加属性：

- `apps/web/core/components/issues/peek-overview/view.tsx`
- `frontend/src/app/features/work-packages/routing/wp-split-view/wp-split-view.component.ts`
- `frontend/src/app/features/work-packages/components/wp-tabs/services/wp-tabs/wp-tabs.service.ts`
- `frontend/src/views/tasks/TaskDetailView.vue`

我们的首屏固定只展示：

```text
describe / 谁向我提出 / 状态 / 排期 / 下一步 / 风险
```

原始聊天、会议、对外承诺、变更时间线和 `reference path` 延后加载；桌面用右侧详情单，移动端进入完整详情页。

### 7. 提醒是个人对象，支持绝对和相对时间

Vikunja 的 Task Reminder 支持绝对时间和相对开始/截止时间；OpenProject 的 Reminder 只对创建者本人和仍可见任务生效：

- `pkg/models/task_reminder.go`
- `app/models/reminder.rb`
- `db/migrate/tables/reminders.rb`

我们的提醒与正式对外交付日期分离。提醒可以自动生成和调整，但任何对外日期变化仍需用户确认。

### 8. 完成任务退出工作区，但不丢失记忆

Super Productivity 把近期归档和较老归档分层，并允许历史页面重新查看和恢复：

- `src/app/features/archive/archive.model.ts`
- `src/app/features/archive/util/sort-data-to-flush.ts`
- `src/app/features/history/history.component.ts`

首版无需立即做冷热存储，只需 `completed_at / archived_at`、默认只读、全文搜索和明确重新打开。数据规模出现压力后再采用冷热分层。

## 推荐的最小领域对象

```text
source_event             原始飞书聊天、会议、日历或人工补录
candidate_request        候选需求及接受、暂存、忽略、重复判断
task                     当前正式任务快照
task_source_link         任务与一个或多个原始来源的关系
task_event               不可覆盖的 PM 变化时间线
correction_event         AI 关联、角色或摘要纠错案例
notification             已有任务变化产生的私人提醒
reminder                 个人绝对或相对提醒
saved_view               对同一任务库的筛选、排序和布局
reference_binding        只读工作目录引用
approval / outbox        对外动作确认与可靠发送
```

### `task_event` 建议包含

- `event_type`：范围变化、排期草案、排期确认、状态变化、等待对象、风险、疑似交付、正式完成、纠错等；
- `actor_type / actor_id`：用户、AI、需求方或系统；
- `visibility`：私人、准备对外、已经对外；
- `source_event_id`：该判断来自哪段原始内容；
- `before / after`：必要的结构化差异；
- `occurred_at / recorded_at / version`：事实发生时间、系统记录时间和任务版本。

OpenProject 的 `lock_version` 也值得借鉴：即使系统不自动执行任务，用户、机器人和后台整理仍可能同时更新同一工单，需要乐观版本检查，避免最后写入者静默覆盖前一次修改。

## 四个项目的最终定位

| 项目 | 采用 | 不采用 |
|---|---|---|
| Plane | Intake 状态机、活动时间线、通知分离、Saved View、Peek | 完整多租户权限、Cycle/Module、复杂富筛选和整套前后端 |
| Vikunja | 任务集合、Saved View、相对提醒、少量关系、领域权限 | `Done bool`、负数伪项目、密集详情、内存事件总线 |
| OpenProject | Journal、通知原因、私人提醒、Query、Split View、乐观锁 | 巨型 WorkPackage、复杂工作流、自定义字段与企业权限体系 |
| Super Productivity | Today 派生视图、Planner、个人排序、历史恢复 | 单一 `isDone` 状态、本地执行型专注工具和时间追踪体系 |

## 可靠性与事件处理边界

Vikunja 的领域事件很适合解耦通知和 Webhook，但主事件总线仍是进程内机制。它不能替代我们此前确定的 PostgreSQL `inbox/job/outbox`。

推荐顺序仍是：

```text
飞书事件或周期扫描
    -> 耐久 inbox
    -> source_event / candidate / task / task_event 事务写入
    -> outbox
    -> 通知、飞书消息和页面刷新
```

这样即使 LLM、飞书发送或进程发生故障，原始来源和 PM 状态也不会丢失。

## 许可证裁决

- Plane 与 Vikunja 为 AGPL；OpenProject 为 GPL。可以学习其建模和交互模式，但未来若复制实质代码、修改后提供网络服务或分发，需要单独进行许可证与开源义务评估。
- Super Productivity 为 MIT，复用源码仍需保留版权和许可声明。
- 当前建议是“依据源码重新设计自己的轻量实现”，不复制上游代码，也不以这些项目为产品底座。

## 最终技术裁决

> 不 fork 成熟 PM，也不重新发明所有设计。自建最小任务与工作记忆真源，用 Plane 设计收件、Vikunja 设计视图与提醒、OpenProject 设计时间线与通知、Super Productivity 设计个人工作台和归档。

本结论仍只属于产品与工程设计输入，不授权在当前项目中编码、安装、部署或运行这些系统。
