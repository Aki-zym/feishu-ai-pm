# 飞书 Agent CLI 适合个人工具层，不适合作为可靠 PM 后端

审计日期：2026-08-09  
审计对象：飞书官方 `larksuite/cli`，commit `7be247614d77dd90275d5b9c5353a1445cba128e`（2026-08-08）  
审计方式：只读源码审计；未安装、编译、运行 CLI，也未调用真实飞书 API

## 结论

原技术方向成立，但 Agent CLI 的定位需要收紧：

- 可以复用它的个人 OAuth、密钥保存、结构化命令、消息查询和 Sidecar 协议。
- 不能把它的事件总线当作可靠收件箱，也不能用它直接承担多人机器人或多租户后台。
- “别人直接私聊系统主人”的捕捉只能按用户身份周期查询，当前没有覆盖全部人际私聊的实时事件入口。
- 正式系统仍应使用 Channel/OpenAPI SDK 接入机器人和应用事件，并在第一跳写入自有耐久 `inbox`。

## 源码事实与产品含义

| 维度 | 源码事实 | 产品含义 |
|---|---|---|
| 用户授权 | 用户 token 会提前刷新，刷新过程有锁、并发代际检查和有限重试 | 单用户长期使用基础成熟，但首次授权和授权失效后仍需人工介入 |
| 密钥保存 | Windows 使用当前用户 DPAPI；Linux 使用本地 master key + AES-GCM | 适合个人机器；正式服务器仍需独立 Secret Manager 和账户隔离 |
| 身份模型 | 普通 profile 主要按 AppID、UserOpenID 和 profile 管理；登录会收敛为当前单用户 | 原生 CLI 不是多人账户池，也没有一等多租户领域模型 |
| 私聊读取 | 用户身份可以列出 P2P 会话、搜索消息和回查聊天历史 | 可以做周期扫描；需要重叠时间窗、`message_id` 幂等和定期全量对账 |
| 实时事件 | WebSocket Source 只使用 AppID/AppSecret 建立应用事件连接 | 机器人私聊和应用可见群消息可事件化；不能据此实时观察用户全部人际私聊 |
| 平台重投边界 | Handler 对异常体、缺字段和正常事件都返回 `nil`；正常事件只先推入内存链 | 根据事件回调语义推断，平台会认为回调已成功；之后的 Bus 丢失或业务失败不会触发平台重投 |
| 事件持久性 | Bus、Hub、去重表和连接缓冲都在内存中 | 进程退出后没有恢复点，不能成为需求真源 |
| 背压 | Bus 和 Consumer 缓冲满时都会丢弃最旧事件，只输出警告或序号缺口 | 即使进程在线也可能丢消息；必须另做查询补漏 |
| ACK 与重放 | 协议只有连接和关闭 ACK，没有事件级 ACK、offset、redelivery 或 replay | 无法证明事件已经被业务层可靠处理 |
| API 重试 | 通用 RetryTransport 默认 `MaxRetries=0`；多数错误只标记为 retryable | 上层必须自己实现退避、幂等和“结果未知”处理 |
| 分页 | 正常分页完整；第二页以后失败时可能停止并仍返回成功 | 退出码 0 不能证明全量结果完整，需要检查 `has_more`、游标和条数 |
| 风险控制 | 支持 dry-run 和 high-risk-write 的 `--yes` 门禁 | 对 Agent 友好，但依赖元数据正确；不能代替后台权限与审计 |
| Sidecar | wire protocol 是正式包；multi-tenant server 明确标记为 demo | 可以借鉴协议和拒绝回退原则，不能直接部署成正式多租户服务 |

## 对本产品入口的修正

### 1. 需求方私聊机器人

保持事件驱动。机器人收到消息后可以立即进入澄清流程；事件进入自有后台后，第一步必须写入耐久 `inbox`，再异步运行 LLM。

### 2. 需求方直接私聊系统主人

采用用户 OAuth 后的周期扫描，不使用 CLI 事件总线：

```text
列出最近活跃的 P2P 会话
  -> 按会话读取重叠时间窗内的新消息
  -> message_id 持久去重
  -> 更新每个会话的 last_seen
  -> 每日扩大窗口对账补漏
```

因此产品承诺应写成“发现候选后立即提醒”，不能承诺“对方发出消息后绝对实时发现”。真实延迟取决于扫描周期、权限、API 配额和失败补偿。

### 3. 指定需求群

- 机器人已在群内且应用拥有对应事件：事件驱动，并用查询接口对账。
- 机器人不在群内、只依赖用户身份：与个人私聊一样按周期查询，不能假设实时事件。

## 对技术选型的影响

### 保留

- 机器人入口：Channel SDK 或 OpenAPI SDK。
- 个人 Agent 工具：官方 Agent CLI，可作为可替换的查询/操作适配器。
- 可靠处理：PostgreSQL `inbox/job/outbox`。
- 原始来源与任务事实：自有最小领域层。

### 收紧

- 不使用 CLI Event Bus 作为正式需求入口或唯一监听器。
- 不把 `--page-all` 成功退出当作“已经读完全部消息”。
- 不依赖 CLI 默认完成 API 自动重试。
- 不直接采用官方 multi-tenant Sidecar demo。
- 不把用户 token 交给共享群机器人或多人 Agent。

## 主要源码证据

- [WebSocket 应用事件入口](https://github.com/larksuite/cli/blob/7be247614d77dd90275d5b9c5353a1445cba128e/internal/event/adapter/lark/websocket/feishu.go#L34-L65)
- [事件进入内存后 Handler 返回成功](https://github.com/larksuite/cli/blob/7be247614d77dd90275d5b9c5353a1445cba128e/internal/event/adapter/lark/websocket/feishu.go#L68-L116)
- [Bus 为内存对象](https://github.com/larksuite/cli/blob/7be247614d77dd90275d5b9c5353a1445cba128e/internal/event/bus/bus.go#L33-L77)
- [连接缓冲固定为 100](https://github.com/larksuite/cli/blob/7be247614d77dd90275d5b9c5353a1445cba128e/internal/event/bus/conn.go#L18-L58)
- [背压时丢弃最旧事件](https://github.com/larksuite/cli/blob/7be247614d77dd90275d5b9c5353a1445cba128e/internal/event/bus/conn.go#L178-L210)
- [Consumer 第二层同样丢旧](https://github.com/larksuite/cli/blob/7be247614d77dd90275d5b9c5353a1445cba128e/internal/event/consume/loop.go#L101-L128)
- [去重只保留内存 5 分钟和 10000 条](https://github.com/larksuite/cli/blob/7be247614d77dd90275d5b9c5353a1445cba128e/internal/event/dedup.go#L11-L34)
- [用户身份列出 P2P 会话](https://github.com/larksuite/cli/blob/7be247614d77dd90275d5b9c5353a1445cba128e/shortcuts/im/im_chat_list.go#L47-L100)
- [跨会话搜索消息](https://github.com/larksuite/cli/blob/7be247614d77dd90275d5b9c5353a1445cba128e/shortcuts/im/im_messages_search.go#L20-L54)
- [默认不执行通用自动重试](https://github.com/larksuite/cli/blob/7be247614d77dd90275d5b9c5353a1445cba128e/internal/cmdutil/transport.go#L20-L72)
- [分页后续页失败后停止](https://github.com/larksuite/cli/blob/7be247614d77dd90275d5b9c5353a1445cba128e/internal/client/client.go#L376-L460)
- [multi-tenant Sidecar 明确为 demo](https://github.com/larksuite/cli/blob/7be247614d77dd90275d5b9c5353a1445cba128e/sidecar/server-multi-tenant-demo/README.md#L1-L28)
- [官方私人助手安全警告](https://github.com/larksuite/cli/blob/7be247614d77dd90275d5b9c5353a1445cba128e/README.md#L280-L286)

## 待实施项目验证

1. 普通企业是否批准用户身份读取 P2P 与群消息所需权限。
2. 周期扫描能否在实际 API 额度内达到可接受延迟。
3. 消息搜索和会话历史在删除、撤回、离群、权限撤销后的真实表现。
4. 第二页失败、重复游标、断网和 token 失效时，补漏是否完整且不重复建单。
5. 是否接受“自然私聊近实时发现、机器人入口即时发现”的体验差异。
