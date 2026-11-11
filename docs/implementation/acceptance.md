# PRISM MVP 实施与验收记录

日期 2026-11-08 · 状态 Implemented candidate, production acceptance pending

当前仓库提供可运行的 Web、Expo iOS、共享 API、数据库与 Worker。核心产品闭环已实现，并有核心逻辑、SQL/API、SQLite 和浏览器回归检查。此状态不等于 PRD 的全部 Definition of Done：生产上线、真实设备和连续两周 beta 尚未完成。

## 实现范围

| 范围              | 当前实现                                                                        | 验证入口                                                    |
| ----------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Foundation        | TypeScript monorepo、共享命令、OpenAPI 类型、统一 SQL Schema、开发启动器        | pnpm typecheck；[接口契约](../api/openapi.json)             |
| Knowledge 与 FSRS | 知识 CRUD、LaTeX、独立卡片、四档评分、权威调度、历史与原始提交保留              | tests/core/fsrs.test.ts；tests/api；tests/e2e/prism.spec.ts |
| Research          | 项目、研究对象、数学状态、证据范围、任务、知识/论文关联和审计                   | API 与浏览器研究闭环                                        |
| Fitness           | 动作、模板、实际会话、组与 cardio、单位归一、历史与事后编辑                     | API、SQLite 与浏览器训练闭环                                |
| arXiv             | 订阅、定时抓取、Atom 校验、去重、版本、匹配解释、收藏与阅读任务                 | tests/core/arxiv.test.ts；Worker/API 与浏览器 fixture       |
| Planner 与 Today  | 容量、任务汇总、review batch、固定、手动顺序、延期解释、超载和日终回顾          | tests/core/planner.test.ts；浏览器规划闭环                  |
| Mobile offline    | SQLite 原子本地写入/outbox、稳定操作 ID、依赖链、快照、冲突与重试               | apps/mobile/tests                                           |
| Export            | 一致快照、JSON/Markdown/manifest、私有 ZIP、状态与过期                          | API 导出检查与真实浏览器下载                                |
| Authentication    | API OIDC JWT 与账户 allowlist；Web PKCE、ID token、Redis 会话；移动安全凭据存储 | API 与会话安全测试；真实身份服务联调待完成                  |
| Reliability       | RLS/复合所有权 FK、不可变历史、幂等、作业租约和有界重试、恢复工具               | 真实 PostgreSQL 与本地恢复演练                              |

实际数据库访问采用 SQL-first repository，生产为 PostgreSQL，开发为文件持久化 PGlite。两者共享 Schema 和领域逻辑，不以客户端预测覆盖服务器 FSRS 状态。[ADR](../architecture/adr-001-sql-repositories.md) 说明这一实现选择；[TDD](../architecture/tdd.md) 保留事务、同步和数学状态规则。

## 当前自动化验证

以下检查已在最终回归中运行；以 [finalchecks.json](../verification/finalchecks.json) 的源文件标识与各套件实际输出为准，不将重复运行的同一套件简单相加。

| 检查                                    | 观察到的结果         | 能证明的范围                                                    |
| --------------------------------------- | -------------------- | --------------------------------------------------------------- |
| Web TypeScript 与 Next production build | 通过                 | 类型检查、路由与服务端/客户端构建                               |
| 核心逻辑                                | 通过                 | 维护中的 FSRS 实现、确定性规划、时区/DST、单位和 arXiv 规范化   |
| API 与 SQL 集成                         | 通过                 | 请求校验、事务、幂等、审计、实体关系、导出与授权                |
| 真实 PostgreSQL                         | 本地隔离实例检查通过 | 非 owner/RLS、真实 SQL 约束与数据库事务行为；不代表托管生产环境 |
| 移动 SQLite 与身份/同步回归             | 通过                 | 本地原子写入、丢响应重试、依赖冻结、冲突和恢复逻辑              |
| Expo iOS Hermes export                  | 通过                 | JavaScript/Hermes bundle 与资源可导出；不等于原生签名构建       |
| Playwright 产品与安全验收               | 当前完整套件通过     | 真实 Web/BFF/API 产品闭环、窄屏和键盘、评分重试、安全边界       |
| 本地 PostgreSQL dump/restore            | 通过                 | 恢复后全部表记录数量和行哈希一致，包含复习和研究历史            |

主要命令：

```sh
pnpm typecheck
pnpm test
pnpm test:api
pnpm test:mobile
pnpm test:postgres
pnpm build
pnpm test:e2e
pnpm verify:restore
```

其中真实 PostgreSQL 与恢复命令依赖隔离测试实例、被忽略的 .data/test-postgres.env 和指定 Docker 容器；使用方式见 [操作手册](../operations/deployment.md)。不能用个人或生产数据库充当可清理的测试库。

## 浏览器验收覆盖

浏览器测试由 Playwright 启动独立 Web 与 SQL API，使用临时数据库。产品闭环中的外部 arXiv 网络响应替换为明确的测试 Atom 元数据；知识、评分、研究、训练、规划和导出不使用模拟产品 API，也不写入个人开发数据库。身份与会话安全回归使用测试密钥、会话及受控令牌响应，不能据此宣称真实 OIDC 登录与刷新已验收。

已覆盖的操作包括：

- 新建数学知识和两张卡片，验证复习一张不修改另一张，揭示答案、评分并读取历史。
- 在服务器已提交评分后丢弃响应，重试完全相同的命令，确认只保存一条 canonical review event。
- 新建研究项目、猜想和有限范围计算证据，创建并完成任务，确认数学状态不被任务完成自动改变。
- 创建动作与模板，记录实际重量、次数和有氧，完成后修改组，检查换算、历史和进展。
- 订阅 math.AC，等待后台 fixture 抓取，收藏、标记已读并创建关联阅读任务。
- 设置容量、手动重排、保留 pin、显示不可能容量下的超载，完成任务并保留任务池。
- Inbox 分类、保存偏好并下载真实 ZIP 导出。
- 在 430px 宽度下导航，检查页面无横向溢出、快捷键打开模态框、输入焦点与 Escape。
- 拒绝伪造 Origin 的修改；限制声明与实际流式请求体，包括缺失或不实的 Content-Length。
- 注销发生在 token refresh 中途时，旧会话不能被刷新写入复活。
- 编辑任务或项目的其他字段时，保留含毫秒与 DST 重叠的原始截止 instant。

测试源见 tests/e2e；[HTML 报告](../../output/playwright/report/index.html) 为本地生成产物，不提交到版本库。真实身份服务完整交互、Safari/VoiceOver 和原生设备行为需要后续实机验收。

## 数据和恢复证据

[本地备份恢复记录](../verification/backup-restore.json) 来自填充了知识、FSRS 事件、研究审计和训练组的独立 PostgreSQL 测试数据库。演练创建新恢复库，执行 dump/restore，再比较全部表的数量与行哈希；不会覆盖已有数据库。

这证明本地数据库恢复路径可行。生产对象存储、备份加密与异地保留、密钥恢复、托管数据库权限和实际恢复耗时仍需在部署环境验证。用户导出的 ZIP 是数据所有权与迁移格式，不替代灾难恢复备份。

恢复投入服务前还须按操作手册轮换同步流代际，不能只等待 revision 数字重新增长。移动端检测到 STREAM_RESET 或 CURSOR_AHEAD 后，会先保留当时的完整设备副本及全部本地 outbox 历史，再重新取得快照；已确认的旧评分不会自动重放。回归检查覆盖服务器历史回退、快照清理后的重试、待同步录入保留，以及恢复 JSON 在文件 SQLite 重开后仍可读取。副本可供人工核对和恢复，不保证补回备份 RPO 内仅存在服务端的数据。

## PRD Definition of Done 对照

| 条件                            | 当前结论                                                              |
| ------------------------------- | --------------------------------------------------------------------- |
| Web 和 iOS 使用同一生产 Backend | 共享 API 和本地联通路径已实现；生产部署未完成                         |
| Knowledge 与 FSRS 端到端可用    | 已实现并有自动化闭环；真实设备网络场景仍需验收                        |
| 研究对象与数学状态历史保留      | 已实现并验证；不声称形式化认证数学正确性                              |
| Fitness 可记录和分析            | 已实现，含事后编辑与兼容单位比较；原生设备体验待验收                  |
| arXiv 自动更新                  | Worker 定时抓取与处理已实现并用 fixtures 验证；生产外部链路待上线确认 |
| Planner 汇总所有相关任务        | 已实现确定性规则、手动覆盖、容量与延期解释                            |
| 核心移动记录离线可用            | SQLite 与 outbox 已实现并测试；真实设备断网/杀进程待验收              |
| 跨设备同步可靠                  | 幂等、版本、快照和冲突协议已实现并回归；多台真实设备长期使用待完成    |
| 用户数据可导出                  | JSON、Markdown、manifest 与私有 ZIP 已实现并测试                      |
| 关键自动化测试通过              | 当前套件通过；发布必须对固定提交重新运行最终检查                      |
| 备份可恢复                      | 本地 PostgreSQL 恢复已验证；生产恢复未验收                            |
| 连续两周无发布阻断缺陷          | 尚未开始，不能以自动化测试代替                                        |

## 尚未完成的发布事项

这些是发布前的真实依赖，不能通过本地构建或测试代替：

- 实际 OIDC issuer、Web/iOS client、允许账户、redirect URI 与生产密钥；真实登录、刷新和退出联调。
- 管理的 PostgreSQL/Redis、持久存储、托管环境、域名和 TLS、监控与生产备份恢复。
- Apple Developer、App Store Connect、EAS project、APNs 凭据、iOS 原生签名构建与 TestFlight 分发。
- 完整 Xcode、iOS 模拟器或真机，真实断网训练/复习、杀进程恢复、两设备并发、通知点击、导出分享与 VoiceOver。
- 生产环境下的容量、响应延迟、可用性和连续两周 beta；99.5% 与 P95 目标尚不是测得的生产保证。

[Dockerfile](../../Dockerfile)、[Compose](../../docker-compose.yml)、[CI](../../.github/workflows/ci.yml) 与 [部署手册](../operations/deployment.md) 提供可执行的部署准备，不表示已经部署。任何评分或训练数据丢失、重复调度、跨账户访问、审计覆盖、论文重复失控或恢复失败，仍会阻断发布。
