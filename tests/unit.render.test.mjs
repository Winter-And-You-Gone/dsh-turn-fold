// React 渲染测试：用 jsdom + react-dom/client 挂载真实的 GroupedToolCallView /
// GroupedAssistantView，驱动 useSession mock store，验证：
//   初始折叠 → 点击大组头展开 → 再次点击收起 的完整交互，以及
//   内置组件委托渲染时 useHostDescription 等 kit hook 的透传（Bug2 回归）。
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { loadPlugin } from './helpers/loader.mjs'
import { createSessionStore, makeUseSession, userNode, asNode, toolNode, buildSnapshot } from './helpers/store.mjs'
import { TURN13 } from './helpers/fixtures.mjs'

const require = createRequire(import.meta.url)
const { JSDOM } = require('jsdom')

// ── 全局 jsdom 环境 ──
const dom = new JSDOM('<!DOCTYPE html><html><head></head><body><div id="root"></div></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/',
})
globalThis.window = dom.window
globalThis.document = dom.window.document
// 固定界面语言为简体中文（client.js 按 navigator.language(s) 检测；文案断言按中文）。
Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN', languages: ['zh-CN'] }, configurable: true })
globalThis.IS_REACT_ACT_ENVIRONMENT = true

// ── 加载插件（fallback 组头路径） ──
const { test: T, exports: pluginExports, React } = loadPlugin({ window: dom.window })

// ── 模拟内置组件 ──
let lastToolCallProps = null
function MockToolCallTree(props) {
  lastToolCallProps = props
  // 组件内调用 useHostDescription（与真实 ToolCallTree 相同的用法），结果写入 DOM 供断言
  const home = typeof props.useHostDescription === 'function'
    ? props.useHostDescription((d) => d?.home)
    : 'NO-HOOK'
  return React.createElement('div', { className: 'mock-tool-card', 'data-call': props.node?.key, 'data-home': String(home) }, 'TOOL')
}
function MockAssistantNodeView(props) {
  return React.createElement('div', { className: 'mock-assistant', 'data-node': props.node?.key }, 'AS')
}
const BUILTIN_ENTRIES = [
  { component: MockToolCallTree, options: { key: 'tool-call', priority: 0, locale: 'conversation' } },
  { component: MockAssistantNodeView, options: { key: 'assistant-step', priority: 0, locale: 'conversation' } },
  { component: MockAssistantNodeView, options: { key: 'context', priority: 0, locale: 'conversation' } },
]

// ── 模拟 slots service ──
const slotRegistrations = []
const slotsService = {
  entries() { return [...BUILTIN_ENTRIES, ...slotRegistrations] },
  entriesOfSlot() { return [] },
  /**
   * @param {string} name
   * @param {() => import('react').ComponentType} factory
   */
  inject(name, factory) {
    const entry = factory()
    slotRegistrations.push(entry)
  },
  register(options, component) {
    return { component, options }
  },
}

// ── 驱动 apply（注入 connection + slots） ──
const hostDescriptionSource = { getSnapshot: () => ({ home: 'C:/Users/Test' }), subscribe: () => () => {} }
pluginExports.apply({
  inject(deps, cb) {
    cb({ slots: slotsService, connection: { hostDescription: hostDescriptionSource } })
  },
})

// ── 模拟 renderer 的 cachedSlotInject：条目 inject 声明的 hooks 变成 use<Name> props ──
// 真实 DSH 里 cachedSlotInject 会把 hooks.hostDescription(source) 绑定成 useHostDescription
// 传入条目组件；这里用同一机制从注册条目取 source 并绑定，模拟真实渲染链路。
const injectedHooks = (() => {
  const injectFace = slotRegistrations[0].options.inject()
  const source = injectFace.hooks.hostDescription
  const bind = (s) => (selector) =>
    React.useSyncExternalStore(
      (fn) => s.subscribe(fn),
      () => selector(s.getSnapshot()),
    )
  return { useHostDescription: bind(source) }
})()

// ── 渲染工具 ──
let root = null
let container = null
function mount(snapshot = TURN13, sessionId = 'sess-1') {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  const store = createSessionStore(snapshot)
  const useSession = makeUseSession(store)
  const propsFor = (node) => ({ node, useSession, sessionId, ...injectedHooks })
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
            return React.createElement(Comp, { key: k, ...propsFor(node) })
          }),
      ),
    )
  })
  return { store, useSession }
}
function clickHeader() {
  const el = container.querySelector('.ccg-header')
  assert.ok(el, '大组头应存在')
  act(() => { el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
}
function counts() {
  return {
    headers: container.querySelectorAll('.ccg-header').length,
    cards: container.querySelectorAll('.mock-tool-card').length,
    assistants: container.querySelectorAll('.mock-assistant').length,
    hidden: container.querySelectorAll('[data-ccg-hidden]').length,
  }
}

// ── 运行中回合 fixture：user → as(流式) → tool(运行中) → as(流式) ──
// turnEnds 为空（回合未结束）、turnTimings 只有 startTime（无 endTime）。
const RUNNING = buildSnapshot(
  [
    userNode('u-run', 100),
    asNode('as-run-1', 200, { step: 1, status: 'running', usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 200 } }),
    toolNode('tc-run', 300, { running: true, step: 1 }),
    asNode('as-run-2', 400, { step: 2, status: 'running', usage: { inputTokens: 30, outputTokens: 10, cacheReadTokens: 60 } }),
  ],
  { turnEnds: new Map(), turnTimings: new Map([[13, { startTime: Date.now() - 5000 }]]) },
)

describe('GroupedToolCallView / GroupedAssistantView 渲染交互（TURN13 真实结构）', () => {
  beforeEach(() => {
    T.turnOverrides.clear() // 模块级状态，避免测试间污染
    T.overrides.clear()
    mount(TURN13)
  })
  afterEach(() => {
    act(() => root.unmount())
    document.body.innerHTML = ''
    T.turnOverrides.clear()
    T.overrides.clear()
  })

  it('初始状态：只渲染大组头 + 最终总结，所有成员带隐藏标记', () => {
    const c = counts()
    assert.equal(c.headers, 1, '应恰好一个大组头')
    assert.ok(container.querySelector('.ccg-turn-divider'), '已结束回合收起状态下分隔线也常驻显示')
    assert.equal(c.cards, 0, '工具卡片应全部隐藏')
    assert.equal(c.assistants, 1, '最终总结消息保持可见')
    assert.equal(c.hidden, 7, '4 个工具 + 3 个中间 Think 共 7 个成员应带隐藏标记')
  })

  it('点击大组头展开：工具卡片与中间 Think 全部可见', () => {
    clickHeader()
    const c = counts()
    assert.equal(c.cards, 4, '4 个工具卡片应可见')
    // 可见的 assistant：组头自身内容(as-1) + 中间成员(as-2..4) + 最终总结(as-5) = 5
    assert.equal(c.assistants, 5, '中间 Think + 组头内容 + 最终总结应可见')
    assert.equal(c.hidden, 0)
    assert.ok(container.querySelector('.ccg-group-root[data-ccg-open="true"]'), '组根应标记展开')
  })

  it('再次点击收起：成员全部重新隐藏（回归 Bug2 场景）', () => {
    clickHeader()
    clickHeader()
    const c = counts()
    assert.equal(c.headers, 1)
    assert.equal(c.cards, 0, '收起后工具卡片必须重新隐藏')
    assert.equal(c.assistants, 1, '只保留最终总结')
    assert.equal(c.hidden, 7)
    assert.equal(container.querySelector('.ccg-group-root').dataset.ccgOpen, undefined, '组根不应标记展开')
  })

  it('Bug2 回归：委托渲染内置工具卡片时透传 useHostDescription（不再崩溃/abdicate）', () => {
    clickHeader()
    assert.ok(lastToolCallProps, '展开时应渲染内置工具卡片')
    assert.equal(typeof lastToolCallProps.useHostDescription, 'function', 'useHostDescription 必须注入并透传')
    const cards = container.querySelectorAll('.mock-tool-card')
    assert.equal(cards.length, 4)
    for (const card of cards) {
      assert.equal(card.dataset.home, 'C:/Users/Test', '内置组件应能通过 useHostDescription 读到 host home')
    }
  })

  it('大组头文案显示真实会话指标', () => {
    const title = container.querySelector('.ccg-header .ccg-title')
    assert.ok(title)
    assert.equal(title.textContent, '耗时22分34秒，消耗370202token，144tok/s，缓存命中94%')
  })
})

describe('运行中的回合：大组头从回复开始出现 + 实时指标 + 分隔线', () => {
  beforeEach(() => {
    T.turnOverrides.clear() // 模块级状态，避免测试间污染
    T.overrides.clear()
    T.liveTokenCache.clear()
    mount(RUNNING)
  })
  afterEach(() => {
    act(() => root.unmount())
    document.body.innerHTML = ''
    T.turnOverrides.clear()
    T.overrides.clear()
    T.liveTokenCache.clear()
  })

  it('回复开始即渲染大组头：组头 + 分隔线 + 内容全部可见（默认展开）', () => {
    const c = counts()
    assert.equal(c.headers, 1, '运行中应恰好一个大组头')
    assert.ok(container.querySelector('.ccg-turn-divider'), '大组头与内容之间应有分隔线')
    assert.ok(container.querySelector('.ccg-group-root[data-ccg-turn][data-ccg-open="true"]'), '运行中默认展开')
    assert.equal(c.cards, 1, '运行中的工具调用应可见（回复逐条加载）')
    assert.equal(c.assistants, 2, '组头自身内容(as-run-1) + 流式消息(as-run-2) 应可见')
    assert.equal(c.hidden, 0)
  })

  it('大组头文案实时显示耗时/token（token 累计确定，耗时随秒表走动）', () => {
    const title = container.querySelector('.ccg-header .ccg-title')
    assert.ok(title)
    // token 累计 = 130 + 260 + 60 = 450、缓存命中 67% 为确定值；
    // 耗时 ≈ 5 秒（秒数不确定）、tok/s = 60/耗时 实时估算（秒数不确定）。
    // 滚轮数字是视觉装饰（DOM 含 0-9 数字条），完整文案在 sr-only 文本上。
    const sr = title.querySelector('.ccg-sr-only')
    assert.ok(sr, '滚轮文案应有 sr-only 最终文本')
    assert.match(sr.textContent, /^耗时\d+秒，消耗450token，\d+(\.\d+)?tok\/s，缓存命中67%$/)
  })

  it('点击大组头收起：成员隐藏、分隔线常驻；再点展开恢复', () => {
    clickHeader()
    let c = counts()
    assert.equal(c.headers, 1)
    assert.equal(c.cards, 0, '收起后工具调用隐藏')
    assert.equal(c.assistants, 0, '收起后组头内容与流式消息都隐藏')
    assert.equal(c.hidden, 2, '成员 as-run-2 / tc-run 带隐藏标记')
    assert.ok(container.querySelector('.ccg-turn-divider'), '收起后分隔线仍常驻显示')
    clickHeader()
    c = counts()
    assert.ok(container.querySelector('.ccg-turn-divider'), '展开后分隔线仍在')
    assert.equal(c.cards, 1)
    assert.equal(c.assistants, 2)
    assert.equal(c.hidden, 0)
  })
})

describe('滚轮数字（RollDigit / AnimatedLabel / 大组头 live 文案）', () => {
  let rroot = null
  let rcontainer = null
  function mountNode(el) {
    rcontainer = document.createElement('div')
    document.body.appendChild(rcontainer)
    rroot = createRoot(rcontainer)
    act(() => { rroot.render(el) })
  }
  function rerender(el) {
    act(() => { rroot.render(el) })
  }
  afterEach(() => {
    act(() => rroot?.unmount())
    document.body.innerHTML = ''
    T.turnOverrides.clear()
    T.overrides.clear()
  })

  it('RollDigit：每位数一个视窗，内部竖排 0-9，按 data-digit 定位（jsdom 无 WAAPI → 静态 transform）', () => {
    mountNode(React.createElement(T.RollDigit, { digit: 5 }))
    const cell = rcontainer.querySelector('.ccg-roll-cell')
    assert.ok(cell, '应有滚轮视窗')
    assert.equal(cell.dataset.digit, '5')
    const strip = cell.querySelector('.ccg-roll-strip')
    assert.ok(strip)
    assert.equal(strip.children.length, 10, '数字条应含 0-9')
    assert.equal(strip.children[9].textContent, '9')
    // translateY(-k*10%)：strip 高 10em，10% = 1em = 一个数位
    assert.equal(strip.style.transform, 'translateY(-50%)')
  })

  it('RollDigit：数值变化后 transform 更新（滚动到新数位）', () => {
    mountNode(React.createElement(T.RollDigit, { digit: 5 }))
    rerender(React.createElement(T.RollDigit, { digit: 7 }))
    const strip = rcontainer.querySelector('.ccg-roll-strip')
    assert.equal(strip.style.transform, 'translateY(-70%)')
  })

  it('AnimatedLabel：数字拆成逐位滚轮、文字原样，sr-only 保留完整最终文案', () => {
    mountNode(React.createElement(T.AnimatedLabel, { label: '耗时5秒，消耗450token，12tok/s，缓存命中67%' }))
    const cells = rcontainer.querySelectorAll('.ccg-roll-cell')
    // 数字 5 / 4 5 0 / 1 2 / 6 7 = 8 个数位
    assert.equal(cells.length, 8)
    assert.deepEqual([...cells].map((c) => c.dataset.digit), ['5', '4', '5', '0', '1', '2', '6', '7'])
    const sr = rcontainer.querySelector('.ccg-sr-only')
    assert.ok(sr, '应有 sr-only 完整文案')
    assert.equal(sr.textContent, '耗时5秒，消耗450token，12tok/s，缓存命中67%')
  })

  it('AnimatedLabel：数值更新只滚动对应数位（9→10 进位时新增高位）', () => {
    const el = (label) => React.createElement(T.AnimatedLabel, { label })
    mountNode(el('耗时9秒'))
    rerender(el('耗时10秒'))
    const cells = rcontainer.querySelectorAll('.ccg-roll-cell')
    assert.deepEqual([...cells].map((c) => c.dataset.digit), ['1', '0'])
    const strips = rcontainer.querySelectorAll('.ccg-roll-strip')
    assert.equal(strips[0].style.transform, 'translateY(-10%)')
    assert.equal(strips[1].style.transform, 'translateY(0%)')
  })

  it('GroupHeader live=true：标题数字渲染滚轮；live=false（或缺省）：纯文本', () => {
    const h = (live) => React.createElement(T.GroupHeader, { count: 0, open: true, onToggle: () => {}, label: '耗时5秒，消耗450token', isTurn: true, live })
    mountNode(h(true))
    assert.equal(rcontainer.querySelectorAll('.ccg-roll-cell').length, 4)
    rerender(h(false))
    assert.equal(rcontainer.querySelectorAll('.ccg-roll-cell').length, 0, '非直播回退纯文本')
    assert.equal(rcontainer.querySelector('.ccg-title').textContent, '耗时5秒，消耗450token')
  })
})

describe('注册契约（Bug2 根因回归）', () => {
  it('三个条目都声明了 hostDescription inject', () => {
    // 前 3 个是 BUILTIN_ENTRIES，接着是插件的 3 个注册条目
    const pluginEntries = slotRegistrations
    assert.equal(pluginEntries.length, 3, '应有 3 个插件条目注册')
    for (const entry of pluginEntries) {
      const opts = entry.options
      assert.equal(typeof opts.inject, 'function', `条目 ${opts.key} 必须声明 inject`)
      const injectFace = opts.inject()
      const hookNames = Object.keys(injectFace.hooks)
      assert.ok(hookNames.includes('hostDescription'), `条目 ${opts.key} 的 inject 必须包含 hostDescription`)
    }
  })
})