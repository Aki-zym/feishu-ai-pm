# TooManyTasks Agent 安装合同

本文件是安装 Agent 的强制执行说明。用户把本仓库 GitHub 地址交给 Agent 后，Agent 必须继续执行到“TooManyTasks 已启动、用户自己的 Aily 已授权、Cindy 插件已安装、首次扫描已验收”，不能只停在 clone、build 或打印操作建议。

## 固定边界

- 直接 clone 本仓库就是正式首次安装入口，不需要密封配置包、共享配置包、GitHub Secret、集中 OAuth 服务或维护者预置凭证。
- 每位用户都必须使用自己的飞书企业租户、自己的企业自建应用和自己的 Aily Agent。
- 禁止复用仓库维护者、其他用户或测试环境的 App ID、App Secret、Agent ID、用户 Token 和数据库。
- 禁止使用 XD Feishu、飞书 MCP、ChatD、Cindy OAuth 或共享凭证服务。
- 不配置开机自启。服务只由 Agent 在首次安装或用户之后说“启动 TooManyTasks”时启动。
- App Secret 只能在 Agent 当前进程内存中从用户自己已登录的飞书开放平台读取，再通过 stdin 传给 `configure-aily`。禁止写入命令行参数、shell 历史、普通文件、聊天消息、日志、GitHub 或最终汇报。
- OAuth 允许、企业管理员审批、飞书登录/二次验证和 Cindy 对插件包的安全确认属于平台强制动作。遇到这些动作时，Agent 只能请求用户完成该动作，不能要求用户手动填写配置字段。

## 用户首次只需知道

Agent 会自动 clone、安装依赖、构建、启动本机服务，在用户自己的飞书后台创建应用和 Aily Agent，随后由 CLI 配置应用权限、回调地址、发布版本并提交管理员授权申请，再打开用户 OAuth 授权页，安装 Cindy 插件，开启扫描并做一次真实检查。用户通常只需要在飞书要求时登录或点“允许/同意”，以及在 Cindy 要求时确认安装插件；用户不需要复制 App Secret、App ID、Agent ID 或 Token。

## 强制执行流程

### 1. 准备本机环境

Agent 先检查 Git、Node.js 24 或更高版本和 npm。缺少时由 Agent 使用当前系统可用的官方安装方式或包管理器完成安装，并再次验证版本。只有操作系统要求管理员密码、Touch ID 或安全确认时才请用户处理当前确认；不能把安装命令、版本选择或环境变量配置交回用户。

随后由 Agent 直接 clone 用户提供的 GitHub 仓库地址，进入仓库根目录，读取本文件、`AGENTS.md` 和 `docs/first-install.md`。禁止下载或寻找额外的密封配置包。

### 2. 构建和启动

执行：

```bash
npm run agent:install
```

该命令会执行 `npm ci`、`npm run build`、`npm run build:plugin`，启动独立 TooManyTasks，并等待 `http://127.0.0.1:4310/api/health` 就绪。若命令失败，读取 `.agent-runtime/server.log` 对应的脱敏错误后修复或明确阻塞原因，不能让用户手工启动 Node。

### 3. 在用户自己的飞书后台创建应用

使用 Agent 可用的浏览器控制能力打开飞书官方开放平台。若当前浏览器没有登录，提示用户在当前浏览器完成登录后继续。

官方当前没有公开的“从零创建开发者后台自建应用”接口，因此这一步仍使用飞书官方后台。应用创建和首次凭证读取必须在浏览器完成；后续大部分权限、回调地址、发布和管理员授权申请交给 CLI。由于飞书要求调用应用配置 API 的应用身份权限先行开通，必须在权限管理中手动开启 `application:application:patch`，这是一项配置权限的前置条件。

必须执行以下动作：

1. 创建一个新的“企业自建应用”，名称使用当前用户可识别的唯一名称，例如 `TooManyTasks - <当前用户>`。
2. 在权限管理中开启应用身份权限 `application:application:patch`。
3. 打开应用凭证页面，读取当前用户自己新建应用的 App ID 和 App Secret。Agent 只在内存中暂存，不能在对话中回显。

除上述应用身份前置权限外，Agent 不得把后台权限表单点击当作必需步骤；其余应用权限、OAuth 回调地址和版本发布由第 5 步的 CLI 完成。

如果页面出现已有应用，Agent 必须确认它是本次新建的用户自己的应用。发现共享应用、仓库示例应用或测试应用时停止并重新创建，不能顺手复用。

### 4. 创建并发布用户自己的 Aily Agent

从飞书官方入口进入 Aily/智能伙伴开发页面，创建新的开发型 Aily Agent，名称使用当前用户可识别的唯一名称，例如 `TooManyTasks - <当前用户>`。

必须执行以下动作：

1. 配置企业知识问答或当前租户可用的消息检索能力。
2. 让 Agent 能在当前用户授权范围内检索单聊和群聊消息，并要求它只总结指定时间窗口内的任务、需求、交付、跟进、阻塞和排期信息。
3. 开启 Aily Agent 的 OpenAPI/开放接入渠道。
4. 发布 Agent。
5. 读取本次新建 Agent 的 Agent ID。

页面名称随飞书版本变化时，按“创建开发型 Agent”“渠道管理/开放接入”“发布”这些语义定位，不要猜测旧 CSS selector。必须看到发布成功和 Agent ID 后才能继续。

### 5. 无交互写入本机配置

Agent 在内存中组装 JSON，并把它通过 stdin 传给脚本。不要使用 `--app-secret`，不要把 JSON 写入临时文件，不要使用会把正文打印到终端的 `echo` 或 `printf`：

```bash
node scripts/agent-runtime.mjs configure-aily
```

输入对象必须包含本次新建应用的 `appId`、`appSecret`、`agentId`、`domain`、本机 `oauthRedirectUri` 和上面的 `oauthScopes`。脚本只向用户报告配置已写入本机加密凭证库，不回显 Secret。

### 6. CLI 配置并申请企业应用权限

执行：

```bash
node scripts/agent-runtime.mjs prepare-aily-app
```

该命令使用官方 SDK 自动完成以下动作：

1. 获取短期 `tenant_access_token`；
2. 写入 Aily 所需用户权限；
3. 写入 `http://127.0.0.1:4310/oauth/aily/callback` 和 refresh token 配置；
4. 提交自建应用版本发布；
5. 调用飞书“向管理员申请授权”接口；
6. 查询当前租户的实际授权状态。

命令只返回 scope 数量、待授权 scope 名称、发布状态和申请状态，不回显企业 Token、App Secret 或完整飞书响应。命令提交申请后立即查询一次授权状态；管理员自动审批时返回 `status=ready`，仍在审批中的权限返回 `status=awaiting_admin_approval`，Agent 应在平台动作完成后重试。高敏权限若被平台要求超级管理员处理，Agent 只能提示当前管理员完成平台动作。

### 7. 完成用户 OAuth

1. 执行 `node scripts/agent-runtime.mjs oauth-url` 获取一次性授权地址。
2. 使用浏览器打开该地址。
3. 若飞书要求登录、二次验证或确认权限，请用户完成当前页面的登录或点击允许。
4. 执行 `node scripts/agent-runtime.mjs wait-oauth`，等待 `authStatus=connected`。
5. 如果缺少 `search:message` 或其他必需 scope，不能继续扫描。明确报告缺少的 scope，重新打开授权页；旧 refresh token 不会自动增加新权限。

Agent 不得要求用户把授权码、Token 或 Secret 复制到聊天中。

### 8. 安装 Cindy 插件

先执行 `node scripts/agent-runtime.mjs verify`，然后使用 Cindy 宿主提供的插件安装能力安装：

```text
<仓库绝对路径>/plugins/cindy-pm-intake/ai-pm-intake-0.7.0.cindy
```

Agent 必须等待宿主报告安装完成并确认 `ai-pm-intake` 已启用。若宿主支持直接安装 `.cindy`，调用该能力；若宿主只支持文件打开，使用宿主规定的打开方式交给 Cindy 接管。不能只把路径发给用户后宣称完成。

安装后：

- 停用旧的 `ai-pm-progress`，避免重复维护同一任务。
- 插件本机地址使用 `http://127.0.0.1:4310`。
- 入库 errand 使用 `codex/gpt-5.6-luna`、思考强度 `high`、权限 `auto`。
- 普通进度功能按用户默认保留主动模式；不得关闭 `update_pm_progress`。

### 9. 开启扫描和首次验收

执行：

```bash
node scripts/agent-runtime.mjs enable-scan
node scripts/agent-runtime.mjs verify
```

脚本会从 TooManyTasks 私有配置目录读取自动生成的本机集成令牌，不要求用户复制令牌。手动扫描会立即返回后台受理状态，不等待 20 分钟周期。Agent 必须等待 Aily 完成、摘要进入 inbox，并在 Cindy 插件的 5 分钟轮询后确认服务端 intake 回执。空窗口也算成功，但不能伪造新增任务数量。

最终汇报只包含运行状态、Aily 连接状态、已授权 scope 数量和缺失列表、Aily Agent 是否配置、Cindy 是否启用、自动扫描状态、首次扫描状态和新增/更新数量。禁止输出 App Secret、Token、授权码、完整 OAuth URL、完整 Aily 聊天正文或凭证文件内容。

## 后续命令

```bash
npm run agent:start
npm run agent:status
npm run agent:stop
npm run agent:update
```

`agent:update` 遇到未提交改动会 fail-closed，不执行 pull 或覆盖用户文件。
