// 历史回归（每修一个 bug 都要往里加用例）：
//   1. 秒表时钟：订阅者在回调栈内全部退订后不得留下空转定时器
//   2. 假 token 增长已删除：真实数据不变 → 数字不变（跨渲染、跨秒表 tick 都不漂移）
//   3. Gear 是兄弟按钮：点击不触发 setOpen、面板在组件树内打开
//   4. 不可折叠栏（aborted）点击整行：无 setOpen、无异常
//   5. 降级要求（UI 增强可坏，Fold 不能被拖坏）：图标包/设置损坏回退默认；裸 node 不崩
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { loadPlugin } from './helpers/loader.mjs'
import {
  T0, makeTurnNode, makeTurnProcessOwner, makeUseTurnData, makeStepsSource, makeUseChat,
  makeStep, makeStepData,
} from './helpers/fixtures.mjs'

const require = createRequire(import.meta.url)

import dom, { sharedWindow, sharedDocument } from './helpers/dom.mjs'

const { test: T } = loadPlugin({ window: sharedWindow })
const react = require('react')

let container = null
let root = null
function mount() {
  container = sharedDocument.createElement('div')
  sharedDocument.body.appendChild(container)
  root = createRoot(container)
}
function renderView(props) {
  act(() => { root.render(react.createElement(T.EnhancedTurnProcessView, props)) })
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const usageStepData = makeStepData(1, {
  usage: { inputTokens: 1000, outputTokens: 3214, cacheReadTokens: 2000 },
})
const usageStep = makeStep(1, usageStepData)

beforeEach(() => {
  sharedWindow.localStorage.clear()
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

describe('秒表时钟状态机（固定 1000ms）', () => {
  it('最后一个订阅者在回调栈内退订 → 定时器被回收，无空转链', async () => {
    const unsub = T.subscribeTicks(() => {
      // 回调栈内退订自己（模拟 React uSES 同步重渲染路径）
      unsub()
    })
    // 等待首个 tick（1000ms 固定间隔）；act(async) 吞掉 tick 驱动的 React 更新
    await act(async () => { await sleep(1600) })
    assert.equal(T.tickListeners.size, 0, '订阅者已全部退订')
    const version = T.getTickVersion()
    await act(async () => { await sleep(1600) })
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
    await act(async () => { await sleep(1600) })
    assert.ok(innerSubscribed)
    assert.equal(T.tickListeners.size, 2, '回调内订阅被接受')
    unsub()
    inner()
    assert.equal(T.tickListeners.size, 0)
    const version = T.getTickVersion()
    await act(async () => { await sleep(1600) })
    assert.equal(T.getTickVersion(), version)
  })
})

describe('禁止假 Token 增长（真实数据不变 → 数字不变）', () => {
  it('真实数据不变的重复渲染：token 数值逐字节一致（无 +1/+11 动画偏移）', () => {
    const props = () => ({
      node: makeTurnNode({ status: 'closed', steps: [usageStep] }),
      turnProcess: makeTurnProcessOwner(),
      useTurnData: makeUseTurnData({}),
    })
    renderView(props())
    const label1 = container.querySelector('.ccg-turn-bar-label').textContent
    renderView(props())
    const label2 = container.querySelector('.ccg-turn-bar-label').textContent
    assert.equal(label1, label2)
    assert.ok(label1.includes('6,214 token'), label1)
  })

  it('运行中跨秒表 tick：耗时随真实时钟推进，token 保持真实值不变', async () => {
    const realNow = Date.now
    Date.now = () => T0 + 5000
    try {
      const steps = makeStepsSource([usageStepData])
      renderView({
        node: makeTurnNode({ status: 'open', startTime: T0, endTime: null }),
        turnProcess: makeTurnProcessOwner(),
        useTurnData: makeUseTurnData({}),
        useChat: makeUseChat(steps),
      })
      const label1 = container.querySelector('.ccg-turn-bar-label').textContent
      assert.ok(label1.includes('6,214 token'), label1)
      // 等待 1 个秒表 tick（1000ms 固定；1100ms 窗口只容纳一个 tick，
      // 下一个 tick 由 afterEach 卸载取消——不产生 act 窗口外的更新）
      for (let i = 0; i < 11; i++) {
        await act(async () => { await sleep(100) })
        require('node:fs').appendFileSync('mem.log', i + ' heap=' + Math.round(process.memoryUsage().heapUsed / 1048576) + 'MB listeners=' + T.tickListeners.size + '\n')
      }
      const label2 = container.querySelector('.ccg-turn-bar-label').textContent
      assert.ok(label2.includes('6,214 token'), 'token 不被伪造增长：' + label2)
      const sec1 = Number(/耗时(\d+)秒/.exec(label1)[1])
      const sec2 = Number(/耗时(\d+)秒/.exec(label2)[1])
      assert.ok(sec2 >= sec1, '耗时随真实时钟推进')
    } finally {
      Date.now = realNow
    }
  })
})

describe('齿轮与折叠互不误触（兄弟按钮结构）', () => {
  it('gear 点击：打开面板（组件树内），不触发 setOpen', () => {
    const setOpenCalls = []
    renderView({
      node: makeTurnNode({ status: 'closed', steps: [usageStep] }),
      turnProcess: makeTurnProcessOwner({ setOpen: (o) => setOpenCalls.push(o) }),
      useTurnData: makeUseTurnData({}),
      useChat: makeUseChat(makeStepsSource([usageStep])),
    })
    act(() => { T.setPopupOpen(false, null) })
    const gear = container.querySelector('button.ccg-gear-button')
    assert.ok(gear)
    act(() => { gear.click() })
    assert.deepEqual(setOpenCalls, [], '设置面板绝不折叠回合')
    assert.ok(container.querySelector('.ccg-gear-overlay'), '面板已打开')
    act(() => { T.setPopupOpen(false, null) })
  })

  it('不可折叠栏（aborted）点击整行：无 setOpen、无异常', () => {
    const setOpenCalls = []
    renderView({
      node: makeTurnNode({ status: 'closed', reason: 'aborted', steps: [usageStep] }),
      turnProcess: makeTurnProcessOwner({ setOpen: (o) => setOpenCalls.push(o) }),
      useTurnData: makeUseTurnData({}),
      useChat: makeUseChat(makeStepsSource([usageStep])),
    })
    const bar = container.querySelector('button.ccg-turn-bar-main')
    act(() => {
      bar.dispatchEvent(new sharedWindow.MouseEvent('click', { bubbles: true }))
    })
    assert.deepEqual(setOpenCalls, [])
  })
})

describe('降级要求（UI 增强可坏，Fold 不能被拖坏）', () => {
  it('图标包损坏（非法 JSON / 不兼容 compat）→ 回退内置默认，不抛错', () => {
    sharedWindow.localStorage.setItem('dsh-turn-fold:icons', '{broken')
    assert.doesNotThrow(() => loadPlugin({ window: sharedWindow }))
    sharedWindow.localStorage.setItem('dsh-turn-fold:icons', JSON.stringify({
      meta: { version: 1, compat: '>=99.0.0' },
      pokerPips: { spade: { path: '', cx: 12, cy: 12, factor: 1 } },
    }))
    const { test: T2 } = loadPlugin({ window: sharedWindow })
    assert.ok(T2.POKER_PIPS.spade.path.length > 0, '不兼容图标包被拒绝，回退内置')
    sharedWindow.localStorage.removeItem('dsh-turn-fold:icons')
  })

  it('设置数据损坏 → 回退默认值，不抛错', () => {
    sharedWindow.localStorage.setItem(T.SETTINGS_KEY, '{broken json')
    const { test: T2 } = loadPlugin({ window: sharedWindow })
    assert.equal(T2.settings.iconStyle, 'poker')
    assert.equal(T2.settings.fields.tokens, true)
  })

  it('Turn 栏渲染所需 props 全部缺失（裸 node）→ 不抛错（降级最小占位栏）', () => {
    const props = { node: { kind: 'turn-process', data: {} } }
    assert.doesNotThrow(() => {
      act(() => { root.render(react.createElement(T.EnhancedTurnProcessView, props)) })
    })
    assert.ok(container.querySelector('.ccg-turn-bar-main'), '最小占位栏仍渲染')
  })
})
