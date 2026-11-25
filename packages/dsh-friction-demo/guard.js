/** 示例结果里出现源码或内部时间表时拦截。包说明、README 和补丁路径不算源码。 */
export function leaksDemoSource(text) {
  const body = String(text ?? '')
  if (body.includes('const LEDGER') || body.includes('2026-11-18T09:00:00') || body.includes('plugins/friction-lab')) return true
  const paths = body.match(/\/dsh-friction-(?:demo|drive)\/[^\s"'`]*/g) ?? []
  const metadata = /\/(?:package\.json|README(?:\.[A-Za-z0-9]+)?|cordis\.patch\.yml)$/
  return paths.some((item) => !metadata.test(item.replace(/[),.;]+$/, '')))
}
