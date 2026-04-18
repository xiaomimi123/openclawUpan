/**
 * USB 同步模块 — 方案 B：启动时 U盘→本机，关闭时 本机→U盘
 *
 * 同步内容：
 *   1. workspace/  — MEMORY.md、memory/*.md、skills/、IDENTITY.md 等
 *   2. memory/     — main.sqlite（向量索引数据库）
 *
 * 策略：
 *   - 用时间戳文件 (.sync-meta.json) 判断哪边更新
 *   - 拷贝失败不阻塞启动（最差情况用本机旧数据）
 *   - 关闭时 U 盘已拔出也不会丢数据（本机留有完整副本）
 */
const fs = require('fs')
const path = require('path')

const SYNC_META = '.sync-meta.json'

// ─── 工具函数 ────────────────────────────────────────────────────────────

/** 递归拷贝目录（覆盖已有文件，不删除目标多余文件——保守策略，防止误删用户数据） */
async function copyDir(src, dest) {
  await fs.promises.mkdir(dest, { recursive: true })
  const entries = await fs.promises.readdir(src, { withFileTypes: true })
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath)
    } else {
      await fs.promises.copyFile(srcPath, destPath)
    }
  }
}

/** 读同步元数据 */
function readSyncMeta(dir) {
  try {
    const metaPath = path.join(dir, SYNC_META)
    if (!fs.existsSync(metaPath)) return null
    return JSON.parse(fs.readFileSync(metaPath, 'utf8'))
  } catch { return null }
}

/** 写同步元数据 */
async function writeSyncMeta(dir) {
  const meta = { lastSync: Date.now(), syncAt: new Date().toISOString() }
  await fs.promises.mkdir(dir, { recursive: true })
  await fs.promises.writeFile(path.join(dir, SYNC_META), JSON.stringify(meta, null, 2), 'utf8')
  return meta
}

/** 判断目录是否有实际内容（排除 .sync-meta.json） */
function hasSyncContent(dir) {
  if (!fs.existsSync(dir)) return false
  try {
    const entries = fs.readdirSync(dir)
    return entries.some(e => e !== SYNC_META)
  } catch { return false }
}

// ─── 核心同步 ────────────────────────────────────────────────────────────

/**
 * 同步一个目录：根据时间戳决定方向
 * @returns {{ direction: 'usb→local'|'local→usb'|'skip', error?: string }}
 */
async function syncDir(usbDir, localDir, label) {
  const usbMeta = readSyncMeta(usbDir)
  const localMeta = readSyncMeta(localDir)
  const usbHas = hasSyncContent(usbDir)
  const localHas = hasSyncContent(localDir)

  // 都没有内容 → 跳过
  if (!usbHas && !localHas) {
    return { direction: 'skip' }
  }

  // 只有 U 盘有 → U 盘→本机
  if (usbHas && !localHas) {
    try {
      await copyDir(usbDir, localDir)
      await writeSyncMeta(localDir)
      return { direction: 'usb→local' }
    } catch (e) {
      return { direction: 'usb→local', error: e.message }
    }
  }

  // 只有本机有 → 本机→U 盘
  if (!usbHas && localHas) {
    try {
      await copyDir(localDir, usbDir)
      await writeSyncMeta(usbDir)
      return { direction: 'local→usb' }
    } catch (e) {
      return { direction: 'local→usb', error: e.message }
    }
  }

  // 都有 → 比较时间戳，新的覆盖旧的
  const usbTime = usbMeta?.lastSync || 0
  const localTime = localMeta?.lastSync || 0

  if (usbTime > localTime) {
    // U 盘更新 → U 盘→本机（用户在另一台电脑更新过）
    try {
      await copyDir(usbDir, localDir)
      await writeSyncMeta(localDir)
      return { direction: 'usb→local' }
    } catch (e) {
      return { direction: 'usb→local', error: e.message }
    }
  } else {
    // 本机更新或相同 → 跳过（关闭时再写回）
    return { direction: 'skip' }
  }
}

/**
 * 启动时同步：U 盘 → 本机（如果 U 盘数据更新）
 * @param {string} usbRoot - U 盘根目录
 * @param {object} locals - 本机目录 { workspace, memory, managedSkills }
 * @param {function} log - 日志回调
 */
async function syncFromUsb(usbRoot, locals, log) {
  const usbData = path.join(usbRoot, '.openclaw-data')

  const syncPairs = [
    { name: 'workspace',      usb: path.join(usbData, 'workspace'),      local: locals.workspace },
    { name: 'memory',         usb: path.join(usbData, 'memory'),         local: locals.memory },
    { name: 'managed-skills', usb: path.join(usbData, 'managed-skills'), local: locals.managedSkills },
  ]

  const results = []
  for (const { name, usb, local } of syncPairs) {
    const r = await syncDir(usb, local, name)
    results.push({ name, ...r })
    if (r.direction !== 'skip') {
      log(`[同步] ${name}: ${r.direction}${r.error ? ' (失败: ' + r.error + ')' : ' ✅'}`)
    }
  }
  return results
}

/**
 * 关闭时同步：本机 → U 盘
 * @param {string} usbRoot - U 盘根目录
 * @param {object} locals - 本机目录 { workspace, memory, managedSkills }
 * @param {function} log - 日志回调
 */
async function syncToUsb(usbRoot, locals, log) {
  const usbData = path.join(usbRoot, '.openclaw-data')

  // 检查 U 盘是否还在
  if (!fs.existsSync(usbRoot)) {
    log('[同步] U 盘已拔出，跳过写回（数据安全保存在本机）')
    return []
  }

  const syncPairs = [
    { name: 'workspace',      usb: path.join(usbData, 'workspace'),      local: locals.workspace },
    { name: 'memory',         usb: path.join(usbData, 'memory'),         local: locals.memory },
    { name: 'managed-skills', usb: path.join(usbData, 'managed-skills'), local: locals.managedSkills },
  ]

  const results = []
  for (const { name, usb, local } of syncPairs) {
    if (!hasSyncContent(local)) continue
    try {
      await copyDir(local, usb)
      await writeSyncMeta(usb)
      await writeSyncMeta(local)
      results.push({ name, direction: 'local→usb' })
      log(`[同步] ${name} 已写回 U 盘 ✅`)
    } catch (e) {
      results.push({ name, direction: 'local→usb', error: e.message })
      log(`[同步] ${name} 写回失败: ` + e.message)
    }
  }

  return results
}

module.exports = { syncFromUsb, syncToUsb }
