/**
 * 不调用模型。覆盖公式、会话隔离、死锁恢复和审批文案。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { admit, applyAdaptation, approvalCopy, clearGate, failureOf, freshState, gateSkipped, noteCall, normalizeOwnedPatch, notesDescription, ownedCopy, ownedName, ownedPatchExample, ownedPatchHint, patchesMatch, projectedCalls, propose, proposeOwned, renderNotes, retest, reviseOwned, sameOwned, semanticOwnedName, truncationOf } from './logic.js'
import { schemaError } from './schema.js'
import { readSession, sessionDir, withSession } from './store.js'

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

test('过线的这一次不拦截，下一次才拦截，且不连坐其他工具', () => {
  const state = freshState(4)
  const crossed = noteCall(state, { tool: 'ledger', ok: false, args: '1', truncated: true })
  assert.equal(crossed.blocked, false)
  assert.equal(crossed.gate, true)
  const other = noteCall(state, { tool: 'fx', ok: true, args: '1' })
  assert.equal(other.blocked, false)
  const next = noteCall(state, { tool: 'ledger', ok: true, args: '2' })
  assert.equal(next.blocked, true)
})

test('预计次数按本会话工作量计算，非法页码和不能下降的补丁会被拒绝', () => {
  assert.equal(projectedCalls(ledgerSpec, ledgerEntry, null).calls, 9)
  assert.equal(projectedCalls(ledgerSpec, ledgerEntry, 5).calls, 6)
  assert.equal(projectedCalls({ ...ledgerSpec, pageSize: 50 }, ledgerEntry, 5).calls, 2)
  assert.equal(projectedCalls({ ...ledgerSpec, engine: 'ledger_compact' }, ledgerEntry, 5).calls, 1)
  const state = freshState(1)
  noteCall(state, { tool: 'ledger', ok: false, args: '1', workloadItems: 5 })
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
  noteCall(state, { tool: 'grep', ok: false, args: '{}' })
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
  assert.match(notes, /rg \{\{query\}\} src/)
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
  noteCall(state, { tool: 'grep', ok: false, args: '{}' })
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
    noteCall(state, { tool: 'ledger', ok: false, args: String(index) })
  }))
  assert.equal(runs.length, 8)
  const failures = withSession(dir, 'same', 100, ({ state }) => state.tools.ledger.failures)
  assert.equal(failures, 8)
  rmSync(dir, { recursive: true, force: true })
})
