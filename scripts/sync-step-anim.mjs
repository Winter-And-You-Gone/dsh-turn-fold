#!/usr/bin/env node
/**
 * 生成步骤折叠栏「运行中」图标的动画 SVG，并写入 client.js 的
 * `>>> step-running-poker-svg` / `<<< step-running-poker-svg` 标记块。
 *
 * 设计源（唯一）：docs/扑克牌轮换_动态蒙版遮挡_文件图标加强版.html
 *   **第五行「牌面翻转 · 竖直对角线轴」** —— renderDiagonalSpinCard() 调
 *   svgAxisSpin(16, poker, axisAngle=0, restAngle=diagonalRestAngle())，
 *   即「以卡牌左上→右下真实对角线为旋转轴」的四花色翻牌（每次翻到背面固定
 *   DeepSeek 鲸鱼）。回合栏运行中图标用的就是这条变体。
 *
 * 数值源（唯一）：icons/default.json —— 与回合栏 buildPokerSpinSVG 同读这份文件。
 *   脚本逐项断言两处数值一致，任何一边漂移都会在这里失败：
 *     pokerSpin.restAngle   == atan(w/h)（四舍五入到 4 位小数）—— 对角线轴恒等式
 *     pokerSpin.h / pokerRatio / r / pipScale / strokeW == 参考稿第五行的字面量
 *     pokerSpin.scaleKeys / scaleKeyTimes == 参考稿 svgAxisSpin 内联的 73 帧
 *   牌面取自 pokerPips（24 单位视箱，含 fill="currentColor"）；
 *   牌背 Logo 取自 pokerSpinDeepseek（占位符 axis-deepseek-UID）。
 *   边界：产物是**构建期**烘焙进 client.js 的（与第三行同机制），运行时 localStorage
 *   图标包覆盖不改写它 —— 覆盖只作用于回合栏翻牌与运行时生成的步骤双态牌面。
 *
 * 为什么不像第三行那样整段抄模板：第三行的 `const ANIM_SVG` 是静态模板，可逐字移植；
 *   第五行的 SVG 是 svgAxisSpin(...) 用 ${} 插值现场拼的（面/几何/关键帧来自 JS 常量），
 *   所以这里改为「结构 + 可见性关键帧抄参考稿、几何与轴角取数据源」的生成方式，
 *   并对参考稿做结构断言（见 guardTokens），保证移植目标仍是第五行那条变体。
 *
 * 出口形态：自包含 SMIL SVG（无外部 CSS、无脚本），作为 CSS mask 的 data URI：
 *   · style="color:#fff" —— mask 只用 alpha 通道，真实牌线颜色由伪元素的
 *     background-color:currentColor 决定（跟随 DSH 主题）；
 *   · 内联 .anim-card{fill:transparent}（数据 URI 不继承宿主 CSS）；
 *   · 牌面宽高 16（mask-size:24px → 与回合栏 24px 渲染逐像素同比例）。
 *
 * 运行：node scripts/sync-step-anim.mjs
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
const spin = icons.pokerSpin
const pips = icons.pokerPips

/** 参考稿里必须仍然存在的结构标记（第五行接线 + 共轭变换 + 可见性关键帧 + 时序）。 */
const guardTokens = [
  'function svgAxisSpin(s, shape',
  'function diagonalRestAngle(shape',
  'svgAxisSpin(16, shape, 0, restAngle)',                    // 第五行的调用点
  '牌面翻转 · 竖直对角线轴',                                   // 第五行的标题
  'transform="rotate(${axisAngle})"',                        // 共轭：正向
  'transform="rotate(${-axisAngle})"',                       // 共轭：反向
  'class="axis-rest-rotation" data-rest-angle="${restAngle}"',
  'transform="rotate(${restAngle})"',                        // 对角线休息角
  'type="scale"',
  'dur="1.6s"',                                              // 单次翻面
  'dur="6.4s"',                                              // 四花色一整轮
  'hidden;visible;hidden;visible;hidden;visible;hidden;visible;hidden;hidden',  // 牌背窗口
  "spade:   { initial: 'visible', values: 'visible;hidden;visible;visible', keyTimes: '0;0.0625;0.9375;1' }",
  "heart:   { initial: 'hidden',  values: 'hidden;visible;hidden;hidden',  keyTimes: '0;0.1875;0.3125;1' }",
  "diamond: { initial: 'hidden',  values: 'hidden;visible;hidden;hidden',  keyTimes: '0;0.4375;0.5625;1' }",
  "club:    { initial: 'hidden',  values: 'hidden;visible;hidden;hidden',  keyTimes: '0;0.6875;0.8125;1' }",
]
for (const token of guardTokens) {
  if (!html.includes(token)) throw new Error('参考稿第五行结构漂移，缺少标记: ' + token)
}
// 只在 svgAxisSpin 的函数体内取字面量：第三行的轮换动画也用 type="scale"，
// 全文匹配会抓错对象（这正是"移植对象必须是第五行"这条断言的用意）。
const fnStart = html.indexOf('function svgAxisSpin')
const fnEnd = html.indexOf('function renderAxisSpinCard', fnStart)
if (fnStart < 0 || fnEnd < fnStart) throw new Error('参考稿缺少 svgAxisSpin 函数体')
const flipBody = html.slice(fnStart, fnEnd)
const pageH = Number(flipBody.match(/const h = ([\d.]+)/)[1])
const pageRatio = html.match(/const POKER_RATIO = ([\d\s/]+)/)[1].trim()
const pageR = Number(flipBody.match(/const r = shape === 'poker' \? ([\d.]+)/)[1])
const pageStroke = Number(flipBody.match(/const strokeW = ([\d.]+)/)[1])
const pagePipScale = Number(flipBody.match(/const pipScale = ([\d.]+)/)[1])
const pageScaleValues = flipBody.match(/type="scale"\s*values="([^"]+)"/)[1]
const pageScaleKeyTimes = flipBody.match(/type="scale"\s*values="[^"]+"\s*keyTimes="([^"]+)"/)[1]
const pageRatioValue = Function('return ' + pageRatio)()   // "5 / 7" → 0.7142857142857143

// ── 数值源 ↔ 参考稿逐项对齐（任一漂移即失败） ──
const expect = (label, left, right) => {
  if (left !== right) throw new Error(label + ' 不一致：数据源 ' + left + ' ≠ 参考稿 ' + right)
}
expect('pokerSpin.h', spin.h, pageH)
expect('pokerSpin.pokerRatio', spin.pokerRatio, pageRatioValue)
expect('pokerSpin.r', spin.r, pageR)
expect('pokerSpin.strokeW', spin.strokeW, pageStroke)
expect('pokerSpin.pipScale', spin.pipScale, pagePipScale)
expect('pokerSpin.scaleKeys', spin.scaleKeys, pageScaleValues)
expect('pokerSpin.scaleKeyTimes', spin.scaleKeyTimes, pageScaleKeyTimes)

// ── 几何（与回合栏 buildPokerSpinSVG 同一套算式） ──
const H = spin.h
const W = H * spin.pokerRatio
const X = 8 - W / 2
const Y = 8 - H / 2
const R = spin.r
const STROKE = spin.strokeW
const PIP_SCALE = spin.pipScale
const LOGO_SCALE = Math.min(W * 0.72, H * 0.58) / 24
const REST = spin.restAngle
// 对角线轴恒等式：轴角 = atan(w/h)（数据源存的是四舍五入到 4 位小数的值）
const atanDeg = Math.atan(W / H) * 180 / Math.PI
if (Number(atanDeg.toFixed(4)) !== Number(REST)) {
  throw new Error('pokerSpin.restAngle 不是 atan(w/h)：' + REST + ' ≠ ' + atanDeg)
}

const SUITS = ['spade', 'heart', 'diamond', 'club']
/** 四花色可见性窗口（6.4s 一整轮：♠ → 背 → ♥ → 背 → ♦ → 背 → ♣ → 背 → ♠）。 */
const SUIT_VIS = {
  spade: { initial: 'visible', values: 'visible;hidden;visible;visible', keyTimes: '0;0.0625;0.9375;1' },
  heart: { initial: 'hidden', values: 'hidden;visible;hidden;hidden', keyTimes: '0;0.1875;0.3125;1' },
  diamond: { initial: 'hidden', values: 'hidden;visible;hidden;hidden', keyTimes: '0;0.4375;0.5625;1' },
  club: { initial: 'hidden', values: 'hidden;visible;hidden;hidden', keyTimes: '0;0.6875;0.8125;1' },
}
/** 牌背（DeepSeek 鲸鱼）窗口：每次翻到背面都显示，正面时隐藏。 */
const BACK_VIS = 'hidden;visible;hidden;visible;hidden;visible;hidden;visible;hidden;hidden'
const BACK_KEYS = '0;0.0625;0.1875;0.3125;0.4375;0.5625;0.6875;0.8125;0.9375;1'
/** 翻面周期（= 参考稿 svgAxisSpin 的 scale 时长）与一整轮花色周期。 */
const FLIP_DUR = '1.6s'
const CYCLE_DUR = '6.4s'
/** 牌背 Logo 的 def id（每个 data URI 是独立文档，固定 id 安全）。 */
const LOGO_ID = 'axis-deepseek-step'

const faceRect = '<rect class="anim-card axis-spin-card" x="' + X + '" y="' + Y +
  '" width="' + W + '" height="' + H + '" rx="' + R +
  '" stroke="currentColor" stroke-width="' + STROKE + '"/>'
const logoDef = icons.pokerSpinDeepseek.replace('axis-deepseek-UID', LOGO_ID)

/** 一张花色正面：可见性窗口 + 卡牌轮廓 + 居中花色（与参考稿 suitFace 同结构）。 */
function suitFace(suit) {
  const info = pips[suit]
  const vis = SUIT_VIS[suit]
  return '<g visibility="' + vis.initial + '">' +
    '<animate attributeName="visibility" values="' + vis.values + '" keyTimes="' + vis.keyTimes +
    '" dur="' + CYCLE_DUR + '" repeatCount="indefinite" calcMode="discrete"/>' +
    faceRect +
    '<g transform="translate(8 8) scale(' + PIP_SCALE * info.factor + ') translate(' + (-info.cx) + ' ' + (-info.cy) + ')">' +
    info.path + '</g></g>'
}

let svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" style="color:#fff">' +
  '<defs>' + logoDef + '</defs>' +
  '<style>.anim-card{fill:transparent}</style>' +
  // 共轭变换：R(0) · scaleX(cosθ) · R(0) · R(restAngle)
  //   scale 组先把卡牌按 cosθ 收窄（θ 过 90°/270° 时零宽切面换面，视觉无跳变），
  //   紧随其后的 tf-step-axis 组把「左上→右下对角线」旋到竖直方向 —— 于是翻转
  //   看起来是绕这条真实对角线发生的（与回合栏 ccg-axis-rest-rotation 同一几何）。
  //   注意：轴角只由该组的 SVG transform 属性决定，CSS 不得再写 transform 覆盖它
  //   （CSS transform 会压掉同名属性 —— 回合栏踩过这个坑），故类名与回合栏区分开，
  //   由 tests/unit.css.test.mjs 的翻牌契约守卫看着。
  '<g transform="translate(8 8)">' +
  '<g>' +
  '<animateTransform attributeName="transform" type="scale" values="' + spin.scaleKeys +
  '" keyTimes="' + spin.scaleKeyTimes + '" dur="' + FLIP_DUR + '" repeatCount="indefinite" calcMode="linear"/>' +
  '<g class="tf-step-axis" transform="rotate(' + REST + ')">' +
  '<g transform="translate(-8 -8)">' +
  SUITS.map(suitFace).join('') +
  '<g visibility="hidden">' +
  '<animate attributeName="visibility" values="' + BACK_VIS + '" keyTimes="' + BACK_KEYS +
  '" dur="' + CYCLE_DUR + '" repeatCount="indefinite" calcMode="discrete"/>' +
  faceRect +
  '<g transform="translate(8 8) scale(' + LOGO_SCALE + ') translate(12 -12) scale(-1 1)">' +
  '<use href="#' + LOGO_ID + '" fill="currentColor"/></g></g>' +
  '</g></g></g></g></svg>'

// ── 出口校验（嵌入 client.js 单引号字符串；且必须仍是被移植的那条动画） ──
svg = svg.replace(/\s+/g, ' ').replace(/>\s+</g, '><').trim()
if (svg.includes("'") || svg.includes('\\')) throw new Error('SVG 含单引号或反斜杠，需先转义')
if (svg.includes('${')) throw new Error('SVG 仍有未解析的插值占位符')
for (const token of [
  '<animateTransform', 'type="scale" values="1 1;', 'calcMode="linear"',
  'class="tf-step-axis"', 'transform="rotate(' + REST + ')"',
  'dur="' + FLIP_DUR + '"', 'dur="' + CYCLE_DUR + '"',
  'calcMode="discrete"', 'id="' + LOGO_ID + '"', '.anim-card{fill:transparent}',
  'stroke="currentColor"', 'width="' + W + '"', 'height="' + H + '"', 'rx="' + R + '"',
]) {
  if (!svg.includes(token)) throw new Error('生成结果缺少结构标记: ' + token)
}
// 四张正面必须逐字来自数据源（大小王花色 + 各自的 24 单位视箱居中变换）
for (const suit of SUITS) {
  if (!svg.includes(pips[suit].path)) throw new Error('生成结果缺少花色正面: ' + suit)
  if (!svg.includes('translate(' + (-pips[suit].cx) + ' ' + (-pips[suit].cy) + ')')) {
    throw new Error('花色 ' + suit + ' 的居中变换与数据源不一致')
  }
}
// 单张牌翻面不需要第三行那套遮挡机；也必须不引入 CSS 3D / 第二伪元素语义
for (const banned of ['mask=', 'mask-type', 'rotateY', 'perspective', 'scaleX', 'backface-visibility',
  'ccg-axis-rest-rotation', 'phase-1', 'primitiveUnits']) {
  if (svg.includes(banned)) throw new Error('生成结果出现禁用标识: ' + banned)
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

console.log('[sync-step-anim] 牌面翻转 · 竖直对角线轴（参考稿第五行）',
  '| svg length:', svg.length,
  '| 轴角:', REST + '°',
  '| animateTransform:', (svg.match(/<animateTransform/g) || []).length,
  '| animate:', (svg.match(/<animate\b/g) || []).length,
  '| 正面:', SUITS.length, '| 牌背:', svg.includes('id="' + LOGO_ID + '"') ? 1 : 0)
