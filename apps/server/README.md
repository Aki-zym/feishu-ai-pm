# 飞书接入与任务后台

本目录是本地 Fastify API 和 PM 领域服务，负责 SQLite 事实库、受控人工补录、候选确认、任务详情、审批、真实适配器和集成状态。正式服务不注册开发模拟消息路由；模拟收件只存在于显式测试装配，用于内存 SQLite 的 Mock/契约验证。测试装配必须显式声明 `testOnly`，并由入口 fail-closed 校验 `test + sqlite :memory:`。

真实飞书和 OpenAI-compatible LLM 只有在桌面设置中填写配置并显式打开开关后才会请求外部服务；没有凭证时使用 rule mock。工作区适配器始终只读，PostgreSQL 仍不是 Windows 桌面版的运行依赖。

Cindy 插件通过浏览器本机后台分两步入库：先把最小来源事实原子保存到 SQLite，并取得服务端签发的 opaque `source_receipt`；再只用 receipts 提交结构化判断。Bearer 只负责 HTTP 鉴权；稳定连接账号锚点与独立 receipt 密钥由插件首次启动时生成并保存，轮换 Bearer 不改变旧 receipt、来源身份或幂等记录。请求 body 不能自报 owner/account；sender/chat/thread 技术 ID 只生成 owner/account 隔离的内部引用。display name 经 NFC、控制字符/Bidi 去除和空白折叠后，按完整 grapheme 截到最多 80 个且不超过最严格下游的 160 UTF-16 单元；字符串化对象占位和 `ou_`/`oc_` 飞书技术 ID 固定回退“需求方”。reply/thread 只允许同账号、同 chat、兼容 thread 的当前 receipt 或同批引用；无关系上下文限 20 条/60 分钟且必须有明确主人证据，thread/reply 限 100 条/4 小时。正式任务更新继续执行版本 CAS。生产 `buildApp` 不注册 raw-source intake 或 seed 路由；旧 Feishu/模型扫描入口已停止导出。

主人消息主链使用 `feishu_monitor_target` 保存明确选择的人员和群。人员以对方 `open_id` 为配置真源，服务端内部解析既有 P2P `chat_id`；群聊只持久化真实 `@主人` 消息。每个目标有独立游标和错误状态，机器人补充群仍由单独配置控制。来源同步先检查用户 OAuth scope；缺少权限时安全跳过并保留游标，不重复请求会返回 400 的接口。

候选收件箱支持 `deleted=active|only|all`、软删除和恢复。删除只归档候选通知并保留来源、审计、需求线程和正式任务关联；回收站候选不能继续接受或重新整理。
