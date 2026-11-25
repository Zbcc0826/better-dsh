/** read 工具用 <path> 包住目标文件。这些文件本身可以提到源码路径。 */
const METADATA = /\/(?:package\.json|README(?:\.[A-Za-z0-9]+)*|cordis\.patch\.yml)$/

/** 去掉结尾标点后再看是不是包说明、README 或补丁。 */
function metadataPath(value) {
  return METADATA.test(String(value ?? '').replace(/[),.;]+$/, ''))
}

/**
 * 示例结果里出现源码或内部时间表时拦截。
 * 路径在 < 处截断，避免 package.json</path> 被看成源码。
 * read 的目标若是包说明、README 或补丁，正文里的相对路径不算泄漏。
 */
export function leaksDemoSource(text) {
  const body = String(text ?? '')
  if (body.includes('const LEDGER') || body.includes('2026-11-18T09:00:00') || body.includes('plugins/friction-lab')) return true
  const envelope = body.match(/<path>([^<]*)<\/path>/)
  if (envelope && metadataPath(envelope[1])) return false
  const paths = body.match(/\/dsh-friction-(?:demo|drive)\/[^\s"'`<]*/g) ?? []
  return paths.some((item) => !metadataPath(item))
}
