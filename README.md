# OpenClaw 启动器（USB 钥匙版）

> U 盘即钥匙，插入即用，拔出即停。

OpenClaw 启动器是一个基于 Electron 的桌面应用，将 U 盘作为硬件授权钥匙，控制 OpenClaw AI 助手的启动与运行。核心理念：**U 盘只做授权，不做运行环境**，OpenClaw 安装在本机原生运行，保证稳定性和性能。

---

## 项目结构

```
openclaw-key/
├── main.js                 # Electron 主进程（IPC、安装、启动、插件管理）
├── preload.js              # 渲染进程桥接（主窗口 IPC 接口）
├── pet-preload.js          # 桌面宠物窗口桥接
│
├── setup.html              # 首次安装向导页面（选择 AI 服务商、API Key）
├── launcher.html           # 主界面（状态面板、日志、插件管理）
├── pet.html                # 桌面宠物（龙虾 SVG 动画）
│
├── src/
│   ├── paths.js            # 路径常量（U 盘路径、本机安装路径、配置路径）
│   ├── config.js           # AI 服务商配置生成（支持 7+ 服务商）
│   ├── license.js          # 授权验证（ECDSA 签名 + U 盘序列号绑定）
│   └── log-translate.js    # 日志翻译层（技术错误 → 中文友好提示）
│
├── styles/
│   └── common.css          # 通用样式
│
├── assets/
│   ├── icon.ico            # 应用图标
│   └── weixin-plugin.zip   # 微信插件离线包
│
├── test/
│   ├── config.test.js      # 配置模块测试（16 个用例）
│   └── log-translate.test.js  # 日志翻译测试（16 个用例）
│
├── sign-usb.js             # 开发者工具：为 U 盘生成授权签名
├── public.pem              # ECDSA 公钥（验证用）
├── 授权U盘.ps1             # PowerShell 授权脚本
├── 生成授权.bat            # 批处理授权入口
│
├── package.json            # 项目配置、构建脚本
└── CHANGELOG.md            # 更新日志
```

### 关键路径（运行时）

| 路径 | 说明 |
|------|------|
| U 盘根目录 | `OpenClaw-启动器.exe` + `openclaw.zip` + `runtime/` + `license.key` |
| `%LOCALAPPDATA%\OpenClaw\` | 本机安装目录（openclaw + Node.js） |
| `~/.openclaw/` | OpenClaw 原生配置目录（不做任何重定向） |

---

## 功能说明

### 1. USB 硬件授权

- U 盘的**卷序列号**作为硬件标识，结合 **ECDSA 签名**验证授权
- 开发者使用私钥为指定 U 盘签名，生成 `license.key`
- 启动时验证签名是否匹配当前 U 盘，不匹配则拒绝启动
- license.key 自动备份到本机，防止用户误删

### 2. 一键安装

- 首次启动自动进入安装向导（`setup.html`）
- 从 U 盘解压 `openclaw.zip` 和 `runtime/`（Node.js）到本机
- 用户选择 AI 服务商、填写 API Key，自动生成配置
- 支持服务商：Claude / GPT / DeepSeek / 通义千问 / GLM / 火山引擎 / 自定义

### 3. 启动与运行管理

- 启动前执行 **Preflight 检查**：Node.js / 程序文件 / 端口 / 配置 / 磁盘空间
- 端口被占用时自动识别并提供一键释放
- U 盘拔出后 800ms 内自动停止 OpenClaw
- U 盘有新版本时自动升级本机安装

### 4. 插件管理

推荐插件区域支持一键安装和重装：

- **飞书插件**：以 AI 身份操作飞书（发消息、写文档、创建表格）
  - 多步安装：下载 → npm install → 打开终端配置 App ID/Secret
- **微信插件**：扫码连接微信，通过微信与 OpenClaw 对话
  - 一键安装：npx 自动拉取最新版

重装功能：
- 已安装的插件按钮显示"重装"，支持换绑账号
- 点击"重装"需二次确认（防止误触），3 秒超时自动恢复
- 重装会覆盖旧版本，新账号替换旧账号

### 5. 日志翻译

将 OpenClaw 的技术日志自动翻译为中文友好提示：

| 技术错误 | 用户看到的提示 |
|---------|--------------|
| `ETIMEDOUT` | 网络连接超时 |
| `EADDRINUSE` | 端口被占用 |
| `EPERM` | 权限不足 |
| `ENOSPC` | 磁盘空间不足 |
| `Config invalid` | 配置异常 + 修复提示 |

### 6. 一键修复

配置损坏时自动重建最小可用配置，无需用户手动编辑 JSON。

### 7. 桌面宠物

- 龙虾 SVG 动画，显示 OpenClaw 运行状态
- 独立悬浮窗口，可拖拽

### 8. API Key 管理

支持在启动后修改 API Key 和服务商，无需重新安装。

---

## 安全机制

### 授权安全
- ECDSA 非对称签名，私钥不随程序分发
- 授权绑定 U 盘物理序列号，无法复制到其他 U 盘使用

### 运行安全
- zip 解压路径遍历防护（防止恶意 zip 写入系统目录）
- Gateway token 每次启动刷新
- 安装前磁盘空间检查（< 1500 MB 中止安装）

### 环境兼容（三层防御）
1. **全局 PATH 兜底** — 启动时确保 system32 在 PATH 中
2. **buildEnv() 增强** — 每次 spawn 子进程带完整 PATH
3. **关键命令完整路径** — taskkill / rundll32 / cmd.exe 不依赖 PATH

---

## 开发

### 环境要求
- Node.js 18+
- Windows 10/11

### 常用命令

```bash
# 开发模式运行
npm start

# 运行测试
npm test

# 打包（生成便携版 exe）
npm run build
# 输出: dist/OpenClaw-启动器.exe
```

### 为 U 盘生成授权

```bash
# 查询 U 盘序列号（F 盘为例）
wmic logicaldisk where "DeviceID='F:'" get VolumeSerialNumber

# 生成 license.key（需要 private.pem）
node sign-usb.js <序列号>
```

---

## U 盘内容清单

```
OpenClaw-启动器.exe     ~73 MB    启动器程序
openclaw.zip           ~140 MB    OpenClaw 本体
runtime/               ~82 MB     Node.js 运行时
license.key            <1 KB      授权文件
─────────────────────────────────
总计                   ~310 MB
```

---

## 技术栈

- **Electron 33** — 桌面应用框架
- **Node.js** — 主进程逻辑
- **纯 HTML/CSS/JS** — 前端页面（无框架）
- **yauzl** — zip 解压
- **ECDSA (P-256)** — 授权签名
- **electron-builder** — 打包工具
