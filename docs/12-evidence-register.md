# 试点证据登记表（模板）

本表把“代码已经具备”与“学校/专业/隐私责任人已经批准”分开。仓库只放合成验证和**去标识索引**，不放学生资料、量表原文、合同、联系方式或签署件。`engineering` 是本地/CI 可复现证据；`external` 必须由责任人把批准文件放在学校认可的私有位置后填写引用。

## 1. 证据状态

| 状态 | 含义 |
|---|---|
| `verified` | 已在指定环境完成，记录命令、版本、时间和结果 |
| `failed` | 检查失败，必须有修复或阻断结论 |
| `unverified` | 需要目标环境、供应商或人工操作，仓库没有冒充通过 |
| `not_applicable` | 责任人书面说明为何不适用，并记录替代控制 |

## 2. 工程证据索引（合成数据）

| 证据 ID | 覆盖范围 | 可复现入口 | 当前状态 |
|---|---|---|---|
| E-REF-TEST | API、权限、同意、频次、危机闭环、媒体、会话撤销、审计和字段/对象密钥轮换 | `npm test`（44 项 Node 测试） | `verified` |
| E-REF-SEC | 凭据模式、生产后端/演示 MFA、CSP、请求体和私有对象边界 | `npm run security:check` | `verified` |
| E-REF-PLAN | 48 项任务、依赖 DAG、生成任务清单同步 | `python3 scripts/check_plan.py` | `verified` |
| E-PG-MIGRATION | 36 张表、36 个 `FORCE RLS`、36 个策略、关键跨租户外键、应用角色无 `SUPERUSER/BYPASSRLS` | CI PostgreSQL 16 步骤；本地 `infra/migrations/001_initial.sql` | `verified`（参考迁移） |
| E-REF-RECOVERY | 加密 JSON/私有对象复制、恢复和临时文件清理 | `npm run drill:recovery` | `verified`（本地合成） |
| E-REF-CAPACITY | 受限并发请求 p50/p95、错误率 | `npm run drill:capacity` | `verified`（本机基线） |
| E-RELEASE-GATE | 生产环境配置和外部证据缺失时阻断发布 | `CAMPMIND_RELEASE_MODE=production npm run release:check` | `verified`（应阻断） |

上述证据不证明量表信效度、临床判断、法律合规、生产容量、供应商 SLA 或真实值班能力。

## 3. 外部 Gate 登记（由责任人填写）

| Gate | 必填证据 | 责任岗位 | 引用/签署位置 | 状态 |
|---|---|---|---|---|
| CM-001 / CM-005 | 首校范围、数据责任、容量/RPO/RTO、需求差异和威胁模型签字 | 产品、校方、技术、安全 | _待填写_ | `unverified` |
| CM-002 / CM-014 / CM-016 / CM-046 | 权利许可、数字化范围、适龄/常模、计分金标准、专业审批和撤销处置 | 专业负责人、权利负责人 | _待填写_ | `unverified` |
| CM-003 / CM-013 / CM-036 | 处理依据、告知/同意、监护核验、保留/删除和权利流程 | 隐私/法律、校方 | _待填写_ | `unverified` |
| CM-004 / CM-026 / CM-028 / CM-030 / CM-032 | 值班/备用/升级、转介回执、夜间/失联演练、独立结案者 | 专业负责人、校方 | _待填写_ | `unverified` |
| CM-007 / CM-008 / CM-010 / CM-011 | 真实 PostgreSQL Store、SSO/MFA、KMS、私有桶、审计和连接池演练 | 后端、运维、安全 | _待填写_ | `unverified` |
| CM-038 / CM-039 | 目标环境容量、备份恢复、删除重放、安全评审和影响评估 | 运维、安全、隐私/法律 | _待填写_ | `unverified` |
| CM-040 | 校方试点人数/窗口/停止条件、人工接管和共同签署 | 校方、产品、专业、隐私 | _待填写_ | `unverified` |
| CM-048 | 新用途/接收方授权、聚合互补抑制、逐校扩张验收 | 数据、安全、校方 | _待填写_ | `unverified` |

只有外部 Gate 证据齐全、严重问题关闭且 `CAMPMIND_RELEASE_MODE=production npm run release:check` 通过，才可进入受控真实试点。任何 `unverified` 不得被改写成 `verified`，也不得以合成测试或 GitHub Issue 代替签署。

## 4. 记录格式

每条证据至少记录：代码/迁移 SHA、环境与数据类型、操作者、开始/结束时间、命令或人工步骤、预期/实际、状态、脱敏日志位置、失败与回滚结论、专业/校方签署和后续责任人。恢复副本、量表原文和真实数据只放经批准的私有位置，并在生命周期结束后保留删除证明。
