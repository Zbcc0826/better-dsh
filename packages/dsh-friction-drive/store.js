/**
 * 每个会话一个目录：状态、工具定义和锁放在一起。
 * 锁文件记下进程号。持有者已经不在时，下一次请求把锁清掉。
 */
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { freshState } from './logic.js'

/** 跟随 DSH_HOME，空白环境变量视为没设置。 */
export function harnessHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.trim()) return path.resolve(configured.trim())
  return path.join(os.homedir(), '.dsh')
}

export function stateRoot() {
  return path.join(harnessHome(), 'friction-drive', 'sessions')
}

export function sessionDir(root, sessionId) {
  const safe = String(sessionId).replace(/[^a-zA-Z0-9._-]/g, '_')
  return path.join(root, safe)
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function ownerDead(lock) {
  try {
    const pid = Number(readFileSync(lock, 'utf8').split('\n')[0])
    if (!Number.isInteger(pid) || pid <= 0) return true
    process.kill(pid, 0)
    return false
  } catch (error) {
    return error?.code !== 'EPERM'
  }
}

/** 取锁后执行 fn。死进程留下的锁会被清掉，不静默覆盖别人正在写的文件。 */
export function withLock(dir, fn) {
  mkdirSync(dir, { recursive: true })
  const lock = path.join(dir, '.lock')
  let fd
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      fd = openSync(lock, 'wx')
      writeFileSync(fd, `${process.pid}\n${Date.now()}\n`)
      break
    } catch {
      if (ownerDead(lock)) {
        try { unlinkSync(lock) } catch { /* 另一个请求刚刚清掉 */ }
        continue
      }
      sleep(20)
    }
  }
  if (fd === undefined) throw new Error('FRICTION_LOCK_TIMEOUT')
  try {
    return fn()
  } finally {
    closeSync(fd)
    try { unlinkSync(lock) } catch { /* 锁已经被清掉 */ }
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(tmp, file)
}

/** 只读会话。文件不存在时不创建目录。 */
export function readSession(root, sessionId, threshold) {
  const dir = sessionDir(root, sessionId)
  return {
    state: readJson(path.join(dir, 'state.json'), freshState(threshold)),
    catalog: readJson(path.join(dir, 'catalog.json'), { tools: {} }),
  }
}

/**
 * 在同一把锁里修改状态和工具定义。
 * @param {Function} mutate 接收 { state, catalog }，可以就地修改
 */
export function withSession(root, sessionId, threshold, mutate) {
  const dir = sessionDir(root, sessionId)
  return withLock(dir, () => {
    const state = readJson(path.join(dir, 'state.json'), freshState(threshold))
    const catalog = readJson(path.join(dir, 'catalog.json'), { tools: {} })
    const result = mutate({ state, catalog })
    writeJson(path.join(dir, 'state.json'), state)
    writeJson(path.join(dir, 'catalog.json'), catalog)
    return result
  })
}
