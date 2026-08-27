# TooManyTasks 本机服务

本目录提供 4310 本机 Fastify API、Cindy 插件入库边界、浏览器任务台 API 和 SQLite 任务库。当前产品路径分为三条：

- Cindy 插件通过 `GET /api/integrations/cindy/tasks` 读取任务快照，通过 `POST /api/integrations/cindy/intake` 提交来源与提案；服务端完成来源去重、窗口幂等、候选写入和任务版本 CAS。
- 独立服务通过官方 `@larksuiteoapi/node-sdk@1.73.0` 调用 Aily，管理用户 OAuth、refresh token、SSE 解析、扫描窗口和空窗口游标推进。
- 浏览器任务台使用候选、任务、日历、通知、纠错和设置接口；设置页管理 Aily 应用配置、用户授权、自动扫描开关、入库窗口游标、开发者 seed、后台重启和退出。
- SQLite 保存 source_event、candidate_request、task、cursor、候选来源边和运行状态，作为任务与候选的持久化真源。

服务端只监听 `127.0.0.1`。首次启动会在私有配置目录生成 `cindy-integration-token`，Cindy Worker 从同一路径读取；用户无需复制令牌。自定义目录统一使用 `TOOMANYTASKS_CONFIG_ROOT`，旧 `CONFIG_ROOT` 只作兼容。Cindy 集成接口要求该 Bearer，Aily 配置、OAuth、runtime 和开发者 seed 接口仅接受 loopback 请求；OAuth 回调固定为本机 `/oauth/aily/callback`。Aily App ID 和 Agent ID 由当前安装在设置页显式填写，源码不预填开发测试标识。

旧 Feishu 分类链、XD Feishu、飞书 MCP、ChatD、模拟消息路由和 Electron 入口均不参与当前扫描。Aily OAuth、TokenStore 和官方 SDK 全部属于独立 TooManyTasks；Cindy 只接收 Aily 派生摘要和本地任务判断结果。

开发验证：

```bash
npm run typecheck
npm test
npm run build
```
