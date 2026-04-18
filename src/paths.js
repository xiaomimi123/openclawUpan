/**
 * 路径常量和路径工具函数
 * USB 钥匙版：openclaw 安装在本机，USB 只做授权和首次部署
 */
const path = require('path')
const fs = require('fs')
const os = require('os')
const crypto = require('crypto')
const { app } = require('electron')

// USB root: where the launcher .exe lives (on USB)
const usbRoot = app.isPackaged
  ? (process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath))
  : path.join(__dirname, '..', 'dev-data')

// 本机安装目录
const installDir  = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'OpenClaw')
const openclawDir = path.join(installDir, 'openclaw')
const nodeDir     = path.join(installDir, 'node')
const setupFile   = path.join(installDir, 'setup.json')
const versionFile = path.join(installDir, 'version.txt')

// openclaw 原生配置目录（不做任何重定向！）
const configDir = path.join(os.homedir(), '.openclaw')

function getNodePath() {
  // 1. 本地安装目录
  const local = path.join(nodeDir, 'node.exe')
  if (fs.existsSync(local)) return local
  // 2. 系统 Node.js（Program Files）
  const systemNode = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe')
  if (fs.existsSync(systemNode)) return systemNode
  // 3. fallback：依赖 PATH
  return 'node'
}

/**
 * 从目录的 package.json 的 bin 字段动态发现 openclaw 入口文件。
 */
function resolveEntryFromDir(dir) {
  try {
    const pkgPath = path.join(dir, 'package.json')
    if (!fs.existsSync(pkgPath)) return null
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
    const candidates = [
      pkg.bin?.openclaw,
      pkg.exports?.['./cli-entry'],
      'openclaw.mjs',
    ].filter(Boolean)
    for (const rel of candidates) {
      const full = path.join(dir, rel)
      if (fs.existsSync(full)) return full
    }
  } catch {}
  return null
}

function getOpenclawMjs() {
  // 本机安装目录
  const local = resolveEntryFromDir(openclawDir)
  if (local) return local
  // Dev fallback: global npm install
  const globalDir = path.join(
    process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'npm', 'node_modules', 'openclaw'
  )
  return resolveEntryFromDir(globalDir)
}

/** 检查本机是否已安装 openclaw */
function isInstalled() {
  return getOpenclawMjs() !== null
}

/** 读取 zip 文件的版本标识（size:hash） */
function getZipVersion(zipPath) {
  try {
    const stat = fs.statSync(zipPath)
    const fd = fs.openSync(zipPath, 'r')
    const buf = Buffer.alloc(Math.min(65536, stat.size))
    try {
      fs.readSync(fd, buf, 0, buf.length, 0)
    } finally {
      fs.closeSync(fd)
    }
    const hash = crypto.createHash('md5').update(buf).digest('hex').slice(0, 16)
    return `${stat.size}:${hash}`
  } catch { return null }
}

/** 读取本机已安装的版本标识 */
function getLocalVersion() {
  try { return fs.readFileSync(versionFile, 'utf8').trim() } catch { return null }
}

/** 确保必要目录存在 */
async function ensureDirs() {
  for (const d of [
    installDir,
    openclawDir,
    nodeDir,
  ]) await fs.promises.mkdir(d, { recursive: true })
}

module.exports = {
  usbRoot, installDir, openclawDir, nodeDir, configDir, setupFile, versionFile,
  getNodePath, getOpenclawMjs, isInstalled, getZipVersion, getLocalVersion,
  resolveEntryFromDir, ensureDirs
}
