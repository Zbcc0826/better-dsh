/**
 * 复杂任务的可选流程：先找茬，再写带次生影响的实现方案。
 * 没经过同意不算开始。计划没盖住全部问题之前，不算可以动手。
 */

const SEVERITY = new Set(['fatal', 'high', 'medium'])

/** 同意前只检查任务说明是否够具体，不判断任务难不难。 */
export function assessLoopOffer(input) {
  const task = clean(input?.task, 200)
  const why = clean(input?.why, 200)
  if (!task || task.length < 12) return { ok: false, code: 'BAD_TASK' }
  if (!why || why.length < 12) return { ok: false, code: 'BAD_WHY' }
  return { ok: true, task, why }
}

/** 找茬记录。新的一轮找茬会使上一份方案失效。 */
export function assessCritique(defects) {
  if (!Array.isArray(defects) || defects.length < 2 || defects.length > 8) return { ok: false, code: 'BAD_DEFECTS' }
  const seen = new Set()
  const cleaned = []
  for (const defect of defects) {
    const id = String(defect?.id ?? '')
    if (!/^d[1-9][0-9]?$/.test(id) || seen.has(id)) return { ok: false, code: 'BAD_DEFECT', id }
    if (!SEVERITY.has(defect?.severity)) return { ok: false, code: 'BAD_SEVERITY', id }
    const scenario = clean(defect?.scenario, 200)
    const consequence = clean(defect?.consequence, 200)
    if (!scenario || scenario.length < 8 || !consequence || consequence.length < 8) return { ok: false, code: 'BAD_DEFECT', id }
    seen.add(id)
    cleaned.push({ id, severity: defect.severity, scenario, consequence })
  }
  return { ok: true, defects: cleaned }
}

/**
 * 实现方案必须逐条回应找茬。
 * 每条修改至少写一个次生影响，避免只考虑眼前这一处。
 */
export function assessPlan(defects, plan) {
  if (!Array.isArray(defects) || defects.length === 0) return { ok: false, code: 'NO_CRITIQUE' }
  const principle = clean(plan?.principle, 400)
  if (!principle || principle.length < 12) return { ok: false, code: 'BAD_PRINCIPLE' }
  const changes = Array.isArray(plan?.changes) ? plan.changes : null
  if (!changes || changes.length !== defects.length) return { ok: false, code: 'PLAN_MISMATCH' }
  const wanted = new Map(defects.map((defect) => [defect.id, defect]))
  const seen = new Set()
  const cleaned = []
  for (const change of changes) {
    const defectId = String(change?.defectId ?? '')
    const defect = wanted.get(defectId)
    if (!defect || seen.has(defectId)) return { ok: false, code: 'PLAN_MISMATCH', id: defectId }
    const text = clean(change?.change, 300)
    const secondary = Array.isArray(change?.secondary) ? change.secondary.map((item) => clean(item, 160)).filter((item) => item && item.length >= 8) : []
    if (!text || text.length < 8 || secondary.length === 0) return { ok: false, code: 'MISSING_SECONDARY', id: defectId }
    seen.add(defectId)
    cleaned.push({ defectId, severity: defect.severity, change: text, secondary })
  }
  return { ok: true, plan: { principle, changes: cleaned } }
}

/** 给模型和 friction_status 看的进度。ready 之前不要动手实现。 */
export function qualityView(loop) {
  if (!loop?.active) return { active: false, ready: false }
  const defects = loop.critique?.defects ?? []
  const addressed = new Set((loop.plan?.changes ?? []).map((change) => change.defectId))
  return {
    active: true,
    ready: Boolean(loop.plan) && defects.length > 0 && defects.every((defect) => addressed.has(defect.id)),
    task: loop.task,
    defectCount: defects.length,
    openDefects: defects.filter((defect) => !addressed.has(defect.id)).map((defect) => defect.id),
  }
}

/** 审批卡说明这是整个任务的两轮流程，不是放行一次调用。 */
export function qualityCopy(task) {
  const shown = task.slice(0, 80)
  return {
    zh: `允许本会话对这个复杂任务使用找茬再实现的流程。会多花 token。同意前不会改东西。任务：${shown}`,
    en: `Allow the critique-then-implement loop for this complex task in the current session. This spends extra tokens. Nothing is changed before approval. Task: ${shown}`,
  }
}

function clean(value, max) {
  if (typeof value !== 'string') return ''
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > max ? text.slice(0, max) : text
}
