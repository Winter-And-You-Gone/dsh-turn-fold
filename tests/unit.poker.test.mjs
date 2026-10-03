// Poker 视觉测试（插件签名视觉保留验证）：
//   - 活动 → 花色映射（thinking→♥ read→♠ edit→♦ commands→♣ 编排→鲸鱼）
//   - 牌堆/扇形 SVG（3 牌 / 5 牌 / 鲸鱼牌面）与运行中翻牌 SVG
//   - 组件渲染（PokerIcon / PokerSpinIcon）与 reduced-motion / 无 WAAPI 的静态降级
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { loadPlugin } from './helpers/loader.mjs'

const require = createRequire(import.meta.url)

import dom, { sharedWindow, sharedDocument } from './helpers/dom.mjs'

// 官方 UI 原语桩：chevron 图标 / Toast（组件身份稳定即可，渲染为空元素）
const PRIMITIVES_STUB = {
  IconChevronDownOutline14: function IconChevronDownStub() { return null },
  IconChevronRightOutline14: function IconChevronRightStub() { return null },
  Toast: function ToastStub() { return null },
}
const { test: T } = loadPlugin({ window: sharedWindow })
const react = require('react')

let container = null
let root = null
function mount(el) {
  container = sharedDocument.createElement('div')
  sharedDocument.body.appendChild(container)
  root = createRoot(container)
  act(() => { root.render(el) })
}

beforeEach(() => {
  sharedWindow.localStorage.clear()
  T.setIconStyle('poker')
})

afterEach(() => {
  if (root) {
    act(() => { root.unmount() })
    root = null
  }
  if (container) {
    container.remove()
    container = null
  }
})

describe('活动 → 花色映射（Step Poker Skin 数据源）', () => {
  it('goal 指定映射：thinking→heart read→spade edit→diamond commands→club 编排→whale', () => {
    assert.equal(T.activitySuitOf('thinking'), 'heart')
    assert.equal(T.activitySuitOf('questions'), 'heart')
    assert.equal(T.activitySuitOf('read'), 'spade')
    assert.equal(T.activitySuitOf('readImage'), 'spade')
    assert.equal(T.activitySuitOf('search'), 'spade')
    assert.equal(T.activitySuitOf('webSearch'), 'spade')
    assert.equal(T.activitySuitOf('webFetch'), 'spade')
    assert.equal(T.activitySuitOf('edit'), 'diamond')
    assert.equal(T.activitySuitOf('write'), 'diamond')
    assert.equal(T.activitySuitOf('commands'), 'club')
    assert.equal(T.activitySuitOf('code'), 'club')
    assert.equal(T.activitySuitOf('subagents'), 'whale')
    assert.equal(T.activitySuitOf('plan'), 'whale')
    assert.equal(T.activitySuitOf('tools'), 'whale')
  })

  it('未登记活动回退 heart（官方默认 activity=thinking 同款）', () => {
    assert.equal(T.activitySuitOf('somethingNew'), 'heart')
    assert.equal(T.activitySuitOf(undefined), 'heart')
  })

  it('官方 ProcessActivity 词表全覆盖', () => {
    const official = ['thinking', 'read', 'readImage', 'search', 'edit', 'write', 'commands', 'code', 'webSearch', 'webFetch', 'subagents', 'plan', 'questions', 'tools']
    for (const a of official) assert.ok(T.ACTIVITY_SUIT[a] !== undefined, '缺活动 ' + a)
  })
})

describe('SVG 生成', () => {
  it('buildPokerSVGBase(3)：3 张牌 + 各牌独立 mask', () => {
    const svg = T.buildPokerSVGBase(3, 'spade')
    assert.equal((svg.match(/ccg-poker-card/g) || []).length, 3)
    assert.equal((svg.match(/<mask /g) || []).length, 3)
    assert.ok(svg.includes('ccg-poker-pip'), '花色点已注入')
  })

  it('buildPokerSVGBase(5, deepseek)：5 张牌 + 鲸鱼 defs', () => {
    const svg = T.buildPokerSVGBase(5, 'deepseek')
    assert.equal((svg.match(/ccg-poker-card/g) || []).length, 5)
    assert.ok(svg.includes('ccg-poker-logo-'), '鲸鱼 logo 注入 defs')
    assert.ok(svg.includes('use href="#ccg-poker-logo-'), 'pip 引用鲸鱼')
  })

  it('buildPokerSpinSVG：四花色循环 + DeepSeek 背面 + 唯一 id 替换', () => {
    const svg = T.buildPokerSpinSVG('uid42')
    assert.ok(svg.includes('axis-deepseek-uid42'), 'uid 替换')
    // 花色名不出现在 markup（可见性用 SMIL 关键帧驱动）：4 组正面 + 1 组背面 = 5 组循环
    assert.equal((svg.match(/<animate /g) || []).length, 5, '四花色 + 背面的循环动画')
    assert.ok(svg.includes('axis-deepseek-uid42'), '鲸鱼背面')
    assert.ok(svg.includes('animateTransform'), '翻转动画')
    assert.ok(svg.includes('repeatCount="indefinite"'))
  })

  it('pokerTransforms：牌堆 ↔ 扇形两套位姿', () => {
    const stack = T.pokerTransforms(3, false)
    const fan = T.pokerTransforms(3, true)
    assert.notDeepEqual(stack, fan)
    assert.equal(Object.keys(T.pokerTransforms(5, false)).length, 5)
  })

  it('pokerFacePool：注入数据后含鲸鱼牌面', () => {
    assert.ok(T.POKER_SPIN_DEEPSEEK, 'ICON_DEFAULTS 已注入鲸鱼数据')
    assert.deepEqual(T.pokerFacePool(), ['spade', 'heart', 'diamond', 'club', 'deepseek'])
  })

  it('foldSuitFor：同一 key 牌面稳定，且属于牌面池', () => {
    const pool = T.pokerFacePool()
    const suit = T.foldSuitFor('turn:13')
    assert.equal(T.foldSuitFor('turn:13'), suit)
    assert.ok(pool.includes(suit))
  })

  it('suitMaskImage：四花色 + 鲸鱼都能产出 mask data-URI', () => {
    for (const suit of ['heart', 'spade', 'diamond', 'club', 'whale']) {
      const img = T.suitMaskImage(suit)
      assert.ok(img.startsWith('url("data:image/svg+xml,'), suit + ' mask 缺失')
    }
  })
})

describe('组件渲染与降级', () => {
  it('PokerIcon 渲染出 svg 与 3 张牌', () => {
    mount(react.createElement(T.PokerIcon, { count: 3, suit: 'heart', open: false }))
    const svg = container.querySelector('.ccg-poker-icon svg')
    assert.ok(svg)
    assert.equal(container.querySelectorAll('.ccg-poker-card').length, 3)
  })

  it('PokerSpinIcon 渲染翻牌动画 SVG', () => {
    mount(react.createElement(T.PokerSpinIcon, null))
    assert.ok(container.querySelector('.ccg-poker-icon .ccg-poker-svg svg'))
  })

  it('无 WAAPI 环境（jsdom）→ RollDigit 直接定位、无动画调用', () => {
    mount(react.createElement(T.RollDigit, { digit: 3 }))
    const strip = container.querySelector('.ccg-roll-strip')
    assert.ok(strip)
    assert.equal(strip.style.transform, 'translateY(-30%)')
  })

  it('prefers-reduced-motion → RollDigit 静态定位', () => {
    dom.window.matchMedia = (q) => ({ matches: q.includes('reduce'), addListener() {}, removeListener() {} })
    try {
      mount(react.createElement(T.RollDigit, { digit: 7 }))
      const strip = container.querySelector('.ccg-roll-strip')
      assert.equal(strip.style.transform, 'translateY(-70%)')
    } finally {
      delete dom.window.matchMedia
    }
  })

  it('AnimatedLabel：数字段逐位滚动 + sr-only 完整文案', () => {
    mount(react.createElement(T.AnimatedLabel, { label: '耗时1分32秒' }))
    assert.ok(container.querySelector('.ccg-sr-only').textContent === '耗时1分32秒')
    assert.ok(container.querySelectorAll('.ccg-roll-cell').length >= 3, '数字位滚动窗')
  })

  it('turnPokerIcon：poker 风格运行中→翻牌、结束→牌堆；native→官方几何 chevron（running/不可折叠→undefined）', () => {
    // 渲染层 smoke：返回元素类型正确
    const live = T.turnPokerIcon(4, true, false, 13, true)
    assert.ok(live, '运行中返回翻牌图标元素')
    const closed = T.turnPokerIcon(4, false, false, 13, true)
    assert.ok(closed, '结束返回牌堆图标元素')
    T.setIconStyle('native')
    const chevron = T.turnPokerIcon(4, false, false, 13, true)
    assert.ok(chevron, 'native 结束且可折叠 → 官方风格 chevron 元素')
    assert.equal(chevron.props.open, false, '收起态向下')
    assert.ok(T.turnPokerIcon(4, false, true, 13, true).props.open, '展开态 rotate(180deg)')
    assert.equal(T.turnPokerIcon(4, true, false, 13, true), undefined, 'native 运行中无前导图标（官方如此）')
    assert.equal(T.turnPokerIcon(4, false, false, 13, false), undefined, 'native 不可折叠（Verbose）无 chevron（官方如此）')
    T.setIconStyle('poker')
  })
})

// ══════════════════════════════════════════════════════════════════════
// 3 张牌身份连续性：stack ↔ fan 是同一张牌，层级与身份都不交换
// ══════════════════════════════════════════════════════════════════════
// 旧实现 fan3 = { 1: -26°, 2: +26°, 3: 0° } ⇒ 收起时的顶牌 card3 展开后**留在中间**，
// card2 跑到最右并（配合 order [1,3,2]）变成顶层——顶牌身份被顶替。
// 正确映射与 fan5 同构：居中那张不带旋转，两侧对称，id 越大越靠右（顶牌向右展开）。
describe('3 张牌身份连续性（stack ↔ fan 同一 card id）', () => {
  const rotateOf = (s) => { const m = /rotate\(([-\d.]+) 8 12\)/.exec(s); return m ? Number(m[1]) : 0 }
  const translateOf = (s) => { const m = /translate\(([-\d.]+), ([-\d.]+)\)/.exec(s); return { x: Number(m[1]), y: Number(m[2]) } }

  it('stack3：card1 底（右下）、card2 中、card3 顶（左上）', () => {
    const stack = T.pokerTransforms(3, false)
    const [c1, c2, c3] = [translateOf(stack[1]), translateOf(stack[2]), translateOf(stack[3])]
    assert.ok(c1.x > c2.x && c2.x > c3.x, 'x 递减：card1 最右、card3 最左')
    assert.ok(c1.y > c2.y && c2.y > c3.y, 'y 递减：card1 最下、card3 最上（顶牌）')
    assert.equal(rotateOf(stack[1]) + rotateOf(stack[2]) + rotateOf(stack[3]), 0, '牌堆无旋转')
  })

  it('fan3：card1 左（-26°）、card2 居中（0°）、card3 右（+26°）', () => {
    const fan = T.pokerTransforms(3, true)
    assert.equal(rotateOf(fan[1]), -26, 'card1 = 左牌')
    assert.equal(rotateOf(fan[2]), 0, 'card2 = 中牌（居中不旋转）')
    assert.equal(rotateOf(fan[3]), 26, 'card3 = 右牌（原顶牌向右展开）')
  })

  it('fan3 三张统一 translate(0, -0.18)（只改身份映射，不动几何量）', () => {
    const fan = T.pokerTransforms(3, true)
    for (const i of [1, 2, 3]) {
      const t = translateOf(fan[i])
      assert.equal(t.x, 0, 'card' + i + ' tx')
      assert.equal(t.y, -0.18, 'card' + i + ' ty')
    }
  })

  it('身份方向连续：底层牌向左、顶牌向右（与 fan5 同一规律）', () => {
    const fan3 = T.pokerTransforms(3, true), fan5 = T.pokerTransforms(5, true)
    assert.ok(rotateOf(fan3[1]) < 0 && rotateOf(fan3[3]) > 0, '3 张：id 小在左、id 大在右')
    assert.ok(rotateOf(fan5[1]) < 0 && rotateOf(fan5[5]) > 0, '5 张同规律')
    assert.equal(rotateOf(fan5[3]), 0, '5 张居中那张也不旋转（fan3 与 fan5 同构）')
    // 每张牌在 stack 里越靠上（y 越小），fan 里越靠右（角度越大）——身份不被交换
    const stack3 = T.pokerTransforms(3, false)
    const order = [1, 2, 3].sort((a, b) => translateOf(stack3[b]).y - translateOf(stack3[a]).y)
    const angles = order.map((i) => rotateOf(fan3[i]))
    assert.deepEqual(angles, [-26, 0, 26], 'stack 从下到上 ↔ fan 从左到右一一对应：' + JSON.stringify(angles))
  })

  it('绘制顺序 = 身份序（开合一致）：card3 在两种状态下都是 z-top', () => {
    assert.deepEqual(T.pokerPaintOrder(3), [1, 2, 3], '3 张 closed')
    assert.deepEqual(T.pokerPaintOrder(5), [1, 2, 3, 4, 5], '5 张 closed')
    // 旧 bug 的形态：3 张展开曾是 [1,3,2]（card2 压顶）
    assert.notDeepEqual(T.pokerPaintOrder(3), [1, 3, 2], '不得再用 [1,3,2]')
    const zOf = (count) => Object.fromEntries(T.pokerPaintOrder(count).map((id, index) => [id, index]))
    for (const count of [3, 5]) {
      const z = zOf(count)
      assert.equal(z[count], count - 1, '最大 id 的牌必须最上层')
      assert.ok(z[3] > z[2] && z[2] > z[1], 'z 随 id 递增')
    }
  })

  it('iconConfig 数据源与代码 fallback 的 fan3 必须逐值一致（单一事实来源）', async () => {
    const { readFileSync } = await import('node:fs')
    const json = JSON.parse(readFileSync(new URL('../icons/default.json', import.meta.url), 'utf8'))
    const embedded = T.ICON_DEFAULTS.pokerTransforms
    assert.deepEqual(embedded.fan3, json.pokerTransforms.fan3, 'ICON_DEFAULTS 与 default.json 一致')
    const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
    const fallback = /: t\.fan3 \|\| \{ ([^}]+) \}/.exec(source)
    assert.ok(fallback, 'client.js 里存在 fan3 fallback')
    for (const [id, value] of Object.entries(json.pokerTransforms.fan3)) {
      assert.ok(fallback[1].includes(`${id}: "${value}"`), 'fallback 缺少/不匹配 card' + id + '：' + value)
    }
  })
})
