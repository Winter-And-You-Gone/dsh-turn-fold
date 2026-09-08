// 从 docs/icon-candidates.html 提取新图标数据，更新 icons/default.json
// 注意：该 HTML 是本地-only 实验场（gitignore，2026-08-30 起不入库）——新克隆/发布包
// 上不存在属预期，此时给出明确指引后退出，而不是 ENOENT 堆栈。
import { existsSync, readFileSync, writeFileSync } from 'fs'

if (!existsSync('docs/icon-candidates.html')) {
  console.error('[extract-icons] docs/icon-candidates.html 不存在（本地-only 实验场，不入库）。')
  console.error('[extract-icons] 若要运行本脚本，请先在本机恢复该实验文件（图标工作起点），')
  console.error('[extract-icons] 或直接编辑 icons/default.json 后跑 npm run sync:icons。')
  process.exit(1)
}

const html = readFileSync('docs/icon-candidates.html', 'utf8')
const lines = html.split('\n')

// 1. 提取花色路径
function extractPath(name) {
  const re = new RegExp("^  const " + name + " = '(.+?)'$", 'm')
  const m = html.match(re)
  if (!m) throw new Error('not found: ' + name)
  return m[1]
}

const spade = extractPath('SPADE')
const heart = extractPath('HEART')
const diamond = extractPath('DIAMOND')
const club = extractPath('CLUB')

// 2. 提取 ANIM_SVG（模板字面量，纯字符串）
// 找到 ANIM_SVG 的起始行（const ANIM_SVG = ` 之后的内容）
const startIdx = html.indexOf('const ANIM_SVG = `')
if (startIdx === -1) throw new Error('ANIM_SVG not found')
const contentStart = html.indexOf('`', startIdx + 17) + 1 // 跳过反引号
const endIdx = html.indexOf('`', contentStart) // 结束反引号
const animSVG = html.slice(contentStart, endIdx)
  .replace(/\r\n/g, '\n')
  .replace(/\r/g, '\n')
  // 剔除 HTML 演示用的虚线边框（<rect class="demo-border" .../>），插件内不应渲染
  .replace(/<rect class="demo-border"[\s\S]*?\/>/g, '')
  .trim()

// 3. 提取 DeepSeek 路径（pip-deepseek）
// 在 defs 里找 <path id="pip-deepseek" d="..."（注意匹配 pip-deepseek" 之后的 d=）
const deepseekStart = html.indexOf('<path id="pip-deepseek" d="')
if (deepseekStart === -1) throw new Error('pip-deepseek not found')
const dStart = html.indexOf('d="', deepseekStart + '<path id="pip-deepseek"'.length) + 3
const dEnd = html.indexOf('"', dStart)
const deepseekPath = html.slice(dStart, dEnd)

// 4. 构建新 pokerSpinDeepseek（与当前格式一致：<path id="axis-deepseek-UID" d="..."/>）
const pokerSpinDeepseek = '<path id="axis-deepseek-UID" d="' + deepseekPath + '"/>'

// 5. 读取当前 default.json 保留未改动的字段
const current = JSON.parse(readFileSync('icons/default.json', 'utf8'))

const updated = {
  meta: current.meta,
  pokerR: current.pokerR,
  pokerPips: {
    spade: { path: spade, cx: 12, cy: 12, factor: 1 },
    heart: { path: heart, cx: 12, cy: 12, factor: 1 },
    diamond: { path: diamond, cx: 12, cy: 12, factor: 1 },
    club: { path: club, cx: 12, cy: 12, factor: 1 },
  },
  pokerSVGBase: current.pokerSVGBase,
  pokerTransforms: current.pokerTransforms,
  pokerSpin: current.pokerSpin,
  pokerAnimSVG: animSVG,
  pokerSpinDeepseek: pokerSpinDeepseek,
}

writeFileSync('icons/default.json', JSON.stringify(updated, null, 2) + '\n')
console.log('default.json updated')
console.log('pokerPips: spade, heart, diamond, club updated')
console.log('pokerAnimSVG: ' + animSVG.length + ' chars')
console.log('pokerSpinDeepseek: ' + pokerSpinDeepseek.length + ' chars')