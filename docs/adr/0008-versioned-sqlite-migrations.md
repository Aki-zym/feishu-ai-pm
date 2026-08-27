---
id: ADR-0008
title: 当前 SQLite 使用版本化迁移与可恢复升级
status: accepted
date: 2026-08-15
owner: 架构负责人 / 数据可靠性负责人
scope: M1 SQLite schema 迁移、备份、恢复与降级门禁
supersedes: []
---

# ADR 0008：当前 SQLite 使用版本化迁移与可恢复升级

## 状态

已接受，日期：2026-08-15。

## 问题

早期 M1 数据库在每次启动时通过表结构探测、`ALTER TABLE`、数据修补和局部重建追平当前形状，没有稳定 schema version、迁移账本、升级前备份或旧应用拒绝新 schema 的门禁。迁移中断或约束冲突可能留下难以判断的数据库状态，重复关系还曾按 `MAX(rowid)` 静默删除。

## 决定

- 当前 SQLite 使用从 v1 开始的不可变顺序迁移；每步记录唯一 version、name、SHA-256 checksum 和 applied time，并同步 `PRAGMA user_version`。v1 由单一通用解释器消费有序声明式 operation payload：schema SQL、历史加列、冲突查询、条件重建、`insert_select` copy mode、`abort` conflict mode、source/target columns、数据 SQL、索引/约束 SQL、canonical 重建、实例身份、最终验证和账本推进都在 payload 中；历史 canonical identity 也复用同一解释器，不维护按 operation ID 手工选择 SQL 的第二路径。payload 递归冻结并稳定序列化；version、name、SQL、copy/conflict mode、列映射或操作顺序变化都会改变 checksum，未知 operation 或最终验证未紧邻账本推进时拒绝。
- 本 ADR 的版本化迁移和受管备份合同仍适用于明确的服务端维护流程与合成测试；Electron 桌面不再用它自动打开或兼容已有用户库。桌面固定使用新的 `data/ai-pm-v1.sqlite`，只有该路径不存在时才初始化当前规范 schema；既有 `data/ai-pm.sqlite` 原样保留，只做存在性检测并显示固定提示，不读取、迁移、重命名、覆盖或删除。配置和加密凭证目录保持不变。服务端迁移仍对未知 schema、约束冲突和失败保持 fail-closed，并由单一解释器和受管 validator 保护。
- 待执行迁移、账本写入和版本推进在清晰事务中完成。失败时回滚并从升级前备份恢复；恢复失败或版本/账本不可信时拒绝启动。
- restore 与 retention 共用完整 managed-pair validator：主库、备份目录、备份和 manifest 的 realpath containment、普通单链接、实例 ID、严格文件名时间、版本、整库 hash、完整性、外键与完整 schema 任一不匹配都拒绝。retention 只按验证后的文件名时间和稳定 filename tie-break 排序，绝不使用 mtime/ctime；伪造、篡改、未知或链接 pair 保持不动。真实 Windows 文件锁和祖先 reparse 行为仍需 L5。
- 数据冲突不再由迁移静默选留、复用已有同 ID 行、改写或删除。候选仅能绑定本轮事务临时映射中成功新建的需求单元；生成 unit ID/key、来源/线程关系、共享来源候选、双 current 修订等冲突会使整个事务回滚，并从受管备份恢复相同内容和状态；后续纠错必须可审计。
- M1、系统主人单机试用及首个受控单用户试点继续使用 SQLite。只有产品进入多人、多设备或远程服务形态时，才触发 PostgreSQL 迁移评审；届时必须通过新的数据库 ADR 和独立实施工作确定迁移、回退与数据验证方案。
- M1 与首轮试点固定为 draft-only。该产品边界不由数据库形态放宽，任何系统主人以外的人能够看到的内容仍须主人确认。
- `main` 与 `integration` 只通过 PR 合入；数据库改动除常规审阅外还需独立复核，并由项目负责人最终批准。
- Electron bootstrap 在数据库身份或迁移失败时显示固定脱敏错误，清理核心并退出；不继续以部分功能运行，也不留下无窗口后台进程。该桌面错误路径只由合成单元合同覆盖，Windows 安装包仍需独立 L5 Smoke。

## 原因

SQLite 是 M1、主人单机试用和首个受控单用户试点的正式真源。为避免在无法证明的真实历史库形态上自动作出数据迁移决定，桌面采用“旧库保留、新库启动”的可逆边界；用户原文件不被读取或改变，当前规范 schema 在新文件中重新建立。服务端迁移合同继续用于明确维护流程和合成回归。PostgreSQL 只在多人、多设备或远程服务触发条件出现后另行评审。

## 未选择

- 继续依赖每次启动的无版本 add-column 修补：无法证明迁移顺序、完成状态或 downgrade 安全。
- 迁移失败后继续以只读或部分功能启动：当前服务层没有经过验证的全局只读模式，容易形成误写，因此 fail-closed。
- 在本 ADR 实施 PostgreSQL：当前只记录未来触发条件，具体架构、数据迁移和运行方案仍由 Issue #66 或后续 ADR 单独裁决。
- 自动兼容桌面真实历史库：本版本明确不承诺；旧数据库由系统主人另行导出、核验或迁移。

## 限制

- 当前自动证据仅为临时合成 SQLite 的 L2 测试和隔离桌面 Smoke；Windows 文件锁、磁盘空间、杀进程故障注入、已安装 EXE 的 N-1/N 升降级和真实历史库处理仍需 L5/L6。
- 当前恢复入口面向维护者，不等于用户数据导出、隐私硬删除、跨设备同步或完整灾备产品。

## 重新评估条件

- 新 schema 变化必须新增版本，不得修改已发布迁移的名称或 checksum。多人、多设备或远程服务任一触发条件出现时，应新增 ADR 评审 PostgreSQL，并明确取代或缩小本决定的适用范围。
