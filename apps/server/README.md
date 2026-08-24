# 飞书接入与任务后台

本目录是本地 Fastify API 和 PM 领域服务，负责 SQLite 事实库、受控人工补录、候选确认、任务详情、审批、真实适配器和集成状态。正式服务不注册开发模拟消息路由；模拟收件只存在于显式测试装配，用于内存 SQLite 的 Mock/契约验证。测试装配必须显式声明 `testOnly`，并由入口 fail-closed 校验 `test + sqlite :memory:`。

真实飞书和 OpenAI-compatible LLM 只有在桌面设置中填写配置并显式打开开关后才会请求外部服务；没有凭证时使用 rule mock。工作区适配器始终只读，PostgreSQL 仍不是 Windows 桌面版的运行依赖。

Cindy 插件通过浏览器本机后台分两步入库：先把最小来源事实原子保存到 SQLite，并取得服务端签发的 opaque `source_receipt`；再只用 receipts 提交结构化判断。owner scope 与连接账号锚点从 Bearer 认证上下文派生，请求 body 不能自报；正式任务更新继续执行版本 CAS。旧 Feishu/模型扫描入口已停止导出；`apps/server` 仅作为本机任务库服务核心和 Cindy intake 合同的共享实现。

主人消息主链使用 `feishu_monitor_target` 保存明确选择的人员和群。人员以对方 `open_id` 为配置真源，服务端内部解析既有 P2P `chat_id`；群聊只持久化真实 `@主人` 消息。每个目标有独立游标和错误状态，机器人补充群仍由单独配置控制。来源同步先检查用户 OAuth scope；缺少权限时安全跳过并保留游标，不重复请求会返回 400 的接口。

候选收件箱支持 `deleted=active|only|all`、软删除和恢复。删除只归档候选通知并保留来源、审计、需求线程和正式任务关联；回收站候选不能继续接受或重新整理。
