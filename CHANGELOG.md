# OpenClaw 启动器更新日志

---

## v5.0.0-alpha (2026-04-24)

**架构重构**：从 USB 钥匙（ECDSA 签名）改为灵境AI 账号登录模式。

### 新增
- **账号登录体系**：邮箱+密码登录，cookie session 模式（30 天有效）
  - 注册 / 登录 / 退出登录 / session 自动持久化到 U 盘 `auth.json`
  - 验证码发送（灵境后端邮件）
- **多页主窗口**（1180×740）按 v5 设计稿重构：
  - 首页 · Gateway 控制中心：启/停 / 修复 / 打开控制台 + 4 个状态卡 + 日志面板
  - 模型配置：官方模型网格（7 个上架模型）/ 自定义 API Key
  - 模型充值：4 个套餐 / 跳官网充值 / 兑换码 / 自动检测到账
  - 聊天工具：微信 / Telegram / 飞书 三 Tab 一键安装
  - 技能管理：9 个已安装技能扫描 + 搜索 + 分类筛选
  - 环境检查：Preflight 5 项自检 + 一键修复
  - 联系客服：拉灵境后端客服配置 + 诊断信息一键复制
  - 设置：账户信息 / 退出登录 / 版本信息
- **独立登录窗**（480×640）：登录/注册 Tab + 60 秒验证码倒计时 + 运行日志面板

### 中转站对接
- `https://aitoken.homes`（灵境AI / new-api 分支）
- 认证 `/api/user/*` / 模型 `/api/lingjing/model-prices` / 充值 `/api/lingjing/pay/*` / 令牌 `/api/token/*`
- AI 代理走 `/v1/chat/completions` 与 sk-xxx token

### 安全加固
- 自实现 `node:https.request` HTTP 客户端，绕过 Electron Chromium 对 Set-Cookie 的过滤
- `install-skill` IPC 参数严格白名单（只允许 npx / openclaw + 安全字符）
- `getDiskFreeMB` drive letter 严格 `/^[A-Z]$/` 校验
- `validate-api-key` 响应体 1MB 上限
- `onAuthFailed` 事件订阅修复：`window.auth` 与 `window.mainWin` 可并存（旧逻辑互相覆盖）

### 移除
- ECDSA 授权体系（`src/license.js` / `public.pem` / `license.key` / `sign-usb.js` / 授权 U 盘 PS1/BAT 工具）
- `setup.html` 首次配置页（V5 登录流程取代）
- 桌宠窗口（`pet.html` / `pet-preload.js` / `show-pet` / `hide-pet` IPC）

### 测试
- 64 个单元测试覆盖 log-translate / config / api-client / auth 四大模块
- 端到端验证：登录 → 模型选择 → 配置 sync 到 agent → Gateway 启动 → openclaw 控制台打开 → AI 正常回复

---

## v4.0.0 (2026-04-18)

### 适配
- 适配 openclaw 4.2+ 内置飞书插件：推荐插件区域飞书按钮显示为"已安装"
- 技能商城和教学中心内嵌窗口增加 URL 协议白名单（只允许 http/https），防止页面内 `javascript:` / `file:` 跳转

### 稳定性
- `refreshGatewayToken` 仅刷新 token，不再覆盖用户自定义的 auth mode / controlUi 字段
- `disableAllThirdPartyPlugins` 增加内置插件白名单（telegram / discord / feishu），只禁用真正的第三方插件
- 程序退出时 `killOpenclaw` 改为 Promise 化，等待子进程真正退出再写回 U 盘，避免竞态
- Preflight 端口检测同时覆盖 IPv4 和 IPv6，避免绑定 `::1` 时漏检
- `license.js` 读取 U 盘序列号改用 `execFile` + 参数数组，避免 shell 注入
- 飞书插件 tgz 补丁路径未命中时明确告警，不再静默跳过

### UI
- 主窗口和桌面宠物窗口开启 `sandbox: true`，提升渲染进程隔离度
- `log-translate` 规则字段名统一为 `append`，与返回约定一致

---

## v3.0.0 (2026-04-04)

### 插件中心
- 启动器新增"推荐插件"区域，支持一键安装飞书插件、微信插件
- 飞书插件多步安装流程：下载 tgz → 全局安装 → 独立终端引导输入 App ID / Secret
- 微信插件一键安装：`npx @tencent-weixin/openclaw-weixin` 自动拉取最新版
- 插件启动失败三阶段渐进恢复：补全注册信息 → 定位并禁用问题插件 → 兜底全部禁用

### 环境兼容（三层 PATH 防御）
- 全局 PATH 兜底：启动时确保 system32 在 `process.env.PATH` 中
- `buildEnv()` 每次 spawn 子进程都注入完整 PATH（nodeDir / npmBin / openclawDir / system32 / ComSpec）
- 关键系统命令（taskkill / rundll32 / cmd.exe）使用完整路径，不依赖 PATH 查找
- 自动在 nodeDir 和 npm 全局目录创建 `openclaw.cmd` shim，让插件 CLI 能通过 PATH 找到 openclaw

### 修复
- spawn cmd.exe ENOENT：cwd 目录三级 fallback（openclawDir → installDir → tmpdir）
- 飞书版本检查失败：npm install 后自动打补丁，从 `OpenClaw 2026.x.x (hash)` 中提取纯数字版本
- 微信 CLI 找不到 openclaw：启动时自动创建 shim
- taskkill / rundll32 ENOENT：全部使用完整路径
- APPDATA 为空时路径异常：用 `os.homedir()` 拼接兜底
- `appData` 变量重复声明改名为 `appDataDir`

---

## v2.0.0 (2026-04-02)

### 数据同步
- 新增 U 盘 ↔ 本机双向同步：启动时 U 盘 → 本机，关闭时本机 → U 盘
- 同步目录：workspace（MEMORY.md / skills / IDENTITY.md）、memory（main.sqlite 向量索引）、managed-skills
- 使用 `.sync-meta.json` 时间戳判断同步方向，拷贝失败不阻塞启动
- U 盘拔出时自动跳过写回，数据安全保留在本机

### 配置安全
- `mergeUserConfig`：启动器只覆盖自己管理的字段，保留用户和插件写入的其他字段
- 切换 AI 服务商时自动清理旧 provider 的 API Key 配置，防止字段残留
- 配置损坏时 `repair-config` 先备份再重建最小可用配置

### API Key 管理
- 支持在启动后修改 API Key 和服务商，无需重新安装
- 保存前在线验证 API Key 可用性，失败可选择跳过
- `setup.json` 中 apiKey 自动脱敏为 `***`，防止明文泄露

---

## v1.0.0 (2026-04-01) — 首个版本

### 架构

全新架构：U 盘只做授权钥匙，openclaw 安装在本机原生运行。

- **从 openclaw-usb（U盘便携版）演化而来**，砍掉所有环境变量重定向和配置自愈代码
- openclaw 运行在 `%LOCALAPPDATA%\OpenClaw\`，使用原生 `~/.openclaw/` 配置路径
- 首次使用自动从 U 盘安装到本机，后续启动秒开
- U 盘拔出即停止（800ms 检测），USB 序列号 + ECDSA 签名授权

### 功能

- **一键安装**: 首次启动自动解压 openclaw.zip + 复制完整 Node.js runtime 到本机
- **版本管理**: U 盘有新版时自动升级本机安装
- **API Key 管理**: 支持 Claude/GPT/DeepSeek/通义/GLM/火山引擎/自定义服务商
- **微信插件**: 安装/登录/更新全流程
- **桌面宠物**: 龙虾 SVG，显示运行状态
- **日志翻译**: 技术错误自动转译为中文友好提示
- **一键修复**: 配置损坏时自动重建
- **Preflight 检查**: Node.js/程序文件/端口/配置/磁盘空间 5 项

### 安全

- zip 解压路径遍历防护
- gateway token 每次启动刷新，失败时清空防残留
- 安装前磁盘空间检查（< 1500 MB 中止）
- npm_config_registry 指向淘宝镜像（国内直连）

### U 盘内容

```
OpenClaw-启动器.exe    73 MB
openclaw.zip          140 MB
runtime/              82 MB（完整 Node.js + npm）
license.key           <1 KB
总计                  ~310 MB
```
