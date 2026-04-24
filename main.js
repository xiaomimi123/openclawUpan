const { app, BrowserWindow, ipcMain, shell, dialog, screen } = require('electron')
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
const crypto = require('crypto')
const net = require('net')

// ─── 模块导入 ──────────────────────────────────────────────────────────────
const {
  usbRoot, installDir, openclawDir, nodeDir, configDir, setupFile, versionFile,
  getNodePath, getOpenclawMjs, isInstalled, getZipVersion, getLocalVersion, ensureDirs
} = require('./src/paths')

const {
  applyProviderConfig, buildOpenclawConfig, mergeUserConfig, refreshGatewayToken
} = require('./src/config')

const { translateLog } = require('./src/log-translate')
const { syncFromUsb, syncToUsb } = require('./src/usb-sync')
const { AuthManager } = require('./src/auth')

const APP_VERSION = require('./package.json').version

// 同步路径常量（U 盘 ↔ 本机 三组目录）
const syncLocals = {
  workspace:     path.join(installDir, 'workspace'),       // MEMORY.md, memory/*.md, skills/
  memory:        path.join(configDir, 'memory'),            // main.sqlite（向量索引）
  managedSkills: path.join(configDir, 'skills'),            // openclaw 命令安装的技能
}

// ─── 全局 PATH 兜底：确保 system32 在 PATH 中 ─────────────────────────────
// 某些客户电脑的 PATH 缺失 system32，导致 taskkill/netstat/powershell 等系统命令 ENOENT
;(() => {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows'
  const sys32 = path.join(systemRoot, 'system32')
  const currentPath = process.env.PATH || ''
  if (!currentPath.toLowerCase().split(';').some(p => p.replace(/[\\/]+$/, '').toLowerCase() === sys32.toLowerCase())) {
    process.env.PATH = currentPath + ';' + sys32
  }
  if (!process.env.ComSpec) {
    process.env.ComSpec = path.join(sys32, 'cmd.exe')
  }
})()

// ─── 全局状态 ──────────────────────────────────────────────────────────────
let mainWindow
let openclawProc = null
let openclawStartedAt = null  // ms timestamp；Gateway 首页显示运行时长
let usbMonitorTimer = null
let currentGatewayToken = null
let startingOpenclaw = false
let pluginRetryPhase = 0        // 0=正常, 1=已同步注册重试, 2=已逐个隔离, 3=已全部禁用

// V5 登录态管理器（app.whenReady 后初始化）
let authManager = null

// V5 登录窗口（未登录时显示；登录成功后关闭并创建主窗口）
let loginWindow = null

const sendLog = (msg) => mainWindow?.webContents.send('openclaw-log', msg)

// 向所有窗口广播 auth 事件（登录失效等）
function broadcastAuthEvent(channel) {
  for (const w of BrowserWindow.getAllWindows()) {
    try { w.webContents.send(channel) } catch {}
  }
}

// 往登录窗推送一条诊断日志（entry = { level, message }）
function pushLoginDebug(level, message) {
  if (loginWindow && !loginWindow.isDestroyed()) {
    try { loginWindow.webContents.send('login-win:debug-log', { level, message }) } catch {}
  }
  // 同时 console 输出，便于终端看（auth 前缀 -- 登录窗或主窗都可能触发）
  if (level === 'error') console.error('[auth]', message)
  else console.log('[auth]', message)
}

// ─── 插件注册 ────────────────────────────────────────────────────────────
// openclaw 的插件系统依赖 openclaw.json 中三个字段协同工作：
//   plugins.allow   — 白名单，allow 不为空时不在其中的插件会被拒绝加载
//   plugins.entries  — 每个插件的启用状态 { enabled: true/false }
//   plugins.installs — npm 安装元数据（source/spec/installPath/version/integrity 等），
//                      openclaw 用它做 provenance 安全审计，缺失会触发 "untracked" 警告
// 启动器负责在安装和启动时确保这三个字段与 extensions 目录一致。

/**
 * 读取插件目录的元数据（package.json + openclaw.plugin.json）
 * @returns {{ pluginId, npmName, version, installPath, manifest }} 或 null
 */
function readPluginMeta(pluginDir) {
  try {
    const manifestPath = path.join(pluginDir, 'openclaw.plugin.json')
    if (!fs.existsSync(manifestPath)) return null
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    const pluginId = manifest.id
    if (!pluginId) return null

    // 从 package.json 读 npm 信息
    let npmName = pluginId, version = '0.0.0'
    const pkgPath = path.join(pluginDir, 'package.json')
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
        npmName = pkg.name || pluginId
        version = pkg.version || '0.0.0'
      } catch {}
    }

    return { pluginId, npmName, version, installPath: pluginDir, manifest }
  } catch { return null }
}

/**
 * 将一个插件完整注册到 openclaw.json（allow + entries + installs）
 */
async function registerPlugin(pluginId) {
  const configPath = path.join(configDir, 'openclaw.json')
  const pluginDir = path.join(configDir, 'extensions', pluginId)
  if (!fs.existsSync(configPath)) return false

  const meta = readPluginMeta(pluginDir)
  if (!meta) return false

  try {
    const cfg = JSON.parse(await fs.promises.readFile(configPath, 'utf8'))
    if (!cfg.plugins) cfg.plugins = {}
    if (!cfg.plugins.entries) cfg.plugins.entries = {}
    if (!cfg.plugins.allow) cfg.plugins.allow = []
    if (!cfg.plugins.installs) cfg.plugins.installs = {}

    let changed = false

    // allow 白名单
    if (!cfg.plugins.allow.includes(pluginId)) {
      cfg.plugins.allow.push(pluginId)
      changed = true
    }
    // entries（不覆盖用户已有的 enabled 设置）
    if (!cfg.plugins.entries[pluginId]) {
      cfg.plugins.entries[pluginId] = { enabled: true }
      changed = true
    }
    // installs 元数据（不覆盖 openclaw 自身写入的完整记录）
    if (!cfg.plugins.installs[pluginId]) {
      cfg.plugins.installs[pluginId] = {
        source: 'npm',
        spec: meta.npmName,
        installPath: meta.installPath,
        version: meta.version,
        resolvedName: meta.npmName,
        resolvedVersion: meta.version,
        installedAt: new Date().toISOString()
      }
      changed = true
    }

    if (changed) {
      await fs.promises.writeFile(configPath, JSON.stringify(cfg, null, 2), 'utf8')
    }
    return true
  } catch (e) {
    console.error('[registerPlugin] failed:', e.message)
    return false
  }
}

/**
 * 扫描 extensions 目录，确保所有已安装插件在 allow/entries/installs 中完整注册。
 * 每次 gateway 启动前调用，解决"插件文件存在但配置缺失"导致的加载失败。
 */
async function syncPluginRegistry() {
  const configPath = path.join(configDir, 'openclaw.json')
  const extDir = path.join(configDir, 'extensions')
  if (!fs.existsSync(configPath) || !fs.existsSync(extDir)) return

  try {
    const cfg = JSON.parse(await fs.promises.readFile(configPath, 'utf8'))
    if (!cfg.plugins) cfg.plugins = {}
    if (!cfg.plugins.entries) cfg.plugins.entries = {}
    if (!cfg.plugins.allow) cfg.plugins.allow = []
    if (!cfg.plugins.installs) cfg.plugins.installs = {}

    const dirs = await fs.promises.readdir(extDir, { withFileTypes: true })
    let changed = false

    for (const d of dirs) {
      if (!d.isDirectory()) continue
      const meta = readPluginMeta(path.join(extDir, d.name))
      if (!meta) continue

      const { pluginId } = meta

      if (!cfg.plugins.allow.includes(pluginId)) {
        cfg.plugins.allow.push(pluginId)
        changed = true
      }
      if (!cfg.plugins.entries[pluginId]) {
        cfg.plugins.entries[pluginId] = { enabled: true }
        changed = true
      }
      if (!cfg.plugins.installs[pluginId]) {
        cfg.plugins.installs[pluginId] = {
          source: 'npm',
          spec: meta.npmName,
          installPath: meta.installPath,
          version: meta.version,
          resolvedName: meta.npmName,
          resolvedVersion: meta.version,
          installedAt: new Date().toISOString()
        }
        changed = true
      }
    }

    if (changed) {
      await fs.promises.writeFile(configPath, JSON.stringify(cfg, null, 2), 'utf8')
      console.log('[syncPluginRegistry] 已补全插件注册:', cfg.plugins.allow)
    }
  } catch (e) {
    console.error('[syncPluginRegistry] failed:', e.message)
  }
}

/**
 * 从 gatewayLog 中尝试提取导致崩溃的插件 id
 * openclaw 加载插件时会输出 "[plugins] <id> ..." 格式的日志
 */
function extractCrashPluginId(gatewayLog) {
  // 匹配 "[plugins] xxx failed to load" 或 "[plugins] xxx:" 后紧跟错误
  const failMatch = gatewayLog.match(/\[plugins?\]\s+(\S+)\s+(?:failed to load|error|:.*(?:TypeError|ReferenceError|Cannot read))/i)
  if (failMatch) return failMatch[1]

  // 如果日志里提到了 non-bundled 插件列表，取最后一个（通常是后加载的那个出问题）
  const discoverMatch = gatewayLog.match(/non-bundled plugins? may auto-load:\s*(.+?)(?:\.|Set plugins)/i)
  if (discoverMatch) {
    const ids = discoverMatch[1].split(',').map(s => s.replace(/\(.*?\)/g, '').trim()).filter(Boolean)
    // 返回不在我们已知良好列表里的第一个
    const KNOWN_GOOD = new Set(['openclaw-weixin', 'feishu-openclaw-plugin'])
    const suspect = ids.find(id => !KNOWN_GOOD.has(id))
    if (suspect) return suspect
    return ids[ids.length - 1] // 如果都是已知的，返回最后一个
  }
  return null
}

/**
 * 禁用指定插件（entries.enabled = false），保留其他插件不动
 */
async function disablePlugin(pluginId) {
  const configPath = path.join(configDir, 'openclaw.json')
  if (!fs.existsSync(configPath)) return false
  try {
    const cfg = JSON.parse(await fs.promises.readFile(configPath, 'utf8'))
    if (!cfg.plugins?.entries?.[pluginId]) {
      if (!cfg.plugins) cfg.plugins = {}
      if (!cfg.plugins.entries) cfg.plugins.entries = {}
    }
    cfg.plugins.entries[pluginId] = { enabled: false }
    await fs.promises.writeFile(configPath, JSON.stringify(cfg, null, 2), 'utf8')
    return true
  } catch (e) {
    console.error('[disablePlugin] failed:', e.message)
    return false
  }
}

/**
 * 禁用所有非内置插件（entries 里全部 enabled: false），保底确保 gateway 能启动
 */
async function disableAllThirdPartyPlugins() {
  const configPath = path.join(configDir, 'openclaw.json')
  if (!fs.existsSync(configPath)) return false
  try {
    const cfg = JSON.parse(await fs.promises.readFile(configPath, 'utf8'))
    if (!cfg.plugins?.entries) return false
    // openclaw 内置插件（由 openclaw 自身管理），不动
    const BUILTIN = new Set(['telegram', 'discord', 'feishu'])
    for (const key of Object.keys(cfg.plugins.entries)) {
      if (BUILTIN.has(key)) continue
      cfg.plugins.entries[key].enabled = false
    }
    await fs.promises.writeFile(configPath, JSON.stringify(cfg, null, 2), 'utf8')
    return true
  } catch (e) {
    console.error('[disableAllThirdPartyPlugins] failed:', e.message)
    return false
  }
}

// 调用 openclaw doctor --fix 让 openclaw 自己修复配置问题
function runDoctorFix() {
  return new Promise(resolve => {
    const nodePath = getNodePath()
    const mjs = getOpenclawMjs()
    if (!mjs) return resolve(false)
    const proc = spawn(nodePath, [mjs, 'doctor', '--fix'], {
      env: buildEnv(),
      cwd: openclawDir,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15000
    })
    proc.on('exit', code => resolve(code === 0))
    proc.on('error', () => resolve(false))
  })
}

// 兜底：验证配置文件 JSON 格式合法，不删除任何用户/插件字段
// 只修复 JSON 格式问题（如尾逗号），不做字段清理——插件的字段由 openclaw 自身管理
async function cleanConfigFallback() {
  const configPath = path.join(configDir, 'openclaw.json')
  if (!fs.existsSync(configPath)) return false
  try {
    // 只要能正常解析就算通过
    JSON.parse(await fs.promises.readFile(configPath, 'utf8'))
    return true
  } catch {
    // JSON 损坏，无法修复
    return false
  }
}

// 综合修复：备份 → doctor --fix → 验证 JSON 合法
// doctor --fix 可能删掉插件写入的自定义字段，所以先备份
async function repairConfigAuto() {
  const configPath = path.join(configDir, 'openclaw.json')
  if (!fs.existsSync(configPath)) return false

  // 备份当前配置（doctor 可能删掉插件字段）
  const backupPath = configPath + '.pre-repair.bak'
  try { await fs.promises.copyFile(configPath, backupPath) } catch {}

  const doctorOk = await runDoctorFix()
  if (doctorOk) return true
  // doctor 失败（可能命令不存在），恢复备份并检查 JSON 合法性
  try { await fs.promises.copyFile(backupPath, configPath) } catch {}
  return cleanConfigFallback()
}

// 从配置文件读取 gateway 当前实际使用的 token（gateway 启动后可能会重新生成 token）
function readGatewayToken() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(configDir, 'openclaw.json'), 'utf8'))
    return cfg.gateway?.auth?.token || null
  } catch { return null }
}

// 构建带 token 的 UI 地址
function buildUiUrl() {
  // 优先从配置文件读取最新 token（gateway 可能已更新），回退到缓存值
  const token = readGatewayToken() || currentGatewayToken
  const ts = Date.now()
  return token
    ? `http://127.0.0.1:18789/?_t=${ts}#token=${token}`
    : `http://127.0.0.1:18789/`
}

// openclaw 子进程环境：把本机安装的 Node.js 目录加入 PATH（让 npm/npx 可被找到）
// 检测是否为中国大陆环境（时区 + 系统语言）
function isChinaEnv() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    if (tz === 'Asia/Shanghai' || tz === 'Asia/Chongqing' || tz === 'Asia/Urumqi') return true
    const lang = (process.env.LANG || process.env.LANGUAGE || process.env.LC_ALL || '').toLowerCase()
    if (lang.startsWith('zh')) return true
    // Windows 系统语言
    const winLang = app.getLocale?.() || ''
    if (winLang.startsWith('zh')) return true
  } catch {}
  return false
}

// 在 nodeDir 和 npm 全局目录中创建 openclaw.cmd shim，让插件 CLI 能通过 PATH 找到 openclaw 命令
function ensureOpenclawShim() {
  const mjs = getOpenclawMjs()
  const nodePath = getNodePath()
  if (!mjs) return
  const content = `@echo off\r\n"${nodePath}" "${mjs}" %*\r\n`
  // 放两个位置：nodeDir（buildEnv 能找到）+ npm 全局 bin（npx 子进程能找到）
  const npmBin = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'npm')
  for (const dir of [nodeDir, npmBin]) {
    const shimPath = path.join(dir, 'openclaw.cmd')
    try {
      if (fs.existsSync(shimPath)) {
        const existing = fs.readFileSync(shimPath, 'utf8')
        if (existing.includes(mjs)) continue
      }
      fs.writeFileSync(shimPath, content, 'utf8')
    } catch {}
  }
}

function buildEnv() {
  const env = { ...process.env }
  // 仅中国大陆环境使用淘宝镜像，其他地区使用官方源
  if (isChinaEnv()) {
    env.npm_config_registry = 'https://registry.npmmirror.com'
  }

  const npmBin = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'npm')

  // ── 1. 确保关键目录存在（客户电脑不可信，目录可能全不存在）──
  for (const d of [nodeDir, npmBin]) {
    try { fs.mkdirSync(d, { recursive: true }) } catch {}
  }

  // ── 2. 确保 openclaw.cmd shim 存在（插件 CLI 需要通过 PATH 找到 openclaw 命令）──
  ensureOpenclawShim()

  // ── 3. 构建 PATH：nodeDir + npm 全局 bin + openclawDir + system32 + 原有 PATH ──
  const extraPaths = [nodeDir, npmBin]
  if (openclawDir && fs.existsSync(openclawDir)) extraPaths.push(openclawDir)
  const sys32 = path.join(env.SystemRoot || 'C:\\Windows', 'system32')
  if (!((env.PATH || '').toLowerCase().includes(sys32.toLowerCase()))) {
    extraPaths.push(sys32)
  }
  env.PATH = extraPaths.join(';') + ';' + (env.PATH || '')

  // ── 4. 确保 ComSpec 存在 ──
  if (!env.ComSpec) {
    env.ComSpec = path.join(sys32, 'cmd.exe')
  }
  return env
}

// 通用 zip 解压（yauzl），带路径遍历防护
function extractZip(zipPath, destDir, { onProgress, timeout = 5 * 60 * 1000 } = {}) {
  const extractPromise = new Promise((resolve) => {
    const yauzl = require('yauzl')
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err) return resolve(false)
      const finish = (result) => {
        try { zipfile.close() } catch {}
        resolve(result)
      }
      const total = zipfile.entryCount
      let done = 0

      zipfile.readEntry()
      zipfile.on('entry', (entry) => {
        done++
        if (onProgress) onProgress(done, total)
        const entryName = entry.fileName.replace(/\\/g, '/')
        const dest = path.join(destDir, entryName)
        if (!path.normalize(dest).startsWith(path.normalize(destDir))) {
          console.error('[extractZip] path traversal blocked:', entryName)
          return finish(false)
        }
        if (/\/$/.test(entryName)) {
          fs.mkdirSync(dest, { recursive: true })
          zipfile.readEntry()
        } else {
          fs.mkdirSync(path.dirname(dest), { recursive: true })
          zipfile.openReadStream(entry, (err2, readStream) => {
            if (err2) return finish(false)
            const ws = fs.createWriteStream(dest)
            readStream.on('error', () => finish(false))
            readStream.pipe(ws)
            ws.on('close', () => zipfile.readEntry())
            ws.on('error', () => finish(false))
          })
        }
      })
      zipfile.on('end', () => finish(true))
      zipfile.on('error', () => finish(false))
    })
  })
  const timeoutPromise = new Promise(r => setTimeout(() => r(false), timeout))
  return Promise.race([extractPromise, timeoutPromise])
}

// 递归复制目录（runtime 文件夹兼容回退用）
async function copyDirFallback(src, dest) {
  await fs.promises.mkdir(dest, { recursive: true })
  const entries = await fs.promises.readdir(src, { withFileTypes: true })
  for (const entry of entries) {
    const s = path.join(src, entry.name), d = path.join(dest, entry.name)
    if (entry.isDirectory()) await copyDirFallback(s, d)
    else await fs.promises.copyFile(s, d)
  }
}

// ─── Window ────────────────────────────────────────────────────────────────

function createLoginWindow() {
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.focus()
    return
  }
  loginWindow = new BrowserWindow({
    width: 480,
    height: 640,
    resizable: false,
    maximizable: false,
    minimizable: true,
    frame: false,
    backgroundColor: '#0F1218',
    show: false,
    center: true,
    webPreferences: {
      preload: path.join(__dirname, 'login-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  loginWindow.loadFile('login.html')
  loginWindow.once('ready-to-show', () => loginWindow.show())
  loginWindow.on('closed', () => { loginWindow = null })
}

// 登录成功后：关闭登录窗 → 打开主窗口
function transitionLoginToMain() {
  createWindow()
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.close()
  }
}

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.focus()
    return
  }
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 740,
    minWidth: 1080,
    minHeight: 680,
    resizable: true,
    frame: false,
    backgroundColor: '#08090D',
    show: false,
    center: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.loadFile('launcher.html')
  mainWindow.once('ready-to-show', () => mainWindow.show())
  mainWindow.on('closed', () => { mainWindow = null })
}

// 登出 / session 失效：关主窗，打开登录窗
function transitionMainToLogin() {
  createLoginWindow()
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.close()
  }
}

// ─── 单实例锁 ─────────────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    // 第二个实例启动时，聚焦已有窗口（登录窗或主窗口）
    const w = loginWindow || mainWindow
    if (w && !w.isDestroyed()) {
      if (w.isMinimized()) w.restore()
      w.focus()
    }
  })

  app.whenReady().then(async () => {
    ensureOpenclawShim()
    // V5：AuthManager 单例，持久化到 U 盘 auth.json
    authManager = new AuthManager({
      authPath: path.join(usbRoot, 'auth.json'),
      onAuthFailed: () => broadcastAuthEvent('auth:failed'),
    })
    await authManager.load()
    // 未登录 → 登录窗；已登录 → 直接主窗口
    if (authManager.isLoggedIn()) {
      createWindow()
    } else {
      createLoginWindow()
    }
    startUsbMonitor()
  })
}

// ─── 磁盘空间检测（兼容 PowerShell 受限环境）─────────────────────────────

function getDiskFreeMB(driveLetter) {
  const { execSync } = require('child_process')
  const drive = String(driveLetter || '').toUpperCase()
  // 严格白名单：仅允许单个 A-Z 字母，防止任何命令注入
  if (!/^[A-Z]$/.test(drive)) return NaN
  // 方法 1: wmic（不依赖 PowerShell）
  try {
    const out = execSync(
      `wmic logicaldisk where "DeviceID='${drive}:'" get FreeSpace /format:value`,
      { encoding: 'utf8', timeout: 5000, windowsHide: true }
    )
    const m = out.match(/FreeSpace=(\d+)/)
    if (m) return Math.floor(parseInt(m[1], 10) / 1024 / 1024)
  } catch {}
  // 方法 2: fsutil（不依赖 PowerShell 和 wmic，Win11 24H2+ 移除了 wmic）
  try {
    const out = execSync(
      `fsutil volume diskfree ${drive}:`,
      { encoding: 'utf8', timeout: 5000, windowsHide: true }
    )
    // 匹配 "可用空闲字节数" 或 "Total free bytes" 行
    const m = out.match(/(?:可用空闲|Total free|avail free)\D+(\d[\d,. ]*)/i)
    if (m) {
      const bytes = parseInt(m[1].replace(/[,.\s]/g, ''), 10)
      if (!isNaN(bytes)) return Math.floor(bytes / 1024 / 1024)
    }
  } catch {}
  // 方法 3: PowerShell（最后回退）
  try {
    const out = execSync(
      `powershell -NoProfile -Command "(Get-PSDrive -Name ${drive}).Free"`,
      { encoding: 'utf8', timeout: 5000, windowsHide: true }
    )
    const val = parseInt(out.trim(), 10)
    if (!isNaN(val)) return Math.floor(val / 1024 / 1024)
  } catch {}
  return NaN
}

// ─── 首次安装到本机 ────────────────────────────────────────────────────────

async function installToLocal() {
  const openclawZip = path.join(usbRoot, 'openclaw.zip')

  // 本机已安装（通过 npm 全局或本地目录均可）且 U 盘无 zip → 跳过安装
  if (!fs.existsSync(openclawZip)) {
    if (isInstalled()) return
    throw new Error('U 盘中未找到 openclaw.zip')
  }

  // 版本检查：本机已安装且版本一致则跳过
  const usbVersion = getZipVersion(openclawZip)
  const localVersion = getLocalVersion()
  if (localVersion === usbVersion && isInstalled()) return

  // 磁盘空间检查（安装需要约 1.5 GB）
  const drive = installDir.charAt(0).toUpperCase()
  const freeMB = getDiskFreeMB(drive)
  if (!isNaN(freeMB) && freeMB < 1500) {
    throw new Error(`磁盘空间不足（${drive}: 盘剩余 ${freeMB} MB，安装需要约 1500 MB）\n请清理磁盘空间后重试`)
  }

  // 清理旧安装（openclaw 目录 + node 目录）
  for (const dir of [openclawDir, nodeDir]) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch (e) {
      console.warn('[installToLocal] cleanup failed:', dir, e.message)
    }
  }
  await ensureDirs()

  // 显示安装进度窗口
  const splash = new BrowserWindow({
    width: 460, height: 230,
    frame: false, resizable: false, center: true,
    backgroundColor: '#0f0f23',
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  })
  splash.loadURL(`data:text/html;charset=utf-8,<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
  *{margin:0;padding:0;box-sizing:border-box;}
  body{background:%230f0f23;color:%23c0c0e0;font-family:'Microsoft YaHei',sans-serif;
       display:flex;flex-direction:column;align-items:center;justify-content:center;
       height:100vh;gap:12px;text-align:center;padding:0 36px;}
  h3{font-size:15px;font-weight:600;}
  .bar-wrap{width:360px;height:8px;background:%231a1a2e;border-radius:4px;overflow:hidden;}
  .bar-fill{height:100%;width:0%;background:linear-gradient(90deg,%23667eea,%23764ba2);
            border-radius:4px;transition:width 0.2s ease;}
  .pct{font-size:13px;font-weight:600;color:%23667eea;}
  .tip{font-size:11px;color:%23666688;line-height:1.7;}
</style></head><body>
  <h3>正在安装 OpenClaw...</h3>
  <div class="bar-wrap"><div class="bar-fill" id="bar"></div></div>
  <div class="pct" id="pct">0%</div>
  <div class="tip">请勿关闭程序或移除 U 盘</div>
  <script>
    function updateProgress(p){
      document.getElementById('bar').style.width = p + '%';
      document.getElementById('pct').textContent = p + '%';
    }
  </script>
</body></html>`)

  await new Promise(resolve => {
    splash.webContents.once('did-finish-load', resolve)
    setTimeout(resolve, 3000)
  })

  // 解压 openclaw.zip 到本机
  let lastPct = -1, lastPushTime = 0
  const pushProgress = (done, total) => {
    const pct = Math.round((done / total) * 100)
    const now = Date.now()
    if (pct === lastPct || now - lastPushTime < 300) return
    lastPct = pct
    lastPushTime = now
    try { splash.webContents.executeJavaScript(`updateProgress(${pct})`) } catch {}
  }

  let ok = false
  let installError = ''
  try {
    ok = await extractZip(openclawZip, openclawDir, { onProgress: pushProgress })
    if (!ok) installError = 'openclaw.zip 解压返回失败'
  } catch (e) {
    ok = false
    installError = 'openclaw.zip 解压异常: ' + e.message
  }

  // 解压 Node.js runtime（含 npm/npx，插件安装需要）
  // 如果本机已有可用的 Node.js，runtime 解压失败不阻塞启动
  if (ok) {
    const runtimeZip = path.join(usbRoot, 'runtime.zip')
    const runtimeDir = path.join(usbRoot, 'runtime')
    let runtimeOk = false
    if (fs.existsSync(runtimeZip)) {
      try {
        runtimeOk = await extractZip(runtimeZip, nodeDir)
      } catch (e) {
        console.error('[installToLocal] extract runtime.zip failed:', e.message)
      }
    }
    if (!runtimeOk && fs.existsSync(runtimeDir)) {
      try {
        await copyDirFallback(runtimeDir, nodeDir)
        runtimeOk = true
      } catch (e) {
        console.error('[installToLocal] copy runtime failed:', e.message)
      }
    }
    // runtime 失败时检查系统是否已有 Node.js，有则继续
    if (!runtimeOk) {
      const systemNode = getNodePath()
      if (systemNode !== 'node' && fs.existsSync(systemNode)) {
        console.log('[installToLocal] runtime 解压失败，使用系统 Node.js:', systemNode)
      } else {
        installError = 'Node.js 运行时安装失败，且系统未安装 Node.js'
        ok = false
      }
    }
    // 确保 nodeDir 存在 + 重建 openclaw.cmd shim（插件安装依赖它）
    try { fs.mkdirSync(nodeDir, { recursive: true }) } catch {}
    ensureOpenclawShim()
  }

  if (!splash.isDestroyed()) splash.close()

  // 校验安装结果（同时检查 openclaw 入口和 node.exe）
  const nodeCheck = getNodePath()
  const mjsCheck = getOpenclawMjs()
  const nodeOk = nodeCheck === 'node' || fs.existsSync(nodeCheck)
  if (!ok || !mjsCheck || !nodeOk) {
    // 构建详细错误信息
    const details = []
    if (installError) details.push('错误: ' + installError)
    if (!ok) details.push('解压状态: 失败')
    if (!mjsCheck) details.push('openclaw 入口文件: 未找到 (目录: ' + openclawDir + ')')
    if (!nodeOk) details.push('Node.js: 未找到 (' + nodeCheck + ')')
    details.push('U 盘路径: ' + usbRoot)
    details.push('安装目录: ' + installDir)

    try { fs.rmSync(openclawDir, { recursive: true, force: true }) } catch (e) {
      console.warn('[installToLocal] post-fail cleanup:', e.message)
    }
    const choice = dialog.showMessageBoxSync({
      type: 'error',
      title: '安装失败',
      message: 'OpenClaw 安装失败，无法启动',
      detail: details.join('\n') + '\n\n'
        + '建议：先将杀毒软件临时关闭或添加白名单，再点击"重试"。',
      buttons: ['重试', '退出'],
      defaultId: 0
    })
    if (choice === 0) { app.relaunch(); app.quit() }
    else { app.quit() }
    throw new Error('安装失败')
  }

  // 写入版本标记
  try { fs.writeFileSync(versionFile, usbVersion, 'utf8') } catch (e) {
    console.warn('[installToLocal] version file write failed:', e.message)
  }
}

// ─── App lifecycle ─────────────────────────────────────────────────────────

app.on('window-all-closed', async () => {
  if (usbMonitorTimer) { clearInterval(usbMonitorTimer); usbMonitorTimer = null }
  // 等子进程真正退出（释放 SQLite 文件锁），再写回 U 盘
  try { await killOpenclaw() } catch {}
  try {
    await syncToUsb(usbRoot, syncLocals, (msg) => console.log(msg))
  } catch (e) {
    console.error('[sync] 写回失败:', e.message)
  }
  app.quit()
})

// ─── USB Monitor ───────────────────────────────────────────────────────────

function startUsbMonitor() {
  if (!app.isPackaged) return
  const drive = path.resolve(usbRoot).charAt(0).toUpperCase()

  let missCount = 0
  let checking = false
  usbMonitorTimer = setInterval(() => {
    if (checking) return
    checking = true
    fs.access(`${drive}:\\`, fs.constants.F_OK, (err) => {
      checking = false
      if (!err) { missCount = 0; return }
      if (++missCount < 3) return
      clearInterval(usbMonitorTimer)
      usbMonitorTimer = null
      killOpenclaw()
      mainWindow?.webContents.send('usb-removed')
      setTimeout(() => app.quit(), 2500)
    })
  }, 800)
}

// ─── Process management ────────────────────────────────────────────────────

function killOpenclaw() {
  if (!openclawProc) return Promise.resolve()
  const proc = openclawProc
  const pid = proc.pid
  openclawProc = null
  openclawStartedAt = null

  // 等子进程真正 exit 再 resolve，让调用方可以安全地做写回操作
  const exitPromise = new Promise(resolve => {
    let done = false
    const finish = () => { if (!done) { done = true; resolve() } }
    proc.once('exit', finish)
    // 5 秒兜底：即便 taskkill 没触发 exit 事件也不卡死
    setTimeout(finish, 5000)
  })

  // Windows 上 SIGTERM 等同于 SIGKILL，只杀主进程不杀子进程树
  // 所以直接用 taskkill /T 杀整棵进程树
  if (pid) {
    const { execFile } = require('child_process')
    const sys32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'system32')
    const taskkillExe = path.join(sys32, 'taskkill.exe')
    // 先温和终止（不加 /F），给进程 2 秒清理
    execFile(taskkillExe, ['/T', '/PID', String(pid)], { windowsHide: true, timeout: 3000 }, () => {
      // 2 秒后强制终止，确保不留僵尸
      setTimeout(() => {
        execFile(taskkillExe, ['/F', '/T', '/PID', String(pid)], { windowsHide: true, timeout: 3000 }, () => {})
      }, 2000)
    })
  } else {
    try { proc.kill() } catch {}
  }

  return exitPromise
}

// ─── IPC: Window ──────────────────────────────────────────────────────────

ipcMain.on('window-minimize', () => mainWindow?.minimize())
ipcMain.on('window-close',    () => app.quit())

async function openUrl(url) {
  try {
    await shell.openExternal(url)
  } catch {
    // 回退：用 rundll32 打开 URL，避免 cmd /c start 的命令注入风险
    const { execFile } = require('child_process')
    const rundll32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'system32', 'rundll32.exe')
    execFile(rundll32, ['url.dll,FileProtocolHandler', url], { windowsHide: true })
  }
}

ipcMain.handle('open-external', async (_, url) => {
  if (typeof url !== 'string' || (!url.startsWith('http://') && !url.startsWith('https://'))) {
    return { ok: false, error: 'invalid url' }
  }
  await openUrl(url)
  return { ok: true }
})

// ─── IPC: Navigation ──────────────────────────────────────────────────────

const ALLOWED_PAGES = ['setup', 'launcher']
ipcMain.handle('navigate', (_, page) => {
  if (!ALLOWED_PAGES.includes(page)) return { ok: false, error: 'invalid page' }
  mainWindow.loadFile(page + '.html')
  return { ok: true }
})

// ─── IPC: Setup ───────────────────────────────────────────────────────────

ipcMain.handle('get-setup-status', () => {
  if (!fs.existsSync(setupFile)) return { done: false }
  try {
    return { done: true, setup: JSON.parse(fs.readFileSync(setupFile, 'utf8')) }
  } catch { return { done: false } }
})

ipcMain.handle('save-setup', async (_, setup) => {
  try {
    await ensureDirs()
    await fs.promises.mkdir(configDir, { recursive: true })
    const configPath = path.join(configDir, 'openclaw.json')

    // 如果本机已有 openclaw 配置，先备份再合并（保留用户已有的非冲突字段）
    let existingConfig = null
    if (fs.existsSync(configPath)) {
      try {
        existingConfig = JSON.parse(await fs.promises.readFile(configPath, 'utf8'))
        const backupPath = configPath + '.bak'
        await fs.promises.copyFile(configPath, backupPath)
      } catch {}
    }

    const config = mergeUserConfig(buildOpenclawConfig(setup), existingConfig)

    await fs.promises.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8')
    await fs.promises.writeFile(setupFile, JSON.stringify({
      ...setup,
      apiKey: setup.apiKey ? '***' : '',
      savedAt: new Date().toISOString()
    }, null, 2), 'utf8')
    return { ok: true, hadExistingConfig: existingConfig !== null }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

// ─── IPC: Start / Stop OpenClaw ──────────────────────────────────────────

ipcMain.handle('get-openclaw-status', () => ({
  running: openclawProc !== null,
  startedAt: openclawStartedAt,
  port: 18789,
}))

ipcMain.handle('start-openclaw', async () => {
  if (openclawProc) return { ok: true, already: true }
  if (startingOpenclaw) return { ok: true, already: true }
  startingOpenclaw = true
  pluginRetryPhase = 0  // 用户主动启动时重置，允许重新走插件恢复流程

  // 1. 确保已安装
  try {
    await installToLocal()
  } catch (e) {
    startingOpenclaw = false
    return { ok: false, error: e.message }
  }

  const nodePath = getNodePath()
  const mjs = getOpenclawMjs()
  if (!mjs) { startingOpenclaw = false; return { ok: false, error: '程序文件未找到，请确认 U 盘内容完整' } }

  // 2. 确保配置存在
  const configPath = path.join(configDir, 'openclaw.json')
  if (!fs.existsSync(configPath)) {
    if (fs.existsSync(setupFile)) {
      try {
        const setup = JSON.parse(await fs.promises.readFile(setupFile, 'utf8'))
        const config = buildOpenclawConfig(setup)
        await fs.promises.mkdir(configDir, { recursive: true })
        await fs.promises.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8')
        startingOpenclaw = false
        return { ok: false, needApiKey: true, error: '配置已自动恢复，需要重新输入 API Key' }
      } catch (e) {
        console.error('[start-openclaw] rebuild from setup.json failed:', e.message)
      }
    }
    startingOpenclaw = false
    return { ok: false, error: '配置文件不存在，请先完成初始配置' }
  }

  // 3. 首次升级：如果旧 workspace 有数据但新位置没有，迁移过来
  const oldWorkspace = path.join(configDir, 'workspace')
  if (oldWorkspace !== syncLocals.workspace && fs.existsSync(oldWorkspace) && !fs.existsSync(syncLocals.workspace)) {
    try {
      await fs.promises.cp(oldWorkspace, syncLocals.workspace, { recursive: true })
      sendLog('[迁移] 已将旧 workspace 数据迁移到新位置 ✅\n')
    } catch (e) {
      sendLog('[迁移] 旧数据迁移失败: ' + e.message + '\n')
    }
  }

  // 4. 从 U 盘同步 workspace 和 memory 到本机（如果 U 盘上有更新的数据）
  sendLog('正在同步数据...\n')
  try {
    await syncFromUsb(usbRoot, syncLocals, (msg) => sendLog(msg + '\n'))
  } catch (e) {
    sendLog('[同步] 同步失败，使用本机数据继续启动: ' + e.message + '\n')
  }

  // 4. 刷新 gateway token（每次启动生成新 token，不动其他字段）
  await refreshGatewayToken()

  // 4.5 同步插件注册：扫描 extensions 目录，确保已安装的插件都在 allow + entries 中
  await syncPluginRegistry()

  // 5. 直接启动 gateway（不再重写配置文件，不跑 doctor --fix，避免删除插件字段）
  currentGatewayToken = null
  const LOG_MAX = 100000
  let gatewayLog = ''

  try {
    const safeCwd = (openclawDir && fs.existsSync(openclawDir)) ? openclawDir
                  : path.dirname(mjs)
    openclawProc = spawn(nodePath, [mjs, 'gateway'], {
      env: buildEnv(),
      cwd: safeCwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    const onLog = (d) => {
      const s = d.toString('utf8')
      gatewayLog += s
      if (gatewayLog.length > LOG_MAX) gatewayLog = gatewayLog.slice(-LOG_MAX)

      const result = translateLog(s)
      if (result === null) {
        if (s.trim()) sendLog(s)
      } else if (result.hide) {
        // 隐藏
      } else if (result.append) {
        sendLog(result.append + '\n')
      }
    }
    openclawProc.stdout.on('data', onLog)
    openclawProc.stderr.on('data', onLog)
    openclawStartedAt = Date.now()

    const startTime = openclawStartedAt
    openclawProc.on('exit', async (code) => {
      openclawProc = null
      openclawStartedAt = null
      currentGatewayToken = null

      const uptime = Date.now() - startTime

      // 配置问题兜底：启动前已跑过 doctor --fix，如果仍然快速退出且是配置错误，再修一次
      const isConfigError = /Config invalid|Invalid config|Unrecognized key|INVALID_CONFIG|Gateway start blocked/i.test(gatewayLog)
      if (uptime < 10000 && isConfigError) {
        sendLog('\n正在尝试修复配置...\n')
        const fixed = await repairConfigAuto()
        if (fixed) {
          sendLog('配置已修复，正在重新启动...\n')
          mainWindow?.webContents.send('openclaw-auto-restart')
          return
        }
        sendLog('自动修复未能解决问题，请联系售后支持\n')
      }

      // ─── 插件问题三阶段渐进式恢复 ───
      // 检测：快速退出 + 日志中含插件/TypeError 相关关键词
      const isPluginCrash = code !== 0 && uptime < 15000 &&
        /plugins?\.|non-bundled|plugin.*auto-load|TypeError.*read.*properties|Cannot read properties/i.test(gatewayLog)

      if (isPluginCrash && pluginRetryPhase < 3) {
        pluginRetryPhase++

        if (pluginRetryPhase === 1) {
          // 阶段1：补全注册信息后重试（最常见：安装了但没注册）
          sendLog('\n⚠️ 检测到插件问题，正在补全注册信息后重试...\n')
          await syncPluginRegistry()

        } else if (pluginRetryPhase === 2) {
          // 阶段2：定位并禁用有问题的那一个插件
          const suspect = extractCrashPluginId(gatewayLog)
          if (suspect) {
            sendLog(`\n⚠️ 插件 "${suspect}" 导致启动失败，已自动禁用该插件\n`)
            sendLog(`💡 其他插件不受影响，如需恢复请在 openclaw 配置中重新启用\n`)
            await disablePlugin(suspect)
          } else {
            // 无法定位具体插件，进入阶段3
            pluginRetryPhase = 3
          }

        }

        if (pluginRetryPhase === 3) {
          // 阶段3：全部禁用，保底启动
          sendLog('\n⚠️ 多个插件导致启动失败，已临时禁用全部第三方插件\n')
          sendLog('💡 OpenClaw 核心功能不受影响，禁用的插件可在配置中逐个重新启用排查\n')
          await disableAllThirdPartyPlugins()
        }

        mainWindow?.webContents.send('openclaw-auto-restart')
        return
      }

      // 网络瞬时错误
      const isNetworkError = /ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENOTFOUND|fetch failed/i.test(gatewayLog)
      if (code !== 0 && uptime < 30000 && isNetworkError) {
        mainWindow?.webContents.send('openclaw-network-retry')
      }
      // gateway 正常退出时回写数据到 U 盘
      if (code === 0) {
        syncToUsb(usbRoot, syncLocals, (msg) => sendLog(msg + '\n')).catch(() => {})
      }
      mainWindow?.webContents.send('openclaw-stopped', code)
    })

    openclawProc.on('error', err => {
      openclawProc = null
      sendLog('[错误] ' + err.message)
      mainWindow?.webContents.send('openclaw-stopped', -1)
    })

    startingOpenclaw = false
    return { ok: true }
  } catch (e) {
    startingOpenclaw = false
    return { ok: false, error: e.message }
  }
})

ipcMain.handle('stop-openclaw', async () => {
  // 等子进程真正退出（SQLite 文件锁释放），再同步
  try { await killOpenclaw() } catch {}
  sendLog('正在同步数据到 U 盘...\n')
  try {
    await syncToUsb(usbRoot, syncLocals, (msg) => sendLog(msg + '\n'))
  } catch (e) {
    sendLog('[同步] 写回失败: ' + e.message + '\n')
  }
  return { ok: true }
})

// ─── IPC: Repair config ────────────────────────────────────────────────────

ipcMain.handle('repair-config', async () => {
  try {
    const configPath = path.join(configDir, 'openclaw.json')

    // 从 setup.json 重建（注意：setup.json 中的 apiKey 已脱敏为 ***，需要用户重新输入）
    if (!fs.existsSync(configPath) && fs.existsSync(setupFile)) {
      try {
        const setup = JSON.parse(await fs.promises.readFile(setupFile, 'utf8'))
        await fs.promises.mkdir(configDir, { recursive: true })
        const config = buildOpenclawConfig(setup)
        await fs.promises.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8')
        // setup.json 中 apiKey 为 ***，重建后必须让用户重新输入
        await refreshGatewayToken()
        return { ok: false, needsReconfig: true, error: '配置已重建，需要重新输入 API Key，请点击"修改 API Key"' }
      } catch (e) {
        return { ok: false, error: '从已有配置重建失败: ' + e.message }
      }
    }

    if (!fs.existsSync(configPath)) return { ok: false, error: '配置文件不存在，请先完成初始配置' }

    // 修复配置：先 doctor --fix，失败则直接清理脏字段
    await repairConfigAuto()

    // 验证配置文件是否完好
    try {
      const cfg = JSON.parse(await fs.promises.readFile(configPath, 'utf8'))
      if (cfg.gateway?.auth?.token) return { ok: true }
      // 配置完好但缺 token，补上即可
      await refreshGatewayToken()
      return { ok: true }
    } catch {
      // JSON 损坏 → 备份后重建最小配置
      await fs.promises.copyFile(configPath, configPath + '.bak').catch(() => {})
      await fs.promises.unlink(configPath).catch(() => {})
      const newToken = crypto.randomBytes(24).toString('hex')
      const minimalConfig = {
        meta: { lastTouchedVersion: APP_VERSION, lastTouchedAt: new Date().toISOString() },
        gateway: {
          mode: 'local',
          auth: { mode: 'token', token: newToken },
          controlUi: { allowInsecureAuth: true, dangerouslyDisableDeviceAuth: true }
        },
        update: { checkOnStart: false }
      }
      await fs.promises.writeFile(configPath, JSON.stringify(minimalConfig, null, 2), 'utf8')
      return { ok: false, needsReconfig: true, error: '配置文件已损坏并重建，需要重新输入 API Key，请点击"修改 API Key"' }
    }

    return { ok: false, error: '修复失败，请联系售后支持' }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

// ─── IPC: Update API Key ──────────────────────────────────────────────────

ipcMain.handle('update-api-key', async (_, payload) => {
  try {
    const configPath = path.join(configDir, 'openclaw.json')
    if (!fs.existsSync(configPath)) return { ok: false, error: '配置文件不存在，请先完成初始配置' }
    if (!fs.existsSync(setupFile)) return { ok: false, error: '初始配置不存在，请先完成初始配置' }

    const newKey  = typeof payload === 'string' ? payload : payload.key
    const setup   = JSON.parse(await fs.promises.readFile(setupFile, 'utf8'))
    const cfg     = JSON.parse(await fs.promises.readFile(configPath, 'utf8'))
    const provider = (typeof payload === 'object' && payload.provider) ? payload.provider : setup.aiProvider

    // 切换服务商时，先清除所有旧的 API Key 配置
    if (provider !== setup.aiProvider) {
      if (cfg.env) {
        delete cfg.env.ANTHROPIC_API_KEY
        delete cfg.env.ANTHROPIC_BASE_URL
        delete cfg.env.OPENAI_API_KEY
        delete cfg.env.ZAI_API_KEY
      }
      delete cfg.models
    }

    applyProviderConfig(cfg, provider, newKey, {
      baseUrl: (typeof payload === 'object' && payload.baseUrl) || setup.baseUrl,
      modelId: (typeof payload === 'object' && payload.modelId) || setup.customModelId,
    })

    await fs.promises.writeFile(configPath, JSON.stringify(cfg, null, 2), 'utf8')

    // 同步更新 setup.json
    const providerChanged = provider !== setup.aiProvider
    setup.aiProvider = provider
    setup.apiKey = '***'
    setup.savedAt = new Date().toISOString()
    if (providerChanged) { delete setup.baseUrl; delete setup.customModelId }
    if (provider === 'custom') {
      setup.baseUrl = (typeof payload === 'object' && payload.baseUrl) || ''
      setup.customModelId = (typeof payload === 'object' && payload.modelId) || ''
    }
    if (provider === 'volcengine') {
      setup.customModelId = (typeof payload === 'object' && payload.modelId) || ''
    }
    await fs.promises.writeFile(setupFile, JSON.stringify(setup, null, 2), 'utf8')

    // 同步到 agent 的 models.json + auth-profiles.json（openclaw 子 agent 直接读这两个，
    // 不会自动从 openclaw.json 再读一次；不同步的话用户保存了新 key 也没生效）
    try {
      await syncAgentAuth(cfg, newKey, provider)
    } catch (e) {
      console.warn('[update-api-key] syncAgentAuth failed:', e.message)
    }

    return { ok: true, provider }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

// 把最新 key 同步到 agents/main/agent/{models.json, auth-profiles.json}
async function syncAgentAuth(cfg, key, provider) {
  const agentDir = path.join(configDir, 'agents', 'main', 'agent')
  if (!fs.existsSync(agentDir)) return  // 首次启动 openclaw 之前，agent 目录还没创建

  // 灵境/自定义/openai 类通通归一到 "openai" provider
  const providerKey = (provider === 'anthropic') ? 'anthropic' : 'openai'

  // ① models.json
  const modelsPath = path.join(agentDir, 'models.json')
  if (fs.existsSync(modelsPath)) {
    try {
      const m = JSON.parse(await fs.promises.readFile(modelsPath, 'utf8'))
      m.providers = m.providers || {}
      const src = cfg.models?.providers?.[providerKey]
      if (src) m.providers[providerKey] = { ...src }
      await fs.promises.writeFile(modelsPath, JSON.stringify(m, null, 2), 'utf8')
    } catch (e) {
      console.warn('[syncAgentAuth] models.json failed:', e.message)
    }
  }

  // ② auth-profiles.json
  const authPath = path.join(agentDir, 'auth-profiles.json')
  if (fs.existsSync(authPath)) {
    try {
      const ap = JSON.parse(await fs.promises.readFile(authPath, 'utf8'))
      ap.profiles = ap.profiles || {}
      ap.profiles[`${providerKey}:default`] = {
        type: 'api_key',
        provider: providerKey,
        key,
      }
      ap.lastGood = ap.lastGood || {}
      ap.lastGood[providerKey] = `${providerKey}:default`
      await fs.promises.writeFile(authPath, JSON.stringify(ap, null, 2), 'utf8')
    } catch (e) {
      console.warn('[syncAgentAuth] auth-profiles.json failed:', e.message)
    }
  }
}

// ─── IPC: Validate API Key ────────────────────────────────────────────────

const API_VALIDATORS = {
  anthropic: (key, baseUrl) => ({
    url: (baseUrl || 'https://api.anthropic.com') + '/v1/models',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
  }),
  openai: (key, baseUrl) => ({
    url: (baseUrl || 'https://api.openai.com') + '/v1/models',
    headers: { 'Authorization': 'Bearer ' + key }
  }),
  deepseek: (key) => ({
    url: 'https://api.deepseek.com/v1/models',
    headers: { 'Authorization': 'Bearer ' + key }
  }),
  qwen: (key) => ({
    url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/models',
    headers: { 'Authorization': 'Bearer ' + key }
  }),
  glm: (key) => ({
    url: 'https://open.bigmodel.cn/api/paas/v4/models',
    headers: { 'Authorization': 'Bearer ' + key }
  }),
  volcengine: (key) => ({
    url: 'https://ark.cn-beijing.volces.com/api/v3/models',
    headers: { 'Authorization': 'Bearer ' + key }
  }),
  custom: (key, baseUrl) => {
    if (!baseUrl) return null
    return {
      url: baseUrl.replace(/\/+$/, '') + '/models',
      headers: { 'Authorization': 'Bearer ' + key }
    }
  },
}

ipcMain.handle('validate-api-key', async (_, { key, provider, baseUrl }) => {
  const builder = API_VALIDATORS[provider]
  if (!builder) return { ok: true }
  const validatorConfig = builder(key, baseUrl)
  if (!validatorConfig) return { ok: true }  // custom 无 baseUrl 时跳过验证

  try {
    const { URL } = require('url')
    const url = new URL(validatorConfig.url)

    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return { ok: false, error: 'API 地址协议不支持，请使用 http:// 或 https://' }
    }

    const httpModule = url.protocol === 'https:' ? require('https') : require('http')

    const result = await new Promise((resolve) => {
      let resolved = false
      const done = (val) => { if (!resolved) { resolved = true; resolve(val) } }

      const req = httpModule.request(url, {
        method: validatorConfig.body ? 'POST' : 'GET',
        headers: validatorConfig.headers,
        timeout: 15000,
      }, (res) => {
        const MAX_BODY = 1024 * 1024  // 1 MB 上限，防止恶意/误配服务商返回超大响应
        let data = ''
        let aborted = false
        res.on('data', chunk => {
          if (aborted) return
          data += chunk
          if (data.length > MAX_BODY) {
            aborted = true
            try { req.destroy() } catch {}
            done({ ok: false, error: '响应过大，已中止（>1MB）' })
          }
        })
        res.on('end', () => {
          if (aborted) return
          if (res.statusCode === 401 || res.statusCode === 403) {
            let msg = 'API Key 无效或已过期'
            try {
              const body = JSON.parse(data)
              const errMsg = body.error?.message || body.message || ''
              if (errMsg.includes('quota') || errMsg.includes('balance') || errMsg.includes('insufficient'))
                msg = 'API Key 有效，但账户余额不足'
              else if (errMsg.includes('expired'))
                msg = 'API Key 已过期，请更换'
              else if (errMsg.includes('invalid'))
                msg = 'API Key 无效，请检查是否复制完整'
            } catch {}
            done({ ok: false, error: msg })
          } else {
            done({ ok: true })
          }
        })
      })
      req.on('timeout', () => { req.destroy(); done({ ok: false, error: '连接超时，请检查网络（15秒）' }) })
      req.on('error', (e) => {
        if (e.code === 'ENOTFOUND') done({ ok: false, error: '无法连接服务商，请检查网络' })
        else if (e.code === 'ECONNREFUSED') done({ ok: false, error: '服务商拒绝连接，请检查网络' })
        else done({ ok: false, error: '网络错误: ' + e.message })
      })
      if (validatorConfig.body) req.write(validatorConfig.body)
      req.end()
    })

    return result
  } catch (e) {
    return { ok: false, error: '验证失败: ' + e.message }
  }
})

// ─── IPC: 技能商店 ───────────────────────────────────────────────────────

ipcMain.handle('check-skill-installed', async (_, skillId) => {
  const manifest = path.join(configDir, 'extensions', skillId, 'openclaw.plugin.json')
  const installed = fs.existsSync(manifest)
  // 发现已安装但未注册 → 自动补注册
  if (installed) await registerPlugin(skillId)
  return { installed }
})

// 安装命令参数白名单：只允许安全字符（字母数字、@./\-_:+、https 绝对 URL）
const SKILL_INSTALL_ARG_RE = /^(-y|--yes|install|plugins|[a-zA-Z0-9@._:+\-\/]+|https:\/\/[a-zA-Z0-9._\-\/%+?=&#]+)$/
const SKILL_INSTALL_CMDS = new Set(['npx', 'openclaw'])

ipcMain.handle('install-skill', async (_, cmdArray) => {
  // cmdArray: ['npx', '-y', 'https://...tgz', 'install'] 或 ['openclaw', 'plugins', 'install', 'name']
  if (!Array.isArray(cmdArray) || cmdArray.length < 2) {
    return { ok: false, error: '无效的安装命令' }
  }
  if (!SKILL_INSTALL_CMDS.has(cmdArray[0])) {
    return { ok: false, error: '不允许的命令前缀: ' + cmdArray[0] }
  }
  for (let i = 1; i < cmdArray.length; i++) {
    const a = cmdArray[i]
    if (typeof a !== 'string' || !SKILL_INSTALL_ARG_RE.test(a)) {
      return { ok: false, error: '非法参数: ' + a }
    }
  }

  const nodePath = getNodePath()
  // 如果命令以 npx 开头，用本机安装的 Node.js 目录中的 npx
  let cmd, args
  if (cmdArray[0] === 'npx') {
    const npxLocal = path.join(nodeDir, 'npx.cmd')
    const _appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
    const npxGlobal = path.join(_appData, 'npm', 'npx.cmd')
    cmd = fs.existsSync(npxLocal) ? npxLocal : fs.existsSync(npxGlobal) ? npxGlobal : 'npx'
    args = cmdArray.slice(1)
  } else {
    cmd = nodePath
    const mjs = getOpenclawMjs()
    if (!mjs) return { ok: false, error: 'OpenClaw 未安装' }
    args = [mjs, ...cmdArray.slice(1)]
  }

  sendLog(`正在执行: ${cmdArray.join(' ')}\n`)

  // openclaw plugins install 前清理已有插件目录（否则报 "plugin already exists"）
  if (cmdArray[0] === 'openclaw' && cmdArray[1] === 'plugins' && cmdArray[2] === 'install') {
    const skillId = cmdArray.find(a => a.includes('weixin')) ? 'openclaw-weixin'
                  : cmdArray.find(a => a.includes('feishu')) ? 'feishu-openclaw-plugin'
                  : null
    if (skillId) {
      const extDir = path.join(configDir, 'extensions', skillId)
      if (fs.existsSync(extDir)) {
        try { fs.rmSync(extDir, { recursive: true, force: true }) } catch {}
        sendLog(`已清理旧版 ${skillId}\n`)
      }
    }
  }

  const cwd = (openclawDir && fs.existsSync(openclawDir)) ? openclawDir
            : fs.existsSync(installDir) ? installDir
            : os.tmpdir()

  return new Promise(resolve => {
    const proc = spawn(cmd, args, {
      env: buildEnv(),
      cwd,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    proc.stdout.on('data', d => sendLog(d.toString('utf8')))
    proc.stderr.on('data', d => sendLog(d.toString('utf8')))
    proc.on('exit', async (code) => {
      // 从命令参数推断插件 id
      const skillId = cmdArray.find(a => a.includes('weixin')) ? 'openclaw-weixin'
                    : cmdArray.find(a => a.includes('feishu')) ? 'feishu-openclaw-plugin'
                    : null

      if (code === 0) {
        // 安装成功 → 注册插件到 allow + entries
        if (skillId) await registerPlugin(skillId)
        return resolve({ ok: true })
      }
      // 退出码非 0 但插件文件已存在（CLI 的登录/重启步骤失败不影响安装）
      if (skillId) {
        const manifest = path.join(configDir, 'extensions', skillId, 'openclaw.plugin.json')
        if (fs.existsSync(manifest)) {
          await registerPlugin(skillId)
          sendLog('插件文件已安装，后续配置可稍后完成\n')
          return resolve({ ok: true })
        }
      }
      resolve({ ok: false, error: `安装失败 (exit ${code})` })
    })
    proc.on('error', err => {
      resolve({ ok: false, error: err.message })
    })
  })
})

// ─── IPC: Install Feishu Plugin (multi-step) ────────────────────────────

ipcMain.handle('install-feishu-plugin', async () => {
  const https = require('https')
  const tgzUrl = 'https://sf3-cn.feishucdn.com/obj/open-platform-opendoc/c53145d7b9eb0e29f4e07bf051231230_XjCy46mAFI.tgz'
  const tmpFile = path.join(os.tmpdir(), 'feishu-openclaw-plugin-onboard-cli.tgz')

  // 查找 npm：优先本地 nodeDir，然后系统 npm
  const npmCmd = path.join(nodeDir, 'npm.cmd')
  const npmFallback = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'npm', 'npm.cmd')
  const npm = fs.existsSync(npmCmd) ? npmCmd
            : fs.existsSync(npmFallback) ? npmFallback
            : 'npm'

  // 安全的 cwd
  const safeCwd = (openclawDir && fs.existsSync(openclawDir)) ? openclawDir
                : fs.existsSync(installDir) ? installDir
                : os.tmpdir()

  // Step 1: Download tgz
  sendLog('【飞书插件】步骤 1/3: 下载插件包...\n')
  try {
    await new Promise((resolve, reject) => {
      const follow = (url) => {
        https.get(url, { headers: { 'User-Agent': 'OpenClaw-Launcher' } }, res => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            follow(res.headers.location)
            return
          }
          if (res.statusCode !== 200) {
            reject(new Error(`下载失败 HTTP ${res.statusCode}`))
            return
          }
          const ws = fs.createWriteStream(tmpFile)
          res.pipe(ws)
          ws.on('finish', () => { ws.close(); resolve() })
          ws.on('error', reject)
        }).on('error', reject)
      }
      follow(tgzUrl)
    })
    sendLog('【飞书插件】下载完成 ✅\n')
  } catch (err) {
    sendLog('【飞书插件】下载失败: ' + err.message + '\n')
    return { ok: false, error: '下载插件包失败: ' + err.message }
  }

  // Step 2: npm install -g
  sendLog('【飞书插件】步骤 2/3: 全局安装插件...\n')
  const step2 = await new Promise(resolve => {
    const proc = spawn(npm, ['install', tmpFile, '-g'], {
      env: buildEnv(),
      cwd: safeCwd,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    proc.stdout.on('data', d => sendLog(d.toString('utf8')))
    proc.stderr.on('data', d => sendLog(d.toString('utf8')))
    proc.on('exit', code => resolve(code))
    proc.on('error', err => { sendLog('npm 错误: ' + err.message + '\n'); resolve(1) })
  })
  // Clean up tmp file
  try { fs.unlinkSync(tmpFile) } catch {}

  if (step2 !== 0) {
    sendLog('【飞书插件】npm install 失败\n')
    return { ok: false, error: 'npm install 失败' }
  }
  sendLog('【飞书插件】npm install 完成 ✅\n')

  // Step 2.5: Patch feishu version check bug (openclaw --version returns "OpenClaw 2026.x.x (hash)")
  try {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
    const npmGlobalDir = path.join(appData, 'npm', 'node_modules')
    const installJs = path.join(npmGlobalDir, '@lark-open', 'feishu-plugin-onboard-cli', 'dist', 'commands', 'install.js')
    if (fs.existsSync(installJs)) {
      let code = fs.readFileSync(installJs, 'utf8')
      if (code.includes('const version = (0, system_1.runCommandQuiet)')) {
        code = code.replace(
          'const version = (0, system_1.runCommandQuiet)(`${openclawCmd} --version`);',
          'const versionRaw = (0, system_1.runCommandQuiet)(`${openclawCmd} --version`);\n        const version = (versionRaw.match(/(\\d+\\.\\d+\\.\\d+)/) || [])[1] || versionRaw.trim();'
        )
        fs.writeFileSync(installJs, code, 'utf8')
        sendLog('【飞书插件】已修补版本检查兼容性\n')
      } else {
        sendLog('【飞书插件】install.js 已更新（未匹配到旧版本检查代码），跳过补丁\n')
      }
    } else {
      sendLog(`【飞书插件】⚠️ 未找到 ${installJs}（目录结构可能已变化），跳过补丁\n`)
    }
  } catch (e) {
    sendLog('【飞书插件】补丁跳过: ' + e.message + '\n')
  }

  // Step 2.6: 验证 feishu-plugin-onboard 可执行文件存在
  const onboardCmd = path.join(nodeDir, 'feishu-plugin-onboard.cmd')
  const appDataDir = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  const onboardFallback = path.join(appDataDir, 'npm', 'feishu-plugin-onboard.cmd')
  const onboardExists = fs.existsSync(onboardCmd) || fs.existsSync(onboardFallback)
  if (!onboardExists) {
    sendLog('【飞书插件】未找到 feishu-plugin-onboard 命令，npm install 可能未完成\n')
    return { ok: false, error: '未找到 feishu-plugin-onboard 命令' }
  }

  // Step 3: feishu-plugin-onboard install (需要交互输入，打开终端窗口)
  sendLog('【飞书插件】步骤 3/3: 打开终端窗口进行配置...\n')
  sendLog('【飞书插件】请在弹出的终端窗口中按提示完成配置（输入 App ID、App Secret 等）\n')

  const feishuEnv = buildEnv()
  const cmdExe = process.env.ComSpec || path.join(process.env.SystemRoot || 'C:\\Windows', 'system32', 'cmd.exe')
  const envStr = Object.entries(feishuEnv)
    .filter(([k]) => k === 'PATH' || k === 'npm_config_registry' || k === 'ComSpec')
    .map(([k, v]) => `set "${k}=${v}"`)
    .join(' && ')

  const step3 = await new Promise(resolve => {
    const proc = spawn(cmdExe, ['/c', 'start', cmdExe, '/k',
      `${envStr ? envStr + ' && ' : ''}feishu-plugin-onboard install && echo. && echo 飞书插件安装完成！可以关闭此窗口。 && pause`
    ], {
      env: feishuEnv,
      cwd: safeCwd,
      shell: false,
      stdio: 'ignore',
      detached: true
    })
    proc.unref()
    proc.on('exit', () => resolve(0))
    proc.on('error', err => { sendLog('打开终端失败: ' + err.message + '\n'); resolve(1) })
  })

  if (step3 !== 0) {
    sendLog('【飞书插件】打开终端失败\n')
    return { ok: false, error: '无法打开终端窗口' }
  }
  sendLog('【飞书插件】终端窗口已打开，请在终端中完成配置 ✅\n')
  sendLog('【飞书插件】配置完成后点击"刷新"按钮检查安装状态\n')
  return { ok: true }
})

// ─── IPC: Version ─────────────────────────────────────────────────────────

ipcMain.handle('get-version', () => app.getVersion())

// ─── IPC: Auth (V5) ───────────────────────────────────────────────────────
// 统一错误封装：renderer 拿到 { ok: true, data } 或 { ok: false, error: {status,code,message} }
function wrapAuth(label, fn) {
  return async (...args) => {
    try {
      const data = await fn(...args)
      pushLoginDebug('info', `${label} OK`)
      return { ok: true, data }
    } catch (e) {
      const err = {
        status: e && e.status != null ? e.status : 0,
        code: e && e.code != null ? e.code : null,
        message: (e && e.message) || '未知错误',
      }
      pushLoginDebug('error', `${label} FAIL: ${err.message} (status=${err.status}, code=${err.code})`)
      return { ok: false, error: err }
    }
  }
}

ipcMain.handle('auth:send-code', wrapAuth('send-code', async (_e, email) => {
  if (!authManager) throw new Error('AuthManager not initialized')
  return await authManager.sendCode(email)
}))

ipcMain.handle('auth:register', wrapAuth('register', async (_e, payload) => {
  if (!authManager) throw new Error('AuthManager not initialized')
  return await authManager.register(payload)
}))

ipcMain.handle('auth:login', wrapAuth('login', async (_e, payload) => {
  if (!authManager) throw new Error('AuthManager not initialized')
  return await authManager.login(payload)
}))

ipcMain.handle('auth:logout', wrapAuth('logout', async () => {
  if (!authManager) throw new Error('AuthManager not initialized')
  await authManager.logout()
  return { ok: true }
}))

ipcMain.handle('auth:is-logged-in', wrapAuth('is-logged-in', async () => {
  return authManager ? authManager.isLoggedIn() : false
}))

ipcMain.handle('auth:get-user', wrapAuth('get-user', async () => {
  return authManager ? authManager.getUserProfile() : null
}))

ipcMain.handle('auth:refresh-user', wrapAuth('refresh-user', async () => {
  if (!authManager) return null
  return await authManager.refreshUserProfile()
}))

ipcMain.handle('auth:reload', wrapAuth('reload', async () => {
  if (!authManager) throw new Error('AuthManager not initialized')
  return await authManager.load()
}))

// ─── IPC: 登录窗控制 ──────────────────────────────────────────────────────

ipcMain.on('login-win:minimize', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender)
  if (w && !w.isDestroyed()) w.minimize()
})

ipcMain.on('login-win:close', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender)
  if (w && !w.isDestroyed()) w.close()
})

ipcMain.on('login-win:transition-to-main', () => {
  transitionLoginToMain()
})

// ─── IPC: 主窗口控制 ─────────────────────────────────────────────────────

ipcMain.handle('main-win:logout', async () => {
  try {
    if (authManager) await authManager.logout()
  } catch (e) {
    console.error('[main-win:logout] authManager.logout failed:', e.message)
  }
  transitionMainToLogin()
  return { ok: true }
})

ipcMain.on('main-win:transition-to-login', () => {
  transitionMainToLogin()
})

// ─── IPC: V5 Token 管理 + 模型目录 ───────────────────────────────────────
// 默认 token 配置：永不过期 + 不限额 + 全模型
const DEFAULT_TOKEN_NAME = 'launcher-default'
function defaultTokenPayload(name = DEFAULT_TOKEN_NAME) {
  return {
    name,
    expired_time: -1,
    remain_quota: 0,
    unlimited_quota: true,
    models: null,
  }
}

// 拉已有 token；为空时自动创建一个 launcher-default；返回首个 token 的完整记录
ipcMain.handle('token:list-or-create', async () => {
  if (!authManager || !authManager.isLoggedIn()) {
    return { ok: false, error: { message: 'Not logged in' } }
  }
  try {
    const list = await authManager.apiClient.get('/api/token/')
    if (Array.isArray(list) && list.length > 0) {
      return { ok: true, data: list[0] }
    }
    // 空列表 → 创建一个
    const created = await authManager.apiClient.post('/api/token/', defaultTokenPayload())
    return { ok: true, data: created }
  } catch (e) {
    return { ok: false, error: { message: e.message, status: e.status || 0, code: e.code || null } }
  }
})

// 重置 token：删旧 + 建新
ipcMain.handle('token:reset', async () => {
  if (!authManager || !authManager.isLoggedIn()) {
    return { ok: false, error: { message: 'Not logged in' } }
  }
  try {
    const list = await authManager.apiClient.get('/api/token/')
    if (Array.isArray(list)) {
      for (const t of list) {
        try { await authManager.apiClient.del(`/api/token/${t.id}`) } catch {}
      }
    }
    const created = await authManager.apiClient.post('/api/token/', defaultTokenPayload())
    return { ok: true, data: created }
  } catch (e) {
    return { ok: false, error: { message: e.message, status: e.status || 0, code: e.code || null } }
  }
})

// 拉官方已上架的模型目录（公开接口，无需 cookie）
ipcMain.handle('models:list-official', async () => {
  if (!authManager) {
    return { ok: false, error: { message: 'AuthManager not initialized' } }
  }
  try {
    const list = await authManager.apiClient.get('/api/lingjing/model-prices', { auth: false })
    const visible = Array.isArray(list) ? list.filter(m => m.is_visible !== false) : []
    visible.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))
    return { ok: true, data: visible }
  } catch (e) {
    return { ok: false, error: { message: e.message, status: e.status || 0, code: e.code || null } }
  }
})

// ─── IPC: V5 充值（灵境AI 聚合支付）─────────────────────────────────────
function topupErrWrap(fn) {
  return async (...args) => {
    if (!authManager) return { ok: false, error: { message: 'AuthManager not initialized' } }
    try {
      const data = await fn(...args)
      return { ok: true, data }
    } catch (e) {
      return { ok: false, error: { message: e.message, status: e.status || 0, code: e.code || null } }
    }
  }
}

// 套餐列表（公开）
ipcMain.handle('topup:list-plans', topupErrWrap(async () => {
  const list = await authManager.apiClient.get('/api/lingjing/plans', { auth: false })
  const visible = Array.isArray(list) ? list.filter(p => p.is_available !== false) : []
  visible.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || a.price - b.price)
  return visible
}))

// 支付方式开关（公开）
ipcMain.handle('topup:pay-config', topupErrWrap(async () => {
  return await authManager.apiClient.get('/api/lingjing/pay/config', { auth: false })
}))

// 创建订单：返回 { pay_url, order_no, amount, quota }
ipcMain.handle('topup:create-order', topupErrWrap(async (_e, { planId, payType }) => {
  return await authManager.apiClient.post('/api/lingjing/pay/create', {
    plan_id: planId,
    pay_type: payType || 'alipay',
  })
}))

// 查订单状态：status 0=pending, 1=paid
ipcMain.handle('topup:order-status', topupErrWrap(async (_e, orderNo) => {
  return await authManager.apiClient.get(`/api/lingjing/pay/order/${encodeURIComponent(orderNo)}`)
}))

// 兑换码
ipcMain.handle('topup:redeem', topupErrWrap(async (_e, key) => {
  return await authManager.apiClient.post('/api/user/topup', { key })
}))

// ─── IPC: V5 技能列表（扫描已安装技能）──────────────────────────────────
// SKILL.md 格式：以 --- 包住的 YAML frontmatter，包含 name / description 等字段
function parseSkillFrontmatter(content) {
  const m = content.match(/^---\s*\n([\s\S]*?)\n---/)
  if (!m) return {}
  const body = m[1]
  const meta = {}
  let currentKey = null
  let currentVal = []
  const flush = () => {
    if (currentKey) meta[currentKey] = currentVal.join('\n').trim()
  }
  for (const line of body.split(/\r?\n/)) {
    const kv = line.match(/^([a-zA-Z_][\w-]*)\s*:\s*(.*)$/)
    if (kv) {
      flush()
      currentKey = kv[1]
      const v = kv[2].trim()
      currentVal = v === '|' || v === '|-' || v === '' ? [] : [v]
    } else if (currentKey) {
      currentVal.push(line.replace(/^\s{2,}/, ''))
    }
  }
  flush()
  return meta
}

// 支持页：拉客服配置（公开接口）
ipcMain.handle('support:config', async () => {
  if (!authManager) return { ok: false, error: { message: 'AuthManager not initialized' } }
  try {
    const data = await authManager.apiClient.get('/api/lingjing/config', { auth: false })
    return { ok: true, data }
  } catch (e) {
    return { ok: false, error: { message: e.message, status: e.status || 0 } }
  }
})

ipcMain.handle('skills:list', async () => {
  const extRoot = path.join(configDir, 'extensions')
  const skills = []
  try {
    if (!fs.existsSync(extRoot)) return { ok: true, data: [] }
    const pluginDirs = fs.readdirSync(extRoot, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.'))
    for (const plug of pluginDirs) {
      const skillsDir = path.join(extRoot, plug.name, 'skills')
      if (!fs.existsSync(skillsDir)) continue
      const skillDirs = fs.readdirSync(skillsDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
      for (const s of skillDirs) {
        const skillMd = path.join(skillsDir, s.name, 'SKILL.md')
        if (!fs.existsSync(skillMd)) continue
        let meta = {}
        try {
          const content = await fs.promises.readFile(skillMd, 'utf8')
          meta = parseSkillFrontmatter(content)
        } catch {}
        const desc = (meta.description || '').split(/\n/)[0].trim()
        skills.push({
          id: s.name,
          name: meta.name || s.name,
          description: desc || '—',
          source: plug.name,
          path: path.join(skillsDir, s.name),
        })
      }
    }
    skills.sort((a, b) => (a.source + a.name).localeCompare(b.source + b.name))
    return { ok: true, data: skills }
  } catch (e) {
    return { ok: false, error: { message: e.message } }
  }
})

// ─── IPC: Preflight check ─────────────────────────────────────────────────

function checkPortFreeOn(port, host) {
  return new Promise(resolve => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.once('listening', () => srv.close(() => resolve(true)))
    srv.listen(port, host)
  })
}

// 同时检测 IPv4 和 IPv6，任一被占就算占用（openclaw 可能绑 ::1）
async function checkPortFree(port) {
  const [v4, v6] = await Promise.all([
    checkPortFreeOn(port, '127.0.0.1'),
    checkPortFreeOn(port, '::1').catch(() => true)  // IPv6 不可用时视为空闲
  ])
  return v4 && v6
}

// 查找占用指定端口的进程（先 netstat 再 PowerShell 回退）
function findPortProcesses(portNum) {
  const { execFileSync } = require('child_process')

  // 方法 1: netstat（所有 Windows 都支持，不依赖 PowerShell）
  try {
    const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], {
      encoding: 'utf8', timeout: 5000, windowsHide: true
    })
    const results = []
    for (const line of out.split(/\r?\n/)) {
      // 匹配 LISTENING 或 ESTABLISHED 状态的行（兼容 IPv4 和 IPv6）
      const m = line.match(/\s+(?:TCP)\s+\S+:(\d+)\s+.*\s+(\d+)\s*$/)
      if (m && parseInt(m[1], 10) === portNum) {
        const pid = parseInt(m[2], 10)
        if (pid > 0 && !results.some(r => r.pid === pid)) {
          // 尝试获取进程名
          let name = ''
          try {
            const info = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
              encoding: 'utf8', timeout: 3000, windowsHide: true
            })
            const nameMatch = info.match(/"([^"]+)"/)
            if (nameMatch) name = nameMatch[1].replace(/\.exe$/i, '')
          } catch {}
          results.push({ pid, name })
        }
      }
    }
    if (results.length > 0) return results
  } catch {}

  // 方法 2: PowerShell（回退）
  try {
    const script = `Get-NetTCPConnection -LocalPort ${portNum} -ErrorAction SilentlyContinue | ForEach-Object { $p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue; if($p){ "$($_.OwningProcess)|$($p.ProcessName)" } }`
    const out = execFileSync('powershell', ['-NoProfile', '-Command', script], {
      encoding: 'utf8', timeout: 5000, windowsHide: true
    })
    return out.trim().split(/\r?\n/).filter(Boolean).map(line => {
      const [pidStr, name] = line.trim().split('|')
      return { pid: parseInt(pidStr, 10), name: name || '' }
    }).filter(r => r.pid > 0)
  } catch {}

  return []
}

ipcMain.handle('kill-port', async (_, port) => {
  const portNum = parseInt(port, 10)
  if (!Number.isInteger(portNum) || portNum <= 0 || portNum > 65535) {
    return { ok: false, error: '无效的端口号' }
  }

  const processes = findPortProcesses(portNum)
  if (processes.length === 0) return { ok: false, error: '未找到占用端口的进程' }

  const safeNames = new Set(['node', 'node.exe', 'openclaw', 'openclaw.exe'])
  let killed = 0
  const skipped = []
  for (const { pid, name } of processes) {
    if (safeNames.has(name.toLowerCase()) || safeNames.has(name.toLowerCase() + '.exe')) {
      try { process.kill(pid); killed++ } catch {}
    } else {
      skipped.push(name || String(pid))
    }
  }
  if (killed === 0 && skipped.length > 0) {
    return new Promise(r => setTimeout(() => r({
      ok: false,
      error: `端口被其他程序占用（${skipped.join(', ')}），请手动关闭该程序后重试`
    }), 200))
  }
  return new Promise(r => setTimeout(() => r({ ok: killed > 0, killed }), 500))
})

ipcMain.handle('preflight-check', async () => {
  const results = []

  // 1. Node.js runtime
  const nodePath = getNodePath()
  // 1. Node.js runtime（未安装不阻塞，start-openclaw 会自动从 U 盘复制）
  const nodeExists = nodePath !== 'node' ? fs.existsSync(nodePath) : true
  results.push({
    id: 'node', label: 'Node.js 运行环境', ok: true, warn: !nodeExists,
    detail: nodeExists ? '正常' : '运行环境缺失，将在首次启动时自动安装'
  })

  // 2. OpenClaw program files（未安装不阻塞，start-openclaw 会自动安装）
  const mjs = getOpenclawMjs()
  results.push({
    id: 'openclaw', label: 'OpenClaw 程序文件', ok: true, warn: mjs === null,
    detail: mjs !== null ? '正常' : '未安装，将在首次启动时自动安装'
  })

  // 3. Port
  const portFree = await checkPortFree(18789)
  results.push({
    id: 'port', label: '端口 18789', ok: portFree, warn: !portFree,
    detail: portFree ? '正常' : '被占用，将自动释放'
  })

  // 4. Config
  const configPath = path.join(configDir, 'openclaw.json')
  let configOk = false, configDetail = ''
  if (!fs.existsSync(configPath)) {
    configDetail = '未找到，启动时将自动创建'
  } else {
    try {
      const cfg = JSON.parse(await fs.promises.readFile(configPath, 'utf8'))
      if (cfg.gateway?.auth?.mode === 'token' && cfg.gateway?.auth?.token) {
        configOk = true
        configDetail = '配置正常'
      } else {
        configDetail = '需要更新，启动时将自动修复'
      }
    } catch {
      configDetail = '文件损坏，点击"一键修复"即可恢复'
    }
  }
  results.push({
    id: 'config', label: '网关配置', ok: configOk,
    warn: !configOk && fs.existsSync(configPath), detail: configDetail
  })

  // 5. 本机磁盘空间
  {
    const diskDrive = installDir.charAt(0).toUpperCase()
    const diskFreeMB = getDiskFreeMB(diskDrive)
    const enough = diskFreeMB > 500
    results.push({
      id: 'disk', label: '本机磁盘空间', ok: enough || isNaN(diskFreeMB),
      warn: !enough && !isNaN(diskFreeMB),
      detail: isNaN(diskFreeMB) ? '无法检测（跳过）' : `剩余 ${diskFreeMB} MB${enough ? '' : '（建议至少 500 MB）'}`
    })
  }

  return results
})

// ─── IPC: UI Window ────────────────────────────────────────────────────────

ipcMain.handle('open-ui-window', async () => {
  await openUrl(buildUiUrl())
  return { ok: true }
})

// ─── IPC: Skills 商城（内嵌浏览器窗口）─────────────────────────────────────

let skillStoreWindow = null

ipcMain.handle('open-skill-store', () => {
  if (skillStoreWindow && !skillStoreWindow.isDestroyed()) {
    skillStoreWindow.focus()
    return { ok: true }
  }

  const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize
  skillStoreWindow = new BrowserWindow({
    width: Math.min(1100, screenW - 100),
    height: Math.min(750, screenH - 100),
    minWidth: 800,
    minHeight: 500,
    title: 'Skills 商城',
    backgroundColor: '#0f0f23',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  skillStoreWindow.loadURL('https://skillhub.tencent.com/')
  // 所有新窗口请求都在当前窗口内打开；仅允许 http(s)，挡住 javascript:/file: 等危险协议
  skillStoreWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const u = new URL(url)
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        skillStoreWindow.loadURL(url)
      }
    } catch {}
    return { action: 'deny' }
  })
  skillStoreWindow.on('closed', () => { skillStoreWindow = null })
  return { ok: true }
})

// ─── IPC: 教学与售后（内嵌浏览器窗口）─────────────────────────────────────

let helpCenterWindow = null

ipcMain.handle('open-help-center', () => {
  if (helpCenterWindow && !helpCenterWindow.isDestroyed()) {
    helpCenterWindow.focus()
    return { ok: true }
  }

  const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize
  helpCenterWindow = new BrowserWindow({
    width: Math.min(1100, screenW - 100),
    height: Math.min(750, screenH - 100),
    minWidth: 800,
    minHeight: 500,
    title: '教学与售后',
    backgroundColor: '#0f0f23',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  helpCenterWindow.loadURL('https://my.feishu.cn/wiki/ICDbwlmobirpgqkbHY3c8q00nbf?from=from_copylink')
  // 所有新窗口请求都在当前窗口内打开；仅允许 http(s)
  helpCenterWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const u = new URL(url)
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        helpCenterWindow.loadURL(url)
      }
    } catch {}
    return { action: 'deny' }
  })
  helpCenterWindow.on('closed', () => { helpCenterWindow = null })
  return { ok: true }
})
