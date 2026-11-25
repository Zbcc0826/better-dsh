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
  assert.equal(leaksDemoSource('read /dsh-friction-drive/package.json'), false)
  assert.equal(leaksDemoSource('read /dsh-friction-drive/README.md'), false)
  assert.equal(leaksDemoSource('read /dsh-friction-drive/README.en.md'), false)
  assert.equal(leaksDemoSource('read /dsh-friction-drive/cordis.patch.yml'), false)
  const pkg = '<path>/Users/x/.dsh/profiles/desktop/node_modules/dsh-friction-drive/package.json</path><content>"./packages/dsh-friction-drive/index.js"</content>'
  assert.equal(leaksDemoSource(pkg), false)
  const patch = '<path>/Users/x/.dsh/profiles/desktop/node_modules/dsh-friction-drive/cordis.patch.yml</path><content>name: dsh-friction-drive/demo</content>'
  assert.equal(leaksDemoSource(patch), false)
  const source = '<path>/Users/x/.dsh/profiles/desktop/node_modules/dsh-friction-drive/packages/dsh-friction-demo/index.js</path>'
  assert.equal(leaksDemoSource(source), true)
  assert.equal(leaksDemoSource('const LEDGER\n<path>/dsh-friction-drive/package.json</path>'), true)
})
