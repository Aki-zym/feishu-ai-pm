---
id: ADR-0002-electron
title: Windows 桌面载体采用 Electron
status: deprecated
date: 2026-08-09
owner: 桌面负责人
scope: Windows M1 载体
evidence: []
supersedes: []
---

# ADR 0002-E：Windows 桌面载体采用 Electron

> 2026-08-25 起已废弃。当前产品入口是 Cindy 插件、`apps/server` 和 `apps/web`；本记录仅保留历史决策背景。

状态：已接受

日期：2026-08-09

## 决定

正式产品采用 Electron 43、electron-builder 和 NSIS 生成 Windows x64 安装包。现有 React 作为内嵌界面；Electron 主进程通过受限 preload IPC 调用本地 PM 服务、SQLite 与集成适配器，用户不需要安装 Node、启动后台或打开浏览器。

## 安全边界

- `nodeIntegration=false`、`contextIsolation=true`、`sandbox=true`、`webSecurity=true`。
- 页面使用受信 `app://` 协议加载，并阻止任意导航和新窗口。
- preload 只暴露 PM 请求、配置、目录选择和诊断导出等白名单能力，不暴露 `ipcRenderer`。
- 数据库放在 Electron `userData`；飞书与模型密钥使用 `safeStorage` 加密，明文不进入 renderer、日志或 Git。
- 关闭窗口默认隐藏到托盘；只有“完全退出”才关闭数据库和进程。

## 为什么不选 Tauri

当前 React、Fastify、TypeScript 和 Node `sqlite` 可以直接复用。Tauri 若保持同等能力，需要引入 Rust、Windows 编译工具和 Node sidecar，首版复杂度明显更高。未来只有在安装体积或资源占用成为真实问题后再重新评估。

## 分发边界

当前仅支持内部未签名安装包试用；正式分发仍受签名和升级验证约束。

## 重新评估条件

当 Windows 载体、签名、升级回退或跨平台目标发生变化时，另行评估桌面载体；本 ADR 不证明当前安装包已取得 L5。

首期使用未签名的 NSIS 安装包做内部测试。正式对外分发前必须补充 Authenticode 代码签名；自动更新在拥有受控 HTTPS 更新源和签名流程前保持关闭。
