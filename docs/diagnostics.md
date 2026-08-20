# 日志与诊断数据字典

## 适用范围

本页描述运行日志、连接健康和用户主动导出的诊断包。它不改变来源正文、任务、候选或纠错审计的数据保留规则，也不授权新增采集。

隐私生命周期另有独立的主人确认边界：停止采集、撤销本地授权、个人数据导出和二次确认硬删除不通过普通日志清理完成。硬删除后的 `privacy_deletion` / `privacy_audit_event` 只保留不含内容的请求状态、计数、proof hash、时间和必要关联；删除证明不进入诊断包，也不包含 source content、provider payload、路径或原始异常。日志 retention 到期或“清理诊断日志”不会擦除该证明，也不会替代隐私硬删除。

Electron 外链拒绝不扩大本页的采集范围：renderer 预检、preload/main IPC、legacy window/navigation 拒绝和系统 opener 失败都只向当前页面返回固定 `reason`、稳定 `EXTERNAL_URL_...` `errorCode` 和说明，不把原 URL、query、fragment、文档 token 或原始异常写入 `app_log`、连接健康或诊断包。OBS-01 可将受控失败类别关联到本机 `operation_id/request_id/trace_id`，但不记录原始 URL、正文或异常；页面提示不能替代真实 Electron/安装 EXE 验证。

## 脱敏合同

- 当前版本：`redactionSchemaVersion: 1`。
- 隐私导出是主人主动选择的数据副本，不等同于脱敏诊断包；其 scope 和格式由 `/api/privacy/export` 的固定枚举约束。诊断包不携带完整聊天、provider 响应、删除 proof 内容或原始删除错误。
- 写入前：`app_log.summary/context_json` 与 `integration_health.message` 使用同一套脱敏；`details_json` 仅作为本机内部存储，不进入安全 API DTO。
- 读取前：日志 API、连接健康 API 和诊断导出再次脱敏，旧记录或旁路写入不能直接回显。
- 类型化 schema：文本和内部关联 ID 只接受限长、再次清洗的字符串，计数只接受有限数字，布尔状态只接受 boolean；字段名已知但类型错配时也返回占位符。只有固定 schema key 输出规范化受控名；凭证、正文、路径、外部 ID 和未知动态 key 改用当前对象内唯一的短编号，不输出原 key，也不生成可逆摘要。别名碰撞不会覆盖已有字段，`__proto__`、`constructor` 和 `prototype` 不作为输出 key。容器字段不自动授予数组元素保留 primitive 的权限。
- 安全遍历：普通对象只读取 own data descriptor；数组只限量读取 own index descriptor，不调用实例 `slice`、getter 或 `Symbol.species`；`Error.name/message/cause` 不执行 accessor；URL 使用受控 intrinsic，只把确认的 `http/https/file` 输出为 `<url>/<local-path>`。Proxy、revoked Proxy、accessor、异常 descriptor 和不支持对象均 fail-closed。
- 输出预算：单次调用共享全局节点/条目预算，所有动态 key 都替换为固定前缀加有界编号，固定 schema key 的最大长度由 schema 决定；因此 key 数量和 key 长度也受等价输出预算约束。耗尽后返回 `<max-entries>`，最终 JSON 不会因深层宽树或超长 hostile key 放大。普通对象的 own-key 发现和 key 分类扫描仍可能随输入属性数量与原 key 长度增长，因此这只是输出预算，不代表完整运行时成本有严格常数上界。
- fail-closed：未知字段无论字符串、数字、布尔还是对象都不保留原值；JSON 解析失败只返回 `malformed` 与 schema 版本，不返回原字符串。任何分类或遍历异常都返回安全占位符，不回退原值。

## 外部 ID 边界

- 领域库只在固定 allowlist 保存业务必需 ID：`source_event.external_id` 用于来源去重/关联；`ai_decision_log.provider_request_id` 用于受控 provider 请求诊断关联。
- `source_event.external_id` 不默认进入诊断、API 同步结果或原值展示。`provider_request_id` 只有在现有格式校验与脱敏规则允许的受控诊断场景展示，且不得带 token、请求/响应正文或 URL。
- `user_id`、`tenant_id`、`message_id`、`calendar_id`、`open_id`、`union_id`、`chat_id`、`conversation_id`、`document_id` 等身份类外部 ID 默认禁止进入诊断、API 结果和原值展示。

## 允许的诊断字段

| 区域 | 现有字段 | 说明 |
| --- | --- | --- |
| 运行日志 | `id/category/level/event_type/summary/context_json/details/created_at` | `summary` 为限长脱敏文字；`context_json/details` 只保留白名单诊断元数据，并支持 operation/trace/event 过滤。 |
| 连接健康 | `integration/status/message/latency_ms/checked_at` | `message` 在落库和读取时脱敏；内部 `details_json` 不进入安全 API DTO。 |
| 同步结果 | `operation_id/request_id/trace_id/parent_span_id/span_id/outcome/started_at/completed_at/duration_ms/sources/release` | 整体与来源只允许四态 outcome；来源含安全计数、耗时、稳定错误码、固定 reason、freshness、stale 和 next retry。 |
| 健康 | `liveness/readiness/dependencies/release/operation_id/request_id/trace_id/span_id` | liveness 表示进程可响应；readiness 区分 `ready/degraded/not_ready`，数据库、Runner、listener、token、freshness、backoff、queue、disk 各自只输出固定状态/code/details。 |
| 诊断包 | `diagnostic_bundle_version/generatedAt/operation_id/request_id/trace_id/health/readiness/release/counts/configuration/recentErrors/recentEvents/summaries/limits/privacy` | 所有事件、依赖和摘要都经过 SEC-01 递归脱敏、数量/长度上限和稳定 allowlist；不新增原文或供应商响应采集。 |
| 桌面外层 | `desktop.version/platform/packaged` | Electron 导出时追加，不包含安装路径。 |

日志上下文允许保留稳定错误码、HTTP 状态、阶段、分类、计数、布尔状态、耗时，以及内部任务/候选/Runtime 关联 ID。失败来源收件箱只允许 `source_type/occurred_at/stage/error_code/status/retryable/stale/attempts/max_attempts/job_status/next_retry_at` 等受控 DTO 字段；不返回 `content/external_id/conversation_id/source_url` 或 provider 原始响应。记录与 owning source、原始 Runtime payload、`job_source_link` 不一致时，列表静默省略，直接动作只返回固定脱敏 404/409，不返回关系中的原始 ID、状态或 provider payload，且不写入业务或 correction_event 审计。外部系统真实用户、群、会话、消息和租户 ID 不在允许范围。

PROD-01 的来源读取也遵循同一最小化边界：候选/任务默认 DTO 不包含正文、sender、外部 ID、provider/model/prompt、文档 URL/ID、参考路径或 Runtime `last_error` 原文；默认错误只返回固定状态提示。主人核验使用一次性语义的 task-scoped opaque `source_scope` 和严格 `{ confirmed: true }` 请求，服务端重新解析关系后最多返回 280 字脱敏 excerpt，并追加 `source.verification.completed` 私有审计。`external_action=none` 是固定合同，核验不会创建 outbox、发送消息或调用外部工具；这套合同目前只用 synthetic L1-L4 证据验证。

## 禁止内容与替换规则

| 内容 | 处理 |
| --- | --- |
| Authorization/Bearer、多值 Cookie/Set-Cookie、Token、Secret、密码、API key、PKCE verifier、授权码、私钥 | `<redacted>` |
| body、content、prompt、response、payload、transcript 等潜在正文 | `<redacted-body>` |
| `file://`、Windows 盘符路径、POSIX 绝对路径、UNC 路径 | `<local-path>` |
| 带 query/fragment 的 URL 或 URL 对象 | `<url>` |
| 真实外部 ID 键 | `<redacted>` |
| 未知字符串/对象、循环、超限结构、非法 JSON | 安全占位或 `malformed`，绝不回退原值 |

`summary`、`message` 和错误文字仍可保留不敏感的诊断说明，但会先执行凭证、URL、路径和正文模式清理并限长。

## 错误分类

同步结果使用固定 `error_code`：例如 `FEISHU_TOKEN_REFRESH_FAILED`、`FEISHU_RATE_LIMITED`、`FEISHU_SCOPE_REQUIRED`、`OBS_ADAPTER_UNAVAILABLE`、`OBS_INVALID_SOURCE_RESULT`、`FEISHU_SYNC_PARTIAL` 和 `FEISHU_SYNC_FAILED`。失败来源分类入口还使用 `MODEL_OUTPUT_INVALID`、`MODEL_TIMEOUT`、`MODEL_RATE_LIMITED`、`MODEL_REQUEST_FAILED` 和 `SOURCE_CLASSIFICATION_FAILED`；这些 code 只表达受控类别，不携带供应商正文。只有 Runner 入口不存在才使用 `OBS_ADAPTER_UNAVAILABLE`；入口已经调用后返回 `null/undefined`、矛盾 skipped/count/reason、非法计数或原型键 reason 时，固定为真实来源的 `OBS_INVALID_SOURCE_RESULT`。reason 映射不使用普通对象原型索引，最终 `error_code` 只能是 string 或 `null`。飞书已有受控分类优先于通用码；未知异常统一为 `OBS_INTERNAL_FAILURE`，不得把异常文字当 code 或 message 回传。没有稳定供应商错误码时只保留固定说明，不把响应正文落库。本切片不声称覆盖真实供应商的全部错误形状。

## 验证边界

自动测试只使用合成 canary，覆盖未知/超长/凭证类/外部 ID 类 hostile key、别名碰撞、prototype pollution、key 输出预算、类型错配、未知数组 primitive、数组 getter/slice/species、稀疏和超长数组、Error/URL accessor、危险 URL scheme、Proxy/revoked Proxy、递归对象、Bearer/Authorization、Windows/POSIX/UNC 路径、常见凭证键、正文、旧旁路记录，以及同步 success/partial/skipped/failure、混合/全部拒绝来源、单来源 `null/undefined`、矛盾 skipped/count/reason、原型键 reason、刷新失败码、数据库缺表/关闭/查询异常、ID/trace 传播、依赖 fault/readiness、结构化日志过滤、诊断包大小/事件上限、编译期 release identity、实际 desktop bundle 的 post-build 合同、API/日志/诊断 canary 非泄漏和设置页四态提示。没有连接真实飞书、真实 LLM 或生产数据；没有构建安装包。正式 bundle 的静态检查仍只是 L1-L2 构建合同，browser Mock 最高为 L4，不是 Electron/NSIS L5 或真实供应商 L6。
