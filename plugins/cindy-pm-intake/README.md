# TooManyTasks Cindy 薄插件

本包只提供 Cindy 控制面，不包含 TooManyTasks 服务端、网页、Aily SDK 或任何飞书凭证。

首次部署推荐把仓库 GitHub 地址交给 Agent，执行根目录 `AGENT_INSTALL.md`。Agent 会使用当前用户自己的飞书应用和 Aily Agent 完成独立服务、OAuth、插件和首次扫描配置；用户无需在插件设置页填写 App Secret、访问 Token 或 Agent ID。

## 运行边界

独立 TooManyTasks 必须先运行在本机回环地址，默认是 `http://127.0.0.1:4310`。它负责：

- Aily App Secret、用户 OAuth、access token、refresh token 和撤权。
- 官方 `@larksuiteoapi/node-sdk@1.73.0`、SSE 解析、20 分钟后台调度、扫描窗口和 SQLite 摘要 inbox。
- SQLite、候选、任务、来源、幂等和 CAS。
- 首次启动时在私有配置目录生成 `cindy-integration-token`。

插件 Worker 从同一私有配置目录读取集成令牌，只允许访问 `/api/runtime/*` 和 `/api/integrations/cindy/*`。自定义目录时与服务端统一设置 `TOOMANYTASKS_CONFIG_ROOT`；旧 `CONFIG_ROOT` 仍可兼容。插件设置页不显示或保存 `pm_token`、Aily App Secret、用户 Token 或 Agent ID。服务未运行或尚未首次启动时，工具会提示先启动独立 TooManyTasks。

## 工具

- `scan_intake_window`：调用 `POST /api/integrations/cindy/scan`，快速请求服务端开始一轮后台 Aily 扫描，不等待摘要完成。
- `get_pm_tasks`：读取 `GET /api/integrations/cindy/tasks` 的任务、候选和游标快照。
- `submit_intake`：提交 `POST /api/integrations/cindy/intake` 的窗口、受控来源和提案。
- `update_pm_progress`：主动模式使用独立 oneshot 模型维护当前会话进度；自动模式在轮次结束后后台评估。

独立 TooManyTasks 每 20 分钟调用 Aily，非空摘要先写入 SQLite `aily_summary_inbox`。插件每 5 分钟最多通过 `GET /api/integrations/cindy/summary-inbox/next` 领取一条 ready 摘要，再使用固定 `sessionKey: "intake"` 派发 errand。领取租约为 10 分钟；失败通过 retry API 进入 1、2、5、10、20 分钟退避，最多五次。

入库 errand 只接收 `source_kind: "aily_summary"` 派生来源和窗口元数据，必须调用 `get_pm_tasks` 后再调用 `submit_intake`。它不得读取飞书、调用飞书工具、访问 `/api/tasks` 或再次调用 `scan_intake_window`。Aily 摘要保留 `agent_id`、`generated_at` 和窗口范围，完整性按 `limited` 处理，不能冒充逐条飞书原文。claim token 只留在插件内存，由工具拦截层注入 `submit_intake`，不会进入 Prompt。

Aily 返回 `NO_NEW_INFORMATION` 时，独立 TooManyTasks 写入 completed 空窗审计并推进扫描游标，不启动 Cindy。Aily 失败时不推进扫描游标。非空摘要写入 inbox 后即推进扫描游标；Cindy errand、服务端事务或成功回执失败只让该摘要重试，不阻塞后续 Aily 窗口。服务端成功事务会原子标记 inbox completed，Cindy 最终文本不能替代或否决该回执。

## 配置

插件设置只包含：

- 本机 TooManyTasks 地址。
- 自动扫描开关。
- 任务进度维护开关和主动/自动模式。

「重启独立 TooManyTasks」调用本机 `POST /api/runtime/restart`。自动扫描由独立服务每 20 分钟触发；插件常驻轮询只负责每 5 分钟消费一条摘要。Cindy 退出后 Aily 扫描继续运行，摘要保留在本机 inbox，插件下次启动后按顺序处理。

请停用旧 `ai-pm-progress` 包，避免两个插件同时写回同一任务。入库 errand 和进度 oneshot 在插件详情「AI 代办」中使用 `codex/gpt-5.6-luna`、思考强度 `high` 和权限 `auto`。

## 构建与验证

```bash
npm run test:plugin
npm run build:plugin
```

`build:plugin` 生成 `ai-pm-intake-0.7.0.cindy`，包内白名单只有：

```text
README.md
ghost.json
main.js
node/worker.cjs
settings.html
settings.js
skills/pm-progress-update/SKILL.md
```
