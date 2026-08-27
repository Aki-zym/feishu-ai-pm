# TooManyTasks Cindy 薄插件

本包只提供 Cindy 控制面，不包含 TooManyTasks 服务端、网页、Aily SDK 或任何飞书凭证。

## 运行边界

独立 TooManyTasks 必须先运行在本机回环地址，默认是 `http://127.0.0.1:4310`。它负责：

- Aily App Secret、用户 OAuth、access token、refresh token 和撤权。
- 官方 `@larksuiteoapi/node-sdk@1.73.0`、SSE 解析、扫描窗口和空窗口推进。
- SQLite、候选、任务、来源、幂等和 CAS。
- 首次启动时在私有配置目录生成 `cindy-integration-token`。

插件 Worker 从同一私有配置目录读取集成令牌，只允许访问 `/api/runtime/*` 和 `/api/integrations/cindy/*`。自定义目录时与服务端统一设置 `TOOMANYTASKS_CONFIG_ROOT`；旧 `CONFIG_ROOT` 仍可兼容。插件设置页不显示或保存 `pm_token`、Aily App Secret、用户 Token 或 Agent ID。服务未运行或尚未首次启动时，工具会提示先启动独立 TooManyTasks。

## 工具

- `scan_intake_window`：调用 `POST /api/integrations/cindy/scan`。服务端按持久窗口请求 Aily；返回非空派生摘要后，插件使用固定 `sessionKey: "intake"` 派发 errand。
- `get_pm_tasks`：读取 `GET /api/integrations/cindy/tasks` 的任务、候选和游标快照。
- `submit_intake`：提交 `POST /api/integrations/cindy/intake` 的窗口、受控来源和提案。
- `update_pm_progress`：主动模式使用独立 oneshot 模型维护当前会话进度；自动模式在轮次结束后后台评估。

入库 errand 只接收 `source_kind: "aily_summary"` 派生来源和窗口元数据，必须调用 `get_pm_tasks` 后再调用 `submit_intake`。它不得读取飞书、调用飞书工具、访问 `/api/tasks` 或再次调用 `scan_intake_window`。Aily 摘要保留 `agent_id`、`generated_at` 和窗口范围，完整性按 `limited` 处理，不能冒充逐条飞书原文。

Aily 返回 `NO_NEW_INFORMATION` 时，独立 TooManyTasks 提交显式空窗口并推进游标，不启动 Cindy。Aily 失败时不启动 Cindy、不推进游标；Cindy errand、服务端事务或成功回执失败时也不推进游标。服务端回执已经确认入库完成时，Cindy 最终文本只影响人读摘要，不能否决已完成事务。

## 配置

插件设置只包含：

- 本机 TooManyTasks 地址。
- 自动扫描开关。
- 任务进度维护开关和主动/自动模式。

「重启独立 TooManyTasks」调用本机 `POST /api/runtime/restart`。自动扫描由插件常驻 `setInterval` 每 10 分钟触发一次；开关判断和 Aily 调用由独立服务完成。Cindy 退出后不会继续触发定时扫描，但独立 TooManyTasks 仍可继续运行。

请停用旧 `ai-pm-progress` 包，避免两个插件同时写回同一任务。入库 errand 和进度 oneshot 在插件详情「AI 代办」中使用 `codex/gpt-5.6-luna`、思考强度 `high` 和权限 `auto`。

## 构建与验证

```bash
npm run test:plugin
npm run build:plugin
```

`build:plugin` 生成 `ai-pm-intake-0.6.0.cindy`，包内白名单只有：

```text
README.md
ghost.json
main.js
node/worker.cjs
settings.html
settings.js
skills/pm-progress-update/SKILL.md
```
