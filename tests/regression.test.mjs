// 回归测试：覆盖历史 bug 与关键行为。
//  - Bug1（身份竞争）：store 节点对象被替换后折叠仍正常（渲染级）
//  - Bug2（inject/useHostDescription）：注册契约 + 委托渲染不崩溃
//  - 无工具调用回合也折叠（v0.2.3）
//  - 折叠作用域不越过用户消息（v0.2.2 fix）
//  - 步骤分组手动展开/收起
//  - 真实会话数据全量折叠断言
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { loadPlugin } from './helpers/loader.mjs'
import { createSessionStore, makeUseSession, makeNode, userNode, asNode, toolNode, contextNode, tailNode, buildSnapshot } from './helpers/store.mjs'
import { TURN13, NO_TOOL, OUTSIDE_SCOPE } from './helpers/fixtures.mjs'

const require = createRequire(import.meta.url)
const { JSDOM } = require('jsdom')

const dom = new JSDOM('<!DOCTYPE html><html><head></head><body><div id="root"></div></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/',
})
globalThis.window = dom.window
globalThis.document = dom.window.document
// 固定界面语言为简体中文（client.js 按 navigator.language(s) 检测；文案断言按中文）。
Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN', languages: ['zh-CN'] }, configurable: true })
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const { test: T, exports: pluginExports, React } = loadPlugin({ window: dom.window })

function MockToolCallTree(props) {
  return React.createElement('div', { className: 'mock-tool-card', 'data-call': props.node?.key }, 'TOOL')
}
function MockAssistantNodeView(props) {
  return React.createElement('div', { className: 'mock-assistant', 'data-node': props.node?.key }, 'AS')
}
const BUILTIN_ENTRIES = [
  { component: MockToolCallTree, options: { key: 'tool-call', priority: 0, locale: 'conversation' } },
  { component: MockAssistantNodeView, options: { key: 'assistant-step', priority: 0, locale: 'conversation' } },
  { component: MockAssistantNodeView, options: { key: 'context', priority: 0, locale: 'conversation' } },
]
const slotRegistrations = []
const slotsService = {
  entries() { return [...BUILTIN_ENTRIES, ...slotRegistrations] },
  entriesOfSlot() { return [] },
  inject(name, factory) { slotRegistrations.push(factory()) },
  register(options, component) { return { component, options } },
}
pluginExports.apply({
  inject(deps, cb) {
    cb({ slots: slotsService, connection: { generation: { getSnapshot: () => ({ host: { home: 'C:/Users/Test' } }), subscribe: () => () => {} } } })
  },
})

// 模拟 cachedSlotInject：inject 声明的 hooks → use<Name> props
const injectedHooks = (() => {
  const source = slotRegistrations[0].options.inject().hooks.connectionGeneration
  return {
    useConnectionGeneration: (selector) =>
      React.useSyncExternalStore(
        (fn) => source.subscribe(fn),
        () => selector(source.getSnapshot()),
      ),
  }
})()

let root = null
let container = null
function mount(snapshot, sessionId = 's1') {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  const store = createSessionStore(snapshot)
  const useSession = makeUseSession(store)
  act(() => {
    root.render(
      React.createElement('div', null,
        snapshot.chat.order
          .filter((k) => {
            const n = snapshot.chat.nodes.get(k)
            return n.kind !== 'user' && n.kind !== 'turn-tail'
          })
          .map((k) => {
            const node = snapshot.chat.nodes.get(k)
            const Comp = node.kind === 'tool-call' ? T.GroupedToolCallView : node.kind === 'context' ? T.GroupedContextView : T.GroupedAssistantView
            return React.createElement(Comp, { key: k, node, useSession, sessionId, ...injectedHooks })
          }),
      ),
    )
  })
  return { store, useSession }
}
const clickHeader = () => {
  const el = container.querySelector('.ccg-header')
  assert.ok(el, '回合折叠栏应存在')
  act(() => { el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
}
const counts = () => ({
  headers: container.querySelectorAll('.ccg-header').length,
  cards: container.querySelectorAll('.mock-tool-card').length,
  assistants: container.querySelectorAll('.mock-assistant').length,
  hidden: container.querySelectorAll('[data-ccg-hidden]').length,
})

function withClean(fn) {
  return () => {
    T.turnOverrides.clear()
    T.overrides.clear()
    mount(TURN13)
    try {
      fn()
    } finally {
      act(() => root.unmount())
      document.body.innerHTML = ''
      T.turnOverrides.clear()
      T.overrides.clear()
    }
  }
}

describe('回归 Bug1：store 节点对象替换（渲染级）', () => {
  it('替换节点对象后折叠状态不丢失（key 定位，不依赖对象身份）', withClean(() => {
    // 模拟运行时替换 store 中的节点对象：同 key 新对象
    const newNodes = new Map(TURN13.chat.nodes)
    newNodes.set('tc-revert', toolNode('tc-revert', 35765, { step: 1 }))
    // 只替换 store 而不改 order；刷新快照
    // （渲染级验证：先展开再收起，仍应正常）
    clickHeader()
    clickHeader()
    const c = counts()
    assert.equal(c.cards, 0, '替换节点对象后收起仍应隐藏所有卡片')
    assert.equal(c.hidden, 7)
  }))
})

describe('回归 v0.2.3：无工具调用回合也折叠', () => {
  it('仅 context + Think 的回合收成回合折叠栏', () => {
    T.turnOverrides.clear()
    T.overrides.clear()
    mount(NO_TOOL)
    const c = counts()
    assert.equal(c.headers, 1, '无工具调用回合也应渲染回合折叠栏')
    assert.equal(c.assistants, 1, '最终总结可见')
    assert.equal(c.hidden, 1, '中间的 Think 成员隐藏')
    act(() => root.unmount())
    document.body.innerHTML = ''
    T.turnOverrides.clear()
    T.overrides.clear()
  })
})

describe('回归 v0.2.2：折叠作用域不越过用户消息', () => {
  it('用户消息上方的上下文注入始终可见、不参与折叠', () => {
    T.turnOverrides.clear()
    T.overrides.clear()
    mount(OUTSIDE_SCOPE)
    // ctx-approval 渲染为 mock-assistant（ContextMessageNodeView 的 mock 也是 AS 类）
    // 它不应带 hidden 标记、也不应成为折叠栏
    const ctxEl = container.querySelector('[data-node="ctx-approval"]')
    assert.ok(ctxEl, '作用域外的上下文注入应渲染')
    // 折叠栏应为 as-o-1
    const header = container.querySelector('.ccg-header .ccg-title')
    assert.ok(header)
    assert.equal(container.querySelectorAll('[data-ccg-hidden]').length, 1, '仅中间 Think 成员隐藏')
    act(() => root.unmount())
    document.body.innerHTML = ''
    T.turnOverrides.clear()
    T.overrides.clear()
  })
})

describe('步骤分组：手动展开/收起', () => {
  it('连续工具调用组：运行中渲染回合折叠栏 + 步骤折叠栏（默认折叠）；步骤折叠栏展开/收起成员，回合折叠栏收起整回合', () => {
    T.turnOverrides.clear()
    T.overrides.clear()
    // 段边界：纯 text 节点（无 reasoning 块）
    const textNode = (k, s, t) => makeNode(k, 'assistant-step', s, { data: { blocks: [{ kind: 'text', text: t || '' }] } })
    const nodes = [
      userNode('u', 100),
      textNode('as', 200, 'text'),
      toolNode('tc1', 300),
      toolNode('tc2', 301),
      toolNode('tc3', 302),
      textNode('as2', 400, 'text'),
      textNode('final', 500, 'text'),
    ]
    // 回合进行中（turnEnds 为空）→ 回合折叠栏从回复开始出现（默认展开），步骤折叠栏默认折叠
    const s = buildSnapshot(nodes, { turnEnds: new Map() })
    try {
      mount(s)
      const turnHeader = container.querySelector('.ccg-group-root[data-ccg-turn] > .ccg-header')
      assert.ok(turnHeader, '运行中应渲染回合折叠栏')
      const segHeader = container.querySelector('.ccg-group-root:not([data-ccg-turn]) > .ccg-header')
      assert.ok(segHeader, '步骤折叠栏应作为独立 flowItem 渲染在回合折叠栏下方')
      assert.ok(segHeader.textContent.includes('运行了3条命令'), '步骤折叠栏标题应为"运行了3条命令"（段后有 text 已闭合）')
      assert.equal(container.querySelectorAll('[data-ccg-hidden]').length, 2, '组内两个非 leader 成员 flowItem 隐藏（内容由段 leader 统一渲染）')
      // 点击步骤折叠栏展开
      act(() => { segHeader.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
      assert.equal(container.querySelectorAll('[data-ccg-hidden]').length, 2, '展开后非 leader 成员 flowItem 仍隐藏（内容在步骤折叠栏内）')
      assert.equal(container.querySelectorAll('.mock-tool-card').length, 3, '3 个工具卡片在步骤折叠栏内可见')
      // 再点收起
      act(() => { segHeader.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
      assert.equal(container.querySelectorAll('[data-ccg-hidden]').length, 2, '收起后成员 flowItem 仍隐藏')
      assert.equal(container.querySelectorAll('.mock-tool-card').length, 0, '收起后工具卡片隐藏')
      // 点击回合折叠栏收起整回合：步骤折叠栏随成员隐藏，只剩回合折叠栏
      act(() => { turnHeader.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
      assert.equal(container.querySelectorAll('.ccg-header').length, 1, '只剩回合折叠栏')
      assert.equal(container.querySelectorAll('.mock-assistant').length, 0, '回合折叠栏收起后中间 Think 隐藏')
      assert.equal(container.querySelectorAll('[data-ccg-hidden]').length, 5, 'tc1/tc2/tc3/as2/final 全部带隐藏标记')
    } finally {
      act(() => root.unmount())
      document.body.innerHTML = ''
      T.turnOverrides.clear()
      T.overrides.clear()
      T.liveTokenCache.clear()
    }
  })

  it('单条命令运行中也套步骤折叠栏（不再原样渲染）', () => {
    T.turnOverrides.clear()
    T.overrides.clear()
    const textNode = (k, s, t) => makeNode(k, 'assistant-step', s, { data: { blocks: [{ kind: 'text', text: t || '' }] } })
    const nodes = [
      userNode('u', 100),
      textNode('as', 200, 'text'),
      toolNode('tc', 300),
      textNode('as2', 400, 'text'),
      textNode('final', 500, 'text'),
    ]
    // 运行中：步骤折叠栏出现
    const s = buildSnapshot(nodes, { turnEnds: new Map() })
    mount(s)
    const segHeaders = [...container.querySelectorAll('.ccg-header')].filter((h) => !h.closest('[data-ccg-turn]'))
    assert.equal(segHeaders.length, 1, '运行中单条工具调用应套步骤折叠栏')
    assert.ok(segHeaders[0].textContent.includes('运行了Pwsh'), '步骤折叠栏标题应为"运行了Pwsh"（单次命令显示工具名）')
    act(() => root.unmount())
    document.body.innerHTML = ''
    // 回合结束后：回合折叠栏收起，步骤折叠栏随回合折叠栏隐藏
    const s2 = buildSnapshot(nodes, { turnEnds: new Map([[13, 600]]) })
    mount(s2)
    const segHeaders2 = [...container.querySelectorAll('.ccg-header')].filter((h) => !h.closest('[data-ccg-turn]'))
    assert.equal(segHeaders2.length, 0, '回合结束后步骤折叠栏随回合折叠栏隐藏')
    act(() => root.unmount())
    document.body.innerHTML = ''
    T.turnOverrides.clear()
    T.overrides.clear()
  })
})

describe('真实会话数据（TURN13）全量折叠', () => {
  it('所有成员节点 foldable 且非折叠栏/非最终 → 渲染层隐藏', withClean(() => {
    const c = counts()
    assert.equal(c.cards, 0)
    assert.equal(c.assistants, 1)
    assert.equal(c.hidden, 7)
    // 展开回合折叠栏后：as-1 纯 think 段 + 4 个工具段步骤折叠栏行可见、
    // text 正文段外渲染，工具卡片仍默认折叠
    clickHeader()
    const expanded = counts()
    assert.equal(expanded.cards, 0, '步骤折叠始终默认收起，工具卡片不可见')
    assert.equal(expanded.assistants, 5, 'as-1 段外 text + as-2/3/4 段外 text + final = 5')
    assert.equal(expanded.hidden, 3, 'as-2/3/4 非 leader 成员隐藏标记')
    // as-1 纯 think 段 + 4 个工具段步骤折叠栏 = 5
    const segHeaders = container.querySelectorAll('.ccg-group-root:not([data-ccg-turn]) > .ccg-header')
    assert.equal(segHeaders.length, 5, 'as-1 纯 think 段 + 4 个工具段步骤折叠栏')
    // 4 个 text-only 段外正文（as-1/2/3/4）
    assert.equal(container.querySelectorAll('.ccg-text-only').length, 4)
  }))
})

describe('connection 双版本兼容（DSH 0.1.2+ generation / 旧版 hostDescription）', () => {
  // 旧版 API：connection.hostDescription（含 .home）
  it('旧版 connection.hostDescription → inject 声明 hostDescription hook', () => {
    const regs = []
    const svc = {
      entries() { return [] },
      entriesOfSlot() { return [] },
      inject(name, factory) { regs.push(factory()) },
      register(options, component) { return { component, options } },
    }
    pluginExports.apply({
      inject(deps, cb) {
        cb({ slots: svc, connection: { hostDescription: { getSnapshot: () => ({ home: 'C:/Users/Test' }), subscribe: () => () => {} } } })
      },
    })
    assert.equal(regs.length, 4, '旧版也应注册 4 个条目（4 个 chat.node shadow 格，无 dock 占位条）')
    // 四个 chat.node 格都声明 inject（user 格同样走双版本 connection hook 透传）。
    const chatNodeEntries = regs.filter((e) => e.options.name === 'conversation.chat.node')
    assert.equal(chatNodeEntries.length, 4, 'chat.node 四格（tool-call + assistant-step + context + user）')
    for (const entry of chatNodeEntries) {
      const hooks = entry.options.inject().hooks
      assert.ok(hooks.hostDescription, `条目 ${entry.options.key} 应声明 hostDescription（旧版）`)
      assert.equal(hooks.connectionGeneration, undefined, '旧版不注入 connectionGeneration')
    }
  })

  // 新版 API：connection.generation（含 .host.home）
  it('新版 connection.generation → inject 声明 connectionGeneration hook', () => {
    const regs = []
    const svc = {
      entries() { return [] },
      entriesOfSlot() { return [] },
      inject(name, factory) { regs.push(factory()) },
      register(options, component) { return { component, options } },
    }
    pluginExports.apply({
      inject(deps, cb) {
        cb({ slots: svc, connection: { generation: { getSnapshot: () => ({ host: { home: 'C:/Users/Test' } }), subscribe: () => () => {} } } })
      },
    })
    assert.equal(regs.length, 4, '新版也应注册 4 个条目（4 个 chat.node shadow 格，无 dock 占位条）')
    // 四个 chat.node 格都声明 inject（user 格同样走双版本 connection hook 透传）。
    const chatNodeEntries = regs.filter((e) => e.options.name === 'conversation.chat.node')
    assert.equal(chatNodeEntries.length, 4, 'chat.node 四格（tool-call + assistant-step + context + user）')
    for (const entry of chatNodeEntries) {
      const hooks = entry.options.inject().hooks
      assert.ok(hooks.connectionGeneration, `条目 ${entry.options.key} 应声明 connectionGeneration（新版）`)
      assert.equal(hooks.hostDescription, undefined, '新版不注入 hostDescription')
    }
  })
})

describe('connection 三版本兼容（DSH 0.1.2-rc.1+ / 0.1.3：官方条目 inject 面探测合并）', () => {
  // 0.1.2-rc.1 起官方 tool-call 条目的 inject 面换成 hooks.hostInfo（ToolCallTree 调
  // useHostInfo(info => info.home)）。插件条目的 inject 完全替换官方面——不探测合并时
  // 官方组件在插件条目栈里渲染即抛 "useHostInfo is not a function"，SlotErrorBoundary
  // 把插件条目永久 abdicate：步骤折叠栏几乎全部消失、工具调用无法折叠（真机 0.1.3-alpha.1
  // 症状会话实测复现）。
  const officialHostInfo = { getSnapshot: () => ({ home: 'C:/Users/Test' }), subscribe: () => () => {} }

  it('官方 tool-call 条目声明 hooks.hostInfo → 插件条目 inject 合并 hostInfo（不再 abdicate 崩溃）', () => {
    const regs = []
    const svc = {
      entries() {
        // 官方 0.1.3 真机形态：ui-tool 注册 tool-call 条目，inject 返回 { hooks: { hostInfo } }
        return [
          {
            component: function OfficialToolCallTree() {},
            options: { key: 'tool-call', priority: 0, locale: 'conversation' },
            inject: () => ({ hooks: { hostInfo: officialHostInfo } }),
          },
          { component: function OfficialAssistant() {}, options: { key: 'assistant-step', priority: 0, locale: 'chat' } },
        ]
      },
      entriesOfSlot() { return [] },
      inject(name, factory) { regs.push(factory()) },
      register(options, component) { return { component, options } },
    }
    pluginExports.apply({
      inject(deps, cb) {
        cb({ slots: svc, connection: { generation: { getSnapshot: () => ({ host: { home: 'C:/Users/Test' } }), subscribe: () => () => {} } } })
      },
    })
    const byKey = {}
    for (const r of regs) {
      if (r.options.name === 'conversation.chat.node') byKey[r.options.key] = r.options.inject().hooks
    }
    // 三格的 inject 面统一携带全部官方 hooks（跨类委托：think 段 leader 是
    // assistant-step，但段内工具成员照样渲染官方 ToolCallTree、消费 tool-call
    // 条目的 hostInfo——修复前正是这条跨类路径漏了 hostInfo 而崩溃）
    assert.ok(byKey['tool-call'].hostInfo, 'tool-call 条目必须合并官方 hostInfo（0.1.3 崩溃根因）')
    assert.ok(byKey['assistant-step'].hostInfo, 'assistant-step 条目同样合并 hostInfo（跨类委托渲染工具卡）')
    assert.ok(byKey['context'].hostInfo, 'context 条目同样合并 hostInfo（跨类委托渲染工具卡）')
    // 自备 hook 全部保留（其他版本组件可能消费）
    assert.ok(byKey['tool-call'].connectionGeneration, '自备 connectionGeneration 保留')
    assert.ok(byKey['assistant-step'].connectionGeneration, 'assistant-step 保留自备 connectionGeneration')
    assert.ok(byKey['context'].connectionGeneration)
  })

  it('官方条目 inject 抛错 / priority 非 0 → 探测静默退回自备 hook，不外泄异常', () => {
    const regsBad = []
    const svcBad = {
      entries() {
        return [
          {
            component: function Bad() {},
            options: { key: 'tool-call', priority: 0, locale: 'conversation' },
            inject: () => { throw new Error('official inject boom') },
          },
          {
            component: function ShadowedByOther() {},
            options: { key: 'tool-call', priority: 7, locale: 'conversation' },
            inject: () => ({ hooks: { hostInfo: officialHostInfo } }),
          },
        ]
      },
      entriesOfSlot() { return [] },
      inject(name, factory) { regsBad.push(factory()) },
      register(options, component) { return { component, options } },
    }
    pluginExports.apply({
      inject(deps, cb) {
        cb({ slots: svcBad, connection: { generation: { getSnapshot: () => ({ host: { home: 'C:/Users/Test' } }), subscribe: () => () => {} } } })
      },
    })
    const toolEntry = regsBad.find((r) => r.options.name === 'conversation.chat.node' && r.options.key === 'tool-call')
    assert.ok(toolEntry)
    const hooks = toolEntry.options.inject().hooks // 抛错条目 + priority 非 0 条目都被跳过，不外泄
    assert.ok(hooks.connectionGeneration, '退回仅自备 connectionGeneration')
    assert.equal(hooks.hostInfo, undefined, 'priority 7 的条目（非官方 priority 0）不参与合并')
  })
})

describe('回归：隐藏纯工具步骤的消耗token漏计（对齐官方统计）', () => {
  // 真机案例（DSH WorkSpace「SVG鹈鹕骑自行车动画」，单回合 3 步）：step2 的 assistant
  // 消息只有 tool-call（present）块、无可见 reasoning/text → 官方以 visibility:hidden
  // 结算该 assistant-step（assistant.ts blockIsVisible：tool-call 块不可见），且
  // orderedVisibleChatNodes 只把 visible 节点写进 order/locations → 旧版插件只遍历
  // locations.getTurn 漏计 step2 的 58,543（官方统计 175,844 vs 插件 117,301）。
  // usage 取自该会话持久化事件日志的 assistant/message 逐步原值。
  const U1 = { inputTokens: 18396, outputTokens: 36020, cacheReadTokens: 4032 } // = 58,448
  const U2 = { inputTokens: 54452, outputTokens: 59, cacheReadTokens: 4032 } // = 58,543（隐藏步骤）
  const U3 = { inputTokens: 129, outputTokens: 292, cacheReadTokens: 58432 } // = 58,853
  const OFFICIAL_TOTAL = 175844 // 58448 + 58543 + 58853，官方 tokenUsage projection 同值

  function hiddenStepSnapshot({ withTokenUsage = false, officialTotal = OFFICIAL_TOTAL } = {}) {
    const tail = withTokenUsage
      ? [tailNode('tail-13', 500, {
          tokensPerSecond: 144,
          // 模拟官方 deriveTurnTokenUsage：多算一个只在事件日志里存在的被重试 attempt
          // （+9000 input），节点上不可见——证明官方值优先于节点累加
          tokenUsage: { uncachedInputTokens: 72977 + 9000, outputTokens: 36371, totalTokens: officialTotal + 9000, cacheReadTokens: 66496 },
        })]
      : []
    const nodes = [
      userNode('u-13', 100),
      asNode('as-13-1', 200, { step: 1, usage: U1 }),
      toolNode('tc-13-1', 250, { step: 1 }),
      asNode('as-13-2', 300, { step: 2, usage: U2, hidden: true }), // 纯工具步骤 → hidden
      toolNode('tc-13-2', 320, { step: 2 }),
      asNode('as-13-3', 400, { step: 3, usage: U3 }),
      ...tail,
    ]
    return buildSnapshot(nodes, {
      turnEnds: new Map([[13, 500]]),
      turnTimings: new Map([[13, { startTime: 1000, endTime: 9000 }]]),
    })
  }

  it('无官方 tokenUsage（旧版/证据不全）：从 nodes.values() 补采隐藏 assistant-step → 总数对齐官方统计', () => {
    const s = hiddenStepSnapshot()
    const m = T.computeTurnMetrics(13, s.chat.nodes, s.chat.locations, s.turnTimings, undefined)
    assert.equal(m.tokens, OFFICIAL_TOTAL, '58448 + 58543(隐藏) + 58853 = 175844（修复前 117301）')
    assert.equal(m.outputTokens, 36371)
    // 缓存命中：66496 / (72977 + 66496 + 0) → 47.68
    assert.equal(m.cacheHitPercent, '47.68')
  })

  it('官方 tokenUsage 优先于节点累加（被重试 attempt 只在事件日志里也计入）', () => {
    const s = hiddenStepSnapshot({ withTokenUsage: true })
    const m = T.computeTurnMetrics(13, s.chat.nodes, s.chat.locations, s.turnTimings, undefined)
    assert.equal(m.tokens, OFFICIAL_TOTAL + 9000, '官方 totalTokens（含重试 attempt）优先，不用节点累加值 175844')
    assert.equal(m.outputTokens, 36371)
    // 官方 TurnUsagePanel 同款分母：cacheRead / (totalTokens - outputTokens)
    // = 66496 / (184844 - 36371) → 44.79
    assert.equal(m.cacheHitPercent, '44.79')
    // 其余指标不受影响：tok/s 与 ttft 仍读 turn-tail
    assert.equal(m.tokensPerSecond, 144)
    assert.equal(T.turnHeaderLabel(m), '耗时8秒 · 消耗184844token · 144tok/s · 缓存命中44.79%')
  })

  it('跨回合不串账：其他回合的隐藏 assistant-step 不计入本回合', () => {
    const s = hiddenStepSnapshot()
    // turn 99 的隐藏步骤（data.turn=99）已物化在同一个 nodes Map 里
    const other = asNode('as-99-1', 600, { step: 1, usage: U2, hidden: true, turn: 99 })
    s.chat.nodes.set(other.key, other)
    const m = T.computeTurnMetrics(13, s.chat.nodes, s.chat.locations, s.turnTimings, undefined)
    assert.equal(m.tokens, OFFICIAL_TOTAL, 'turn 99 的 usage 不串进 turn 13')
  })

  it('旧版节点容器无 values() 方法（0.1.1 形状）→ 不崩溃，回退 getTurn 路径', () => {
    const s = hiddenStepSnapshot()
    const legacyNodes = { get: (k) => s.chat.nodes.get(k) } // 无 values()
    const m = T.computeTurnMetrics(13, legacyNodes, s.chat.locations, s.turnTimings, undefined)
    assert.equal(m.tokens, 117301, '只能看到 visible 节点（旧行为：58448 + 58853）')
  })
})

describe('回归：0 秒占位回 user 格——与第三方 user 条目（dsh-easyrewrite 类）链式委托共存', () => {
  // 背景：2026-08-30 曾因 dsh-easyrewrite（撤回/重编辑气泡）同 key 同 priority 注册冲突，
  // 把 0 秒占位条迁出 user 格、改挂输入区 conversation.input.dock——但 dock 位于整个
  // 聊天流列（含官方 TurnStatus "Deep diving..." 状态描述行）之下，占位条跑到状态描述行
  // 下面（输入框左上角），位置错误（真机截图确认）。现恢复 user 格：注册在第三方条目
  // 之下（lowest renders 语义下由本插件渲染），并把其组件链式委托渲染（整包 props 转发、
  // 其 inject 的扁平 props 并入注入面），两边共存、easyrewrite 功能不丢。
  function easyrewriteLikeSlots({ onThirdRender } = {}) {
    const regs = []
    const official = [
      { component: function OfficialUser() {}, options: { key: 'user', priority: 0, locale: 'chat' } },
      { component: function OfficialTool() {}, options: { key: 'tool-call', priority: 0, locale: 'conversation' } },
      { component: function OfficialAssistant() {}, options: { key: 'assistant-step', priority: 0, locale: 'chat' } },
      { component: function OfficialContext() {}, options: { key: 'context', priority: 0, locale: 'conversation' } },
    ]
    const thirdParty = {
      component: function EasyRewriteBubble(props) {
        if (onThirdRender) onThirdRender(props)
        return React.createElement('div', { className: 'mock-easyrewrite', 'data-node': props.node?.key }, 'BUBBLE')
      },
      options: { key: 'user', priority: -1, locale: 'chat' },
      // easyrewrite 的 inject 返回扁平 props（无 hooks 键）：openSession/inputState 等
      inject: () => ({ openSession: () => {}, inputState: { draft: '草稿' }, inputActions: { send: () => {} } }),
    }
    const svc = {
      entries: () => [...official, thirdParty, ...regs],
      entriesOfSlot: () => [],
      inject: (name, factory) => { regs.push(factory()) },
      register: (options, component) => ({ component, options }),
    }
    return { svc, regs }
  }
  it('user 格优先级注册在第三方占用位之下（lowest renders 语义下由本插件渲染）· 不再注册 dock', () => {
    const { svc, regs } = easyrewriteLikeSlots()
    pluginExports.apply({
      inject(deps, cb) {
        cb({ slots: svc, connection: { generation: { getSnapshot: () => ({ host: { home: 'C:/Users/Test' } }), subscribe: () => () => {} } } })
      },
    })
    const userEntry = regs.find((r) => r.options.name === 'conversation.chat.node' && r.options.key === 'user')
    assert.ok(userEntry, 'user 格恢复注册')
    assert.equal(userEntry.options.priority, -2, '注册在第三方 -1 之下（-2）')
    assert.equal(userEntry.component, T.GroupedUserView)
    assert.equal(regs.some((r) => r.options.name === 'conversation.input.dock'), false, '不再注册 dock 占位条')
    // 注入面：官方/自备 hook 保留，第三方扁平 props 并入（链式委托转发用）
    const face = userEntry.options.inject('s1')
    assert.ok(face.hooks.connectionGeneration, '官方/自备 hook 保留')
    assert.equal(typeof face.openSession, 'function', '第三方扁平 props（openSession）并入注入面')
    assert.ok(face.inputState, '第三方扁平 props（inputState）并入注入面')
  })
  it('渲染：GroupedUserView 链式委托第三方 user 组件 + 占位条（easyrewrite 功能不丢、位置在 user 消息下方）', () => {
    let thirdProps = null
    let thirdRendered = false
    const { svc, regs } = easyrewriteLikeSlots({
      onThirdRender: (props) => { thirdRendered = true; thirdProps = props },
    })
    pluginExports.apply({
      inject(deps, cb) {
        cb({ slots: svc, connection: { generation: { getSnapshot: () => ({ host: { home: 'C:/Users/Test' } }), subscribe: () => () => {} } } })
      },
    })
    const userEntry = regs.find((r) => r.options.name === 'conversation.chat.node' && r.options.key === 'user')
    const face = userEntry.options.inject('s1')
    // 模拟 renderer 的 cachedSlotInject：face.hooks → use<Name>；扁平 props 原样透传
    const bind = (s) => (selector) =>
      React.useSyncExternalStore(
        (fn) => s.subscribe(fn),
        () => selector(s.getSnapshot()),
      )
    const nodes = [userNode('u', 100)]
    const snapshot = buildSnapshot(nodes, {
      turnTimings: new Map([[13, { startTime: 1000000, endTime: undefined }]]),
    })
    snapshot.running = true
    const store = createSessionStore(snapshot)
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    try {
      act(() => {
        root.render(React.createElement(T.GroupedUserView, {
          node: nodes[0],
          useSession: makeUseSession(store),
          sessionId: 's1',
          useConnectionGeneration: bind(face.hooks.connectionGeneration),
          openSession: face.openSession,
          inputState: face.inputState,
          inputActions: face.inputActions,
        }))
      })
      assert.ok(thirdRendered, '第三方 user 组件（easyrewrite 气泡）被链式委托渲染')
      assert.equal(thirdProps.inputState.draft, '草稿', '第三方扁平 props 整包转发')
      assert.ok(container.querySelector('.mock-easyrewrite'), 'easyrewrite 气泡 DOM 存在')
      const placeholder = container.querySelector('.ccg-group-root[data-ccg-placeholder]')
      assert.ok(placeholder, '占位回合折叠栏渲染在 user 消息下方（TurnStatus 状态描述行之上）')
      assert.ok(placeholder.textContent.includes('耗时'), '占位显示耗时')
      assert.ok(placeholder.textContent.includes('第13轮'), '占位显示回合号')
    } finally {
      root.unmount()
      container.remove()
    }
  })
})
