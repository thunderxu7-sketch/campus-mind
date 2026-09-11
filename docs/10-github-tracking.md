# GitHub 开发工作项

仓库：[thunderxu7-sketch/campus-mind](https://github.com/thunderxu7-sketch/campus-mind)（私有）。

48 个开发任务已分别建立 Issue，并按 6 个里程碑、P0/P1/P2 及 11 个子系统打标。Issue 用于协作跟踪；本地 `planning/backlog.json` 是状态事实源，`done` 仅表示合成参考实现和自动化证据完成，仍不代表真实试点验收。

本地事实源为 [backlog.json](../planning/backlog.json)，文字说明见[开发清单](07-task-breakdown.md)。后续变更应同时更新对应 Issue；本文件只记录初始映射，不会自动同步在线状态。

## 里程碑

| 阶段 | 在线入口 |
|---|---|
| M0 | [范围与专业治理](https://github.com/thunderxu7-sketch/campus-mind/milestone/1) |
| M1 | [安全基础](https://github.com/thunderxu7-sketch/campus-mind/milestone/2) |
| M2 | [测评与报告](https://github.com/thunderxu7-sketch/campus-mind/milestone/3) |
| M3 | [预警与支持闭环](https://github.com/thunderxu7-sketch/campus-mind/milestone/4) |
| M4 | [试点就绪与验收](https://github.com/thunderxu7-sketch/campus-mind/milestone/5) |
| M5 | [完整版本扩展](https://github.com/thunderxu7-sketch/campus-mind/milestone/6) |

## 开发任务

| ID | 工作项 | 阶段 | 优先级 |
|---|---|---|---|
| CM-001 | [#1 确认需求修订与首校试点边界](https://github.com/thunderxu7-sketch/campus-mind/issues/1) | M0 | P0 |
| CM-002 | [#2 建立首个测评方案的授权与适龄证据包](https://github.com/thunderxu7-sketch/campus-mind/issues/2) | M0 | P0 |
| CM-003 | [#3 审定名册依据、告知与数据生命周期](https://github.com/thunderxu7-sketch/campus-mind/issues/3) | M0 | P0 |
| CM-004 | [#4 制定危机承接、转介与人工结案协议](https://github.com/thunderxu7-sketch/campus-mind/issues/4) | M0 | P0 |
| CM-005 | [#5 确定架构、威胁模型及验收基线](https://github.com/thunderxu7-sketch/campus-mind/issues/5) | M0 | P0 |
| CM-006 | [#6 初始化单仓工程与合成环境 CI](https://github.com/thunderxu7-sketch/campus-mind/issues/6) | M1 | P0 |
| CM-007 | [#7 实现组织模型与数据库租户隔离](https://github.com/thunderxu7-sketch/campus-mind/issues/7) | M1 | P0 |
| CM-008 | [#8 实现具名认证、MFA 和会话撤销](https://github.com/thunderxu7-sketch/campus-mind/issues/8) | M1 | P0 |
| CM-009 | [#9 实现对象/字段/用途范围授权](https://github.com/thunderxu7-sketch/campus-mind/issues/9) | M1 | P0 |
| CM-010 | [#10 建立敏感访问审计与脱敏可观测性](https://github.com/thunderxu7-sketch/campus-mind/issues/10) | M1 | P0 |
| CM-011 | [#11 配置加密、私有文件与密钥边界](https://github.com/thunderxu7-sketch/campus-mind/issues/11) | M1 | P0 |
| CM-012 | [#12 实现名单导入预检与组织确认](https://github.com/thunderxu7-sketch/campus-mind/issues/12) | M1 | P0 |
| CM-013 | [#13 实现监护核验、知情参与及撤回](https://github.com/thunderxu7-sketch/campus-mind/issues/13) | M1 | P0 |
| CM-014 | [#14 实现量表与方案的不可变版本发布](https://github.com/thunderxu7-sketch/campus-mind/issues/14) | M2 | P0 |
| CM-015 | [#15 实现确定性计分与有效性校验包](https://github.com/thunderxu7-sketch/campus-mind/issues/15) | M2 | P0 |
| CM-016 | [#16 建立独立计分金标准与版本差分](https://github.com/thunderxu7-sketch/campus-mind/issues/16) | M2 | P0 |
| CM-017 | [#17 实现普查任务、名单快照与时间窗](https://github.com/thunderxu7-sketch/campus-mind/issues/17) | M2 | P0 |
| CM-018 | [#18 实现学年频次与必要复评审批](https://github.com/thunderxu7-sketch/campus-mind/issues/18) | M2 | P0 |
| CM-019 | [#19 实现学生任务入口与适龄答题界面](https://github.com/thunderxu7-sketch/campus-mind/issues/19) | M2 | P0 |
| CM-020 | [#20 实现服务端草稿保存、恢复与冲突反馈](https://github.com/thunderxu7-sketch/campus-mind/issues/20) | M2 | P0 |
| CM-021 | [#21 实现不可变提交与事务 Outbox](https://github.com/thunderxu7-sketch/campus-mind/issues/21) | M2 | P0 |
| CM-022 | [#22 实现异步计分、失败队列与历史回放](https://github.com/thunderxu7-sketch/campus-mind/issues/22) | M2 | P0 |
| CM-023 | [#23 实现报告审核、分级发布与撤回](https://github.com/thunderxu7-sketch/campus-mind/issues/23) | M2 | P0 |
| CM-024 | [#24 实现最小心理档案与个案级授权](https://github.com/thunderxu7-sketch/campus-mind/issues/24) | M2 | P0 |
| CM-025 | [#25 实现版本化风险线索规则](https://github.com/thunderxu7-sketch/campus-mind/issues/25) | M3 | P0 |
| CM-026 | [#26 实现独立加急投递与通知补偿](https://github.com/thunderxu7-sketch/campus-mind/issues/26) | M3 | P0 |
| CM-027 | [#27 实现专业复核与个案指派工作台](https://github.com/thunderxu7-sketch/campus-mind/issues/27) | M3 | P0 |
| CM-028 | [#28 实现接单确认、值班与超时升级](https://github.com/thunderxu7-sketch/campus-mind/issues/28) | M3 | P0 |
| CM-029 | [#29 实现支持计划、转介登记与随访](https://github.com/thunderxu7-sketch/campus-mind/issues/29) | M3 | P0 |
| CM-030 | [#30 实现独立人工结案审批与重开](https://github.com/thunderxu7-sketch/campus-mind/issues/30) | M3 | P0 |
| CM-031 | [#31 实现主动求助与安全支持入口](https://github.com/thunderxu7-sketch/campus-mind/issues/31) | M3 | P0 |
| CM-032 | [#32 演练线索全链路与故障接续](https://github.com/thunderxu7-sketch/campus-mind/issues/32) | M3 | P0 |
| CM-033 | [#33 定义普查完成与线索统计口径](https://github.com/thunderxu7-sketch/campus-mind/issues/33) | M4 | P1 |
| CM-034 | [#34 实现隐私保护的基础统计看板](https://github.com/thunderxu7-sketch/campus-mind/issues/34) | M4 | P1 |
| CM-035 | [#35 实现可撤销的审批导出与水印](https://github.com/thunderxu7-sketch/campus-mind/issues/35) | M4 | P1 |
| CM-036 | [#36 实现权利请求、保留到期与删除重放](https://github.com/thunderxu7-sketch/campus-mind/issues/36) | M4 | P0 |
| CM-037 | [#37 完成跨角色多终端端到端验收](https://github.com/thunderxu7-sketch/campus-mind/issues/37) | M4 | P0 |
| CM-038 | [#38 完成容量、备份恢复与降级演练](https://github.com/thunderxu7-sketch/campus-mind/issues/38) | M4 | P0 |
| CM-039 | [#39 完成安全与隐私上线评审](https://github.com/thunderxu7-sketch/campus-mind/issues/39) | M4 | P0 |
| CM-040 | [#40 完成校方受控试点准入验收](https://github.com/thunderxu7-sketch/campus-mind/issues/40) | M4 | P0 |
| CM-041 | [#41 建立咨询师资质审核与可预约排班](https://github.com/thunderxu7-sketch/campus-mind/issues/41) | M5 | P1 |
| CM-042 | [#42 实现预约、取消、改期与提醒](https://github.com/thunderxu7-sketch/campus-mind/issues/42) | M5 | P1 |
| CM-043 | [#43 实现心理教育内容审核与门户](https://github.com/thunderxu7-sketch/campus-mind/issues/43) | M5 | P1 |
| CM-044 | [#44 实现音视频、文件资源和安全发布](https://github.com/thunderxu7-sketch/campus-mind/issues/44) | M5 | P1 |
| CM-045 | [#45 实现受治理的自定义人员调查](https://github.com/thunderxu7-sketch/campus-mind/issues/45) | M5 | P2 |
| CM-046 | [#46 扩展量表目录与学段适用性](https://github.com/thunderxu7-sketch/campus-mind/issues/46) | M5 | P1 |
| CM-047 | [#47 开放受控的个体自选筛查入口](https://github.com/thunderxu7-sketch/campus-mind/issues/47) | M5 | P2 |
| CM-048 | [#48 评估并实现受控区域聚合与扩校](https://github.com/thunderxu7-sketch/campus-mind/issues/48) | M5 | P2 |
