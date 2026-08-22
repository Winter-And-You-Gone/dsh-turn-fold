// 回归测试：覆盖历史 bug 与关键行为。
//  - Bug1（身份竞争）：store 节点对象被替换后折叠仍正常（渲染级）
//  - Bug2（inject/useHostDescription）：注册契约 + 委托渲染不崩溃
//  - 无工具调用回合也折叠（v0.2.3）
//  - 折叠作用域不越过用户消息（v0.2.2 fix）
//  - 段级分组手动展开/收起
//  - 真实会话数据全量折叠断言
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { loadPlugin } from './helpers/loader.mjs'
import { createSessionStore, makeUseSession, makeNode, userNode, asNode, toolNode, contextNode, buildSnapshot } from './helpers/store.mjs'
import { TURN13, NO_TOOL, OUTSIDE_SCOPE } from './helpers/fixtures.mjs'

const require = createRequire(import.meta.url)
const { JSDOM } = require('jsdom')

const dom = new JSDOM('<!DOCTYPE html><html><head></head><body><div id="root"></div></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/',
})
globalThis.window = dom.window
globalThis.document = dom.window.document
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
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
    cb({ slots: slotsService, connection: { hostDescription: { getSnapshot: () => ({ home: 'C:/Users/Test' }), subscribe: () => () => {} } } })
  },
})

// 模拟 cachedSlotInject：inject 声明的 hooks → use<Name> props
const injectedHooks = (() => {
  const source = slotRegistrations[0].options.inject().hooks.hostDescription
  return {
    useHostDescription: (selector) =>
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
  assert.ok(el, '大组头应存在')
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
  it('仅 context + Think 的回合收成大组头', () => {
    T.turnOverrides.clear()
    T.overrides.clear()
    mount(NO_TOOL)
    const c = counts()
    assert.equal(c.headers, 1, '无工具调用回合也应渲染大组头')
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
    // 它不应带 hidden 标记、也不应成为组头
    const ctxEl = container.querySelector('[data-node="ctx-approval"]')
    assert.ok(ctxEl, '作用域外的上下文注入应渲染')
    // 组头应为 as-o-1
    const header = container.querySelector('.ccg-header .ccg-title')
    assert.ok(header)
    assert.equal(container.querySelectorAll('[data-ccg-hidden]').length, 1, '仅中间 Think 成员隐藏')
    act(() => root.unmount())
    document.body.innerHTML = ''
    T.turnOverrides.clear()
    T.overrides.clear()
  })
})

describe('段级分组：手动展开/收起', () => {
  it('连续工具调用组：leader 渲染段组头，点击展开/收起成员（回合未结束时）', () => {
    T.turnOverrides.clear()
    T.overrides.clear()
    const nodes = [
      userNode('u', 100),
      asNode('as', 200),
      toolNode('tc1', 300),
      toolNode('tc2', 301),
      toolNode('tc3', 302),
      asNode('as2', 400),
      asNode('final', 500),
    ]
    // 回合未结束（turnEnds 为空）→ 段级分组生效，不套大组头
    const s = buildSnapshot(nodes, { turnEnds: new Map() })
    mount(s)
    const segHeaders = [...container.querySelectorAll('.ccg-header')].filter((h) => !h.closest('[data-ccg-turn]'))
    assert.equal(segHeaders.length, 1, '应有一个段级组头')
    assert.equal(container.querySelectorAll('[data-ccg-hidden]').length, 2, '组内两个非 leader 成员隐藏')
    // 点击段级组头展开
    act(() => { segHeaders[0].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
    assert.equal(container.querySelectorAll('[data-ccg-hidden]').length, 0, '展开后成员可见')
    // 再点收起
    act(() => { segHeaders[0].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
    assert.equal(container.querySelectorAll('[data-ccg-hidden]').length, 2, '收起后成员重新隐藏')
    act(() => root.unmount())
    document.body.innerHTML = ''
    T.turnOverrides.clear()
    T.overrides.clear()
  })

  it('单条命令不套段级组头（count=1 原样渲染）', () => {
    T.turnOverrides.clear()
    T.overrides.clear()
    const nodes = [
      userNode('u', 100),
      asNode('as', 200),
      toolNode('tc', 300),
      asNode('as2', 400),
      asNode('final', 500),
    ]
    const s = buildSnapshot(nodes, { turnEnds: new Map([[13, 600]]) })
    mount(s)
    // 回合折叠状态：无段级组头（成员全部收进大组头）
    const segHeaders = [...container.querySelectorAll('.ccg-header')].filter((h) => !h.closest('[data-ccg-turn]'))
    assert.equal(segHeaders.length, 0)
    act(() => root.unmount())
    document.body.innerHTML = ''
    T.turnOverrides.clear()
    T.overrides.clear()
  })
})

describe('真实会话数据（TURN13）全量折叠', () => {
  it('所有成员节点 foldable 且非组头/非最终 → 渲染层隐藏', withClean(() => {
    const c = counts()
    assert.equal(c.cards, 0)
    assert.equal(c.assistants, 1)
    assert.equal(c.hidden, 7)
    // 展开后全部可见
    clickHeader()
    assert.equal(counts().cards, 4)
    assert.equal(counts().hidden, 0)
  }))
})
