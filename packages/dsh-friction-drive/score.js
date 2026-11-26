/**
 * 摩擦分、重复台账和工具身份分开记。
 * 分数按轮数和时间衰减；身份不随分数清掉。
 */

/** 提示线。到了只附加一句，不拦调用。 */
export const HINT_SCORE = 6

/** 拦线。到了或同一失败签名凑满三次，才拦下一次。 */
export const BLOCK_SCORE = 10

/** 轮数半衰期。隔三轮，旧失败只剩一半权重。 */
export const HALF_LIFE_ROUNDS = 3

/** 时间半衰期。八小时后大约剩下四分之一。 */
export const HALF_LIFE_MS = 4 * 60 * 60 * 1000

/** 同一失败签名在窗口内凑满这么多次，就拦一次。 */
export const SIGNATURE_REPEAT = 3

/** 旧状态文件可能没有这些字段。读到时补上，不改已经记下的身份。 */
export function ensureLedgers(state) {
  state.identity = state.identity ?? {}
  state.repetition = state.repetition ?? {}
  state.notes = state.notes ?? []
  state.round = state.round ?? 0
  state.blockScore = state.blockScore ?? BLOCK_SCORE
  state.hintScore = state.hintScore ?? HINT_SCORE
  state.halfLifeRounds = state.halfLifeRounds ?? HALF_LIFE_ROUNDS
  state.halfLifeMs = state.halfLifeMs ?? HALF_LIFE_MS
  state.cardsIssued = state.cardsIssued ?? 0
  return state
}

/** 工具身份。和分数不是同一个对象。 */
export function ensureIdentity(state, name) {
  ensureLedgers(state)
  if (!state.identity[name]) {
    state.identity[name] = {
      registered: false,
      persisted: false,
      voluntary: false,
      unmet: 0,
      retiredAt: null,
      broken: false,
    }
  }
  return state.identity[name]
}

/**
 * 失败签名：工具、错误码、消息形状。
 * 成功调用不签名。同一个坑会落到同一条签名上，不同的坑不会并在一起。
 * 工具正文里的 {"ok":false,"code":"BAD_PATCH","field":"slug"} 记成 BAD_PATCH:slug。
 */
export function failureSignature(tool, event) {
  const parsed = parseToolError(event)
  if (!parsed && event.ok !== false) return ''
  const code = parsed?.code || event.errorCode || extractCode(event) || 'failure'
  const shape = parsed ? parsedShape(parsed) : messageShape(event)
  return `${tool}·${code}·${shape}`
}

/** 工具把失败写在 JSON 正文里时，取出错误码和字段。正文不是纯 JSON 就不猜。 */
export function parseToolError(event) {
  const text = `${event?.output ?? ''}\n${event?.message ?? ''}`.trim()
  if (!text.startsWith('{')) return null
  let body
  try { body = JSON.parse(text) } catch { return null }
  if (!body || body.ok !== false || typeof body.code !== 'string' || !body.code.trim()) return null
  return {
    code: body.code.trim(),
    field: typeof body.field === 'string' ? body.field.trim() : '',
    id: typeof body.id === 'string' ? body.id.trim() : '',
  }
}

/** 按轮数和时间同时衰减。现在这一轮、这一刻的权重是 1。 */
export function decayedWeight(event, state, now) {
  const round = Math.max(0, (state.round ?? 0) - (event.round ?? 0))
  const elapsed = Math.max(0, now - (event.at ?? now))
  const byRound = 0.5 ** (round / (state.halfLifeRounds || HALF_LIFE_ROUNDS))
  const byTime = 0.5 ** (elapsed / (state.halfLifeMs || HALF_LIFE_MS))
  return event.weight * byRound * byTime
}

/** 当前分数。没有事件时，沿用旧账本里的一笔总分，并把它当成上一轮的一次失败。 */
export function currentScore(state, name, now = Date.now()) {
  ensureLedgers(state)
  const tool = state.tools?.[name]
  if (!tool) return 0
  const events = tool.events ?? []
  if (events.length === 0) return round2(tool.score ?? 0)
  let sum = 0
  for (const event of events) sum += decayedWeight(event, state, now)
  return round2(sum)
}

/** 窗口内还剩至少一半权重的同签名次数。 */
export function signatureCount(state, name, signature, now = Date.now()) {
  const tool = state.tools?.[name]
  if (!tool) return 0
  return (tool.events ?? []).filter((event) => event.signature === signature && decayedWeight({ ...event, weight: 1 }, state, now) >= 0.5).length
}

/** 成功调用的参数形状。只看键，不看具体值。 */
export function callShape(tool, args) {
  let value = args
  if (typeof args === 'string') {
    try { value = JSON.parse(args) } catch { value = null }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return `${tool}:scalar`
  return `${tool}:{${Object.keys(value).sort().join(',')}}`
}

/** 记下一次成功的结构重复。满三次只给建议，不关闸。 */
export function noteRepetition(state, tool, args, at) {
  ensureLedgers(state)
  const shape = callShape(tool, args)
  const row = state.repetition[shape] ?? { count: 0, firstAt: at, lastAt: at, shape }
  row.count += 1
  row.lastAt = at
  state.repetition[shape] = row
  return row
}

export function repetitionSuggestion(state, tool, args) {
  const row = state.repetition?.[callShape(tool, args)]
  if (!row || row.count < 3) return ''
  return `同一结构已经出现 ${row.count} 次，可考虑沉淀成工具`
}

/**
 * 替换工具第一次就报 inactive context 时，立刻交还原工具。
 * 这次失败不加分。
 */
export function rollbackReplacement(state, event) {
  if (event.ok !== false) return null
  const text = `${event.output ?? ''}\n${event.message ?? ''}`
  if (!/inactive context/i.test(text)) return null
  for (const [original, row] of Object.entries(state.tools ?? {})) {
    if (row?.successor !== event.tool) continue
    const identity = ensureIdentity(state, event.tool)
    identity.broken = true
    identity.retiredAt = new Date(event.at ?? Date.now()).toISOString()
    delete row.successor
    return { restored: original }
  }
  return null
}

/** 选择卡上的三个动作。继续一次和暂停都要用户点允许。 */
export const CARD_ACTIONS = [
  { id: 'propose', label: '沉淀替代' },
  { id: 'continue-one', label: '继续一次' },
  { id: 'pause', label: '本会话暂停' },
]

/** 拦住时交给调用方的说明。只放行一次，三个选项都写上。 */
export const GATE_MESSAGE = '只放行一次。三个选项：沉淀替代、继续一次、本会话暂停。'

/**
 * 过线时写一张选择卡。同一轮里后过线的工具并进这一张，不另发。
 * 卡上有工具名、分数、失败签名、最近几次事件和三个动作。
 */
export function armCard(state, name, score, signature = '', events = []) {
  ensureLedgers(state)
  const shown = cardSignature(signature, events)
  const entry = {
    tool: name,
    name,
    score,
    signature: shown,
    signatures: cardSignatures(shown, events),
    events: eventSummary(events),
  }
  if (!state.card?.actions || state.card.round !== state.round) {
    state.card = {
      round: state.round,
      ...entry,
      actions: CARD_ACTIONS.map((item) => ({ ...item })),
      tools: [entry],
    }
    state.cardsIssued += 1
    return state.card
  }
  const index = state.card.tools.findIndex((item) => item.tool === name)
  if (index === -1) state.card.tools.push(entry)
  else state.card.tools[index] = entry
  Object.assign(state.card, entry)
  return state.card
}

/** 被拦住的调用返回这个结构，状态里的 card 是同一张。 */
export function gatedDecision(card) {
  return { ok: false, code: 'GATED', message: GATE_MESSAGE, card: card ?? null }
}

/** 用户点了继续一次。闸先留着，真正执行前再花掉这一次。 */
export function allowContinue(state, name) {
  ensureLedgers(state)
  const tool = state.tools?.[name]
  if (!tool?.gated) return { ok: false, code: 'NOT_GATED' }
  tool.continueOnce = true
  state.notes.push(`用户选择继续一次：${name}。只放行一次。`)
  return { ok: true, action: 'continue-one', tool: name }
}

/** 这一次调用获准执行。随后重新评估，不会一直放开。 */
export function spendContinue(state, name) {
  const tool = state.tools?.[name]
  if (!tool?.continueOnce) return { ok: false, code: 'NO_CONTINUE' }
  tool.continueOnce = false
  tool.gated = false
  tool.hold = false
  return { ok: true }
}

/** 只有用户或设置页能暂停。代理自己调用会被拒绝。 */
export function pauseGates(state, at, source) {
  ensureLedgers(state)
  if (source !== 'user' && source !== 'setting') return { ok: false, code: 'PAUSE_FORBIDDEN' }
  state.pause = { at, by: source }
  for (const tool of Object.values(state.tools ?? {})) {
    if (!tool) continue
    tool.gated = false
    tool.hold = false
    tool.continueOnce = false
  }
  state.card = null
  state.notes.push(`闸门已于 ${at} 由用户暂停`)
  return { ok: true, pause: state.pause }
}

/** 会话结束时写摘要，并恢复被暂停的闸门。 */
export function closeSession(state, now = Date.now()) {
  ensureLedgers(state)
  const summary = {
    at: new Date(now).toISOString(),
    restored: Boolean(state.pause),
    pause: state.pause ? { ...state.pause } : null,
    tools: Object.fromEntries(Object.entries(state.tools ?? {}).map(([name, tool]) => [name, {
      score: currentScore(state, name, now),
      failures: tool.failures ?? 0,
    }])),
  }
  if (state.pause) {
    state.notes.push('闸门已于会话结束恢复')
    state.pause = null
  }
  state.summary = summary
  return summary
}

/**
 * 恢复同一会话时往前走一轮，让旧分数衰减，身份保持原样。
 * 不制造新的退役行。
 */
export function resumeSession(state, now = Date.now()) {
  ensureLedgers(state)
  const retiredBefore = Object.values(state.identity).filter((item) => item?.retiredAt).length
  for (const [name, tool] of Object.entries(state.tools ?? {})) {
    tool.events = tool.events ?? []
    if (tool.events.length === 0 && (tool.score ?? 0) > 0) {
      tool.events.push({
        weight: tool.score,
        round: state.round,
        at: now - 1000,
        signature: `${name}·legacy·error`,
      })
    }
  }
  state.round += 1
  for (const name of Object.keys(state.tools ?? {})) {
    state.tools[name].score = currentScore(state, name, now)
  }
  const retiredAfter = Object.values(state.identity).filter((item) => item?.retiredAt).length
  return { retiredAdded: retiredAfter - retiredBefore }
}

/**
 * 分成正在使用、已退役、未注册三区。
 * 只剩计数的 fd_ 工具进退役区，不和正在使用的工具混在一起。
 */
export function partitionTools(state, liveNames, now = Date.now()) {
  ensureLedgers(state)
  const active = {}
  const retired = {}
  const unmet = {}
  for (const [name, tool] of Object.entries(state.tools ?? {})) {
    tool.score = currentScore(state, name, now)
    const identity = state.identity[name] ?? {}
    const row = { ...tool, ...identity, score: tool.score }
    if (identity.unmet) unmet[name] = identity.unmet
    const stale = Boolean(identity.retiredAt || identity.broken)
      || (liveNames && !liveNames.has(name) && /^fd_[a-z0-9]+_\d+$/i.test(name))
    if (stale) retired[name] = row
    else active[name] = row
  }
  return { active, retired, unmet }
}

function parsedShape(parsed) {
  if (parsed.field) return `${parsed.code}:${parsed.field}`
  if (parsed.id) return `${parsed.code}:${parsed.id}`
  return parsed.code
}

function extractCode(event) {
  const text = `${event.errorCode ?? ''}\n${event.message ?? ''}\n${event.output ?? ''}`
  const named = text.match(/\b([A-Z][A-Z0-9_]{2,}):([A-Za-z0-9_-]+)/)
  if (named) return named[1]
  const errno = text.match(/\b(E[A-Z]{2,})\b/)
  if (errno) return errno[1]
  if (/inactive context/i.test(text)) return 'INACTIVE'
  if (/unknown tool/i.test(text)) return 'UNKNOWN_TOOL'
  if (/timeout/i.test(text)) return 'ETIMEDOUT'
  return ''
}

function messageShape(event) {
  const text = `${event.message ?? ''}\n${event.output ?? ''}`
  const named = text.match(/\b([A-Z][A-Z0-9_]{2,}):([A-Za-z0-9_-]+)/)
  if (named) return `${named[1]}:${named[2]}`
  const errno = text.match(/\b(E[A-Z]{2,})\b/)
  const op = text.match(/\b(open|read|write|stat|connect)\b/)
  if (errno && op) return `${errno[1]}:${op[1]}`
  if (errno) return errno[1]
  if (/inactive context/i.test(text)) return 'inactive context'
  if (/timeout/i.test(text)) return 'ETIMEDOUT'
  const unknown = text.match(/unknown tool[:\s"]+([A-Za-z0-9_.-]+)/i)
  if (unknown) return `unknown tool:${unknown[1]}`
  return 'error'
}

function eventSummary(events) {
  return (events ?? []).slice(-5).map((item) => ({
    round: item.round ?? 0,
    weight: item.weight ?? 0,
    signature: item.signature ?? '',
  }))
}

/** 卡面签名取最近一次真正的失败。权重不到 1 的旧记录（例如 ok·error）不盖住它。 */
function cardSignature(signature, events) {
  const lastFailure = [...(events ?? [])].reverse().find((item) => item.signature && (item.weight ?? 0) >= 1)
  return lastFailure?.signature || signature || null
}

/** 重复到线的签名都列出来。最近一次失败放在最前，方便和卡面签名对照。 */
function cardSignatures(headline, events) {
  const counts = new Map()
  for (const item of events ?? []) {
    if (!item.signature || !(item.weight > 0)) continue
    counts.set(item.signature, (counts.get(item.signature) ?? 0) + 1)
  }
  const repeated = [...counts].filter(([, count]) => count >= SIGNATURE_REPEAT).map(([key]) => key)
  return [...new Set([headline, ...repeated].filter(Boolean))]
}

function round2(value) {
  return Math.round(value * 100) / 100
}
