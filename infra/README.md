# 基础设施说明

`migrations/001_initial.sql` 是 PostgreSQL 参考迁移，包含租户复合外键、敏感数据最小字段、会话撤销、无手机学生一次性凭证、名单导入预检哈希、普通学年频次唯一约束、专业复评例外、媒体资源关联和行级安全策略。所有业务表均启用并 `FORCE` RLS（当前共 36 张表）；当前默认本地运行使用加密 JSON 适配器，因此不需要 Docker 或外部数据库。

生产接入 PostgreSQL 前必须：

- 由迁移身份执行 SQL；应用角色不拥有表、不具备 `BYPASSRLS`。
- 可参考 `roles.sql.example` 建立独立的应用角色；示例密码只是占位符，必须由 Secret Manager 注入并在部署时轮换。
- 每个请求在事务内设置 `app.tenant_id`，连接池回收时清理；没有上下文默认拒绝。
- 复评例外使用单独的 `exception` 频次记录，不覆盖原始年度场次；正常 `reserved/consumed` 记录仍由部分唯一索引保护。
- 媒体资源只允许经应用类型/签名/大小检查的内容，正文通过 `PrivateObjectStore` 写入私有对象存储，且必须通过已审核教育内容关联后才可公开读取。默认入口的 `EncryptedFileObjectStore` 只用于合成开发，目录由 `CAMPMIND_OBJECTS_DIR` 指定并被 `.gitignore` 忽略；生产需设置 `CAMPMIND_OBJECT_STORE_ADAPTER_READY=true` 并注入私有桶/KMS 适配器。
- 补齐其它业务表的同租户外键、RLS、字段权限、备份删除重放和恢复演练。
- 仅使用合成数据验收迁移；不要把示例密码或本地 master key 带入生产。
