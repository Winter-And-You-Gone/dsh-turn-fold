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
import { createSessionStore, makeUseSession } from './helpers/store.mjs'
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
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
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
function mount(snapshot, sessionId = 'sess-1') {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  const store = createSessionStore(snapshot)
  const useSession = makeUseSession(store)
  const propsFor = (node) => ({ node, useSession, sessionId, ...injectedHooks })
  act(() => {
    root.render(
      React.createElement('div', null,
        TURN13.chat.order
          .filter((k) => {
            const n = TURN13.chat.nodes.get(k)
            return n.kind !== 'user' && n.kind !== 'turn-tail'
          })
          .map((k) => {
            const node = TURN13.chat.nodes.get(k)
            const Comp = node.kind === 'tool-call' ? T.GroupedToolCallView : T.GroupedAssistantView
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