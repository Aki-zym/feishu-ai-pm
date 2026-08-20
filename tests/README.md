# 测试

- `apps/server/tests`：本地闭环与安全边界单元/接口测试。
- `apps/web/src/*.test.ts`：界面基础逻辑测试。
- `apps/desktop/src/*.test.ts`：Electron 主进程/预加载层可独立验证的基础逻辑；不等于已安装 EXE Smoke。
- `tests/e2e`：桌面宽屏和 Pixel 7 的 L4 浏览器路径验证。两个 Playwright project 使用独立端口、内存数据库和任务记忆目录，每轮使用唯一临时根；run token 与 IPC shutdown 确认用于识别本轮服务和本方关闭，核心写流程不得因 viewport 共享状态而跳过。
- `tests/e2e/desktop-bridge.spec.ts`：只进入桌面 Chromium project 的 L4 本地 browser bridge Mock 合同，覆盖首次配置保留并规范化 DeepSeek Provider，以及安全模拟模式强制 `rule_mock`、关闭真实飞书与扫描；不属于 Electron L5。
- `tests/unit/expected-event-matcher.test.ts`：无浏览器依赖的 B3 纯 matcher 合同单测；fixture 与单测调用同一实现，10 条正常/负例由 `npm run test:e2e:matcher` 执行并纳入 `npm run check`。
- `apps/server/tests/e2e-server.ts`：仅供浏览器 E2E 使用的服务装配，显式注册模拟消息路由；正式服务端和 Electron 不包含该路由。
- `scripts/desktop-installer-smoke.mjs`：Windows 安装、启动、桌面桥接、快捷方式与卸载的 L5 隔离 Smoke；不属于浏览器 E2E。

浏览器 E2E 的前置数据必须由独立 seed 或测试内 API 明确建立，并先做强断言；不得用 `isVisible()` 条件把缺少前置数据变成通过。页面未处理异常和非白名单 `console.error` 会使测试失败；有意模拟的浏览器错误必须由单个测试 scope 同时绑定精确文本、请求方法、pathname、search、响应状态和预期次数。统一 matcher 分别统计并消费响应与错误，缺失、重复或不同接口复用同一错误文本都会失败；独立单测锁定这些合同，E2E fixture 不另写一套判断。首次失败保留 trace 与截图。`npm run test:e2e:lifecycle` 会验证正常 nonce/ACK 关闭、ready 后意外 code 0、ACK 前意外 code 0、端口冲突和注入启动失败，并逐场景断言不遗留运行目录。

CI 选择器和 workflow 合同也必须有提交内自测：纯文档只进入文档门禁；runtime、test/CI、web、desktop、release、混合和未知路径均 fail-closed 到完整门禁，runtime 重命名为 docs 也必须保留旧、新双路径并走完整门禁。Pull Request 必须验证 merge-ref 双亲，每个测试包至少发现并通过一条测试，完整 E2E 必须消费同一轮已经检查过的构建产物。当前 workflow 不上传失败 artifact、Playwright report、trace、screenshot 或日志；生命周期/E2E 包装器只保留有界内存观察状态并输出固定摘要。自动负例必须覆盖 chunk 边界、超大输出、凭证关键字、URL userinfo、绝对路径、二进制/控制字节和无效 UTF-8，并证明 raw canary 不进入 stdout/stderr 或磁盘。

测试数据全部为人工构造，不包含真实聊天、用户 ID、令牌或本地绝对路径。

