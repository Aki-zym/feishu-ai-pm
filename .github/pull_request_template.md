## 用户结果

这次改动让用户看到或获得了什么？

## 关联 Issue

Refs #

## Stacked PR metadata

- Base branch / exact base SHA:
- Dependency PR / branch / exact head SHA (write `none` when independent):
- Merge order:
- After the parent merges: rebind base to `integration/m1-test-20260815`, refresh exact merge-ref provenance, and wait for fresh CI:
- If the parent moves before merge: merge the new parent branch normally; do not rebase or force-push:

## 产品边界

- [ ] 不会自动执行业务任务
- [ ] 对外可见动作仍需要系统主人确认
- [ ] 没有把文件活动直接当成正式完成

## 安全检查

- [ ] 未提交密钥、令牌、真实聊天、数据库或个人路径
- [ ] 权限和数据留存变化已更新文档

## 文档与试用入口

- [ ] `README.md` 已反映当前阶段和已实现/待验收边界
- [ ] 使用流程变化已更新 `docs/user-guide.md`，或已说明不适用
- [ ] 架构、飞书权限、安全边界或 ADR 已按影响更新，或已逐项说明不适用
- [ ] PR 描述列出本次实际修改的指导文档
- [ ] 如需用户试用：已重新生成并冒烟验证安装包，记录对应 commit、SHA-256 和 GitHub Release 发布状态

## 验证

说明运行了哪些检查，以及结果是什么。

- [ ] Handoff 已保存到 ignored `.handoff/current.md`，并列出未运行测试、证据上限和下一步

## 回退

如果上线后有问题，怎样恢复？
