# TooManyTasks

事情来自飞书私聊、群聊、会议和正在干的活，背景和进度很容易散掉。TooManyTasks 把可能的需求收成候选卡片，你确认后进入个人任务台；后来的聊天和 Cindy 里干完的进展可以写回同一条任务。当前产品边界以 [当前状态](docs/current-state.md) 为准。

聊天原文不进首页和任务卡。它不帮你跑数，也不改工作文件。对外发出去的东西只出草稿，由你点头。

## 现在怎么跑

入口是 **独立 TooManyTasks + Cindy 薄插件 + 浏览器**，不需要安装包或 Electron。

1. 启动独立 TooManyTasks，默认地址为 `http://127.0.0.1:4310`。
2. 在任务台设置页保存 Aily 应用配置并点击「连接 Aily」。TooManyTasks 会在本机加密保存用户 OAuth Token，并使用 refresh token 自动续期。
3. 在 Cindy 安装并开启插件 **TooManyTasks 入库**（`plugins/cindy-pm-intake`）。
4. 对话里说「扫近10分钟」。插件只调用本机扫描 API；独立 TooManyTasks 使用官方 Aily SDK 生成摘要，随后 Cindy 结合本地任务快照完成入库判断。

数据在本机 SQLite（默认 `~/Library/Application Support/ai-pm-intake/ai-pm.sqlite`）。TooManyTasks 独立运行，Cindy 退出不会关闭任务台；服务未运行时插件会明确提示先启动 TooManyTasks。

开发仓库里仍可用 `npm install` 后改网页和接口；给人用的路径是 Cindy 插件，不要再打 Windows EXE。

## 现在能做什么

- **工作台**：今天要确认的、要推进的、还在等别人的。
- **候选收件箱**：接受、暂存、忽略或移入回收站。
- **任务与回收站**：排期、归档、删除和恢复。
- **扫描入库**：独立 TooManyTasks 管理窗口、OAuth、Token、官方 Aily SDK 和 SQLite；Cindy 插件只触发扫描，并把派生摘要交给固定 intake errand 判断。
- **进度写回**：Cindy 会话里干完的进展，可通过插件写回同一条任务；设置页没有单独的「自动维护」开关。

任务台和插件设置里可以打开「每 10 分钟自动扫描新任务」。Cindy 开着且开关打开时，插件自己每 10 分钟扫一次，不要去自动化面板里保存。关掉开关后不再自动入库。口头「扫近10分钟」不受开关影响。日历、妙记不进每窗主扫描。入库模型请到 Cindy 插件详情「AI 代办」选折扣 `codex/gpt-5.6-luna`、思考 high、权限自动审核。

## 边界

- 只发现、记录、整理和规划任务，不执行数据分析或其他业务工作。
- 不自动回复飞书、不拉群、不替你宣布完成。
- 数据、Aily 凭证和聊天摘要留在本机 TooManyTasks；Cindy 插件不保存 App Secret、用户 Token 或本机集成令牌。Aily 摘要明确标记为派生证据，不能冒充逐条飞书原文。

现行入口和使用方式见 [文档入口](docs/README.md) 与 [使用和验收指南](docs/user-guide.md)；令牌和删除规则见 [安全与隐私](docs/security_and_privacy.md)。协作见 [CONTRIBUTING](CONTRIBUTING.md)。
