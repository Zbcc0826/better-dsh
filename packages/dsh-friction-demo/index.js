/**
 * 示例工具读插件保存的当前会话定义。补丁不会写回这个文件里的种子。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { leaksDemoSource } from './guard.js'

const LEDGER = [
  { id: 'INV-2401', name: '机房巡检', amount: 4.2, unit: '万元', tags: ['待核'], meeting: 'M-01' },
  { id: 'INV-2402', name: '备件运费', amount: 8600, unit: '元', tags: ['已核'], meeting: 'M-02' },
  { id: 'INV-2403', name: '临时电源', amount: 12.5, unit: '千元', tags: ['待核'], meeting: 'M-01' },
  { id: 'INV-2404', name: '门禁改造', amount: 2.2, unit: '万元', tags: ['待核'], meeting: 'M-03' },
  { id: 'INV-2405', name: '保洁耗材', amount: 640, unit: '元', tags: ['已核'], meeting: 'M-02' },
  { id: 'INV-2406', name: '网络模块', amount: 7.8, unit: '千元', tags: ['待核'], meeting: 'M-03' },
  { id: 'INV-2407', name: '加班餐', amount: 960, unit: '元', tags: ['待核'], meeting: null },
  { id: 'INV-2408', name: '季度维保', amount: 1.1, unit: '万元', tags: ['已核'], meeting: 'M-01' },
]

const WINDOWS = {
  maintenance: { id: 'maintenance', title: '检修窗', start: '2026-11-18T09:00:00', end: '2026-11-18T11:30:00' },
  'M-01': { id: 'M-01', title: '巡检协调会', start: '2026-11-18T10:00:00', end: '2026-11-18T12:00:00' },
  'M-02': { id: 'M-02', title: '后勤例会', start: '2026-11-18T13:00:00', end: '2026-11-18T14:00:00' },
  'M-03': { id: 'M-03', title: '改造评审会', start: '2026-11-18T11:00:00', end: '2026-11-18T11:20:00' },
}

export const name = 'friction-demo'
export const inject = ['friction', 'tools']

export function apply(ctx) {
  ctx.friction.register({
    name: 'ledger_lookup',
    formula: 'paged',
    itemCount: LEDGER.length,
    patchKeys: ['pageSize', 'warmupError', 'format', 'engine'],
    engines: ['ledger_paged', 'ledger_compact'],
    flatEngines: ['ledger_compact'],
    flatCalls: 1,
    seed: { engine: 'ledger_paged', pageSize: 1, warmupError: true, format: 'verbose', minIntervalMs: 0, delayMs: 0 },
  })
  ctx.friction.register({
    name: 'fx_convert',
    formula: 'per-item',
    itemCount: 5,
    repeat: 1,
    patchKeys: ['engine', 'delayMs'],
    engines: ['fx_strict', 'fx_batch'],
    flatEngines: ['fx_batch'],
    flatCalls: 1,
    seed: { engine: 'fx_strict', delayMs: 0 },
  })
  ctx.friction.register({
    name: 'window_overlap',
    formula: 'per-item',
    itemCount: 3,
    repeat: 2,
    patchKeys: ['engine', 'delayMs'],
    engines: ['overlap_strict', 'overlap_iso'],
    flatEngines: ['overlap_iso'],
    flatCalls: 3,
    seed: { engine: 'overlap_strict', delayMs: 0 },
  })

  ctx.on('tools/post-execute', async (_exec, result, next) => {
    const decision = typeof next === 'function' ? await next() : { kind: 'accept' }
    const rendered = `${JSON.stringify(result ?? {})}${JSON.stringify(decision ?? {})}`
    if (leaksDemoSource(rendered)) {
      return { kind: 'block', feedback: [{ type: 'text', text: '结果包含示例源码或内部时间表，已拦截。时间窗请向 window_overlap 要格式提示。' }] }
    }
    return decision
  })

  register(ctx, 'ledger_lookup', '查询账本。view=audit。tag 会过滤，例如待核。', {
    view: { type: 'string', description: '分页引擎要求 audit' },
    cursor: { type: 'string', description: '下一页游标' },
    tag: { type: 'string', description: '按标签过滤' },
  }, queryLedger)
  register(ctx, 'fx_convert', '把金额折成元。严格引擎一次一笔；批量引擎用 items_json。', {
    amount: { type: 'number' },
    unit: { type: 'string' },
    confirm_scale: { type: 'string' },
    items_json: { type: 'string' },
  }, convert)
  register(ctx, 'window_overlap', '计算重叠分钟。严格引擎要中文时间；ISO 引擎可传窗口 id。', {
    left_id: { type: 'string' },
    right_id: { type: 'string' },
    left_start: { type: 'string' },
    left_end: { type: 'string' },
    right_start: { type: 'string' },
    right_end: { type: 'string' },
  }, overlap)
}

function register(ctx, toolName, description, parameters, run) {
  ctx.tools.register(defineTool({
    name: toolName,
    description,
    parameters,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args, exec) {
      const sessionId = String(exec?.agent?.sessionId ?? exec?.agent?.session?.id ?? exec?.agent?.id ?? '')
      if (!sessionId) return JSON.stringify({ ok: false, code: 'SESSION_REQUIRED' })
      const outcome = run(ctx, args, sessionId)
      const recorded = ctx.friction.record(sessionId, {
        tool: toolName,
        ok: outcome.ok !== false,
        args: JSON.stringify(args ?? {}),
        outputChars: JSON.stringify(outcome).length,
        elapsedMs: 0,
        truncated: Boolean(outcome.truncated),
        workloadItems: toolName === 'ledger_lookup' ? rowsOf(args.tag).length : undefined,
      })
      if (recorded.blocked) {
        return JSON.stringify({
          ok: false,
          code: 'FRICTION_GATE',
          tool: toolName,
          score: recorded.tool?.score,
          instruction: '这个工具已过线。其他工具仍可使用。请调用 propose_tool_goal，再调用 apply_tool_change。审批卡由插件填写数字，不要向用户索要口令。',
        })
      }
      const body = recorded.gate ? { ...outcome, friction_gate: { tool: toolName, score: recorded.tool.score, reasons: recorded.reasons } } : outcome
      return JSON.stringify(body)
    },
  }))
}

function rowsOf(tag) {
  return tag ? LEDGER.filter((row) => row.tags.includes(tag)) : LEDGER
}

const warmedSessions = new Set()

function queryLedger(ctx, args, sessionId) {
  const spec = ctx.friction.spec(sessionId, 'ledger_lookup')
  if (!spec) return { ok: false, code: 'NO_SPEC' }
  if (spec.engine === 'ledger_compact') return { ok: true, rows: rowsOf(args.tag) }
  if (args.view !== 'audit') return { ok: false, code: 'VIEW_REQUIRED' }
  const warmKey = `${sessionId}:ledger`
  if (spec.warmupError && !warmedSessions.has(warmKey)) {
    warmedSessions.add(warmKey)
    return { ok: false, code: 'WARMUP', hint: '请用相同参数再调用一次' }
  }
  const all = rowsOf(args.tag)
  const size = Math.max(1, spec.pageSize ?? 1)
  const cursor = args.cursor ? Number(args.cursor) : 0
  const rows = all.slice(cursor, cursor + size)
  const next = cursor + rows.length
  const truncated = next < all.length
  if (spec.format === 'compact') {
    return { ok: true, rows, truncated, page: { returned: rows.length, total: all.length, next_cursor: truncated ? String(next) : null } }
  }
  return {
    ok: true,
    truncated,
    prose: rows.map((row) => `${row.id} ${row.name} ${row.amount}${row.unit} ${row.tags.join(',')}`).join('；'),
    page: { returned: rows.length, total: all.length, next_cursor: truncated ? String(next) : null },
  }
}

function convert(ctx, args, sessionId) {
  const spec = ctx.friction.spec(sessionId, 'fx_convert')
  if (!spec) return { ok: false, code: 'NO_SPEC' }
  if (spec.engine === 'fx_batch') {
    const items = JSON.parse(args.items_json || '[]')
    return { ok: true, rows: items.map((item) => ({ ...item, yuan: toYuan(item.amount, item.unit) })) }
  }
  if (!['元', '万元', '千元'].includes(args.unit)) return { ok: false, code: 'UNIT_REJECTED' }
  if (args.unit !== '元' && args.confirm_scale !== 'yes') return { ok: false, code: 'SCALE_UNCONFIRMED' }
  return { ok: true, yuan: toYuan(args.amount, args.unit) }
}

function overlap(ctx, args, sessionId) {
  const spec = ctx.friction.spec(sessionId, 'window_overlap')
  if (!spec) return { ok: false, code: 'NO_SPEC' }
  if (spec.engine === 'overlap_iso') {
    const left = WINDOWS[args.left_id]
    const right = WINDOWS[args.right_id]
    if (!left || !right) return { ok: false, code: 'UNKNOWN_WINDOW' }
    return { ok: true, minutes: overlapMinutes(left, right) }
  }
  const stamp = /^\d{4}年\d{2}月\d{2}日 \d{2}时\d{2}分$/
  const fields = [args.left_start, args.left_end, args.right_start, args.right_end]
  if (fields.some((value) => !stamp.test(value ?? ''))) {
    const windows = [args.left_id, args.right_id].filter((id) => WINDOWS[id]).map((id) => ({
      id,
      start: toChinese(WINDOWS[id].start),
      end: toChinese(WINDOWS[id].end),
    }))
    return { ok: false, code: 'FORMAT', windows }
  }
  const left = { start: parseChinese(args.left_start), end: parseChinese(args.left_end) }
  const right = { start: parseChinese(args.right_start), end: parseChinese(args.right_end) }
  return { ok: true, minutes: overlapMinutes(left, right) }
}

function toYuan(amount, unit) {
  if (unit === '万元') return Math.round(amount * 10000)
  if (unit === '千元') return Math.round(amount * 1000)
  return Math.round(amount)
}

function toChinese(iso) {
  const [date, time] = iso.split('T')
  const [year, month, day] = date.split('-')
  const [hour, minute] = time.split(':')
  return `${year}年${month}月${day}日 ${hour}时${minute}分`
}

function parseChinese(text) {
  const matched = text.match(/^(\d{4})年(\d{2})月(\d{2})日 (\d{2})时(\d{2})分$/)
  return `${matched[1]}-${matched[2]}-${matched[3]}T${matched[4]}:${matched[5]}:00`
}

function overlapMinutes(left, right) {
  const start = Math.max(Date.parse(left.start), Date.parse(right.start))
  const end = Math.min(Date.parse(left.end), Date.parse(right.end))
  return end > start ? Math.round((end - start) / 60000) : 0
}
