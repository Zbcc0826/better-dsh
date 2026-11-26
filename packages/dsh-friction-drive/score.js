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
 * 同一个坑会落到同一条签名上，不同的坑不会并在一起。
 */
export function failureSignature(tool, event) {
  const code = event.errorCode || extractCode(event) || (event.ok === false ? 'failure' : 'ok')
  return `${tool}·${code}·${messageShape(event)}`
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

/** 同一轮里后过线的工具并进已经发出的那一张卡。 */
export function armCard(state, name, score) {
  ensureLedgers(state)
  if (!state.card || state.card.round !== state.round) {
    state.card = { round: state.round, tools: [] }
    state.cardsIssued += 1
  }
  if (!state.card.tools.some((item) => item.name === name)) {
    state.card.tools.push({ name, score })
  }
  return state.card
}

/** 只有用户或设置页能暂停。代理自己调用会被拒绝。 */
export function pauseGates(state, at, source) {
  ensureLedgers(state)
  if (source !== 'user' && source !== 'setting') return { ok: false, code: 'PAUSE_FORBIDDEN' }
  state.pause = { at, by: source }
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

function round2(value) {
  return Math.round(value * 100) / 100
}
