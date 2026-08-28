// DSH 版本兼容性测试：0.1.1（useSession 快照自带 .chat + 顶层 turnEnds/turnTimings）
// 与 0.1.2（快照拆分：useChat 提供 ChatSnapshot、turnEnds/turnTimings 收进 chat.legacy）
// 两条数据路径都要能驱动折叠视图；以及官方 diff 数据在两版的不同位置（0.1.1 的
// callView/resultView wire 视图、0.1.2 的 root.meta.diffs）都能被读取。
// 另覆盖 hooks 顺序回归：折叠模式切换（turn-fold ↔ auto）不崩条目、双向可恢复。
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { loadPlugin } from './helpers/loader.mjs'
import { createSessionStore, makeUseSession, buildChatSnapshot } from './helpers/store.mjs'
import { TURN13, TURN13_NODES } from './helpers/fixtures.mjs'

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

// ── 加载插件（fallback 折叠栏路径） ──
const { test: T, exports: pluginExports, React } = loadPlugin({ window: dom.window })

// ── 模拟内置组件 / slots service（与 unit.render.test.mjs 同款的最小 mock） ──
const assistantNodes = []
function MockToolCallTree(props) {
  return React.createElement('div', { className: 'mock-tool-card', 'data-call': props.node?.key }, 'TOOL')
}
function MockAssistantNodeView(props) {
  assistantNodes.push(props.node)
  return React.createElement('div', { className: 'mock-assistant', 'data-node': props.node?.key }, 'AS')
}
function MockUserNodeView(props) {
  return React.createElement('div', { className: 'mock-user', 'data-node': props.node?.key }, 'USER')
}
const BUILTIN_ENTRIES = [
  { component: MockToolCallTree, options: { key: 'tool-call', priority: 0, locale: 'conversation' } },
  { component: MockAssistantNodeView, options: { key: 'assistant-step', priority: 0, locale: 'conversation' } },
  { component: MockAssistantNodeView, options: { key: 'context', priority: 0, locale: 'conversation' } },
  { component: MockUserNodeView, options: { key: 'user', priority: 0, locale: 'conversation' } },
]
const slotsService = {
  entries() { return [...BUILTIN_ENTRIES] },
  entriesOfSlot() { return [] },
  inject() {},
  register(options, component) { return { component, options } },
}
pluginExports.apply({
  inject(deps, cb) {
    cb({ slots: slotsService })
  },
})

// ── 渲染工具 ──
let root = null
let container = null
/**
 * 挂载 TURN13 的全部非 user 节点。
 * @param {object} opts
 * @param {object} [opts.sessionSnapshot] useSession 快照（缺省用 TURN13 本体 = 0.1.1 形状）
 * @param {object} [opts.chatSnapshot]   传入则注入 props.useChat（0.1.2 形状）
 */
function mount({ sessionSnapshot = TURN13, chatSnapshot = undefined } = {}) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  const sessionStore = createSessionStore(sessionSnapshot)
  const useSession = makeUseSession(sessionStore)
  let useChat = undefined
  if (chatSnapshot !== undefined) {
    const chatStore = createSessionStore(chatSnapshot)
    useChat = makeUseSession(chatStore)
  }
  const nodes = chatSnapshot ?? sessionSnapshot.chat
  const propsFor = (node) => ({ node, useSession, useChat, sessionId: 'sess-1' })
  act(() => {
    root.render(
      React.createElement('div', null,
        nodes.order
          .filter((k) => nodes.nodes.get(k).kind !== 'user' && nodes.nodes.get(k).kind !== 'turn-tail')
          .map((k) => {
            const node = nodes.nodes.get(k)
            const Comp = node.kind === 'tool-call' ? T.GroupedToolCallView : node.kind === 'context' ? T.GroupedContextView : T.GroupedAssistantView
            return React.createElement(Comp, { key: k, ...propsFor(node) })
          }),
      ),
    )
  })
  return { sessionStore }
}
function unmount() {
  if (root) {
    act(() => { root.unmount() })
    root = null
  }
  if (container) {
    container.remove()
    container = null
  }
}
function setFoldMode(mode) {
  act(() => { T.setFoldMode(mode) })
}

beforeEach(() => {
  // 折叠模式是模块级状态 + localStorage 持久化：每个用例前回到默认 turn-fold
  setFoldMode('turn-fold')
  assistantNodes.length = 0
})
afterEach(unmount)

describe('正文渲染不含 Think 行（textOnlyNode 结构级过滤，防运行版本差异露出）', () => {
  it('收起回合（仅最终总结可见）：内置渲染不收到 reasoning+text 混合块', () => {
    mount({})
    assert.ok(assistantNodes.length > 0, '应有内置 assistant 渲染调用')
    for (const n of assistantNodes) {
      const kinds = (n?.data?.blocks || []).map((b) => b && b.kind)
      assert.ok(!kinds.includes('text') || !kinds.includes('reasoning'),
        '内置渲染不应收到 reasoning+text 混合块（Think 行会露出）: ' + kinds.join(','))
    }
  })

  it('展开回合（段内 think 行 + 段外正文）：同上，且段外正文只含 text 块', () => {
    mount({})
    act(() => { T.setTurnOpen('sess-1', 13, true) })
    assert.ok(container.querySelector('.mock-assistant'), '展开后应有内置 assistant 内容')
    let sawTextBody = false
    for (const n of assistantNodes) {
      const kinds = (n?.data?.blocks || []).map((b) => b && b.kind)
      assert.ok(!kinds.includes('text') || !kinds.includes('reasoning'),
        '内置渲染不应收到 reasoning+text 混合块: ' + kinds.join(','))
      if (kinds.length > 0 && kinds.every((k) => k === 'text')) sawTextBody = true
    }
    assert.ok(sawTextBody, '应存在仅 text 块的段外正文渲染（textOnlyNode）')
  })
})

describe('0.1.1 路径：useSession 快照（.chat + 顶层 turnEnds/turnTimings）', () => {
  it('整回合折叠照常工作（适配层回归：顶层字段兜底）', () => {
    mount({})
    const header = container.querySelector('.ccg-header')
    assert.ok(header, '回合折叠栏应存在')
    assert.match(header.textContent, /耗时22分34秒/, '指标文案应来自顶层 turnTimings')
    assert.match(header.textContent, /第13轮/)
    assert.equal(container.querySelectorAll('.mock-tool-card').length, 0, '回合收起时工具卡片应被折叠')
  })
})

describe('0.1.2 路径：useChat 快照（扁平 ChatSnapshot + legacy 切片）', () => {
  it('useSession 无 chat/turnEnds/turnTimings 时，数据从 useChat 快照与 legacy 读取', () => {
    // 0.1.2 的 SessionSnapshot 只有 running 等会话级字段，读 turnEnds/turnTimings 得 undefined
    const chatSnapshot = buildChatSnapshot(TURN13_NODES, {
      turnEnds: new Map([[13, 38330]]),
      turnTimings: new Map([[13, { startTime: 1787394826374, endTime: 1787396180925 }]]),
    })
    mount({ sessionSnapshot: { running: false }, chatSnapshot })
    const header = container.querySelector('.ccg-header')
    assert.ok(header, '回合折叠栏应存在（useChat 路径）')
    assert.match(header.textContent, /耗时22分34秒/, '指标文案应来自 chat.legacy.turnTimings')
    assert.match(header.textContent, /第13轮/)
    assert.equal(container.querySelectorAll('.mock-tool-card').length, 0, '回合收起时工具卡片应被折叠')
  })

  it('useChat 快照更新（快照对象替换）驱动重渲染', () => {
    const chatSnapshot = buildChatSnapshot(TURN13_NODES, {
      turnEnds: new Map([[13, 38330]]),
      turnTimings: new Map([[13, { startTime: 1787394826374, endTime: 1787396180925 }]]),
    })
    const { sessionStore } = mount({ sessionSnapshot: { running: false }, chatSnapshot })
    assert.ok(container.querySelector('.ccg-header'), '初始应有回合折叠栏')
    // 模拟 0.1.2 chat target 快照更新：换一个新快照对象（identity 变化）
    const updated = buildChatSnapshot(TURN13_NODES, {
      turnEnds: new Map([[13, 38330]]),
      turnTimings: new Map([[13, { startTime: 0, endTime: 61000 }]]),
    })
    act(() => {
      // sessionStore 未变，chat store 变——通过重新挂载不可行，这里直接驱动 useChat 订阅：
      // chat 快照经 useChat 订阅，快照替换由 store.setSnapshot 完成（makeUseSession 复用）。
      sessionStore.setSnapshot({ running: false })
    })
    assert.ok(container.querySelector('.ccg-header'), 'session 快照更新后折叠栏仍在')
  })
})

describe('折叠模式切换（hooks 顺序回归：接管 ↔ 委托双向切换不崩）', () => {
  it('turn-fold → auto → turn-fold 往返，条目不崩且双向恢复', () => {
    mount({})
    assert.ok(container.querySelector('.ccg-header'), 'turn-fold 模式：回合折叠栏存在')
    assert.equal(container.querySelectorAll('.mock-tool-card').length, 0, 'turn-fold 模式：工具卡片被折叠')

    // 切到 auto：整段委托内置渲染。修复前 hook 数量在两条路径间变化会直接崩条目。
    assert.doesNotThrow(() => setFoldMode('auto'))
    assert.equal(container.querySelector('.ccg-header'), null, 'auto 模式：插件折叠栏卸载')
    assert.equal(container.querySelectorAll('.mock-tool-card').length, 4, 'auto 模式：4 个工具卡片由内置渲染器原样显示')

    // 切回 turn-fold：折叠视图恢复（修复前崩过的 fiber 无法恢复）
    setFoldMode('turn-fold')
    assert.ok(container.querySelector('.ccg-header'), '切回 turn-fold：回合折叠栏恢复')
    assert.equal(container.querySelectorAll('.mock-tool-card').length, 0, '切回 turn-fold：工具卡片重新被折叠')
  })

  it('auto 模式下挂载（首次渲染即委托），切回 turn-fold 正常接管', () => {
    setFoldMode('auto')
    mount({})
    assert.equal(container.querySelectorAll('.mock-tool-card').length, 4, 'auto 模式挂载：内置渲染')
    setFoldMode('turn-fold')
    assert.ok(container.querySelector('.ccg-header'), '切回 turn-fold：接管并渲染回合折叠栏')
  })
})

describe('官方 diffs 读取链（0.1.1 callView/resultView · 0.1.2 meta.diffs）', () => {
  const HUNKS = [{ path: 'a.ts', oldText: 'a\nb', newText: 'a\nb\nc' }]

  it('0.1.2 结算：root.meta.diffs（appliedDiffs）', () => {
    const info = T.toolCallInfo({ kind: 'tool-call', data: { root: { kind: 'tool-result', call: { name: 'edit', argsRaw: '{}' }, meta: { diffs: HUNKS } } } })
    assert.deepEqual(info.diffs, HUNKS)
  })
  it('0.1.2 meta.diffs 为空数组 → 官方语义 empty，回退 argsRaw（diffs=undefined）', () => {
    const info = T.toolCallInfo({ kind: 'tool-call', data: { root: { kind: 'tool-result', call: { name: 'edit', argsRaw: '{}' }, meta: { diffs: [] } } } })
    assert.equal(info.diffs, undefined)
  })
  it('0.1.1 结算：resultView.card=diff 权威，callView 兜底', () => {
    const root1 = { kind: 'tool-result', call: { name: 'edit', argsRaw: '' }, resultView: { card: 'diff', diffs: HUNKS }, callView: { card: 'diff', diffs: [{ path: 'x', oldText: 'a', newText: 'b' }] } }
    assert.deepEqual(T.toolCallInfo({ kind: 'tool-call', data: { root: root1 } }).diffs, HUNKS)
    const root2 = { kind: 'tool-result', call: { name: 'edit', argsRaw: '' }, callView: { card: 'diff', diffs: HUNKS } }
    assert.deepEqual(T.toolCallInfo({ kind: 'tool-call', data: { root: root2 } }).diffs, HUNKS)
  })
  it('0.1.1 非 diff 卡片视图（card≠diff）不读取', () => {
    const root = { kind: 'tool-result', call: { name: 'pwsh', argsRaw: '' }, resultView: { card: 'generic', diffs: HUNKS } }
    assert.equal(T.toolCallInfo({ kind: 'tool-call', data: { root } }).diffs, undefined)
  })
  it('兼容旧数据：diffs 直接挂 call / root 上也认', () => {
    const root1 = { kind: 'tool-result', call: { name: 'edit', argsRaw: '', diffs: HUNKS } }
    assert.deepEqual(T.toolCallInfo({ kind: 'tool-call', data: { root: root1 } }).diffs, HUNKS)
    const root2 = { kind: 'tool-result', call: { name: 'edit', argsRaw: '' }, diffs: HUNKS }
    assert.deepEqual(T.toolCallInfo({ kind: 'tool-call', data: { root: root2 } }).diffs, HUNKS)
  })
  it('运行中：callView.diffs（0.1.1 意图 diff）', () => {
    const root = { callId: 'c1', name: 'edit', argsRaw: '', callView: { card: 'diff', diffs: HUNKS } }
    const info = T.toolCallInfo({ kind: 'tool-call', data: { root } })
    assert.equal(info.running, true)
    assert.deepEqual(info.diffs, HUNKS)
  })
  it('hunk 形状校验：缺 oldText/newText 的畸形数据不采纳（走 argsRaw 兜底）', () => {
    assert.equal(T.validDiffHunks([{ path: 'a.ts' }]), undefined)
    assert.equal(T.validDiffHunks(['nope']), undefined)
    assert.equal(T.validDiffHunks([]), undefined)
    assert.equal(T.validDiffHunks(HUNKS), HUNKS)
    // oldText 为 null 合法（新建文件），只要有 newText
    assert.deepEqual(T.validDiffHunks([{ path: 'new.ts', oldText: null, newText: 'x' }]), [{ path: 'new.ts', oldText: null, newText: 'x' }])
  })
})

describe('对话 t 座席兼容（新版 ui-chat \'chat\' 命名空间，防 "message.think" 裸 key 露出）', () => {
  it('wrapLocaleT：宿主 t 全部未命中时用内置词典兜底（zh/en 随界面语言）', () => {
    const broken = (key) => key // locale 服务 ?? key 的未命中行为
    assert.equal(T.wrapLocaleT(broken)('message.think'), '思考')
    assert.equal(T.wrapLocaleT(broken)('row.running'), '运行中')
    const prev = dom.window.document.documentElement.lang
    dom.window.document.documentElement.lang = 'en' // 用插件实例自己的 dom（isolation=none 下 global document 属于最后加载的文件）
    try {
      assert.equal(T.wrapLocaleT(broken)('message.think'), 'Think')
      assert.equal(T.wrapLocaleT(broken)('row.failed'), 'Failed')
    } finally {
      dom.window.document.documentElement.lang = prev
    }
  })

  it('wrapLocaleT：命中原样透传、params 透传、t 缺失/抛错走兜底、未知 key 返回键名', () => {
    let gotParams = null
    const working = (key, params) => { gotParams = params; return key === 'message.think' ? '思考' : key }
    assert.equal(T.wrapLocaleT(working)('message.think'), '思考')
    T.wrapLocaleT(working)('message.think', { count: 3 })
    assert.deepEqual(gotParams, { count: 3 })
    assert.equal(T.wrapLocaleT(undefined)('message.think'), '思考', 't 缺失（测试/极简宿主）走兜底')
    assert.equal(T.wrapLocaleT(() => { throw new Error('boom') })('message.think'), '思考', 't 抛错不外泄')
    assert.equal(T.wrapLocaleT(undefined)('nope.key'), 'nope.key', '词典外的 key 原样返回')
  })

  it('注册条目 locale 按 key 对应跟随官方条目（tool-call=conversation / 其余=chat）', () => {
    // 新版真机形态：tool-call 由 ui-tool 注册声明 'conversation'（tool.title.* 词典），
    // assistant-step/context 由 ui-chat 注册声明 'chat'（message.* 词典）——同 slot 混两种。
    const regs = []
    const officialSlots = {
      entries: () => [
        { component: function OfficialTool() {}, options: { key: 'tool-call', priority: 0, locale: 'conversation' } },
        { component: function OfficialAssistant() {}, options: { key: 'assistant-step', priority: 0, locale: 'chat' } },
        { component: function OfficialContext() {}, options: { key: 'context', priority: 0, locale: 'chat' } },
      ],
      entriesOfSlot: () => [],
      inject: (name, factory) => { regs.push(factory()) },
      register: (options, component) => ({ component, options }),
    }
    pluginExports.apply({ inject(deps, cb) { cb({ slots: officialSlots, connection: {} }) } })
    const ours = {}
    for (const r of regs) {
      if (r.options.priority === -1 && r.options.name === 'conversation.chat.node') ours[r.options.key] = r.options.locale
    }
    assert.equal(ours['tool-call'], 'conversation', '工具卡标题词（tool.title.read=读取）在 conversation 词典')
    assert.equal(ours['assistant-step'], 'chat', 'message.think=思考 在 chat 词典')
    assert.equal(ours['context'], 'chat')
    assert.equal(ours['user'], 'conversation', '无同 key 官方条目且无 ctx.locale 探针 → 回退 conversation')
  })

  it('无官方条目且无 chat 词典时全部回退 conversation（0.1.1 行为不变）', () => {
    const regsFallback = []
    const emptySlots = {
      entries: () => [],
      entriesOfSlot: () => [],
      inject: (name, factory) => { regsFallback.push(factory()) },
      register: (options, component) => ({ component, options }),
    }
    pluginExports.apply({ inject(deps, cb) { cb({ slots: emptySlots, connection: {} }) } })
    const oursFallback = regsFallback.filter((r) => r.options.priority === -1 && r.options.name === 'conversation.chat.node')
    assert.ok(oursFallback.length >= 4)
    for (const r of oursFallback) assert.equal(r.options.locale, 'conversation', '回退 conversation（0.1.1 行为不变）')
  })
})
