# TooManyTasks 入库 Cindy 插件

插件提供三个工具：

- `scan_intake_window`：按当前时间向前取 10 分钟，使用固定 `sessionKey: "intake"` 派发 errand；可选 `trigger: "manual" | "schedule"`，缺省为 `manual`。
- `get_pm_tasks`：读取 `GET /api/integrations/cindy/tasks`。
- `submit_intake`：提交 `POST /api/integrations/cindy/intake` 的窗口、消息来源和提案。

errand 提示要求工作线程使用当前已授权的飞书 MCP 读取窗口消息，调用 `get_pm_tasks` 获取 `items`、`candidates`、`cursors`，按 `create_candidate`、`update_task`、`skip`、`needs_owner` 生成提案，再调用 `submit_intake`。短确认句、资料交接、排期确认和收口句优先更新已有任务或归并已有候选；窗口内证据不完整时不新建候选。errand 不直接调用 `/api/tasks`；`update_task` 由本机任务库服务按 `task_key` 和 `expected_version` 做 CAS 更新已有任务，`create_candidate` 只创建候选。消息正文按不可信数据处理。

长对话收口只针对本窗口出现的 chat/thread 回读：优先使用对应 `cursor` 作为 `im_read_messages` 的 `start_time`，最多回读 4 小时，禁止全局拉取所有会话。窗口没有消息时直接输出 `skipped empty_window`，不提交入库；扫描结果会返回 `proposals: [{ action, title }]` 短列表。

## 配置

启用插件后 Cindy 运行即拉起本机任务库并保持本机 `4310` 服务。任务台浏览器设置中可使用「退出后台进程」。Cindy 退出后后台服务停止。

在插件设置中保存本机任务库地址，默认值为 `http://127.0.0.1:4310`，并保存与本机任务库服务一致的 `pm_token`。设置页和 Node Worker 都校验本机 HTTP 回环地址，任务接口保持在 `/api/integrations/cindy/` 前缀下，自动扫描开关使用 `/api/runtime/auto-scan`。intake 会话保持只读，只授权飞书 MCP，不开 shell、工作区写入或飞书写接口。

入库 errand 和自动化扫描的配置请在插件详情「AI 代办」中手动保存为折扣路由 `codex/gpt-5.6-luna`、思考强度 `high`。插件详情「AI 代办」权限选「自动审核」(`auto`)，不要选只读 `plan` 或完全访问 `bypassPermissions`。请勿选择原价 `gpt-5.6-luna`。Cindy 草稿默认可能显示 `fable5`，首次使用时需改一次；插件不会静默修改 Cindy 的全局默认模型。

Node Worker 的 `pm/restart` 调用当前 `startPmServer` 句柄的 `restart()`，关闭并重新监听同一配置，不调度 `process.exit(0)`；设置页的 `POST /api/runtime/restart` 使用同一条运行时重启链路。`pm/stop` 和 `POST /api/runtime/shutdown` 继续关闭当前 worker 自有实例，并按运行环境处理进程退出。

## 自动扫描与重启

插件声明 `agent.schedule` 能力。设置页的「启用 10 分钟自动扫描」开关打开后，先 `PUT /api/runtime/auto-scan` 写入 `enabled: true`，再打开预填自动化面板；用户需要在面板中选择配置并亲手保存。预填间隔可能被主机抬到 30 分钟，用户可在面板中改回 10 分钟。关闭开关只停止本产品自动流程；Cindy 自动化条目可能仍在，到点会空跑短路。Cindy 必须保持运行，自动扫描才会触发。

自动化面板调用 `scan_intake_window({ trigger: "schedule" })`。插件在扫描前读取 `GET /api/runtime/auto-scan`；返回 `enabled: false` 时直接返回 `skipped auto_scan_disabled`，不会派发 errand。手动调用 `scan_intake_window({ trigger: "manual" })` 始终扫描。

设置页的「重启本机任务库」调用 `pm/restart` 并传 `scheduleExit: false`，运行时内部以无退出方式重启；任务台浏览器的「退出后台进程」继续保留。

## 验证

```bash
node --test main.test.mjs node/worker.test.mjs
```

本目录只保留源码和测试，不调用 `ghost_forge_pack`。
