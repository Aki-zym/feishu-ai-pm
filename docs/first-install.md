# 第一次使用 TooManyTasks

这套流程直接使用 GitHub 仓库，不需要另外下载配置包。每次首次部署都会在你自己的飞书租户中创建一套企业自建应用和 Aily Agent，凭证只保存在你的电脑上。

把 GitHub 项目地址发给 Agent，并说：

```text
请按仓库里的 AGENT_INSTALL.md 安装 TooManyTasks。
使用我自己的飞书账号创建新的企业自建应用和新的 Aily Agent。
完成全部配置、授权、Cindy 插件安装和首次扫描验收。
不要配置开机自启，也不要让我手动填写 App ID、App Secret、Agent ID 或 Token。
```

Agent 会自动完成 clone、准备 Node.js 环境、安装依赖、构建并启动本机 TooManyTasks，在你自己的飞书后台创建应用和 Aily Agent。应用创建后，权限、OAuth 回调地址、版本发布和管理员授权申请由 CLI 自动完成；随后 Agent 保存本机凭证，打开用户授权页，安装 Cindy 插件，开启 20 分钟后台扫描，并执行一次首次扫描检查。

你通常只需要做四类平台动作：

1. 创建应用或 Aily Agent 的后台页面要求登录、二次验证或确认时完成当前页面动作；
2. 新建应用后，在权限管理中开启一次 `application:application:patch` 应用身份权限，这是 CLI 配置应用的前置权限；
3. 飞书用户授权页点击“允许/同意”；
4. Cindy 弹出插件安装安全确认时点击确认。

操作系统偶尔也会要求管理员密码、Touch ID 或安装安全确认。企业管理员通常由飞书自动审批权限；只有平台明确要求人工处理时，Agent 才会停在该平台动作处。你不需要把 App ID、App Secret、Agent ID、授权码或 Token 发给 Agent，也不需要进入设置页逐项填写。

首次完成后，日常只要在需要时对 Agent 说：

```text
启动 TooManyTasks
```

电脑重启后不会自动启动服务，本产品不配置开机自启。
