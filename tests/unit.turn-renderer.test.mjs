// Turn renderer 交互测试（重构核心验收面）：
//   - turnProcess.open = false → 收起视觉；点击 → setOpen(true)
//   - turnProcess.open = true  → 展开视觉；点击 → setOpen(false)
//   - 不可折叠（foldable=false / aborted / error）→ 静态栏、无 setOpen 通道
//   - 运行中 → Running Turn Bar 立即出现（0 秒起）、非交互、不触碰任何 Fold 状态
//   - 回合结束 → 平滑交接为 closed Turn 栏（同一渲染器）
//   - turnProcess 缺失 → 降级静态栏，绝不抛错
// 折叠成员是否真的被隐藏是官方 ChatNodeSeat 的职责，本插件不测。
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { loadPlugin } from './helpers/loader.mjs'
import {
  T0, T1, OFFICIAL_TOKEN_USAGE,
  makeTurnNode, makeTurnProcessOwner, makeUseChat, makeStep, makeStepData,
} from './helpers/fixtures.mjs'

const require = createRequire(import.meta.url)
const { JSDOM } = require('jsdom')

// ── 全局 jsdom 环境 ──
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
const { test: T, window: pluginWindow } = loadPlugin({ window: dom.window, uiPrimitives: PRIMITIVES_STUB })
// loader 不导出 React；直接 require 同一份 react（与插件工厂收到的一致）
const react = require('react')

// ── 渲染工具 ──
let root = null
let container = null

function mount() {
  container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  root = createRoot(container)
}

function renderView(props) {
  act(() => {
    root.render(react.createElement(T.EnhancedTurnProcessView, props))
  })
}

function clickBar() {
  const btn = container.querySelector('button.ccg-turn-bar')
  assert.ok(btn, '期望存在可点击的 Turn 栏 button')
  act(() => {
    btn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
}

function barLabel() {
  const el = container.querySelector('.ccg-turn-bar-label')
  return el ? el.textContent : ''
}

function barStatus() {
  const el = container.querySelector('.ccg-turn-bar-status')
  return el ? el.textContent : ''
}

const setOpenCalls = []
const owner = (overrides = {}) => makeTurnProcessOwner({
  setOpen: (open) => setOpenCalls.push(open),
  ...overrides,
})

const usageStep = makeStep(1, makeStepData(1, {
  usage: { inputTokens: 1000, outputTokens: 3214, cacheReadTokens: 2000 },
  timing: { stepStartTime: T0, firstTokenTime: T0 + 800 },
}))

beforeEach(() => {
  dom.window.localStorage.clear()
  dom.window.document.body.removeAttribute(T.STEP_SKIN_ATTR)
  setOpenCalls.length = 0
  mount()
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  container = null
  root = null
})

describe('Turn renderer：closed 相（折叠语义全部来自官方 turnProcess）', () => {
  const closedProps = (overrides = {}) => ({
    node: makeTurnNode({ status: 'closed', startTime: T0, endTime: T1, reason: 'completed', steps: [usageStep] }),
    turnProcess: owner(overrides),
    useChat: makeUseChat(),
  })

  it('turnProcess.open=false → 收起视觉（无 data-open / aria-expanded=false）', () => {
    renderView(closedProps())
    const bar = container.querySelector('button.ccg-turn-bar')
    assert.ok(bar)
    assert.equal(bar.getAttribute('data-open'), null)
    assert.equal(bar.getAttribute('aria-expanded'), 'false')
  })

  it('点击收起栏 → 恰好一次 setOpen(true)', () => {
    renderView(closedProps())
    clickBar()
    assert.deepEqual(setOpenCalls, [true])
  })

  it('turnProcess.open=true → 展开视觉（data-open / aria-expanded=true），点击 → setOpen(false)', () => {
    renderView(closedProps({ open: true }))
    const bar = container.querySelector('button.ccg-turn-bar')
    assert.equal(bar.getAttribute('data-open'), 'true')
    assert.equal(bar.getAttribute('aria-expanded'), 'true')
    clickBar()
    assert.deepEqual(setOpenCalls, [false])
  })

  it('指标来自官方真实数据（turn-tail 聚合 + step timing）', () => {
    renderView({
      node: makeTurnNode({
        status: 'closed', startTime: T0, endTime: T1, reason: 'completed',
        steps: [usageStep],
        tail: { tokenUsage: OFFICIAL_TOKEN_USAGE },
      }),
      turnProcess: owner(),
      useChat: makeUseChat(),
    })
    const label = barLabel()
    assert.ok(label.includes('22分34秒'), '耗时来自 turn.start/end：' + label)
    assert.ok(label.includes('370,202 token'), 'token 来自官方聚合：' + label)
    assert.ok(label.includes('缓存93.99%'), '缓存来自官方聚合：' + label)
    assert.ok(label.includes('首字0.8s'), 'TTFT 来自官方 step timing：' + label)
    assert.ok(container.querySelector('.ccg-turn-bar-right').textContent.includes('第13轮'))
  })

  it('foldable=false（如 Verbose 官方语义）→ 静态栏、点击无 setOpen', () => {
    renderView(closedProps({ foldable: false }))
    const bar = container.querySelector('button.ccg-turn-bar')
    assert.equal(bar.getAttribute('data-tf-static'), 'true')
    assert.equal(bar.getAttribute('aria-expanded'), null)
    clickBar()
    assert.deepEqual(setOpenCalls, [])
  })

  it('aborted（已停止）/ error（运行失败）→ 官方 alwaysOpen 语义：不可折叠、状态词上栏', () => {
    renderView({
      node: makeTurnNode({ status: 'closed', reason: 'aborted', steps: [usageStep] }),
      turnProcess: owner(),
      useChat: makeUseChat(),
    })
    let bar = container.querySelector('button.ccg-turn-bar')
    assert.equal(bar.getAttribute('data-tf-static'), 'true')
    assert.equal(barStatus(), '已停止')
    clickBar()
    assert.deepEqual(setOpenCalls, [])

    renderView({
      node: makeTurnNode({ status: 'closed', reason: 'error', steps: [usageStep] }),
      turnProcess: owner(),
      useChat: makeUseChat(),
    })
    bar = container.querySelector('button.ccg-turn-bar')
    assert.equal(barStatus(), '运行失败')
    const statusEl = container.querySelector('.ccg-turn-status-failed')
    assert.ok(statusEl, '失败状态词标红')
  })

  it('官方 spec 提供 cardCount（toolCallCount+subagentCount），spec 缺失时回退回合数据 store', () => {
    renderView(closedProps())
    // 牌堆图标渲染（poker 默认风格）；spec.toolCallCount=4 → 5 张牌堆
    assert.ok(container.querySelector('.ccg-poker-icon svg'), 'poker 图标存在')
    renderView(closedProps({ spec: undefined }))
    assert.ok(container.querySelector('.ccg-poker-icon svg'), 'spec 缺失仍渲染（回合 data store 兜底）')
  })

  it('native 图标风格 → 不渲染 poker 图标', () => {
    T.setFoldIconStyle('native')
    try {
      renderView(closedProps())
      assert.equal(container.querySelector('.ccg-poker-icon svg'), null)
      assert.ok(container.querySelector('.ccg-turn-bar-chevron'), '回退官方 chevron')
    } finally {
      T.setFoldIconStyle('poker')
    }
  })
})

describe('Running Turn Bar（0 秒状态表面，不是 Fold Controller）', () => {
  function runningProps(overrides = {}) {
    return {
      node: makeTurnNode({
        status: 'open',
        startTime: T0,
        endTime: null,
        steps: overrides.steps ?? [usageStep],
        spec: overrides.spec,
      }),
      turnProcess: owner(overrides.owner),
      useChat: makeUseChat(),
    }
  }

  it('回合开始（turn/start 投影）→ 栏立即出现，非交互（无 button、无 aria-expanded）', () => {
    const realNow = Date.now
    Date.now = () => T0 + 500 // 0.5 秒
    try {
      renderView(runningProps())
      assert.equal(container.querySelector('button.ccg-turn-bar'), null)
      const bar = container.querySelector('div.ccg-turn-bar[data-tf-running="true"]')
      assert.ok(bar, 'running 栏存在')
      assert.equal(bar.getAttribute('aria-expanded'), null)
      assert.ok(barLabel().includes('耗时0秒'), '0 秒起步：' + barLabel())
      assert.ok(bar.querySelector('.ccg-turn-bar-right').textContent.includes('第13轮'))
    } finally {
      Date.now = realNow
    }
  })

  it('真实 usage 更新 → token/tps 更新（真实数据驱动，无伪造增长）', () => {
    const realNow = Date.now
    Date.now = () => T0 + 13000 // 13 秒
    try {
      renderView(runningProps())
      let label = barLabel()
      assert.ok(label.includes('6,214 token'), label)
      assert.ok(label.includes('247tok/s'), '真实输出/真实耗时：' + label)
      assert.ok(label.includes('首字0.8s'), 'TTFT 来自官方 timing：' + label)
    } finally {
      Date.now = realNow
    }
  })

  it('运行中不改变任何 Fold 状态：点击不触发 setOpen，setOpen 未被调用', () => {
    renderView(runningProps())
    const bar = container.querySelector('div.ccg-turn-bar[data-tf-running="true"]')
    act(() => {
      bar.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
    assert.deepEqual(setOpenCalls, [])
  })

  it('回合结束 → 同一渲染器交接为 closed Turn 栏（button、可折叠）', () => {
    const realNow = Date.now
    Date.now = () => T0 + 13000
    try {
      renderView(runningProps())
      assert.ok(container.querySelector('div.ccg-turn-bar[data-tf-running="true"]'))
    } finally {
      Date.now = realNow
    }
    // 官方在 turn/end 后重发布节点：status=closed + end 时间 + owner state
    renderView({
      node: makeTurnNode({
        status: 'closed', startTime: T0, endTime: T0 + 14000, reason: 'completed',
        steps: [usageStep],
      }),
      turnProcess: owner(),
      useChat: makeUseChat(),
    })
    const btn = container.querySelector('button.ccg-turn-bar')
    assert.ok(btn, '交接为 closed 栏')
    assert.equal(btn.getAttribute('data-tf-running'), null)
    assert.equal(btn.getAttribute('aria-expanded'), 'false')
    clickBar()
    assert.deepEqual(setOpenCalls, [true])
  })
})

describe('兼容与降级（transcript 模式 / 异常宿主）', () => {
  it('turnProcess 缺失（异常宿主）→ 降级静态栏，不抛错、无 setOpen 通道', () => {
    renderView({
      node: makeTurnNode({ status: 'closed' }),
      turnProcess: undefined,
      useChat: makeUseChat(),
    })
    const bar = container.querySelector('button.ccg-turn-bar')
    assert.ok(bar, '降级栏仍渲染')
    assert.equal(bar.getAttribute('data-tf-static'), 'true')
    clickBar()
    assert.deepEqual(setOpenCalls, [])
  })

  it('location 无法定位回合 → 最小占位栏，不抛错', () => {
    renderView({
      node: { kind: 'turn-process', data: { turn: 7 }, location: { kind: 'session' } },
      turnProcess: owner(),
      useChat: makeUseChat(),
    })
    const bar = container.querySelector('button.ccg-turn-bar')
    assert.ok(bar)
    assert.equal(bar.getAttribute('data-turn-process'), '7')
  })

  it('useChat 缺失（极简宿主）→ 不崩溃，指标仍来自 location', () => {
    renderView({
      node: makeTurnNode({ status: 'closed', steps: [usageStep] }),
      turnProcess: owner(),
    })
    assert.ok(barLabel().includes('6,214 token'))
  })

  it('快照订阅存在时官方 tokenUsage 到达 → 文案更新（useChat 驱动重渲染的读取面）', () => {
    renderView({
      node: makeTurnNode({ status: 'closed', steps: [usageStep] }),
      turnProcess: owner(),
      useChat: makeUseChat({ published: 1 }),
    })
    assert.ok(barLabel().includes('6,214 token'))
    renderView({
      node: makeTurnNode({ status: 'closed', steps: [], tail: { tokenUsage: OFFICIAL_TOKEN_USAGE } }),
      turnProcess: owner(),
      useChat: makeUseChat({ published: 2 }),
    })
    assert.ok(barLabel().includes('370,202 token'), barLabel())
  })
})
