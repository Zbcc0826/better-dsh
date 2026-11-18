/**
 * 示例源码泄漏判断。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { leaksDemoSource } from './guard.js'

test('搜索结果带出示例源码或内部时间表时要拦截', () => {
  assert.equal(leaksDemoSource('正常账本'), false)
  assert.equal(leaksDemoSource('see /dsh-friction-demo/index.js'), true)
  assert.equal(leaksDemoSource('start 2026-11-18T09:00:00'), true)
})
