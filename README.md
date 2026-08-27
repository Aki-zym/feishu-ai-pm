# TooManyTasks

事情来自飞书私聊、群聊、会议和正在干的活，背景和进度很容易散掉。TooManyTasks 把可能的需求收成候选卡片，你确认后进入个人任务台；后来的聊天和 Cindy 里干完的进展可以写回同一条任务。当前产品边界以 [当前状态](docs/current-state.md) 为准。

聊天原文不进首页和任务卡。它不帮你跑数，也不改工作文件。对外发出去的东西只出草稿，由你点头。

## 现在怎么跑

推荐把本仓库 GitHub 地址交给 Agent，并要求它执行 [Agent 安装合同](AGENT_INSTALL.md)。Agent 直接 clone 仓库，在当前用户自己的飞书租户中创建新的自建应用和新的 Aily Agent，完成本机环境准备、构建、启动、OAuth、Cindy 插件安装、自动扫描和首次验收。该流程不需要额外配置包；用户无需填写 App ID、App Secret、Agent ID 或 Token，也不配置开机自启。

手动开发路径仍是：启动独立 TooManyTasks，默认地址为 `http://127.0.0.1:4310`；在浏览器任务台完成 Aily OAuth；在 Cindy 安装 `plugins/cindy-pm-intake` 插件。完整的用户预期见 [第一次使用 TooManyTasks](docs/first-install.md)。

数据在本机 SQLite（默认 `~/Library/Application Support/ai-pm-intake/ai-pm.sqlite`）。TooManyTasks 独立运行，Cindy 退出不会关闭任务台；服务未运行时插件会明确提示先启动 TooManyTasks。

开发仓库里仍可用 `npm install` 后改网页和接口；给人用的路径是 Cindy 插件，不要再打 Windows EXE。

## 现在能做什么

- **工作台**：今天要确认的、要推进的、还在等别人的。
- **候选收件箱**：接受、暂存、忽略或移入回收站。
- **任务与回收站**：排期、归档、删除和恢复。
- **扫描入库**：独立 TooManyTasks 每 20 分钟管理窗口并调用 Aily，摘要先进入 SQLite staging inbox；Cindy 插件每 5 分钟领取一条，再交给固定 intake errand 判断。
- **进度写回**：Cindy 会话里干完的进展，可通过插件写回同一条任务；设置页没有单独的「自动维护」开关。

任务台和插件设置里可以打开自动扫描。开关打开后，独立 TooManyTasks 每 20 分钟调用 Aily，即使 Cindy 退出也会继续生成摘要；Cindy 开着时每 5 分钟最多处理一条待入库摘要。关闭开关只停止生成新摘要，已经进入 inbox 的摘要仍会继续处理。口头「扫近10分钟」会立即请求后台扫描，不受开关影响。日历、妙记不进每窗主扫描。入库模型请到 Cindy 插件详情「AI 代办」选折扣 `codex/gpt-5.6-luna`、思考 high、权限自动审核。

## 边界

- 只发现、记录、整理和规划任务，不执行数据分析或其他业务工作。
- 不自动回复飞书、不拉群、不替你宣布完成。
- 数据、Aily 凭证和聊天摘要留在本机 TooManyTasks；Cindy 插件不保存 App Secret、用户 Token 或本机集成令牌。Aily 摘要先作为 staging 数据保存在本机 inbox，Cindy 成功提交后才进入任务来源链，并明确标记为不能冒充逐条飞书原文的派生证据。

现行入口和使用方式见 [文档入口](docs/README.md) 与 [使用和验收指南](docs/user-guide.md)；令牌和删除规则见 [安全与隐私](docs/security_and_privacy.md)。协作见 [CONTRIBUTING](CONTRIBUTING.md)。
