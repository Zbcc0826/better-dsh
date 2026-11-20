/**
 * 摩擦驱动插件。按会话记账。
 * 工具定义由插件写入当前会话的目录，预计调用次数按登记公式计算。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { allocateCompiledName, assessCompiledProposal, commitCompiled, compilableView, executeCompiled, ingestCall, installCompiled, interceptMatches, markStepAgent, matureFragments, noteRegisteredBreakpoint, stageCompiledRestore, stageCompiledRevision, visibleCompiled } from './compiler.js'
import { admit, applyAdaptation, approvalCopy, canonicalPatch, clearGate, failureOf, freshTool, gateSkipped, invalidAgainstSchema, ownedCopy, ownedCore, ownedName, projectedCalls, propose, proposeOwned, renderNotes, retest, reviseOwned, sameOwned, truncationOf } from './logic.js'
import { fillTemplate, presentDelegated } from './owned-runtime.js'
import { assessCritique, assessLoopOffer, assessPlan, qualityCopy, qualityView } from './quality.js'
import { schemaError } from './schema.js'
import { readSession, sessionDir, stateRoot, withSession } from './store.js'

const ROOT = stateRoot
const OWN = new Set(['friction_status', 'propose_tool_goal', 'apply_tool_change', 'restore_tool_definition', 'propose_compiled_procedure', 'propose_quality_loop', 'record_quality_critique', 'record_quality_plan'])

export const name = 'friction-drive'
export const inject = ['tools']

export function apply(ctx) {
  const drive = {
    registry: new Map(),
    ownedBindings: new Map(),
    agents: new Set(),
    started: new Map(),
    // 还没返回又来了另一次调用时，这两次都算并行，不参与片段。
    parallel: new Set(),
    bypass: new Map(),
    threshold: 8,
    slowMs: 2000,
    verboseChars: 500,
    register(entry) {
      if (this.registry.has(entry.name)) return false
      if (!entry?.seed || !Array.isArray(entry.patchKeys) || !Array.isArray(entry.engines)) return false
      if (!['paged', 'per-item'].includes(entry.formula)) return false
      this.registry.set(entry.name, entry)
      return true
    },
    sessionOf(exec) {
      const agent = exec?.agent
      const id = agent?.sessionId ?? agent?.session?.id
      return id ? String(id) : ''
    },
    spec(sessionId, name) {
      const entry = this.registry.get(name)
      if (!entry || !sessionId) return null
      return withSession(ROOT(), sessionId, this.threshold, ({ catalog }) => {
        ensureSeed(catalog, entry)
        return structuredClone(catalog.tools[name])
      })
    },
    record(sessionId, event) {
      const entry = this.registry.get(event.tool)
      if (!entry || !sessionId) return { blocked: false, gate: false, skipped: true }
      return withSession(ROOT(), sessionId, this.threshold, ({ state, catalog }) => {
        ensureSeed(catalog, entry)
        return ingestCall(state, { ...event, registered: true }, { slowMs: this.slowMs, verboseChars: this.verboseChars })
      })
    },
    observe(sessionId, event) {
      if (!sessionId) return { skipped: true }
      if (this.registry.has(event.tool)) {
        return withSession(ROOT(), sessionId, this.threshold, ({ state }) => noteRegisteredBreakpoint(state, event))
      }
      return withSession(ROOT(), sessionId, this.threshold, ({ state, catalog }) => ingestCall(state, {
        ...event,
        own: event.own || OWN.has(event.tool),
        compiled: event.compiled || Boolean(catalog.compiled?.[event.tool]),
      }, { slowMs: this.slowMs, verboseChars: this.verboseChars }))
    },
    look(sessionId, tool) {
      if (!sessionId) return { gated: false, successor: '', owned: false, intercepts: [] }
      try {
        const { state, catalog } = readSession(ROOT(), sessionId, this.threshold)
        const row = state.tools?.[tool]
        const successor = row?.successor ?? ''
        return {
          gated: Boolean(row?.gated),
          successor,
          owned: Boolean(row?.owned),
          // 已有摩擦后继时，编译拦截让路。
          intercepts: successor ? [] : (catalog.intercepts ?? []),
        }
      } catch {
        return { gated: false, successor: '', owned: false, intercepts: [] }
      }
    },
  }
  ctx.reflect.provide('friction', drive)
  drive.skillReady = registerSkill(ctx)
  armOwnedTools(ctx, drive)
  watchTools(ctx, drive)
  drive.commit = (agent) => commitSession(ctx, drive, agent)

  ctx.tools.register(defineTool({
    name: 'friction_status',
    description: '查看本会话里已登记工具的失败、重试、截断和是否已过线。不计分。',
    parameters: {},
    output: textOutput(),
    async execute(_args, exec) {
      const sessionId = drive.sessionOf(exec)
      if (!sessionId) return JSON.stringify({ ok: false, code: 'SESSION_REQUIRED' })
      return JSON.stringify(withSession(ROOT(), sessionId, drive.threshold, ({ state, catalog }) => ({
        ok: true,
        threshold: state.threshold,
        tools: state.tools,
        proposals: state.proposals,
        definitions: [...drive.registry.values()].map((entry) => ({
          name: entry.name,
          patchKeys: entry.patchKeys,
          engines: entry.engines,
        })),
        owned: Object.keys(catalog.owned ?? {}),
        notes: renderNotes(catalog.owned ?? {}),
        compilable: compilableView(matureFragments(state.trace ?? [], fragmentGuards(state))),
        quality: qualityView(catalog.quality),
        compiled: Object.values(catalog.compiled ?? {}).map((spec) => ({
          name: spec.ecName,
          tools: spec.tools,
          steps: (visibleCompiled(spec)?.operations ?? []).map((operation) => ({
            id: operation.id,
            tool: operation.tool,
            mode: operation.mode,
            failedStep: Boolean(operation.failedStep),
          })),
        })),
      })))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'propose_quality_loop',
    description: '复杂任务可选。征求同意后，本会话先找茬再写实现方案。简单任务不要调用。不同意就按普通方式做。',
    parameters: {
      task: { type: 'string', required: true, description: '要做的复杂任务，一两句话。' },
      why: { type: 'string', required: true, description: '为什么它会牵动多处行为，而不是一次查询。' },
    },
    output: textOutput(),
    async execute(args, exec) {
      const sessionId = drive.sessionOf(exec)
      if (!sessionId) return JSON.stringify({ ok: false, code: 'SESSION_REQUIRED' })
      const offer = assessLoopOffer(args)
      if (!offer.ok) return JSON.stringify(offer)
      const current = readSession(ROOT(), sessionId, drive.threshold).catalog.quality
      if (current?.active && !qualityView(current).ready) return JSON.stringify({ ok: false, code: 'IN_PROGRESS' })
      const copy = qualityCopy(offer.task)
      const outcome = await askApproval(ctx, exec, 'propose_quality_loop', copy.zh, copy)
      if (outcome !== 'allowed-once') return JSON.stringify({ ok: false, code: 'NOT_APPROVED', outcome })
      // 新的同意清掉上一轮找茬和方案，避免旧计划被拿去实现新任务。
      const saved = withSession(ROOT(), sessionId, drive.threshold, ({ catalog }) => {
        catalog.quality = { active: true, task: offer.task, why: offer.why, critique: null, plan: null }
        return qualityView(catalog.quality)
      })
      return JSON.stringify({
        ok: true,
        ...saved,
        instruction: '先调用 record_quality_critique。计划还没就绪时不要改代码、不要改工具。',
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'record_quality_critique',
    description: '记下本会话找茬结果。至少两条。写完之前不要实现。',
    parameters: {
      defects_json: { type: 'string', required: true, description: '数组。每项含 id、severity、scenario、consequence。severity 只能是 fatal、high 或 medium。' },
    },
    output: textOutput(),
    async execute(args, exec) {
      const sessionId = drive.sessionOf(exec)
      if (!sessionId) return JSON.stringify({ ok: false, code: 'SESSION_REQUIRED' })
      const loop = readSession(ROOT(), sessionId, drive.threshold).catalog.quality
      if (!loop?.active) return JSON.stringify({ ok: false, code: 'NOT_ACTIVE' })
      let defects
      try {
        defects = JSON.parse(args.defects_json)
      } catch {
        return JSON.stringify({ ok: false, code: 'BAD_DEFECTS' })
      }
      const critique = assessCritique(defects)
      if (!critique.ok) return JSON.stringify(critique)
      const saved = withSession(ROOT(), sessionId, drive.threshold, ({ catalog }) => {
        catalog.quality = { ...catalog.quality, critique, plan: null }
        return qualityView(catalog.quality)
      })
      return JSON.stringify({
        ok: true,
        ...saved,
        instruction: '再调用 record_quality_plan。每条修改都要写次生影响。这时还不要实现。',
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'record_quality_plan',
    description: '按找茬逐条写实现方案。每条必须有次生影响。全部盖住之后，本会话才可以动手。',
    parameters: {
      plan_json: { type: 'string', required: true, description: '含 principle 和 changes。changes 每项含 defectId、change、secondary 数组。' },
    },
    output: textOutput(),
    async execute(args, exec) {
      const sessionId = drive.sessionOf(exec)
      if (!sessionId) return JSON.stringify({ ok: false, code: 'SESSION_REQUIRED' })
      const loop = readSession(ROOT(), sessionId, drive.threshold).catalog.quality
      if (!loop?.active) return JSON.stringify({ ok: false, code: 'NOT_ACTIVE' })
      let plan
      try {
        plan = JSON.parse(args.plan_json)
      } catch {
        return JSON.stringify({ ok: false, code: 'BAD_PRINCIPLE' })
      }
      const checked = assessPlan(loop.critique?.defects, plan)
      if (!checked.ok) return JSON.stringify(checked)
      const saved = withSession(ROOT(), sessionId, drive.threshold, ({ catalog }) => {
        catalog.quality = { ...catalog.quality, plan: checked.plan }
        return qualityView(catalog.quality)
      })
      return JSON.stringify({
        ok: true,
        ...saved,
        instruction: '可以按方案实现。只改方案里写过的点，并留意每条 secondary。这不代替工具改造或程序沉淀的审批。',
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'propose_tool_goal',
    description: '某个工具过线后提出下一步。已登记工具用 projected_calls 和登记字段。其他工具写 name、problem、usage、schema、run，新增或修改本插件的工具。',
    parameters: {
      tool: { type: 'string', required: true, description: '过线的工具名' },
      metric: { type: 'string', required: true, description: '已登记工具只能是 projected_calls。其他工具可省略含义，插件不使用这个值。' },
      target: { type: 'number', description: '可省略。已登记工具会改成公式算出的次数。' },
      patch_json: { type: 'string', required: true, description: '已登记工具用 pageSize 等登记字段。其他工具写 name、problem、usage、schema、run，用来新增或修改本插件的工具。' },
    },
    output: textOutput(),
    async execute(args, exec) {
      const entry = drive.registry.get(args.tool)
      const sessionId = drive.sessionOf(exec)
      if (!sessionId) return JSON.stringify({ ok: false, code: 'SESSION_REQUIRED' })
      if (readSession(ROOT(), sessionId, drive.threshold).catalog.compiled?.[args.tool]) {
        return JSON.stringify({ ok: false, code: 'COMPILED_NOT_REPLACEABLE' })
      }
      let patch
      try {
        patch = JSON.parse(args.patch_json)
      } catch {
        return JSON.stringify({ ok: false, code: 'BAD_PATCH' })
      }
      if (!entry) {
        const checked = schemaError(patch?.schema)
        const currentOwned = readSession(ROOT(), sessionId, drive.threshold).catalog.owned?.[args.tool]
        const generated = currentOwned ? args.tool : allocateName(drive, args.tool)
        const delegateTarget = patch?.run?.kind === 'script' ? '' : String(patch?.run?.tool ?? args.tool)
        const delegateSchema = delegateTarget ? toolParameters(ctx, delegateTarget, exec.agent) : undefined
        const delegateSchemaMissing = Boolean(delegateTarget) && !delegateSchema
        if (!currentOwned && nameTaken(ctx, drive, sessionId, generated)) {
          return JSON.stringify({ ok: false, code: 'NAME_TAKEN', name: generated })
        }
        const result = withSession(ROOT(), sessionId, drive.threshold, ({ state, catalog }) => {
          const current = catalog.owned?.[args.tool]
          if (current) {
            const revised = reviseOwned(current, { ...patch, schemaError: checked, delegateSchema, delegateSchemaMissing })
            if (!revised.ok) return revised
            state.proposals[args.tool] = { ...revised.proposal, id: `p-${Date.now()}` }
            return revised
          }
          return proposeOwned(state, {
            id: `p-${Date.now()}`,
            tool: args.tool,
            ...patch,
            name: generated,
            schemaError: checked,
            delegateSchema,
            delegateSchemaMissing,
          })
        })
        if (!result.ok) return JSON.stringify(result)
        const instruction = result.proposal.kind === 'revise'
          ? `提案已记录。调用 apply_tool_change 修改 ${args.tool}。同意后下一轮使用新的 schema。`
          : `提案已记录。调用 apply_tool_change。同意后使用 ${result.proposal.name}，不要修改 ${args.tool} 本身。`
        return JSON.stringify({ ...result, instruction })
      }
      const result = withSession(ROOT(), sessionId, drive.threshold, ({ state, catalog }) => {
        ensureSeed(catalog, entry)
        return propose(state, {
          id: `p-${Date.now()}`,
          tool: args.tool,
          metric: args.metric,
          patch,
        }, entry, catalog.tools[args.tool])
      })
      if (!result.ok) {
        if (result.code === 'BAD_PATCH') {
          return JSON.stringify({ ...result, patchKeys: entry.patchKeys, engines: entry.engines })
        }
        return JSON.stringify(result)
      }
      return JSON.stringify({
        ...result,
        instruction: '提案已记录。调用 apply_tool_change，补丁必须一致。审批卡上的数字由插件计算，不要向用户索要口令。',
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'apply_tool_change',
    description: '把已提案交给用户做一次性审批。已登记工具会复查调用次数，不下降则不保存。本插件的工具在本轮结束后才换上新 schema。',
    parameters: {
      tool: { type: 'string', required: true, description: '提案里的工具名' },
      patch_json: { type: 'string', required: true, description: '必须与提案中的补丁完全一致' },
    },
    output: textOutput(),
    async execute(args, exec) {
      const entry = drive.registry.get(args.tool)
      const sessionId = drive.sessionOf(exec)
      if (!sessionId) return JSON.stringify({ ok: false, code: 'SESSION_REQUIRED' })
      let patch
      try {
        patch = JSON.parse(args.patch_json)
      } catch {
        return JSON.stringify({ ok: false, code: 'BAD_PATCH' })
      }
      const pending = withSession(ROOT(), sessionId, drive.threshold, ({ state }) => state.proposals[args.tool] ?? null)
      if (!pending) return JSON.stringify({ ok: false, code: 'NO_PROPOSAL' })
      if (pending.kind === 'create' || pending.kind === 'revise') {
        if (!sameOwned(pending, { ...patch, name: pending.name })) {
          return JSON.stringify({ ok: false, code: 'PATCH_MISMATCH' })
        }
        const copy = ownedCopy(pending)
        const outcome = await askApproval(ctx, exec, args.tool, copy.zh, copy)
        if (outcome !== 'allowed-once') return JSON.stringify({ ok: false, code: 'NOT_APPROVED', outcome })
        const before = readSession(ROOT(), sessionId, drive.threshold)
        const saved = withSession(ROOT(), sessionId, drive.threshold, ({ state, catalog }) => installOwnedRecord(state, catalog, pending))
        if (!saved.ok) return JSON.stringify(saved)
        try {
          writeNotes(sessionId, saved.owned)
          if (pending.kind === 'create' && !bindSession(ctx, drive, exec.agent)) throw new Error('工具或技能没有挂上')
        } catch (error) {
          withSession(ROOT(), sessionId, drive.threshold, ({ state, catalog }) => {
            catalog.owned = before.catalog.owned
            state.tools = before.state.tools
          })
          return JSON.stringify({ ok: false, code: 'NOT_INSTALLED', message: error instanceof Error ? error.message : 'NOT_INSTALLED' })
        }
        return JSON.stringify({ ok: true, kind: pending.kind, name: pending.name, pending: pending.kind === 'revise', sessionOnly: true })
      }
      if (!entry) return JSON.stringify({ ok: false, code: 'NOT_REGISTERED' })
      if (JSON.stringify(canonicalPatch(patch, entry.patchKeys)) !== JSON.stringify(pending.patch)) {
        return JSON.stringify({ ok: false, code: 'PATCH_MISMATCH' })
      }
      const stats = withSession(ROOT(), sessionId, drive.threshold, ({ state }) => state.tools[args.tool])
      const copy = approvalCopy(pending, stats)
      const outcome = await askApproval(ctx, exec, args.tool, copy.zh, copy)
      const allowed = admit(pending, patch, outcome, entry.patchKeys)
      if (!allowed.ok) return JSON.stringify(allowed)
      const saved = withSession(ROOT(), sessionId, drive.threshold, ({ state, catalog }) => {
        const current = catalog.tools[args.tool]
        const previous = structuredClone(current)
        const next = { ...current, ...canonicalPatch(patch, entry.patchKeys) }
        catalog.tools[args.tool] = next
        const after = projectedCalls(catalog.tools[args.tool], entry, state.tools[args.tool]?.workloadItems)
        const checked = retest(pending.current, after.ok ? after.calls : Number.NaN)
        if (!checked.ok) {
          catalog.tools[args.tool] = previous
          return { ok: false, ...checked, restored: true }
        }
        clearGate(state, args.tool)
        return { ok: true, ...checked, patch: canonicalPatch(patch, entry.patchKeys), sessionOnly: true }
      })
      return JSON.stringify(saved)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'restore_tool_definition',
    description: '把当前会话里某个已登记工具恢复成初始定义。需要用户在审批卡上同意。不影响其他会话。',
    parameters: {
      tool: { type: 'string', required: true, description: '要恢复的工具名' },
    },
    output: textOutput(),
    async execute(args, exec) {
      const entry = drive.registry.get(args.tool)
      const sessionId = drive.sessionOf(exec)
      if (!sessionId) return JSON.stringify({ ok: false, code: 'SESSION_REQUIRED' })
      const snapshot = withSession(ROOT(), sessionId, drive.threshold, ({ state, catalog }) => ({
        adapted: Boolean(state.tools[args.tool]?.successor || state.tools[args.tool]?.owned || catalog.owned?.[args.tool] || catalog.compiled?.[args.tool]),
        compiled: Boolean(catalog.compiled?.[args.tool]),
        reason: catalog.compiled?.[args.tool]
          ? compiledRestoreReason(catalog.compiled[args.tool])
          : restoreReason(state, catalog, args.tool, entry),
      }))
      const adapted = snapshot.adapted
      const reason = snapshot.reason
      const outcome = await askApproval(ctx, exec, args.tool, reason.zh, reason)
      if (outcome !== 'allowed-once') return JSON.stringify({ ok: false, code: 'NOT_APPROVED', outcome })
      if (!entry && !adapted) return JSON.stringify({ ok: false, code: 'NOT_ADAPTED' })
      const restored = withSession(ROOT(), sessionId, drive.threshold, ({ state, catalog }) => {
        if (catalog.compiled?.[args.tool]) {
          stageCompiledRestore(catalog, args.tool)
          return { owned: catalog.owned }
        }
        return restoreOwned(state, catalog, args.tool, entry)
      })
      try {
        writeNotes(sessionId, restored.owned)
        bindSession(ctx, drive, exec.agent)
      } catch (error) {
        return JSON.stringify({ ok: false, code: 'NOT_INSTALLED', message: error instanceof Error ? error.message : 'NOT_INSTALLED' })
      }
      return JSON.stringify({ ok: true, restored: args.tool, sessionOnly: true })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'propose_compiled_procedure',
    description: '把 friction_status.compilable 里的一段成熟调用沉淀成当前会话的 ec_ 工具。审批前不执行原工具。多个候选时必须带 asset_id。',
    parameters: {
      contract_json: { type: 'string', required: true, description: '合同 JSON，含 operations、order、edges、slots、constants。修订失败步时加 revise_step。' },
      asset_id: { type: 'string', description: '已有资产。零个匹配时省略；恰好一个时必须等于它；多个时必须是候选之一。' },
    },
    output: textOutput(),
    async execute(args, exec) {
      return proposeCompiled(ctx, drive, args, exec)
    },
  }))
}

function ensureSeed(catalog, entry) {
  if (!catalog.tools[entry.name]) catalog.tools[entry.name] = structuredClone(entry.seed)
}

/** 会话打开后补挂已经批准的新工具。挂不上就等下一轮，不占用全局工具表。 */
function armOwnedTools(ctx, drive) {
  let left = 120
  const timer = setInterval(() => {
    left -= 1
    if (!drive.skillReady) drive.skillReady = registerSkill(ctx)
    for (const agent of drive.agents) bindSession(ctx, drive, agent)
    if (left <= 0) clearInterval(timer)
  }, 250)
  if (typeof timer.unref === 'function') timer.unref()
}

/** 给所有正在使用的工具记账，并在过线或已批准后拦住对原工具的直接调用。 */
function watchTools(ctx, drive) {
  ctx.on('agent/created', ({ agent }) => {
    if (agent) drive.agents.add(agent)
    // 子代理创建发生在本轮进行中。这里只补挂已生效的工具，不提交尚未换上的修改。
    bindSession(ctx, drive, agent)
  })
  ctx.on('agent/turn-stopping', ({ agent }) => {
    if (agent) drive.agents.add(agent)
    commitSession(ctx, drive, agent)
  })
  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = typeof next === 'function' ? await next() : { kind: 'allow' }
    if (decision.kind !== 'allow') return decision
    if (OWN.has(exec.name) || gateSkipped(drive.bypass.get(exec.callId), exec.name)) return decision
    let gate
    try {
      gate = drive.look(drive.sessionOf(exec), exec.name)
    } catch {
      return decision
    }
    if (gate.successor) {
      return { kind: 'deny', reason: `${exec.name} 在这个会话里请改用 ${gate.successor}，并查看 friction_status 的 notes。原工具定义没有修改。` }
    }
    if (gate.owned && gate.gated) {
      return { kind: 'deny', reason: `${exec.name} 属于本插件，摩擦已过线。请提出一份不同的修改，同时更新 schema、执行方式和技能说明。` }
    }
    if (gate.gated) {
      const hint = drive.registry.has(exec.name)
        ? '请调用 propose_tool_goal，再调用 apply_tool_change。审批卡由插件填写数字。'
        : `请调用 propose_tool_goal。patch_json 写 name、problem、usage、schema、run，用来新增本插件的工具。不要修改 ${exec.name} 本身。`
      return { kind: 'deny', reason: `${exec.name} 的摩擦已过线。${hint}` }
    }
    const intercepted = (gate.intercepts ?? []).find((item) => interceptMatches(item, exec.name, exec.arguments))
    if (intercepted) {
      return { kind: 'deny', reason: `${exec.name} 在这个会话里请改用 ${intercepted.ecName}，并查看 friction_status。这是已安装的经验编译工具，不是放行这一次调用。` }
    }
    if (drive.started.size > 0) {
      drive.parallel.add(exec.callId)
      for (const id of drive.started.keys()) drive.parallel.add(id)
    }
    drive.started.set(exec.callId, Date.now())
    return decision
  })
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = typeof next === 'function' ? await next() : { kind: 'accept' }
    const started = drive.started.get(exec.callId)
    const parallel = drive.parallel.has(exec.callId) || Boolean(exec.parallel)
    drive.started.delete(exec.callId)
    drive.parallel.delete(exec.callId)
    const judged = failureOf(result)
    const text = (result?.content ?? []).map((block) => block?.text ?? '').join('\n')
    const exitCode = typeof result?.value?.exitCode === 'number' ? result.value.exitCode : undefined
    try {
      drive.observe(drive.sessionOf(exec), {
        tool: exec.name,
        callId: exec.callId,
        ok: judged.ok,
        invalid: judged.invalid,
        failed: result?.value?.failed === true || result?.isError === true,
        isError: result?.isError === true,
        args: exec.arguments ?? {},
        scoreArgs: JSON.stringify(exec.arguments ?? {}),
        output: text,
        outputChars: text.length,
        exitCode,
        elapsedMs: started ? Date.now() - started : 0,
        truncated: truncationOf(result),
        bypass: drive.bypass.has(exec.callId),
        parallel,
        fileHash: result?.value?.fileHash ?? null,
      })
    } catch {
      // 记账失败时保留工具原来的结果。
    }
    return decision
  })
}

/** 把提案写进当前会话。原工具只记下后继名字。 */
function installOwnedRecord(state, catalog, pending) {
  catalog.owned = catalog.owned ?? {}
  if (pending.kind === 'create') {
    if (catalog.owned[pending.name]) return { ok: false, code: 'NAME_TAKEN' }
    catalog.owned[pending.name] = { ...ownedCore(pending), replaces: pending.replaces, previous: null }
    if (!state.tools[pending.replaces]) state.tools[pending.replaces] = freshTool()
    clearGate(state, pending.replaces)
    state.tools[pending.replaces].successor = pending.name
    state.tools[pending.name] = freshTool()
    state.tools[pending.name].owned = true
  } else {
    const current = catalog.owned[pending.name]
    if (!current) return { ok: false, code: 'NOT_ADAPTED' }
    const live = current.staged && current.previous
      ? current.previous
      : { ...ownedCore(current), replaces: current.replaces, previous: current.previous ?? null }
    catalog.owned[pending.name] = { ...ownedCore(pending), replaces: current.replaces, previous: live, staged: true }
    if (!state.tools[pending.name]) state.tools[pending.name] = freshTool()
    state.tools[pending.name].owned = true
  }
  return { ok: true, owned: catalog.owned }
}

/** 恢复上一版。没有上一版时卸掉新工具，原工具重新可以调用。 */
function restoreOwned(state, catalog, name, entry) {
  catalog.owned = catalog.owned ?? {}
  if (entry) catalog.tools[name] = structuredClone(entry.seed)
  const ownedName = catalog.owned[name] ? name : state.tools[name]?.successor
  const current = ownedName ? catalog.owned[ownedName] : null
  if (current?.staged && current.previous) {
    catalog.owned[ownedName] = {
      ...ownedCore(current.previous),
      replaces: current.replaces,
      previous: current.previous.previous ?? null,
    }
  } else if (current?.previous) {
    catalog.owned[ownedName] = { ...current, pendingRestore: { mode: 'rollback' } }
  } else if (current) {
    catalog.owned[ownedName] = { ...current, pendingRestore: { mode: 'delete' } }
  }
  return { owned: catalog.owned }
}

/** 本轮结束前，已批准但还没换上的修改仍用旧 schema 和旧说明。 */
function visibleSpec(spec) {
  if (spec?.staged && spec.previous) return { ...spec.previous, replaces: spec.replaces ?? spec.previous.replaces }
  return spec
}

/** 把暂存的修改换成正在使用的版本，并重新注册。当前这一步已经解析过的工具表不会被拆掉。 */
function commitSession(ctx, drive, agent) {
  const sessionId = drive.sessionOf({ agent })
  if (!sessionId) return false
  const before = readSession(ROOT(), sessionId, drive.threshold)
  const waiting = Object.values(before.catalog.owned ?? {}).some((spec) => spec.staged || spec.pendingRestore)
    || Object.values(before.catalog.compiled ?? {}).some((spec) => spec.staged || spec.pendingRestore)
  if (waiting) {
    withSession(ROOT(), sessionId, drive.threshold, ({ state, catalog }) => {
      for (const [name, spec] of Object.entries(catalog.owned ?? {})) {
        if (spec.pendingRestore?.mode === 'delete') {
          delete catalog.owned[name]
          if (state.tools[spec.replaces]) delete state.tools[spec.replaces].successor
          delete state.tools[name]
          clearGate(state, spec.replaces)
          continue
        }
        if (spec.pendingRestore?.mode === 'rollback' && spec.previous) {
          catalog.owned[name] = {
            ...ownedCore(spec.previous),
            replaces: spec.replaces,
            previous: spec.previous.previous ?? null,
          }
          clearGate(state, name)
          if (state.tools[name]) state.tools[name].owned = true
          continue
        }
        if (!spec.staged) continue
        catalog.owned[name] = { ...ownedCore(spec), replaces: spec.replaces, previous: spec.previous ?? null }
        clearGate(state, name)
        if (state.tools[name]) state.tools[name].owned = true
      }
      commitCompiled(state, catalog)
    })
    writeNotes(sessionId, readSession(ROOT(), sessionId, drive.threshold).catalog.owned)
  }
  return bindSession(ctx, drive, agent)
}

/** bash 这类工具挂在会话上，插件自己的上下文直接查名字会落空。 */
function toolParameters(ctx, name, agent) {
  const found = ctx.tools.get?.(name, agent) ?? ctx.tools.get?.(name)
  if (found?.parameters?.properties) return found.parameters
  const listed = [
    ...(typeof ctx.tools.definitions === 'function' && agent ? ctx.tools.definitions(agent) : []),
    ...(typeof ctx.tools.definitions === 'function' ? ctx.tools.definitions() : []),
  ]
  return listed.find((item) => item.name === name)?.parameters
}

/** 新工具的全局名字。fd、原工具缩写、时间，同一毫秒再加序号。 */
function allocateName(drive, tool) {
  let serial = 0
  let name = ownedName(tool, Date.now(), serial)
  const used = new Set([...drive.ownedBindings.values()].map((bound) => bound.name))
  while (used.has(name)) {
    serial += 1
    name = ownedName(tool, Date.now(), serial)
  }
  return name
}

/** 名字已被原工具或其他会话占用时，在审批前拒绝。 */
function nameTaken(ctx, drive, sessionId, name) {
  if (typeof name !== 'string' || name === '') return false
  if (OWN.has(name) || drive.registry.has(name)) return true
  for (const [key, bound] of drive.ownedBindings) {
    if (bound.name === name && !key.startsWith(`${sessionId}:`)) return true
  }
  if (!ctx.tools.get?.(name)) return false
  return !drive.ownedBindings.has(`${sessionId}:${name}`)
}

function restoreReason(state, catalog, name, entry) {
  if (entry) {
    return { zh: `把 ${name} 恢复成初始定义。只影响当前会话。`, en: `Restore ${name} to its initial definition for this session only.` }
  }
  const ownedName = catalog.owned?.[name] ? name : state.tools[name]?.successor
  const current = ownedName ? catalog.owned?.[ownedName] : null
  const replaces = current?.replaces ?? name
  if (current?.staged) {
    return { zh: `取消 ${ownedName} 尚未生效的修改。这一轮仍使用当前版本。`, en: `Discard the not-yet-applied change to ${ownedName}. This turn keeps the current version.` }
  }
  if (current?.previous) {
    return { zh: `把 ${ownedName} 退回上一版。${replaces} 仍请改用 ${ownedName}。`, en: `Roll ${ownedName} back one version. Keep using ${ownedName} instead of ${replaces}.` }
  }
  return { zh: `卸掉 ${ownedName ?? name}，并重新允许直接调用 ${replaces}。只影响当前会话。`, en: `Remove ${ownedName ?? name} and allow direct calls to ${replaces} again in this session.` }
}

function writeNotes(sessionId, owned) {
  const dir = sessionDir(ROOT(), sessionId)
  mkdirSync(dir, { recursive: true })
  const body = Object.keys(owned ?? {}).length > 0 ? renderNotes(owned) : ''
  writeFileSync(path.join(dir, 'notes.md'), body)
}

/** 只挂到这个 agent。schema 没变就不动已注册的工具，避免当前这一步丢失它。 */
function bindSession(ctx, drive, agent) {
  const sessionId = drive.sessionOf({ agent })
  const tools = agent?.ctx?.tools
  if (!sessionId || !tools?.register) return false
  const { catalog } = readSession(ROOT(), sessionId, drive.threshold)
  const owned = catalog.owned ?? {}
  const compiled = catalog.compiled ?? {}
  const alive = new Set([...Object.keys(owned), ...Object.keys(compiled)])
  for (const [key, bound] of drive.ownedBindings) {
    if (!key.startsWith(`${sessionId}:`)) continue
    if (alive.has(bound.name)) continue
    bound.dispose?.()
    drive.ownedBindings.delete(key)
  }
  for (const spec of Object.values(owned)) {
    const shown = visibleSpec(spec)
    const key = `${sessionId}:${shown.name}`
    const hash = JSON.stringify(ownedCore(shown))
    const bound = drive.ownedBindings.get(key)
    if (bound?.hash === hash) continue
    bound?.dispose?.()
    const dispose = tools.register(defineTool(ownedDefinition(ctx, drive, shown)), {
      // 工具服务是进程级的。没有 when 时，别的会话也会看到这个 schema。
      when: ({ agent }) => drive.sessionOf({ agent }) === sessionId,
    })
    drive.ownedBindings.set(key, { hash, dispose, name: spec.name })
  }
  for (const spec of Object.values(compiled)) {
    const shown = visibleCompiled(spec)
    if (!shown?.name) continue
    const key = `${sessionId}:${shown.name}`
    const hash = JSON.stringify({ operations: shown.operations, edges: shown.edges })
    const bound = drive.ownedBindings.get(key)
    if (bound?.hash === hash) continue
    bound?.dispose?.()
    const dispose = tools.register(defineTool(compiledDefinition(ctx, drive, shown)), {
      // 同一套工具服务上，别的会话的 when 看不到这个 ec_。
      when: ({ agent }) => drive.sessionOf({ agent }) === sessionId,
    })
    drive.ownedBindings.set(key, { hash, dispose, name: shown.name })
  }
  return true
}

/** 新工具的定义。每次调用都读取当前会话里的执行方式。 */
function ownedDefinition(ctx, drive, spec) {
  return {
    name: spec.name,
    description: spec.usage,
    parameters: spec.schema,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          exitCode: { type: 'integer' },
          failed: { type: 'boolean' },
          truncated: { type: 'boolean' },
          partial: { type: 'boolean' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
    },
    async execute(args, exec) {
      const sessionId = drive.sessionOf(exec)
      if (!sessionId) return { text: '缺少会话', failed: true }
      const record = readSession(ROOT(), sessionId, drive.threshold).catalog.owned?.[spec.name]
      const current = visibleSpec(record)
      if (!current?.run) return { text: '这个工具已撤回', failed: true }
      const callId = `${exec.callId}:inner`
      const bypassTool = current.run.kind === 'script' ? (current.replaces === 'bash' ? 'bash' : '') : current.run.tool
      if (bypassTool) drive.bypass.set(callId, bypassTool)
      try {
        if (current.run.kind === 'script') {
          const filled = fillTemplate(current.run.command, args)
          if (!filled.ok) return { text: `invalid arguments: missing ${filled.missing.join(', ')}`, failed: false }
          const batch = await ctx.tools.execute({
            calls: [{ type: 'tool-call', id: callId, name: 'bash', arguments: JSON.stringify({ command: filled.command, description: `Run ${current.name}` }) }],
            agent: exec.agent,
            signal: exec.signal,
          })
          return presentDelegated(batch?.results?.[0]?.result, null)
        }
        const merged = applyAdaptation(current.run, args ?? {})
        const batch = await ctx.tools.execute({
          calls: [{ type: 'tool-call', id: callId, name: current.run.tool, arguments: JSON.stringify(merged) }],
          agent: exec.agent,
          signal: exec.signal,
        })
        return presentDelegated(batch?.results?.[0]?.result, current.run.overrides)
      } finally {
        drive.bypass.delete(callId)
      }
    },
  }
}

function registerSkill(ctx) {
  try {
    const skills = ctx.get?.('skills')
    if (!skills?.register) return false
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'SKILL.md')
    const raw = readFileSync(file, 'utf8')
    const description = raw.match(/^description:\s*(.+)$/m)?.[1]?.trim()
    const content = raw.replace(/^---[\s\S]*?---\n/, '')
    if (!description || !content.trim()) return
    skills.register({
      name: 'friction-drive',
      description,
      content,
      source: 'runtime',
      provider: 'runtime',
      path: file,
    })
    return true
  } catch {
    // 没有技能服务时，工具结果里的说明仍然够用。
    return false
  }
}

function textOutput() {
  return {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: String(value) }],
  }
}

/** 过线或已有摩擦后继的工具不参与编译。 */
function fragmentGuards(state) {
  const gatedTools = new Set()
  const successorTools = new Set()
  for (const [name, row] of Object.entries(state.tools ?? {})) {
    if (row?.gated) gatedTools.add(name)
    if (row?.successor) successorTools.add(name)
  }
  return { gatedTools, successorTools }
}

/** 本进程和本会话里已经占用的工具名，避免同一毫秒装出重名。 */
function usedNames(drive, catalog) {
  return new Set([
    ...[...drive.ownedBindings.values()].map((bound) => bound.name),
    ...Object.keys(catalog.owned ?? {}),
    ...Object.keys(catalog.compiled ?? {}),
  ])
}

/** 审批前只对照轨迹。同意之后才写入拦截和 ec_ 工具。 */
async function proposeCompiled(ctx, drive, args, exec) {
  const sessionId = drive.sessionOf(exec)
  if (!sessionId) return JSON.stringify({ ok: false, code: 'SESSION_REQUIRED' })
  let contract
  try {
    contract = JSON.parse(args.contract_json)
  } catch {
    return JSON.stringify({ ok: false, code: 'BAD_CONTRACT' })
  }
  const loaded = readSession(ROOT(), sessionId, drive.threshold)
  const guards = fragmentGuards(loaded.state)
  const revise = Boolean(contract?.revise_step)
  const assetId = args.asset_id || contract?.asset_id || ''
  const existing = revise
    ? Object.values(loaded.catalog.compiled ?? {}).find((spec) => spec.assetId === assetId || spec.ecName === assetId)
    : null
  let ecName = existing?.ecName ?? ''
  if (!revise) {
    const first = contract?.operations?.find((operation) => operation?.id === contract?.order?.[0])?.tool ?? contract?.operations?.[0]?.tool
    ecName = allocateCompiledName(first || 'tool', Date.now(), usedNames(drive, loaded.catalog))
    if (!ecName || nameTaken(ctx, drive, sessionId, ecName)) return JSON.stringify({ ok: false, code: 'NAME_TAKEN', name: ecName })
  }
  const schemas = {}
  for (const operation of contract?.operations ?? []) {
    if (operation?.run?.kind !== 'delegate' || !operation.tool) continue
    const parameters = toolParameters(ctx, operation.tool, exec.agent)
    if (parameters) schemas[operation.tool] = (overrides) => invalidAgainstSchema(parameters, overrides)
  }
  const decision = assessCompiledProposal({
    trace: loaded.state.trace ?? [],
    contract,
    ecName,
    assetId,
    assets: loaded.catalog.assets ?? {},
    gatedTools: guards.gatedTools,
    successorTools: guards.successorTools,
    registeredTools: new Set(drive.registry.keys()),
    schemas,
    existing,
    reviseStep: contract?.revise_step,
  })
  if (!decision.ok) return JSON.stringify(decision)
  if (decision.code === 'SAME_REVISION') {
    return JSON.stringify({ ok: true, code: 'SAME_REVISION', asset_id: decision.assetId, name: decision.ecName })
  }
  const outcome = await askApproval(ctx, exec, decision.ecName, decision.card.zh, decision.card)
  if (outcome !== 'allowed-once') return JSON.stringify({ ok: false, code: 'NOT_APPROVED', outcome })
  if (decision.assetMode === 'revise') {
    const staged = withSession(ROOT(), sessionId, drive.threshold, ({ catalog }) => stageCompiledRevision(catalog, decision.ecName, decision.operations))
    if (!staged.ok) return JSON.stringify(staged)
    bindSession(ctx, drive, exec.agent)
    return JSON.stringify({ ok: true, kind: 'revise', name: decision.ecName, pending: true, sessionOnly: true })
  }
  const before = readSession(ROOT(), sessionId, drive.threshold)
  const snap = sessionSnapshot(before.state, before.catalog)
  const asset = `a${Date.now()}`
  const saved = withSession(ROOT(), sessionId, drive.threshold, ({ state, catalog }) => installCompiled(state, catalog, {
    ecName: decision.ecName,
    assetId: asset,
    signatureKey: decision.signatureKey,
    fragment: decision.fragment,
    operations: decision.operations,
    intercept: decision.intercept,
  }))
  if (!saved.ok) return JSON.stringify(saved)
  try {
    if (!bindSession(ctx, drive, exec.agent)) throw new Error('工具没有挂上')
  } catch (error) {
    withSession(ROOT(), sessionId, drive.threshold, ({ state, catalog }) => restoreSnapshot(state, catalog, snap))
    bindSession(ctx, drive, exec.agent)
    return JSON.stringify({ ok: false, code: 'NOT_INSTALLED', message: error instanceof Error ? error.message : 'NOT_INSTALLED' })
  }
  return JSON.stringify({ ok: true, kind: 'create', name: decision.ecName, asset_id: asset, sessionOnly: true })
}

/** 安装失败时回到同意之前的目录，拦截不能留下。 */
function sessionSnapshot(state, catalog) {
  return {
    tools: structuredClone(state.tools ?? {}),
    resumes: structuredClone(state.resumes ?? {}),
    compiled: structuredClone(catalog.compiled ?? {}),
    assets: structuredClone(catalog.assets ?? {}),
    intercepts: structuredClone(catalog.intercepts ?? []),
    owned: structuredClone(catalog.owned ?? {}),
  }
}

function restoreSnapshot(state, catalog, snap) {
  state.tools = snap.tools
  state.resumes = snap.resumes
  catalog.compiled = snap.compiled
  catalog.assets = snap.assets
  catalog.intercepts = snap.intercepts
  catalog.owned = snap.owned
}

function compiledRestoreReason(spec) {
  const name = spec.ecName ?? spec.name
  const tool = spec.tools?.[0] ?? '原工具'
  if (spec.staged) {
    return { zh: `取消 ${name} 尚未生效的修改。这一轮仍使用当前版本。`, en: `Discard the not-yet-applied change to ${name}. This turn keeps the current version.` }
  }
  if (spec.previous) {
    return { zh: `把 ${name} 退回上一版。`, en: `Roll ${name} back one version.` }
  }
  return {
    zh: `卸掉 ${name}，并重新允许直接调用 ${tool}。只影响当前会话。这一轮结束前仍按旧规则拦截，结束后原工具可以再被直接调用。`,
    en: `Remove ${name} and allow direct calls to ${tool} again in this session. The old rule stays until this turn ends.`,
  }
}

function compiledParameters(spec) {
  const parameters = {}
  for (const step of spec.steps ?? []) {
    for (const slot of step.slots ?? []) {
      if (parameters[slot.name]) continue
      const type = slot.type === 'boolean' || slot.type === 'number' || slot.type === 'string' ? slot.type : 'string'
      parameters[slot.name] = { type, description: `槽位 ${slot.name}。只在被校验的两次绑定上有参照。` }
    }
  }
  parameters.resume_token = { type: 'string', description: '遇到模型步之后，用同一个工具继续时带上。' }
  parameters.step_output = { type: 'string', description: '刚刚完成的模型步输出。' }
  return parameters
}

/** ec_ 的执行定义。内层调用只旁路该步的工具名，不计成功也不计摩擦。 */
function compiledDefinition(ctx, drive, spec) {
  return {
    name: spec.name,
    description: `经验编译：${(spec.tools ?? []).join(' → ')}`.slice(0, 180),
    parameters: compiledParameters(spec),
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          exitCode: { type: 'integer' },
          failed: { type: 'boolean' },
          truncated: { type: 'boolean' },
          partial: { type: 'boolean' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
    },
    async execute(args, exec) {
      const sessionId = drive.sessionOf(exec)
      if (!sessionId) return { text: '缺少会话', failed: true }
      const record = readSession(ROOT(), sessionId, drive.threshold).catalog.compiled?.[spec.name]
      const current = visibleCompiled(record)
      if (!current?.operations) return { text: '这个工具已撤回', failed: true }
      const resumeId = args?.resume_token
      const resume = resumeId ? readSession(ROOT(), sessionId, drive.threshold).state.resumes?.[resumeId] : null
      if (resumeId && (!resume || resume.ecName !== spec.name)) return { text: '恢复令牌无效', failed: true }
      const outcome = await executeCompiled(current, {
        slots: args ?? {},
        resume: Boolean(resume),
        cursor: resume?.cursor,
        outputs: resume?.outputs,
        storedSlots: resume?.slots,
        stepOutput: args?.step_output,
      }, async (call) => {
        const callId = `${exec.callId}:${call.step?.id ?? 'step'}`
        drive.bypass.set(callId, call.name)
        try {
          const batch = await ctx.tools.execute({
            calls: [{ type: 'tool-call', id: callId, name: call.name, arguments: JSON.stringify(call.arguments ?? {}) }],
            agent: exec.agent,
            signal: exec.signal,
          })
          const result = batch?.results?.[0]?.result
          const text = (result?.content ?? []).map((block) => block?.text ?? '').filter(Boolean).join('\n')
          return {
            output: text,
            exitCode: typeof result?.value?.exitCode === 'number' ? result.value.exitCode : undefined,
            failed: result?.isError === true || result?.value?.failed === true,
            truncated: result?.value?.truncated === true || result?.value?.partial === true,
            fileHash: result?.value?.fileHash ?? null,
          }
        } finally {
          drive.bypass.delete(callId)
        }
      })
      if (!outcome.ok) {
        if (outcome.code === 'STEP_FAILED' || outcome.code === 'NOT_PROGRAM') {
          withSession(ROOT(), sessionId, drive.threshold, ({ catalog }) => {
            markStepAgent(catalog, spec.name, outcome.step)
          })
        }
        return {
          text: JSON.stringify({ ok: false, failed: true, code: outcome.code, step: outcome.step, completed: outcome.completed ?? [], missing: outcome.missing }),
          failed: true,
        }
      }
      if (outcome.stopped && outcome.resumeToken) {
        withSession(ROOT(), sessionId, drive.threshold, ({ state }) => {
          state.resumes = state.resumes ?? {}
          state.resumes[outcome.resumeToken] = {
            ecName: spec.name,
            cursor: outcome.cursor,
            outputs: outcome.outputs,
            slots: outcome.slots,
          }
        })
      }
      return {
        text: JSON.stringify({
          ok: true,
          outputs: outcome.outputs,
          resume_token: outcome.resumeToken,
          remaining: outcome.remaining,
          completed: outcome.completed,
        }),
        failed: false,
      }
    },
  }
}

async function askApproval(ctx, exec, tool, reason, copy) {
  const approval = ctx.get?.('approval')
  if (!approval?.request || !exec?.agent) return 'unavailable'
  try {
    return await approval.request({
      agent: exec.agent,
      toolName: tool,
      callId: exec.callId,
      reason,
      displayReason: { en: copy?.en ?? reason, zh: copy?.zh ?? reason },
    })
  } catch {
    return 'unavailable'
  }
}
