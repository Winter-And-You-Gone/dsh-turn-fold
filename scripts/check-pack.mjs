#!/usr/bin/env node
// 打包内容断言（2026-10-13 评审修复）。
//
// 背景：CI / Release 里那句 `npm pack --dry-run` 只把文件清单打印出来，**不做任何断言**——
// `files` 里少一项、或某个 glob 匹配为空都不会让 CI 变红。而运行时真正需要的文件掉出
// tarball 是静默故障：index.js 读 assets/ 下的 skill 正文，skill 又指引用户/agent 去跑
// scripts/sync-icons.mjs 并用 icons/default.json。
//
// 这个脚本做三件事：
//   1) 必须存在（运行时/安装/文档链路真正用到的文件）；
//   2) 必须不存在（workspace-only 文件、测试、lock、日志——绝不能随包泄漏）；
//   3) 顺带打印文件数与体积，便于发现"包体被塞进死重量"。
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, openSync, closeSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
// 受限环境（沙箱）里默认 npm cache（AppData\Local\npm-cache）不可写，node_modules 下的
// 缓存目录同样可能被 ACL 拒 → 用仓库根的 .npm-cache（.gitignore 已忽略），跑完删掉。
const cache = path.join(root, '.npm-cache')
const outFile = path.join(root, '.npm-pack.json')
let ownCache = false
try {
  mkdirSync(cache, { recursive: true })
  ownCache = true
} catch {
  // 建不出来就退回 npm 默认 cache（CI 里没问题；本机受限环境下会在下面如实报错）
}

/** 运行时 / 安装 / 文档链路真正需要的文件（掉一个就是静默故障）。 */
const REQUIRED = [
  'package.json',
  'index.js',
  'client.js',
  'icons/default.json',
  'assets/dsh-turn-fold-customize-icons.md',
  'scripts/sync-icons.mjs',
  'scripts/sync-step-anim.mjs',
  'cordis.patch.yml',
  'install.ps1',
  'LICENSE',
  'README.md',
  'README.en.md',
  'docs/扑克牌轮换_动态蒙版遮挡_文件图标加强版.html',
]
/** 绝不能出现在 tarball 里的东西（workspace-only / 测试 / 锁 / 日志）。 */
const FORBIDDEN = [
  'AGENTS.md',
  'MEMORY.md',
  'CLAUDE.md',
  'package-lock.json',
  'npm-debug.log',
]

function packJson() {
  const npmCli = process.env.npm_execpath
  const args = ['pack', '--dry-run', '--json', '--cache', cache]
  const cmd = npmCli ? process.execPath : (process.platform === 'win32' ? 'npm.cmd' : 'npm')
  const argv = npmCli ? [npmCli, ...args] : args
  // ⚠️ 不用管道捕获输出：受限沙箱里带管道 stdio 的 spawn 会被拒（EPERM），
  // 所以把 stdout 重定向到文件再读（stdio[1] = fd 不是 pipe，沙箱放行）。
  const fd = openSync(outFile, 'w')
  try {
    execFileSync(cmd, argv, { cwd: root, stdio: ['ignore', fd, 'inherit'] })
  } finally {
    closeSync(fd)
  }
  const out = readFileSync(outFile, 'utf8')
  // npm 可能先打几条 notice；JSON 数组是 stdout 上的最后一段结构化输出。
  const start = out.indexOf('[')
  if (start < 0) throw new Error('npm pack --json 没有输出 JSON：\n' + out)
  return JSON.parse(out.slice(start))
}

let packResult = null
try {
  packResult = packJson()
} finally {
  // 自己建的临时文件/缓存自己清掉（CI 上也无害）
  try { rmSync(outFile, { force: true }) } catch { /* 忽略 */ }
  if (ownCache) { try { rmSync(cache, { recursive: true, force: true }) } catch { /* 忽略 */ } }
}

const [entry] = packResult
const paths = entry.files.map((f) => f.path.split(path.sep).join('/'))
const problems = []

for (const want of REQUIRED) {
  if (!paths.includes(want)) problems.push('缺文件（运行时/文档链路需要）：' + want)
}
for (const bad of FORBIDDEN) {
  if (paths.includes(bad)) problems.push('不该随包发布：' + bad)
}
for (const p of paths) {
  if (p.startsWith('tests/')) problems.push('不该随包发布（测试）：' + p)
  if (p.endsWith('.log')) problems.push('不该随包发布（日志）：' + p)
  if (p.startsWith('.session-extract/') || p.startsWith('.review-')) problems.push('不该随包发布（本地临时目录）：' + p)
}

if (problems.length > 0) {
  console.error('[check-pack] 打包内容断言失败：')
  for (const p of problems) console.error('  - ' + p)
  console.error('  当前 tarball 共 ' + paths.length + ' 个文件：\n    ' + paths.join('\n    '))
  process.exitCode = 1
} else {
  const bytes = entry.files.reduce((sum, f) => sum + (f.size || 0), 0)
  console.log('[check-pack] OK：' + paths.length + ' 个文件，未压缩合计 ' + (bytes / 1024).toFixed(0) + ' KB（' + entry.filename + '）')
}
