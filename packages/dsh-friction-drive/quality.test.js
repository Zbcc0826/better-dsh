import assert from 'node:assert/strict'
import test from 'node:test'
import { assessCritique, assessLoopOffer, assessPlan, qualityView } from './quality.js'

const defects = [
  { id: 'd1', severity: 'fatal', scenario: '同意前就改了两个文件', consequence: '用户拒绝时改动已经留下' },
  { id: 'd2', severity: 'high', scenario: '只改了当前函数的返回值', consequence: '记分和另一会话的拦截一起变了' },
]

test('任务说明太短不能提议流程', () => {
  assert.equal(assessLoopOffer({ task: '改一下', why: '因为这个任务会跨过记分和审批' }).code, 'BAD_TASK')
  const offer = assessLoopOffer({ task: '给插件增加可选的高质量流程', why: '会改动审批、记分和会话隔离' })
  assert.equal(offer.ok, true)
})

test('找茬至少两条，方案必须逐条写次生影响', () => {
  assert.equal(assessCritique([defects[0]]).code, 'BAD_DEFECTS')
  const critique = assessCritique(defects)
  assert.equal(critique.ok, true)
  assert.equal(assessPlan(critique.defects, {
    principle: '先保住用户还没同意的现场',
    changes: [
      { defectId: 'd1', change: '同意前只记录文字', secondary: [] },
      { defectId: 'd2', change: '把记分规则写进方案', secondary: ['失败重试的计分不能被这次改动清掉'] },
    ],
  }).code, 'MISSING_SECONDARY')
  const plan = assessPlan(critique.defects, {
    principle: '先保住用户还没同意的现场',
    changes: [
      { defectId: 'd1', change: '同意前只记录文字', secondary: ['已有的 fd_ 工具不会被这个流程卸掉'] },
      { defectId: 'd2', change: '把记分规则写进方案', secondary: ['失败重试的计分不能被这次改动清掉'] },
    ],
  })
  assert.equal(plan.ok, true)
  const ready = qualityView({ active: true, task: 'x', critique, plan: plan.plan })
  assert.equal(ready.ready, true)
  const again = assessCritique(defects)
  assert.equal(qualityView({ active: true, task: 'x', critique: again, plan: null }).ready, false)
})
