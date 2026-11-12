# PRISM

Personal Research, Intelligence & Self-Management

PRISM 将数学知识与复习、研究项目、训练记录、arXiv 动态和每日规划连接在同一个个人工作区。当前仓库已实现可运行的 MVP 候选：Next.js Web、Expo iOS 客户端、共享 TypeScript 业务层、Fastify API 与后台 Worker。

这不是已经完成生产验收的发布版本。生产身份服务、托管与 TLS、Apple 签名和 TestFlight、真机测试及连续两周 beta 尚未完成。功能与验收边界见 [实施验收记录](docs/implementation/acceptance.md)。

## 本地启动

0.2 外观更新：界面与系统提示改为英文，加入统一的棱镜图标、系统字体、明暗主题及克制的动态效果。Mac/Web 在 Settings → Appearance 可调整文字大小、阅读字体、密度、强调色、对比度、透明度和动态效果；iOS 提供本机保存的主题、文字大小及减少动态效果。原有用户内容保留原语言。详见 [外观更新说明](docs/implementation/appearance.md)。

Mac 桌面应用已可通过 pnpm build:macos 构建并安装到 ~/Applications/PRISM.app，双击使用独立窗口。此个人本地版仍依赖当前项目与 Node 环境；详见 [macOS 指南](apps/macos/README.md)。iOS 的 TestFlight 安装前置条件见 [iPhone 安装指南](docs/operations/iphone-installation.md)。

本机可以双击 [start.command](start.command)，或在项目目录运行 ./start.command。启动器优先使用已安装的 Node.js 24，也能使用这台 Mac 已有的 Codex runtime；关闭终端或按 Ctrl+C 停止服务。首次启动若缺少依赖会执行锁定版本安装。

双击启动会在服务就绪后打开浏览器。重复启动会打开已运行的同一实例，不会再占用一次端口；停止服务需在首次启动的终端按 Ctrl+C。其他程序占用 3000 或 API 端口时，启动器会在创建服务前给出提示，并保留占用程序。无浏览器环境可设置 PRISM_OPEN_BROWSER=0。

启动器回归检查为 pnpm test:launcher，需先停止本地 PRISM 并空出 3000/4000；它使用临时数据库目录验证重复启动、端口占用和退出清理。

需要 Node.js 24 与 pnpm 11。依赖精确版本由 pnpm-lock.yaml 固定。

```sh
node --version
pnpm --version
pnpm install --frozen-lockfile
pnpm dev
```

开发启动器会启动共享 API 和 Web：

- Web：<http://localhost:3000>
- API：<http://127.0.0.1:4000/api/v1>

默认使用文件持久化的 PGlite PostgreSQL 引擎，数据放在被 Git 忽略的 .data 目录；无需先安装 Docker。开发 API 内运行自动化 Worker 与导出处理。首次使用没有虚构的知识、训练或论文数据，建立自己的记录后仪表盘会随之更新。

可选地将 [.env.example](.env.example) 复制为根目录 .env，配置本地参数；开发启动器会读取它。请保留 PRISM_WEB_ORIGIN 与实际浏览器地址一致。开发模式明确限定 loopback，无需登录，不能作为局域网或生产部署方式。停止开发启动器会同时停止其子进程。

需要分别启动时：

```sh
pnpm dev:api
pnpm dev:web
pnpm dev:worker
```

单独命令需要在进程环境中提供相应配置；开发模式须显式设置 PRISM_AUTH_MODE=development。改用 PostgreSQL 时单独运行 Worker，不能与文件 PGlite 的开发内嵌 Worker 同时重复运行。

## 启动 iOS 客户端

保持 API 运行，在另一个终端执行：

```sh
EXPO_PUBLIC_DEV_AUTH=1 pnpm dev:mobile
```

模拟器可使用 http://127.0.0.1:4000/api/v1；也可在应用首次连接设置中显式启用开发模式。该模式仅用于开发构建与 loopback 联通，发布构建不提供认证绕过。真机使用可访问的 HTTPS 后端与 OIDC 登录，可通过 EXPO_PUBLIC_API_URL 设置初始地址。

知识录入、评分和训练记录先原子写入本地 SQLite 与 outbox，再同步至同一 API。网络重试沿用原操作标识，冲突保留设备与服务器副本。Web 的失败修改保留在表单中供重试；持久化离线录入由移动端承担。

安装完整 Xcode 后，可运行 pnpm --filter @prism/mobile ios。Expo Hermes bundle 导出不等于原生签名构建，也不等于 TestFlight 分发。连接、离线协议、EAS 与真机验收说明见 [iOS 指南](apps/mobile/README.md)。

## 五个使用闭环

1. 在 Knowledge 新建 Definition、Theorem 或其他知识对象，编辑 LaTeX 并查看预览。为陈述、证明或应用分别建立卡片，在 Review 中先回忆、再揭示、再用 Again / Hard / Good / Easy 评分。服务器执行 FSRS 并保存独立卡片的历史与下次到期时间。
2. 在 Research 创建项目、研究问题与猜想，记录证明尝试和计算证据。计算验证须写明范围与结果，已证明状态须有证明文本或引用；状态变化进入时间线。创建关联任务后，完成任务不会自动认证猜想。
3. 在 Fitness 建立动作与模板，开始训练，记录实际组、重量、次数、RPE/RIR 与有氧活动。完成后仍可修正记录并比较同一动作的历史；模板修改不改变过去会话的快照。
4. 在 Discover 订阅 arXiv 分类、关键词、作者或主题。Worker 抓取元数据、去重并保留版本；可以收藏、标记已读、关联研究项目或创建阅读任务。排序会展示匹配原因。
5. 在 Today / Planner 设置可用分钟，生成汇总计划，手动固定、重排、延后或完成任务。无法容纳的任务保留并解释原因，超载会明确显示。任务池保存未排入今日的工作，Inbox 用于快速捕捉，日终回顾保存当天进展。

Settings 提供个人时区、保持率、复习上限、静默时间、摘要偏好、同步冲突与私有 ZIP 导出。导出包含结构化 JSON、知识与研究 Markdown、记录数量和校验和。

## 工程结构

```text
apps/
  web/                 Next.js 工作区、OIDC BFF 与 Redis 会话
  mobile/              Expo iOS、SQLite 副本与离线 outbox
  api/                 Fastify transport、认证与请求校验
  worker/              arXiv、每日自动化、通知与作业执行
packages/
  core/                共享命令、事务和领域业务规则
  database/            PostgreSQL / PGlite SQL repository
  fsrs/                固定版本 FSRS 适配器
  planner/             确定性每日规划
  api-client/          共用 HTTP client
  types/               从 OpenAPI 生成的接口类型
  shared-utils/        时区、单位等纯逻辑
database/schema.sql    SQL 约束、索引、RLS 与历史保护
tests/                 核心、API、数据库与浏览器验收
docs/                  技术设计、操作手册和验证证据
```

数据库采用 SQL-first repository，保留复合所有权外键、CHECK、生成列、RLS 与不可变历史约束。生产 API/Worker 使用 PostgreSQL，开发和部分测试使用兼容 SQL 的 PGlite；两者使用同一 Schema 与领域命令。实现选择和原 TDD 的差异见 [SQL repository 决策](docs/architecture/adr-001-sql-repositories.md)。

[OpenAPI](docs/api/openapi.json) 定义请求、响应、幂等与版本前置条件。修改契约后运行 pnpm generate:types 更新 packages/types；业务规则不应分别复制到两个客户端。

## 验证

```sh
pnpm typecheck
pnpm test
pnpm test:api
pnpm test:mobile
pnpm build
pnpm test:e2e
```

pnpm test 运行 FSRS、规划、时区、单位换算与 arXiv 核心测试。API 测试覆盖持久化、重复请求、冲突与授权；移动测试使用真实 SQLite adapter 检查离线与恢复。pnpm build 包含 Web production build 与 iOS Hermes bundle 导出。

浏览器测试使用独立的 4100 API、3100 Web 和临时 SQL 数据库，不操作个人开发数据库。产品闭环使用真实产品 API，外部 arXiv Atom 传输使用测试元数据；身份与会话安全回归另使用测试密钥、会话和受控令牌响应，不代表真实身份服务已联调。测试涵盖五个闭环、私有导出、丢响应后评分去重、窄屏与键盘，以及 BFF 安全回归。首次运行可能需要 pnpm exec playwright install chromium。

配置隔离 PostgreSQL 测试实例后，可额外运行：

```sh
pnpm test:postgres
pnpm verify:restore
```

真实 PostgreSQL 测试和恢复演练需要独立的测试连接与 Docker 容器，不能指向个人或生产数据库。准备步骤见 [部署与恢复手册](docs/operations/deployment.md)。pnpm verify 汇总常规检查、构建和浏览器测试，不代替真机、生产恢复或两周 beta。

验证证据：

- [最新应用检查结果](docs/verification/finalchecks.json)
- [本地 PostgreSQL 备份恢复记录](docs/verification/backup-restore.json)
- [本次 Playwright HTML 报告](output/playwright/report/index.html)
- [初始工程规格校验](docs/validation.md)，其范围仅为当时的契约和数据库约束

## 生产与发布

生产使用 PostgreSQL、Redis、OIDC allowlisted account 和 HTTPS。MIGRATION_DATABASE_URL 仅供受控迁移、用户初始化和角色配置；运行时 DATABASE_URL 使用非 owner、无 BYPASSRLS 的独立 API 或 Worker 角色。Web 只保存随机会话标识 cookie，访问与刷新令牌在服务器 Redis 中加密保存。

从 [.env.example](.env.example) 与 [部署手册](docs/operations/deployment.md) 配置实际环境。不要将真实令牌或密码提交到仓库。数据库迁移与初始化命令为 pnpm db:migrate、pnpm db:provision、pnpm db:runtime-role，须按手册使用各自的受控连接执行。

[Dockerfile](Dockerfile) 提供 API、Worker、Web 目标；[docker-compose.yml](docker-compose.yml) 提供本地 PostgreSQL 与 Redis；[CI](.github/workflows/ci.yml) 执行可自动化检查。容器定义与 CI 文件已经具备，不表示托管、域名、TLS、生产凭据或 App Store Connect 已配置完成。

发布前仍须完成真实 OIDC 登录与刷新、生产备份和恢复、APNs/EAS、iOS 原生签名与 TestFlight、真实设备断网恢复与同步，以及连续两周使用验收。完整定义和未完成项见 [实施验收记录](docs/implementation/acceptance.md)；技术事务与同步协议见 [TDD](docs/architecture/tdd.md)。

## Practice and appearance

Open Practice → Import exercises to select a text PDF and page range. Review the editable Markdown and LaTeX before saving. The preview flags formulas with uncertain layout and retains the original excerpt for comparison. Imported PDFs and practice records stay in the local workspace.

Settings → Appearance → Translucent surfaces controls the frosted navigation. The reading and editing surfaces use solid backgrounds. The macOS app also honors the system Reduce Transparency setting.

Open **Settings → Getting Started** to view the tutorial in English, Simplified Chinese, or Japanese. The guide covers creating a note, making and reviewing a card, importing PDF exercises, and adjusting the frosted appearance. Switching tutorial languages preserves your checklist progress.
