#!/usr/bin/env node
/**
 * 从参考实现 docs/扑克牌轮换_动态蒙版遮挡_文件图标加强版.html 的第三行
 * 「牌面轮换 · 正向」机械化移植 Step Running 五牌面轮换 SVG，并写入 client.js 的
 * `>>> step-running-poker-svg` / `<<< step-running-poker-svg` 标记块。
 *
 * 转换规则（与参考页自身保持一致，不改任何 SMIL 关键帧/时序）：
 *   1) 只取 `const ANIM_SVG = \`...\`` 模板内容；去掉页面预览用的 demo-border 虚线框；
 *   2) 与参考页 applyAnimationShape('poker') 同规则适配 5:7 牌形：
 *        卡牌 rect 8×5.714（baseW = 8×5/7）rx 1.08；
 *        蒙版 rect 同宽 +0.72、同高 +0.72（连同 stroke 一起挖空）rx 1.44；
 *   3) 内联参考页 CSS `.anim-card{fill:transparent}`（数据 URI 无外部样式，必须自包含）；
 *   4) 颜色固定 #fff：作为 CSS mask 时仅使用 alpha 通道，实际牌线颜色由伪元素的
 *      background-color:currentColor 决定（跟随 DSH 主题）；
 *   5) 去注释、压紧空白后写入标记块（单引号 JS 字符串，脚本会校验无引号/反斜杠）。
 *
 * 运行：node scripts/sync-step-anim.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REF = path.join(root, 'docs', '扑克牌轮换_动态蒙版遮挡_文件图标加强版.html')
const CLIENT = path.join(root, 'client.js')

const html = fs.readFileSync(REF, 'utf8')
const start = html.indexOf('const ANIM_SVG = `')
const end = html.indexOf('</svg>`', start)
if (start < 0 || end < 0) throw new Error('ANIM_SVG 模板未在参考 HTML 中找到')
let svg = html.slice(start + 'const ANIM_SVG = `'.length, end + '</svg>'.length)

// 1) 自包含颜色 + 内联参考页卡片样式（数据 URI 不继承宿主 CSS）
svg = svg.replace(/\s*style="color:var\(--card-stroke,#fff\)"/, ' style="color:#fff"')
svg = svg.replace('</defs>', '</defs><style>.anim-card{fill:transparent}</style>')

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

// 4) 去注释、压缩空白
svg = svg.replace(/<!--[\s\S]*?-->/g, '')
svg = svg.replace(/\s+/g, ' ').replace(/>\s+</g, '><').trim()

// 5) 校验（嵌入单引号 JS 字符串，且必须仍包含参考动画的关键结构）
if (svg.includes("'") || svg.includes('\\')) throw new Error('SVG 含单引号或反斜杠，需先转义')
for (const token of ['<animateTransform', 'mask-plus-out', 'mask-plus-in', 'mask-minus-out', 'mask-minus-in', 'phase-1', 'phase-5', 'pip-deepseek', 'calcMode="discrete"', 'dur="0.8s"', 'dur="4s"']) {
  if (!svg.includes(token)) throw new Error('转换后缺少结构标记: ' + token)
}

const client = fs.readFileSync(CLIENT, 'utf8')
const mStart = client.indexOf('/* >>> step-running-poker-svg')
const mEnd = client.indexOf('/* <<< step-running-poker-svg */')
if (mStart < 0 || mEnd < 0 || mEnd < mStart) throw new Error('client.js 缺少标记块')
const block = '/* >>> step-running-poker-svg (generated; do not edit; regenerate: node scripts/sync-step-anim.mjs) */\n'
  + "\t\tvar STEP_RUNNING_POKER_SVG = '" + svg + "';\n"
  + '\t\t'
fs.writeFileSync(CLIENT, client.slice(0, mStart) + block + client.slice(mEnd))

console.log('[sync-step-anim] svg length:', svg.length,
  '| animateTransform:', (svg.match(/<animateTransform/g) || []).length,
  '| animate:', (svg.match(/<animate\b/g) || []).length,
  '| masks:', (svg.match(/url\(#mask-/g) || []).length)
