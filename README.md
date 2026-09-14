# Campus Mind · 校园心晴

**心理健康测评云平台（中小学版）**：以学校为服务单位，连接学生、心理教师与校方，形成「知情参与 → 测评 → 专业复核 → 支持与转介 → 随访」闭环。

项目说明站点已发布到 [GitHub Pages](https://thunderxu7-sketch.github.io/campus-mind/)。Pages 只托管静态文档与合成数据说明，不运行 API 或接收真实学生资料；发布边界见 [Pages 部署说明](docs/13-github-pages.md)。

> **当前状态：合成数据参考实现 v0.1（开发/验收用途）。** 本仓库不包含真实学生数据、受版权保护的量表题目或生产服务。筛查结果不是医学诊断，系统不能替代专业判断或紧急救助。

## 产品范围

规划归并为 **11 个子系统**，不是把“11 个模块”直接拆成 11 个微服务：

1. 学校组织与独立账号权限
2. 人员信息采集、监护关系与知情参与
3. 量表目录、授权版本与计分引擎
4. 心理普查与任务管理
5. 心理筛查与学生测评端
6. 心理档案与报告
7. 危机预警与人工复核
8. 干预、转介与随访
9. 隐私保护的数据统计
10. 咨询师排班与预约
11. 心理教育门户与内容管理

**首个 MVP**：以一所学校的初中学段试点为默认假设；系统设计保留多租户隔离。完成名单导入、知情参与、一个经过授权和专业审定的测评方案、断线恢复、计分、报告审核、风险人工处置和基础统计。小学高年级、高中扩展需分别完成适龄验证；小学低年级先提供教育与支持服务，不直接复用中学生量表。

## 阅读顺序

| 文档 | 解决的问题 |
|---|---|
| [产品需求与范围](docs/01-product-requirements.md) | 原始需求如何归并；哪些能力先做、后做或不做 |
| [权限与业务流程](docs/02-roles-and-workflows.md) | 谁能看什么；测评、审核和危机处置如何流转 |
| [技术架构](docs/03-architecture.md) | 模块化单体、前后端、异步可靠性和部署边界 |
| [数据与 API 设计](docs/04-data-and-api.md) | 关键实体、版本、约束、接口和错误语义 |
| [安全、隐私与专业治理](docs/05-safety-privacy.md) | 未成年人保护、量表版权、数据生命周期和上线门槛 |
| [路线图](docs/06-roadmap.md) | M0–M5、交付门槛、关键路径及待决策事项 |
| [可执行开发任务](docs/07-task-breakdown.md) | P0/P1/P2、依赖、责任角色和逐项验收标准 |
| [测试与试点验收](docs/08-verification.md) | 计分金标准、隔离测试、故障演练和停止条件 |
| [来源及需求变更记录](docs/09-sources-and-decisions.md) | 官方依据、已调整的危险需求和方案假设 |
| [GitHub 工作项索引](docs/10-github-tracking.md) | 在线开发任务与 Milestone 入口 |
| [证据登记册](docs/12-evidence-register.md) | 工程验证、外部准入证据与未决门槛 |
| [表达与支持助手：营销方向](docs/14-expression-support-marketing.md) | 定位、文案、演示、客户验证与宣传证据门槛（新增规划，未实现） |
| [表达与支持助手：开发执行规格](docs/15-expression-support-implementation.md) | 数据、API、权限、状态机、开发任务和验收矩阵（新增规划，未实现） |

## 关键设计决定

- **独立账号，不共享管理员密码**；平台运维默认不能访问学生心理资料。
- **自动识别线索，不自动诊断或结案**；低分、重测或学生自助申请均不能自动解除预警。
- **测评次数受控**；学校任务与学生自选筛查共用频次检查，不能通过新建任务绕过。
- **报告分级审核发布**；日常展示策略不剥夺学生及监护人依法申请查阅资料的权利。
- **量表、常模、阈值、报告模板均版本化**；本项目不虚构临床阈值，不把成人量表默认用于儿童。
- **共享终端 fail-closed**；退出/切换身份会清理敏感页面状态，并用会话 epoch 丢弃迟到的异步响应。
- **云端部署不等于境外存储**；默认规划中国大陆数据平面，GitHub 只管理源码、合成测试和规划。

上述为项目设计约束，政策依据与适用边界见[来源记录](docs/09-sources-and-decisions.md)。正式运营须经当地校方、专业负责人及法律/隐私负责人评审，不以文档存在证明合规。

## 生产技术方向与当前参考实现

**生产规划方向**：TypeScript 单仓、React + Vite（管理端 / 学生端）、NestJS API 与 Worker、PostgreSQL、Redis 队列、私有对象存储。核心计分独立纯函数包；从模块化单体起步，不先上微服务、AI 诊断或 Kubernetes。以上选型尚未表示已经采购或接入。

当前已提供一个**合成数据参考实现**（Node 20+），使用轻量 Node HTTP API 与静态响应式页面验证领域不变量；同时包含加密 JSON 本地适配器、版本化演示计分、人工复核工作流、受控导入/导出、预约、教育内容、媒体安全检查、学生反馈与权利申请入口、专业档案/报告工作台、运维接续按钮、无手机学生一次性短期凭证和 PostgreSQL 迁移草案。React/Vite/NestJS/Redis 等生产组件尚未在本参考实现中接入。它不是生产部署，也不能接收真实学生资料。生产环境必须替换存储、密钥、通知和身份接入，并通过 M4 Gate。

```sh
npm install
CAMPMIND_DEMO_MFA=true CAMPMIND_MASTER_KEY=local-only-key npm start
# 管理端 http://localhost:8787/admin；学生端 http://localhost:8787/student

npm run check       # TypeScript、52 项行为测试、安全扫描与规划校验
npm run drill:capacity  # 合成并发基线（输出 p50/p95/错误率）
npm run drill:recovery  # 合成快照与加密私有对象恢复演练
npm run drill:crisis    # 合成危机线索、人工接续与死信恢复演练
npm run drill:key-rotation  # 合成字段/对象密钥轮换与旧密钥拒绝演练
npm run release:check    # 参考模式边界检查；生产模式需外部证据环境变量
npm audit --omit=dev --audit-level=high
```

演示数据全部由代码生成，密码只用于本地测试；不要把其作为生产凭据。API 默认将本地数据写入被 `.gitignore` 忽略的 `private-data/`。

可复制 `.env.example` 作为本地配置模板。`CAMPMIND_OBJECTS_DIR` 指向加密私有媒体目录；生产配置必须注入 PostgreSQL 与私有对象存储适配器，不能使用示例 JSON/文件适配器。

## 验证规划

需要 Python 3.11 或更高版本，无第三方依赖：

```sh
python3 scripts/check_plan.py
python3 -m unittest discover -s tests -v
```

任务事实源是 [planning/backlog.json](planning/backlog.json)。修改后生成 Markdown：

```sh
python3 scripts/check_plan.py --write
```

任务状态中的 `done` 只表示参考实现与自动化证据完成；`in_progress` 仍可能缺生产/治理证据。GitHub Issue 是规划跟踪，不代表真实试点准入。代码与文档贡献规则见 [CONTRIBUTING.md](CONTRIBUTING.md)。
