# GitHub Pages 发布说明

本仓库的 GitHub Pages 是**静态项目说明与规划站点**，发布源为 `main` 分支的 `/docs` 目录，访问地址为：

<https://thunderxu7-sketch.github.io/campus-mind/>

## 边界

- Pages 只托管 `docs/index.html` 等公开说明文件，不运行 Node API、数据库、队列或对象存储。
- 页面只展示合成数据参考实现的产品范围、治理边界和开发文档，不接收真实学生资料。
- 管理端、学生端和 API 只能在本地或经过独立安全审查的服务环境运行，不能把 Pages 地址当作生产服务地址。
- 页面明确提示：筛查结果不是医学诊断，平台不能替代专业判断或紧急救助。
- `/expression-demo/` 是固定合成交互演示，只使用预设状态和动画；不申请摄像头、不登录、不调用 API、不接收真实文本。

## 发布与验证

1. 将 `docs/index.html` 及相关文档提交到 `main`。
2. 在仓库 **Settings → Pages** 中选择 **Deploy from a branch**、`main`、`/docs`，保存后等待 GitHub 构建。
3. 使用 `gh api repos/thunderxu7-sketch/campus-mind/pages` 查看 Pages 状态和最终 URL。
4. 发布后检查首页、移动端布局、仓库链接和安全提示；不要在页面或仓库提交真实个人信息、生产密钥或未授权量表题目。

## 后续切换

如果未来需要独立的前端构建流程，可将静态产物改为专用 `site/` 目录，并在完成 Actions 权限、依赖供应链和发布审查后切换到 GitHub Actions；切换不应改变本页面的隐私与专业治理提示。
