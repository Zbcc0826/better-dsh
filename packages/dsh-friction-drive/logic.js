/**
 * 摩擦记账的纯逻辑。不读文件、不弹审批。
 * 预计调用次数由插件按登记时的公式计算，不采用工具临时返回的数字。
 */

export const PATCH_KEYS = ['pageSize', 'warmupError', 'format', 'engine', 'minIntervalMs', 'delayMs']

export function freshState(threshold = 8) {
  return { threshold, tools: {}, proposals: {} }
}

export function freshTool() {
  return {
    calls: 0,
    failures: 0,
    retries: 0,
    partials: 0,
    score: 0,
    gated: false,
    lastArgs: '',
    lastOk: null,
    lastOutputChars: 0,
    workloadItems: null,
  }
}

/**
 * 给一次调用算分。成功且未截断、未慢超时的同参重复不加分。
 * retry 只加在上一次失败、而且这一次仍失败的同参调用上。
 * 正文退出码把 lastOk 打成失败之后，下一次成功的同参调用不加 retry。
 * verbose 只在失败或这种重试时叠加。
 * @param {object} tool 该工具已有计数
 * @param {object} event 本次调用事实
 */
export function scoreCall(tool, event, options = {}) {
  const slowMs = options.slowMs ?? 2000
  const verboseChars = options.verboseChars ?? 500
  const reasons = []
  const args = event.args ?? ''
  const sameArgs = tool.lastArgs !== '' && tool.lastArgs === args
  const retry = sameArgs && tool.lastOk === false && event.ok === false
  if (event.ok === false) reasons.push('failure')
  if (retry) reasons.push('retry')
  if ((event.elapsedMs ?? 0) > slowMs) reasons.push('slow')
  if (event.truncated) reasons.push('partial')
  if ((event.outputChars ?? 0) > verboseChars && (event.ok === false || retry)) reasons.push('verbose')
  const weights = { failure: 3, retry: 2, slow: 1, partial: 2, verbose: 1 }
  const points = reasons.reduce((sum, reason) => sum + weights[reason], 0)
  return { points, reasons, retry }
}

/** 记下一次调用。过线的这一次仍返回原结果，从下一次开始拦截。 */
export function noteCall(state, event, options = {}) {
  const tool = state.tools[event.tool] ?? freshTool()
  if (tool.gated) {
    state.tools[event.tool] = tool
    return { state, blocked: true, gate: false, points: 0, tool }
  }
  const scored = scoreCall(tool, event, options)
  tool.calls += 1
  if (event.ok === false) tool.failures += 1
  if (scored.retry) tool.retries += 1
  if (event.truncated) tool.partials += 1
  tool.score += scored.points
  tool.lastArgs = event.args ?? ''
  tool.lastOk = event.ok === false ? false : true
  tool.lastOutputChars = event.outputChars ?? 0
  if (Number.isInteger(event.workloadItems) && event.workloadItems >= 1) tool.workloadItems = event.workloadItems
  const crossed = tool.score >= state.threshold && scored.points > 0
  if (crossed) tool.gated = true
  state.tools[event.tool] = tool
  return { state, blocked: false, gate: crossed, points: scored.points, reasons: scored.reasons, tool }
}

/** 工作量不能超过登记时的条目上限，也不能用 0 或小数把公式压低。 */
export function itemsOf(entry, workloadItems) {
  const cap = entry?.itemCount
  if (!Number.isInteger(cap) || cap < 1) return null
  if (!Number.isInteger(workloadItems) || workloadItems < 1 || workloadItems > cap) return cap
  return workloadItems
}

/**
 * 按登记公式计算预计调用次数。flat 引擎恒为声明的次数。
 * @param {object} spec 当前工具定义
 * @param {object} entry 登记信息，含 formula、itemCount、flatEngines
 */
export function projectedCalls(spec, entry, workloadItems) {
  const items = itemsOf(entry, workloadItems)
  if (items === null) return { ok: false, code: 'NO_MEASURE' }
  if (entry.flatEngines?.includes(spec?.engine)) {
    const calls = entry.flatCalls ?? 1
    if (!Number.isInteger(calls) || calls < 1) return { ok: false, code: 'NO_MEASURE' }
    return { ok: true, calls, items, warmup: false, pages: calls, flat: true }
  }
  if (entry.formula === 'paged') {
    const size = Number(spec?.pageSize)
    if (!Number.isInteger(size) || size < 1) return { ok: false, code: 'NO_MEASURE' }
    const pages = Math.ceil(items / size)
    const warmup = spec?.warmupError === true
    return { ok: true, calls: pages + (warmup ? 1 : 0), items, warmup, pages, flat: false }
  }
  const repeat = entry.repeat ?? 1
  if (!Number.isInteger(repeat) || repeat < 1) return { ok: false, code: 'NO_MEASURE' }
  return { ok: true, calls: items * repeat, items, warmup: false, pages: items * repeat, flat: false }
}

export function canonicalPatch(patch, allowedKeys = PATCH_KEYS) {
  const sorted = {}
  for (const key of PATCH_KEYS) {
    if (!allowedKeys.includes(key)) continue
    if (patch && Object.prototype.hasOwnProperty.call(patch, key)) sorted[key] = patch[key]
  }
  return sorted
}

/** 非法字段或非法取值都拒绝。pageSize 至少为 1。 */
export function invalidPatch(patch, entry) {
  const keys = Object.keys(patch ?? {})
  if (keys.length === 0) return 'empty'
  const allowed = entry?.patchKeys ?? []
  for (const key of keys) {
    if (!PATCH_KEYS.includes(key) || !allowed.includes(key)) return key
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'pageSize')) {
    if (!Number.isInteger(patch.pageSize) || patch.pageSize < 1) return 'pageSize'
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'warmupError') && typeof patch.warmupError !== 'boolean') return 'warmupError'
  if (Object.prototype.hasOwnProperty.call(patch, 'format') && !['compact', 'verbose'].includes(patch.format)) return 'format'
  if (Object.prototype.hasOwnProperty.call(patch, 'engine')) {
    if (typeof patch.engine !== 'string' || !entry?.engines?.includes(patch.engine)) return 'engine'
  }
  for (const key of ['minIntervalMs', 'delayMs']) {
    if (Object.prototype.hasOwnProperty.call(patch, key) && (!Number.isInteger(patch[key]) || patch[key] < 0)) return key
  }
  return null
}

/**
 * 只接受 projected_calls。目标次数以公式预览为准，不采用模型自己写的目标。
 */
export function propose(state, input, entry, spec) {
  const tool = state.tools[input.tool]
  if (!tool?.gated) return { ok: false, code: 'BELOW_THRESHOLD' }
  if (input.metric !== 'projected_calls') return { ok: false, code: 'METRIC_NOT_RETESTABLE' }
  const before = projectedCalls(spec, entry, tool.workloadItems)
  if (!before.ok) return { ok: false, code: before.code }
  const bad = invalidPatch(input.patch, entry)
  if (bad) return { ok: false, code: 'BAD_PATCH', key: bad }
  const next = { ...spec, ...canonicalPatch(input.patch, entry.patchKeys) }
  const after = projectedCalls(next, entry, tool.workloadItems)
  if (!after.ok) return { ok: false, code: after.code }
  if (!(after.calls < before.calls)) return { ok: false, code: 'NOT_LOWER', current: before.calls, after: after.calls }
  const proposal = {
    id: input.id,
    tool: input.tool,
    metric: 'projected_calls',
    current: before.calls,
    target: after.calls,
    patch: canonicalPatch(input.patch, entry.patchKeys),
    before,
    after,
  }
  state.proposals[input.tool] = proposal
  return { ok: true, proposal }
}

/** 审批结果只有 allowed-once 能应用，且补丁必须和提案完全一致。 */
export function admit(proposal, patch, outcome, allowedKeys) {
  if (!proposal) return { ok: false, code: 'NO_PROPOSAL' }
  if (outcome !== 'allowed-once') return { ok: false, code: 'NOT_APPROVED', outcome: outcome ?? 'unavailable' }
  const got = canonicalPatch(patch, allowedKeys)
  if (JSON.stringify(got) !== JSON.stringify(proposal.patch)) return { ok: false, code: 'PATCH_MISMATCH' }
  return { ok: true }
}

/** 写入后按同一公式再算一次，没有下降就撤回。 */
export function retest(beforeCalls, afterCalls) {
  if (!Number.isInteger(beforeCalls) || !Number.isInteger(afterCalls)) return { ok: false, code: 'NO_MEASURE' }
  if (afterCalls < 1) return { ok: false, code: 'NO_MEASURE' }
  if (!(afterCalls < beforeCalls)) return { ok: false, code: 'REVERT', before: beforeCalls, after: afterCalls }
  return { ok: true, before: beforeCalls, after: afterCalls }
}

export function clearGate(state, toolName) {
  const tool = state.tools[toolName]
  if (!tool) return state
  tool.gated = false
  tool.score = 0
  tool.calls = 0
  tool.failures = 0
  tool.retries = 0
  tool.partials = 0
  tool.lastArgs = ''
  delete state.proposals[toolName]
  return state
}

function describePatch(patch, lang) {
  const parts = []
  const zh = lang === 'zh'
  if (Object.prototype.hasOwnProperty.call(patch, 'pageSize')) parts.push(zh ? `每页条数改为 ${patch.pageSize}` : `page size to ${patch.pageSize}`)
  if (Object.prototype.hasOwnProperty.call(patch, 'warmupError')) {
    parts.push(patch.warmupError
      ? (zh ? '保留首次预热失败' : 'keep the warmup failure')
      : (zh ? '去掉首次预热失败' : 'remove the warmup failure'))
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'format')) {
    parts.push(patch.format === 'compact'
      ? (zh ? '结果改成紧凑列表' : 'compact results')
      : (zh ? '结果改成完整说明' : 'verbose results'))
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'engine')) parts.push(zh ? `换用 ${patch.engine} 引擎` : `engine ${patch.engine}`)
  if (Object.prototype.hasOwnProperty.call(patch, 'minIntervalMs')) parts.push(zh ? `最小间隔改为 ${patch.minIntervalMs} 毫秒` : `minimum interval ${patch.minIntervalMs} ms`)
  if (Object.prototype.hasOwnProperty.call(patch, 'delayMs')) parts.push(zh ? `额外等待改为 ${patch.delayMs} 毫秒` : `extra delay ${patch.delayMs} ms`)
  return parts.join(zh ? '，' : ', ')
}

function warmupClause(breakdown, lang) {
  if (!breakdown.warmup) return ''
  return lang === 'zh' ? '，其中 1 次是预热失败' : ', including 1 warmup failure'
}

/**
 * bash 把非零退出码印在正常结果里。这种结果也要计为失败。
 * @param {string} text 工具结果文本
 */
export function commandFailed(text) {
  return /\[exit code: (?!0)\d+\]/.test(String(text ?? ''))
}

/**
 * 审批卡只用插件统计和公式，不引用模型概述，避免两边数字不一致。
 * @param {object} proposal 已接受的提案
 * @param {object} stats 该工具的失败、重试、截断和分数
 */
export function approvalCopy(proposal, stats) {
  const change = describePatch(proposal.patch, 'zh')
  const changeEn = describePatch(proposal.patch, 'en')
  const still = proposal.after.warmup ? '改完后首次调用仍会失败。' : ''
  const stillEn = proposal.after.warmup ? ' The first call will still fail after the change.' : ''
  const zh = `这个会话里 ${proposal.tool} 失败 ${stats.failures} 次、同参数重试 ${stats.retries} 次、结果被截断 ${stats.partials} 次，摩擦分 ${stats.score}。按本会话最近一次要处理的 ${proposal.before.items} 条计算，现在预计调用 ${proposal.before.calls} 次${warmupClause(proposal.before, 'zh')}。请允许修改 ${proposal.tool}：${change}。改完后预计调用 ${proposal.after.calls} 次${warmupClause(proposal.after, 'zh')}。${still}这次同意只改当前会话；复查没有下降不会写入。`
  const en = `In this session ${proposal.tool} failed ${stats.failures} times, retried the same arguments ${stats.retries} times, and returned truncated results ${stats.partials} times. Friction score: ${stats.score}. For the latest workload of ${proposal.before.items} items, this takes ${proposal.before.calls} calls${warmupClause(proposal.before, 'en')}. Allow changing ${proposal.tool}: ${changeEn}. Afterward it takes ${proposal.after.calls} calls${warmupClause(proposal.after, 'en')}.${stillEn} This approval changes only the current session. The change is not saved unless the projected calls decrease.`
  return { zh, en }
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 任意工具的改进名。原工具过线后，模型改调这个名字。 */
export function fixName(tool) {
  return `fix_${String(tool).replace(/[^A-Za-z0-9_]/g, '_')}`
}

/** 未登记工具只能补默认参数或强制覆盖参数，不能改工具源码。 */
export function invalidAdaptation(patch) {
  if (!plainObject(patch)) return 'patch'
  const keys = Object.keys(patch)
  if (keys.length === 0) return 'empty'
  for (const key of keys) {
    if (key !== 'defaults' && key !== 'overrides') return key
  }
  for (const key of ['defaults', 'overrides']) {
    if (patch[key] === undefined) continue
    if (!plainObject(patch[key]) || Object.keys(patch[key]).length === 0) return key
  }
  if (patch.defaults === undefined && patch.overrides === undefined) return 'empty'
  return null
}

export function canonicalAdaptation(patch) {
  const out = {}
  if (plainObject(patch?.defaults)) out.defaults = patch.defaults
  if (plainObject(patch?.overrides)) out.overrides = patch.overrides
  return out
}

/** 正在使用的工具过线后，提案只保存参数改法。目标次数无法事先测算。 */
export function proposeAdaptation(state, input) {
  const tool = state.tools[input.tool]
  if (!tool?.gated) return { ok: false, code: 'BELOW_THRESHOLD' }
  const bad = invalidAdaptation(input.patch)
  if (bad) return { ok: false, code: 'BAD_PATCH', key: bad, patchKeys: ['defaults', 'overrides'] }
  const proposal = {
    id: input.id,
    tool: input.tool,
    kind: 'adaptation',
    metric: 'failures',
    current: tool.failures,
    patch: canonicalAdaptation(input.patch),
    fixTool: fixName(input.tool),
  }
  state.proposals[input.tool] = proposal
  return { ok: true, proposal }
}

export function admitAdaptation(proposal, patch, outcome) {
  if (!proposal) return { ok: false, code: 'NO_PROPOSAL' }
  if (outcome !== 'allowed-once') return { ok: false, code: 'NOT_APPROVED', outcome: outcome ?? 'unavailable' }
  if (JSON.stringify(canonicalAdaptation(patch)) !== JSON.stringify(proposal.patch)) return { ok: false, code: 'PATCH_MISMATCH' }
  return { ok: true }
}

/** 把批准过的默认值和覆盖值套到本次参数上。覆盖值优先。 */
export function applyAdaptation(patch, args) {
  return { ...(patch.defaults ?? {}), ...(args ?? {}), ...(patch.overrides ?? {}) }
}

/**
 * 工具是否真的失败。
 * invalid arguments 仍不计成失败。数值退出码是 0 时，正文里的非零退出码也算失败。
 */
export function failureOf(result) {
  const message = result?.error?.message ?? ''
  if (message.includes('invalid arguments')) return { ok: true, invalid: true }
  if (result?.isError === true || result?.value?.failed === true) return { ok: false, invalid: false }
  const code = result?.value?.exitCode
  if (typeof code === 'number' && code !== 0) return { ok: false, invalid: false }
  const text = (result?.content ?? []).map((block) => block?.text ?? '').join('\n')
  if (commandFailed(text)) return { ok: false, invalid: false }
  return { ok: true, invalid: false }
}

/** 截断标记，或 grep 渲染结果的首行统计。正文后面的相同句子不算。 */
export function truncationOf(result) {
  const value = result?.value
  if (value?.truncated === true || value?.partial === true) return true
  const first = (result?.content ?? []).map((block) => block?.text ?? '').join('\n').split('\n', 1)[0]
  const found = /^Found (\d+) of (\d+) matches$/.exec(first)
  return Boolean(found && Number(found[1]) < Number(found[2]))
}

/** 本插件注册到进程里的工具名。总长 2 到 41，只能是小写、数字和下划线。 */
export const OWNED_NAME = /^[a-z][a-z0-9_]{1,40}$/

/** 全局工具名。调用方给了合法语义名就用它，否则才退回 fd_原工具_时间。 */
export function ownedName(tool, now = Date.now(), serial = 0) {
  const stem = String(tool).toLowerCase().replace(/[^a-z0-9_]+/g, '').slice(0, 12) || 'tool'
  const suffix = serial > 0 ? `_${serial}` : ''
  const stamp = String(now)
  const prefix = `fd_${stem}_`
  const room = 41 - prefix.length - suffix.length
  return `${prefix}${stamp.slice(-Math.max(room, 1))}${suffix}`
}

/** 把 plugin-check 收成 plugin_check。不合规则时返回空字符串。 */
export function semanticOwnedName(name) {
  const stem = String(name ?? '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 41)
  return OWNED_NAME.test(stem) ? stem : ''
}

/** 内部调用只有目标就是被代替的那个工具时，才跳过它的闸门。 */
export function gateSkipped(allowedTool, toolName) {
  return typeof allowedTool === 'string' && allowedTool.length > 0 && allowedTool === toolName
}

function canonicalRun(run) {
  if (!plainObject(run)) return null
  if (run.kind === 'script') return { kind: 'script', command: String(run.command ?? '') }
  if (run.kind !== 'delegate') return null
  const out = { kind: 'delegate', tool: String(run.tool ?? '') }
  if (plainObject(run.defaults) && Object.keys(run.defaults).length > 0) out.defaults = run.defaults
  if (plainObject(run.overrides) && Object.keys(run.overrides).length > 0) out.overrides = run.overrides
  return out
}

/** 比较新工具时忽略审批元数据，只看名称、说明、schema 和执行方式。 */
export function ownedCore(spec) {
  return {
    name: spec?.name,
    problem: spec?.problem,
    usage: spec?.usage,
    schema: spec?.schema,
    run: canonicalRun(spec?.run),
  }
}

export function sameOwned(left, right) {
  return JSON.stringify(stable(ownedCore(left))) === JSON.stringify(stable(ownedCore(right)))
}

/** 审批时比较规范化后的补丁。说明文字和键顺序不同不算两份提案。 */
export function patchesMatch(stored, incoming) {
  return JSON.stringify(loosen(ownedCore(stored))) === JSON.stringify(loosen(ownedCore(incoming)))
}

function loosen(core) {
  const schema = {}
  for (const [key, node] of Object.entries(core.schema ?? {})) {
    if (!plainObject(node)) continue
    schema[key] = { type: node.type, ...(node.required === true ? { required: true } : {}) }
  }
  return stable({ ...core, schema })
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (!plainObject(value)) return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
}

function invalidOwnedText(value, label) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 200) return label
  return null
}

/**
 * 模型常把 schema 写成 JSON Schema，把 run 写成一整段命令。
 * 先收成 Harness 的字段写法，再校验。说明超过 200 字时截断，避免只因字数被整份拒绝。
 */
export function normalizeOwnedPatch(patch) {
  if (!plainObject(patch)) return patch
  const next = { ...patch }
  if (typeof next.problem === 'string') next.problem = next.problem.trim().slice(0, 200)
  if (typeof next.usage === 'string') next.usage = next.usage.trim().slice(0, 200)
  if (next.schema !== undefined) next.schema = authorSchema(next.schema)
  if (typeof next.run === 'string' && next.run.trim() !== '') next.run = { kind: 'script', command: next.run }
  return next
}

/** 把 JSON Schema 或字段数组收成 { 字段名: { type, required, description } }。 */
function authorSchema(schema) {
  if (Array.isArray(schema)) {
    const out = {}
    for (const field of schema) {
      if (!plainObject(field) || typeof field.name !== 'string' || field.name === '') continue
      out[field.name] = authorField(field.name, field, Boolean(field.required))
    }
    return out
  }
  if (!plainObject(schema)) return schema
  if (!plainObject(schema.properties)) {
    const out = {}
    for (const [key, node] of Object.entries(schema)) {
      if (!plainObject(node)) {
        out[key] = node
        continue
      }
      const copy = { ...node }
      if (copy.required !== true) delete copy.required
      out[key] = copy
    }
    return out
  }
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((item) => typeof item === 'string') : [])
  const out = {}
  for (const [key, node] of Object.entries(schema.properties)) {
    out[key] = authorField(key, plainObject(node) ? node : {}, required.has(key))
  }
  return out
}

function authorField(key, node, required) {
  const field = {
    type: typeof node.type === 'string' ? node.type : 'string',
    description: typeof node.description === 'string' && node.description.trim() !== '' ? node.description : key,
  }
  // Harness 只接受 required: true。可选字段不能写 required: false，否则整份 schema 被拒绝。
  if (required) field.required = true
  if (Array.isArray(node.enum)) field.enum = node.enum
  return field
}

/** 拒绝时告诉模型下一版该怎么写，避免只看到一个 key。 */
export function ownedPatchHint(key) {
  if (key === 'schema') return 'schema 写成 {"dir":{"type":"string","required":true,"description":"目录"}}。也可以写带 properties 和 required 的 JSON Schema。'
  if (key === 'usage' || key === 'problem') return `${key} 最多 200 字。`
  if (key === 'run') return 'run 写成 {"kind":"script","command":"命令"}，或 {"kind":"delegate","tool":"原工具","overrides":{}}。也可以直接给命令字符串。'
  if (key === 'command') return '脚本最长 4000 字。'
  return ''
}

/** 校验失败时给一份能通过的最小提案，避免模型继续猜格式。 */
export function ownedPatchExample() {
  return {
    usage: '检查一个插件目录',
    schema: { dir: { type: 'string', required: true, description: '目录' } },
    run: { kind: 'script', command: 'node --check ${dir}' },
  }
}

/** 覆盖值必须是原工具 schema 里已有的字段，并且类型相符。 */
export function invalidAgainstSchema(schema, values) {
  if (values === undefined) return null
  if (!plainObject(values)) return 'values'
  const properties = schema?.properties
  if (!properties || typeof properties !== 'object') return 'schema'
  for (const [key, value] of Object.entries(values)) {
    if (!Object.prototype.hasOwnProperty.call(properties, key)) return key
    if (invalidJson(properties[key], value)) return key
  }
  return null
}

function invalidJson(node, value) {
  if (!node || typeof node !== 'object') return 'schema'
  if (Array.isArray(node.oneOf)) return node.oneOf.some((branch) => !invalidJson(branch, value)) ? null : 'oneOf'
  if (Object.prototype.hasOwnProperty.call(node, 'const') && value !== node.const) return 'const'
  switch (node.type) {
    case 'string':
      return typeof value === 'string' && (!Array.isArray(node.enum) || node.enum.includes(value)) ? null : 'string'
    case 'number':
      return typeof value === 'number' && (!Array.isArray(node.enum) || node.enum.includes(value)) ? null : 'number'
    case 'integer':
      return Number.isInteger(value) && (!Array.isArray(node.enum) || node.enum.includes(value)) ? null : 'integer'
    case 'boolean':
      return typeof value === 'boolean' ? null : 'boolean'
    case 'null':
      return value === null ? null : 'null'
    case 'array':
      if (!Array.isArray(value)) return 'array'
      if (node.items) {
        for (const item of value) {
          if (invalidJson(node.items, item)) return 'array'
        }
      }
      return null
    case 'object':
      if (!plainObject(value)) return 'object'
      for (const key of Object.keys(value)) {
        if (!node.properties || !Object.prototype.hasOwnProperty.call(node.properties, key)) return key
        if (invalidJson(node.properties[key], value[key])) return key
      }
      return null
    default:
      return 'type'
  }
}

function invalidOwned(spec, schemaError, delegateSchema, delegateSchemaMissing) {
  if (!OWNED_NAME.test(spec?.name ?? '')) return 'name'
  const problem = invalidOwnedText(spec?.problem, 'problem')
  if (problem) return problem
  const usage = invalidOwnedText(spec?.usage, 'usage')
  if (usage) return usage
  if (schemaError) return 'schema'
  if (!plainObject(spec?.schema) || Object.keys(spec.schema).length === 0) return 'schema'
  const run = canonicalRun(spec.run)
  if (!run) return 'run'
  if (run.kind === 'delegate') {
    if (run.tool !== spec.replaces) return 'run.tool'
    if (delegateSchemaMissing) return 'schema'
    if (delegateSchema) {
      const over = invalidAgainstSchema(delegateSchema, run.overrides)
      if (over) return over
      const defaults = invalidAgainstSchema(delegateSchema, run.defaults)
      if (defaults) return defaults
    }
    return null
  }
  if (typeof run.command !== 'string' || run.command.trim() === '' || run.command.length > 4000) return 'command'
  const slots = [...run.command.matchAll(/\{\{([a-zA-Z0-9_]+)\}\}/g)].map((match) => match[1])
  for (const slot of slots) {
    if (!Object.prototype.hasOwnProperty.call(spec.schema, slot)) return slot
  }
  return null
}

/** 原工具过线后，提案一个属于本插件的新工具，不改原工具定义。 */
export function proposeOwned(state, input) {
  const tool = state.tools[input.tool]
  if (!tool?.gated) return { ok: false, code: 'BELOW_THRESHOLD' }
  if (tool.successor) return { ok: false, code: 'HAS_SUCCESSOR', successor: tool.successor }
  const spec = { ...ownedCore(input), replaces: input.tool }
  const bad = invalidOwned(spec, input.schemaError, input.delegateSchema, input.delegateSchemaMissing)
  if (bad) return { ok: false, code: 'BAD_PATCH', key: bad }
  const proposal = { id: input.id, tool: input.tool, kind: 'create', replaces: input.tool, ...ownedCore(spec) }
  state.proposals[input.tool] = proposal
  return { ok: true, proposal }
}

/** 修改已经属于本插件的工具。与当前一版相同则拒绝。 */
export function reviseOwned(current, input) {
  const replaces = current.replaces ?? current.run?.tool
  const spec = { ...ownedCore({ ...current, ...input, name: current.name }), replaces }
  const bad = invalidOwned(spec, input.schemaError, input.delegateSchema, input.delegateSchemaMissing)
  if (bad) return { ok: false, code: 'BAD_PATCH', key: bad }
  if (sameOwned(current, spec)) return { ok: false, code: 'SAME_REVISION' }
  return { ok: true, proposal: { kind: 'revise', tool: current.name, replaces, ...ownedCore(spec) } }
}

/** 审批卡上要看见真正会跑的脚本或覆盖值，并保持一行。 */
export function runBrief(run) {
  if (run?.kind === 'script') return `脚本 ${JSON.stringify(run.command ?? '')}`
  return `调用 ${run?.tool ?? ''}，覆盖 ${JSON.stringify(run?.overrides ?? {})}`
}

export function ownedCopy(proposal) {
  const problem = String(proposal.problem ?? '').slice(0, 40)
  const action = proposal.kind === 'revise' ? '修改' : '增加'
  const zh = `允许${action}本会话工具 ${proposal.name}。${runBrief(proposal.run)}。问题：${problem}。`
  const en = `Allow ${proposal.kind === 'revise' ? 'revising' : 'adding'} session tool ${proposal.name}. ${runBrief(proposal.run)}. Problem: ${problem}.`
  return { zh, en }
}

function describeNode(key, node, indent) {
  const required = node?.required ? '必填' : '可选'
  const enumText = Array.isArray(node?.enum) ? `，可选 ${node.enum.join('/')}` : ''
  let line = `${indent}- ${key} (${node?.type ?? 'json'}, ${required}${enumText}): ${node?.description ?? ''}`
  if (node?.type === 'array' && node.items) line += `\n${describeNode('元素', node.items, `${indent}  `)}`
  if (node?.type === 'object' && node.properties) line += `\n${describeSchema(node.properties, `${indent}  `)}`
  if (Array.isArray(node?.oneOf)) {
    line += node.oneOf.map((branch, index) => `\n${describeNode(`分支${index + 1}`, branch, `${indent}  `)}`).join('')
  }
  return line
}

function describeSchema(schema, indent = '') {
  return Object.entries(schema ?? {}).map(([key, node]) => describeNode(key, node, indent)).join('\n')
}

/** 会话说明。嵌套字段和脚本正文都写出来。尚未换上的修改不出现在这里。 */
export function renderNotes(owned) {
  const blocks = Object.values(owned ?? {}).map((spec) => {
    const shown = spec?.staged && spec.previous ? { ...spec.previous, replaces: spec.replaces } : spec
    const run = shown.run?.kind === 'script'
      ? `脚本：${shown.run.command}`
      : `调用 ${shown.run?.tool}。强制字段：${JSON.stringify(shown.run?.overrides ?? {})}。`
    return [`## ${shown.name}`, `代替 ${shown.replaces}。`, `问题：${shown.problem}`, `用法：${shown.usage}`, '参数：', describeSchema(shown.schema), run].join('\n')
  })
  return ['# 本会话的替代工具', ...blocks].join('\n\n')
}

export function notesDescription(owned) {
  const names = Object.keys(owned ?? {})
  return names.length > 0 ? `本会话的替代工具：${names.join('、')}` : '本会话还没有替代工具'
}

/** 任意工具的审批卡。说明原调用不能改参数，以及批准后要改用的工具名。 */
export function adaptationCopy(proposal, stats) {
  const fix = proposal.fixTool
  const change = JSON.stringify(proposal.patch)
  const zh = `这个会话里 ${proposal.tool} 失败 ${stats.failures} 次、同参数重试 ${stats.retries} 次、结果被截断 ${stats.partials} 次，摩擦分 ${stats.score}。Harness 不允许改写这次调用的参数。请允许使用 ${fix}：它会套用 ${change}，再调用原来的 ${proposal.tool}。同意后请改用 ${fix}，不要直接调用 ${proposal.tool}。这次只影响当前会话。`
  const en = `In this session ${proposal.tool} failed ${stats.failures} times, retried the same arguments ${stats.retries} times, and returned truncated results ${stats.partials} times. Friction score: ${stats.score}. Harness does not allow rewriting the arguments of the current call. Allow ${fix}: it applies ${change}, then calls ${proposal.tool}. After approval, call ${fix} instead of ${proposal.tool}. This approval affects only the current session.`
  return { zh, en }
}
