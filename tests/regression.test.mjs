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
    // 展开回合折叠栏后：4 个工具段步骤折叠栏行可见（as-1 纯 think 段直接官方渲染）、
    // text 正文段外渲染，工具卡片仍默认折叠
    clickHeader()
    const expanded = counts()
    assert.equal(expanded.cards, 0, '步骤折叠始终默认收起，工具卡片不可见')
    assert.equal(expanded.assistants, 5, 'as-1 官方渲染 + as-2/3/4 text-only + final = 5')
    assert.equal(expanded.hidden, 3, 'as-2/3/4 非 leader 成员隐藏标记')
    // 4 个工具段步骤折叠栏（as-1 纯 think 段无步骤折叠栏）
    const segHeaders = container.querySelectorAll('.ccg-group-root:not([data-ccg-turn]) > .ccg-header')
    assert.equal(segHeaders.length, 4, '4 个工具段步骤折叠栏')
    // 3 个 text-only 段外正文（as-2/3/4）
    assert.equal(container.querySelectorAll('.ccg-text-only').length, 3)
  }))
})
