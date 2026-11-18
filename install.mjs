/**
 * 把两个包装进当前 DSH_HOME，桌面和命令行共用这一份配置。
 * 路径在运行时按本机仓库位置写入，不写进将要公开的源码。
 * 命令行拒绝管理名为 desktop 的 profile，所以这里改的是 home 层补丁。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)))
const home = process.env.DSH_HOME?.trim()
  ? path.resolve(process.env.DSH_HOME.trim())
  : path.join(homedir(), '.dsh')
const entries = [
  ['friction-drive', path.join(root, 'packages/dsh-friction-drive/index.js')],
  ['friction-demo', path.join(root, 'packages/dsh-friction-demo/index.js')],
]

for (const [, file] of entries) {
  if (!existsSync(file)) {
    console.error(`找不到插件入口：${file}`)
    process.exit(1)
  }
}

ensurePeer()

const homePatch = path.join(home, 'cordis.patch.yml')
const block = [
  '- insert:',
  ...entries.flatMap(([id, file]) => [
    `    - id: ${id}`,
    `      name: ${JSON.stringify(file)}`,
  ]),
].join('\n')

mkdirSync(home, { recursive: true })
writeFileSync(homePatch, `${upsert(existsSync(homePatch) ? readFileSync(homePatch, 'utf8') : '', block)}\n`)

const profiles = path.join(home, 'profiles')
if (existsSync(profiles)) {
  for (const name of readdirSync(profiles)) {
    const dir = path.join(profiles, name)
    const patch = path.join(dir, 'cordis.patch.yml')
    if (existsSync(patch)) writeFileSync(patch, stripInserts(readFileSync(patch, 'utf8')))
    const manifest = path.join(dir, 'package.json')
    if (existsSync(manifest)) unbundle(manifest)
  }
}

console.log(`已写入 ${homePatch}`)
console.log('桌面应用和所有 profile 都会加载这两个包。重启正在运行的桌面应用后生效。')
console.log('卸掉时删除该文件里 id 为 friction-drive 和 friction-demo 的插入项。')

/** 桌面应用加载仓库外的入口时，不会使用应用包内的依赖。仓库根目录必须能解析这个包。 */
function ensurePeer() {
  const resolved = path.join(root, 'node_modules', '@deepseek-ai', 'dsh-tools', 'package.json')
  if (existsSync(resolved)) {
    console.log('已能从仓库解析 @deepseek-ai/dsh-tools。')
    return
  }
  if (existsSync(path.join(root, 'node_modules'))) {
    console.error('仓库里已有 node_modules，但没有 @deepseek-ai/dsh-tools。请先移开 node_modules 再运行。')
    process.exit(1)
  }
  const vendor = path.join(root, '.dsh-deps')
  const vendored = path.join(vendor, 'node_modules', '@deepseek-ai', 'dsh-tools', 'package.json')
  if (!existsSync(vendored)) {
    const spec = peerSpec()
    mkdirSync(vendor, { recursive: true })
    console.log(`正在安装 ${spec}。桌面应用需要从插件目录向上找到这个包。`)
    const result = spawnSync('npm', ['install', '--no-fund', '--no-audit', spec], { cwd: vendor, stdio: 'inherit' })
    if (result.status !== 0 || !existsSync(vendored)) {
      console.error('没能装上 @deepseek-ai/dsh-tools。需要本机有 npm，并且能访问 npm 仓库。')
      process.exit(result.status || 1)
    }
  }
  symlinkSync(path.join(vendor, 'node_modules'), path.join(root, 'node_modules'), 'dir')
  console.log('已链接 node_modules。不要把 .dsh-deps 或 node_modules 提交进仓库。')
}

/** 版本与插件声明的 peerDependency 保持一致。 */
function peerSpec() {
  const manifest = JSON.parse(readFileSync(path.join(root, 'packages/dsh-friction-drive/package.json'), 'utf8'))
  const version = manifest.peerDependencies?.['@deepseek-ai/dsh-tools'] ?? '0.2.2-rc.3'
  return `@deepseek-ai/dsh-tools@${version}`
}

/** 去掉旧的摩擦插件插入，再挂上这次的本机路径。 */
function upsert(text, next) {
  const kept = stripInserts(text).trim()
  if (kept === '' || kept === '[]') return next
  return `${kept}\n${next}`
}

/** 只删除这两个插件的 insert 块，保留 profile 里的其他配置。 */
function stripInserts(text) {
  return text.replace(/\n?- insert:\n(?:[ \t]*- id: friction-(?:drive|demo)\n[ \t]*name:.*\n?)+/g, '\n')
}

/** 组合包安装和 home 补丁不能同时存在，否则工具会登记两次。 */
function unbundle(file) {
  const manifest = JSON.parse(readFileSync(file, 'utf8'))
  const bundles = manifest.dsh?.profile?.bundles
  if (Array.isArray(bundles)) {
    manifest.dsh.profile.bundles = bundles.filter((name) => name !== 'dsh-friction-drive' && name !== 'dsh-friction-demo')
  }
  if (manifest.dependencies) {
    delete manifest.dependencies['dsh-friction-drive']
    delete manifest.dependencies['dsh-friction-demo']
  }
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`)
}
