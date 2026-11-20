/**
 * 把本仓库作为组合包装进 DSH 的 profile。
 * 插件页的开关只认 profile 的 bundles 列表。
 * 写进 home 的绝对路径不会出现在那一页，开关也关不掉，所以这里会删掉那种旧插入。
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
const bundleName = 'dsh-friction-drive'

const driveEntry = path.join(root, 'packages/dsh-friction-drive/index.js')
const demoEntry = path.join(root, 'packages/dsh-friction-demo/index.js')
if (!existsSync(driveEntry) || !existsSync(demoEntry) || !existsSync(path.join(root, 'cordis.patch.yml'))) {
  console.error('仓库不完整：需要根目录的 cordis.patch.yml，以及 packages 里的两个入口。')
  process.exit(1)
}

ensurePeer()
stripHomeInserts()

const profiles = path.join(home, 'profiles')
if (!existsSync(profiles)) {
  console.error(`找不到 ${profiles}。先启动一次桌面应用或 dsh，再运行这个脚本。`)
  process.exit(1)
}

const pnpm = findPnpm()
let installed = 0
for (const name of readdirSync(profiles)) {
  const dir = path.join(profiles, name)
  const manifestPath = path.join(dir, 'package.json')
  if (!existsSync(manifestPath)) continue
  const patch = path.join(dir, 'cordis.patch.yml')
  if (existsSync(patch)) writeFileSync(patch, stripInserts(readFileSync(patch, 'utf8')))
  linkBundle(dir, pnpm)
  enableBundle(manifestPath)
  installed += 1
  console.log(`已装进 profile ${name}，并打开开关。`)
}

if (installed === 0) {
  console.error('没有可写的 profile。先启动一次桌面应用，再运行这个脚本。')
  process.exit(1)
}

console.log('重启正在运行的桌面应用后，插件页「已安装插件」里会出现「更好的 DSH」。')

/** 链接到仓库外时，桌面应用不会改用自己包里的依赖。仓库根目录必须能解析这个包。 */
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
    const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
    const version = manifest.peerDependencies?.['@deepseek-ai/dsh-tools'] ?? '0.2.2-rc.3'
    const spec = `@deepseek-ai/dsh-tools@${version}`
    mkdirSync(vendor, { recursive: true })
    // 单独的 package.json，避免 npm 改到仓库根上的清单。
    writeFileSync(path.join(vendor, 'package.json'), `${JSON.stringify({ private: true, dependencies: { '@deepseek-ai/dsh-tools': version } }, null, 2)}\n`)
    console.log(`正在安装 ${spec}。本地路径安装时，插件目录需要自己能找到这个包。`)
    const result = spawnSync('npm', ['install', '--prefix', vendor, '--no-fund', '--no-audit'], { stdio: 'inherit' })
    if (result.status !== 0 || !existsSync(vendored)) {
      console.error('没能装上 @deepseek-ai/dsh-tools。需要本机有 npm，并且能访问 npm 仓库。')
      process.exit(result.status || 1)
    }
  }
  symlinkSync(path.join(vendor, 'node_modules'), path.join(root, 'node_modules'), 'dir')
  console.log('已链接 node_modules。不要把 .dsh-deps 或 node_modules 提交进仓库。')
}

/** 删掉 home 层的旧插入。那里的绝对路径绕过插件页。 */
function stripHomeInserts() {
  const file = path.join(home, 'cordis.patch.yml')
  if (!existsSync(file)) return
  const next = stripInserts(readFileSync(file, 'utf8')).trim()
  writeFileSync(file, next === '' || next === '[]' ? '[]\n' : `${next}\n`)
  console.log(`已从 ${file} 去掉不出现在插件页的旧插入。`)
}

/** 只删除这两个插件的 insert 块，保留 profile 里的其他配置。 */
function stripInserts(text) {
  return text.replace(/\n?- insert:\n(?:[ \t]*- id: friction-(?:drive|demo)\n[ \t]*name:.*\n?)+/g, '\n')
}

/** 用桌面应用自带的 pnpm，或 PATH 上的 pnpm。命令行拒绝管理名为 desktop 的 profile。 */
function findPnpm() {
  if (process.env.PNPM_BIN && existsSync(process.env.PNPM_BIN)) return process.env.PNPM_BIN
  const onPath = spawnSync('sh', ['-c', 'command -v pnpm'], { encoding: 'utf8' })
  const found = onPath.stdout.trim()
  if (onPath.status === 0 && found) return found
  const fromApp = pnpmInApp(runningApp()) || pnpmInApp('/Applications/DeepSeek Harness.app')
    || pnpmInApp(path.join(homedir(), 'Applications/DeepSeek Harness.app'))
  if (fromApp) return fromApp
  console.error('找不到 pnpm。请安装 pnpm，或设置 PNPM_BIN 指向桌面应用里的 pnpm.mjs。')
  process.exit(1)
}

/** 从正在运行的桌面应用路径推出它自带的 pnpm。 */
function runningApp() {
  const listed = spawnSync('ps', ['-ax', '-o', 'command='], { encoding: 'utf8' })
  const match = listed.stdout.match(/(\/.*DeepSeek Harness\.app)\//)
  return match ? match[1] : ''
}

/** 应用包内的 pnpm 入口。不存在就返回空字符串。 */
function pnpmInApp(app) {
  if (!app) return ''
  const file = path.join(app, 'Contents/Resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs')
  return existsSync(file) ? file : ''
}

/** 把仓库链接进这个 profile。已经指向同一目录时不重复安装。 */
function linkBundle(dir, pnpm) {
  const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))
  const current = manifest.dependencies?.[bundleName] ?? ''
  if (typeof current === 'string' && current.includes(root)) return
  const command = pnpm.endsWith('.mjs') ? process.execPath : pnpm
  const args = pnpm.endsWith('.mjs') ? [pnpm, 'add', `link:${root}`] : ['add', `link:${root}`]
  const result = spawnSync(command, args, { cwd: dir, stdio: 'inherit' })
  if (result.status !== 0) {
    console.error(`没能把组合包装进 ${dir}`)
    process.exit(result.status || 1)
  }
}

/** 打开插件页上的组合包开关：写进 dsh.profile.bundles。 */
function enableBundle(file) {
  const manifest = JSON.parse(readFileSync(file, 'utf8'))
  const profile = manifest.dsh?.profile ?? {}
  const bundles = Array.isArray(profile.bundles) ? profile.bundles.filter((name) => name !== 'dsh-friction-demo') : []
  if (!bundles.includes(bundleName)) bundles.push(bundleName)
  manifest.dsh = { ...manifest.dsh, profile: { ...profile, bundles } }
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`)
}
