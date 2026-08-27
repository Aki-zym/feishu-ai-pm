# LOG

## 2026-08-27

- 默认 main 干净 clone 已完成 `npm ci`、构建、插件打包、服务启动、health/readiness、Cindy Bearer API 和 Agent 测试。
- 当前工作树核心门禁：插件 36/36，Server 53/53，Web 13/13，Agent 5/5，docs:test 43/43，ci:policy:test 63/63。
- E2E 生命周期 5/5 通过。
- Playwright 全套当前有历史陈旧测试：恢复 skip 后执行得到 29 passed、30 failed、2 interrupted；失败集中在旧任务台字段、旧设置文案和旧 Feishu UI 合同，与本轮独立 TooManyTasks/Aily 改动无关。原有 skip 已恢复，inventory 仍会按既有策略报告这些历史 skip。
- 旧授权应用真实 `prepare-aily-app` 实跑确认：飞书 SDK 返回顶层 `tenant_access_token`；修复后继续到真实应用身份权限门禁，当前阻塞为缺少 `application:application:patch`。
- 旧授权服务已用修复后构建在 4311 启动，停止动作待发布前完成。

## 2026-08-27（发布前复测）

- 核心门禁再次通过：`npm run check`、`npm run typecheck`、`npm run docs:check`、`npm run docs:test`、`npm run ci:policy:test`、`npm run build`、`npm run build:plugin`、`npm run test:e2e:lifecycle`、`git diff --check`。
- 补齐任务详情的安全提示、正式任务纠错入口和任务来源纠错表单；修复任务详情异步响应竞态；开发者模拟入口保留 seed 缺失时的受控人工补录回退。相关桌面/移动端 6 项 Playwright 定向测试通过。
- 完整 Playwright 运行结果：51 passed、22 failed、18 skipped。22 个失败集中在旧版任务台/设置页/来源同步合同，包含已删除的持续更新面板、旧 10 分钟扫描文案、旧 Feishu 来源同步界面和旧 hash 路由；未发现本轮 Aily-only 新增流程失败。18 个静态跳过项继续由 inventory policy 拦截，未删除或放宽策略。

## 2026-08-27（GitHub main 新机复验）

- PR #33 合并提交：`b1058e4c7ce2cc76b9d919eee4388ac875e0fe69`；PR #34 修复 fingerprint 后合并提交：`59149263c07c30f4b53698d8dbd067175545ae8d`。
- 从 `main` 全新克隆目录 `/tmp/feishu-ai-pm-final-nQ2gzT`，执行 `npm ci` 和 `TOOMANYTASKS_CONFIG_ROOT=<新目录> PORT=4511 npm run agent:install`：构建、插件打包、服务启动、health/readiness 均通过，服务版本 `0.2.0`，插件包 `ai-pm-intake-0.7.0.cindy`。
- 新用户隔离验证通过：`agent:status` 显示 `pidFile`、`logFile` 均位于自定义配置根目录，Aily 未配置时明确显示 `appConfigured=false`、`agentConfigured=false`，无凭证泄漏。
- 新机 `npm run test:agent` 6/6、`npm run docs:check`、`npm run docs:test` 43/43 通过；自定义端口下若直接运行 Agent 测试会触发测试固定默认 4310 的断言，按默认端口合同重跑通过，不属于产品运行失败。
- 最终新机服务已执行 `npm run agent:stop` 停止，未保留测试服务进程。
