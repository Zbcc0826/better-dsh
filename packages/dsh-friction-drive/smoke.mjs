/**
 * 不调用模型。确认插件按会话保存定义，审批文案来自公式。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'

const home = mkdtempSync(path.join(tmpdir(), 'friction-home-'))
process.env.DSH_HOME = home

const drive = await import('./index.js')
const demo = await import('../dsh-friction-demo/index.js')

class ToolsStub extends Service {
  constructor(ctx) {
    super(ctx, 'tools')
    this.items = new Map()
    this.schemas = new Map()
  }

  // 原工具的 JSON Schema。包装工具会把它抄到自己的参数上。
  get(name) {
    const parameters = this.schemas.get(name)
    return parameters ? { parameters } : undefined
  }

  register(tool) {
    this.items.set(tool.name, tool)
    return () => {
      this.items.delete(tool.name)
    }
  }

  async execute(input) {
    this.lastBatch = input
    return {
      results: input.calls.map((call) => ({
        callId: call.id,
        result: {
      isError: false,
      content: [{ type: 'text', text: '(no output)' }],
      value: { exitCode: 0 },
    },
      })),
      additionalContexts: [],
      concluded: false,
    }
  }
}

let approvalMode = 'unavailable'
let lastReason = ''

class SkillsStub extends Service {
  constructor(ctx) {
    super(ctx, 'skills')
    this.items = new Map()
  }

  register(skill) {
    this.items.set(skill.name, skill)
    return () => {
      this.items.delete(skill.name)
    }
  }
}

class ApprovalStub extends Service {
  constructor(ctx) {
    super(ctx, 'approval')
  }

  request(req) {
    lastReason = req.displayReason?.zh ?? req.reason ?? ''
    return approvalMode
  }
}

const ctx = new Context()
try {
  await ctx.plugin(ToolsStub)
  await ctx.plugin(SkillsStub)
  await ctx.plugin(ApprovalStub)
  await ctx.plugin(drive)
  await ctx.plugin(demo)
  console.log('tools', [...ctx.tools.items.keys()].join(','))
  const ledger = ctx.tools.items.get('ledger_lookup')
  const exec = { agent: { session: { id: `smoke-${Date.now()}` } }, callId: 'c1' }
  const first = JSON.parse(await ledger.execute({ view: 'audit', tag: '待核' }, exec))
  if (first.code !== 'WARMUP') throw new Error(`expected warmup, got ${first.code}`)
  let crossed = null
  for (let page = 0; page < 6 && !crossed; page += 1) {
    const args = { view: 'audit', tag: '待核' }
    if (page > 0) args.cursor = String(page)
    const body = JSON.parse(await ledger.execute(args, { ...exec, callId: `p${page}` }))
    if (body.prose?.includes('INV-2402')) throw new Error('tag filter leaked a 已核 row')
    if (body.friction_gate) crossed = body
  }
  if (!crossed) throw new Error('ledger did not cross the threshold')
  const fx = JSON.parse(await ctx.tools.items.get('fx_convert').execute({ amount: 1, unit: '元' }, { ...exec, callId: 'c2' }))
  if (fx.yuan !== 1) throw new Error('fx was blocked together with ledger')
  const badKey = JSON.parse(await ctx.tools.items.get('propose_tool_goal').execute({
    tool: 'ledger_lookup',
    metric: 'projected_calls',
    patch_json: JSON.stringify({ page_size: 50 }),
  }, exec))
  if (badKey.code !== 'BAD_PATCH' || !badKey.patchKeys.includes('pageSize')) {
    throw new Error(`bad key should name the allowed fields: ${JSON.stringify(badKey)}`)
  }
  const patch = { pageSize: 8, warmupError: false, format: 'compact' }
  const proposed = JSON.parse(await ctx.tools.items.get('propose_tool_goal').execute({
    tool: 'ledger_lookup',
    metric: 'projected_calls',
    patch_json: JSON.stringify(patch),
  }, exec))
  if (!proposed.ok || proposed.proposal.current !== 6 || proposed.proposal.target !== 1) {
    throw new Error(`propose failed ${JSON.stringify(proposed)}`)
  }
  const denied = JSON.parse(await ctx.tools.items.get('apply_tool_change').execute({
    tool: 'ledger_lookup',
    patch_json: JSON.stringify(patch),
  }, exec))
  if (denied.code !== 'NOT_APPROVED') throw new Error(`headless apply should fail closed, got ${denied.code}`)
  if (!lastReason.includes('最近一次要处理的 5 条') || !lastReason.includes('每页条数改为 8')) {
    throw new Error(`approval copy missing the formula: ${lastReason}`)
  }
  const mismatch = JSON.parse(await ctx.tools.items.get('apply_tool_change').execute({
    tool: 'ledger_lookup',
    patch_json: JSON.stringify({ pageSize: 4 }),
  }, exec))
  if (mismatch.code !== 'PATCH_MISMATCH') throw new Error(`mismatch got ${mismatch.code}`)
  const blocked = JSON.parse(await ledger.execute({ view: 'audit', tag: '待核', cursor: '2' }, { ...exec, callId: 'c3' }))
  if (blocked.code !== 'FRICTION_GATE') throw new Error(`next call should block, got ${blocked.code}`)
  approvalMode = 'allowed-once'
  const applied = JSON.parse(await ctx.tools.items.get('apply_tool_change').execute({
    tool: 'ledger_lookup',
    patch_json: JSON.stringify(patch),
  }, exec))
  if (!applied.ok || applied.after !== 1) throw new Error(`apply did not retest down to 1: ${JSON.stringify(applied)}`)
  const again = JSON.parse(await ledger.execute({ view: 'audit', tag: '待核' }, { ...exec, callId: 'c4' }))
  if (!Array.isArray(again.rows) || again.rows.some((row) => row.tags.includes('已核')) || again.rows.length !== 5) {
    throw new Error(`tagged compact page is wrong: ${JSON.stringify(again)}`)
  }
  const other = ctx.friction.spec('other-session', 'ledger_lookup')
  if (other.pageSize !== 1 || other.warmupError !== true) throw new Error(`other session was changed: ${JSON.stringify(other)}`)
  console.log('smoke ok', { score: crossed.friction_gate.score, after: applied.after, rows: again.rows.length })
  const foreignAgent = { session: { id: `foreign-${Date.now()}` }, ctx }
  const foreign = { agent: foreignAgent, callId: 'g1' }
  for (let index = 0; index < 3; index += 1) {
    ctx.friction.observe(foreignAgent.session.id, { tool: 'grep', ok: false, args: '{"path":"."}', outputChars: 20, elapsedMs: 0, truncated: false })
  }
  const ownedPatch = {
    name: 'grep_src',
    problem: '查找范围太大',
    usage: '只查 src',
    schema: {
      query: { type: 'string', required: true, description: '要查找的文本' },
      tags: {
        type: 'array',
        description: '可选标签',
        items: { type: 'string' },
      },
    },
    run: { kind: 'delegate', tool: 'grep', overrides: { path: 'src' } },
  }
  ctx.tools.schemas.set('grep', {
    type: 'object',
    properties: {
      query: { type: 'string' },
      path: { type: 'string' },
    },
  })
  const foreignProposal = JSON.parse(await ctx.tools.items.get('propose_tool_goal').execute({
    tool: 'grep',
    metric: 'failures',
    patch_json: JSON.stringify(ownedPatch),
  }, foreign))
  if (!foreignProposal.ok || !/^fd_grep_\d+$/.test(foreignProposal.proposal.name)) {
    throw new Error(`foreign propose failed ${JSON.stringify(foreignProposal)}`)
  }
  const createdName = foreignProposal.proposal.name
  approvalMode = 'allowed-once'
  const foreignApplied = JSON.parse(await ctx.tools.items.get('apply_tool_change').execute({
    tool: 'grep',
    patch_json: JSON.stringify(ownedPatch),
  }, foreign))
  if (!foreignApplied.ok || foreignApplied.name !== createdName) throw new Error(`owned tool missing ${JSON.stringify(foreignApplied)}`)
  const owned = ctx.tools.items.get(createdName)
  const fields = Object.keys(owned.parameters?.properties ?? {})
  if (!fields.includes('query') || !fields.includes('tags')) {
    throw new Error(`grep_src schema was flattened: ${fields.join(',')}`)
  }
  const body = await owned.execute({ query: 'TODO', tags: ['a'] }, { ...foreign, callId: 'g2' })
  if (!body.text.includes('[exit code: 0]') || !body.text.includes('已覆盖')) throw new Error(`owned result dropped the rewrite: ${body.text}`)
  const forwarded = JSON.parse(ctx.tools.lastBatch.calls[0].arguments)
  if (forwarded.path !== 'src' || forwarded.query !== 'TODO') throw new Error(`delegate args were wrong: ${body.text}`)
  const status = JSON.parse(await ctx.tools.items.get('friction_status').execute({}, foreign))
  if (!status.notes.includes('查找范围太大') || !status.notes.includes(createdName)) {
    throw new Error(`session notes missing the new tool: ${status.notes}`)
  }
  const same = JSON.parse(await ctx.tools.items.get('propose_tool_goal').execute({
    tool: createdName,
    metric: 'failures',
    patch_json: JSON.stringify(ownedPatch),
  }, foreign))
  if (same.code !== 'SAME_REVISION') throw new Error(`same revision was accepted: ${JSON.stringify(same)}`)
  const revisedPatch = { ...ownedPatch, usage: '只查 src/lib' }
  const revised = JSON.parse(await ctx.tools.items.get('propose_tool_goal').execute({
    tool: createdName,
    metric: 'failures',
    patch_json: JSON.stringify(revisedPatch),
  }, foreign))
  if (!revised.ok || revised.proposal.kind !== 'revise') throw new Error(`revise failed ${JSON.stringify(revised)}`)
  const revisedApplied = JSON.parse(await ctx.tools.items.get('apply_tool_change').execute({
    tool: createdName,
    patch_json: JSON.stringify(revisedPatch),
  }, foreign))
  if (!revisedApplied.ok || revisedApplied.pending !== true) throw new Error(`revise apply failed ${JSON.stringify(revisedApplied)}`)
  if (ctx.tools.items.get(createdName).description !== '只查 src') {
    throw new Error('revision replaced the tool before the turn ended')
  }
  ctx.friction.commit(foreignAgent)
  if (ctx.tools.items.get(createdName).description !== '只查 src/lib') {
    throw new Error('revised schema was not installed')
  }
  const statusAfter = JSON.parse(await ctx.tools.items.get('friction_status').execute({}, foreign))
  if (!statusAfter.notes.includes('只查 src/lib') || !statusAfter.notes.includes('元素')) {
    throw new Error(`session notes kept the old usage: ${statusAfter.notes}`)
  }
  console.log('foreign tool ok', forwarded.path, 'exit', 0)
} catch (error) {
  console.error('SMOKE_FAIL', error)
  process.exitCode = 1
} finally {
  rmSync(home, { recursive: true, force: true })
}
