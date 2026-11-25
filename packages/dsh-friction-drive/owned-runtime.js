/**
 * 本插件自己的工具在运行时怎么执行。
 * 原工具只被调用，定义不会被改写。
 */
export function shellQuote(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return `'${String(text).replace(/'/g, `'\\''`)}'`
}

const MUSTACHE = String.raw`\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}`
const DOLLAR = String.raw`\$\{([A-Za-z_][A-Za-z0-9_]*)\}`

/**
 * schema 里没有标成必填的字段。作者字段表看 required !== true，JSON Schema 看 required 数组。
 * 命令里引用了这些字段、调用时又没传，就换成空字符串，而不是报缺少参数。
 */
export function optionalSlots(schema) {
  if (!schema || typeof schema !== 'object') return new Set()
  if (schema.properties && typeof schema.properties === 'object') {
    const required = new Set(Array.isArray(schema.required) ? schema.required : [])
    return new Set(Object.keys(schema.properties).filter((key) => !required.has(key)))
  }
  const optional = new Set()
  for (const [key, field] of Object.entries(schema)) {
    if (!field || typeof field !== 'object' || Array.isArray(field)) continue
    if (field.required !== true) optional.add(key)
  }
  return optional
}

/**
 * 把 {{参数}} 或 ${参数} 换成 shell 单引号包住的值。
 * 必填或缺席且不在 optional 里的槽位会让整条命令失败。
 * 可选槽位没传时换成空字符串。占位符两侧如果只有一层成对引号，先吃掉再放入。
 */
export function fillTemplate(command, args, options = {}) {
  const missing = []
  const optional = options.optional ?? new Set()
  const quoted = (key) => {
    const value = args?.[key]
    if (!Object.prototype.hasOwnProperty.call(args ?? {}, key) || value === undefined) {
      if (optional.has(key)) return shellQuote('')
      missing.push(key)
      return ''
    }
    return shellQuote(value)
  }
  const fromGroups = (_all, mustache, dollar) => quoted(mustache || dollar)
  let filled = String(command).replace(
    new RegExp(`(['"])(?:${MUSTACHE}|${DOLLAR})\\1`, 'g'),
    (_all, _quote, mustache, dollar) => quoted(mustache || dollar),
  )
  filled = filled.replace(new RegExp(`${MUSTACHE}|${DOLLAR}`, 'g'), fromGroups)
  if (missing.length > 0) return { ok: false, missing: [...new Set(missing)] }
  return { ok: true, command: filled }
}

/** 把内部调用的正文交回模型，并写明哪些字段被强制覆盖。 */
export function presentDelegated(result, overrides) {
  const text = (result?.content ?? []).map((block) => block?.text ?? '').filter(Boolean).join('\n')
  const exitCode = result?.value?.exitCode
  let body = text
  if (typeof exitCode === 'number' && !/\[exit code:/.test(body)) {
    body = body ? `${body}\n[exit code: ${exitCode}]` : `[exit code: ${exitCode}]`
  }
  if (result?.isError && result.error?.message && !body.includes(result.error.message)) {
    body = body ? `${body}\n${result.error.message}` : result.error.message
  }
  const changed = Object.keys(overrides ?? {})
  if (changed.length > 0) {
    const shown = changed.slice(0, 4).map((key) => `${key}=${JSON.stringify(overrides[key]).slice(0, 80)}`).join(' ')
    body = body ? `${body}\n已覆盖 ${shown}` : `已覆盖 ${shown}`
  }
  const invalid = `${result?.error?.message ?? ''}\n${body}`.includes('invalid arguments')
  const failed = !invalid && (result?.isError === true || (typeof exitCode === 'number' && exitCode !== 0))
  return {
    text: body || '无输出',
    ...(typeof exitCode === 'number' ? { exitCode } : {}),
    failed,
    truncated: result?.value?.truncated === true,
    partial: result?.value?.partial === true,
  }
}
