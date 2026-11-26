/**
 * 经验编译的负例。不启动桌面端，不读取密钥。
 */
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { freshState, noteCall, OWNED_NAME } from './logic.js'
import {
  allocateCompiledName,
  assessCompiledProposal,
  CARD_LIMIT,
  contractFor,
  executeCompiled,
  ingestCall,
  interceptMatches,
  matureFragments,
  structuralKey,
  traceFrom,
} from './compiler.js'

const here = path.dirname(fileURLToPath(import.meta.url))

function call(tool, args, extra = {}) {
  return {
    tool,
    args,
    output: extra.output ?? 'ok',
    exitCode: Object.prototype.hasOwnProperty.call(extra, 'exitCode') ? extra.exitCode : 0,
    ok: extra.ok !== false,
    truncated: extra.truncated === true,
    invalid: extra.invalid === true,
    own: extra.own === true,
    registered: extra.registered === true,
    bypass: extra.bypass === true,
    parallel: extra.parallel === true,
    fileHash: extra.fileHash ?? null,
  }
}

function twice(steps) {
  return traceFrom([...steps, ...steps])
}

test('正文退出码失败和截断都不成熟，也不能跨过这些断点', () => {
  const body = traceFrom([
    call('bash', { command: 'ls /tmp' }, { output: 'no\n[exit code: 1]', ok: true, exitCode: null }),
    call('bash', { command: 'ls /tmp' }, { output: 'no\n[exit code: 1]', ok: true, exitCode: null }),
  ])
  assert.equal(matureFragments(body).length, 0)
  const clipped = traceFrom([
    call('grep', { query: 'a', path: 'src' }, { output: 'Found 1 of 9 matches\nsrc/a.ts', truncated: true }),
    call('grep', { query: 'a', path: 'src' }, { output: 'Found 1 of 9 matches\nsrc/a.ts', truncated: true }),
  ])
  assert.equal(matureFragments(clipped).length, 0)
  const broken = traceFrom([
    call('bash', { command: 'ls /tmp' }),
    call('bash', { command: 'pwd' }, { output: 'x\n[exit code: 2]', ok: true, exitCode: null }),
    call('bash', { command: 'ls /tmp' }),
  ])
  assert.equal(matureFragments(broken).length, 0)
  const invalid = traceFrom([
    call('bash', { command: 'ls /tmp' }, { invalid: true, ok: true }),
    call('bash', { command: 'pwd' }),
    call('bash', { command: 'ls /tmp' }, { invalid: true, ok: true }),
    call('bash', { command: 'pwd' }),
  ])
  assert.equal(matureFragments(invalid).length, 0)
})

test('只保留互不重叠的最长片段，接缝和子串不入库', () => {
  const steps = [
    call('read', { path: 'a.txt' }),
    call('grep', { query: 'x', path: 'src' }),
    call('bash', { command: 'pwd' }),
  ]
  const found = matureFragments(twice(steps))
  assert.equal(found.length, 1)
  assert.deepEqual(found[0].tools, ['read', 'grep', 'bash'])
  const plugin = traceFrom([
    call('bash', { command: 'ls /tmp' }),
    call('friction_status', {}, { own: true, output: '{}' }),
    call('bash', { command: 'pwd' }),
    call('bash', { command: 'ls /tmp' }),
    call('friction_status', {}, { own: true, output: '{}' }),
    call('bash', { command: 'pwd' }),
  ])
  assert.equal(matureFragments(plugin).length, 0)
})

test('常量值不同不得复用，全槽位原样调用不入库', () => {
  const left = twice([
    call('bash', { command: 'ls /tmp' }),
    call('bash', { command: 'pwd' }),
  ])
  const right = twice([
    call('bash', { command: 'ls /var' }),
    call('bash', { command: 'whoami' }),
  ])
  const ls = matureFragments(left)[0]
  const other = matureFragments(right)[0]
  assert.ok(ls)
  assert.ok(other)
  assert.notEqual(structuralKey(ls), structuralKey(other))
  const mixed = traceFrom([
    ...left,
    ...right,
  ])
  const both = matureFragments(mixed)
  const keys = new Set(both.map(structuralKey))
  assert.equal(keys.has(structuralKey(ls)), true)
  assert.equal(keys.has(structuralKey(other)), true)
  const slotted = traceFrom([
    call('grep', { query: 'alpha' }),
    call('grep', { query: 'one' }),
    call('grep', { query: 'beta' }),
    call('grep', { query: 'two' }),
  ])
  assert.equal(matureFragments(slotted).length, 0)
  const contract = contractFor(other)
  const assessed = assessCompiledProposal({
    trace: right,
    contract,
    ecName: 'ec_bash_1',
    assetId: 'asset-ls',
    assets: {
      'asset-ls': {
        id: 'asset-ls',
        enabled: true,
        structuralKey: structuralKey(ls),
        operations: contractFor(ls).operations,
      },
    },
  })
  assert.equal(assessed.ok, false)
  assert.equal(assessed.code, 'ASSET_UNEXPECTED')
})

test('多个候选必须带 asset_id，停用的旧版不参与匹配', () => {
  const trace = twice([
    call('bash', { command: 'ls /tmp' }),
    call('bash', { command: 'pwd' }),
  ])
  const fragment = matureFragments(trace)[0]
  const contract = contractFor(fragment)
  const key = structuralKey(fragment)
  const operations = contract.operations
  const assets = {
    one: { id: 'one', enabled: true, structuralKey: key, operations, constants: [], pre: [], post: [] },
    two: { id: 'two', enabled: true, structuralKey: key, operations, constants: [], pre: [], post: [] },
    old: { id: 'old', enabled: false, structuralKey: key, operations, constants: [], pre: [], post: [] },
  }
  const missing = assessCompiledProposal({ trace, contract, ecName: 'ec_bash_1', assets })
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'ASSET_AMBIGUOUS')
  assert.deepEqual(missing.candidates.map((item) => item.asset_id).sort(), ['one', 'two'])
  const named = assessCompiledProposal({ trace, contract, ecName: 'ec_bash_1', assetId: 'two', assets })
  assert.equal(named.ok, true)
  assert.equal(named.code, 'SAME_REVISION')
  assert.equal(named.assetId, 'two')
  const outsider = assessCompiledProposal({ trace, contract, ecName: 'ec_bash_1', assetId: 'old', assets })
  assert.equal(outsider.ok, false)
  assert.equal(outsider.code, 'ASSET_UNKNOWN')
  const onlyOld = assessCompiledProposal({
    trace,
    contract,
    ecName: 'ec_bash_1',
    assets: { old: assets.old },
  })
  assert.equal(onlyOld.ok, true)
  assert.equal(onlyOld.code, 'READY')
})

test('审批前的校验不执行工具，后置恒真、非 bash 脚本和缺边都会拒绝', async () => {
  let invoked = 0
  const trace = twice([
    call('bash', { command: 'echo hello' }, { output: 'hello' }),
    call('grep', { query: 'hello', path: 'src' }, { output: 'src/a.ts' }),
  ])
  const fragment = matureFragments(trace)[0]
  assert.ok(fragment.requiredEdges.some((edge) => edge.path === 'query'))
  const contract = contractFor(fragment)
  const ready = assessCompiledProposal({
    trace,
    contract,
    ecName: 'ec_bash_1',
    schemas: { grep: () => null },
  })
  assert.equal(ready.ok, true)
  assert.equal(invoked, 0)
  const tautology = structuredClone(contract)
  tautology.operations[0].post = {}
  const rejected = assessCompiledProposal({ trace, contract: tautology, ecName: 'ec_bash_1', schemas: { grep: () => null } })
  assert.equal(rejected.code, 'STEP_MUST_BE_AGENT')
  const script = structuredClone(contract)
  script.operations[1].run = { kind: 'script', command: 'rg hello src' }
  const notBash = assessCompiledProposal({ trace, contract: script, ecName: 'ec_bash_1', schemas: { grep: () => null } })
  assert.equal(notBash.code, 'STEP_MUST_BE_AGENT')
  assert.equal(notBash.reason, 'script-not-bash')
  const noEdge = structuredClone(contract)
  noEdge.edges = []
  const missingEdge = assessCompiledProposal({ trace, contract: noEdge, ecName: 'ec_bash_1', schemas: { grep: () => null } })
  assert.equal(missingEdge.code, 'EDGE_REQUIRED')
  const swapped = structuredClone(contract)
  swapped.operations[0].run = { kind: 'script', command: 'echo other' }
  const mismatch = assessCompiledProposal({ trace, contract: swapped, ecName: 'ec_bash_1', schemas: { grep: () => null } })
  assert.equal(mismatch.code, 'STEP_MUST_BE_AGENT')
  const huge = structuredClone(contract)
  huge.operations[0].run = { kind: 'script', command: 'echo hello' }
  const long = 'x'.repeat(CARD_LIMIT)
  huge.operations[0].note = long
  const card = assessCompiledProposal({
    trace,
    contract: { ...huge, operations: huge.operations.map((operation, index) => index === 0 ? { ...operation, run: { kind: 'script', command: `echo ${long}` } } : operation) },
    ecName: 'ec_bash_1',
    schemas: { grep: () => null },
  })
  assert.notEqual(card.code, 'READY')
})

test('工具名符合现有规则，同一毫秒用序号区分', () => {
  const now = 1731840123456
  const first = allocateCompiledName('grep', now, new Set())
  const second = allocateCompiledName('grep', now, new Set([first]))
  assert.equal(first, 'ec_grep_1731840123456')
  assert.equal(OWNED_NAME.test(first), true)
  assert.equal(OWNED_NAME.test(second), true)
  assert.notEqual(first, second)
  assert.equal(first.length <= 41, true)
})

test('含中间模型步时第二次调用才执行后一步，缺槽位失败', async () => {
  const trace = twice([
    call('bash', { command: 'echo one' }, { output: 'one' }),
    call('read', { path: 'a.txt' }, { output: 'body' }),
    call('bash', { command: 'echo two' }, { output: 'two' }),
  ])
  const fragment = matureFragments(trace)[0]
  const contract = contractFor(fragment, { 1: 'agent' })
  const spec = { operations: contract.operations, steps: fragment.steps, edges: contract.edges, contract }
  const seen = []
  const first = await executeCompiled(spec, { slots: {} }, async (call) => {
    seen.push(call.arguments.command)
    return { output: 'one', exitCode: 0, failed: false }
  })
  assert.equal(first.stopped, true)
  assert.deepEqual(seen, ['echo one'])
  assert.ok(first.resumeToken)
  assert.ok(first.remaining.includes('s2'))
  const second = await executeCompiled(spec, {
    resume: true,
    cursor: first.cursor,
    outputs: first.outputs,
    storedSlots: first.slots,
    stepOutput: 'body',
    slots: {},
  }, async (call) => {
    seen.push(call.arguments.command)
    return { output: 'two', exitCode: 0, failed: false }
  })
  assert.equal(second.ok, true)
  assert.deepEqual(seen, ['echo one', 'echo two'])
  const slotFragment = matureFragments(traceFrom([
    call('bash', { command: 'rg alpha src' }),
    call('bash', { command: 'echo done' }),
    call('bash', { command: 'rg beta src' }),
    call('bash', { command: 'echo done' }),
  ])).find((fragment) => fragment.steps.some((step) => step.slots.length > 0))
  assert.ok(slotFragment)
  const slotContract = contractFor(slotFragment)
  const missing = await executeCompiled({
    operations: slotContract.operations,
    steps: slotFragment.steps,
    edges: slotContract.edges,
  }, { slots: {} }, async () => ({ output: '', exitCode: 0 }))
  assert.equal(missing.failed, true)
  assert.equal(missing.code, 'MISSING_SLOT')
  assert.equal(JSON.stringify(missing).includes('invalid arguments'), false)
  const slotName = slotFragment.steps.flatMap((step) => step.slots).find((slot) => slot.fragment)?.name
  const quoted = []
  const filled = await executeCompiled({
    operations: slotContract.operations,
    steps: slotFragment.steps,
    edges: slotContract.edges,
  }, { slots: { [slotName]: 'beta' } }, async (call) => {
    quoted.push(call.arguments.command)
    return { output: 'ok', exitCode: 0, failed: false }
  })
  assert.equal(filled.ok, true)
  assert.match(quoted[0], /'beta'/)
})

test('同一成功参数连续五次不加摩擦分，也不因此过线', () => {
  const state = freshState(8)
  for (let index = 0; index < 5; index += 1) {
    const scored = noteCall(state, { tool: 'bash', ok: true, args: '{"command":"ls"}', outputChars: 20, elapsedMs: 10 })
    assert.equal(scored.points, 0)
    assert.equal(scored.gate, false)
  }
  assert.equal(state.tools.bash.score, 0)
  assert.equal(state.tools.bash.gated, false)
  const traced = { trace: [] }
  for (let index = 0; index < 5; index += 1) {
    ingestCall(traced, { tool: 'bash', args: { command: 'ls' }, output: 'ok', exitCode: 0, ok: true, scoreArgs: '{"command":"ls"}' })
  }
  assert.equal(traced.tools.bash.score, 0)
  assert.equal(traced.tools.bash.gated, false)
})

test('拦截只打中第一步常量，旁路不匹配', () => {
  const fragment = matureFragments(twice([
    call('bash', { command: 'ls /tmp' }),
    call('bash', { command: 'pwd' }),
  ]))[0]
  const intercept = { ecName: 'ec_bash_1', firstTool: 'bash', step: fragment.steps[0] }
  assert.equal(interceptMatches(intercept, 'bash', { command: 'ls /tmp' }), true)
  assert.equal(interceptMatches(intercept, 'bash', { command: 'pwd' }), false)
  assert.equal(interceptMatches(intercept, 'bash', { command: 'ls /var' }), false)
  assert.equal(interceptMatches(intercept, 'read', { command: 'ls /tmp' }), false)
})

test('单步失败不需要抬高摩擦分，修订不能改其他步', async () => {
  const trace = twice([
    call('bash', { command: 'echo one' }),
    call('bash', { command: 'echo two' }),
  ])
  const fragment = matureFragments(trace)[0]
  const contract = contractFor(fragment)
  const spec = {
    ecName: 'ec_bash_1',
    assetId: 'asset-1',
    name: 'ec_bash_1',
    tools: fragment.tools,
    steps: fragment.steps,
    bindings: fragment.bindings,
    operations: contract.operations,
    contract,
    edges: contract.edges,
  }
  const failed = await executeCompiled(spec, { slots: {} }, async (call) => {
    if (String(call.arguments.command).includes('two')) return { output: 'no\n[exit code: 1]', exitCode: 1, failed: true }
    return { output: 'one', exitCode: 0, failed: false }
  })
  assert.equal(failed.failed, true)
  assert.equal(failed.step, 's1')
  assert.deepEqual(failed.completed, ['s0'])
  const changed = structuredClone(contract)
  changed.revise_step = 's1'
  changed.operations[0].run = { kind: 'script', command: 'echo changed' }
  const locked = assessCompiledProposal({
    trace,
    contract: changed,
    reviseStep: 's1',
    existing: { ...spec, operations: spec.operations.map((operation, index) => index === 1 ? { ...operation, mode: 'agent', failedStep: true } : operation) },
  })
  assert.equal(locked.code, 'STEP_LOCKED')
  const fixed = structuredClone(contract)
  fixed.revise_step = 's1'
  const revised = assessCompiledProposal({
    trace,
    contract: fixed,
    reviseStep: 's1',
    assetId: 'asset-1',
    existing: {
      ...spec,
      assetId: 'asset-1',
      edges: contract.edges,
      operations: spec.operations.map((operation, index) => index === 1 ? { ...operation, mode: 'agent', failedStep: true } : operation),
    },
  })
  assert.equal(revised.ok, false)
  assert.equal(revised.code, 'NOT_REVISED')
})

test('失败步可以换一份钉住正文的脚本，旧脚本再交一次不是修订', () => {
  const trace = twice([
    call('bash', { command: 'echo one' }, { output: 'one' }),
    call('bash', { command: 'echo two' }, { output: 'ok' }),
  ])
  const fragment = matureFragments(trace)[0]
  const contract = contractFor(fragment)
  const existing = {
    ecName: 'ec_bash_1',
    assetId: 'asset-1',
    name: 'ec_bash_1',
    tools: fragment.tools,
    steps: fragment.steps,
    bindings: fragment.bindings,
    edges: contract.edges,
    contract,
    operations: contract.operations.map((operation, index) => index === 1 ? { ...operation, mode: 'agent', failedStep: true } : operation),
  }
  const same = structuredClone(contract)
  same.revise_step = 's1'
  const again = assessCompiledProposal({ trace, contract: same, reviseStep: 's1', assetId: 'asset-1', existing })
  assert.equal(again.code, 'NOT_REVISED')
  const changed = structuredClone(contract)
  changed.revise_step = 's1'
  changed.operations[1].run = { kind: 'script', command: 'echo fixed' }
  changed.operations[1].post = { exitCode: 0 }
  const weak = assessCompiledProposal({ trace, contract: changed, reviseStep: 's1', assetId: 'asset-1', existing })
  assert.equal(weak.code, 'STEP_MUST_BE_AGENT')
  changed.operations[1].post = { exitCode: 0, outputIncludes: 'ok' }
  const accepted = assessCompiledProposal({ trace, contract: changed, reviseStep: 's1', assetId: 'asset-1', existing })
  assert.equal(accepted.ok, true)
  assert.equal(accepted.code, 'REVISE')
  assert.equal(accepted.operations[1].run.command, 'echo fixed')
})

test('write 不得成为 program，执行器也不按新槽位调用原工具', async () => {
  const trace = twice([
    call('write', { path: 'a.txt', contents: 'one' }, { output: 'ok' }),
    call('write', { path: 'a.txt', contents: 'two' }, { output: 'ok' }),
  ])
  const fragment = matureFragments(trace)[0]
  assert.ok(fragment)
  const contract = contractFor(fragment)
  assert.equal(contract.operations.every((operation) => operation.mode === 'agent'), true)
  const forced = structuredClone(contract)
  forced.operations = fragment.steps.map((step, index) => {
    const overrides = {}
    for (const constant of step.constants) {
      if (!constant.template) overrides[constant.path] = constant.value
    }
    return {
      ...forced.operations[index],
      mode: 'program',
      post: { exitCode: 0 },
      pre: index === 0 ? { argsEquals: { path: '/not/observed' } } : {},
      run: { kind: 'delegate', tool: 'write', overrides },
    }
  })
  const assessed = assessCompiledProposal({
    trace,
    contract: forced,
    ecName: 'ec_write_1',
    schemas: { write: () => null },
  })
  assert.equal(assessed.ok, false)
  assert.equal(assessed.code, 'STEP_MUST_BE_AGENT')
  assert.equal(assessed.reason, 'not-readonly')
  const seen = []
  const ran = await executeCompiled({
    operations: forced.operations,
    steps: fragment.steps,
    edges: forced.edges,
  }, { slots: { contents: 'other' } }, async (call) => {
    seen.push(call)
    return { output: 'ok', exitCode: 0 }
  })
  assert.equal(ran.code, 'NOT_PROGRAM')
  assert.equal(seen.length, 0)
})

test('resume 的输出对不上后置时不执行后续命令', async () => {
  const trace = twice([
    call('bash', { command: 'echo one' }, { output: 'one' }),
    call('bash', { command: 'echo two' }, { output: 'two' }),
    call('bash', { command: 'echo three' }, { output: 'three' }),
  ])
  const fragment = matureFragments(trace)[0]
  const contract = contractFor(fragment)
  const operations = contract.operations.map((operation, index) => (
    index === 1 ? { ...operation, mode: 'agent', post: { exitCode: 0 } } : operation
  ))
  const seen = []
  const resumed = await executeCompiled({
    operations,
    steps: fragment.steps,
    edges: contract.edges,
  }, {
    resume: true,
    cursor: 1,
    stepOutput: 'not-the-observed-output',
    slots: {},
  }, async (call) => {
    seen.push(call.arguments.command)
    return { output: 'three', exitCode: 0 }
  })
  assert.equal(resumed.ok, false)
  assert.equal(resumed.code, 'POST_FAILED')
  assert.deepEqual(seen, [])
})

test('两次正文不同不得只因退出码 0 成为 program', () => {
  const trace = traceFrom([
    call('bash', { command: 'echo same' }, { output: 'alpha' }),
    call('bash', { command: 'echo done' }, { output: 'done' }),
    call('bash', { command: 'echo same' }, { output: 'beta' }),
    call('bash', { command: 'echo done' }, { output: 'done' }),
  ])
  const fragment = matureFragments(trace).find((item) => item.tools.length === 2)
  assert.ok(fragment)
  const contract = contractFor(fragment)
  assert.equal(contract.operations[0].mode, 'agent')
  const forced = structuredClone(contract)
  forced.operations[0] = {
    ...forced.operations[0],
    mode: 'program',
    post: { exitCode: 0 },
    run: { kind: 'script', command: 'echo same' },
  }
  const assessed = assessCompiledProposal({ trace, contract: forced, ecName: 'ec_bash_1' })
  assert.equal(assessed.code, 'STEP_MUST_BE_AGENT')
})

test('无关 bash 不得粘成一个程序', () => {
  const trace = traceFrom([
    call('bash', { command: 'ls /tmp' }),
    call('bash', { command: 'pwd' }),
    call('bash', { command: 'ls /tmp' }),
    call('bash', { command: 'pwd' }),
    call('bash', { command: 'ls /var' }),
    call('bash', { command: 'whoami' }),
    call('bash', { command: 'date' }),
    call('bash', { command: 'ls /var' }),
    call('bash', { command: 'whoami' }),
    call('bash', { command: 'date' }),
  ])
  const found = matureFragments(trace)
  assert.equal(found.some((fragment) => fragment.tools.length >= 5), false)
  const templates = (fragment) => fragment.steps.map((step) => step.commandTemplate).join('\n')
  assert.equal(found.some((fragment) => templates(fragment).includes('ls /tmp') && templates(fragment).includes('whoami')), false)
  assert.equal(found.some((fragment) => templates(fragment).startsWith('pwd\n')), false)
  assert.ok(found.some((fragment) => templates(fragment) === 'ls /tmp\npwd'))
  assert.ok(found.some((fragment) => templates(fragment) === 'ls /var\nwhoami\ndate'))
})

test('没有常量的第一步不得拦截所有 bash', () => {
  const intercept = {
    ecName: 'ec_bash_1',
    firstTool: 'bash',
    step: {
      constants: [],
      slots: [{ path: 'command', type: 'string', name: 'p0_command', fragment: false }],
      commandTemplate: '{{p0_command}}',
    },
  }
  assert.equal(interceptMatches(intercept, 'bash', { command: 'pwd' }), false)
  assert.equal(interceptMatches(intercept, 'bash', { command: 'ls /tmp' }), false)
  assert.equal(interceptMatches(intercept, 'bash', { command: 'whoami' }), false)
})

test('上一步包装正文不得改写已批准的 bash', async () => {
  const spec = {
    operations: [
      { id: 's0', tool: 'bash', mode: 'program', run: { kind: 'script', command: 'echo hello' }, post: { exitCode: 0 } },
      { id: 's1', tool: 'bash', mode: 'program', run: { kind: 'script', command: 'cat hello.txt' }, post: { exitCode: 0 } },
    ],
    steps: [
      { tool: 'bash', constants: [{ path: 'command', value: 'echo hello', template: false }], slots: [], commandTemplate: 'echo hello' },
      { tool: 'bash', constants: [{ path: 'command', value: 'cat hello.txt', template: false }], slots: [], commandTemplate: 'cat hello.txt' },
    ],
    edges: [{ from: 's0', to: 's1', path: 'command', sample: 'hello' }],
  }
  const wrapped = []
  await executeCompiled(spec, { slots: {} }, async (call) => {
    wrapped.push(call.arguments.command)
    return { text: 'hello\n[exit code: 0]', exitCode: 0, failed: false }
  })
  assert.equal(wrapped[1], 'cat hello.txt')
  const quoted = []
  await executeCompiled(spec, { slots: {} }, async (call) => {
    quoted.push(call.arguments.command)
    if (quoted.length === 1) return { output: "hello'BREAK", exitCode: 0, failed: false }
    return { output: 'file', exitCode: 0, failed: false }
  })
  assert.notEqual(quoted[1], "cat hello'BREAK.txt")
  assert.match(quoted[1], /'\\''/)
})

test('正文非零退出码记摩擦失败，随后的成功同参不加 retry', () => {
  const state = { trace: [] }
  const failed = ingestCall(state, {
    tool: 'bash',
    args: { command: 'ls /tmp' },
    output: 'no\n[exit code: 1]',
    exitCode: 0,
    ok: true,
    scoreArgs: '{"command":"ls /tmp"}',
  })
  assert.equal(failed.record.failed, true)
  assert.equal(state.tools.bash.lastOk, false)
  assert.equal(state.tools.bash.failures, 1)
  assert.equal(state.tools.bash.score, 1)
  const again = ingestCall(state, {
    tool: 'bash',
    args: { command: 'ls /tmp' },
    output: 'tmp',
    exitCode: 0,
    ok: true,
    scoreArgs: '{"command":"ls /tmp"}',
  })
  assert.equal(again.points, 0)
  assert.equal((again.reasons ?? []).includes('retry'), false)
  assert.equal(state.tools.bash.score, 1)
  assert.equal(state.tools.bash.lastOk, true)
})

test('前置声称的参数必须在两次绑定里出现', () => {
  const trace = twice([
    call('bash', { command: 'ls /tmp' }, { output: 'tmp' }),
    call('grep', { query: 'tmp', path: 'src' }, { output: 'src/a.ts' }),
  ])
  const fragment = matureFragments(trace)[0]
  const contract = contractFor(fragment)
  contract.operations[1].pre = { argsEquals: { path: '/not/observed' } }
  const assessed = assessCompiledProposal({
    trace,
    contract,
    ecName: 'ec_bash_1',
    schemas: { grep: () => null },
  })
  assert.equal(assessed.code, 'STEP_MUST_BE_AGENT')
  assert.equal(assessed.reason, 'pre-unobserved')
})

test('插件会话：审批前不执行，拦截不误伤，另一会话看不到 ec_', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'ec-session-'))
  process.env.DSH_HOME = home
  const { Context, Service } = await import('@deepseek-ai/cordis')
  const drive = await import('./index.js')
  const demo = await import('../dsh-friction-demo/index.js')
  let approvalMode = 'unavailable'
  let card = ''
  let executions = 0
  let failSecond = false
  let failRegister = false

  class ToolsStub extends Service {
    constructor(ctx) {
      super(ctx, 'tools')
      this.ctx = ctx
      this.items = new Map()
      this.whens = new Map()
      this.calls = []
    }

    get(name) {
      return undefined
    }

    register(tool, options) {
      if (failRegister && String(tool.name).startsWith('ec_')) throw new Error('挂不上')
      this.items.set(tool.name, tool)
      if (options?.when) this.whens.set(tool.name, options.when)
      return () => {
        this.items.delete(tool.name)
        this.whens.delete(tool.name)
      }
    }

    async execute(input) {
      executions += input.calls.length
      const results = []
      for (const call of input.calls) {
        const args = JSON.parse(call.arguments)
        const exec = { name: call.name, arguments: args, callId: call.id, agent: input.agent }
        const decision = await this.ctx.waterfall('tools/pre-execute', exec, () => ({ kind: 'allow' }))
        if (decision?.kind === 'deny') {
          results.push({ result: { isError: true, error: { message: decision.reason }, content: [{ type: 'text', text: decision.reason }] } })
          continue
        }
        const command = String(args.command ?? '')
        const failed = failSecond && command.includes('echo two')
        const text = failed ? 'no\n[exit code: 1]' : 'ok'
        const result = { isError: false, content: [{ type: 'text', text }], value: { exitCode: failed ? 1 : 0, failed } }
        await this.ctx.waterfall('tools/post-execute', exec, result, () => ({ kind: 'accept' }))
        this.calls.push(command)
        results.push({ result })
      }
      return { results }
    }
  }

  class SkillsStub extends Service {
    constructor(ctx) {
      super(ctx, 'skills')
    }

    register() {
      return () => {}
    }
  }

  class ApprovalStub extends Service {
    constructor(ctx) {
      super(ctx, 'approval')
    }

    request(req) {
      card = req.displayReason?.zh ?? req.reason ?? ''
      if (card.includes('不是放行这一次调用')) assert.equal(executions, 0)
      return approvalMode
    }
  }

  const ctx = new Context()
  await ctx.plugin(ToolsStub)
  await ctx.plugin(SkillsStub)
  await ctx.plugin(ApprovalStub)
  await ctx.plugin(drive)
  await ctx.plugin(demo)
  const sessionA = 'sess-a'
  const sessionB = 'sess-b'
  const agent = { session: { id: sessionA }, ctx }
  const exec = { agent, callId: 'user-1' }
  let serial = 0
  async function record(tool, args, output = 'ok') {
    serial += 1
    await ctx.waterfall('tools/post-execute', {
      name: tool,
      arguments: args,
      callId: `rec-${serial}`,
      agent,
    }, {
      isError: false,
      content: [{ type: 'text', text: output }],
      value: { exitCode: 0, failed: false },
    }, () => ({ kind: 'accept' }))
  }
  async function guard(tool, args) {
    return ctx.waterfall('tools/pre-execute', {
      name: tool,
      arguments: args,
      callId: `pre-${serial += 1}`,
      agent,
    }, () => ({ kind: 'allow' }))
  }

  const fx = ctx.tools.items.get('fx_convert')
  for (let index = 0; index < 5; index += 1) {
    const body = JSON.parse(await fx.execute({ amount: 1, unit: '元' }, { ...exec, callId: `fx-${index}` }))
    assert.equal(body.yuan, 1)
    assert.equal(body.code, undefined)
  }
  const fxGate = await guard('fx_convert', { amount: 1, unit: '元' })
  assert.equal(fxGate.kind, 'allow')
  let status = JSON.parse(await ctx.tools.items.get('friction_status').execute({}, exec))
  assert.equal(status.tools.fx_convert.score, 0)
  assert.equal(status.tools.fx_convert.gated, false)
  assert.equal(status.compilable.some((item) => item.tools.includes('fx_convert')), false)

  for (let round = 0; round < 2; round += 1) {
    await record('bash', { command: 'ls /tmp' }, 'tmp')
    await ctx.waterfall('tools/post-execute', {
      name: 'fx_convert',
      arguments: { amount: 1 },
      callId: `fx-invalid-${round}`,
      agent,
    }, {
      isError: true,
      error: { message: 'invalid arguments: missing unit' },
      content: [{ type: 'text', text: 'invalid arguments: missing unit' }],
    }, () => ({ kind: 'accept' }))
    await record('bash', { command: 'pwd' }, 'here')
  }
  status = JSON.parse(await ctx.tools.items.get('friction_status').execute({}, exec))
  assert.equal(status.tools.fx_convert.score, 0)
  assert.equal(status.compilable.some((item) => item.tools.every((tool) => tool === 'bash') && item.constants.some((constant) => constant.value === 'ls /tmp') && item.constants.some((constant) => constant.value === 'pwd')), false)
  const rejectedUnit = JSON.parse(await ctx.tools.items.get('fx_convert').execute({ amount: 1, unit: '角' }, { ...exec, callId: 'fx-bad-unit' }))
  assert.equal(rejectedUnit.code, 'UNIT_REJECTED')
  status = JSON.parse(await ctx.tools.items.get('friction_status').execute({}, exec))
  assert.equal(status.tools.fx_convert.calls, 6)
  assert.equal(status.tools.fx_convert.score, 1)

  const steps = [
    ['bash', { command: 'ls /tmp' }, 'tmp'],
    ['bash', { command: 'echo two' }, 'two'],
  ]
  for (let round = 0; round < 2; round += 1) {
    for (const [tool, args, output] of steps) await record(tool, args, output)
  }
  status = JSON.parse(await ctx.tools.items.get('friction_status').execute({}, exec))
  const fragment = matureFragments(traceFrom([
    call('bash', { command: 'ls /tmp' }, { output: 'tmp' }),
    call('bash', { command: 'echo two' }, { output: 'two' }),
    call('bash', { command: 'ls /tmp' }, { output: 'tmp' }),
    call('bash', { command: 'echo two' }, { output: 'two' }),
  ]))[0]
  const contract = contractFor(fragment)
  const propose = ctx.tools.items.get('propose_compiled_procedure')
  const denied = JSON.parse(await propose.execute({ contract_json: JSON.stringify(contract) }, exec))
  assert.equal(denied.code, 'NOT_APPROVED')
  assert.equal(executions, 0)
  assert.equal([...ctx.tools.items.keys()].some((name) => String(name).startsWith('ec_')), false)
  assert.match(card, /这是给当前会话安装工具，不是放行这一次调用/)
  assert.match(card, /槽位只在被校验的两次绑定上有参照/)
  assert.match(card, /ls \/tmp/)
  assert.equal(card.includes('\n'), true)

  failRegister = true
  approvalMode = 'allowed-once'
  const rolled = JSON.parse(await propose.execute({ contract_json: JSON.stringify(contract) }, exec))
  assert.equal(rolled.code, 'NOT_INSTALLED')
  assert.equal((await guard('bash', { command: 'ls /tmp' })).kind, 'allow')
  failRegister = false
  const installed = JSON.parse(await propose.execute({ contract_json: JSON.stringify(contract) }, exec))
  assert.equal(installed.ok, true)
  assert.match(installed.name, /^ec_bash_/)
  const direct = await guard('bash', { command: 'ls /tmp' })
  assert.equal(direct.kind, 'deny')
  assert.match(direct.reason, new RegExp(installed.name))
  assert.equal((await guard('bash', { command: 'echo two' })).kind, 'allow')
  assert.equal((await guard('bash', { command: 'ls /var' })).kind, 'allow')
  const bashScore = JSON.parse(await ctx.tools.items.get('friction_status').execute({}, exec)).tools.bash.score
  const ec = ctx.tools.items.get(installed.name)
  const ran = await ec.execute({}, { ...exec, callId: 'run-1' })
  const ranBody = JSON.parse(ran.text)
  assert.equal(ran.failed, false)
  assert.equal(ranBody.ok, true)
  assert.ok(ctx.tools.calls.includes('ls /tmp'))
  assert.ok(ctx.tools.calls.includes('echo two'))
  const when = ctx.tools.whens.get(installed.name)
  assert.equal(when({ agent: { session: { id: sessionA } } }), true)
  assert.equal(when({ agent: { session: { id: sessionB } } }), false)
  const foreign = JSON.parse(await ctx.tools.items.get('friction_status').execute({}, { agent: { session: { id: sessionB }, ctx }, callId: 'b' }))
  assert.equal((foreign.compiled ?? []).some((item) => item.name === installed.name), false)

  const before = executions
  failSecond = true
  const broke = await ec.execute({}, { ...exec, callId: 'run-2' })
  assert.equal(broke.failed, true)
  assert.equal(JSON.parse(broke.text).step, 's1')
  await ctx.waterfall('tools/post-execute', {
    name: installed.name,
    arguments: {},
    callId: 'ec-fail',
    agent,
  }, {
    isError: false,
    value: { failed: true, text: broke.text },
    content: [{ type: 'text', text: broke.text }],
  }, () => ({ kind: 'accept' }))
  status = JSON.parse(await ctx.tools.items.get('friction_status').execute({}, exec))
  assert.equal(status.tools[installed.name]?.score ?? 0, 0)
  assert.equal(status.tools[installed.name]?.gated ?? false, false)
  assert.equal(status.tools.bash.score, bashScore)
  assert.equal(status.compiled.find((item) => item.name === installed.name).steps[1].mode, 'agent')
  const callsBefore = ctx.tools.calls.length
  const resumed = JSON.parse((await ec.execute({}, { ...exec, callId: 'run-3' })).text)
  assert.equal(resumed.resume_token.length > 0, true)
  assert.deepEqual(ctx.tools.calls.slice(callsBefore), ['ls /tmp'])
  assert.equal(executions > before, true)
  const replaced = JSON.parse(await ctx.tools.items.get('propose_tool_goal').execute({
    tool: installed.name,
    metric: 'failures',
    patch_json: '{}',
  }, exec))
  assert.equal(replaced.code, 'COMPILED_NOT_REPLACEABLE')
  assert.equal(status.proposals?.bash, undefined)

  approvalMode = 'allowed-once'
  const removed = JSON.parse(await ctx.tools.items.get('restore_tool_definition').execute({ tool: installed.name }, exec))
  assert.equal(removed.ok, true)
  assert.equal((await guard('bash', { command: 'ls /tmp' })).kind, 'deny')
  ctx.friction.commit(agent)
  assert.equal((await guard('bash', { command: 'ls /tmp' })).kind, 'allow')
  assert.equal(ctx.tools.items.has(installed.name), false)
  rmSync(home, { recursive: true, force: true })
})

test('仓库外必须加载插件入口，依赖解析失败就是失败', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ec-load-'))
  const packageDir = path.join(dir, 'pkg')
  mkdirSync(packageDir, { recursive: true })
  for (const name of ['index.js', 'logic.js', 'score.js', 'compiler.js', 'quality.js', 'store.js', 'schema.js', 'owned-runtime.js']) {
    cpSync(path.join(here, name), path.join(packageDir, name))
  }
  const root = path.resolve(here, '../..')
  const vendor = path.join(root, '.dsh-deps/node_modules/@deepseek-ai/dsh-tools')
  mkdirSync(path.join(packageDir, 'node_modules/@deepseek-ai'), { recursive: true })
  symlinkSync(vendor, path.join(packageDir, 'node_modules/@deepseek-ai/dsh-tools'))
  return import(pathToFileURL(path.join(packageDir, 'index.js')).href).then((loaded) => {
    assert.equal(loaded.name, 'friction-drive')
    assert.equal(typeof loaded.apply, 'function')
    rmSync(dir, { recursive: true, force: true })
  })
})

