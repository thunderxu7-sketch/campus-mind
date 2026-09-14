# 表达与支持助手：开发执行规格

版本：1.0 · 日期：2026-09-14 · 基线：`ff051b6` · 状态：**新增能力设计稿，未实现、未试点**。

配套：[营销定位与执行手册](14-expression-support-marketing.md)。本文件是本扩展的需求与任务事实源；原有 `planning/backlog.json` 的 48 项任务不因此自动新增、完成或改变准入状态。ES-* 是待排期的扩展任务，不冒充已创建的 GitHub Issue。

## 1. 目标、范围和不可变约束

交付两条互不交换视觉数据的能力：

1. **核心业务**：学生自愿记录 → 选择分享 → 单独请求联系 → 专业人员接单/跟进 → 学生查看状态或取消。
2. **可选体验**：学生主动开启摄像头 → 设备内面部几何跟踪 → 虚拟形象随动 → 停止并释放资源。

### 1.1 MUST / MUST NOT

- MUST：拒绝摄像头、无摄像头、模型失败时，记录、支持请求、预约和帮助入口仍完整可用。
- MUST：保存记录、授权分享、请求联系是三个独立动作；默认只保存给自己，不默认通知教师。
- MUST：学生明确看到接收人、内容、期限、服务时段及撤回限制。
- MUST：自述只标记 `student_self_report`，不伪装成标准量表，不计总分、不排名、不做心理趋势评分。
- MUST NOT：根据面部、声音或其他生物信号推断情绪、压力、专注度、人格、真假、疾病或心理危机。
- MUST NOT：采集面部数据作为心理模型训练材料；输出几何动作序列到档案、统计或服务端。
- MUST NOT：摄像头动作、自述主题或文字自动触发 `RiskSignal`、改写测评分数、解除危机。
- MUST NOT：接入教室监控、隐蔽采集、强制拍摄、考勤、班级排名或营销追踪。
- MUST NOT：以“获得同意”或“仅供参考”绕过以上功能边界。

首版不做：真实视频咨询/录制、语音分析、LLM 情绪分析、原始记录批量导出、家长实时浏览自述、校级心理状态看板、自动转介、复杂排班重构、移动原生 App。医疗服务不是本扩展范围。

## 2. 现有代码与必须补齐的接口边界

以下是基线核对结果，不是未来生产实现的描述。

| 位置 | 当前事实 | 本次开发动作 |
|---|---|---|
| `apps/student-web/index.html` | 静态 HTML + 内联脚本，有会话 epoch 清理 | 增加自述/分享/支持区；视觉生命周期单独模块，不引入 React 重写 |
| `apps/admin-web/index.html` | 有专业工作台及运维接续入口 | 增加普通支持收件箱，与危机工作台分区 |
| `apps/api/src/main.ts` | Node HTTP 路由，响应 `{data}` / `{error}`；默认 `camera=()` | 增加精确匹配路由、静态资源白名单和仅学生页可选摄像头权限 |
| `apps/api/src/domain/types.ts` | `ConsentRecord.purpose` 只有 assessment/support/research | 显式新增两个用途，不借用 research/assessment 绕过授权 |
| `apps/api/src/domain/service.ts` | 有 createConsent/withdrawConsent、rights、预约、Outbox | 扩展用途与撤回、权利和清理；新普通请求单独建模 |
| 同上 `createRiskSignal` | 调用会创建/关联危机个案并入 Outbox | 普通“想聊聊”禁止直接调用该方法 |
| 同上 `withdrawConsent` | 目前只有 assessment 有专用停止处理逻辑 | 为新增用途实现独立、即时的撤回副作用 |
| 同上 `rightsAccessPackage` / `purgeStudentData` / `processRetention` | 不知道新增表/集合 | 必须覆盖新记录、分享、请求、备注、派生包和恢复重放 |
| `apps/api/src/domain/auth.ts` | 角色权限表，不自动等于对象级授权 | 新增细分权限，并在每次操作校验对象关系 |
| `apps/api/src/domain/store.ts` | Store.transaction/read + JsonStore，生产拒绝 JSON 适配器 | emptyState 增加集合；生产缺口不得以文档替代 |
| `infra/migrations/001_initial.sql` | 36 张参考表、租户 RLS 与 FORCE RLS | 新增 `002_expression_support.sql`，不重写旧迁移；实际生产适配器同步实现 |
| `.github/workflows/ci.yml` | 有“36 表/36 策略”的数量检查 | 新增迁移后改成正确数量，并增加按表检查，不能删除 RLS 检查 |
| `docs/index.html`、`docs/13-github-pages.md` | Pages 静态说明页，不运行 API | 只放合成演示；不能把真实服务部署到 Pages |

新增业务代码建议：`apps/api/src/domain/expression-support.ts`；只让 HTTP 路由调用导出的服务方法。共用授权/审计 helper 若需要抽取，应保持旧行为回归，不从前端实现权威权限判断。

## 3. 用户流程与页面规格

### 3.1 学生页：四张业务卡片 + 一个可选体验入口

| 区域 | 字段与操作 | 反馈与边界 |
|---|---|---|
| 我的表达 | 可选主题 + 可选文字，至少填一项；保存 | “仅本人可在此查看；不会自动通知老师”；不承诺对依法处理的权利请求绝对不可见 |
| 我的记录 | 本人记录列表，查看详情、删除、分享 | 不出现情绪颜色、等级、健康分；列表不直接渲染全文 |
| 选择分享 | 同校合格咨询师、记录预览、期限；单独确认 | 显示“分享不等于请求联系”；已看过的信息不能回收 |
| 希望老师联系我 | 咨询师、可选已授权记录；单独提交 | 显示服务时段、最迟接单时间及状态；允许不写自述而直接请求联系 |
| 可选形象互动 | 开始/关闭/跳过，摄像头指示 | 不提交业务数据，不生成状态记录，不承诺改善情绪 |

每张可提交卡片都包含 `idle / submitting / success / error`，提交中禁重复点击但仍依赖服务端幂等。失败保留当前内存输入并显示具体可执行提示；退出/换人必须清空，不写 localStorage、sessionStorage、IndexedDB 或 Service Worker 离线缓存。

所有页面永久显示既有“需要立即帮助”入口；普通支持请求旁写明“不是即时救助渠道”。此入口不能被摄像头授权、记录字数限制、普通请求限流或新的同意流程挡住。

### 3.2 专业人员页

- “分享给我的记录”：只有指定收件人、授权仍有效、同意仍有效时可见；列表仅返回记录 ID、分享时间、到期时间与收件权限状态。
- “普通支持请求”：状态、提交时间、服务截止时间、接收人。无自述正文、心理主题或视觉字段出现在通知/全局列表。
- 请求详情：授权后显示联系所需的学生姓名/校内身份及状态；关联原文必须另走分享详情读取，不能永久复制进请求 DTO。
- 操作：接单、开始联系、安排跟进、添加受控工作备注、结束服务。结束仅表示工作流程结束，不表示心理恢复。
- 授权失效：立即禁用正文区；下次请求不得返回内容。没有权限的教师/管理员看不到此入口，直接访问 API 同样拒绝。

### 3.3 分享、请求、撤回的具体语义

1. 记录保存后不可原位修改；需要修改时创建新记录，旧分享不会自动指向新内容。
2. 一条记录同时最多一个有效分享。更换收件人必须先撤回旧分享，再创建新分享；不隐式扩散到整个咨询中心。
3. 分享默认 24 小时，可选 1 / 24 / 168 小时；后端同时受学校上限和记录保存期限制，不能超过原记录有效期。这是产品默认，不是法定留存期。
4. 分享本身不创建联系请求或通知。请求联系时可不关联记录；关联时必须是本人仍有效、同一收件人的分享。
5. 撤回分享阻止后续原文访问，但不自动取消已请求的联系；界面同时提供明确的“也取消联系请求”选项，两项结果分别反馈。
6. 删除记录撤回其分享，但不删除已形成的独立工作备注或联系人请求。删除页面必须解释此边界，并提供现有权利申请入口。
7. 撤回 `self_expression` 用途：立即禁止新增记录/分享/普通联系，撤回本用途全部分享，取消未结束的本模块普通请求及未发送提醒；不改变正式危机个案、既有预约或其他用途的法定处理。
8. 撤回 `visual_interaction` 只停用视觉体验，不影响核心业务。
9. 重新同意不恢复旧分享、已取消请求或已删记录。撤回、停用、到期时的页面失效处理见第 9 节。

## 4. 配置、角色与知情参与

### 4.1 配置合约（新增，默认关闭）

从受控、版本化配置装载 `ExpressionPolicy`，以 `(tenantId, schoolId)` 精确匹配；首版不做开放的后台自由配置 API。配置由具名管理员提议、专业/隐私负责人批准后通过发布流程部署，审计仅记录版本/操作者，不公开签署文件。

| 字段 | 规则 |
|---|---|
| `enabled` / `visualEnabled` | 分别控制核心模块与视觉模块；默认 false |
| `policyVersion` | 1–80 字符、版本不可原位覆盖 |
| `expressionNoticeVersion` / `visualNoticeVersion` | 与当前被批准告知文本严格对应 |
| `minAge` / `maxAge` | 必填整数且 minAge ≤ maxAge；首版限已批准的初中未成年人范围，参考 fixture 为 12–17，不当作真实适龄证据 |
| `counselorIds` / `backupProfessionalLeadId` | 同租户同校、active、专业角色的允许名单；撤销立即生效 |
| `serviceHoursText` / `contactInstructions` | 专业负责人批准、纯文本；真实环境不使用示例电话 |
| `ackTargetMinutes` | 正整数；从提交起连续经过的分钟数，不暗含工作日算法 |
| `entryRetentionDays` / `closedRequestRetentionDays` / `accessLedgerRetentionDays` | 正整数；生产无隐含默认，必须有必要性/留存依据 |
| `maxShareHours` | 1–168；不足某个选项时不展示该选项 |
| `maxOpenRequestsPerStudent` | 首版固定 3；仅普通请求，不影响紧急帮助 |

合成测试使用明确的固定配置，例如记录 30 天、结束请求 90 天、访问撤销台账 180 天、接单目标 60 分钟；**仅为工程 fixture，不是建议给真实学校的 SLA 或合法期限**。测试使用可控时钟，不依赖真实等待。

告知正文保存在部署随附的版本化 `ExpressionNotice` 注册表中，字段为 `purpose,version,title,body`；body 包含用途、字段、接收人、留存/撤回边界、服务时段和权利入口。配置只能引用已批准且存在的版本，不能仅修改版本号却继续展示旧文案。正文为纯文本；历史版本保留在批准的告知记录中。

生产 `enabled=true` 时缺字段、证据或接续人员应拒绝启用；`visualEnabled=true` 还需额外视觉评审。时限配置变化只作用于新请求；已有 `ackDueAt` 保留原约定，并对失去接续能力的存量请求显示异常。

### 4.2 权限矩阵

| 角色 | 自述正文 | 普通请求 | 配置/运维 |
|---|---|---|---|
| student | 仅本人；可删、可选分享 | 仅本人创建/查询/取消 | 无 |
| 指定 counselor / professional_lead | 仅被显式分享且当前有效的记录 | 仅接收给自己的请求；不能据此读取其他记录 | 无默认全校正文权限 |
| 非收件 professional_lead | 无 | 只见需要接续的最小元数据，不自动接管正文 | 复核接续人员配置 |
| school_admin / teacher | 无 | 无个体请求列表/正文 | 管理员仅提出配置请求；教师不获得新增权限 |
| guardian | 不直接浏览学生自述 | 不代替学生分享/请求联系 | 核验关系后完成未满 14 岁适用同意；权利请求另走原流程 |
| privacy_auditor | 不直接浏览业务正文 | 不直接浏览业务详情 | 权利处理及最小审计；仅已受理、合法核验的 access 包可包含必要内容 |
| platform_ops | 无 | 无业务详情 | 系统故障数量、队列健康等最小指标 |

新增权限建议：student 获 `self:expression`；专业角色获 `expression:shared-read`、`support:assigned-manage`；负责人获 `support:escalation-metadata`。这些字符串不赋予跨对象权利；服务端校验同租户、同校、active、所有权/收件关系、当前政策和用途。

### 4.3 用途与同意

扩展 `ConsentRecord.purpose`、HTTP 校验和 SQL CHECK，增加 `self_expression`、`visual_interaction`；原 assessment/support/research 语义不变。

- 年龄未知、年龄超出批准学段：本模块真实数据功能不可启用，仍提供公共帮助资源。首版目标初中，适龄范围来自已批准政策，不靠界面手填年龄放行。
- 小于 14 岁：要求当前有效、版本匹配且已核验监护关系的 guardian 同意；学生每次保存、分享、请求/开启视觉还需主动确认。学生确认写在动作审计中，不另建 student ConsentRecord 覆盖 guardian 记录。
- 14–17 岁：本版至少要求本人当前用途同意；适用地区/学校要求额外监护参与时，须先实现相应规则再启用，不假设各地一致。
- 新用途不接受 `school_legal_basis` 作为替代自愿参与的捷径；不改变旧用途规则。
- `createConsent` 当前按用途找一条 active 记录；实现时验证 actor、关系及版本，禁止“不匹配 actor 却直接返回 existing”造成假授权。
- 浏览器摄像头授权不是业务知情同意。视觉权限与自述用途独立；任意用途撤回不取消公共帮助。

敏感信息处理和未满 14 岁监护同意等法律要求由项目负责人按实际活动核验，端侧并非豁免。[个人信息保护法](https://www.cac.gov.cn/2021-08/20/c_1631050028355286.htm)

## 5. 数据结构和数据库约束

### 5.1 五个新增集合/表

时间一律 UTC ISO 8601 / `timestamptz`；ID 为服务端生成 UUID。TS 用 camelCase，SQL 用 snake_case。以下字段是开发合约，不是迁移已执行的声明。

| TS / SQL | 必要字段与含义 |
|---|---|
| `ExpressionEntry` / `expression_entries` | `id, tenantId, schoolId, studentId, source='student_self_report', payloadCiphertext, consentId, noticeVersion, createdAt, expiresAt, deletedAt?, idempotencyKey, requestDigest, digestKeyVersion`；payloadCiphertext 仅删除/到期后允许 null |
| `ExpressionShare` / `expression_shares` | `id, tenantId, schoolId, studentId, entryId, recipientId, consentId, noticeVersion, status(active/revoked/expired), createdAt, expiresAt, revokedAt?, idempotencyKey, requestDigest, digestKeyVersion` |
| `SupportRequest` / `support_requests` | `id, tenantId, schoolId, studentId, recipientId, shareId?, consentId, noticeVersion, state, version, policyVersion, createdAt, updatedAt, ackDueAt, firstAcknowledgedAt?, nextFollowUpAt?, closedAt?, cancellationReason?, idempotencyKey, requestDigest, digestKeyVersion` |
| `SupportNote` / `support_notes` | `id, tenantId, schoolId, requestId, authorId, noteCiphertext, createdAt, idempotencyKey, requestDigest, digestKeyVersion`；专业工作记录，不用来复制全部自述 |
| `ExpressionRevocation` / `expression_revocations` | `id, tenantId, schoolId, studentId, targetType(entry/share/consent), targetId, effect(delete/revoke), recordedAt`；恢复时重放的最小访问撤销台账，不存正文 |

`ExpressionEntry.payloadCiphertext` 解密后的结构固定为：

```json
{
  "topic": "study",
  "note": "合成示例：想和老师聊聊学习安排。"
}
```

`topic` 可为 `study / peers / family / school_life / general / null`，`note` 为 null 或最多 1000 个 Unicode 码点的纯文本。两项不可同时空。主题只是本人选定话题，没有情绪或风险映射；正文与主题一起加密，不进入明文索引。

### 5.2 必须实现的约束

1. 所有新增表启用 RLS + FORCE RLS，以 tenant context 约束访问。学校与对象级控制仍在领域服务逐次执行，RLS 不能代替这些判断。
2. 新表全部含 `UNIQUE(tenant_id,id)`。为 students/users 及新增 entry/share/request 建立需要的 `UNIQUE(tenant_id,school_id,id)`；学生、收件人和 author 引用采用同校三列 FK。entry/share/request 另提供 `UNIQUE(tenant_id,school_id,student_id,id)`；share→entry、request→share 用这四列关联。consents 增加 `UNIQUE(tenant_id,student_id,id)`，用途引用用这三列且在事务中校验 purpose。notes→request 使用同校三列，服务端另验 author 为指定处理人。撤销台账的多态 targetId 不建到待删除实体的 FK，恢复重放前按 targetType 与学生范围验证。
3. 状态、source、revocation target/effect、时间先后有 SQL CHECK；`version >= 1`。`entry` 不允许保存原始媒体、JSON 扩展属性或未加密正文。
4. share 部分唯一索引 `(tenant_id,entry_id) WHERE status='active'`。创建新分享前在同一事务锁定 entry，将确已到期的 active 分享转 expired，再校验唯一性。
5. 所有创建接口的幂等唯一键包含租户、请求人、对象/接口作用域。notes 的作用域为 `(tenant_id,author_id,request_id,idempotency_key)`；其他表至少含 `(tenant_id,student_id,idempotency_key)`。
6. `requestDigest` 是服务器密钥保护的 HMAC，输入绑定接口作用域、租户、请求人和规范化 body，不能用可穷举短文本的普通明文哈希。新增用途隔离密钥由现有密钥管理边界供给，digestKeyVersion 标记版本；去重窗口结束前保留对应历史验证密钥。摘要与版本仅用于冲突检测，不返回客户端或提交密钥。
7. support_requests 对同学生、同 recipient、非终态有部分唯一约束；即使换幂等键也不能无限制造同一接收人的未结束请求。
8. 严格限制 note/主题、请求总长度和允许字段。新接口 body 上限 8 KiB，正文码点限制另算，超过直接 413，不按旧全局 3 MB 上限读取完才判断。
9. 所有新增集合纳入 emptyState、旧 JSON 快照载入、种子、清理和恢复。兼容旧快照不代表旧库具备生产能力。
10. 追加迁移先新建五表、索引/策略，再扩展 consents/outbox CHECK；对回滚使用关闭功能而非删表。旧应用兼容性必须实测，不假设旧 worker 理解新事件。

枚举固定：SupportRequest.state 为 requested/acknowledged/in_contact/follow_up/completed/cancelled；cancellationReason 仅 user_requested/consent_withdrawn 或 null。撤销台账只允许 `(entry,delete)`、`(share,revoke)`、`(consent,revoke)`，不允许其他组合。接收人停用不自动伪记“学生取消”，保留请求并提示学生重新选择，备援收到最小异常元数据。

现有 36 表 + 本版 5 表 = 41 表；CI 同时断言五张新增表的 RLS、FK、索引和权限，不只改数字。禁止为通过数量测试而删除已有表。

## 6. API 合约

### 6.1 通用规则

- 沿用 `/v1`、Bearer 会话与现有同源校验；新路由精确验证 segment 数量，拒绝额外路径段。
- 返回成功 `{ "data": ... }`，列表 `{ "data": [...], "page": { "nextCursor": null } }`；错误沿用 `{ "error": { "code": "...", "message": "..." } }`。
- 从认证上下文推导 student/tenant/school；不接受由学生 body 提供这些字段，不把 `actorId` 当可信来源。
- 未登录 401；角色不允许 403；猜测其他人的对象与对象不存在均 404；本人已删除/到期记录 410；并发/幂等冲突 409；缺配置/接续能力 503。
- `Cache-Control: no-store`；禁止通配 CORS；不在 URL 放正文、token 或姓名。列表 limit 默认 20、最大 50，cursor 是签名的不透明游标，绑定用户/学校/查询条件。
- 创建必须带 `Idempotency-Key`：16–128 位 ASCII `[A-Za-z0-9_-]`；请求丢响应后同键重试返回同一对象（200），首次 201；不同 body 同键返回 409。回放前重新鉴权，不能因幂等绕过撤回或返回旧正文。
- 幂等保留至对象留存结束；单条删除先清空密文并保留原行的 ID、归属、幂等信息及删除时间到原留存期结束，作为不含正文的去重墓碑。窗口内已删除同键返回 410，不重建；客户端不得为重试自动换键。窗口后去重不再承诺，新的操作必须生成新键；哈希密钥轮换期间仍须正确核验历史摘要。

### 6.2 路由清单

| 方法 / 路径 | 请求/返回 | 关键服务端检查 |
|---|---|---|
| GET `/v1/me/expression-capabilities` | `{expressionEnabled,visualEnabled,noticeVersions,consentRequirements,serviceHoursText,contactInstructions,allowedShareHours,validForSeconds}` | 不返回影像/生物数据；validForSeconds 固定 45；服务端政策与会话决定能力 |
| GET `/v1/me/expression-notices/:purpose` | `{purpose,version,title,body}`，purpose 仅 self_expression/visual_interaction | 返回当前学校配置引用的告知文本；不接受任意文件路径/版本读取 |
| GET `/v1/me/support-recipients` | 被批准的同校接收人 `{id,displayName,role,acceptingRequests}` | 仅必要资料；离职/停用/无专业角色不出现 |
| POST `/v1/me/expression-entries` | `{topic?,note?,noticeVersion,acknowledged:true}` → 本人详情 DTO | 同意与适龄有效，至少一项非空，字段白名单 |
| GET `/v1/me/expression-entries` | 列表 `{id,createdAt,expiresAt,shareStatus}` | 本人记录，不返回正文/主题 |
| GET `/v1/me/expression-entries/:id` | `{id,source,topic,note,createdAt,expiresAt}` | 本人且未删/未到期；本人读取不因撤回新处理同意而永久丧失查阅权 |
| DELETE `/v1/me/expression-entries/:id` | 204，无 body | 原子清空密文、撤回分享、写 entry 删除台账；本人重复删除 204 |
| POST `/v1/me/expression-entries/:id/shares` | `{recipientId,ttlHours,noticeVersion,acknowledged:true}` → 分享元数据 | 本人原文有效、当前同意、合格接收人、唯一有效分享 |
| GET `/v1/me/expression-shares` | `{id,entryId,recipientId,status,expiresAt}` 列表 | 仅本人；显示有效状态按当前时间/撤回重新计算 |
| POST `/v1/me/expression-shares/:id/revoke` | `{}` → 204 | 原子撤销并写分享台账；重复不报错 |
| GET `/v1/professional/expression-shares` | 分享元数据列表，无正文/主题 | 仅当前指定收件人，过滤失效同意/关系 |
| GET `/v1/professional/expression-shares/:id` | 被分享的单条记录 DTO | 每次读取重验全部关系；不得借 requestId 绕过 |
| POST `/v1/me/support-requests` | `{recipientId,shareId?,noticeVersion,acknowledged:true}` → 请求状态 DTO | 明确请求联系、当前自述用途同意、活动请求数量/收件唯一性、关联分享同一收件人 |
| GET `/v1/me/support-requests` | 本人请求状态列表 | 无专业备注/他人资料 |
| GET `/v1/me/support-requests/:id` | 本人请求状态 DTO | 仅本人；关闭功能后仍提供历史查阅/取消与权利入口 |
| POST `/v1/me/support-requests/:id/cancel` | `{expectedVersion}` → 请求状态 | 原子取消非终态和未发送提醒；同一已取消请求重复返回当前状态 |
| GET `/v1/professional/support-requests` | 指定接收人的请求列表 | 对象级过滤，不使用原全校 case:read 来放大范围 |
| GET `/v1/professional/support-requests/:id` | 请求状态 + 必要联系身份 + 自述可访问性标记 | 不直接内嵌原文；对象/学校/收件人当前有效 |
| POST `/v1/professional/support-requests/:id/transitions` | `{action,expectedVersion,nextFollowUpAt?}` → 新状态 | 事务锁/version，action 白名单与状态机 |
| GET `/v1/professional/support-requests/:id/notes` | 已授权请求的专业备注列表 | 仅指定处理人；不返回给学生普通状态接口 |
| POST `/v1/professional/support-requests/:id/notes` | `{note,expectedVersion}` → `{id,createdAt}` | 1–2000 码点，活动请求、当前处理授权；幂等，写入同时递增 version |
| GET `/v1/professional/support-escalations` | `{requestId,recipientId,createdAt,ackDueAt,reasonCode}` | 仅备援负责人，限逾期/失去接收能力的请求，无姓名/正文 |

记录/分享/请求详情不得直接返回 Store 实体或密文字段。主档案 `getStudentArchive` 首版不嵌入自述；即使用户有 `report:read`，也必须走分享详情或依法核验的权利包。

对状态 DTO 额外返回派生的 `recipientAvailable`（当前政策及账号计算，不作为历史心理字段）；不可用时学生可取消并新选接收人，原分享不自动转移。新的用途同意创建/查询/撤回复用现有 `/v1/me/consents` 与 `/v1/me/consents/:id/withdraw`，按第 4 节扩展校验，不重复另建授权接口。

### 6.3 示例（均为合成契约示例）

保存：

```http
POST /v1/me/expression-entries
Idempotency-Key: synthetic_entry_0001
Content-Type: application/json

{"topic":"study","note":"合成示例：想聊聊学习安排。","noticeVersion":"expression-synthetic-v1","acknowledged":true}
```

首次成功：

```json
{"data":{"id":"00000000-0000-4000-8000-000000000001","source":"student_self_report","topic":"study","note":"合成示例：想聊聊学习安排。","createdAt":"2026-09-14T08:00:00Z","expiresAt":"2026-10-14T08:00:00Z"}}
```

普通支持请求状态 DTO：

```json
{"data":{"id":"00000000-0000-4000-8000-000000000002","recipientId":"00000000-0000-4000-8000-000000000003","recipientAvailable":true,"shareId":null,"state":"requested","version":1,"createdAt":"2026-09-14T08:00:00Z","updatedAt":"2026-09-14T08:00:00Z","ackDueAt":"2026-09-14T09:00:00Z","firstAcknowledgedAt":null,"nextFollowUpAt":null,"closedAt":null,"cancellationReason":null}}
```

示例 ID、告知版本、时间不能作为生产配置；`ackDueAt` 由学校政策和服务器时钟生成。

### 6.4 业务错误码

| HTTP / code | UI 行为 |
|---|---|
| 400 `EXPRESSION_INPUT_INVALID` | 指向具体非法字段，不回显敏感输入 |
| 403 `EXPRESSION_CONSENT_REQUIRED` | 展示当前适龄告知/监护步骤；保留公共帮助 |
| 409 `EXPRESSION_NOTICE_CHANGED` | 丢弃旧授权确认并重新展示告知，不偷偷代同意 |
| 403 `VISUAL_CONSENT_REQUIRED` | 不申请/立即停止摄像头，核心服务不受影响 |
| 404 `EXPRESSION_NOT_FOUND` | 清空详情，显示不可访问；不暴露是否属于别人 |
| 410 `EXPRESSION_GONE` | 告知本人记录到期/删除，禁止同键重建 |
| 409 `SHARE_ACTIVE_EXISTS` | 提示先撤回现有分享 |
| 409 `SHARE_UNAVAILABLE` | 当前分享已失效，请重新选择或不带记录联系 |
| 409 `IDEMPOTENCY_CONFLICT` / `SUPPORT_VERSION_CONFLICT` | 刷新状态；不自动换键重复创建 |
| 409 `SUPPORT_ALREADY_OPEN` | 展示本人同接收人的活动请求入口 |
| 429 `SUPPORT_REQUEST_LIMITED` | 显示已存在请求，不挡紧急帮助/公共内容 |
| 503 `SUPPORT_RECIPIENT_UNAVAILABLE` / `EXPRESSION_NOT_CONFIGURED` | 显示人工支持说明，不谎报已交给老师 |

## 7. 普通支持状态机与可靠性

### 7.1 状态转换

| 原状态 | action / 操作者 | 目标状态 | 副作用 |
|---|---|---|---|
| 无 | 创建 / 学生 | requested | version=1；计算 ackDueAt；同事务创建普通提醒事件 |
| requested | acknowledge / 指定接收人 | acknowledged | 首次写 firstAcknowledgedAt，不得因重试改写 |
| acknowledged | start / 指定接收人 | in_contact | updatedAt/version 增加 |
| in_contact | follow_up / 指定接收人 | follow_up | nextFollowUpAt 必须为未来有效时间；创建到期提醒 |
| follow_up | follow_up / 指定接收人 | follow_up | 更新下一次时间，旧提醒失效；保留状态动作审计 |
| acknowledged/in_contact/follow_up | complete / 指定接收人 | completed | 写 closedAt；取消未发送提醒；不表达“心理恢复正常” |
| 任意非终态 | cancel / 学生；或用途撤回副作用 | cancelled | closedAt；取消未发提醒；记录枚举原因而非正文 |

未接单不能直接 complete；completed/cancelled 为终态，不能重新打开。需要新联系时创建新请求。所有转换 `UPDATE ... WHERE version=expectedVersion` 或等价行锁原子检查，受影响行数为 0 则冲突，不最后写入者覆盖。

### 7.2 提醒、超时与备援

- 创建请求与 `support.request_created` Outbox 在同一事务；提醒只含请求引用，不含学生姓名、自述、主题或脸部信息。
- 新增事件：`support.request_created`、`support.request_overdue`、`support.follow_up_due`。通知适配器增加 `routine` 运输优先级，与现有 urgent/attention 兼容；业务界面不把 routine 称为风险。
- 到期扫描只处理普通请求；逾期是工作人员流程指标，不能升级学生的心理风险等级。
- 请求创建提醒给指定接收人；接单逾期提醒给原接收人与配置的备援负责人。备援仅见第 6 节最小信息，不自动获得正文；需要新收件人时让学生明确重新选择。
- Worker 在发送前重读用途、请求、接收人、版本和相关事件的适用性。已取消、已接单的过期接单提醒、已变更的跟进时间应标记 `cancelled`，不发送。
- 为 Outbox.status 增加 `cancelled` 及可选 `cancelledAt`、`cancelReasonCode` 字段，同步 TS/SQL/worker/运维列表。原因固定 request_cancelled/consent_revoked/already_acknowledged/schedule_replaced/recipient_unavailable。不得把抑制发送伪记为 published；必须保留原因与审计。
- 供应商超时使用同一个 eventId 幂等重试；失败保留重试/死信，人工补投只作用仍有效事件。通知已发不能伪装成可撤回，通知链接访问仍实时鉴权。
- 固定演练：创建丢响应、两人/两标签同时接单、撤回与发送竞态、重复 worker、供应商未知结果、人员停用、跟进到期。截止前已在途的最小通知可能到达，正文不可因此恢复。

### 7.3 与危机预警、预约的边界

普通请求绝不调用 `createRiskSignal`。独立紧急帮助入口继续使用原用户明确求助工作流；不自动复制自述、不给视觉或关键词提供触发入口。专业人员如另行形成危机线索，按原权限、证据与人工复核流程记录，不在本扩展自动转单。

预约继续使用现有 `/v1/availability-slots`、`/v1/appointments`；学生明确操作，不默认夹带自述。普通支持请求与预约各有状态，不把预约成功视为已接单。本版不改变现有预约备注的访问规则。

## 8. 可选端侧视觉模块

### 8.1 仅实现几何互动

使用浏览器 `getUserMedia` 请求视频、`audio:false`。模型候选为 MediaPipe Face Landmarker，只读取面部关键点用于虚拟形象位置/形变；关闭额外的表情分类/解释输出，不构建情绪、意图、专注度或心理推断层。[官方 Web 文档](https://developers.google.com/edge/mediapipe/solutions/vision/face_landmarker/web_js)

不引入微表情情绪数据集、心理阈值、动作到情绪映射或跨会话人脸匹配。原型不需要服务端 GPU、不购买专用相机。SDK 包和模型文件必须分别核验商业使用许可、版本和 SHA-256；不使用 `latest` 或只凭代码许可证推定模型授权。

建议新增：`apps/student-web/visual/` 下 `controller.js`、`worker.js`、`avatar.js`；自控静态模型资产单独目录。controller 是唯一资源所有者，worker 无业务 API/token/学生 ID，输出仅内存中的渲染数据，不输出可导出的动作历史。

### 8.2 生命周期

状态：`disabled → ready → loading → authorizing → running → stopped`；拒绝/超时/异常进入 `error`，只有新的显式点击才能重试。

1. 登录后读取 capabilities，未批准/不适龄/未同意只显示无摄像头示例，不触发浏览器授权。
2. 点击开始后重新核验当前用途与政策，进入 loading 加载自控且已校验的 SDK/模型，显示本地处理说明，然后进入 authorizing 申请摄像头；禁止未准备完隐蔽开镜头。
3. 摄像头开始后只保留当前待处理帧；worker 忙则丢弃新帧，不堆积视频或多秒环形缓存；处理完释放 ImageBitmap/相关资源。
4. 零张或多张脸时暂停形象随动并提示调整/关闭，不识别哪张脸属于登录学生；不保存人数、行为计数或动作历史。
5. capabilities 每 30 秒重新核验，授权租约最多 45 秒，用本地单调时钟计算剩余时长；超时、离线、401/403、关闭开关即停止。请求中不包含摄像头状态、帧、关键点或动作。
6. 关闭、退出、切换身份、页面隐藏、pagehide、摄像头 track ended、模块异常时统一 cleanup：`track.stop()` 全部执行、`video.srcObject=null`、清空 canvas、停止循环、终止 worker、关闭模型实例、清除引用、递增 epoch。
7. 关闭过程中 `getUserMedia`/模型加载迟到返回时先验证 epoch；已失效则立即释放刚获得的 track/model，不把它挂回页面。
8. 从隐藏/浏览器返回缓存恢复时保持 stopped，不能自动恢复。每次最多运行 3 分钟的参考默认到期停止，可手动再开启；这是资源/隐私限制，不是心理干预时长。

浏览器摄像头生命周期应按媒体 API 规范实现并做实机验证，不能把“隐藏 video 元素”当成停止采集。[W3C Media Capture and Streams](https://www.w3.org/TR/mediacapture-streams/)

### 8.3 HTTP、CSP 与网络隔离

- 基线 `headers()` 全局为 `camera=()`。只在精确 `GET /student`、部署视觉开关开启时返回 `Permissions-Policy: camera=(self), microphone=(), geolocation=()`；其他页面/API继续禁用。学校/个人同意仍由模块与服务端 capabilities 控制，HTTP 头不是业务授权证明。
- 仅通过严格 allowlist 服务 JS、WASM、模型资产，分别正确 MIME、长度与资源路径；不能增加任意仓库目录静态映射、任意文件读取或路径穿越。
- 视觉依赖从同源加载，禁止 CDN、遥测、WebSocket、WebRTC 外发、录制、截屏上传、sendBeacon 和会话回放。worker 不持有业务 token，不引入网络发送方法。
- CSP 只按目标浏览器实测增加 `worker-src 'self'`，如确实需要 WASM 编译能力，只对学生页最小范围添加相应指令；不得全站开启 unsafe-eval、跨域 `*` 或移除 frame-ancestors。
- 同源限制本身不能证明“不上传”：还必须核查 fetch/XHR/WebSocket/sendBeacon 等出站请求的 body、服务端日志、浏览器存储、第三方资源清单。SDK/模型加载以及不含视觉数据的能力核验属于允许流量。
- 不把第三方监控脚本嵌入学生页。核心业务自行提交的数据可以发送 API，但视觉模块不得把输出注入请求 DTO。

### 8.4 Pages 边界

`docs/expression-demo/`（待建）只能包含固定合成状态与预设形象动画；禁止 getUserMedia、真实登录、真实资料输入或请求生产 API。若提供操作输入，仅限固定选项，显著标记“仅演示，不会提交给老师”。不把 API bearer 放到 Pages 配置。

## 9. 敏感数据、撤回、恢复与审计

### 9.1 最小保留与浏览器访问撤回

- 草稿仅在内存，离开/退出销毁；保存期由政策决定，不无限留存。日志和审计不记录正文、主题、面部信息或完整请求 body。
- 自述列表不解密全文，点击详情才取；DOM 用 textContent，纯文本显示，禁止用户内容作为 HTML 渲染。
- 专业端正文每 15 秒重验分享，隐藏页面立即清空；30 秒未成功重验即清空正文。API 撤回后立即拒绝新访问；已经返回的响应或已看过的内容无法追溯抹除，不营销“瞬间从对方记忆删除”。
- 所有详情请求绑定当前登录 epoch 和当前对象/分享版本；切换对象/账号/撤回后丢弃旧响应。中止 fetch 不代替版本验证。
- 分享到期在每次读取时以服务器时钟判定，不依赖定时任务是否已运行。本人历史查阅与专业访问权限分开，撤回同意不剥夺依法查阅权。

### 9.2 删除与恢复

- 单条删除事务：清空 entry 密文 → 撤销关联 share → 记入 ExpressionRevocation → 使关联详情不可读；不可在备份恢复后重新出现。
- 原文到期同样删除密文，过期分享失效；过期不以“长期 archived”保留正文。关联普通请求可以保留最小状态，不保留原文副本。
- `self_expression` 撤回台账记录到 consentId，恢复时撤销该用途对应分享/未结束请求；`visual_interaction` 撤回恢复后不能重新获得视觉能力。
- 权利 access 包纳入新增本人资料，核验请求者与用途后生成加密包；包只能由既定权利结果通道读取。正文更新/删除、撤回分享不得遗留未授权的通用导出副本。
- `purgeStudentData` 全量删除需要清空本模块记录、分享、请求、备注、派生包，原有 student tombstone 继续控制整个人的数据恢复；不能误把单条 entry tombstone 当作整人删除。
- 专业备注与已结束请求按 closedAt + 已批准保存期清理；活动请求不因过期任务被悄悄结束，应产生运营待处理项。备注不用于复制原文绕过撤回；依法必须保留的独立记录按专门规则处理。
- 恢复流程先重放独立保存的最新撤销/删除台账，再开放读流量。仅有旧数据库备份中的旧台账不够；必须与批准的备份/留存环境建立单调更新的外部台账检查点。台账保留期要覆盖可能恢复的备份窗口；无法证明完整则只读隔离，不开放正文。

### 9.3 审计事件

事件名：`expression.created/read/deleted`、`expression.share_created/share_read/share_revoked/share_expired`、`support.requested/acknowledged/started/follow_up/completed/cancelled`、`support.note_added/note_read`、`support.notification_cancelled`、`expression.access_replayed`。

字段只含 actorId、对象引用、动作、政策版本、时间、批准的用途及必要状态/错误枚举；禁存主题、正文、contactInstructions 内容、图像和关键点。视觉不记录单人动作/使用次数，只保留用途同意与撤回证据。运维指标不含个体心理资料。

## 10. 工程边界、测试环境与发布

### 10.1 环境与功能开关

- 参考环境：合成身份、合成记录、模拟通知；新功能只有显式 policy 才开启。
- Pages：固定合成演示，摄像头入口不发布，不接真实账号。
- 生产：先满足现有 M4 Gate、PostgreSQL/身份/密钥/通知等生产化要求，再通过本模块新增门槛；不得仅把环境变量设 true 就声称获批。
- 扩展 `scripts/release-gate.mjs`：表达启用时要求 E-GOV、E-PRIV、E-FLOW、E-OPS 的受控证据引用与摘要；视觉另要求 E-VIS。校验存在性/版本匹配只是机器检查，签字真实性仍由责任人确认。

| 证据 ID | 内容 | 责任角色 |
|---|---|---|
| E-GOV | 用途、适龄、说明、拒绝路径、普通支持与危机边界 | 产品 + 专业负责人 |
| E-PRIV | 最小采集、权限、撤回、保存期限、权利与恢复影响评估 | 隐私/安全负责人 |
| E-FLOW | 全流程、并发、异常、无摄像头、跨校越权测试 | QA + 技术负责人 |
| E-OPS | 指定人员、服务时段、备援、通知失败接续与恢复演练 | 校方服务负责人 + 运维 |
| E-VIS | 模型与 SDK 许可、端侧网络证据、资源释放和设备兼容 | 前端 + 安全负责人 |

### 10.2 停止与回滚

发现面部/正文外传、越权、误导性心理评分、摄像头不停止、普通请求无人接续或被强制使用：关闭对应新建/采集功能，保留历史查阅、撤回/取消、权利和帮助入口；处理现有队列，不静默抹掉未接单请求。

优先回滚开关和受控前端，不 DROP 表。旧 worker 若不认识新事件不得接管新队列；旧代码回滚需验证不会绕过新分享授权、复活撤回或把 cancelled 当 published。专业支持流程停用与学生紧急帮助不能绑定成同一开关。

## 11. 可执行任务拆分与依赖

每项开始前建 `codex/` 分支，标记涉及现有模块；每项完成后提交可复现测试证据。当前下表状态全部为 TODO，不是已完成功能。

### 11.1 P0：必须先完成的非视觉业务与保护

| ID | 责任角色 | 任务/具体文件方向 | 依赖 | 完成条件 |
|---|---|---|---|---|
| ES-01 | 产品/专业/隐私 + BE | 冻结第 1/3/4 节；实现 ExpressionPolicy 载入/校验、合成配置；准备两种告知文本 | 无 | 未配置拒绝启用；用途和留存无隐式生产默认；T-02/T-19 |
| ES-02 | BE | types.ts、auth.ts、emptyState 增加实体/细分权限；新 domain/expression-support.ts | ES-01 | 老快照兼容、未授权拒绝、密文 DTO 不泄漏；T-03/T-04 |
| ES-03 | BE/DB | 新增 002 迁移、5 表/复合约束/RLS、consents/outbox 状态扩展；更新 roles 示例和 CI 精确断言 | ES-02 | 干净库和旧库升级通过；跨租户/跨校关系与约束测试；T-22 |
| ES-04 | BE | 新用途 create/list/withdrawConsent，actor、年龄、当前版本校验，新增用途副作用 | ES-02 | 不复用 assessment 同意；重同意不复活；T-02/T-16 |
| ES-05 | BE | 记录创建/列表/详情/删除、字段白名单、8 KiB body、HMAC 幂等 | ES-02/ES-04 | 本人范围、纯文本、安全重试、删后不可重建；T-03/T-04/T-08 |
| ES-06 | BE | 分享创建/查询/详情/撤回；收件人目录、期限、单有效分享约束 | ES-03/ES-05 | 指定对象读取、到期即时拒绝、撤回竞态；T-05/T-06/T-07 |
| ES-07 | BE | 普通请求及工作备注、状态机、version、截止时间和活动唯一约束 | ES-03/ES-04/ES-06 | 不写危机表，跟进可记录，终态不可重开；T-08/T-11/T-20 |
| ES-08 | BE/运维 | Worker routine 事件、cancelled、通知前校验、逾期/跟进扫描和备援元数据 | ES-07 | 重试/取消/失去收件能力不误报；T-09/T-18 |
| ES-09 | BE/隐私 | 扩展 rightsAccessPackage、purgeStudentData、processRetention、单条台账、恢复检查点 | ES-03/ES-04/ES-05/ES-06/ES-07 | 权利包、密文清除、最小留存、恢复不复活；T-10/T-16 |
| ES-10 | FE | student-web 四卡片、当前授权提示、状态反馈、无摄像头路径 | ES-04/ES-05/ES-06/ES-07 | 键盘/移动端可操作，换人无残留；T-01/T-06/T-17 |
| ES-11 | FE | admin-web 普通收件箱/受控详情/接单跟进/备注/失效刷新 | ES-06/ES-07/ES-08 | 不借全校 case 权限放大读取；T-07/T-11/T-16/T-17 |
| ES-12 | QA/安全 | 建行为、API、浏览器、数据库与恢复测试；接 release gate/安全检查 | ES-03/ES-08/ES-09/ES-10/ES-11 | T-01 至 T-11、T-16 至 T-22 适用项通过；缺覆盖明确记录 |

### 11.2 P1：可选视觉与合成演示

| ID | 责任角色 | 任务/具体文件方向 | 依赖 | 完成条件 |
|---|---|---|---|---|
| ES-13 | FE/安全 | SDK 与模型许可核验、固定版本、自控资源、生命周期控制器和 worker | ES-01/ES-04 | 无业务 token/动作日志；拒绝/迟到/异常可退出；T-12/T-13/T-14 |
| ES-14 | FE/BE | 仅学生页权限头、资产白名单、最小 CSP、capabilities 租约及独立开关 | ES-13 | 其他路由继续禁相机；开关/撤回停机；T-12/T-15/T-19 |
| ES-15 | QA/安全 | 视觉实机、网络/内存/存储检查、无摄像头完整回归 | ES-10/ES-11/ES-13/ES-14 | T-01/T-12 至 T-15/T-17/T-20，形成 E-VIS；无真实学生材料 |
| ES-16 | FE/设计/市场 | docs/expression-demo 固定合成交互；按营销文档制作演示和主张证据表 | ES-10/ES-11；不依赖视觉真实采集 | 不申请摄像头、不输入真实文本、不发 API；视觉只用动画 |

### 11.3 P2：独立审批后再做

- ES-17：校级流程指标。先明确用途/小样本保护/分母口径，再实现聚合；不扩展成情绪分布或学生排名。依赖 ES-12、单独统计评审。
- ES-18：更多设备和学段。依据支持矩阵和适龄证据逐一纳入，不直接复制初中规则。依赖相应专业、隐私和服务能力评审。
- ES-19：真实校园受控试点。依赖原项目全部生产门槛及 E-GOV/E-PRIV/E-FLOW/E-OPS；选择视觉时再加 E-VIS。缺外部批准只阻断真实启用，不阻断合成开发。

关键路径：ES-01 → ES-02/ES-03/ES-04 → ES-05/ES-06/ES-07 → ES-08/ES-09 → ES-10/ES-11 → ES-12 → 真实准入。视觉 ES-13–15 可不做，不能成为核心业务发布的前置条件；相应营销主张保持未实现。

排期规则：先由实际开发团队对每项给出估算与可用人员，再形成日历计划。此前讨论的“2 人、4–6 周参考版”仅是未校准假设，不是工期或采购承诺。基础生产适配器与校方审核时间必须单列。

## 12. 验收矩阵与测试执行

### 12.1 必测用例

| ID | 场景 | 可判定的通过标准 |
|---|---|---|
| T-01 | 无摄像头全路径 | 不调用 getUserMedia 也能保存、分享、发请求、查看接单、取消、预约和帮助 |
| T-02 | 用途/年龄/拒绝 | 无同意、过期版本、未知年龄、伪监护、错 actor 均拒绝新处理；拒绝摄像头不影响其他用途 |
| T-03 | 输入与输出 | 8 KiB/字数边界、额外 JSON 字段、HTML/控制字符、空内容被正确处理；无原始密文字段/主题日志泄漏 |
| T-04 | 身份与跨校 | A 学生/B 学生、同租户不同校、不同租户、非指定咨询师、班主任、运维枚举 ID 均不能读正文 |
| T-05 | 分享创建与到期 | 一个 active，选定收件人，精确到期边界拒绝读取；不靠定时器才能失效 |
| T-06 | 撤回与迟到响应 | 撤回后新请求拒绝；旧异步响应不覆盖已清空界面；换人后正文/表单/摄像头无残留 |
| T-07 | 分享正文与主档案 | 仅指定且当前有效权限可解密；case/report 全校角色不等于分享权；主档案不暗含自述 |
| T-08 | 并发/幂等 | 10 个相同键创建只落一条；换键也不绕过活动请求唯一性；竞争转换只成功一个；删后重试不重建 |
| T-09 | 通知取消与重试 | 撤回/取消/接单后待发提醒被抑制并记 cancelled；丢响应重试不重复通知；不记录 published 假成功 |
| T-10 | 删除/恢复 | 单条删、到期、全人删除、rights 包与备份恢复全部不复活内容；缺最新台账时不开放读取 |
| T-11 | 普通请求与备注 | 仅指定接收人、版本正确可操作；同校管理员看不到备注；结束只改变工作流，不改危机或评分 |
| T-12 | 视觉生命周期 | 拒绝、退出、隐藏、pagehide、异常、迟到授权、3 分钟到期、远程撤回均停止 track/worker；不自动重启 |
| T-13 | 视觉数据不外传 | 在批准的浏览器/构建中检查请求内容、日志、存储及 API DTO：无帧、关键点、动作、模板；允许自控资源和无视觉字段的能力请求 |
| T-14 | 供应链 | 锁版本、模型/SDK 分别有许可记录、哈希与实际加载文件相符，无 CDN/遥测/回放脚本 |
| T-15 | HTTP 安全 | 只有批准的 student 页面可申请视频；其他路由 camera=()；路径穿越失败；无麦克风/地理位置权限扩张 |
| T-16 | 多途径撤回 | 学生/核验监护人撤回、告知更替、收件人停用、学校变更、rights 处理后访问都即时重验；重新同意不恢复旧分享 |
| T-17 | 浏览器 E2E | 学生→分享→请求→教师接单→跟进→学生状态→撤回；窄屏、键盘、会话过期及慢网反馈均可完成 |
| T-18 | 故障与接续 | 通知供应商失败/未知、无人接单、备援不可用、跟进重复扫描均有可审计结果；不静默遗失，不提高心理风险 |
| T-19 | 开关与准入 | 默认关闭；少配置/证据拒绝真实启用；关闭后核心历史/权利/取消/帮助路径仍可用；视觉独立停用 |
| T-20 | 禁止用途防回归 | 视觉 schema 不能进业务 DTO；普通提交/话题/面部动作不产生 RiskSignal/ScoreRun，学生自述没有自动情绪标签 |
| T-21 | Pages 合成演示 | 无摄像头调用、真实文本输入、token、生产 API 或第三方追踪；静态失效链接与假成功反馈为失败 |
| T-22 | 数据库升级与隔离 | 001→002 和已有库→002均通过；新增5表 FORCE RLS/策略/FK/索引存在；跨租户、错误学校关联、非法状态均被拒绝 |

T-13 不能靠“源码里搜不到 fetch”判通过；T-12 必须同时包含可重复模拟测试与获准的实机资源释放检查。使用合成渲染面部 fixture 验证管线；必要的人工相机检查只限明确同意的成年测试者，禁止录制/上传其影像。

### 12.2 执行命令与新增测试文件

现有基线检查：

```sh
npm run build
npm test
npm run security:check
python3 scripts/check_plan.py
python3 -m unittest discover -s tests -v
```

开发 ES-12/15 时新增：

- `test/expression-support.test.js`：领域/并发/幂等/到期/撤回。
- `test/expression-api.test.js`：真实 HTTP、字段白名单、角色与对象权限。
- `test/expression-recovery.test.js`：新增集合和删除/恢复重放；加密包访问。
- `test/e2e/expression.spec.ts`：浏览器完整路径/会话 epoch/清理。
- `test/e2e/visual.spec.ts`：可选视觉生命周期、网络和资产。
- `test/e2e/pages-expression.spec.ts`：无摄像头合成演示。
- `infra/tests/expression-support.sql`：新增数据库约束与 RLS，接入现有 Postgres CI。

新增 devDependency 和浏览器测试配置必须锁版本；ES-12 在 package.json 定义 `test:e2e:expression`（核心与 Pages）和 `test:e2e:visual`（视觉），然后运行：

```sh
# 以下脚本待 ES-12 实现，现在不存在，不能报告已经通过。
npm run test:e2e:expression
npm run test:e2e:visual
```

支持矩阵：至少验证 Windows 的 Chrome/Edge、macOS Safari、iOS Safari、Android Chrome 的选定实测版本；记录具体版本/设备/构建哈希，不写“全平台兼容”。无支持设备须降级无摄像头完整流程。

参考性能验收目标（不是现有成绩）：100 并发合成 API 请求下 p95 ≤ 1 秒、非预期 5xx 为 0；视觉在参考设备上交互 p95 ≤ 200 ms，达不到则降低渲染负载或回退无摄像头，不偷偷改成服务端视频分析。参考设备、浏览器、时长、样本量由 ES-12 开始时登记，禁止只凭单次观感验收。

## 13. 开发启动顺序与未决事项

拿到本文件后可直接启动 ES-01/02 的合成配置与契约实现，再按依赖推进；本次文档请求不授权立刻编写功能、联系学校或部署真实服务。

| 必须明确的生产事项 | 责任人 | 未明确时允许做什么 / 不允许做什么 |
|---|---|---|
| 具体试点学校、学段、人员名单和服务时限 | 校方 + 专业负责人 | 允许合成流程；不接真实联系请求 |
| 用途合法性、同意文本、未成年人与监护安排 | 隐私/专业负责人 | 允许模拟同意；不把监护布尔字段当真实证明 |
| 各类留存期、例外保留、备份窗口和恢复台账 | 隐私 + 运维 | 允许固定 fixture 演练；不启用真实存储 |
| 实际生产 Store/身份/通知及其他 M4 缺口 | 技术负责人 | 允许现有参考适配器；不把 JSON 改为生产允许 |
| SDK 与模型商业授权、目标设备 | 前端 + 安全负责人 | 允许预设动画；未确认前不发布真实摄像头组件 |
| 客户需求和价格 | 产品/销售 | 允许合成访谈材料；不虚构客户认可/效果/采购价格 |

本扩展的工程完成不代表原有 48 项任务全部完成，也不代表具备医学效能；所有真实上线证据仍按[安全治理](05-safety-privacy.md)、[测试与试点验收](08-verification.md)、[生产运行手册](11-production-runbook.md)执行。
