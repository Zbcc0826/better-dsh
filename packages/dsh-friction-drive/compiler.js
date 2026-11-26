/**
 * 经验编译的纯逻辑。
 * 只对照已经记下的调用做判断，这里不执行原工具，也不弹审批。
 */
import { randomBytes } from 'node:crypto'
import { freshTool, isUnregisteredCall, noteCall, OWNED_NAME, commandFailed } from './logic.js'
import { ensureIdentity } from './score.js'
import { fillTemplate, shellQuote } from './owned-runtime.js'

/**
 * 只读工具的效果就是已经保存的正文。
 * 写入、删除、发送以及名单外的工具不能变成会执行的程序步。
 */
const READONLY_TOOLS = new Set(['read', 'grep'])

/** 审批卡超过这个长度就拒绝安装，不允许截断后继续。 */
export const CARD_LIMIT = 8000

/** 轨迹太长时丢掉最早的记录，避免一次会话无限长大。 */
const TRACE_LIMIT = 180

const POST_KEYS = new Set(['exitCode', 'truncated', 'outputIncludes', 'fileHash', 'failed'])

/**
 * 对象键排序后的 JSON。常量比较和签名都用它，避免键顺序把常量看成槽位。
 * @param {unknown} value 任意 JSON 值
 */
export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value))
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key])
    return out
  }
  return value
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** JSON 类型。数字不拆成整数，避免 1 和 1.5 被当成不同类型。 */
function jsonType(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'object') return 'object'
  return typeof value
}

/** 把嵌套对象拆成叶子路径。空对象本身算一个叶子，不把整颗对象收成槽位。 */
function leafMap(value, prefix = '', out = {}) {
  if (Array.isArray(value)) {
    if (value.length === 0) out[prefix] = value
    else value.forEach((item, index) => leafMap(item, prefix ? `${prefix}.${index}` : String(index), out))
    return out
  }
  if (plainObject(value)) {
    const keys = Object.keys(value).sort()
    if (keys.length === 0) out[prefix] = value
    else for (const key of keys) leafMap(value[key], prefix ? `${prefix}.${key}` : key, out)
    return out
  }
  out[prefix] = value
  return out
}

function getPath(value, path) {
  if (!path) return value
  let current = value
  for (const part of path.split('.')) {
    if (current == null) return undefined
    current = current[part]
  }
  return current
}

function setPath(target, path, value) {
  const parts = path.split('.')
  let current = target
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index]
    if (!plainObject(current[part]) && !Array.isArray(current[part])) current[part] = /^\d+$/.test(parts[index + 1]) ? [] : {}
    current = current[part]
  }
  current[parts[parts.length - 1]] = value
}

function safeArgs(value) {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return plainObject(parsed) ? parsed : { value: parsed }
    } catch {
      return { value }
    }
  }
  return plainObject(value) ? value : {}
}

function tokenize(text) {
  return String(text).match(/\s+|\S+/g) ?? []
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 把带 {{槽位}} 的命令变成整串匹配。槽位只吃一段不包含空白的文本。 */
function templateToRegExp(template) {
  const names = []
  const source = `^${String(template).split(/(\{\{[a-zA-Z0-9_]+\}\})/).map((part) => {
    const slot = /^\{\{([a-zA-Z0-9_]+)\}\}$/.exec(part)
    if (slot) {
      names.push(slot[1])
      return '(\\S+)'
    }
    return escapeRegExp(part)
  }).join('')}$`
  return { re: new RegExp(source), names }
}

function templateFits(template, command) {
  return templateToRegExp(template).re.test(String(command ?? ''))
}

/**
 * 把一次调用收成轨迹记录。
 * 能进片段的只有外部工具的成功调用：没截断、不是参数错误、正文也没有非零退出码。
 * @param {object} event 工具返回后能看到的事实
 */
export function classifyCall(event) {
  const output = String(event.output ?? '')
  const args = safeArgs(event.args)
  let exitCode = typeof event.exitCode === 'number' ? event.exitCode : null
  if (exitCode === null) {
    const matched = /\[exit code: (\d+)\]/.exec(output)
    if (matched) exitCode = Number(matched[1])
  }
  const firstLine = output.split('\n', 1)[0]
  const found = /^Found (\d+) of (\d+) matches$/.exec(firstLine)
  const truncated = event.truncated === true || Boolean(found && Number(found[1]) < Number(found[2]))
  const invalid = event.invalid === true
  const bodyFailed = commandFailed(output)
  const numericFail = typeof exitCode === 'number' && exitCode !== 0
  const explicitFail = event.ok === false || event.failed === true || event.isError === true
  const breakpoint = Boolean(event.own || event.registered || event.bypass || event.parallel || event.compiled || invalid)
  const eligible = !breakpoint && !truncated && !bodyFailed && !numericFail && !explicitFail
  return {
    id: event.id,
    tool: String(event.tool ?? ''),
    args,
    output,
    exitCode,
    truncated,
    invalid,
    fileHash: event.fileHash ?? null,
    failed: explicitFail || bodyFailed || numericFail,
    own: Boolean(event.own),
    registered: Boolean(event.registered),
    bypass: Boolean(event.bypass),
    parallel: Boolean(event.parallel),
    compiled: Boolean(event.compiled),
    callId: event.callId ?? null,
    eligible,
    time: event.time ?? 0,
  }
}

/** 往会话轨迹里追加一条。任何调用都记，包括失败和本插件自己的工具。 */
export function appendTrace(state, event) {
  state.trace = state.trace ?? []
  state.traceSeq = (state.traceSeq ?? 0) + 1
  const record = classifyCall({ ...event, id: state.traceSeq })
  state.trace.push(record)
  if (state.trace.length > TRACE_LIMIT) state.trace.splice(0, state.trace.length - TRACE_LIMIT)
  return record
}

/** 由测试直接把若干事件收成轨迹。 */
export function traceFrom(events) {
  return events.map((event, index) => classifyCall({ ...event, id: event.id ?? index + 1, time: event.time ?? index }))
}

function diffCommand(left, right, stepIndex, path) {
  const leftParts = tokenize(left)
  const rightParts = tokenize(right)
  if (leftParts.length === 0 || leftParts.length !== rightParts.length) return { kind: 'slot' }
  let slotCount = 0
  let constantTokens = 0
  let template = ''
  const slots = []
  const stem = path.replace(/[^a-zA-Z0-9_]/g, '_')
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      if (/^\s+$/.test(leftParts[index]) || /^\s+$/.test(rightParts[index])) return { kind: 'slot' }
      const name = `p${stepIndex}_${stem}_${slotCount}`
      slotCount += 1
      slots.push({ path, type: 'string', name, fragment: true })
      template += `{{${name}}}`
    } else {
      template += leftParts[index]
      if (leftParts[index].trim() !== '') constantTokens += 1
    }
  }
  if (slotCount === 0) return { kind: 'same' }
  if (constantTokens === 0) return { kind: 'slot' }
  return { kind: 'template', template, slots }
}

/** 逐字段对比两次参数。缺字段或类型不同就不是同一片段。 */
function diffArgs(leftArgs, rightArgs, stepIndex) {
  const left = leafMap(leftArgs ?? {})
  const right = leafMap(rightArgs ?? {})
  const paths = Object.keys(left).sort()
  if (paths.join('\0') !== Object.keys(right).sort().join('\0')) return null
  const constants = []
  const slots = []
  let commandTemplate = null
  for (const path of paths) {
    const leftValue = left[path]
    const rightValue = right[path]
    if (jsonType(leftValue) !== jsonType(rightValue)) return null
    if (canonicalJson(leftValue) === canonicalJson(rightValue)) {
      constants.push({ path, value: leftValue, template: false })
      if (path === 'command' && typeof leftValue === 'string') commandTemplate = leftValue
      continue
    }
    if (typeof leftValue === 'string' && typeof rightValue === 'string') {
      const templated = diffCommand(leftValue, rightValue, stepIndex, path)
      if (templated.kind === 'template') {
        constants.push({ path, value: templated.template, template: true })
        slots.push(...templated.slots)
        if (path === 'command') commandTemplate = templated.template
        continue
      }
    }
    const name = `p${stepIndex}_${path.replace(/[^a-zA-Z0-9_]/g, '_')}`
    slots.push({ path, type: jsonType(leftValue), name, fragment: false })
    if (path === 'command' && typeof leftValue === 'string') commandTemplate = `{{${name}}}`
  }
  return { constants, slots, commandTemplate }
}

function alignSteps(left, right) {
  if (left.length !== right.length) return null
  const steps = []
  for (let index = 0; index < left.length; index += 1) {
    if (left[index].tool !== right[index].tool) return null
    const diff = diffArgs(left[index].args, right[index].args, index)
    if (!diff) return null
    steps.push({ tool: left[index].tool, ...diff })
  }
  const signature = {
    tools: steps.map((step) => step.tool),
    steps,
    requiredEdges: mergeEdges(edgesOf(left), edgesOf(right)),
    bindings: [left, right],
  }
  for (const edge of signature.requiredEdges) attachEdgeSlot(edge, signature, left)
  return signature
}

function edgesOf(occurrence) {
  const edges = []
  for (let index = 1; index < occurrence.length; index += 1) {
    const previous = String(occurrence[index - 1].output ?? '')
    if (!previous) continue
    for (const [path, value] of Object.entries(leafMap(occurrence[index].args))) {
      if (typeof value === 'string' && value.includes(previous)) edges.push({ from: index - 1, to: index, path, sample: previous })
    }
  }
  return edges
}

function mergeEdges(left, right) {
  const merged = []
  for (const edge of [...left, ...right]) {
    if (!merged.some((item) => item.from === edge.from && item.to === edge.to && item.path === edge.path)) merged.push({ ...edge })
  }
  return merged
}

function attachEdgeSlot(edge, signature, occurrence) {
  const step = signature.steps[edge.to]
  const args = occurrence[edge.to]?.args ?? {}
  for (const slot of step.slots) {
    const token = slot.fragment
      ? extractSlot(step.commandTemplate, getPath(args, slot.path), slot.name)
      : getPath(args, slot.path)
    if (token === edge.sample) edge.slot = slot.name
  }
}

function extractSlot(template, command, name) {
  if (!template) return undefined
  const parsed = templateToRegExp(template)
  const matched = parsed.re.exec(String(command ?? ''))
  if (!matched) return undefined
  const index = parsed.names.indexOf(name)
  return index >= 0 ? matched[index + 1] : undefined
}

function sameTools(left, right) {
  return left.length === right.length && left.every((step, index) => step.tool === right[index].tool)
}

/**
 * 记下每一段实心的相邻重复。
 * 更长的重复先占住区间，短窗口不能再在里面划缝，免得把包住它的长程序切开。
 * 没有被更长重复占住的短程序仍然留缝，避免窗口跨过两段无关任务。
 */
function repetitionSeams(segment) {
  const total = segment.length
  const seams = []
  const claimed = []
  const overlaps = (start, end) => claimed.some((span) => start < span.end && end > span.start)
  for (let len = Math.min(6, Math.floor(total / 2)); len >= 2; len -= 1) {
    for (let index = 0; index + 2 * len <= total;) {
      const left = segment.slice(index, index + len)
      const right = segment.slice(index + len, index + 2 * len)
      const aligned = sameTools(left, right) ? alignSteps(left, right) : null
      // 整段命令都变成槽位时，工具名相同不算同一次重复，也不能当成接缝。
      if (aligned && solidSteps(aligned) && !overlaps(index, index + 2 * len)) {
        seams.push(index + len)
        claimed.push({ start: index, end: index + 2 * len })
        index += 2 * len
      } else index += 1
    }
  }
  return seams
}

function crosses(start, len, seams) {
  return seams.some((seam) => start < seam && start + len > seam)
}

function splitSegments(trace) {
  const segments = []
  let current = []
  for (const record of trace) {
    if (!record.eligible) {
      if (current.length > 0) segments.push(current)
      current = []
    } else current.push(record)
  }
  if (current.length > 0) segments.push(current)
  return segments
}

function windowsIn(segment) {
  const seams = repetitionSeams(segment)
  const found = []
  const total = segment.length
  for (let len = 2; len <= Math.min(6, total); len += 1) {
    for (let index = 0; index + len <= total; index += 1) {
      if (crosses(index, len, seams)) continue
      const records = segment.slice(index, index + len)
      found.push({ len, records, ids: records.map((record) => record.id) })
    }
  }
  return found
}

function idsOverlap(left, right) {
  const seen = new Set(left)
  return right.some((id) => seen.has(id))
}

function allSlotPassthrough(signature) {
  const constants = signature.steps.some((step) => step.constants.length > 0)
  const slots = signature.steps.some((step) => step.slots.length > 0)
  return slots && !constants
}

/** 任一步没有常量，就只是工具名相同，不是同一段程序。 */
function solidSteps(signature) {
  return signature.steps.every((step) => (step.constants ?? []).length > 0)
}

/** 两次保存的正文必须全等，退出码相同不够。 */
function outputsAgree(bindings) {
  const outputs = (bindings ?? []).map((item) => String(item?.output ?? ''))
  return outputs.length >= 2 && outputs.every((item) => item === outputs[0])
}

/**
 * 程序步必须能用已保存的正文独立验收。
 * bash 要有观察到的命令模板。其他工具必须只读，并且正文非空或文件哈希一致。
 * @param {object} step 对齐后的一步
 * @param {object[]} bindings 这一步的两次保存结果
 */
function canBeProgram(step, bindings) {
  if (!step || !outputsAgree(bindings)) return false
  const exits = bindings.map((item) => (item?.exitCode === undefined ? null : item.exitCode))
  if (!exits.every((item) => item === exits[0])) return false
  if (step.tool === 'bash') return typeof step.commandTemplate === 'string' && step.commandTemplate.length > 0
  if (!READONLY_TOOLS.has(step.tool)) return false
  const hashes = bindings.map((item) => item?.fileHash ?? null)
  const hashAgreed = hashes.every((item) => item && item === hashes[0])
  const body = bindings.every((item) => String(item?.output ?? '').length > 0)
  return hashAgreed || body
}

function jsonConstants(signature) {
  return signature.steps.flatMap((step, index) => step.constants.filter((item) => !item.template).map((item) => ({ ...item, step: index })))
}

function jsonSlots(signature) {
  return signature.steps.flatMap((step, index) => step.slots
    .filter((item) => !item.fragment)
    .map((item) => ({ ...item, step: index })))
}

/** 有槽位又有普通常量时，后一次把常量跑成别的值，这份签名作废。纯常量的另一条命令是另一份程序。 */
function contradicted(windows, signature) {
  const constants = jsonConstants(signature)
  const slots = jsonSlots(signature)
  if (constants.length === 0 || slots.length === 0) return false
  const len = signature.tools.length
  for (const window of windows) {
    if (window.len !== len) continue
    if (!signature.tools.every((tool, index) => window.records[index].tool === tool)) continue
    let sameShape = true
    let broken = false
    for (const constant of constants) {
      const value = getPath(window.records[constant.step].args, constant.path)
      if (canonicalJson(value) !== canonicalJson(constant.value)) broken = true
    }
    for (const slot of slots) {
      const value = getPath(window.records[slot.step].args, slot.path)
      if (jsonType(value) !== slot.type) sameShape = false
    }
    if (sameShape && broken) return true
  }
  return false
}

function toolKey(tools) {
  return tools.join('\0')
}

function constantKey(step) {
  return canonicalJson((step.constants ?? []).map((item) => ({
    path: item.path,
    value: item.value,
    template: Boolean(item.template),
  })))
}

/** 短片段只有在常量和工具都与更长片段的连续步相同时才丢掉。常量不同的短程序留下。 */
function containsProgram(shorter, longer) {
  if (!shorter?.steps || !longer?.steps || shorter.steps.length >= longer.steps.length) return false
  for (let index = 0; index + shorter.steps.length <= longer.steps.length; index += 1) {
    const matched = shorter.steps.every((step, offset) => {
      const other = longer.steps[index + offset]
      return step.tool === other.tool && constantKey(step) === constantKey(other)
    })
    if (matched) return true
  }
  return false
}

/**
 * 从轨迹里取成熟片段。
 * 只保留互不重叠的最长片段；正文失败、截断、参数错误和本插件工具都会把序列切开。
 * @param {object[]} trace classifyCall 产生的记录
 * @param {{ gatedTools?: Set<string>, successorTools?: Set<string> }} [options]
 */
export function matureFragments(trace, options = {}) {
  const gated = options.gatedTools ?? new Set()
  const successors = options.successorTools ?? new Set()
  const windows = splitSegments(trace ?? []).flatMap(windowsIn)
  const grouped = new Map()
  for (const window of windows) {
    const key = toolKey(window.records.map((record) => record.tool))
    if (!grouped.has(key)) grouped.set(key, [])
    grouped.get(key).push(window)
  }
  const found = []
  for (const group of grouped.values()) {
    const seen = new Set()
    for (let left = 0; left < group.length; left += 1) {
      for (let right = left + 1; right < group.length; right += 1) {
        if (group[left].len !== group[right].len) continue
        if (idsOverlap(group[left].ids, group[right].ids)) continue
        const aligned = alignSteps(group[left].records, group[right].records)
        if (!aligned || allSlotPassthrough(aligned) || !solidSteps(aligned)) continue
        if (contradicted(group, aligned)) continue
        const key = structuralKey(aligned)
        if (seen.has(key)) continue
        seen.add(key)
        aligned.occurrenceCount = countFits(group, aligned)
        if (aligned.occurrenceCount < 2) continue
        found.push(aligned)
      }
    }
  }
  const kept = found.filter((fragment) => !found.some((other) => containsProgram(fragment, other)))
  return kept.filter((fragment) => !gated.has(fragment.tools[0]) && !successors.has(fragment.tools[0]))
}

function countFits(windows, signature) {
  const used = new Set()
  let count = 0
  const ordered = [...windows].filter((window) => window.len === signature.tools.length).sort((left, right) => left.ids[0] - right.ids[0])
  for (const window of ordered) {
    if (window.ids.some((id) => used.has(id))) continue
    if (!signature.tools.every((tool, index) => window.records[index].tool === tool)) continue
    if (!windowFits(window.records, signature)) continue
    window.ids.forEach((id) => used.add(id))
    count += 1
  }
  return count
}

function windowFits(records, signature) {
  if (!signature.tools.every((tool, index) => records[index]?.tool === tool)) return false
  for (let index = 0; index < signature.steps.length; index += 1) {
    if (fitStep(records[index].args, signature.steps[index]) !== 'match') return false
  }
  return true
}

function fitStep(args, step) {
  for (const constant of step.constants) {
    const value = getPath(args, constant.path)
    if (constant.template) {
      if (typeof value !== 'string' || !templateFits(constant.value, value)) return 'constant-mismatch'
    } else if (canonicalJson(value) !== canonicalJson(constant.value)) return 'constant-mismatch'
  }
  for (const slot of step.slots) {
    if (slot.fragment) continue
    const value = getPath(args, slot.path)
    if (value === undefined || jsonType(value) !== slot.type) return 'shape-mismatch'
  }
  return 'match'
}

/** 签名含工具顺序、常量、槽位，以及由两次保存结果推出的后置。fd_ 不读这把钥匙。 */
export function structuralKey(signature) {
  const posts = (signature.bindings ?? []).length
    ? signature.steps.map((_, index) => postFor(signature.bindings.map((occurrence) => occurrence[index])))
    : []
  return canonicalJson({
    tools: signature.tools,
    constants: signature.steps.flatMap((step, index) => step.constants.map((item) => ({
      step: index,
      path: item.path,
      value: item.value,
      template: Boolean(item.template),
    }))),
    slots: signature.steps.flatMap((step, index) => step.slots.map((item) => ({
      step: index,
      path: item.path,
      type: item.type,
      fragment: Boolean(item.fragment),
    }))),
    post: posts,
  })
}

/** 停用的资产不参与匹配。常量值不同则结构键不同，不能复用。 */
export function matchAssets(assets, signature) {
  const key = structuralKey(signature)
  return Object.values(assets ?? {}).filter((asset) => asset && asset.enabled !== false && asset.structuralKey === key)
}

function postShape(post) {
  return plainObject(post) && Object.keys(post).length > 0 && Object.keys(post).every((key) => POST_KEYS.has(key))
}

/** 后置必须能被保存结果否决。空对象、空子串和换一批数据仍然成立的写法都拒绝。 */
export function postHolds(post, saved) {
  if (!postShape(post)) return false
  if (Object.prototype.hasOwnProperty.call(post, 'outputIncludes')) {
    if (typeof post.outputIncludes !== 'string' || post.outputIncludes.trim() === '') return false
    if (!String(saved?.output ?? '').includes(post.outputIncludes)) return false
  }
  if (Object.prototype.hasOwnProperty.call(post, 'exitCode')) {
    if (typeof saved?.exitCode !== 'number' || post.exitCode !== saved.exitCode) return false
  }
  if (Object.prototype.hasOwnProperty.call(post, 'truncated') && Boolean(post.truncated) !== Boolean(saved?.truncated)) return false
  if (Object.prototype.hasOwnProperty.call(post, 'failed') && Boolean(post.failed) !== Boolean(saved?.failed)) return false
  if (Object.prototype.hasOwnProperty.call(post, 'fileHash')) {
    if (!saved?.fileHash || post.fileHash !== saved.fileHash) return false
  }
  return true
}

function judgePost(post, records) {
  if (!postShape(post)) return { ok: false, reason: 'tautology' }
  if (Object.prototype.hasOwnProperty.call(post, 'outputIncludes') && (typeof post.outputIncludes !== 'string' || post.outputIncludes.trim() === '')) {
    return { ok: false, reason: 'tautology' }
  }
  const spoiled = [
    { output: 'EC_SPOIL_A', exitCode: 7, truncated: true, failed: true, fileHash: 'EC_SPOIL_A' },
    { output: 'EC_SPOIL_B', exitCode: 8, truncated: false, failed: false, fileHash: 'EC_SPOIL_B' },
  ]
  if (spoiled.every((item) => postHolds(post, item))) return { ok: false, reason: 'tautology' }
  if (!records.every((record) => postHolds(post, record))) return { ok: false, reason: 'post' }
  return { ok: true }
}

function judgePre(pre, bindings = []) {
  if (pre == null || (plainObject(pre) && Object.keys(pre).length === 0)) return { ok: true }
  if (!plainObject(pre)) return { ok: false, reason: 'pre' }
  if (Object.keys(pre).some((key) => key !== 'argsEquals')) return { ok: false, reason: 'pre' }
  const blob = canonicalJson(pre)
  if (blob.includes('cwd') || blob.includes('env') || blob.includes('directory') || blob.includes('workdir') || blob.includes('环境')) {
    return { ok: false, reason: 'pre' }
  }
  if (pre.argsEquals !== undefined) {
    if (!plainObject(pre.argsEquals)) return { ok: false, reason: 'pre' }
    const claimed = leafMap(pre.argsEquals)
    for (const binding of bindings) {
      for (const [path, value] of Object.entries(claimed)) {
        if (canonicalJson(getPath(binding?.args, path)) !== canonicalJson(value)) return { ok: false, reason: 'pre-unobserved' }
      }
    }
  }
  return { ok: true }
}

/** 失败步的新脚本不要求等于旧模板。写入类委托在这里也不能变成程序步。 */
function checkRevisedRun(operation, step) {
  const run = operation.run
  if (!plainObject(run)) return { ok: false, reason: 'run' }
  if (step.tool === 'bash') {
    if (run.kind !== 'script' || typeof run.command !== 'string' || run.command.trim() === '') return { ok: false, reason: 'run' }
    return { ok: true }
  }
  if (!READONLY_TOOLS.has(step.tool)) return { ok: false, reason: 'not-readonly' }
  return checkRun(operation, step, [])
}

function failedScript(run) {
  if (run?.kind === 'script') return String(run.command ?? '')
  return canonicalJson(run ?? null)
}

function checkRun(operation, step, bindings) {
  const run = operation.run
  if (!plainObject(run)) return { ok: false, reason: 'run' }
  if (run.kind === 'script') {
    if (step.tool !== 'bash') return { ok: false, reason: 'script-not-bash' }
    if (!step.commandTemplate || run.command !== step.commandTemplate) return { ok: false, reason: 'script-mismatch' }
    for (const binding of bindings) {
      if (!templateFits(run.command, getPath(binding.args, 'command'))) return { ok: false, reason: 'script-mismatch' }
    }
    return { ok: true }
  }
  if (run.kind !== 'delegate') return { ok: false, reason: 'run' }
  if (step.tool === 'bash') return { ok: false, reason: 'bash-needs-script' }
  if (run.tool !== step.tool) return { ok: false, reason: 'delegate-tool' }
  const overrides = plainObject(run.overrides) ? run.overrides : {}
  const expected = {}
  for (const constant of step.constants) {
    if (constant.template) continue
    setPath(expected, constant.path, constant.value)
  }
  if (canonicalJson(overrides) !== canonicalJson(expected)) return { ok: false, reason: 'overrides' }
  return { ok: true }
}

function normalizeOperations(contract) {
  if (!plainObject(contract) || !Array.isArray(contract.operations) || !Array.isArray(contract.order)) return null
  if (contract.order.length !== contract.operations.length) return null
  const byId = new Map(contract.operations.map((operation) => [operation?.id, operation]))
  const operations = []
  for (const id of contract.order) {
    const operation = byId.get(id)
    if (!operation || (operation.mode !== 'program' && operation.mode !== 'agent')) return null
    operations.push(operation)
  }
  return operations
}

function fragmentMatches(fragment, operations, contract) {
  if (fragment.tools.length !== operations.length) return false
  if (!fragment.tools.every((tool, index) => operations[index].tool === tool)) return false
  const constants = Array.isArray(contract.constants) ? contract.constants : []
  const slots = Array.isArray(contract.slots) ? contract.slots : []
  for (let index = 0; index < fragment.steps.length; index += 1) {
    const expectedConstants = fragment.steps[index].constants
    const gotConstants = constants.filter((item) => item?.step === index)
    if (gotConstants.length !== expectedConstants.length) return false
    for (const expected of expectedConstants) {
      const got = gotConstants.find((item) => item.path === expected.path)
      if (!got || canonicalJson(got.value) !== canonicalJson(expected.value)) return false
    }
    const expectedSlots = fragment.steps[index].slots
    const gotSlots = slots.filter((item) => item?.step === index)
    if (gotSlots.length !== expectedSlots.length) return false
    for (const expected of expectedSlots) {
      const got = gotSlots.find((item) => item.path === expected.path && item.name === expected.name && item.type === expected.type)
      if (!got) return false
    }
  }
  return true
}

function edgesSatisfied(fragment, operations, contract) {
  const edges = Array.isArray(contract.edges) ? contract.edges : []
  for (const required of fragment.requiredEdges) {
    const from = operations[required.from]?.id
    const to = operations[required.to]?.id
    if (!edges.some((edge) => edge?.from === from && edge?.to === to && edge?.path === required.path)) return false
  }
  return true
}

function assetView(asset) {
  return {
    asset_id: asset.id,
    constants: asset.constants,
    pre: asset.pre,
    post: asset.post,
  }
}

function resolveAsset(assets, signature, assetId) {
  const matches = matchAssets(assets, signature)
  const listed = matches.map(assetView)
  if (matches.length === 0) {
    if (assetId) return { ok: false, code: 'ASSET_UNEXPECTED', candidates: [] }
    return { ok: true, mode: 'create', matches }
  }
  if (matches.length === 1) {
    if (assetId !== matches[0].id) return { ok: false, code: 'ASSET_REQUIRED', candidates: listed }
    return { ok: true, mode: 'reuse', asset: matches[0], matches }
  }
  if (!assetId) return { ok: false, code: 'ASSET_AMBIGUOUS', candidates: listed }
  const chosen = matches.find((asset) => asset.id === assetId)
  if (!chosen) return { ok: false, code: 'ASSET_UNKNOWN', candidates: listed }
  return { ok: true, mode: 'reuse', asset: chosen, matches }
}

/**
 * 按步写出全部脚本和覆盖值。写不下就不返回截断后的卡片。
 * @param {object} input 即将注册的名字和合同
 */
export function compiledCopy(input) {
  const steps = input.operations.map((operation, index) => {
    const action = operation.mode === 'agent'
      ? '留给模型'
      : operation.run?.kind === 'script'
        ? `脚本 ${operation.run.command}`
        : `调用 ${operation.run?.tool ?? ''}，覆盖 ${JSON.stringify(operation.run?.overrides ?? {})}`
    return `步骤 ${index + 1} ${operation.mode} ${operation.tool}：${action}`
  })
  const zh = [
    `允许为当前会话安装工具 ${input.ecName}。`,
    '这是给当前会话安装工具，不是放行这一次调用。',
    `之后第一步在常量匹配时会被拒绝并改走 ${input.ecName}。`,
    '只影响当前会话。',
    '槽位只在被校验的两次绑定上有参照。',
    `序列：${input.tools.join(' → ')}`,
    ...steps,
  ].join('\n')
  const en = [
    `Allow installing session tool ${input.ecName}.`,
    'This installs a tool for the current session. It does not approve this one call.',
    `Later, a direct call is rejected when the first step and its constants match, and must use ${input.ecName}.`,
    'This affects only the current session.',
    'Slots are checked only against the two validated bindings.',
    `Sequence: ${input.tools.join(' -> ')}`,
    ...input.operations.map((operation, index) => `Step ${index + 1} ${operation.mode} ${operation.tool}: ${operation.run?.command ?? JSON.stringify(operation.run?.overrides ?? {})}`),
  ].join('\n')
  if (zh.length > CARD_LIMIT || en.length > CARD_LIMIT) return { ok: false, code: 'CARD_TOO_LONG' }
  return { ok: true, zh, en }
}

/**
 * 程序步的验收。revised 为真时，失败步可以换一份 bash 脚本，但后置必须钉住已保存正文。
 * 不调用原工具。
 */
function validateProgram(operation, step, bindings, schema, revised = false) {
  if (!canBeProgram(step, bindings)) {
    const reason = step?.tool !== 'bash' && !READONLY_TOOLS.has(step?.tool) ? 'not-readonly' : 'post-not-independent'
    return { ok: false, code: 'STEP_MUST_BE_AGENT', step: operation.id, reason }
  }
  const pre = judgePre(operation.pre, bindings)
  if (!pre.ok) return { ok: false, code: 'STEP_MUST_BE_AGENT', step: operation.id, reason: pre.reason }
  if (revised && step.tool === 'bash') {
    const claimed = operation.post ?? {}
    if (!Object.prototype.hasOwnProperty.call(claimed, 'outputIncludes') && !Object.prototype.hasOwnProperty.call(claimed, 'fileHash')) {
      return { ok: false, code: 'STEP_MUST_BE_AGENT', step: operation.id, reason: 'post-not-independent' }
    }
  }
  const post = judgePost(operation.post, bindings)
  if (!post.ok) return { ok: false, code: 'STEP_MUST_BE_AGENT', step: operation.id, reason: post.reason }
  const run = revised ? checkRevisedRun(operation, step) : checkRun(operation, step, bindings)
  if (!run.ok) return { ok: false, code: 'STEP_MUST_BE_AGENT', step: operation.id, reason: run.reason }
  if (operation.run?.kind === 'delegate') {
    if (typeof schema !== 'function') return { ok: false, code: 'STEP_MUST_BE_AGENT', step: operation.id, reason: 'schema' }
    const invalid = schema(operation.run.overrides)
    if (invalid) return { ok: false, code: 'STEP_MUST_BE_AGENT', step: operation.id, reason: invalid }
  }
  return { ok: true }
}

/**
 * 审批前的全部判断。不调用原工具，不跑脚本。
 * @param {object} input 轨迹、合同、资产和可选的已装工具
 */
export function assessCompiledProposal(input) {
  const contract = input.contract
  const operations = normalizeOperations(contract)
  if (!operations) return { ok: false, code: 'BAD_CONTRACT' }
  if (operations.some((operation) => input.registeredTools?.has?.(operation.tool))) return { ok: false, code: 'REGISTERED' }
  if (input.reviseStep || contract.revise_step) return assessRevision(input, operations)
  const fragments = matureFragments(input.trace ?? [], {
    gatedTools: input.gatedTools,
    successorTools: input.successorTools,
  })
  const matches = fragments.filter((fragment) => fragmentMatches(fragment, operations, contract))
  if (matches.length === 0) return { ok: false, code: 'NOT_MATURE' }
  matches.sort((left, right) => right.tools.length - left.tools.length)
  const fragment = matches[0]
  if (allSlotPassthrough(fragment)) return { ok: false, code: 'NOT_A_PROGRAM' }
  const first = fragment.tools[0]
  if (input.gatedTools?.has?.(first) || input.successorTools?.has?.(first)) return { ok: false, code: 'FRICTION_OWNS' }
  if (!edgesSatisfied(fragment, operations, contract)) return { ok: false, code: 'EDGE_REQUIRED' }
  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index]
    if (operation.mode === 'agent') continue
    const bindings = fragment.bindings.map((occurrence) => occurrence[index])
    const checked = validateProgram(operation, fragment.steps[index], bindings, input.schemas?.[operation.tool])
    if (!checked.ok) return checked
  }
  if (!operations.some((operation) => operation.mode === 'program')) return { ok: false, code: 'NOT_A_PROGRAM' }
  const assetId = input.assetId || contract.asset_id || ''
  const resolved = resolveAsset(input.assets, fragment, assetId)
  if (!resolved.ok) return resolved
  if (resolved.mode === 'reuse') {
    const same = sameProgram(resolved.asset, operations)
    if (!same) return { ok: false, code: 'SCRIPT_LOCKED', asset_id: resolved.asset.id }
    return { ok: true, code: 'SAME_REVISION', assetMode: 'reuse', assetId: resolved.asset.id, ecName: resolved.asset.ecName }
  }
  if (!input.ecName || !OWNED_NAME.test(input.ecName)) return { ok: false, code: 'BAD_NAME' }
  const card = compiledCopy({ ecName: input.ecName, tools: fragment.tools, operations })
  if (!card.ok) return card
  return {
    ok: true,
    code: 'READY',
    assetMode: 'create',
    ecName: input.ecName,
    card,
    fragment,
    operations,
    signatureKey: structuralKey(fragment),
    intercept: interceptOf(input.ecName, fragment),
  }
}

function sameProgram(asset, operations) {
  const saved = asset.operations ?? []
  if (saved.length !== operations.length) return false
  for (let index = 0; index < operations.length; index += 1) {
    if (saved[index]?.mode !== operations[index].mode) return false
    if (canonicalJson(saved[index]?.run ?? null) !== canonicalJson(operations[index].run ?? null)) return false
  }
  return true
}

function edgeIdentity(edges) {
  const slim = (edges ?? []).map((edge) => ({ from: edge?.from, to: edge?.to, path: edge?.path }))
  slim.sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)))
  return canonicalJson(slim)
}

function assessRevision(input, operations) {
  const stepId = input.reviseStep || input.contract.revise_step
  const assetId = input.assetId || input.contract.asset_id || ''
  const spec = input.existing
  if (!spec || !stepId) return { ok: false, code: 'BAD_CONTRACT' }
  const current = spec.operations ?? spec.contract?.operations ?? []
  const target = current.find((operation) => operation.id === stepId)
  if (!target?.failedStep) return { ok: false, code: 'NOT_FAILED' }
  if (operations.length !== current.length) return { ok: false, code: 'STEP_LOCKED' }
  for (let index = 0; index < current.length; index += 1) {
    if (current[index].id === stepId) continue
    if (canonicalJson(current[index].run ?? null) !== canonicalJson(operations[index].run ?? null)) return { ok: false, code: 'STEP_LOCKED' }
    if (canonicalJson(current[index].pre ?? null) !== canonicalJson(operations[index].pre ?? null)) return { ok: false, code: 'STEP_LOCKED' }
    if (canonicalJson(current[index].post ?? null) !== canonicalJson(operations[index].post ?? null)) return { ok: false, code: 'STEP_LOCKED' }
  }
  const proposedEdges = edgeIdentity(input.contract.edges)
  const savedEdges = edgeIdentity(spec.contract?.edges ?? spec.edges)
  if (proposedEdges !== savedEdges) return { ok: false, code: 'STEP_LOCKED' }
  const index = operations.findIndex((operation) => operation.id === stepId)
  const operation = operations[index]
  if (!operation || operation.mode !== 'program') return { ok: false, code: 'STEP_MUST_BE_AGENT', step: stepId }
  const bindings = (spec.bindings ?? []).map((occurrence) => occurrence[index])
  if (bindings.length < 2) return { ok: false, code: 'STEP_MUST_BE_AGENT', step: stepId, reason: 'bindings' }
  if (failedScript(target.run) === failedScript(operation.run)) return { ok: false, code: 'NOT_REVISED', step: stepId }
  const checked = validateProgram(operation, spec.steps[index], bindings, input.schemas?.[operation.tool], true)
  if (!checked.ok) return checked
  if (assetId && spec.assetId && assetId !== spec.assetId) return { ok: false, code: 'ASSET_UNKNOWN' }
  const card = compiledCopy({ ecName: spec.ecName ?? spec.name, tools: spec.tools ?? operations.map((item) => item.tool), operations })
  if (!card.ok) return card
  const next = operations.map((item) => (item.id === stepId ? { ...item, failedStep: false } : item))
  return { ok: true, code: 'REVISE', assetMode: 'revise', ecName: spec.ecName ?? spec.name, card, operations: next, stepId }
}

function interceptOf(ecName, fragment) {
  return {
    ecName,
    firstTool: fragment.tools[0],
    step: fragment.steps[0],
    signatureKey: structuralKey(fragment),
  }
}

/** 模型直接调用时，工具名和第一步常量都对上才拦截。 */
export function interceptMatches(intercept, tool, args) {
  if (!intercept || intercept.firstTool !== tool) return false
  if ((intercept.step?.constants ?? []).length === 0) return false
  return fitStep(safeArgs(args), intercept.step) === 'match'
}

/** 工具名：ec_、最多 12 位缩写、时间戳，同一毫秒再加序号。 */
export function compiledName(tool, now = Date.now(), serial = 0) {
  const stem = String(tool).toLowerCase().replace(/[^a-z0-9_]+/g, '').slice(0, 12) || 'tool'
  const suffix = serial > 0 ? `_${serial}` : ''
  const prefix = `ec_${stem}_`
  const room = 41 - prefix.length - suffix.length
  return `${prefix}${String(now).slice(-Math.max(room, 1))}${suffix}`
}

/** 避开本进程已经占用的名字。没有合法名字时返回空字符串。 */
export function allocateCompiledName(tool, now, used) {
  for (let serial = 0; serial < 100; serial += 1) {
    const name = compiledName(tool, now, serial)
    if (!OWNED_NAME.test(name) || name.length > 41) continue
    if (used?.has?.(name)) continue
    return name
  }
  return ''
}

/**
 * 用片段的两次绑定生成一份能通过参照验收的合同。测试和说明用它核对形状。
 * @param {object} fragment matureFragments 的一项
 * @param {Record<number, string>} [modes] 把某些步显式标成 agent
 */
export function contractFor(fragment, modes = {}) {
  const operations = fragment.steps.map((step, index) => {
    const bindings = fragment.bindings.map((occurrence) => occurrence[index])
    const post = postFor(bindings)
    const eligible = Boolean(post) && canBeProgram(step, bindings)
    const mode = modes[index] === 'agent' || !eligible ? 'agent' : 'program'
    const operation = {
      id: `s${index}`,
      tool: step.tool,
      mode,
      pre: {},
      post: mode === 'program' ? post : {},
      note: step.tool,
    }
    if (mode === 'program') operation.run = runFor(step)
    return operation
  })
  return {
    operations,
    order: operations.map((operation) => operation.id),
    edges: fragment.requiredEdges.map((edge) => ({
      from: `s${edge.from}`,
      to: `s${edge.to}`,
      path: edge.path,
    })),
    slots: fragment.steps.flatMap((step, index) => step.slots.map((slot) => ({ ...slot, step: index }))),
    constants: fragment.steps.flatMap((step, index) => step.constants.map((item) => ({
      step: index,
      path: item.path,
      value: item.value,
    }))),
  }
}

function postFor(bindings) {
  if (!outputsAgree(bindings)) return null
  const exit = bindings[0]?.exitCode
  if (typeof exit === 'number' && bindings.every((item) => item.exitCode === exit)) return { exitCode: exit }
  const output = String(bindings[0]?.output ?? '')
  if (output && bindings.every((item) => String(item.output ?? '').includes(output))) return { outputIncludes: output }
  return null
}

/** 委托包装会在正文后接退出码行和「已覆盖」。嵌进命令前丢掉这层，不改 presentDelegated。 */
function delegatedBody(text) {
  return String(text ?? '')
    .replace(/\n已覆盖[\s\S]*$/, '')
    .replace(/\n\[exit code: \d+\]$/, '')
}

/** 上一步正文与批准时的样本不同，才用 shellQuote 嵌进命令。相同则保持原命令。 */
function embedShellSample(command, sample, output) {
  const body = delegatedBody(output)
  if (!sample || !String(command).includes(sample) || body === sample) return command
  return String(command).split(sample).join(shellQuote(body))
}

/** 恢复时只采用模型交来的正文。没有退出码行就不编造 0。 */
function submissionRecord(stepOutput) {
  const source = String(stepOutput ?? '')
  let exitCode = null
  const matched = /\[exit code: (\d+)\]/.exec(source)
  if (matched) exitCode = Number(matched[1])
  const failed = commandFailed(source) || (typeof exitCode === 'number' && exitCode !== 0)
  return { output: delegatedBody(source), exitCode, truncated: false, failed, fileHash: null }
}

function runFor(step) {
  if (step.tool === 'bash') return { kind: 'script', command: step.commandTemplate }
  const overrides = {}
  for (const constant of step.constants) {
    if (!constant.template) setPath(overrides, constant.path, constant.value)
  }
  return { kind: 'delegate', tool: step.tool, overrides }
}

function liveOf(result) {
  const source = result?.output != null ? String(result.output) : String(result?.text ?? '')
  const output = delegatedBody(source)
  let exitCode = typeof result?.exitCode === 'number' ? result.exitCode : null
  if (exitCode === null) {
    const matched = /\[exit code: (\d+)\]/.exec(source)
    if (matched) exitCode = Number(matched[1])
  }
  const failed = result?.failed === true || (typeof exitCode === 'number' && exitCode !== 0) || commandFailed(source)
  return { output, exitCode, failed, truncated: result?.truncated === true, fileHash: result?.fileHash ?? null }
}

/**
 * 执行到第一个模型步就停。缺槽位是失败，不会变成 invalid arguments。
 * @param {object} spec 已安装的合同和签名
 * @param {object} input 槽位、恢复令和上一步输出
 * @param {(call: object) => Promise<object>} invoke 真正去调原工具的函数
 */
export async function executeCompiled(spec, input, invoke) {
  const operations = spec.operations ?? spec.contract?.operations ?? []
  const steps = spec.steps ?? []
  const edges = spec.edges ?? spec.contract?.edges ?? []
  const slotArgs = { ...(input.storedSlots ?? {}) }
  for (const [key, value] of Object.entries(input.slots ?? {})) {
    if (key === 'resume_token' || key === 'step_output') continue
    if (value !== undefined) slotArgs[key] = value
  }
  const outputs = { ...(input.outputs ?? {}) }
  let index = input.cursor ?? 0
  if (input.resume) {
    const step = operations[index]
    if (!step || step.mode !== 'agent') return { ok: false, failed: true, code: 'BAD_RESUME' }
    const saved = submissionRecord(input.stepOutput)
    if (step.post && Object.keys(step.post).length > 0 && !postHolds(step.post, saved)) {
      return { ok: false, failed: true, code: 'POST_FAILED', step: step.id }
    }
    outputs[step.id] = saved.output
    index += 1
  }
  const completed = []
  for (; index < operations.length; index += 1) {
    const operation = operations[index]
    if (operation.mode !== 'program') {
      return {
        ok: true,
        stopped: true,
        cursor: index,
        outputs,
        completed,
        remaining: operations.slice(index).map((item) => item.id),
        slots: slotArgs,
        resumeToken: `ecr_${randomBytes(9).toString('hex')}`,
      }
    }
    if (operation.run?.kind === 'delegate' && !READONLY_TOOLS.has(operation.run.tool ?? operation.tool)) {
      return { ok: false, failed: true, code: 'NOT_PROGRAM', step: operation.id, completed, outputs, cursor: index }
    }
    const built = buildCall(operation, steps[index], edges, operations, slotArgs, outputs)
    if (!built.ok) return { ok: false, failed: true, code: 'MISSING_SLOT', step: operation.id, missing: built.missing }
    const live = liveOf(await invoke(built.call))
    if (live.failed || (operation.post && !postHolds(operation.post, live))) {
      return { ok: false, failed: true, code: 'STEP_FAILED', step: operation.id, completed, outputs, cursor: index }
    }
    outputs[operation.id] = live.output
    completed.push(operation.id)
  }
  return { ok: true, stopped: false, outputs, completed, remaining: [], cursor: operations.length, slots: slotArgs }
}

function buildCall(operation, step, edges, operations, slotArgs, outputs) {
  const incoming = edges.filter((edge) => edge.to === operation.id)
  if (operation.run?.kind === 'script') {
    const slots = { ...slotArgs }
    for (const edge of incoming) {
      const fromId = edge.from
      if (edge.slot && outputs[fromId] != null) slots[edge.slot] = delegatedBody(outputs[fromId])
    }
    const filled = fillTemplate(operation.run.command, slots)
    if (!filled.ok) return { ok: false, missing: filled.missing }
    let command = filled.command
    for (const edge of incoming) {
      if (edge.slot || outputs[edge.from] == null || !edge.sample) continue
      command = embedShellSample(command, edge.sample, outputs[edge.from])
    }
    return { ok: true, call: { name: 'bash', arguments: { command, description: operation.id }, step: operation } }
  }
  const args = {}
  for (const constant of step?.constants ?? []) {
    if (!constant.template) setPath(args, constant.path, constant.value)
  }
  const missing = []
  for (const slot of step?.slots ?? []) {
    if (slot.fragment) continue
    if (!Object.prototype.hasOwnProperty.call(slotArgs, slot.name)) missing.push(slot.name)
    else setPath(args, slot.path, slotArgs[slot.name])
  }
  if (missing.length > 0) return { ok: false, missing }
  for (const edge of incoming) {
    if (outputs[edge.from] == null) continue
    const raw = delegatedBody(outputs[edge.from])
    const current = getPath(args, edge.path)
    if (typeof current === 'string' && edge.sample && current.includes(edge.sample)) {
      if (raw !== edge.sample) setPath(args, edge.path, current.split(edge.sample).join(raw))
    } else setPath(args, edge.path, raw)
  }
  return { ok: true, call: { name: operation.run.tool, arguments: args, step: operation } }
}

/** 把通过审批的程序写进当前会话。不改原工具的 successor。 */
export function installCompiled(state, catalog, record) {
  catalog.compiled = catalog.compiled ?? {}
  catalog.assets = catalog.assets ?? {}
  catalog.intercepts = catalog.intercepts ?? []
  if (catalog.compiled[record.ecName] || catalog.assets[record.assetId]) return { ok: false, code: 'NAME_TAKEN' }
  const stored = storedSpec(record)
  catalog.compiled[record.ecName] = stored
  catalog.assets[record.assetId] = {
    id: record.assetId,
    enabled: true,
    ecName: record.ecName,
    structuralKey: record.signatureKey,
    constants: record.fragment.steps.flatMap((step, index) => step.constants.map((item) => ({ step: index, ...item }))),
    pre: record.operations.map((operation) => operation.pre ?? {}),
    post: record.operations.map((operation) => operation.post ?? {}),
    operations: record.operations,
  }
  catalog.intercepts.push(record.intercept)
  state.tools[record.ecName] = freshTool()
  state.tools[record.ecName].compiled = true
  return { ok: true, spec: stored }
}

function storedSpec(record) {
  return {
    name: record.ecName,
    ecName: record.ecName,
    assetId: record.assetId,
    signatureKey: record.signatureKey,
    tools: record.fragment.tools,
    steps: record.fragment.steps,
    bindings: record.fragment.bindings,
    edges: (record.fragment.requiredEdges ?? []).map((edge, index) => ({
      ...edge,
      from: record.operations[edge.from]?.id,
      to: record.operations[edge.to]?.id,
      index,
    })),
    operations: record.operations,
    contract: {
      operations: record.operations,
      edges: (record.fragment.requiredEdges ?? []).map((edge) => ({
        from: record.operations[edge.from]?.id,
        to: record.operations[edge.to]?.id,
        path: edge.path,
        sample: edge.sample,
        slot: edge.slot,
      })),
    },
    previous: null,
    staged: false,
  }
}

/** 失败步改成模型步。不改其他步，也不碰摩擦分。 */
export function markStepAgent(catalog, ecName, stepId) {
  const spec = catalog.compiled?.[ecName]
  if (!spec) return null
  spec.operations = spec.operations.map((operation) => (operation.id === stepId ? { ...operation, mode: 'agent', failedStep: true, run: operation.run } : operation))
  if (spec.contract?.operations) spec.contract.operations = spec.operations
  return spec
}

/** 本轮结束前仍用当前合同。已暂存的修改要等提交。 */
export function visibleCompiled(spec) {
  if (!spec) return null
  if (spec.staged && spec.previous && !spec.pendingRestore) return { ...spec.previous, name: spec.name, ecName: spec.ecName }
  return spec
}

/** 恢复或卸掉先记账，提交时才解除拦截。 */
export function stageCompiledRestore(catalog, name) {
  const spec = catalog.compiled?.[name]
  if (!spec) return { ok: false, code: 'NOT_ADAPTED' }
  if (spec.staged && spec.previous) {
    catalog.compiled[name] = { ...spec.previous, previous: spec.previous.previous ?? null, staged: false }
    return { ok: true, pending: false }
  }
  if (spec.previous) {
    catalog.compiled[name] = { ...spec, pendingRestore: { mode: 'rollback' } }
    return { ok: true, pending: true }
  }
  catalog.compiled[name] = { ...spec, pendingRestore: { mode: 'delete' } }
  return { ok: true, pending: true }
}

/** 提交本轮：换上已批准的修改，或卸掉工具并停用资产。 */
export function commitCompiled(state, catalog) {
  let changed = false
  for (const [name, spec] of Object.entries(catalog.compiled ?? {})) {
    if (spec.pendingRestore?.mode === 'delete') {
      delete catalog.compiled[name]
      catalog.intercepts = (catalog.intercepts ?? []).filter((item) => item.ecName !== name)
      if (catalog.assets?.[spec.assetId]) catalog.assets[spec.assetId].enabled = false
      delete state.tools[name]
      changed = true
      continue
    }
    if (spec.pendingRestore?.mode === 'rollback' && spec.previous) {
      const rolled = { ...spec.previous, previous: spec.previous.previous ?? null, staged: false }
      catalog.compiled[name] = rolled
      if (catalog.assets?.[spec.assetId]) {
        catalog.assets[spec.assetId].operations = rolled.operations
        catalog.assets[spec.assetId].enabled = true
      }
      changed = true
      continue
    }
    if (spec.staged) {
      catalog.compiled[name] = { ...spec, staged: false, previous: spec.previous ?? null }
      if (catalog.assets?.[spec.assetId]) catalog.assets[spec.assetId].operations = spec.operations
      changed = true
    }
  }
  return changed
}

/** 把失败步的新合同暂存到下一轮。其他步必须已经相同。 */
export function stageCompiledRevision(catalog, ecName, operations) {
  const spec = catalog.compiled?.[ecName]
  if (!spec) return { ok: false, code: 'NOT_ADAPTED' }
  const previous = spec.staged && spec.previous ? spec.previous : { ...spec, previous: spec.previous ?? null, staged: false }
  catalog.compiled[ecName] = {
    ...spec,
    operations,
    contract: { ...spec.contract, operations },
    previous,
    staged: true,
    pendingRestore: null,
  }
  return { ok: true }
}

/**
 * 已登记工具在 execute 之前失败时只留轨迹断点。
 * 同一次 callId 已经由 record 记过时不再追加，也不记摩擦分。
 * @param {object} state 会话状态
 * @param {object} event 这次 post-execute 能看到的事实
 */
export function noteRegisteredBreakpoint(state, event) {
  state.trace = state.trace ?? []
  const last = state.trace[state.trace.length - 1]
  if (event.callId && last?.callId === event.callId && last?.registered && last.tool === String(event.tool ?? '')) {
    return { duplicate: true, skippedScore: true, points: 0 }
  }
  const record = appendTrace(state, { ...event, registered: true })
  return { record, skippedScore: true, points: 0 }
}

/**
 * 记账入口。注册工具仍然计摩擦分；旁路、参数错误和编译工具只留在轨迹里。
 * 正文里的非零退出码按失败记分。成功的同参重复不加 retry。
 * @param {object} state 会话状态
 * @param {object} event 一次调用
 * @param {object} options 慢调用和截断的阈值
 */
export function ingestCall(state, event, options = {}) {
  state.tools = state.tools ?? {}
  const record = appendTrace(state, event)
  if (isUnregisteredCall(event.output)) {
    const tool = state.tools[event.tool] ?? freshTool()
    tool.unmet = (tool.unmet ?? 0) + 1
    state.tools[event.tool] = tool
    const identity = ensureIdentity(state, event.tool)
    identity.unmet = tool.unmet
    return { record, skippedScore: true, unmet: tool.unmet, points: 0 }
  }
  const skipScore = event.bypass || event.invalid || event.own || event.compiled || event.parallel
  if (skipScore) return { record, skippedScore: true, points: 0 }
  const scoredOk = event.ok !== false && record.failed !== true
  const scored = noteCall(state, {
    tool: event.tool,
    ok: scoredOk,
    args: typeof event.scoreArgs === 'string' ? event.scoreArgs : canonicalJson(record.args),
    outputChars: event.outputChars ?? record.output.length,
    elapsedMs: event.elapsedMs ?? 0,
    truncated: record.truncated,
    workloadItems: event.workloadItems,
    output: event.output,
    message: event.message,
    errorCode: event.errorCode,
    round: event.round,
    at: event.at,
    cancelled: event.cancelled === true,
  }, options)
  return { record, ...scored }
}

/** 给状态接口看的成熟片段，不带内部对齐细节以外的运行时对象。 */
export function compilableView(fragments) {
  return (fragments ?? []).map((fragment) => ({
    tools: fragment.tools,
    structuralKey: structuralKey(fragment),
    occurrences: fragment.occurrenceCount,
    constants: fragment.steps.flatMap((step, index) => step.constants.map((item) => ({ step: index, path: item.path, value: item.value, template: Boolean(item.template) }))),
    slots: fragment.steps.flatMap((step, index) => step.slots.map((item) => ({ step: index, path: item.path, type: item.type, name: item.name }))),
    requiredEdges: fragment.requiredEdges.map((edge) => ({ from: edge.from, to: edge.to, path: edge.path })),
    bindings: fragment.bindings.map((occurrence) => occurrence.map((step) => ({
      tool: step.tool,
      args: step.args,
      output: step.output,
      exitCode: step.exitCode,
      truncated: step.truncated,
      fileHash: step.fileHash,
    }))),
  }))
}
