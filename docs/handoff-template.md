# AI Worker handoff 模板

复制本文件到被忽略的 `.handoff/current.md`，每次交接覆盖前先保存上一份有用记录。当前 handoff 只用于本地恢复，不是 GitHub、CI 或产品完成证明。

```powershell
New-Item -ItemType Directory -Force .handoff | Out-Null
Copy-Item docs/handoff-template.md .handoff/current.md
```

## 1. 目标与范围

- Issue / PR：
- 用户可见结果：
- 本次包含：
- 明确不包含：
- 产品主人确认状态与时间：

## 2. 现场恢复

- Worktree（仓库内相对标识）：
- Branch：
- Commit（behavior/source、docs/evidence 如有多个分别写）：
- `git status --short --branch`：
- Dirty paths（没有写 `clean`）：
- 可恢复副本 / patch / backup ref：
- 共享工作区是否保持未触碰：

## 3. 必读材料

- [ ] `README.md`
- [ ] `docs/current-state.md`
- [ ] `docs/project-map.md`
- [ ] `docs/README.md`
- [ ] 对应 Issue 和依赖 PR
- [ ] 受影响的稳定合同、ADR、QA 或安全文档：

## 4. 依赖、base 与合并顺序

- Dependencies：
- Base branch / exact base SHA：
- Dependency PR / branch / exact head SHA：
- Temporary stacked base（如有）：
- Merge order：
- Parent 前进时的处理：普通 merge / no rebase / no force-push
- Parent 合入后的 rebind 目标：`integration/m1-test-20260815`
- Rebind 后必须刷新：base/head/merge-ref/parents/tree/run/job 和 CI 结果

## 5. 证据与证据上限

- Changed paths（完整 base→HEAD）：
- `ci-plan` 选择：minimum L__；manual review：yes/no；claimAuthorized：yes/no
- Source / record / merge-ref / parents / tree：
- Run / job / environment / command：
- 已取得层级：L__；证据状态：
- Skip 分类：`none` / `capability` / `platform` / `not_executed`
- Evidence ceiling（L0-L6；明确不能证明什么）：
  - [ ] 不把 Mock、契约、浏览器或合成数据写成真实飞书/LLM/生产证据
  - [ ] 不把构建产物 hash 写成 Windows 安装 Smoke
  - [ ] 不把 L4 写成 L5/L6

## 6. 测试清单

### 已运行

| 命令/场景 | 结果 | 时间 | 证据位置 |
|---|---|---|---|
|  |  |  |  |

### 未运行

| 命令/场景 | `not_executed` 原因 | 后续负责人 |
|---|---|---|
|  |  |  |

任何应运行但没有运行的测试必须写 `not_executed`，不能写成 passed；平台能力缺失要区分 `capability` 或 `platform`。

## 7. 未决事项、风险与回退

- 未决产品决定及负责人：
- 已知风险 / 冲突：
- 回退方式（保留原始来源和审计）：
- 不得做的外部动作：

## 8. 下一步

- 当前阻塞：
- 下一位负责人：
- 明确下一动作：
- 交接时间：

不得写入密钥、令牌、聊天原文、生产数据、日志、个人绝对路径或未经验证的完成声明。
