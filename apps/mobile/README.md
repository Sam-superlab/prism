# PRISM iOS

Expo 原生客户端覆盖 Today、Learn、Research、Fitness、Discover，以及设置、Inbox、冲突处理和导出。数学公式的 KaTeX CSS 与字体随应用打包，显示不依赖 CDN。

## 启动

从仓库根目录安装依赖后，启动 API，再运行：

```sh
EXPO_PUBLIC_DEV_AUTH=1 pnpm --filter @prism/mobile start
```

iOS 模拟器的 API 默认为 http://127.0.0.1:4000/api/v1。也可在首次进入的“连接设置”中显式启用模拟器开发模式。该模式仅在开发构建提供，API 同时限制为 loopback；不要把无需认证的开发 API 暴露到局域网。

真机和发布构建使用 HTTPS 后端与 OIDC Authorization Code + PKCE。通过 EXPO_PUBLIC_API_URL 配置初始地址，也可在应用设置修改。身份服务必须登记与后端 /auth/config 返回的 mobile_redirect_uri 完全相同的地址，并启用对应 public mobile client；不要仅凭应用 scheme 猜测回调路径。Access/refresh token 保存于 Keychain，绑定 API 地址；切换服务器使用独立 SQLite 数据库，不把旧服务器的未同步操作发送到新服务器。

新的 OIDC 登录必须先通过不使用缓存的 /me 授权检查，再将已验证的 canonical account ID 与凭据一同保存。启动、同步和取 token 均核对该身份与本地研究空间；旧版未验证凭据保持锁定并要求重新登录，不删除缓存或 outbox。已退出时只显示连接与登录界面，不显示私人冲突或未同步操作的分享入口。Release 构建不继承 Keychain 中保存的 development=true；旧 HTTP 开发连接会进入 HTTPS 配置流程。

凭据写入按队列串行执行；刷新按 API/会话 singleflight，并对 generation 和原始 Keychain 值作比较后才提交。退出、切换服务器或新的登录会使旧刷新失效，避免晚到的请求复活已删除会话或覆盖新凭据。

## 离线协议

每次离线录入在同一 SQLite 事务中写产品投影和 outbox，之后才显示“已保存到设备”。客户端 UUID 与 operation ID 不因网络重试变化。SQLite 的 canonical 和 provisional 副本分开，冲突不会覆盖用户编辑。同步快照全部下载后才原子安装；未同步 outbox 和编辑副本保留。

离线范围是知识条目、评分、一般或研究任务、Inbox capture，以及实际训练会话、组和有氧记录。复习卡创建、研究对象编辑、动作库和模板维护、论文操作、偏好与导出仍需要网络；不承诺整个客户端的每个操作都可离线完成。

出队按依赖逐项执行。首次发送前，仅使用自己明确依赖的已应用操作返回的目标版本冻结 baseline；发送后不再修改命令，避免丢响应后 hash 改变。训练模板离线启动先创建空会话、显式创建稳定 ID 的动作/组，再关联模板，避免服务器与设备分别生成重复组。

每轮同步在发送待确认操作前先拉取并验证服务器同步流。若服务端因备份恢复返回 STREAM_RESET 或 CURSOR_AHEAD，设备在替换 canonical 副本之前，同事务保存当时完整的 canonical/provisional 记录和全部本地 outbox 历史（包含已确认操作）的独立恢复 JSON。同一旧游标、同一恢复原因的失败重试复用副本。快照被清理或到期时，每轮最多尝试三份快照（首次加两次重试）；安装完成前不替换原数据。

恢复副本保存在 SQLite，不依赖临时下载目录。登录原研究空间后会看到持续提示，可在设置导出 JSON，确认提示不删除副本。恢复不会盲目重放已确认的旧评分或训练；只继续处理 pending 与可重试的 blocked 命令，conflict/rejected 仍待用户处理。每日备份的 RPO 仍可能导致仅存在服务端的新数据损失，设备副本为人工核对与恢复保留证据，不宣称能够自动补回全部服务器历史。

冲突在设置中保留设备与服务器副本；内容可合并，旧评分必须重新回忆。被依赖冲突阻塞的操作只能由用户显式重建为新操作，旧命令仍保留。拒绝的输入可分享原始副本后修正，不会自动循环覆盖。

## Appearance

The interface is English and uses native system fonts with blue accents and neutral surfaces. Settings offers System, Light and Dark themes, four text sizes, and Reduce Motion. Appearance preferences persist in local SQLite metadata and do not create sync commands or modify existing notes. Native OS text scaling remains enabled; mathematical content also scales. The OS reduced-motion preference is always respected, and reduced motion disables sheet transitions.

These preferences and the dark theme have passed type checking and bundle export; native visual, large-text and VoiceOver checks still require a simulator or physical device.

## 校验和分发

```sh
pnpm --filter @prism/mobile typecheck
pnpm --filter @prism/mobile test
pnpm --filter @prism/mobile build
```

测试使用真实 SQLite（Node SQLite adapter）验证原子写入、重复回执、冲突、快照恢复、依赖版本冻结，以及选定 IANA 时区和 DST 转换。身份与凭据并发测试使用受控 SecureStore/AuthSession 替身；真实 Keychain、系统浏览器及身份服务联调仍需设备验证。build 导出 iOS Hermes bundle，不能替代真机或模拟器测试。

安装完整 Xcode 后可运行 pnpm --filter @prism/mobile ios。TestFlight 使用 eas.json 的 production profile；需要用户自己的 Apple Developer 身份、签名和 App Store Connect 应用。构建生产包时设置 EXPO_PUBLIC_DEV_AUTH=0 与 HTTPS API。推送另需 EAS project ID 与 APNs 凭据；设置中的注册操作会明确报告缺失配置，不伪造成功。

发布前必须进行一次真实断网训练、进程结束后恢复、并发评分冲突、OIDC 回调/刷新、通知点击、文件导出和 VoiceOver 检查。本机没有完整 Xcode，因此不声称这些设备测试已完成。
