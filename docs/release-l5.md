# Windows L5 发布门禁（Issue #62）

本门禁把“构建”和“可授权发布”分开：只有同一份 versioned manifest 同时绑定精确源码 commit/tree、base/head/merge-ref、GitHub Actions run/job/check、安装包 SHA-256/size/架构、Electron/Node/SQLite/config 兼容性、同一安装包的实际 Authenticode 状态、owner allowlist 中的证书 thumbprint、timestamp/证书链，以及完整 Windows Smoke evidence IDs 时，才可能将 `authorization` 设为 `true`。

当前提交的 [`release-manifest.json`](release-manifest.json) 是 fail-closed pending manifest：`authorization=false`、签名为 `NotSigned`、Smoke 尚未取得。它可以在普通 PR CI 中验证字段结构，但不能授权发布、GitHub Release 或最终包。

## 自动门禁

`.github/workflows/release-l5.yml` 在 Windows runner 上：

1. checkout exact event commit 并安装 Node 24 依赖；
2. 校验 pending/authorized manifest，并在启用 LFS 后核对 EXE、blockmap 与 latest.yml 的实际 hash/size/version；
3. 执行 synthetic N-1→N、保留数据重装、downgrade 拒绝、数据库/迁移/磁盘/文件锁/config/网络/auth/429/分页故障合同；
4. 在完整 server inventory 下使用受控的 30 秒单测超时并关闭文件级并行，避免 Windows runner 的调度抖动或 worker 更新饥饿把正常测试误判为失败；超时、失败、跳过和空 inventory 仍会 fail-closed；
5. 从 exact source 构建隔离 NSIS Smoke 包；
6. 执行安装、启动、第二实例、窗口关闭、托盘退出、完全退出、卸载和进程树清理；Smoke 必须为第二实例、窗口关闭、托盘退出和卸载分别记录 `executed`、退出码和 evidence ID，任一场景未执行、证据缺失、安装或卸载、临时目录和快捷方式清理失败都会失败；
7. 只有手动 release verification 才尝试 `--require-authorized`；授权校验必须由调用方提供 trusted exact provenance、实际 artifact inspection 和 owner thumbprint allowlist，无证书、签名、时间戳或有效证书链时保持拒绝。

Ubuntu CI、浏览器 Mock、合成 provider 和 artifact hash 不能冒充 Windows L5。浏览器证据合同固定为桌面 `1440x900`、Pixel 7/`320px`，Electron 窗口为 `980x680`；这些尺寸不会把 L4 证据提升为 L5/L6。

## 仍待完成

- 受授权的 Windows 代码签名证书、Authenticode thumbprint 和 RFC3339 timestamp；
- 使用同一签名包取得完整 Windows L5 Smoke evidence IDs；
- 对 N-1/N、回退和真实文件锁/reparse 行为的独立 Windows 验收；
- Lead 授权后才可更新正式 manifest、release 载体和 GitHub Release。

不连接真实飞书、LLM、生产数据库或生产数据；不提交证书、私钥、token、`win-unpacked/` 或调试文件。
