# OpenClaw 启动器 · 灵境AI 账号登录版

> 邮箱登录即用，一键启动 Gateway，自动接入上架模型。

基于 Electron 的桌面启动器，对接 [灵境AI](https://aitoken.homes) 账号体系：用户登录后，自动拉取可用模型列表、API Token、余额；一键启动 OpenClaw Gateway 并打开聊天控制台。U 盘作为 **跨设备存储钥匙**（随身带走 `auth.json` + `workspace/memory/managed-skills`），换台电脑插上自动登录。

---

## 快速开始

```bash
# 开发环境
git clone https://github.com/xiaomimi123/openclawUpan.git
cd openclawUpan
git checkout v5-dev
npm install          # 只有一个依赖 yauzl
npm start            # 启动 Electron

# 跑单测（64 个，全离线）
npm test
```

首次启动流程：**独立登录窗** → 邮箱+密码（或注册+验证码）→ 主窗口 → 模型配置选一个模型 → 启动 Gateway → 自动打开控制台。

---

## 项目结构

```
openclaw-key/
├── main.js                 # Electron 主进程：IPC + 窗口 + Gateway 子进程管理
├── preload.js              # 主窗口 IPC 桥接（window.usb / auth / mainWin / models / topup / skills / support）
├── login-preload.js        # 登录窗 IPC 桥接（只暴露 auth / loginWin）
│
├── login.html              # 独立登录/注册窗 480×640
├── launcher.html           # 主窗口 1180×740（8 个页面：首页/模型/充值/聊天/技能/环境/客服/设置）
│
├── src/
│   ├── auth.js             # AuthManager：cookie session 模式，持久化到 U 盘 auth.json
│   ├── api-client.js       # HTTP 客户端（node:https），自动带 cookie / bearer，统一 {success,data} 解包
│   ├── api-config.js       # 中转站端点常量
│   ├── config.js           # openclaw.json 配置构建（multi-provider 支持）
│   ├── paths.js            # 路径常量：usbRoot / installDir / configDir
│   ├── usb-sync.js         # U 盘 ↔ 本机 workspace/memory/managed-skills 双向同步
│   └── log-translate.js    # openclaw 日志翻译层（技术错误 → 中文友好提示）
│
├── test/
│   ├── auth.test.js        # AuthManager 单测（15 个）
│   ├── api-client.test.js  # HTTP 客户端（16 个）
│   ├── config.test.js      # 配置构建（16 个）
│   └── log-translate.test.js # 日志翻译（16 个）
│
├── assets/icon.ico         # 应用图标
├── dev-data/               # 开发模式下模拟的 U 盘目录
├── docs/archive/           # 归档的历史审查文档
├── CHANGELOG.md            # 版本日志
└── package.json            # v5.0.0-alpha
```

---

## 后端接口（对接灵境AI / new-api）

启动器只走下面的 HTTPS 接口，`src/api-config.js` 集中定义：

| 模块 | 端点 | 方法 |
|---|---|---|
| 认证 | `/api/verification` / `/api/user/register` / `/api/user/login` / `/api/user/logout` / `/api/user/self` | GET/POST |
| Token 管理 | `/api/token/` (list / create) | GET/POST/DELETE |
| 上架模型 | `/api/lingjing/model-prices` | GET（公开） |
| 充值套餐 | `/api/lingjing/plans` / `/api/lingjing/pay/config` / `/api/lingjing/pay/create` / `/api/lingjing/pay/order/:no` | GET/POST |
| 兑换码 | `/api/user/topup` | POST |
| 客服配置 | `/api/lingjing/config` | GET |
| AI 代理 | `/v1/chat/completions` / `/v1/models` / `/v1/dashboard/billing/*` | 鉴权用 Token 本体（不带 sk- 前缀） |

登录返回 `Set-Cookie: session=xxx`，30 天有效。启动器用原生 `node:https.request`（不是 Electron/Chromium fetch）直接发请求，确保 Set-Cookie 可见并能持久化。

---

## 核心模块

### `AuthManager`（src/auth.js）
```
load()                       读 U 盘 auth.json，恢复 session + user
sendCode(email)              GET /api/verification
register({username, email, password, verification_code})  后自动 login
login({username, password})  POST /api/user/login，捕获 Set-Cookie
logout()                     GET /api/user/logout，清 auth.json
refreshUserProfile()         GET /api/user/self，刷新余额/用户信息
getCookieString()            给 ApiClient 注入 Cookie header
```

### `ApiClient`（src/api-client.js）
- 三种鉴权：`auth: 'cookie' | 'bearer' | false`
- 自动捕获登录响应的 Set-Cookie → 调 `setCookie` 回调
- 业务 `{success,data,message}` 统一解包：`unwrap=true`（默认）返回 `data`，失败抛 `ApiError(message)`
- 原生 `node:https` 实现，与 fetch 契约一致（返回 `{ ok, status, headers, text() }`）

### 主窗口多页（launcher.html）
单文件 SPA，JS 用 `data-page` 属性切换 8 个 `<div class="page-view">`。IPC 按命名空间分组：
- `window.auth.*` — 登录态
- `window.mainWin.*` — 窗口生命周期
- `window.models.*` — token + 上架模型
- `window.topup.*` — 充值 + 套餐 + 兑换码
- `window.skills.*` — 技能列表
- `window.support.*` — 客服配置
- `window.usb.*` — v4 遗留（Gateway 启停、安装技能、preflight 等）

---

## 打包

```bash
npm run build     # electron-builder portable x64
```

输出：`dist/OpenClaw-启动器.exe`。

**部署到 U 盘**：exe + workspace/memory/managed-skills 目录 + 可选的 auth.json（登录态）。用户拷到 U 盘即插即用，换机保持登录态。

---

## 开发注意

- **不要把 `require('undici')` 当 fetch 的兜底** —— 在 Electron 里 undici 不暴露为公共模块。全程用 `node:https.request`
- 保存模型时 API key **不加 sk- 前缀**（灵境 API 原样接受）
- 保存模型后必须同步到 agent 的 `models.json` + `auth-profiles.json`（main.js `syncAgentAuth`），否则 openclaw 子 agent 用的是陈旧缓存
- Gateway UI 状态机：stopped / starting / running / stopping，refresh 只在非过渡态跑（避免覆盖用户刚点的 starting）

---

## 许可证

MIT License（见 LICENSE）。

## 反馈

- 客服：启动器内设置页 → 联系客服 → 一键复制诊断信息发微信
- GitHub：https://github.com/xiaomimi123/openclawUpan/issues
