# PRISM Web

Next.js Web 工作区，默认从同源 `/api/v1` 经过 BFF 访问 `PRISM_API_URL`（默认 `http://127.0.0.1:4000`）。

生产登录使用 OIDC Authorization Code + PKCE。配置 `PRISM_OIDC_CLIENT_ID`、可选 `PRISM_OIDC_CLIENT_SECRET`、`PRISM_OIDC_REDIRECT_URI`、`PRISM_WEB_ORIGIN` 与至少 32 字符的 `PRISM_SESSION_SECRET`。OIDC endpoints 由 API `/auth/config` 提供。不要将身份凭据放进 `NEXT_PUBLIC_` 环境变量。

浏览器只持有加密的随机会话标识 cookie；access/refresh token 在服务器侧使用 `PRISM_SESSION_SECRET` 加密并保存到 Redis。生产必须配置 `REDIS_URL`，缺失时拒绝建立会话。开发可使用进程内存，重启会要求重新登录。Refresh 使用 Redis 租约锁、原子 TTL 更新和轮换令牌；退出会删除服务器会话并清除 cookie。OIDC callback 验证 state、PKCE、ID token 签名/issuer/audience/nonce，再向 API `/me` 检查账户授权。

修改请求检查 Origin 与 Sec-Fetch-Site；不把浏览器传入的 Authorization 直接转发。BFF 同时限制 Content-Length 与实际流式请求体为 1 MiB，包括没有 Content-Length 的请求。生产中未登录请求在读取 body 前被拒绝，只有 GET /auth/config 公开。API 仍独立验证 JWT、账户 allowlist 与所有权。开发 API 的 loopback 模式只由后端显式配置允许，Web 不会在生产绕过认证。所有 API 请求由 BFF route handler 处理，不配置会绕过动态 BFF 的 Next rewrite。

Web 对已加载内容支持离线阅读；失败修改保留在当前表单并可重试，不声称自动后台同步。核心持久离线录入由 iOS SQLite outbox 实现。

## 验证

在仓库根运行 `pnpm exec playwright test`。测试在 4100 启动隔离 SQL API、在 3100 启动独立 Next 输出目录，不读写 3000 开发工作区的个人数据库。arXiv 只在测试入口替换外部 Atom 网络传输，创建/复习/训练/规划/导出均经过真实应用代码。HTML 报告保存在 `output/playwright/report`。

浏览器验收覆盖独立复习卡、已提交但响应丢失的评分重试、研究证据与时间线、训练事后修改、计划超载与手动顺序、后台论文抓取、Inbox 分类、私有导出、窄屏键盘操作，以及 Origin、流式请求体限制、精确截止时间和会话注销竞态的回归检查。
