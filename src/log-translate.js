/**
 * 日志翻译层：将技术错误转为用户友好的中文提示
 * 匹配技术错误 → 追加用户友好提示（不替换原文，只在下一行补充说明）
 */

const LOG_TRANSLATIONS = [
  // 配置问题（覆盖 openclaw 各版本的不同报错格式）
  // 隐藏规则放前面，优先匹配（避免被后面的 append 规则抢走）
  { test: /Unrecognized key/i, hide: true },  // schema 详情，对用户无用
  { test: /Unknown config key/i, hide: true },  // Unknown config keys 标题
  { test: /^-\s+<root>|^-\s+[a-z]+\.[a-z]+/i, hide: true },  // schema 详情行
  { test: /^Run:?\s+.*openclaw.*doctor/i, hide: true },  // 修复建议，我们自动处理了
  { test: /^Run "openclaw/i, hide: true },  // 另一种格式的修复建议
  { test: /^File: /i,         hide: true },  // 配置文件路径
  { test: /^Problem:/i,       hide: true },  // "Problem:" 标题行
  { test: /^Code=/i,          hide: true },  // 错误码行
  { test: /^[|o+\-\s]+$/, hide: true },  // 方框图绘制行（|, o, +---+ 等）
  { test: /^\s*Doctor\b/i, hide: true },  // Doctor 标题行
  // 提示规则
  { test: /Config invalid|Invalid config|INVALID_CONFIG/i, append: '↑ 检测到配置问题，正在自动修复...' },
  { test: /Missing config\. Run.*setup/i, append: '↑ 配置文件缺失，正在自动恢复...' },
  { test: /Gateway start blocked/i, append: '↑ 网关配置异常，正在自动修复...' },
  // 网络问题
  { test: /ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENOTFOUND/i, append: '↑ 网络连接失败，请检查网络' },
  { test: /fetch failed/i, append: '↑ 网络请求失败，请检查网络连接' },
  // 端口问题
  { test: /EADDRINUSE|address already in use/i, append: '↑ 端口被占用，正在自动释放...' },
  // 模块缺失
  { test: /ERR_MODULE_NOT_FOUND|Cannot find (package|module)/i, append: '↑ 程序文件不完整，请删除临时缓存后重启' },
  // 权限问题
  { test: /EPERM|EACCES|permission denied/i, append: '↑ 文件访问被拒绝，请检查杀毒软件或以管理员身份运行' },
  // 磁盘问题
  { test: /ENOSPC|no space/i, append: '↑ 磁盘空间不足，请清理磁盘后重试' },
]

// 返回: { hide: true } 隐藏该行 | { append: '...' } 原文后追加提示 | null 原样显示
function translateLog(raw) {
  const trimmed = raw.trim()
  if (!trimmed) return null
  for (const rule of LOG_TRANSLATIONS) {
    if (rule.test.test(trimmed)) {
      if (rule.hide) return { hide: true }
      return { append: rule.append }
    }
  }
  return null
}

module.exports = { LOG_TRANSLATIONS, translateLog }
