// Turn renderer 交互测试（收尾版验收面）：
//   - 官方最小切片订阅：useTurnData('turn-tail') + turnDataSource(turn,'assistant-step')
//   - turnProcess.open=false → 收起视觉；点击 → setOpen(true)；反向同理
//   - foldable=false（Verbose 官方语义）→ 静态栏 + open 视觉 = true + Poker 扇形 + 无 setOpen
//   - 运行中 → Running Bar 立即出现（0 秒起）、非交互、不触碰任何 Fold 状态
//   - Gear = 主按钮的兄弟 <button>；点击只开面板；Escape 关闭 + 焦点还给齿轮
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
  makeTurnNode, makeTurnProcessOwner, makeUseTurnData, makeStepsSource, makeUseChat,
  makeStep, makeStepData,
} from './helpers/fixtures.mjs'

const require = createRequire(import.meta.url)

// ── 全局 jsdom 环境 ──
import dom, { sharedWindow, sharedDocument } from './helpers/dom.mjs'

const { test: T } = loadPlugin({ window: sharedWindow })
const react = require('react')

// ── 渲染工具 ──
let root = null
let container = null

function mount() {
  container = sharedDocument.createElement('div')
  sharedDocument.body.appendChild(container)
  root = createRoot(container)
}

function renderView(props) {
  act(() => {
    root.render(react.createElement(T.EnhancedTurnProcessView, props))
  })
}

function clickMain() {
  const btn = container.querySelector('button.ccg-turn-bar-main')
  assert.ok(btn, '期望存在可点击的 Turn 栏主按钮')
  act(() => {
    btn.dispatchEvent(new sharedWindow.MouseEvent('click', { bubbles: true }))
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

const usageStepData = makeStepData(1, {
  usage: { inputTokens: 1000, outputTokens: 3214, cacheReadTokens: 2000 },
  timing: { stepStartTime: T0, firstTokenTime: T0 + 800 },
})
// TurnLocation.steps 收 StepLocation 包装（fallback 直读路径用）；
// turnDataSource 收 step **数据**对象（官方增量发布面）——两者形状不同，勿混用。
const usageStep = makeStep(1, usageStepData)

/** 标准订阅 mock：turn-tail 走官方 useTurnData、steps 走 turnDataSource。 */
function subscriptionProps(nodeProps, ownerOverrides) {
  const steps = makeStepsSource(nodeProps.stepsData ?? [])
  return {
    node: makeTurnNode(nodeProps),
    turnProcess: owner(ownerOverrides),
    useTurnData: makeUseTurnData({ tail: nodeProps.tail }),
    useChat: makeUseChat(steps, 13),
    steps,
  }
}

function closedProps(overrides = {}) {
  const p = subscriptionProps({
    status: 'closed', startTime: T0, endTime: T1, reason: 'completed',
    steps: [usageStep], stepsData: [usageStepData], tail: { tokenUsage: OFFICIAL_TOKEN_USAGE },
  }, overrides)
  return { node: p.node, turnProcess: p.turnProcess, useTurnData: p.useTurnData, useChat: p.useChat }
}

beforeEach(() => {
  sharedWindow.localStorage.clear()
  setOpenCalls.length = 0
  act(() => { T.setPopupOpen(false, null) })
  mount()
})

afterEach(() => {
  act(() => { T.setPopupOpen(false, null) })
  act(() => { root.unmount() })
  container.remove()
  container = null
  root = null
})

describe('Turn renderer：closed 相（折叠语义全部来自官方 turnProcess）', () => {
  it('turnProcess.open=false → 收起视觉（无 data-open / aria-expanded=false）', () => {
    renderView(closedProps())
    const bar = container.querySelector('button.ccg-turn-bar-main')
    assert.ok(bar)
    assert.equal(bar.getAttribute('data-open'), null)
    assert.equal(bar.getAttribute('aria-expanded'), 'false')
  })

  it('点击收起栏 → 恰好一次 setOpen(true)', () => {
    renderView(closedProps())
    clickMain()
    assert.deepEqual(setOpenCalls, [true])
  })

  it('turnProcess.open=true → 展开视觉（data-open / aria-expanded=true），点击 → setOpen(false)', () => {
    renderView(closedProps({ open: true }))
    const bar = container.querySelector('button.ccg-turn-bar-main')
    assert.equal(bar.getAttribute('data-open'), 'true')
    assert.equal(bar.getAttribute('aria-expanded'), 'true')
    clickMain()
    assert.deepEqual(setOpenCalls, [false])
  })

  it('指标来自官方真实数据（turn-tail 聚合 + step timing），千位分组', () => {
    renderView(closedProps())
    const label = barLabel()
    assert.ok(label.includes('22分34秒'), '耗时来自 turn.start/end：' + label)
    assert.ok(label.includes('370,202 token'), 'token 来自官方聚合：' + label)
    assert.ok(label.includes('缓存93.99%'), '缓存来自官方聚合：' + label)
    assert.ok(label.includes('首字0.8s'), 'TTFT 来自官方 step timing：' + label)
    assert.ok(container.querySelector('.ccg-turn-bar-right').textContent.includes('第13轮'))
  })

  it('官方最小切片订阅：turnDataSource 发布新 step 数据 → 栏指标随之更新', () => {
    const p = subscriptionProps({ status: 'closed', startTime: T0, endTime: T1, reason: 'completed', steps: [] })
    renderView({ node: p.node, turnProcess: p.turnProcess, useTurnData: p.useTurnData, useChat: p.useChat })
    // 无 step 数据：token 槽位显示 "—"（不伪造数字），其余启用槽位照常
    assert.ok(barLabel().includes('— token'), '无 step 数据时 token 显示 —（槽位不消失）：' + barLabel())
    assert.ok(!/\d[\d,.]*\s*token/.test(barLabel()), '无 step 数据时不得出现伪造 token 数字：' + barLabel())
    // 官方增量发布：成员数据到达
    act(() => {
      p.steps.set([usageStepData])
    })
    assert.ok(barLabel().includes('6,214 token'), barLabel())
    assert.ok(barLabel().includes('0.8s'), barLabel())
  })

  it('foldable=false（Verbose 官方语义）→ 静态栏 + open 视觉=true + Poker 扇形 + 无 setOpen', () => {
    renderView(closedProps({ foldable: false }))
    const bar = container.querySelector('button.ccg-turn-bar-main')
    assert.equal(bar.getAttribute('data-tf-static'), 'true')
    assert.equal(bar.getAttribute('aria-expanded'), null)
    assert.equal(bar.getAttribute('data-open'), 'true', '官方 open=!foldable||open → 展开视觉')
    // Poker 扇形：layout effect 写入的 transform 含 rotate（牌堆只有纯 translate）
    const motion = [...container.querySelectorAll('.ccg-poker-motion')].map((m) => m.getAttribute('transform'))
    assert.ok(motion.some((t) => (t || '').includes('rotate')), 'Poker 呈扇形：' + JSON.stringify(motion))
    clickMain()
    assert.deepEqual(setOpenCalls, [])
  })

  it('aborted（已停止）/ error（运行失败）→ 官方 alwaysOpen 语义：不可折叠、状态词上栏', () => {
    renderView({
      node: makeTurnNode({ status: 'closed', reason: 'aborted', steps: [usageStep] }),
      turnProcess: owner(),
      useTurnData: makeUseTurnData({}),
      useChat: makeUseChat(makeStepsSource([usageStepData])),
    })
    let bar = container.querySelector('button.ccg-turn-bar-main')
    assert.equal(bar.getAttribute('data-tf-static'), 'true')
    assert.equal(barStatus(), '已停止')
    clickMain()
    assert.deepEqual(setOpenCalls, [])

    renderView({
      node: makeTurnNode({ status: 'closed', reason: 'error', steps: [usageStep] }),
      turnProcess: owner(),
      useTurnData: makeUseTurnData({}),
      useChat: makeUseChat(makeStepsSource([usageStepData])),
    })
    bar = container.querySelector('button.ccg-turn-bar-main')
    assert.equal(barStatus(), '运行失败')
    assert.ok(container.querySelector('.ccg-turn-status-failed'), '失败状态词标红')
  })

  it('官方 spec 提供 cardCount；spec 缺失时回退回合数据 store', () => {
    renderView(closedProps())
    assert.ok(container.querySelector('.ccg-poker-icon svg'), 'poker 图标存在')
    renderView(closedProps({ spec: undefined }))
    assert.ok(container.querySelector('.ccg-poker-icon svg'), 'spec 缺失仍渲染（回合 data store 兜底）')
  })

  it('native 图标风格 → 不渲染 poker 图标，回退自有 chevron（无宿主包依赖）', () => {
    T.setFoldIconStyle('native')
    try {
      renderView(closedProps())
      assert.equal(container.querySelector('.ccg-poker-icon svg'), null)
      const chevron = container.querySelector('.ccg-turn-bar-chevron svg')
      assert.ok(chevron, '自有 chevron 存在')
      assert.ok(chevron.querySelector('polyline'), 'chevron 为插件自有 SVG 折线')
    } finally {
      act(() => { T.setFoldIconStyle('poker') })
    }
  })
})

describe('Gear：主按钮的兄弟交互节点 + 面板在自身 React 树内', () => {
  it('gear 是 .ccg-turn-row 下与主按钮兄弟的真实 <button>，不嵌套在主按钮内', () => {
    renderView(closedProps())
    const row = container.querySelector('.ccg-turn-row')
    const main = row.querySelector('button.ccg-turn-bar-main')
    const gear = row.querySelector('button.ccg-gear-button')
    assert.ok(main && gear, '主按钮与齿轮按钮都在行内')
    assert.equal(gear.closest('button.ccg-turn-bar-main'), null, '齿轮不嵌套在主按钮内')
    assert.equal(gear.getAttribute('aria-haspopup'), 'dialog')
    assert.equal(gear.getAttribute('aria-expanded'), 'false')
  })

  it('gear 点击 → 面板在自身树内打开（无 body portal）、setOpen 不被触发、aria-expanded 同步', () => {
    renderView(closedProps())
    const gear = container.querySelector('button.ccg-gear-button')
    act(() => { gear.click() })
    const overlay = container.querySelector('.ccg-gear-overlay')
    assert.ok(overlay, '面板已打开（在组件树内）')
    assert.equal(container.querySelector('.ccg-gear-popup').getAttribute('role'), 'dialog')
    assert.equal(gear.getAttribute('aria-expanded'), 'true')
    assert.deepEqual(setOpenCalls, [], '设置面板绝不触发折叠')
    assert.ok(document.querySelectorAll('.ccg-gear-overlay').length === 1, '全局同时最多一个面板')
    assert.equal(container.querySelectorAll('button.ccg-gear-button').length, 1)
  })

  it('Escape 关闭面板，焦点还给齿轮', () => {
    renderView(closedProps())
    const gear = container.querySelector('button.ccg-gear-button')
    act(() => { gear.click() })
    assert.ok(container.querySelector('.ccg-gear-overlay'), '面板打开')
    act(() => {
      document.dispatchEvent(new sharedWindow.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    assert.equal(container.querySelector('.ccg-gear-overlay'), null, 'Escape 关闭')
    assert.equal(document.activeElement, gear, '焦点还给齿轮')
  })

  it('面板打开时焦点移入 dialog；遮罩点击与 Done 均可关闭', () => {
    renderView(closedProps())
    const gear = container.querySelector('button.ccg-gear-button')
    act(() => { gear.click() })
    const popup = container.querySelector('.ccg-gear-popup')
    assert.equal(document.activeElement, popup, '打开即聚焦面板（tabIndex=-1 容器）')
    act(() => {
      container.querySelector('.ccg-gear-popup-btn').dispatchEvent(new sharedWindow.MouseEvent('click', { bubbles: true }))
    })
    assert.equal(container.querySelector('.ccg-gear-overlay'), null)
    assert.equal(document.activeElement, gear, 'Done 关闭同样把焦点还给齿轮')
    act(() => { gear.click() })
    const overlay = container.querySelector('.ccg-gear-overlay')
    act(() => {
      overlay.dispatchEvent(new sharedWindow.MouseEvent('click', { bubbles: true }))
    })
    assert.equal(container.querySelector('.ccg-gear-overlay'), null)
  })

  it('两根栏同时在场 → 只有一根渲染面板（共享状态 + 仅打开者渲染）', () => {
    const p1 = closedProps()
    const p2 = closedProps({ open: true })
    act(() => {
      root.render(react.createElement(react.Fragment, null,
        react.createElement(T.EnhancedTurnProcessView, { key: 'a', ...p1 }),
        react.createElement(T.EnhancedTurnProcessView, { key: 'b', ...p2 }),
      ))
    })
    const wraps = [...container.querySelectorAll('.ccg-turn-wrap')]
    assert.equal(wraps.length, 2)
    assert.equal(document.querySelectorAll('.ccg-gear-overlay').length, 0)
    const gearA = wraps[0].querySelector('button.ccg-gear-button')
    act(() => { gearA.click() })
    const overlays = [...container.querySelectorAll('.ccg-gear-overlay')]
    assert.equal(overlays.length, 1, '仍只有一个面板')
    assert.ok(wraps[0].contains(overlays[0]), '面板渲染在打开者（A 栏）的树内')
    assert.ok(!wraps[1].querySelector('.ccg-gear-overlay'), 'B 栏不渲染')
    const gearB = wraps[1].querySelector('button.ccg-gear-button')
    act(() => { gearB.click() })
    const overlays2 = [...container.querySelectorAll('.ccg-gear-overlay')]
    assert.equal(overlays2.length, 1)
    assert.ok(wraps[1].contains(overlays2[0]), '面板跟随新的打开者')
  })

  it('面板打开时所在栏卸载 → 共享状态自动复位（不留僵尸 open）', () => {
    renderView(closedProps())
    act(() => { container.querySelector('button.ccg-gear-button').click() })
    assert.ok(T.getPopupState().open, '面板打开中')
    act(() => { root.unmount() })
    root = null
    assert.equal(T.getPopupState().open, false, '卸载即复位')
    mount()
  })
})

describe('Running Turn Bar（0 秒状态表面，不是 Fold Controller）', () => {
  function runningProps(overrides = {}) {
    const steps = makeStepsSource(overrides.stepsData ?? [usageStepData])
    return {
      props: {
        node: makeTurnNode({
          status: 'open', startTime: T0, endTime: null,
          steps: [], spec: overrides.spec, tail: overrides.tail,
        }),
        turnProcess: owner(overrides.owner),
        useTurnData: makeUseTurnData({ tail: overrides.tail }),
        useChat: makeUseChat(steps, 13),
      },
      steps,
    }
  }

  it('回合开始（turn/start 投影）→ 栏立即出现，非交互（无 button、无 aria-expanded）', () => {
    const realNow = Date.now
    Date.now = () => T0 + 500 // 0.5 秒
    try {
      const { props } = runningProps()
      renderView(props)
      assert.equal(container.querySelector('button.ccg-turn-bar-main'), null)
      const bar = container.querySelector('div.ccg-turn-bar-main[data-tf-running="true"]')
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
      const { props } = runningProps()
      renderView(props)
      const label = barLabel()
      assert.ok(label.includes('6,214 token'), label)
      assert.ok(label.includes('247tok/s'), '真实输出/真实耗时：' + label)
      assert.ok(label.includes('首字0.8s'), 'TTFT 来自官方 timing：' + label)
    } finally {
      Date.now = realNow
    }
  })

  it('运行中不改变任何 Fold 状态：点击不触发 setOpen，setOpen 未被调用', () => {
    const { props } = runningProps()
    renderView(props)
    const bar = container.querySelector('div.ccg-turn-bar-main[data-tf-running="true"]')
    act(() => {
      bar.dispatchEvent(new sharedWindow.MouseEvent('click', { bubbles: true }))
    })
    assert.deepEqual(setOpenCalls, [])
  })

  it('回合结束 → 同一渲染器交接为 closed Turn 栏（button、可折叠）', () => {
    const realNow = Date.now
    Date.now = () => T0 + 13000
    try {
      const { props } = runningProps()
      renderView(props)
      assert.ok(container.querySelector('div.ccg-turn-bar-main[data-tf-running="true"]'))
    } finally {
      Date.now = realNow
    }
    renderView({
      node: makeTurnNode({
        status: 'closed', startTime: T0, endTime: T0 + 14000, reason: 'completed',
        steps: [usageStep],
      }),
      turnProcess: owner(),
      useTurnData: makeUseTurnData({}),
      useChat: makeUseChat(makeStepsSource([usageStepData])),
    })
    const btn = container.querySelector('button.ccg-turn-bar-main')
    assert.ok(btn, '交接为 closed 栏')
    assert.equal(btn.getAttribute('data-tf-running'), null)
    assert.equal(btn.getAttribute('aria-expanded'), 'false')
    clickMain()
    assert.deepEqual(setOpenCalls, [true])
  })
})

describe('兼容与降级（transcript 模式 / 异常宿主）', () => {
  it('turnProcess 缺失（异常宿主）→ 降级静态栏，不抛错、无 setOpen 通道', () => {
    renderView({
      node: makeTurnNode({ status: 'closed' }),
      turnProcess: undefined,
      useTurnData: makeUseTurnData({}),
      useChat: makeUseChat(makeStepsSource([])),
    })
    const bar = container.querySelector('button.ccg-turn-bar-main')
    assert.ok(bar, '降级栏仍渲染')
    assert.equal(bar.getAttribute('data-tf-static'), 'true')
    clickMain()
    assert.deepEqual(setOpenCalls, [])
  })

  it('location 无法定位回合 → 最小占位栏，不抛错', () => {
    renderView({
      node: { kind: 'turn-process', data: { turn: 7 }, location: { kind: 'session' } },
      turnProcess: owner(),
      useTurnData: makeUseTurnData({}),
      useChat: makeUseChat(makeStepsSource([])),
    })
    const bar = container.querySelector('button.ccg-turn-bar-main')
    assert.ok(bar)
    assert.equal(bar.getAttribute('data-turn-process'), '7')
  })

  it('useTurnData 缺失（旧绑定宿主）→ tail 回退回合 data store 直读', () => {
    renderView({
      node: makeTurnNode({ status: 'closed', steps: [usageStep], tail: { tokenUsage: OFFICIAL_TOKEN_USAGE } }),
      turnProcess: owner(),
      useChat: makeUseChat(makeStepsSource([usageStepData])),
    })
    assert.ok(barLabel().includes('370,202 token'), barLabel())
  })

  it('useChat 缺失（极简宿主）→ 不崩溃，steps 回退逐 step 直读', () => {
    renderView({
      node: makeTurnNode({ status: 'closed', steps: [usageStep] }),
      turnProcess: owner(),
      useTurnData: makeUseTurnData({}),
    })
    assert.ok(barLabel().includes('6,214 token'))
  })

  it('useTurnData 官方聚合到达 → 文案切换为官方 tokenUsage', () => {
    renderView({
      node: makeTurnNode({ status: 'closed', steps: [] }),
      turnProcess: owner(),
      useTurnData: makeUseTurnData({ tail: { tokenUsage: OFFICIAL_TOKEN_USAGE } }),
      useChat: makeUseChat(makeStepsSource([])),
    })
    assert.ok(barLabel().includes('370,202 token'), barLabel())
  })
})
