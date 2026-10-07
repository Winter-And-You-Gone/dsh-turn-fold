#!/usr/bin/env node
/**
 * 生成步骤折叠栏「运行中」图标的动画 SVG，并写入 client.js 的
 * `>>> step-running-poker-svg` / `<<< step-running-poker-svg` 标记块。
 *
 * 设计源（唯一）：docs/扑克牌轮换_动态蒙版遮挡_文件图标加强版.html **第三行的
 *   「牌面轮换 · 平面旋转 35.5°」变体** —— 第三行的五牌面轮换动画本体
 *   （`const ANIM_SVG` 模板：每 0.8s 一组、五相位 4s 一整轮、动态蒙版挖空下层牌）
 *   加上参考稿 svg3dRotated() 那一步：在 </defs> 之后插入
 *   `<g transform="rotate(angle 8 8)">`，把卡牌、花色与它们引用的 mask **整体**绕
 *   16×16 画布中心旋转 —— 关键帧一个字不改（参考稿注释：「在不改动动画关键帧的前提下，
 *   把整套可见动画绕 16×16 画布中心旋转。defs 保持原坐标；外层 transform 会让卡牌、
 *   花色以及引用的 mask 一起旋转。」）。
 *   **不是**第四/五行的「牌面翻转 · 竖直对角线轴」——那是回合栏运行中的图标，两者刻意不同。
 *
 * 旋转角 = icons/default.json → pokerSpin.restAngle（≈35.5377° = atan(w/h)，与回合栏轴角
 *   同一数据源）：脚本断言它四舍五入到 1 位小数 == 参考稿那条变体的字面量 35.5
 *   （「牌面轮换 · 平面旋转 35.5°」标签、`const target = toward35 ? 35.5 : 0`）——
 *   设计值与数据源同源，任一边漂移都在这里失败。若只想钉死设计字面量，把 ANGLE 换成 35.5 即可。
 *
 * 转换规则（与参考页自身保持一致，不改任何 SMIL 关键帧/时序）：
 *   1) 只取 `const ANIM_SVG = \`...\`` 模板内容；去掉页面预览用的 demo-border 虚线框；
 *   2) 与参考页 applyAnimationShape('poker') 同规则适配 5:7 牌形：
 *        卡牌 rect 8×5.714（baseW = 8×5/7）rx 1.08；
 *        蒙版 rect 同宽 +0.72、同高 +0.72（连同 stroke 一起挖空）rx 1.44；
 *   3) 内联参考页 CSS `.anim-card{fill:transparent}`（数据 URI 无外部样式，必须自包含）；
 *   4) 颜色固定 #fff：作为 CSS mask 时仅使用 alpha 通道，实际牌线颜色由伪元素的
 *      background-color:currentColor 决定（跟随 DSH 主题）；
 *   5) 旋转组：`<g class="tf-step-flat-rotation" transform="rotate(<角> 8 8)">` 紧跟在
 *      `</defs><style>…</style>` 之后开、`</svg>` 之前闭合（包住全部可见内容）；
 *   6) 去注释、压紧空白后写入标记块（单引号 JS 字符串，脚本会校验无引号/反斜杠）。
 *
 * 类名 `tf-step-flat-rotation` 与回合栏的 `ccg-axis-rest-rotation` 刻意分开：后者那条
 *   「CSS 不得写 transform 覆盖 SVG 属性」的禁令只针对回合栏轴组（CSS transform 会压掉
 *   同名属性），这里同理也不许任何人再写 CSS transform 覆盖这个旋转角。
 *
 * 边界：产物是**构建期**烘焙进 client.js 的，运行时 localStorage 图标包覆盖不改写它
 *   （覆盖只作用于回合栏翻牌与运行时生成的步骤双态牌面）。
 *
 * 运行：npm run sync:step-anim
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REF = path.join(root, 'docs', '扑克牌轮换_动态蒙版遮挡_文件图标加强版.html')
const ICONS = path.join(root, 'icons', 'default.json')
const CLIENT = path.join(root, 'client.js')

const icons = JSON.parse(fs.readFileSync(ICONS, 'utf8'))
const html = fs.readFileSync(REF, 'utf8')

// ── 参考稿结构断言：移植对象必须仍是第三行那条「平面旋转」变体 ──
const guardTokens = [
  'const ANIM_SVG = `',                                   // 第三行动画本体
  'function svg3dRotated(s, angle',                       // 平面旋转变体
  'class="anim-root-rotation" transform="rotate(\' + angle + \' 8 8)"',
  '牌面轮换 · 平面旋转 ${angle}°',
  'const target = toward35 ? 35.5 : 0',
  '当前：牌面轮换 · 平面旋转 35.5° · 点击切换',
]
for (const token of guardTokens) {
  if (!html.includes(token)) throw new Error('参考稿第三行「平面旋转」变体结构漂移，缺少标记: ' + token)
}
// 设计字面量（35.5）↔ 数据源轴角（≈35.5377）双向对齐
const refAngle = Number(html.match(/const target = toward35 \? ([\d.]+) : 0/)[1])
const ANGLE = icons.pokerSpin && icons.pokerSpin.restAngle
if (typeof ANGLE !== 'number') throw new Error('icons/default.json 缺少 pokerSpin.restAngle')
if (Number(ANGLE.toFixed(1)) !== refAngle) {
  throw new Error('旋转角与设计字面量不一致：数据源 restAngle ' + ANGLE + ' 四舍五入 ≠ 参考稿 ' + refAngle)
}

// ── 取第三行动画本体 ──
const start = html.indexOf('const ANIM_SVG = `')
const end = html.indexOf('</svg>`', start)
if (start < 0 || end < 0) throw new Error('ANIM_SVG 模板未在参考 HTML 中找到')
let svg = html.slice(start + 'const ANIM_SVG = `'.length, end + '</svg>'.length)

// 1) 自包含颜色 + 内联参考页卡片样式 + 平面旋转组（三者同挂在 </defs> 边界上）
svg = svg.replace(/\s*style="color:var\(--card-stroke,#fff\)"/, ' style="color:#fff"')
svg = svg.replace('</defs>', '</defs><style>.anim-card{fill:transparent}</style>'
  + '<g class="tf-step-flat-rotation" transform="rotate(' + ANGLE + ' 8 8)">')
svg = svg.replace(/<\/svg>\s*$/, '</g></svg>')

// 2) 去掉页面预览虚线框（不属于动画本体）
svg = svg.replace(/<rect class="demo-border"[\s\S]*?\/>\s*/, '')

// 3) poker 5:7 形状（与参考页 applyAnimationShape('poker') 完全一致）
const baseW = 8 * (5 / 7)
const baseX = -baseW / 2
const maskW = baseW + 0.72
const maskX = -maskW / 2
svg = svg.replace(/<rect class="anim-base-rect"[^>]*?\/>/g,
  `<rect class="anim-base-rect" x="${baseX}" y="-4" width="${baseW}" height="8" rx="1.08" stroke="currentColor" stroke-width="0.7"/>`)
svg = svg.replace(/<rect class="anim-mask-rect"[^>]*?\/>/g,
  `<rect class="anim-mask-rect" x="${maskX}" y="-4.36" width="${maskW}" height="8.72" rx="1.44" fill="black"/>`)

// 4) 去掉生成脚本注入的排版空白、页面注释（参考页模板里的注释不进产物）
svg = svg.replace(/<!--[\s\S]*?-->/g, '')
svg = svg.replace(/\s+/g, ' ').replace(/>\s+</g, '><').trim()

// ── 出口校验 ──
if (svg.includes("'") || svg.includes('\\')) throw new Error('SVG 含单引号或反斜杠，需先转义')
if (svg.includes('${')) throw new Error('SVG 仍有未解析的插值占位符')
for (const token of [
  '<animateTransform', 'mask-plus-out', 'mask-plus-in', 'mask-minus-out', 'mask-minus-in',
  'phase-1', 'phase-5', 'pip-deepseek', 'calcMode="discrete"', 'dur="0.8s"', 'dur="4s"',
  'class="tf-step-flat-rotation" transform="rotate(' + ANGLE + ' 8 8)"',
  '.anim-card{fill:transparent}',
  'class="anim-base-rect"', 'class="anim-mask-rect"', 'width="' + maskW + '"', 'rx="1.44"',
]) {
  if (!svg.includes(token)) throw new Error('转换后缺少结构标记: ' + token)
}
// 旋转组必须真的包住五组相位（而不是只挂在某个相位上）
const rotAt = svg.indexOf('tf-step-flat-rotation')
const lastPhaseAt = svg.lastIndexOf('<g id="phase-5')
if (rotAt < 0 || lastPhaseAt < rotAt || !svg.endsWith('</g></svg>')) {
  throw new Error('平面旋转组未包住全部相位（rotAt=' + rotAt + ', lastPhaseAt=' + lastPhaseAt + '）')
}
// 不得混入回合栏/翻转时代的语义（第四、五行的轴旋转不是本动画）
for (const banned of ['rotateY', 'perspective', 'backface-visibility', 'scaleX',
  'ccg-axis-rest-rotation', 'tf-step-axis', 'axis-spin-card', 'anim-root-rotation']) {
  if (svg.includes(banned)) throw new Error('产物出现禁用标识: ' + banned)
}

const client = fs.readFileSync(CLIENT, 'utf8')
const mStart = client.indexOf('/* >>> step-running-poker-svg')
const mEnd = client.indexOf('/* <<< step-running-poker-svg */')
if (mStart < 0 || mEnd < 0 || mEnd < mStart) throw new Error('client.js 缺少标记块')
// 行尾跟随目标文件（本仓库工作区是 CRLF 检出：插 LF 会留下混合行尾）
const eol = client.includes('\r\n') ? '\r\n' : '\n'
const block = '/* >>> step-running-poker-svg (generated; do not edit; regenerate: npm run sync:step-anim) */' + eol
  + "\t\tvar STEP_RUNNING_POKER_SVG = '" + svg + "';" + eol
  + '\t\t'
fs.writeFileSync(CLIENT, client.slice(0, mStart) + block + client.slice(mEnd))

console.log('[sync-step-anim] 牌面轮换 · 平面旋转 ' + Number(ANGLE.toFixed(1)) + '°（参考稿第三行变体；角取自 pokerSpin.restAngle = ' + ANGLE + '）',
  '| svg length:', svg.length,
  '| animateTransform:', (svg.match(/<animateTransform/g) || []).length,
  '| animate:', (svg.match(/<animate\b/g) || []).length,
  '| masks:', (svg.match(/url\(#mask-/g) || []).length)
