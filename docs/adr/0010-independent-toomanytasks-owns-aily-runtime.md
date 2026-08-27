---
id: ADR-0010-independent-toomanytasks-owns-aily-runtime
title: 独立 TooManyTasks 拥有 OAuth 与 Aily 运行时
status: accepted
date: 2026-08-27
owner: 产品负责人 / 插件与后端负责人
scope: TooManyTasks 与 Cindy 插件运行边界
supersedes: []
evidence: [VER-AILY-SDK-ISOLATED-20260827]
---

# ADR 0010：独立 TooManyTasks 拥有 OAuth 与 Aily 运行时

## 背景

早期 `0.5.0` 把 Aily App Secret、用户访问 Token、官方 SDK、Fastify 服务和网页产物打进 Cindy 插件。安装后需要手工粘贴 Token，Cindy 生命周期也会决定本机任务台是否运行。这与 TooManyTasks 作为独立软件的边界冲突，并让 OAuth 自动刷新、撤权和安全存储很难形成完整闭环。

## 决定

1. `apps/server` 是独立 TooManyTasks 运行主体，负责 Aily 应用配置、用户 OAuth、TokenStore、refresh token、官方 SDK、SSE、扫描窗口、SQLite 和网页服务。
2. Aily App Secret、access token、refresh token、scope、过期时间和一次性 OAuth state 进入本机 AES-256-GCM 凭证库。配置目录使用 `0700`，密钥、密文和集成令牌使用 `0600`。
3. Aily App ID 和 Agent ID 由每个 TooManyTasks 安装在设置页显式配置；源码和示例配置不提供测试应用或测试 Agent 的默认标识。
4. TooManyTasks 首次启动自动生成 `cindy-integration-token`。Cindy Worker 从同一平台私有配置目录读取，不要求用户复制或手填。
5. Cindy 插件只保留 `pm/request` 与完成轮次读取能力。它不包含 Aily SDK、服务端 bundle、网页、菜单栏二进制或任何 secret binding。
6. 插件扫描固定调用 `POST /api/integrations/cindy/scan`，接口快速返回 accepted job。独立服务每 20 分钟自动扫描，非空摘要写入 SQLite inbox；插件每 5 分钟领取一条并派固定 intake errand。Cindy 继续通过 `get_pm_tasks` 和 `submit_intake` 完成最终本地任务判断。
7. Aily 配置、OAuth、断开和 runtime 接口只接受 loopback。OAuth 回调地址也必须是本机 HTTP 回环地址，路径固定为 `/oauth/aily/callback`。Cindy 接口额外要求自动生成的 Bearer。服务端继续只监听 `127.0.0.1`。
8. 插件 `0.7.0` 包只包含清单、主逻辑、薄 Worker、设置页和进度 skill。构建脚本对白名单外的 SDK、Server、Web 和二进制产物 fail-closed。

## 原因

该边界让 TooManyTasks 拥有完整的软件生命周期和授权生命周期。用户在任务台完成一次 OAuth 后，服务端可以长期保存 refresh token、自动续期并在撤权时清理本机凭证。Cindy 仍可通过自然语言触发扫描和执行 intake errand，同时不承担网络授权、密钥保管或本机服务托管职责。

## 限制

- Aily 扫描可以在 Cindy 退出时继续运行；Cindy intake 判断仍依赖插件常驻。插件关闭期间的摘要会在本机 inbox 积压，重新启动后按顺序处理。
- 自定义配置目录时，TooManyTasks 与 Cindy Worker 统一读取 `TOOMANYTASKS_CONFIG_ROOT`；服务端继续兼容旧 `CONFIG_ROOT`，Worker 也保留同名回退。两个进程必须看到同一路径。
- 本地合成测试不证明真实飞书租户的 OAuth、refresh token 轮换、Aily Agent 可见范围、限流或撤权结果。
- Cindy 宿主当前没有稳定的 errand 工具白名单合同，插件仍依靠提示合同、API 白名单和服务端认证收紧能力。

## 重新评估条件

- Aily 扫描调度需要跨设备、远程服务或多进程 leader election。
- 产品变成多设备、远程服务或多人共享形态。
- 飞书 OAuth、Aily OpenAPI 或 refresh token 合同发生变化。
- Cindy 提供正式的本机应用连接、OAuth broker 或 errand 工具白名单。
