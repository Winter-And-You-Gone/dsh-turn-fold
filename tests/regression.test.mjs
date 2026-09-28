// 历史回归（每修一个 bug 都要往里加用例）：
//   1. 直播时钟：订阅者在回调栈内全部退订后不得留下空转定时器（无人持有的 250ms 链）
//   2. 假 token 增长已删除：真实数据不变 → 数字不变（跨渲染、跨直播 tick 都不漂移）
//   3. 齿轮点击 stopPropagation：弹窗不误触折叠 toggle
//   4. 运行中栏不是 Fold Controller：任何交互都不产生 setOpen
//   5. 注册异常软降级：单个条目抛错不影响其余功能与宿主启动
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { loadPlugin } from './helpers/loader.mjs'
import {
  T0, makeTurnNode, makeTurnProcessOwner, makeUseChat, makeStep, makeStepData,
} from './helpers/fixtures.mjs'

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

const PRIMITIVES_STUB = {
  IconChevronDownOutline14: function IconChevronDownStub() { return null },
  IconChevronRightOutline14: function IconChevronRightStub() { return null },
  Toast: function ToastStub() { return null },
}
const { test: T } = loadPlugin({ window: dom.window, uiPrimitives: PRIMITIVES_STUB })
const react = require('react')

let container = null
let root = null
function mount() {
  container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  root = createRoot(container)
}
function renderView(props) {
  act(() => { root.render(react.createElement(T.EnhancedTurnProcessView, props)) })
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const usageStep = makeStep(1, makeStepData(1, {
  usage: { inputTokens: 1000, outputTokens: 3214, cacheReadTokens: 2000 },
}))

beforeEach(() => {
  dom.window.localStorage.clear()
  mount()
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

describe('直播时钟状态机', () => {
  it('最后一个订阅者在回调栈内退订 → 定时器被回收，无空转链', async () => {
    const unsub = T.subscribeTicks(() => {
      // 回调栈内退订自己（模拟 React uSES 同步重渲染路径）
      unsub()
    })
    // 等待 2 个 tick 周期（基准 250ms × 随机 0.5~1）
    await sleep(700)
    assert.equal(T.tickListeners.size, 0, '订阅者已全部退订')
    const version = T.getTickVersion()
    await sleep(700)
    assert.equal(T.getTickVersion(), version, '无订阅者后时钟停表（无空转定时器）')
  })

  it('回调期间新订阅者不会开出并行链（tick 速率不翻倍）', async () => {
    let innerSubscribed = false
    let inner = null
    const unsub = T.subscribeTicks(() => {
      if (!innerSubscribed) {
        innerSubscribed = true
        inner = T.subscribeTicks(() => {}) // 回调内订阅
      }
    })
    await sleep(700)
    assert.ok(innerSubscribed)
    assert.equal(T.tickListeners.size, 2, '回调内订阅被接受')
    // 退订全部 → 停表
    unsub()
    inner()
    assert.equal(T.tickListeners.size, 0)
    const version = T.getTickVersion()
    await sleep(700)
    assert.equal(T.getTickVersion(), version)
  })
})

describe('禁止假 Token 增长（真实数据不变 → 数字不变）', () => {
  it('真实数据不变的重复渲染：token 数值逐字节一致（无 +1/+11 动画偏移）', () => {
    const props = () => ({
      node: makeTurnNode({ status: 'closed', steps: [usageStep] }),
      turnProcess: makeTurnProcessOwner(),
      useChat: makeUseChat(),
    })
    renderView(props())
    const label1 = container.querySelector('.ccg-turn-bar-label').textContent
    renderView(props())
    const label2 = container.querySelector('.ccg-turn-bar-label').textContent
    assert.equal(label1, label2)
    assert.ok(label1.includes('6,214 token'), label1)
  })

  it('运行中跨直播 tick：耗时增长（真实时钟），token 保持真实值不变', async () => {
    const realNow = Date.now
    Date.now = () => T0 + 5000
    try {
      renderView({
        node: makeTurnNode({ status: 'open', startTime: T0, endTime: null, steps: [usageStep] }),
        turnProcess: makeTurnProcessOwner(),
        useChat: makeUseChat(),
      })
      const label1 = container.querySelector('.ccg-turn-bar-label').textContent
      assert.ok(label1.includes('6,214 token'), label1)
      // 等待 1-2 个直播 tick（仅时钟前进；usage 无新数据）
      await sleep(700)
      const label2 = container.querySelector('.ccg-turn-bar-label').textContent
      assert.ok(label2.includes('6,214 token'), 'token 不被伪造增长：' + label2)
      // 耗时字段来自真实时钟，允许 ≥ 之前的秒数
      const sec1 = Number(/耗时(\d+)秒/.exec(label1)[1])
      const sec2 = Number(/耗时(\d+)秒/.exec(label2)[1])
      assert.ok(sec2 >= sec1, '耗时随真实时钟推进')
    } finally {
      Date.now = realNow
    }
  })
})

describe('齿轮与折叠互不误触', () => {
  it('齿轮点击：stopPropagation → 不触发 setOpen，弹窗打开', () => {
    const setOpenCalls = []
    renderView({
      node: makeTurnNode({ status: 'closed', steps: [usageStep] }),
      turnProcess: makeTurnProcessOwner({ setOpen: (o) => setOpenCalls.push(o) }),
      useChat: makeUseChat(),
    })
    T.setPopupVisible(false)
    const gear = container.querySelector('.ccg-gear-icon')
    assert.ok(gear)
    act(() => {
      gear.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
    assert.deepEqual(setOpenCalls, [], '弹窗触发不得折叠回合')
    assert.equal(T.getPopupVisible(), true, '弹窗已打开')
    T.setPopupVisible(false)
  })

  it('不可折叠栏（aborted）点击整行：无 setOpen、无异常', () => {
    const setOpenCalls = []
    renderView({
      node: makeTurnNode({ status: 'closed', reason: 'aborted', steps: [usageStep] }),
      turnProcess: makeTurnProcessOwner({ setOpen: (o) => setOpenCalls.push(o) }),
      useChat: makeUseChat(),
    })
    const bar = container.querySelector('button.ccg-turn-bar')
    act(() => {
      bar.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
    assert.deepEqual(setOpenCalls, [])
  })
})

describe('降级要求（UI 增强可坏，Fold 不能被拖坏）', () => {
  it('图标包损坏（非法 JSON / 不兼容 compat）→ 回退内置默认，不抛错', () => {
    dom.window.localStorage.setItem('dsh-turn-fold:icons', '{broken')
    assert.doesNotThrow(() => loadPlugin({ window: dom.window }))
    dom.window.localStorage.setItem('dsh-turn-fold:icons', JSON.stringify({
      meta: { version: 1, compat: '>=99.0.0' },
      pokerPips: { spade: { path: '', cx: 12, cy: 12, factor: 1 } },
    }))
    const { test: T2 } = loadPlugin({ window: dom.window })
    assert.ok(T2.POKER_PIPS.spade.path.length > 0, '不兼容图标包被拒绝，回退内置')
    dom.window.localStorage.removeItem('dsh-turn-fold:icons')
  })

  it('设置数据损坏 → 回退默认值，不抛错', () => {
    dom.window.localStorage.setItem(T.SETTINGS_KEY, '{broken json')
    const { test: T2 } = loadPlugin({ window: dom.window })
    assert.equal(T2.settings.stepSkin, 'poker')
    assert.equal(T2.settings.fields.tokens, true)
  })

  it('Turn 栏渲染所需 props 全部缺失（裸 node）→ 不抛错（降级最小占位栏）', () => {
    const props = { node: { kind: 'turn-process', data: {} } }
    assert.doesNotThrow(() => {
      act(() => { root.render(react.createElement(T.EnhancedTurnProcessView, props)) })
    })
    assert.ok(container.querySelector('.ccg-turn-bar'), '最小占位栏仍渲染')
  })
})
