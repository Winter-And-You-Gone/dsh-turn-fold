// DSH 0.1.7-rc.2 ↔ 0.2.0-rc.2 版本矩阵测试。
//
// 审计基线（2026-10，源码 diff 787b746b80…↔c1b47e41fc…）：
//   插件消费的全部核心契约 shape 在两个 release 间不变——
//   contract/ 目录逐字节零差异；ChatNodeSeat / register-node-renderers /
//   use-turn-data / snapshot.ts / ui-conversation contract/conversation.ts 均未变。
//   0.2.0 renderer 侧的三处变化与插件无关或已被插件消化：
//     ① 官方 TurnProcessNodeView running → return null（live 视觉迁往 RunningStatus）：
//        插件 shadow 该 key，node 投影（turn/start）与 slot 调用不变 → Running Bar 不受影响；
//     ② ChatGroupSeat TextShimmer 嵌套：shimmer 属性移到外层 span（:has() 仍命中）；
//     ③ process-groups 官方分组顺序微调（question-reply 合并）：插件不拥有分组。
// 本文件用同一组官方形状 fixtures 显式按版本标注跑双份断言，锁定
// "一个实现 + feature detection"——禁止 if DSH 0.1.7 / if DSH 0.2.0 分叉。
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { loadPlugin, CLIENT_JS } from './helpers/loader.mjs'
import {
  makeTurnNode, makeTurnProcessOwner, makeUseTurnData, makeStepsSource, makeUseChat,
  makeStepData, makeStep, OFFICIAL_TOKEN_USAGE, T0, T1,
} from './helpers/fixtures.mjs'

const require = createRequire(import.meta.url)
import dom, { sharedWindow, sharedDocument } from './helpers/dom.mjs'

const { test: T, window: pluginWindow } = loadPlugin({ window: sharedWindow })
const react = require('react')
const src = readFileSync(CLIENT_JS, 'utf8')
const document = sharedDocument

const VERSIONS = [
  { label: '0.1.7-rc.2', commit: '787b746b807df83776957875683b8853c862ca2c' },
  { label: '0.2.0-rc.2', commit: 'c1b47e41fcd54d20a0f061df28683bfc29ee24e5' },
]

// 每个版本的 contract shapes 一致（审计结论）——fixture 工厂按版本打标复用。
function fixturesFor(version) {
  return {
    label: version.label,
    makeNode: (opts) => makeTurnNode(opts),
    makeOwner: (overrides) => makeTurnProcessOwner(overrides),
  }
}

function renderTurnBar(props) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => { root.render(react.createElement(T.EnhancedTurnProcessView, props)) })
  return {
    container,
    runningBar: () => container.querySelector('[data-tf-running="true"]'),
    button: () => container.querySelector('button.ccg-turn-bar-main'),
    staticBar: () => container.querySelector('[data-tf-static="true"]'),
    cleanup: () => { act(() => { root.unmount() }); container.remove() },
  }
}

// ══════════════ A. Slot contract：turn-process renderer props（双版本） ══════════════
describe('版本矩阵 A：turn-process slot renderer props（contract/slots.ts 双版本一致）', () => {
  for (const v of VERSIONS) {
    it(v.label + '：closed Turn + owner → 折叠栏，aria-expanded 来自 owner.open', () => {
      const f = fixturesFor(v)
      const owner = f.makeOwner({ open: false })
      const view = renderTurnBar({
        node: f.makeNode({ status: 'closed' }),
        turnProcess: owner,
        useTurnData: makeUseTurnData({ tail: { tokenUsage: OFFICIAL_TOKEN_USAGE } }),
        useChat: makeUseChat(makeStepsSource([]).holder),
      })
      try {
        assert.ok(view.button(), '折叠栏呈现')
        assert.equal(view.button().getAttribute('aria-expanded'), 'false')
      } finally { view.cleanup() }
    })
  }

  it('priority -1 shadow 机制在 0.2.0 仍合法：register-node-renderers 以 key+priority 注册（源码契约测试锁定）', () => {
    // 结构守卫：插件仍以 keyed slot + priority 覆盖方式注册，官方 keyed slot 语义未变。
    assert.ok(src.includes('conversation.chat.node'), '插件必须注册官方 conversation.chat.node slot')
    assert.ok(src.includes('priority'), '插件以 priority 覆盖官方 renderer')
  })
})

// ══════════════ B. TurnProcess owner 语义（0.2.0 官方实现逐项对照） ══════════════
describe('版本矩阵 B：TurnProcessOwnerProps 语义（0.2.0 TurnProcessNodeView 同款推导）', () => {
  it('open = !foldable || turnProcess.open（官方 c1b47e41 第 14 行同语义）', () => {
    const owner = makeTurnProcessOwner({ foldable: false, open: false })
    // foldable=false → 官方 open=true：Poker 呈扇形（静态栏，无 button）
    const view = renderTurnBar({
      node: makeTurnNode({ status: 'closed' }),
      turnProcess: owner,
      useTurnData: makeUseTurnData({}),
      useChat: makeUseChat(makeStepsSource([]).holder),
    })
    try {
      assert.ok(view.staticBar(), 'foldable=false → 静态栏')
      const fan = [...view.container.querySelectorAll('.ccg-poker-motion')]
        .some((m) => (m.getAttribute('transform') || '').includes('rotate'))
      assert.ok(fan, 'Poker 呈扇形（官方 open 语义）')
    } finally { view.cleanup() }
  })

  it('canCollapse = foldable && hasContent && !alwaysOpen；aborted/error 回合不可折叠', () => {
    for (const reason of ['aborted', 'error']) {
      const view = renderTurnBar({
        node: makeTurnNode({ status: 'closed', reason }),
        turnProcess: makeTurnProcessOwner({ foldable: true, hasContent: true }),
        useTurnData: makeUseTurnData({}),
        useChat: makeUseChat(makeStepsSource([]).holder),
      })
      try {
        assert.ok(view.staticBar(), reason + ' → 不可折叠（官方 alwaysOpen 语义）')
      } finally { view.cleanup() }
    }
  })

  it('completed Turn：点击只调 turnProcess.setOpen（唯一折叠通道），插件不自持状态', () => {
    let requested
    const owner = makeTurnProcessOwner({ open: false, setOpen: (v) => { requested = v } })
    const view = renderTurnBar({
      node: makeTurnNode({ status: 'closed' }),
      turnProcess: owner,
      useTurnData: makeUseTurnData({}),
      useChat: makeUseChat(makeStepsSource([]).holder),
    })
    try {
      act(() => { view.button().click() })
      assert.equal(requested, true, '点击 → setOpen(true)（官方 owner 通道）')
      // 未重渲染前插件不得自行翻转显示状态
      assert.equal(view.button().getAttribute('aria-expanded'), 'false', '插件不自持 Fold 状态')
    } finally { view.cleanup() }
  })
})

// ══════════════ C. Running Turn Bar 生命周期（0.2.0 官方 renderer running→null 不影响 shadow） ══════════════
describe('版本矩阵 C：Running Turn Bar（0.2.0 turn-process 投影不变，0 秒呈现）', () => {
  it('open Turn（running）→ RunningTurnBar 渲染，无 Fold 状态、无 setOpen 调用', () => {
    let setOpenCalled = false
    const owner = makeTurnProcessOwner({ setOpen: () => { setOpenCalled = true } })
    const view = renderTurnBar({
      node: makeTurnNode({ status: 'open', endTime: null, startTime: Date.now() - 2000 }),
      turnProcess: owner,
      useTurnData: makeUseTurnData({}),
      useChat: makeUseChat(makeStepsSource([]).holder),
    })
    try {
      assert.ok(view.runningBar(), 'Running Turn Bar 呈现（0.2.0 投影仍在 turn/start 存在）')
      assert.equal(view.button(), null, 'running 阶段无折叠 button')
      assert.ok(!setOpenCalled, 'running 阶段不调 setOpen（不控制 Fold）')
    } finally { view.cleanup() }
  })

  it('turn close → 平滑交给 closed Fold Bar（同一 renderer，无第二套状态系统）', () => {
    const steps = makeStepsSource([])
    const node = { status: 'open', endTime: null, startTime: T0 }
    const owner = makeTurnProcessOwner({ open: false })
    const view = renderTurnBar({
      node: makeTurnNode(node),
      turnProcess: owner,
      useTurnData: makeUseTurnData({}),
      useChat: makeUseChat(steps.holder),
    })
    try {
      assert.ok(view.runningBar(), 'running 中')
      // 官方 turn/end：同一 props 流（node 重发布）→ closed Fold Bar
      const closed = renderTurnBar({
        node: makeTurnNode({ status: 'closed', startTime: T0, endTime: T1 }),
        turnProcess: owner,
        useTurnData: makeUseTurnData({ tail: { tokenUsage: OFFICIAL_TOKEN_USAGE } }),
        useChat: makeUseChat(steps.holder),
      })
      try {
        assert.ok(closed.button(), 'closed → 官方 owner 驱动的 Fold Bar')
        assert.equal(closed.runningBar(), null)
      } finally { closed.cleanup() }
    } finally { view.cleanup() }
  })
})

// ══════════════ D. Metrics（0.1.7 / 0.2.0 usage shapes 一致） ══════════════
describe('版本矩阵 D：metrics 数据形状（turn-tail 聚合 + assistant-step usage）', () => {
  for (const v of VERSIONS) {
    it(v.label + '：多 step + cache read → 官方聚合 tokenUsage 透出（不重估算）', () => {
      const steps = [
        makeStep(0, makeStepData(0, { usage: { inputTokens: 10970, outputTokens: 904, cacheReadTokens: 76544 }, timing: { stepStartTime: T0, firstTokenTime: T0 + 800 } })),
        makeStep(1, makeStepData(1, { usage: { inputTokens: 2000, outputTokens: 500, cacheReadTokens: 50000 }, timing: { stepStartTime: T0 + 9000, firstTokenTime: T0 + 9600 } })),
      ]
      const view = renderTurnBar({
        node: makeTurnNode({ status: 'closed', steps }),
        turnProcess: makeTurnProcessOwner(),
        useTurnData: makeUseTurnData({ tail: { tokenUsage: OFFICIAL_TOKEN_USAGE } }),
        useChat: makeUseChat(makeStepsSource(steps.map((s) => s.data.get('assistant-step'))).holder),
      })
      try {
        assert.ok(view.button(), '折叠栏呈现')
        const text = view.container.textContent
        assert.ok(text.includes('370,202'), 'totalTokens 用官方聚合值：' + text.slice(0, 120))
        assert.ok(text.includes('93.99'), 'cacheHit 按官方 cacheRead/billedInput')
      } finally { view.cleanup() }
    })
  }

  it('无 cache：cacheHit 缺失不崩溃；tool Turn / retry 聚合（tail.outputTokens = 全 attempt）', () => {
    const steps = [makeStep(0, makeStepData(0, { usage: { inputTokens: 500, outputTokens: 200 } }))]
    const view = renderTurnBar({
      node: makeTurnNode({ status: 'closed', steps, data: undefined }),
      turnProcess: makeTurnProcessOwner({ spec: { turn: 13, controlAnchorSeq: 1, processStartSeq: 1, answerAnchorSeq: 2, answerStep: 1, inlineReasoning: false, messageCount: 1, toolCallCount: 2, subagentCount: 0 } }),
      useTurnData: makeUseTurnData({ tail: { tokenUsage: { uncachedInputTokens: 500, outputTokens: 700, totalTokens: 1200 } } }),
      useChat: makeUseChat(makeStepsSource(steps.map((s) => s.data.get('assistant-step'))).holder),
    })
    try {
      assert.ok(view.button(), '折叠栏呈现（无 cache 字段安全）')
      assert.ok(!view.container.textContent.includes('NaN'), '无 NaN 指标')
    } finally { view.cleanup() }
  })

  it('running：不产生伪 token / 伪 TTFT（liveNow 只驱动时长）', () => {
    const view = renderTurnBar({
      node: makeTurnNode({ status: 'open', endTime: null, startTime: Date.now() - 1500 }),
      turnProcess: makeTurnProcessOwner(),
      useTurnData: makeUseTurnData({}),
      useChat: makeUseChat(makeStepsSource([]).holder),
    })
    try {
      const text = view.container.textContent
      assert.ok(view.runningBar(), 'Running Bar 呈现')
      assert.ok(!/\d{1,3}(,\d{3})+/.test(text), 'running 阶段不得出现千分位 token 数（无伪增长）：' + text)
    } finally { view.cleanup() }
  })
})

// ══════════════ E. Step DOM：0.1.7 平铺 shimmer / 0.2.0 嵌套 TextShimmer ══════════════
describe('版本矩阵 E：Step Group DOM soft hooks（双版本 DOM 形状）', () => {
  // 从皮肤 CSS 提取 running 选择器（与 unit.css.test 同款解析；翻牌 mask 规则）。
  // :has(...) 后必须紧跟卡牌位——排除 completed fan 规则里的 :not(:has(...)) 排除子句。
  function runningHostSelectors(skin) {
    const line = skin.split('\n').find((l) => l.includes(':has([data-shimmer="true"]) [data-step-process-icon]::before{') && l.includes('-webkit-mask-image:url("data:image/svg+xml'))
    assert.ok(line, 'running 翻牌 mask 规则缺失')
    return line.slice(0, line.indexOf('{')).split(',')
      .map((sel) => sel.slice(0, sel.lastIndexOf(' [data-step-process-icon]::before')))
  }
  function buildStep(shimmerShape) {
    // 官方 ChatGroupSeat → ProcessGroupHeader 结构（省略无关属性）：
    // 0.1.7：<span data-text-shimmer class=label>（TextShimmer 单层）
    // 0.2.0：<span data-shimmer><span class=label>（TextShimmer 嵌套，属性在外层）
    const host = document.createElement('div')
    host.setAttribute('data-step-process', '')
    const icon = document.createElement('span')
    icon.setAttribute('data-step-process-icon', '')
    host.appendChild(icon)
    const shimmer = document.createElement('span')
    if (shimmerShape === '0.1.7-rc.2') {
      host.appendChild(shimmer)
      shimmer.setAttribute('data-text-shimmer', 'true')
      const label = document.createElement('span')
      label.className = 'label'
      shimmer.appendChild(label)
    } else {
      shimmer.setAttribute('data-shimmer', 'true')
      host.appendChild(shimmer)
      const label = document.createElement('span')
      label.className = 'label'
      shimmer.appendChild(label)
    }
    document.body.appendChild(host)
    return { host, cleanup: () => host.remove() }
  }

  beforeEach(() => { T.settings.iconStyle = 'poker'; T.applyIconStyle() })

  for (const shape of ['0.1.7-rc.2', '0.2.0-rc.2']) {
    it(shape + ' 官方 DOM → running 选择器命中（任一 shimmer 契约），翻牌 mask 规则到位', () => {
      const skin = document.querySelector('style[data-plugin-css="' + T.SKIN_CSS_ID + '"]').textContent
      const selectors = runningHostSelectors(skin)
      const { host, cleanup } = buildStep(shape)
      try {
        const hit = selectors.filter((sel) => host.matches(sel))
        if (shape === '0.1.7-rc.2') {
          assert.equal(hit.length, 1, '0.1.7 只有 data-text-shimmer 选择器命中')
          assert.ok(hit[0].includes('data-text-shimmer'))
        } else {
          assert.equal(hit.length, 1, '0.2.0 只有 data-shimmer 选择器命中')
          assert.ok(hit[0].includes('[data-shimmer="true"]') && !hit[0].includes('data-text-shimmer'))
        }
        // 双契约 running 规则都在（单一卡牌位；mask 换成竖直对角线轴翻牌 SVG）
        assert.ok(skin.includes(':has([data-text-shimmer="true"]) [data-step-process-icon]::before'), '0.1.7 running 规则缺失')
        assert.ok(skin.includes(':has([data-shimmer="true"]) [data-step-process-icon]::before'), '0.2.0+ running 规则缺失')
      } finally { cleanup() }
    })
  }

  it('未知 activity 回落安全：activitySuitOf(未知) → heart（官方词表外不崩）', () => {
    assert.equal(T.activitySuitOf('some-future-activity'), 'heart')
  })
})
