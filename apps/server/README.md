# TooManyTasks 本机服务

本目录提供 4310 本机 Fastify API、Cindy 插件入库边界、浏览器任务台 API 和 SQLite 任务库。当前产品路径分为三条：

- Cindy 插件通过 `GET /api/integrations/cindy/tasks` 读取任务快照，通过 `POST /api/integrations/cindy/intake` 提交来源与提案；服务端完成来源去重、窗口幂等、候选写入和任务版本 CAS。
- 浏览器任务台使用候选、任务、日历、通知、纠错和设置接口；设置页管理自动扫描开关、入库窗口游标、开发者 seed、后台重启和退出。
- SQLite 保存 source_event、candidate_request、task、cursor、候选来源边和运行状态，作为任务与候选的持久化真源。

服务端只监听 `127.0.0.1`。Cindy 集成接口要求 `Authorization: Bearer <CINDY_INTEGRATION_TOKEN>`；runtime 和开发者 seed 接口仅接受 loopback 请求。退出接口关闭当前 HTTP 服务，生产进程随后退出；重启接口关闭并重新监听同一端口，SQLite 连接保持打开。

旧 Feishu OAuth、LLM 分类器、轮询同步、模拟消息路由和 Electron 入口已从当前服务路径移除。Cindy 使用已授权的飞书 MCP 读取消息，插件将结果以提案提交给本机服务。

开发验证：

```bash
npm run typecheck
npm test
npm run build
```
