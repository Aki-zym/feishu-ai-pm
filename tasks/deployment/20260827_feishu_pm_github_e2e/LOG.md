# LOG

## 2026-08-27

- 默认 main 干净 clone 已完成 `npm ci`、构建、插件打包、服务启动、health/readiness、Cindy Bearer API 和 Agent 测试。
- 当前工作树核心门禁：插件 36/36，Server 53/53，Web 13/13，Agent 5/5，docs:test 43/43，ci:policy:test 63/63。
- E2E 生命周期 5/5 通过。
- Playwright 全套当前有历史陈旧测试：恢复 skip 后执行得到 29 passed、30 failed、2 interrupted；失败集中在旧任务台字段、旧设置文案和旧 Feishu UI 合同，与本轮独立 TooManyTasks/Aily 改动无关。原有 skip 已恢复，inventory 仍会按既有策略报告这些历史 skip。
- 旧授权应用真实 `prepare-aily-app` 实跑确认：飞书 SDK 返回顶层 `tenant_access_token`；修复后继续到真实应用身份权限门禁，当前阻塞为缺少 `application:application:patch`。
- 旧授权服务已用修复后构建在 4311 启动，停止动作待发布前完成。
