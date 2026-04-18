/**
 * 授权验证模块
 * ECDSA 签名验证 + U 盘序列号读取 + license.key 备份保护
 */
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { app, dialog } = require('electron')
const { usbRoot, installDir } = require('./paths')

// 内嵌公钥 — 私钥由开发者保管，此处仅用于验证签名
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEdzen0/wxPzE508F5WU7S5RK2MIHH
gbCQcDmOwvKZEbkO9BGuTnDb9C/m3BzEZuhh3eF7ltJZ6OIjzKch0xV3HA==
-----END PUBLIC KEY-----`

// 备份路径：藏在本机安装目录
const LICENSE_BACKUP = () => path.join(installDir, '.license.bak')

// 标准化序列号：去掉横杠和空格，统一大写（确保签名端和验证端格式一致）
function normalizeSerial(raw) {
  return raw.replace(/[-\s]/g, '').toUpperCase()
}

function getVolSerial(driveLetter) {
  return new Promise(resolve => {
    const { execFile } = require('child_process')
    const sys32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'system32')
    const cmdExe = process.env.ComSpec || path.join(sys32, 'cmd.exe')
    const psExe = path.join(sys32, 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const opts = { encoding: 'utf8', timeout: 5000, windowsHide: true }

    // 方法 1：vol 是 cmd 内置命令，必须走 cmd.exe /c；driveLetter 经 normalize 只剩单字母
    execFile(cmdExe, ['/c', 'vol', `${driveLetter}:`], opts, (err, out) => {
      if (!err && out) {
        const m = out.match(/[0-9A-F]{4}[\s-][0-9A-F]{4}/i)
        if (m) return resolve(normalizeSerial(m[0]))
      }
      // 方法 2：PowerShell WMI（返回无横杠格式，回退用）
      const psScript = `(Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${driveLetter}:'").VolumeSerialNumber`
      execFile(psExe, ['-NoProfile', '-Command', psScript], opts, (err2, stdout) => {
        if (!err2 && stdout.trim()) return resolve(normalizeSerial(stdout.trim()))
        resolve(null)
      })
    })
  })
}

async function verifyLicense() {
  if (!app.isPackaged) return true  // 开发模式跳过验证

  const drive = path.resolve(usbRoot).charAt(0).toUpperCase()
  const serial = await getVolSerial(drive)

  if (!serial) {
    dialog.showErrorBox('授权验证失败', '无法读取 U 盘序列号，请确认程序从 U 盘运行。')
    app.quit()
    return false
  }

  const licFile = path.join(usbRoot, 'license.key')
  const backupFile = LICENSE_BACKUP()

  // license.key 丢失时尝试从备份恢复
  if (!fs.existsSync(licFile) && fs.existsSync(backupFile)) {
    try {
      fs.copyFileSync(backupFile, licFile)
    } catch {}
  }

  if (!fs.existsSync(licFile)) {
    dialog.showErrorBox(
      '未找到授权文件',
      '未找到 license.key，请联系作者获取授权文件后放入 U 盘根目录。'
    )
    app.quit()
    return false
  }

  try {
    const signature = fs.readFileSync(licFile, 'utf8').trim()
    const verify = crypto.createVerify('SHA256')
    verify.update(serial)
    const ok = verify.verify(PUBLIC_KEY, signature, 'hex')
    if (!ok) throw new Error('签名不匹配')

    // 验证通过后，自动备份 license.key（每次启动都刷新备份）
    try {
      fs.mkdirSync(path.dirname(backupFile), { recursive: true })
      fs.copyFileSync(licFile, backupFile)
    } catch {}

    return true
  } catch {
    dialog.showErrorBox(
      '授权验证失败',
      `授权文件无效或与当前 U 盘不匹配。\n请联系作者重新授权。\n（序列号：${serial}）`
    )
    app.quit()
    return false
  }
}

module.exports = { PUBLIC_KEY, getVolSerial, verifyLicense }
