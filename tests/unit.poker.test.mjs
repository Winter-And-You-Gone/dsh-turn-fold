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
const { JSDOM } = require('jsdom')

const dom = new JSDOM('<!DOCTYPE html><html><head></head><body><div id="root"></div></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/',
})
globalThis.window = dom.window
globalThis.document = dom.window.document
Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN', languages: ['zh-CN'] }, configurable: true })
globalThis.IS_REACT_ACT_ENVIRONMENT = true

// 官方 UI 原语桩：chevron 图标 / Toast（组件身份稳定即可，渲染为空元素）
const PRIMITIVES_STUB = {
  IconChevronDownOutline14: function IconChevronDownStub() { return null },
  IconChevronRightOutline14: function IconChevronRightStub() { return null },
  Toast: function ToastStub() { return null },
}
const { test: T } = loadPlugin({ window: dom.window, uiPrimitives: PRIMITIVES_STUB })
const react = require('react')

let container = null
let root = null
function mount(el) {
  container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  root = createRoot(container)
  act(() => { root.render(el) })
}

beforeEach(() => {
  dom.window.localStorage.clear()
  T.setFoldIconStyle('poker')
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

  it('turnPokerIcon：poker 风格运行中→翻牌、结束→牌堆；native→undefined', () => {
    // 渲染层 smoke：返回元素类型正确
    const live = T.turnPokerIcon(4, true, false, 13)
    assert.ok(live, '运行中返回翻牌图标元素')
    const closed = T.turnPokerIcon(4, false, false, 13)
    assert.ok(closed, '结束返回牌堆图标元素')
    T.setFoldIconStyle('native')
    assert.equal(T.turnPokerIcon(4, false, false, 13), undefined)
    T.setFoldIconStyle('poker')
  })
})
