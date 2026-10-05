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
  // 官方 AssistantTiming：completedTime = assistant/message 事件时间（13 秒处 settle）
  timing: { stepStartTime: T0, firstTokenTime: T0 + 800, completedTime: T0 + 13000 },
})
// TurnLocation.steps 收 StepLocation 包装（fallback 直读路径用）；
// turnDataSource 收 step **数据**对象（官方增量发布面）——两者形状不同，勿混用。
const usageStep = makeStep(1, usageStepData, T0)

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
  // 运行时 TTFT 观察缓存是模块级（跨用例共享）——每个用例从干净状态开始
  T.observedTtft.clear()
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

  it('native 图标风格 → 前导位渲染官方几何 chevron，poker 消失，右侧提示箭头不重复出现', () => {
    T.setIconStyle('native')
    try {
      renderView(closedProps())
      assert.equal(container.querySelector('.ccg-poker-icon svg'), null, 'poker 图标消失')
      const leading = container.querySelector('.ccg-turn-bar-main > svg[aria-hidden=true]')
      assert.ok(leading, '前导位存在自有 chevron（零宿主包依赖）')
      assert.ok(leading.querySelector('path'), 'chevron 为官方同款 path 折线（非 polyline）')
      assert.equal(leading.getAttribute('viewBox'), '0 0 16 16', 'viewBox 对齐官方 16 盒')
      assert.equal(container.querySelector('.ccg-turn-bar-chevron'), null, 'native 不再出现右侧第二个 chevron')
      // 增强字段一个不少
      const label = container.querySelector('.ccg-turn-bar-label')
      assert.ok(label && label.textContent.length > 0, '指标字段仍在')
      assert.ok(container.querySelector('.ccg-turn-bar-right'), '第 N 轮仍在')
      assert.ok(container.querySelector('.ccg-gear-button'), '齿轮仍在')
      // 展开态：rotate(180deg)
      renderView(closedProps({ open: true }))
      const openChevron = container.querySelector('.ccg-turn-bar-main > svg[aria-hidden=true]')
      assert.ok(openChevron, '展开态仍有 chevron')
      assert.ok(String(openChevron.getAttribute('style')).includes('rotate(180deg)'), '展开态 chevron 旋转 180°：' + openChevron.outerHTML)
    } finally {
      act(() => { T.setIconStyle('poker') })
    }
  })
});

// ══════════════════════════════════════════════════════════════════════
// 真实回合数据（落盘事件夹具）驱动的渲染：reload / 历史会话路径
// ══════════════════════════════════════════════════════════════════════
describe('历史会话渲染：durable projection 用真实回合数据救回首字与 tok/s', () => {
  it('客户端无 timing + durable 有真实值 → 标签显示 首字1.5s / 141tok/s', async () => {
    const { readFileSync } = await import('node:fs')
    const host = await import('../index.js')
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/real-turn-slice.json', import.meta.url), 'utf8'))
    let state = host.turnFoldInit()
    for (const event of fixture.events) state = host.turnFoldApply(state, event)
    const view = host.turnFoldMetricsProjection.wire.view(state)
    const start = fixture.events.find((event) => event.type === 'step/start')
    const row = view.turns[String(start.data.turn)]
    assert.deepEqual(row, { ttftMs: 1508, decodeMs: 2219, decodeTokens: 313 }, '夹具真实值')

    // 历史重建形态：客户端 step 数据只有 usage，没有 finalNode.timing
    const noTiming = makeStepData(1, { usage: { inputTokens: 10, outputTokens: 313 } })
    const p = subscriptionProps({
      status: 'closed', startTime: T0, endTime: T1, reason: 'completed',
      steps: [makeStep(1, noTiming, T0)], stepsData: [noTiming],
      tail: { tokenUsage: OFFICIAL_TOKEN_USAGE },
    })
    renderView({
      ...p,
      sessionId: 'sess-real',
      useProjection: (key, selector) => selector({ turns: { 13: row } }),
    })
    const label = barLabel()
    assert.ok(label.includes('首字1.5s'), 'durable 真实 TTFT 必须出现：' + label)
    assert.ok(label.includes('141tok/s'), 'durable 真实 decode-speed 必须出现：' + label)
  })
})

// ══════════════════════════════════════════════════════════════════════
// 同一实例状态机（不 remount）：Hook 顺序 + 图标/字段/Fold 全程正确
// ══════════════════════════════════════════════════════════════════════
// 为什么必须"同实例"：TurnBarView 的 canToggle 随回合生命周期变化
// （running→settled），此前 `if (canToggle && useIconStyle() === "poker")` 会让
// hook 数量在两次 render 之间变化 —— Rules of Hooks 违规（"Rendered more hooks
// than during the previous render"）。本轮把 iconStyle 订阅收敛到
// EnhancedTurnProcessView 一处、以普通 prop 下传；这个用例走完整生命周期，
// 全程复用同一个 root / 同一个组件实例（不 unmount、不重新 mount）。
describe('同一实例状态机：running → settled → open → native → poker', () => {
  function runningProps(overrides = {}) {
    const p = subscriptionProps({ status: 'open', startTime: T0, endTime: null, reason: undefined, steps: [], stepsData: [], tail: undefined }, overrides)
    return { node: p.node, turnProcess: p.turnProcess, useTurnData: p.useTurnData, useChat: p.useChat }
  }
  const leadingChevron = () => container.querySelector('.ccg-turn-bar-main > svg[aria-hidden=true]')
  const pokIcon = () => container.querySelector('.ccg-poker-icon')
  // 右侧区域只允许「第 N 轮」文本：不得再有任何箭头图形（原 .ccg-turn-bar-chevron 已删除）
  const rightSvg = () => container.querySelector('.ccg-turn-bar-right svg')
  const label = () => barLabel()

  it('A→F 全程：无 Hook 顺序错误，图标/字段/Fold 语义逐步正确', () => {
    const hookErrors = []
    const originalError = console.error
    console.error = function () {
      hookErrors.push([...arguments].map(String).join(' '))
    }
    try {
      // A. running · poker · canToggle=false
      renderView(runningProps())
      assert.ok(container.querySelector('[data-tf-running]'), 'A: running 栏在')
      assert.ok(pokIcon(), 'A: 运行中前导 = 翻牌 Poker')
      assert.equal(rightSvg(), null, 'A: running 右侧无箭头')
      assert.equal(container.querySelector('button.ccg-turn-bar-main'), null, 'A: running 是静态 div')
      const aLabel = label()
      clickMainStatic()
      assert.deepEqual(setOpenCalls, [], 'A: running 无 setOpen 通道')
      assert.ok(aLabel.includes('耗时') && aLabel.includes('token'), 'A: 字段槽位在')

      // B. settled closed · poker · canToggle=true
      renderView(closedProps())
      assert.ok(pokIcon(), 'B: 收起 = 牌堆 Poker')
      assert.equal(rightSvg(), null, 'B: poker 右侧不再有折叠箭头（Fold 状态由 Poker 自身表达）')
      assert.equal(container.querySelector('button.ccg-turn-bar-main').getAttribute('aria-expanded'), 'false')
      const bLabel = label()
      assert.ok(bLabel.includes('首字0.8s') && bLabel.includes('370,202 token') && bLabel.includes('263tok/s') && bLabel.includes('缓存93.99%') && bLabel.includes('22分34秒'), 'B: 字段齐全：' + bLabel)
      assert.ok(container.querySelector('.ccg-turn-bar-right').textContent.includes('第13轮'), 'B: 第 N 轮在')
      assert.ok(container.querySelector('.ccg-gear-button'), 'B: 齿轮在')
      clickMain()
      assert.deepEqual(setOpenCalls, [true], 'B: 点击只调 setOpen(true)')

      // C. settled open · poker
      renderView(closedProps({ open: true }))
      const cBar = container.querySelector('button.ccg-turn-bar-main')
      assert.equal(cBar.getAttribute('data-open'), 'true', 'C: 展开视觉')
      const motion = [...container.querySelectorAll('.ccg-poker-motion')].map((m) => m.getAttribute('transform') || '')
      assert.ok(motion.some((t) => t.includes('rotate')), 'C: 展开 = 扇形（含 rotate 的位姿）')
      clickMain()
      assert.deepEqual(setOpenCalls, [true, false], 'C: 点击只调 setOpen(false)')

      // D. settled open · native
      act(() => { T.setIconStyle('native') })
      renderView(closedProps({ open: true }))
      assert.equal(pokIcon(), null, 'D: native 无 Poker')
      const dChevron = leadingChevron()
      assert.ok(dChevron, 'D: native 前导 = 自有 chevron')
      assert.ok(String(dChevron.getAttribute('style')).includes('rotate(180deg)'), 'D: 展开态 chevron 向上')
      assert.equal(rightSvg(), null, 'D: native 右侧无箭头（唯一 chevron 在左侧）')
      const dLabel = label()
      assert.ok(dLabel.includes('22分34秒') && dLabel.includes('首字0.8s') && dLabel.includes('370,202 token') && dLabel.includes('263tok/s') && dLabel.includes('缓存93.99%'), 'D: 增强字段全保留：' + dLabel)
      assert.ok(container.querySelector('.ccg-turn-bar-right').textContent.includes('第13轮'), 'D: 第 N 轮在')
      assert.ok(container.querySelector('.ccg-gear-button'), 'D: 齿轮在')

      // E. settled closed · native
      renderView(closedProps())
      const eChevron = leadingChevron()
      assert.ok(eChevron, 'E: native 收起仍有前导 chevron')
      assert.ok(!String(eChevron.getAttribute('style')).includes('rotate(180deg)'), 'E: 收起态 chevron 向下（无旋转）')
      assert.equal(rightSvg(), null, 'E: native 右侧仍无箭头')
      clickMain()
      assert.deepEqual(setOpenCalls, [true, false, true], 'E: native 点击同样只调 setOpen(true)')

      // F. 切回 poker
      act(() => { T.setIconStyle('poker') })
      renderView(closedProps())
      assert.ok(pokIcon(), 'F: 切回后 Poker 恢复')
      assert.equal(rightSvg(), null, 'F: 切回 poker 右侧同样无箭头')
      assert.equal(leadingChevron(), null, 'F: native chevron 退场')

      // 形状稳定性：iconStyle 每次切换都会重渲染全部栏，但不产生任何 hook 顺序告警
      assert.deepEqual(hookErrors.filter((message) => /hook/i.test(message)), [], 'React 不得报 hook 顺序问题：' + hookErrors.join(' | '))
      assert.deepEqual(hookErrors, [], 'React 不得有任何 console.error：' + hookErrors.join(' | '))
    } finally {
      console.error = originalError
      act(() => { T.setIconStyle('poker') })
    }
  })

  it('同一实例连续 rerender 50 次（running↔settled + open↔closed + poker↔native）无告警', () => {
    const hookErrors = []
    const originalError = console.error
    console.error = function () { hookErrors.push([...arguments].map(String).join(' ')) }
    try {
      for (let i = 0; i < 50; i += 1) {
        const running = i % 3 === 0
        act(() => { T.setIconStyle(i % 2 === 0 ? 'poker' : 'native') })
        renderView(running ? runningProps() : closedProps({ open: i % 4 === 0 }))
      }
      assert.deepEqual(hookErrors, [], '50 次状态往返不得有任何 React 告警：' + hookErrors.slice(0, 3).join(' | '))
    } finally {
      console.error = originalError
      act(() => { T.setIconStyle('poker') })
    }
  })

  function clickMainStatic() {
    const el = container.querySelector('[data-tf-running]')
    if (!el) return
    act(() => { el.dispatchEvent(new sharedWindow.MouseEvent('click', { bubbles: true })) })
  }
})

// ══════════════════════════════════════════════════════════════════════
// StrictMode：effect mount/unmount/replay 下的状态一致性
// ══════════════════════════════════════════════════════════════════════
describe('StrictMode 严格验收（effect 双调用）', () => {
  function renderStrict(props) {
    act(() => {
      root.render(react.createElement(react.StrictMode, null,
        react.createElement(T.EnhancedTurnProcessView, props)))
    })
  }
  it('同一实例在 StrictMode 下走完 running→settled→native→poker，无告警、图标与总闸一致', () => {
    const errors = []
    const originalError = console.error
    console.error = function () { errors.push([...arguments].map(String).join(' ')) }
    const skinEl = sharedDocument.querySelector('style[data-plugin-css="' + T.SKIN_CSS_ID + '"]')
    const cardEl = sharedDocument.querySelector('style[data-plugin-css="' + T.STEP_CARD_CSS_ID + '"]')
    try {
      const p1 = subscriptionProps({ status: 'open', startTime: T0, endTime: null, reason: undefined, steps: [], stepsData: [], tail: undefined })
      renderStrict({ node: p1.node, turnProcess: p1.turnProcess, useTurnData: p1.useTurnData, useChat: p1.useChat })
      assert.ok(container.querySelector('[data-tf-running]'), 'StrictMode: running 栏在')

      renderStrict(closedProps())
      assert.ok(container.querySelector('.ccg-poker-icon'), 'StrictMode: poker 前导在')
      assert.equal(skinEl.disabled, false, 'StrictMode: poker 总闸开')

      act(() => { T.setIconStyle('native') })
      assert.equal(container.querySelector('.ccg-poker-icon'), null, 'StrictMode: native 无 Poker（订阅未被 StrictMode 打乱）')
      assert.ok(container.querySelector('.ccg-turn-bar-main > svg[aria-hidden=true]'), 'StrictMode: native 前导 chevron 在')
      assert.equal(skinEl.disabled, true, 'StrictMode: Step 皮肤表同步禁用')
      assert.equal(cardEl.disabled, true, 'StrictMode: 牌数桥表同步禁用')

      act(() => { T.setIconStyle('poker') })
      assert.ok(container.querySelector('.ccg-poker-icon'), 'StrictMode: 切回 poker 立即恢复')
      assert.equal(skinEl.disabled, false)
      assert.equal(cardEl.disabled, false)

      assert.deepEqual(errors, [], 'StrictMode 下不得有任何 React 告警：' + errors.slice(0, 3).join(' | '))
    } finally {
      console.error = originalError
      act(() => { T.setIconStyle('poker') })
    }
  })
})

// ══════════════════════════════════════════════════════════════════════
// 唯一 Fold icon：每种模式/状态最多一个折叠图标，右侧不再有辅助箭头
// ══════════════════════════════════════════════════════════════════════
// 旧实现给 poker 模式在齿轮左侧又加了一个 .ccg-turn-bar-chevron（随 open/closed
// 转向）——Poker 自身已经用「牌堆 = 收起 / 扇形 = 展开」表达 Fold 状态，右侧箭头
// 是冗余信息且紧贴齿轮像多出来的控件。本轮删除该渲染与配套 CSS。
describe('唯一 Fold icon（Poker 右侧不再有折叠箭头）', () => {
  const runningProps = () => {
    const p = subscriptionProps({ status: 'open', startTime: T0, endTime: null, reason: undefined, steps: [], stepsData: [], tail: undefined })
    return { node: p.node, turnProcess: p.turnProcess, useTurnData: p.useTurnData, useChat: p.useChat }
  }
  const rightArea = () => container.querySelector('.ccg-turn-bar-right')
  const rightIcons = () => container.querySelectorAll('.ccg-turn-bar-right svg, .ccg-turn-bar-chevron')
  const leadingChevron = () => container.querySelector('.ccg-turn-bar-main > svg[aria-hidden=true]')

  it('poker + settled closed：[Poker] [字段] [第N轮] [齿轮]，右侧无箭头', () => {
    T.setIconStyle('poker')
    try {
      renderView(closedProps())
      assert.ok(container.querySelector('.ccg-poker-icon'), '前导 = 牌堆 Poker')
      assert.equal(container.querySelector('.ccg-turn-bar-chevron'), null, '旧右侧箭头类不得出现')
      assert.equal(rightIcons().length, 0, '右侧区域不得含任何箭头图形')
      assert.ok(rightArea().textContent.includes('第13轮'), '第 N 轮保留')
      assert.ok(container.querySelector('.ccg-gear-button'), '齿轮保留')
      assert.ok(barLabel().includes('首字0.8s') && barLabel().includes('263tok/s'), '字段保留：' + barLabel())
    } finally { act(() => { T.setIconStyle('poker') }) }
  })

  it('poker + settled open：扇形 Poker，右侧仍无箭头', () => {
    T.setIconStyle('poker')
    try {
      renderView(closedProps({ open: true }))
      const motion = [...container.querySelectorAll('.ccg-poker-motion')].map((m) => m.getAttribute('transform') || '')
      assert.ok(motion.some((t) => t.includes('rotate')), '前导 = 扇形（Poker 表达展开态）')
      assert.equal(rightIcons().length, 0, '展开态右侧同样无箭头')
      assert.ok(rightArea().textContent.includes('第13轮'), '第 N 轮保留')
    } finally { act(() => { T.setIconStyle('poker') }) }
  })

  it('poker + running：翻牌 Poker，右侧无箭头、非 button', () => {
    T.setIconStyle('poker')
    try {
      renderView(runningProps())
      assert.ok(container.querySelector('.ccg-poker-icon'), '前导 = 翻牌 Poker')
      assert.equal(rightIcons().length, 0, 'running 右侧无箭头')
      assert.equal(container.querySelector('button.ccg-turn-bar-main'), null, 'running 仍是静态 div')
    } finally { act(() => { T.setIconStyle('poker') }) }
  })

  it('native + closed：唯一 chevron 在左侧（朝下），右侧无箭头', () => {
    act(() => { T.setIconStyle('native') })
    try {
      renderView(closedProps())
      const chevron = leadingChevron()
      assert.ok(chevron, '左侧前导 chevron 存在')
      assert.ok(!String(chevron.getAttribute('style')).includes('rotate(180deg)'), '收起态朝下')
      assert.equal(rightIcons().length, 0, '右侧无第二个箭头')
      assert.ok(rightArea().textContent.includes('第13轮'), '第 N 轮保留')
      assert.ok(container.querySelector('.ccg-gear-button'), '齿轮保留')
    } finally { act(() => { T.setIconStyle('poker') }) }
  })

  it('native + open：唯一 chevron 在左侧（rotate(180deg) 朝上），右侧无箭头', () => {
    act(() => { T.setIconStyle('native') })
    try {
      renderView(closedProps({ open: true }))
      const chevron = leadingChevron()
      assert.ok(chevron, '左侧前导 chevron 存在')
      assert.ok(String(chevron.getAttribute('style')).includes('rotate(180deg)'), '展开态朝上')
      assert.equal(rightIcons().length, 0, '右侧无第二个箭头')
    } finally { act(() => { T.setIconStyle('poker') }) }
  })

  it('native + running & 不可折叠：本就无 Fold icon，右侧也无箭头', () => {
    act(() => { T.setIconStyle('native') })
    try {
      renderView(runningProps())
      assert.equal(leadingChevron(), null, 'native running 无前导 icon')
      assert.equal(rightIcons().length, 0, 'running 右侧无箭头')
      renderView(closedProps({ foldable: false }))
      assert.equal(leadingChevron(), null, '不可折叠（Verbose 语义）无前导 chevron')
      assert.equal(rightIcons().length, 0, '不可折叠右侧无箭头')
      assert.ok(rightArea().textContent.includes('第13轮'), '第 N 轮仍保留')
    } finally { act(() => { T.setIconStyle('poker') }) }
  })
})

// ══════════════════════════════════════════════════════════════════════
// Turn owner contract evolution（0.1.2~0.1.6 旧 modern owner 形状兼容）：
// 官方 TurnProcessOwnerProps 0.1.7-rc.1 起才有 hasContent；旧形状
// { spec, foldable, open, setOpen } 下 foldable 即足以决定可折叠。
// MISSING hasContent ≠ hasContent=false ≠ legacy turn —— 全部经
// normalizeTurnProcessOwner 归一化，视图不感知契约代际。
// ══════════════════════════════════════════════════════════════════════
describe('Turn owner 契约演进：旧 modern owner（无 hasContent 字段）', () => {
  it('A: foldable=true + 无 hasContent → 可折叠栏，点击 → setOpen(true) 恰一次', () => {
    renderView(closedProps({ omitHasContent: true }))
    const bar = container.querySelector('button.ccg-turn-bar-main')
    assert.ok(bar, '可折叠栏呈现（不是静态栏）')
    assert.equal(bar.getAttribute('data-tf-static'), null, '不得是静态栏')
    assert.equal(bar.getAttribute('aria-expanded'), 'false')
    assert.equal(bar.getAttribute('data-open'), null)
    clickMain()
    assert.deepEqual(setOpenCalls, [true], '点击只调官方 setOpen(true) 恰一次')
  })
  it('B: 旧 owner open=true → 展开视觉，点击 → setOpen(false) 恰一次', () => {
    renderView(closedProps({ omitHasContent: true, open: true }))
    const bar = container.querySelector('button.ccg-turn-bar-main')
    assert.ok(bar)
    assert.equal(bar.getAttribute('data-tf-static'), null)
    assert.equal(bar.getAttribute('aria-expanded'), 'true')
    assert.equal(bar.getAttribute('data-open'), 'true')
    clickMain()
    assert.deepEqual(setOpenCalls, [false], '点击只调官方 setOpen(false) 恰一次')
  })
  it('C: 旧 owner foldable=false → 静态栏 + data-open=true，点击不调 setOpen', () => {
    renderView(closedProps({ omitHasContent: true, foldable: false }))
    const bar = container.querySelector('button.ccg-turn-bar-main')
    assert.ok(bar, 'Verbose 语义静态栏')
    assert.equal(bar.getAttribute('data-tf-static'), 'true')
    assert.equal(bar.getAttribute('aria-expanded'), null)
    assert.equal(bar.getAttribute('data-open'), 'true', '官方 open=!foldable||open → 展开视觉')
    clickMain()
    assert.deepEqual(setOpenCalls, [], 'foldable=false 不得调 setOpen')
  })
  it('F: 旧 owner + aborted/error → alwaysOpen 优先，仍不可折叠', () => {
    for (const reason of ['aborted', 'error']) {
      const steps = makeStepsSource([])
      renderView({
        node: makeTurnNode({ status: 'closed', reason }),
        turnProcess: owner({ omitHasContent: true }),
        useTurnData: makeUseTurnData({}),
        useChat: makeUseChat(steps, 13),
      })
      const bar = container.querySelector('button.ccg-turn-bar-main')
      assert.ok(bar, reason + ' 静态栏')
      assert.equal(bar.getAttribute('data-tf-static'), 'true', reason + ' 不可折叠')
      clickMain()
      assert.deepEqual(setOpenCalls, [], reason + ' 不得调 setOpen')
    }
  })
  it('H: 旧 owner 可折叠时 Poker/Native 图标语义正常（与契约代际无关）', () => {
    // Poker：open=false → 收起牌堆（无旋转），open=true → 扇形（有旋转）
    renderView(closedProps({ omitHasContent: true }))
    const closedRot = [...container.querySelectorAll('.ccg-poker-motion')]
      .some((m) => (m.getAttribute('transform') || '').includes('rotate'))
    assert.equal(closedRot, false, '收起牌堆无旋转')
    renderView(closedProps({ omitHasContent: true, open: true }))
    const fanRot = [...container.querySelectorAll('.ccg-poker-motion')]
      .some((m) => (m.getAttribute('transform') || '').includes('rotate'))
    assert.ok(fanRot, '展开扇形有旋转')
    // Native：前导 chevron 存在且随 open 翻转
    act(() => { T.setIconStyle('native') })
    try {
      renderView(closedProps({ omitHasContent: true }))
      const chevron = container.querySelector('.ccg-turn-row svg')
      assert.ok(chevron, 'native 前导 chevron 存在')
    } finally { act(() => { T.setIconStyle('poker') }) }
  })
})

describe('Turn owner 契约演进：归一化纯函数与源码守卫', () => {
  it('normalizeTurnProcessOwner：missing hasContent ≠ hasContent=false', () => {
    const setOpen = () => {}
    const legacyOwner = { spec: { turn: 1 }, foldable: true, open: false, setOpen }
    assert.equal(Object.prototype.hasOwnProperty.call(legacyOwner, 'hasContent'), false, 'fixture 必须真省略 key')
    const legacy = T.normalizeTurnProcessOwner(legacyOwner, false)
    assert.equal(legacy.available, true)
    assert.equal(legacy.foldable, true)
    assert.equal(legacy.hasExplicitHasContent, false)
    assert.equal(legacy.hasContent, undefined, 'missing → undefined（不是 false）')
    assert.equal(legacy.canCollapse, true, '旧契约 foldable=true → 可折叠')
    assert.equal(legacy.open, false)
    const newOff = T.normalizeTurnProcessOwner({ spec: { turn: 1 }, foldable: true, hasContent: false, open: false, setOpen }, false)
    assert.equal(newOff.hasExplicitHasContent, true)
    assert.equal(newOff.hasContent, false)
    assert.equal(newOff.canCollapse, false, '显式 hasContent=false → 不可折叠')
    const newOn = T.normalizeTurnProcessOwner({ spec: { turn: 1 }, foldable: true, hasContent: true, open: false, setOpen }, false)
    assert.equal(newOn.canCollapse, true, '显式 hasContent=true → 可折叠')
    const verbose = T.normalizeTurnProcessOwner({ spec: { turn: 1 }, foldable: false, open: false, setOpen }, false)
    assert.equal(verbose.canCollapse, false)
    assert.equal(verbose.open, true, 'foldable=false → 展开视觉')
    const always = T.normalizeTurnProcessOwner(legacyOwner, true)
    assert.equal(always.canCollapse, false, 'alwaysOpen 优先')
    const missing = T.normalizeTurnProcessOwner(undefined, false)
    assert.equal(missing.available, false)
    assert.equal(missing.canCollapse, false)
    assert.equal(missing.open, true, '缺失 → 降级展开静态栏')
  })
  it('源码守卫：视图不得重新出现 turnProcess.foldable/hasContent 直接布尔绑定', () => {
    const src = require('node:fs').readFileSync(new URL('../client.js', import.meta.url), 'utf8')
    assert.ok(src.includes('function normalizeTurnProcessOwner'), '必须存在归一化 helper')
    assert.ok(src.includes('normalizeTurnProcessOwner(turnProcess, alwaysOpen)'), '视图必须经归一化消费 owner')
    assert.ok(!src.includes('turnProcess.hasContent'), '禁止 turnProcess.hasContent 直接绑定（兼容判断收敛进 helper）')
    assert.ok(!src.includes('turnProcess.foldable'), '禁止 turnProcess.foldable 直接绑定')
  })
})
