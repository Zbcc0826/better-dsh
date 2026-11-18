/** 示例结果里出现源码或内部时间表时拦截。插件本体不认识这些字符串。 */
export function leaksDemoSource(text) {
  const body = String(text ?? '')
  return body.includes('/dsh-friction-demo/')
    || body.includes('/dsh-friction-drive/')
    || body.includes('plugins/friction-lab')
    || body.includes('const LEDGER')
    || body.includes('2026-11-18T09:00:00')
}
