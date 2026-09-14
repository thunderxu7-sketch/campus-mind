# 表达与支持扩展 · 执行状态与证据

更新时间：2026-09-14  
范围：`codex/implement-mvp-foundation` 本地参考实现；只使用合成身份和合成文本。

## 已按依赖顺序落地

### P0 核心业务（ES-01–ES-12）

- **配置与同意**：受控部署注册表中的 `ExpressionPolicy`、版本化 `ExpressionNotice`、`self_expression` / `visual_interaction` 用途、年龄与未满 14 岁监护人校验；默认演示策略关闭视觉互动。
- **学生端**：表达记录（加密、仅本人默认可见）、限时单一分享、支持人员目录、主动支持请求、取消/撤回、换人清理和异步 epoch 防旧响应覆盖。
- **专业端**：指定收件人的分享详情、普通支持收件箱、接单/开始沟通/跟进/完成状态机、加密工作备注；与危机线索工作台分离。
- **后端**：字段白名单、8 KiB 请求上限、服务器 HMAC 幂等、版本冲突、活动请求唯一约束、通知 outbox 的 routine 事件与取消状态。
- **隐私与恢复**：单条删除、用途撤回、权利 access 包、全人清理、保留任务（记录/分享/已结束请求/备注）和最小撤回台账。
- **数据库**：`infra/migrations/002_expression_support.sql` 增加五张租户运行数据表、复合外键、部分唯一索引、RLS + FORCE RLS，并扩展 consent/outbox CHECK；CI 会执行 001→002、数量和索引断言。策略/告知版本是受控、版本化部署注册表，由参考种子和生产配置适配器提供，不在迁移里做成可被业务写入的表。
- **契约**：`docs/openapi.yaml` 已登记新增 HTTP 路由；`.env.example` 与 `scripts/release-gate.mjs` 增加显式上线证据开关。

### P1 安全开关与合成演示（ES-14、ES-16 基线）

- `/student/visual-interaction.js` 只负责显式摄像头生命周期、track 释放、隐藏/pagehide 停止和 3 分钟资源上限；没有情绪模型、网络发送、业务 token 或动作日志。
- 全站默认 `camera=()`；仅当 `GET /student` 且 `CAMPMIND_EXPRESSION_ENABLED=true` 与 `CAMPMIND_VISUAL_DEPLOYMENT_ENABLED=true` 同时满足时，响应头才允许 `camera=(self)`。API、管理端和静态资源继续禁用摄像头。
- `docs/expression-demo/` 是离线固定合成动画，不申请摄像头、不登录、不调用 API、不接受真实文本。

## 可复现验证

在仓库根目录执行：

```sh
npm run build
npm test
npm run security:check
python3 scripts/check_plan.py
git diff --check
```

数据库参考迁移（需要本地 PostgreSQL）：

```sh
psql ... --set ON_ERROR_STOP=1 --file infra/migrations/001_initial.sql
psql ... --set ON_ERROR_STOP=1 --file infra/migrations/002_expression_support.sql
```

当前测试覆盖：学生记录/分享/支持生命周期、同意撤回、幂等冲突、字段白名单、8 KiB 限制、专业对象授权、普通请求不产生 `RiskCase`、静态页面头、JSON 快照兼容、迁移表/RLS/索引检查。真实浏览器、实机摄像头、供应商故障与生产适配器尚未作为通过证据。

## 尚未完成且不得营销为已实现

1. **ES-13 / ES-15**：真实 SDK/模型的许可证、锁版本/哈希、目标浏览器实机资源释放、网络/存储/性能证据；在证据完成前不得启用视觉开关。
2. **ES-17**：经统计评审的小样本保护、分母口径和校级流程指标；不得展示个体心理状态分布或排名。
3. **ES-18**：更多设备与学段的适龄、服务与兼容性证据；初中合成策略不能直接复制。
4. **ES-19**：真实校园试点、用途/监护/留存审批、PostgreSQL/身份/通知/对象存储生产适配器以及原项目 M4 Gate。

### 关闭与回滚

发现越权、正文/视觉数据外传、摄像头未停止、无人接续或误导性心理推断时，先关闭相应 feature flag，保留帮助、取消、撤回和权利入口；不 DROP 表、不把普通支持请求改写成危机结论。

