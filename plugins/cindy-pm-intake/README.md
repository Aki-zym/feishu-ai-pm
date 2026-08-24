# TooManyTasks 入库 Cindy 插件

插件提供三个工具：

- `scan_intake_window`：按当前时间向前取 10 分钟，使用固定 `sessionKey: "intake"` 派发 errand。
- `get_pm_tasks`：读取 `GET /api/integrations/cindy/tasks`。
- `submit_intake`：提交 `POST /api/integrations/cindy/intake` 的窗口、消息来源和提案。

errand 提示要求工作线程使用当前已授权的飞书 MCP 读取窗口消息，读取任务快照，按 `create_candidate`、`update_task`、`skip`、`needs_owner` 生成提案，再调用 `submit_intake`。errand 不直接调用 `/api/tasks`；`update_task` 由本机任务库服务按 `task_key` 和 `expected_version` 做 CAS 更新已有任务，`create_candidate` 只创建候选。消息正文按不可信数据处理。

## 配置

启用插件后 Cindy 运行即拉起本机任务库并保持本机 `4310` 服务。任务台浏览器设置中可使用「退出后台进程」。Cindy 退出后后台服务停止。

在插件设置中保存本机任务库地址，默认值为 `http://127.0.0.1:4310`，并保存与本机任务库服务一致的 `pm_token`。设置页和 Node Worker 都校验本机 HTTP 回环地址，并把路径限制在 `/api/integrations/cindy/` 前缀下。intake 会话保持只读，只授权飞书 MCP，不开 shell、工作区写入或飞书写接口。

当前没有 10 分钟自动扫描：`ghost.json` 未配置 `agent.schedule`，`scan_intake_window` 需要手动调用；空窗口短路也尚未实现；Cindy 必须保持运行，插件才能拉起和维持本机任务库。

## 验证

```bash
node --test main.test.mjs node/worker.test.mjs
```

本目录只保留源码和测试，不调用 `ghost_forge_pack`。
