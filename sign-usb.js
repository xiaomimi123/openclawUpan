// sign-usb.js — 开发者授权工具，不打包进 exe
// 用法: node sign-usb.js <U盘序列号>
// 示例: node sign-usb.js ACD87D0B
//
// 查询U盘序列号的命令（将 F: 替换为实际盘符）:
//   wmic logicaldisk where "DeviceID='F:'" get VolumeSerialNumber

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

let serial = (process.argv[2] || '').trim().toUpperCase()
// 去掉横杠和空格（vol 命令返回 XXXX-XXXX 格式，WMI 返回 XXXXXXXX 格式）
serial = serial.replace(/[-\s]/g, '')
// U盘序列号是十六进制（0-9, A-F），自动将常见误输的字母纠正为数字
const corrected = serial.replace(/O/g, '0').replace(/I/g, '1').replace(/L/g, '1')
if (corrected !== serial) {
  console.log(`⚠ 自动纠正: ${serial} → ${corrected}（序列号为十六进制，不含字母 O/I/L）`)
  serial = corrected
}
if (!serial) {
  console.error('❌ 请提供U盘序列号')
  console.error('   用法: node sign-usb.js <序列号>')
  console.error('   示例: node sign-usb.js ACD87D0B')
  console.error('')
  console.error('   查询序列号（F盘）:')
  console.error('   wmic logicaldisk where "DeviceID=\'F:\'" get VolumeSerialNumber')
  process.exit(1)
}

const privateKeyPath = path.join(__dirname, 'private.pem')
if (!fs.existsSync(privateKeyPath)) {
  console.error('❌ 找不到 private.pem，请确认私钥文件在同目录下')
  process.exit(1)
}

try {
  const privateKey = fs.readFileSync(privateKeyPath, 'utf8')
  const sign = crypto.createSign('SHA256')
  sign.update(serial)
  const signature = sign.sign(privateKey, 'hex')

  const outPath = path.join(__dirname, 'license.key')
  fs.writeFileSync(outPath, signature, 'utf8')

  console.log(`✅ 授权文件已生成: license.key`)
  console.log(`   绑定序列号: ${serial}`)
  console.log(``)
  console.log(`   将 license.key 发送给用户，放入U盘根目录即可。`)
} catch (e) {
  console.error('❌ 签名失败:', e.message)
  process.exit(1)
}
