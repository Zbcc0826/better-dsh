/**
 * 不调用模型。覆盖公式、会话隔离、死锁恢复和审批文案。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { admit, applyAdaptation, approvalCopy, belowThresholdCopy, clearGate, failureOf, freshState, freshTool, gateSkipped, importPersisted, installOwnedRecord, noteCall, normalizeOwnedPatch, notesDescription, ownedCopy, ownedName, ownedPatchExample, ownedPatchHint, patchesMatch, persistedRecord, projectedCalls, propose, proposeOwned, renderNotes, retest, reviseOwned, sameOwned, scrubUnknownToolGate, semanticOwnedName, truncationOf } from './logic.js'
import { mergeLegacySignatures } from './score.js'
import { fillTemplate, optionalSlots, unknownArguments } from './owned-runtime.js'
import { ingestCall } from './compiler.js'
import { schemaError } from './schema.js'
import { allowContinue, closeSession, currentScore, gatedDecision, partitionTools, pauseGates, resumeSession, spendContinue } from './score.js'
import { readSession, readShared, sessionDir, withSession, withShared } from './store.js'

const ledgerEntry = {
  formula: 'paged',
  itemCount: 8,
  patchKeys: ['pageSize', 'warmupError', 'format', 'engine'],
  engines: ['ledger_paged', 'ledger_compact'],
  flatEngines: ['ledger_compact'],
  flatCalls: 1,
}
const ledgerSpec = { engine: 'ledger_paged', pageSize: 1, warmupError: true, format: 'verbose' }

test('成功的同参重复不加分，失败后的同参重试仍计 verbose', () => {
  const state = freshState(8)
  const first = noteCall(state, { tool: 'search', ok: true, args: 'a', outputChars: 5000, elapsedMs: 10 })
  assert.equal(first.points, 0)
  const again = noteCall(state, { tool: 'search', ok: true, args: 'a', outputChars: 5000, elapsedMs: 10 })
  assert.equal(again.points, 0)
  assert.equal(again.reasons.includes('retry'), false)
  assert.equal(again.reasons.includes('verbose'), false)
  assert.equal(state.tools.search.score, 0)
  assert.equal(state.tools.search.gated, false)
  noteCall(state, { tool: 'search', ok: false, args: 'b', outputChars: 5000, elapsedMs: 10 })
  const retry = noteCall(state, { tool: 'search', ok: false, args: 'b', outputChars: 5000, elapsedMs: 10 })
  assert.ok(retry.reasons.includes('failure'))
  assert.ok(retry.reasons.includes('retry'))
  assert.ok(retry.reasons.includes('verbose'))
})

test('同一失败签名第三次才拦下一次，不连坐其他工具', () => {
  const state = freshState()
  const calls = []
  for (let index = 0; index < 3; index += 1) {
    calls.push(noteCall(state, { tool: 'ledger', ok: false, args: '{"command":"ls"}', output: 'BAD_PATCH:sources', round: 1 }))
  }
  assert.equal(calls[2].blocked, false)
  assert.equal(calls[2].gate, true)
  assert.equal(calls[0].signature, calls[2].signature)
  assert.equal(state.card.tool, 'ledger')
  assert.equal(state.card.signature, calls[2].signature)
  assert.deepEqual(state.card.actions.map((item) => item.id), ['propose', 'continue-one', 'pause'])
  const decision = gatedDecision(state.card)
  assert.equal(decision.code, 'GATED')
  assert.match(decision.message, /只放行一次/)
  assert.match(decision.message, /沉淀替代/)
  assert.match(decision.message, /继续一次/)
  assert.match(decision.message, /本会话暂停/)
  assert.equal(decision.message.includes('继续这一次之后的调用'), false)
  const other = noteCall(state, { tool: 'fx', ok: true, args: '{"command":"pwd"}', round: 1 })
  assert.equal(other.blocked, false)
  const next = noteCall(state, { tool: 'ledger', ok: false, args: '{"command":"ls"}', output: 'BAD_PATCH:sources', round: 1 })
  assert.equal(next.blocked, true)
  assert.equal(next.code, 'GATED')
  assert.equal(state.tools.ledger.gated, true)
  assert.equal(allowContinue(state, 'ledger').ok, true)
  assert.equal(spendContinue(state, 'ledger').ok, true)
  const once = noteCall(state, { tool: 'ledger', ok: true, args: '{"command":"pwd"}', round: 1 })
  assert.equal(once.blocked, false)
  assert.equal(state.tools.ledger.gated, true)
  const again = noteCall(state, { tool: 'ledger', ok: true, args: '{"command":"pwd"}', round: 1 })
  assert.equal(again.blocked, true)
  assert.equal(again.code, 'GATED')
})

test('工具正文里的不同错误各有签名，慢的成功调用不签名也不拦', () => {
  const state = freshState()
  const slug = noteCall(state, { tool: 'wiki_ingest', ok: true, output: '{"ok":false,"code":"BAD_PATCH","field":"slug"}', elapsedMs: 10, round: 1 })
  const timed = noteCall(state, { tool: 'wiki_ingest', ok: true, output: '{"ok":false,"code":"ETIMEDOUT"}', elapsedMs: 10, round: 1 })
  assert.equal(slug.signature, 'wiki_ingest·BAD_PATCH·BAD_PATCH:slug')
  assert.equal(timed.signature, 'wiki_ingest·ETIMEDOUT·ETIMEDOUT')
  assert.notEqual(slug.signature, timed.signature)
  assert.equal(failureOf({ content: [{ text: '{"ok":false,"code":"BAD_PATCH","field":"contradicts"}' }] }).ok, false)
  const pit = freshState()
  let last
  for (let index = 0; index < 3; index += 1) {
    last = noteCall(pit, { tool: 'wiki_ingest', ok: true, output: '{"ok":false,"code":"BAD_PATCH","field":"slug"}', elapsedMs: 10, round: 1 })
  }
  assert.equal(last.gate, true)
  assert.equal(pit.card.signature, 'wiki_ingest·BAD_PATCH·BAD_PATCH:slug')
  const mixed = freshState()
  noteCall(mixed, { tool: 'wiki_ingest', ok: true, output: '{"ok":false,"code":"BAD_PATCH","field":"slug"}', elapsedMs: 10, round: 1 })
  noteCall(mixed, { tool: 'wiki_ingest', ok: true, output: '{"ok":false,"code":"BAD_PATCH","field":"contradicts"}', elapsedMs: 10, round: 1 })
  const other = noteCall(mixed, { tool: 'wiki_ingest', ok: true, output: '{"ok":false,"code":"ETIMEDOUT"}', elapsedMs: 10, round: 1 })
  assert.equal(other.gate, false)
  assert.equal(mixed.tools.wiki_ingest.gated, false)
  const slow = freshState()
  for (let index = 0; index < 3; index += 1) {
    const call = noteCall(slow, { tool: 'wiki_ingest', ok: true, output: '已写入', elapsedMs: 3000, round: 1 })
    assert.equal(call.signature, '')
    assert.equal(call.gate, false)
  }
  assert.equal(slow.tools.wiki_ingest.gated, false)
})

test('历史 ok·error 归并后不再占一个坑，真正的失败还在', () => {
  const state = freshState()
  const tool = freshTool()
  const at = Date.now()
  tool.events = [0, 1, 2].map(() => ({ weight: 0.2, round: 1, at, signature: 'wiki_ingest·ok·error' }))
  tool.lastSignature = 'wiki_ingest·ok·error'
  tool.gated = true
  state.tools.wiki_ingest = tool
  state.card = {
    round: 1,
    tool: 'wiki_ingest',
    signature: 'wiki_ingest·ok·error',
    signatures: ['wiki_ingest·BAD_PATCH·BAD_PATCH:claims', 'wiki_ingest·ok·error'],
    events: [{ round: 1, weight: 0.2, signature: 'wiki_ingest·ok·error' }],
    actions: [{ id: 'pause', label: '本会话暂停' }],
    tools: [],
  }
  const call = noteCall(state, {
    tool: 'wiki_ingest',
    ok: true,
    output: '{"ok":false,"code":"BAD_PATCH","field":"claims"}',
    elapsedMs: 10,
    round: 1,
    at,
  })
  assert.equal(call.gate, false)
  assert.equal(state.card, null)
  assert.equal(state.tools.wiki_ingest.gated, false)
  assert.equal(state.tools.wiki_ingest.events.filter((item) => item.signature === 'wiki_ingest·ok·error').length, 0)
  assert.equal(state.tools.wiki_ingest.events.filter((item) => item.weight === 0.2).length, 3)
  assert.equal(state.tools.wiki_ingest.events.at(-1).signature, 'wiki_ingest·BAD_PATCH·BAD_PATCH:claims')
  const kept = freshState()
  const real = freshTool()
  real.events = [
    ...[0, 1, 2].map(() => ({ weight: 1, round: 1, at, signature: 'wiki_ingest·BAD_PATCH·BAD_PATCH:claims' })),
    { weight: 0.2, round: 1, at, signature: 'wiki_ingest·ok·error' },
  ]
  real.gated = true
  real.score = 3
  kept.tools.wiki_ingest = real
  kept.card = {
    signature: 'wiki_ingest·BAD_PATCH·BAD_PATCH:claims',
    signatures: ['wiki_ingest·BAD_PATCH·BAD_PATCH:claims', 'wiki_ingest·ok·error'],
    events: [
      { round: 1, weight: 1, signature: 'wiki_ingest·BAD_PATCH·BAD_PATCH:claims' },
      { round: 1, weight: 0.2, signature: 'wiki_ingest·ok·error' },
    ],
    tools: [{ signature: 'wiki_ingest·ok·error', signatures: ['wiki_ingest·ok·error'], events: [] }],
  }
  mergeLegacySignatures(kept)
  assert.equal(kept.tools.wiki_ingest.gated, true)
  assert.equal(kept.card.signature, 'wiki_ingest·BAD_PATCH·BAD_PATCH:claims')
  assert.deepEqual(kept.card.signatures, ['wiki_ingest·BAD_PATCH·BAD_PATCH:claims'])
  assert.equal(kept.card.events.some((item) => item.signature === 'wiki_ingest·ok·error'), false)
  assert.equal(kept.tools.wiki_ingest.events.filter((item) => item.weight === 0.2).length, 1)
})

test('预计次数按本会话工作量计算，非法页码和不能下降的补丁会被拒绝', () => {
  assert.equal(projectedCalls(ledgerSpec, ledgerEntry, null).calls, 9)
  assert.equal(projectedCalls(ledgerSpec, ledgerEntry, 5).calls, 6)
  assert.equal(projectedCalls({ ...ledgerSpec, pageSize: 50 }, ledgerEntry, 5).calls, 2)
  assert.equal(projectedCalls({ ...ledgerSpec, engine: 'ledger_compact' }, ledgerEntry, 5).calls, 1)
  const state = freshState(1)
  for (let index = 0; index < 3; index += 1) {
    noteCall(state, { tool: 'ledger', ok: false, args: '1', workloadItems: 5, output: 'EPERM:open' })
  }
  assert.equal(propose(state, { tool: 'ledger', metric: 'failures', patch: { pageSize: 8 } }, ledgerEntry, ledgerSpec).code, 'METRIC_NOT_RETESTABLE')
  assert.equal(propose(state, { tool: 'ledger', metric: 'projected_calls', patch: { pageSize: 0 } }, ledgerEntry, ledgerSpec).code, 'BAD_PATCH')
  assert.equal(propose(state, { tool: 'ledger', metric: 'projected_calls', patch: { description: '隐藏' } }, ledgerEntry, ledgerSpec).code, 'BAD_PATCH')
  const ok = propose(state, { tool: 'ledger', metric: 'projected_calls', patch: { pageSize: 8, warmupError: false } }, ledgerEntry, ledgerSpec)
  assert.equal(ok.proposal.current, 6)
  assert.equal(ok.proposal.target, 1)
  assert.equal(ok.proposal.after.warmup, false)
})

test('审批卡使用插件统计，并写明预热是否还在', () => {
  const copy = approvalCopy({
    tool: 'ledger_lookup',
    patch: { pageSize: 50 },
    before: { calls: 6, items: 5, warmup: true },
    after: { calls: 2, items: 5, warmup: true },
  }, { failures: 1, retries: 1, partials: 3, score: 9 })
  assert.match(copy.zh, /失败 1 次/)
  assert.match(copy.zh, /最近一次要处理的 5 条/)
  assert.match(copy.zh, /现在预计调用 6 次/)
  assert.match(copy.zh, /改完后预计调用 2 次/)
  assert.match(copy.zh, /首次调用仍会失败/)
  assert.match(copy.en, /5 items/)
  assert.equal(copy.zh.includes('模型觉得'), false)
})

test('只有一次性允许且补丁一致才能应用，复查不下降就撤回', () => {
  const allowed = ['pageSize', 'warmupError']
  const proposal = { patch: { pageSize: 8, warmupError: false } }
  assert.equal(admit(proposal, { pageSize: 8 }, 'unavailable', allowed).code, 'NOT_APPROVED')
  assert.equal(admit(proposal, { pageSize: 8 }, 'allowed-once', allowed).code, 'PATCH_MISMATCH')
  assert.equal(admit(proposal, { warmupError: false, pageSize: 8 }, 'allowed-once', allowed).ok, true)
  assert.equal(retest(8, 8).code, 'REVERT')
  assert.equal(retest(8, 0).code, 'NO_MEASURE')
  assert.equal(retest(8, 1).ok, true)
  const state = freshState()
  state.tools.ledger = { gated: true, score: 9 }
  state.proposals.ledger = proposal
  clearGate(state, 'ledger')
  assert.equal(state.tools.ledger.gated, false)
  assert.equal(state.proposals.ledger, undefined)
})

test('两个会话的分数和工具定义互不影响', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'friction-'))
  withSession(dir, 'session-a', 8, ({ state, catalog }) => {
    noteCall(state, { tool: 'ledger', ok: false, args: '1' })
    catalog.tools.ledger = { pageSize: 8 }
  })
  const isolated = withSession(dir, 'session-b', 8, ({ state, catalog }) => ({
    failures: state.tools.ledger?.failures,
    pageSize: catalog.tools.ledger?.pageSize,
  }))
  assert.equal(isolated.failures, undefined)
  assert.equal(isolated.pageSize, undefined)
  const own = withSession(dir, 'session-a', 8, ({ state, catalog }) => ({
    failures: state.tools.ledger.failures,
    pageSize: catalog.tools.ledger.pageSize,
  }))
  assert.equal(own.failures, 1)
  assert.equal(own.pageSize, 8)
  rmSync(dir, { recursive: true, force: true })
})

test('正文里的非零退出码算失败，参数错误仍不计成失败', () => {
  assert.equal(failureOf({ isError: false, content: [{ text: 'log [exit code: 1]' }], value: { exitCode: 0 } }).ok, false)
  assert.equal(failureOf({ isError: false, content: [{ text: 'ok\n[exit code: 0]' }], value: { exitCode: 0 } }).ok, true)
  assert.equal(failureOf({ isError: false, value: { exitCode: 2 } }).ok, false)
  assert.equal(failureOf({ isError: true, error: { message: 'invalid arguments: missing required property "description"' } }).invalid, true)
  assert.equal(failureOf({ isError: true, error: { message: 'rg failed' }, content: [{ text: 'invalid arguments in file' }] }).ok, false)
  assert.equal(truncationOf({ value: { truncated: true } }), true)
  assert.equal(truncationOf({ content: [{ text: 'Found 1 of 9' }] }), false)
  assert.equal(truncationOf({ content: [{ text: 'Found 1 of 9 matches\n\nsrc/a.ts' }] }), true)
  assert.equal(truncationOf({ content: [{ text: 'src/a.ts\nLine 1: Found 1 of 9 matches' }] }), false)
})

test('新工具的 schema 能表达数组，不能表达的关键字整份拒绝', () => {
  const todos = {
    todos: {
      type: 'array',
      required: true,
      description: '任务列表',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          content: { type: 'string', required: true, description: '内容' },
        },
      },
    },
  }
  assert.equal(schemaError(todos), null)
  assert.equal(typeof schemaError({ page: { type: 'integer', minimum: 1, description: '页' } }), 'string')
})

test('过线后提出的是本插件的新工具，相同的一版不能再批', () => {
  const state = freshState(1)
  for (let index = 0; index < 3; index += 1) {
    noteCall(state, { tool: 'grep', ok: false, args: '{}', output: 'EPERM:open' })
  }
  const spec = {
    name: 'grep_src',
    problem: '结果被截断',
    usage: '只查 src',
    schema: { query: { type: 'string', required: true, description: '文本' } },
    run: { kind: 'delegate', tool: 'grep', overrides: { path: 'src' } },
  }
  const created = proposeOwned(state, { tool: 'grep', ...spec })
  assert.equal(created.ok, true)
  assert.equal(created.proposal.kind, 'create')
  assert.equal(created.proposal.replaces, 'grep')
  const again = reviseOwned(spec, spec)
  assert.equal(again.code, 'SAME_REVISION')
  const revised = reviseOwned(spec, { ...spec, usage: '只查 src/lib' })
  assert.equal(revised.ok, true)
  assert.equal(sameOwned(revised.proposal, spec), false)
  assert.deepEqual(applyAdaptation(spec.run, { query: 'TODO' }), { path: 'src', query: 'TODO' })
  const notes = renderNotes({
    grep_src: {
      ...spec,
      replaces: 'grep',
      schema: {
        tags: {
          type: 'array',
          description: '标签',
          items: { type: 'object', properties: { content: { type: 'string', required: true, description: '内容' } } },
        },
      },
    },
    grep_fast: { name: 'grep_fast', replaces: 'grep', problem: '慢', usage: '直接搜', schema: { query: { type: 'string', required: true, description: '文本' } }, run: { kind: 'script', command: 'rg {{query}} src' } },
  })
  assert.match(notes, /grep_src/)
  assert.match(notes, /内容/)
  assert.match(notes, /rg <query> src/)
  assert.match(notesDescription({ grep_src: spec }), /grep_src/)
  const copy = ownedCopy(created.proposal)
  assert.equal(copy.zh.includes('\n'), false)
  assert.match(copy.zh, /覆盖/)
  assert.match(copy.zh, /"src"/)
})

test('新工具名字带 fd 前缀和时间，覆盖值必须符合原工具字段', () => {
  const name = ownedName('grep', 1731840123456)
  assert.equal(name, 'fd_grep_1731840123456')
  assert.equal(gateSkipped('bash', 'bash'), true)
  assert.equal(gateSkipped('grep', 'bash'), false)
  const state = freshState(1)
  for (let index = 0; index < 3; index += 1) {
    noteCall(state, { tool: 'grep', ok: false, args: '{}', output: 'EPERM:open' })
  }
  const rejected = proposeOwned(state, {
    tool: 'grep',
    name: 'grep_src',
    problem: '范围太大',
    usage: '只查 src',
    schema: { query: { type: 'string', required: true, description: '文本' } },
    run: { kind: 'delegate', tool: 'grep', overrides: { path: 1 } },
    delegateSchema: { properties: { path: { type: 'string' }, query: { type: 'string' } } },
  })
  assert.equal(rejected.code, 'BAD_PATCH')
  assert.equal(rejected.key, 'path')
  const hidden = proposeOwned(state, {
    tool: 'grep',
    name: 'grep_src',
    problem: '范围太大',
    usage: '只查 src',
    schema: { query: { type: 'string', required: true, description: '文本' } },
    run: { kind: 'script', command: `rg {{query}} src && curl ${'x'.repeat(240)}` },
  })
  assert.equal(hidden.ok, true)
  assert.equal(ownedCopy(hidden.proposal).zh.includes('x'.repeat(240)), true)
})

test('JSON Schema 和命令字符串会被收成可安装的提案', () => {
  const state = freshState(8)
  state.tools.bash = { gated: true, successor: '' }
  const usage = '一次调用给出插件目录体检报告。'.padEnd(220, '。')
  const patch = normalizeOwnedPatch({
    name: 'plugin_check',
    problem: '检查本地插件要连开多次 bash。',
    usage,
    schema: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: '插件目录绝对路径' },
        probeUrl: { type: 'string', description: '可选探测地址' },
      },
      required: ['dir'],
      additionalProperties: false,
    },
    run: `node --check ${'x'.repeat(1800)}`,
  })
  assert.equal(patch.usage.length, 200)
  assert.equal(patch.schema.dir.required, true)
  assert.equal(patch.schema.probeUrl.required, undefined)
  assert.equal(schemaError(patch.schema), null)
  const created = proposeOwned(state, { id: 'p1', tool: 'bash', ...patch, name: 'plugin_check' })
  assert.equal(created.ok, true)
  assert.equal(created.proposal.name, 'plugin_check')
  assert.equal(created.proposal.run.kind, 'script')
  assert.equal(patchesMatch(created.proposal, { ...patch, description: '被忽略的可选说明', name: 'plugin_check' }), true)
  assert.equal(ownedPatchHint('schema').includes('properties'), true)
  const named = semanticOwnedName('plugin-check')
  assert.equal(named, 'plugin_check')
  const example = ownedPatchExample()
  assert.equal(example.usage.length <= 200, true)
  assert.equal(example.run.command.includes('${dir}'), true)
})

test('没过线直接造工具会被拒绝，用户确认后才记录提案', () => {
  const state = freshState(8)
  const spec = {
    name: 'plugin_check',
    problem: '想先有检查命令',
    usage: '检查插件目录',
    schema: { dir: { type: 'string', required: true, description: '目录' } },
    run: { kind: 'script', command: 'node --check ${dir}' },
  }
  const denied = proposeOwned(state, { id: 'p', tool: 'bash', ...spec, confirmed: 'true' })
  assert.equal(denied.code, 'BELOW_THRESHOLD')
  assert.equal(denied.confirm, 'required')
  assert.equal(state.proposals.bash, undefined)
  const fromPatch = proposeOwned(state, { id: 'p', tool: 'bash', ...spec })
  assert.equal(fromPatch.code, 'BELOW_THRESHOLD')
  const created = proposeOwned(state, { id: 'p', tool: 'bash', ...spec, confirmed: true })
  assert.equal(created.ok, true)
  assert.equal(created.proposal.voluntary, true)
  assert.equal(state.tools.bash, undefined)
  const again = proposeOwned(state, { id: 'p2', tool: 'bash', ...spec })
  assert.equal(again.ok, true)
  assert.equal(again.proposal, created.proposal)
  const catalog = {}
  const saved = installOwnedRecord(state, catalog, created.proposal)
  assert.equal(saved.ok, true)
  assert.equal(state.tools.bash, undefined)
  assert.equal(state.proposals.bash, undefined)
  assert.equal(catalog.owned.plugin_check.voluntary, true)
  assert.match(renderNotes(catalog.owned), /仍可调用/)
  assert.match(renderNotes(catalog.owned), /voluntary/)
  assert.match(ownedCopy(created.proposal).zh, /主动提案/)
  const card = belowThresholdCopy('bash', 'plugin_check', spec.problem)
  assert.equal(card.zh.includes('\n'), false)
  assert.match(card.zh, /还要再批一次/)
  const gatedState = freshState(8)
  gatedState.tools.bash = { gated: true, successor: '', score: 9 }
  const gated = proposeOwned(gatedState, { id: 'p2', tool: 'bash', ...spec })
  assert.equal(gated.proposal.voluntary, false)
  installOwnedRecord(gatedState, {}, gated.proposal)
  assert.equal(gatedState.tools.bash.successor, 'plugin_check')
  assert.equal(gatedState.tools.bash.gated, false)
  assert.equal(gatedState.tools.bash.score, 0)
  const idle = freshState(8)
  const earlyBlocked = propose(idle, {
    tool: 'ledger',
    metric: 'projected_calls',
    patch: { pageSize: 8, warmupError: false },
  }, ledgerEntry, ledgerSpec)
  assert.equal(earlyBlocked.code, 'BELOW_THRESHOLD')
  assert.equal(idle.proposals.ledger, undefined)
  const early = propose(idle, {
    tool: 'ledger',
    metric: 'projected_calls',
    patch: { pageSize: 8, warmupError: false },
    confirmed: true,
  }, ledgerEntry, ledgerSpec)
  assert.equal(early.ok, true)
  assert.equal(early.proposal.voluntary, true)
  assert.match(approvalCopy(early.proposal, undefined).zh, /主动提案/)
})

test('插值自带 shell 引号，模板再包一层也不会叠成字面引号', () => {
  const plain = fillTemplate('node --check ${dir}', { dir: '/tmp/plugin' })
  assert.equal(plain.command, "node --check '/tmp/plugin'")
  const doubled = fillTemplate('node --check "${dir}"', { dir: '/tmp/plugin' })
  assert.equal(doubled.command, "node --check '/tmp/plugin'")
  const singled = fillTemplate("node --check '${dir}'", { dir: '/tmp/plugin' })
  assert.equal(singled.command, "node --check '/tmp/plugin'")
  const mustache = fillTemplate('rg {{query}} src', { query: "a'b" })
  assert.equal(mustache.command, "rg 'a'\\''b' src")
  const partial = fillTemplate('echo "x ${dir}"', { dir: '/tmp/plugin' })
  assert.equal(partial.command, "echo \"x '/tmp/plugin'\"")
  const missing = fillTemplate('node --check ${dir}', {})
  assert.equal(missing.ok, false)
  assert.deepEqual(missing.missing, ['dir'])
  const schema = {
    dir: { type: 'string', required: true, description: '目录' },
    probeUrl: { type: 'string', description: '可选探测地址' },
  }
  const optional = optionalSlots(schema)
  assert.equal(optional.has('dir'), false)
  assert.equal(optional.has('probeUrl'), true)
  const skipped = fillTemplate('node check.js ${dir} ${probeUrl}', { dir: '/tmp/plugin' }, { optional })
  assert.equal(skipped.ok, true)
  assert.equal(skipped.command, "node check.js '/tmp/plugin' ''")
  const stillRequired = fillTemplate('node check.js ${dir} ${probeUrl}', {}, { optional })
  assert.equal(stillRequired.ok, false)
  assert.deepEqual(stillRequired.missing, ['dir'])
  const typo = unknownArguments(schema, { dir: '/tmp/plugin', probe_url: 'http://127.0.0.1' })
  assert.deepEqual(typo.unknown, ['probe_url'])
  assert.match(typo.text, /未知参数 probe_url/)
  assert.match(typo.text, /probeUrl/)
  assert.equal(unknownArguments(schema, { dir: '/tmp/plugin' }), null)
})

test('persist 为 true 的工具进入以后的会话，且不拦住原工具', () => {
  const spec = {
    name: 'plugin_check',
    problem: '想先有检查命令',
    usage: '检查插件目录',
    schema: { dir: { type: 'string', required: true, description: '目录' } },
    run: { kind: 'script', command: 'node --check ${dir}' },
    replaces: 'bash',
    voluntary: true,
    persist: true,
  }
  const kept = reviseOwned(spec, { ...spec, usage: '改一下用法' })
  assert.equal(kept.proposal.persist, true)
  const dropped = reviseOwned(spec, { ...spec, persist: false, usage: '只留在这一会话' })
  assert.equal(dropped.proposal.persist, false)
  assert.equal(patchesMatch(spec, { ...spec, persist: false }), false)
  const dir = mkdtempSync(path.join(tmpdir(), 'friction-persist-'))
  withShared(dir, (shared) => {
    shared.owned.plugin_check = persistedRecord(spec)
  })
  const imported = withSession(dir, 'next', 8, ({ state, catalog }) => {
    importPersisted(state, catalog, readShared(dir).owned)
    return {
      successor: state.tools.bash?.successor ?? '',
      persist: catalog.owned.plugin_check.persist,
      persisted: catalog.owned.plugin_check.persisted,
    }
  })
  assert.equal(imported.successor, '')
  assert.equal(imported.persist, true)
  assert.equal(imported.persisted, true)
  assert.match(renderNotes({ plugin_check: readShared(dir).owned.plugin_check }).toString(), /以后的会话/)
  withSession(dir, 'local', 8, ({ state, catalog }) => {
    catalog.owned = { plugin_check: { ...spec, persist: false, persisted: false, problem: '本地版本' } }
    importPersisted(state, catalog, readShared(dir).owned)
    assert.equal(catalog.owned.plugin_check.problem, '本地版本')
  })
  rmSync(dir, { recursive: true, force: true })
})

test('unknown tool 不计摩擦分，注册成功后清掉这种假过线', () => {
  const state = freshState(8)
  const missed = ingestCall(state, {
    tool: 'plugin_check_1',
    ok: false,
    output: 'Error: unknown tool "plugin_check_1"',
    outputChars: 40,
    elapsedMs: 1,
    args: {},
  })
  assert.equal(missed.skippedScore, true)
  assert.equal(state.tools.plugin_check_1.unmet, 1)
  assert.equal(state.tools.plugin_check_1.score ?? 0, 0)
  assert.equal(state.tools.plugin_check_1.gated ?? false, false)
  state.tools.plugin_check_1.calls = 2
  state.tools.plugin_check_1.failures = 2
  state.tools.plugin_check_1.score = 8
  state.tools.plugin_check_1.gated = true
  assert.equal(scrubUnknownToolGate(state, 'plugin_check_1'), true)
  assert.equal(state.tools.plugin_check_1.gated, false)
  assert.equal(state.tools.plugin_check_1.score, 0)
  const notes = renderNotes({
    plugin_check_1: {
      name: 'plugin_check_1',
      replaces: 'bash',
      problem: '检查',
      usage: '检查目录',
      schema: { dir: { type: 'string', required: true, description: '目录' } },
      run: { kind: 'script', command: 'node /dsh-friction-drive/tools/plugin-check.mjs ${dir}' },
    },
  })
  assert.match(notes, /<dir>/)
  assert.match(notes, /<plugin>/)
  assert.equal(notes.includes('${dir}'), false)
})

test('读取会话不创建目录', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'friction-read-'))
  const read = readSession(dir, 'missing', 8)
  assert.equal(read.state.threshold, 8)
  assert.equal(read.catalog.owned, undefined)
  assert.equal(existsSync(sessionDir(dir, 'missing')), false)
  rmSync(dir, { recursive: true, force: true })
})
test('并行更新不会丢分数，死进程留下的锁会被清掉', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'friction-lock-'))
  const stale = sessionDir(dir, 'same')
  withSession(dir, 'same', 100, () => {})
  writeFileSync(path.join(stale, '.lock'), '999999\n')
  const runs = Array.from({ length: 8 }, (_, index) => withSession(dir, 'same', 100, ({ state }) => {
    noteCall(state, { tool: 'ledger', ok: true, args: `{"n":${index}}` })
  }))
  assert.equal(runs.length, 8)
  const calls = withSession(dir, 'same', 100, ({ state }) => state.tools.ledger.calls)
  assert.equal(calls, 8)
  rmSync(dir, { recursive: true, force: true })
})

test('慢磨和跨时段失败不闸，分数会衰减', () => {
  const state = freshState()
  noteCall(state, { tool: 'read', ok: false, args: '{"path":"a"}', output: 'ENOENT', round: 0, at: 0 })
  for (let round = 1; round <= 3; round += 1) {
    noteCall(state, { tool: 'read', ok: true, args: `{"path":"ok-${round}"}`, round, at: round })
  }
  const mid = noteCall(state, { tool: 'read', ok: false, args: '{"path":"b"}', output: 'EACCES', round: 4, at: 4 })
  assert.equal(mid.gate, false)
  assert.equal(mid.level === 'L1', false)
  const midScore = mid.tool.score
  const later = noteCall(state, { tool: 'read', ok: true, args: '{"path":"c"}', round: 5, at: 5 })
  assert.equal(later.blocked, false)
  assert.ok(later.tool.score < midScore)
})

test('同一结构成功三次只建议沉淀，不关闸', () => {
  const state = freshState()
  let last
  for (let round = 1; round <= 3; round += 1) {
    last = noteCall(state, { tool: 'bash', ok: true, args: '{"command":"ls","check":true}', round })
  }
  assert.equal(last.gate, false)
  assert.equal(state.tools.bash.gated, false)
  const row = Object.values(state.repetition).find((item) => item.count >= 3)
  assert.ok(row)
  assert.match(last.suggestion, /沉淀/)
})

test('坏替换第一次失败就交还原工具，并且不加分', () => {
  const state = freshState()
  state.tools.bash = freshTool()
  state.tools.bash.successor = 'fd_bash_1'
  const result = noteCall(state, {
    tool: 'fd_bash_1',
    ok: false,
    output: 'cannot get required service "tools" in inactive context',
  })
  assert.equal(result.broken, true)
  assert.equal(result.restored, 'bash')
  assert.equal(state.tools.bash.successor, undefined)
  assert.equal(state.identity.fd_bash_1.broken, true)
  assert.equal(state.tools.bash.score, 0)
  const again = noteCall(state, { tool: 'bash', ok: true, args: '{"command":"ls"}' })
  assert.equal(again.blocked, false)
})

test('恢复会话只衰减分数，不新增退役行', () => {
  const state = freshState()
  state.tools.read = freshTool()
  state.tools.read.score = 9
  state.identity.read = { registered: true, persisted: false, voluntary: false, unmet: 0, retiredAt: null, broken: false }
  const before = { ...state.identity.read }
  const resumed = resumeSession(state, 10_000)
  assert.ok(state.tools.read.score < 9)
  assert.deepEqual(state.identity.read, before)
  assert.equal(resumed.retiredAdded, 0)
})

test('多个工具同时过线只发一张卡', () => {
  const state = freshState()
  for (const name of ['read', 'skill', 'bash']) {
    for (let index = 0; index < 3; index += 1) {
      noteCall(state, { tool: name, ok: false, args: '{"path":"a"}', output: 'EPERM:open', round: 1, at: 1 })
    }
  }
  assert.equal(state.cardsIssued, 1)
  assert.equal(state.card.tools.length, 3)
  assert.deepEqual(state.card.tools.map((item) => item.tool).sort(), ['bash', 'read', 'skill'])
  assert.equal(state.card.actions.length, 3)
  assert.ok(state.card.events.length >= 1)
})

test('用户取消不计分，暂停只对用户开放且会话结束恢复', () => {
  const state = freshState()
  const cancelled = noteCall(state, { tool: 'bash', ok: false, cancelled: true, output: 'no' })
  assert.equal(cancelled.points, 0)
  assert.equal(state.tools.bash.score ?? 0, 0)
  assert.match(state.notes.join('\n'), /用户取消/)
  assert.equal(pauseGates(state, '2026-11-26T03:00:00.000Z', 'agent').code, 'PAUSE_FORBIDDEN')
  assert.equal(pauseGates(state, '2026-11-26T03:00:00.000Z', 'user').ok, true)
  for (let index = 0; index < 3; index += 1) {
    const failed = noteCall(state, { tool: 'bash', ok: false, args: '{"command":"ls"}', output: 'EPERM:open', round: 1 })
    assert.equal(failed.gate, false)
  }
  assert.match(state.notes.join('\n'), /闸门已于 2026-11-26T03:00:00.000Z 由用户暂停/)
  const summary = closeSession(state)
  assert.equal(summary.restored, true)
  assert.equal(state.pause, null)
  assert.match(state.notes.join('\n'), /会话结束恢复/)
})

test('八小时后的旧失败掉到拦线以下', () => {
  const state = freshState()
  const start = Date.parse('2026-11-25T00:00:00.000Z')
  state.tools.bash = freshTool()
  state.tools.bash.events = Array.from({ length: 10 }, (_item, index) => ({
    weight: 1,
    round: 0,
    at: start,
    signature: `bash·E${index}·shape-${index}`,
  }))
  assert.ok(currentScore(state, 'bash', start) >= 10)
  const later = currentScore(state, 'bash', start + (8 * 60 * 60 * 1000))
  assert.ok(later < 10)
})

test('只剩计数的替换工具进退役区', () => {
  const state = freshState()
  state.tools.bash = freshTool()
  state.tools.bash.calls = 1
  state.tools.fd_bash_1795591267336 = freshTool()
  state.tools.fd_bash_1795591267336.calls = 1
  const view = partitionTools(state, new Set(['bash']))
  assert.equal(view.active.fd_bash_1795591267336, undefined)
  assert.ok(view.retired.fd_bash_1795591267336)
  assert.ok(view.active.bash)
})

test('unknown tool 记在身份上，不写进分数', () => {
  const state = freshState()
  ingestCall(state, { tool: 'plugin_check_1', ok: false, output: 'unknown tool plugin_check_1', outputChars: 20, elapsedMs: 1, args: {} })
  ingestCall(state, { tool: 'plugin_check_1', ok: false, output: 'UNKNOWN_TOOL', outputChars: 12, elapsedMs: 1, args: {} })
  assert.equal(state.identity.plugin_check_1.unmet, 2)
  assert.equal(state.tools.plugin_check_1.score ?? 0, 0)
  assert.equal(state.tools.plugin_check_1.gated ?? false, false)
})
