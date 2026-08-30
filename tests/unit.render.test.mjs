// React 渲染测试：用 jsdom + react-dom/client 挂载真实的 GroupedToolCallView /
// GroupedAssistantView · 驱动 useSession mock store · 验证：
//   初始折叠 → 点击回合折叠栏展开 → 再次点击收起 的完整交互 · 以及
//   内置组件委托渲染时 useHostDescription 等 kit hook 的透传（Bug2 回归）。
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { loadPlugin } from './helpers/loader.mjs'
import { createSessionStore, makeUseSession, makeNode, userNode, asNode, toolNode, buildSnapshot } from './helpers/store.mjs'
import { TURN13, TURN13_METRICS } from './helpers/fixtures.mjs'

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

// ── 加载插件（fallback 折叠栏路径） ──
const { test: T, exports: pluginExports, React } = loadPlugin({ window: dom.window })

// ── 模拟内置组件 ──
let lastToolCallProps = null
function MockToolCallTree(props) {
  lastToolCallProps = props
  // 组件内调用 useConnectionGeneration（与真实 ToolCallTree 相同的用法） · 结果写入 DOM 供断言
  const home = typeof props.useConnectionGeneration === 'function'
    ? props.useConnectionGeneration((g) => g?.host?.home)
    : 'NO-HOOK'
  return React.createElement('div', { className: 'mock-tool-card', 'data-call': props.node?.key, 'data-home': String(home) }, 'TOOL')
}
function MockAssistantNodeView(props) {
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
const hostDescriptionSource = { getSnapshot: () => ({ host: { home: 'C:/Users/Test' } }), subscribe: () => () => {} }
pluginExports.apply({
  inject(deps, cb) {
    cb({ slots: slotsService, connection: { generation: hostDescriptionSource } })
  },
})

// ── 模拟 renderer 的 cachedSlotInject：条目 inject 声明的 hooks 变成 use<Name> props ──
// 真实 DSH 里 cachedSlotInject 会把 hooks.connectionGeneration(source) 绑定成 useConnectionGeneration
// 传入条目组件；这里用同一机制从注册条目取 source 并绑定 · 模拟真实渲染链路。
const injectedHooks = (() => {
  const injectFace = slotRegistrations[0].options.inject()
  const source = injectFace.hooks.connectionGeneration
  const bind = (s) => (selector) =>
    React.useSyncExternalStore(
      (fn) => s.subscribe(fn),
      () => selector(s.getSnapshot()),
    )
  return { useConnectionGeneration: bind(source) }
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
  assert.ok(el, '回合折叠栏应存在')
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
    T.turnOverrides.clear() // 模块级状态 · 避免测试间污染
    T.overrides.clear()
    mount(TURN13)
  })
  afterEach(() => {
    act(() => root.unmount())
    document.body.innerHTML = ''
    T.turnOverrides.clear()
    T.overrides.clear()
  })

  it('初始状态：只渲染回合折叠栏 + 最终总结 · 所有成员带隐藏标记', () => {
    const c = counts()
    assert.equal(c.headers, 1, '应恰好一个回合折叠栏')
    assert.ok(container.querySelector('.ccg-turn-divider'), '已结束回合收起状态下分隔线也常驻显示')
    assert.equal(c.cards, 0, '工具卡片应全部隐藏')
    assert.equal(c.assistants, 1, '最终总结消息保持可见')
    assert.equal(c.hidden, 7, '4 个工具 + 3 个中间 Think 共 7 个成员应带隐藏标记')
  })

  it('点击回合折叠栏展开：步骤折叠栏行可见（纯 think 段 + 工具段）+ text 正文段外渲染', () => {
    clickHeader()
    const c = counts()
    // 步骤折叠默认收起 → 工具卡片隐藏
    assert.equal(c.cards, 0, '步骤折叠默认收起 · 工具卡片不可见')
    // text 正文：as-1 段外 text 1 + as-2/3/4 text-only 3 + as-5 final 1 = 5
    assert.equal(c.assistants, 5, 'text 正文各处渲染 = 5')
    assert.equal(c.hidden, 3, 'as-2/3/4 非 leader 成员隐藏标记')
    assert.ok(container.querySelector('.ccg-group-root[data-ccg-open="true"]'), '组根应标记展开')
    // 步骤折叠栏：as-1 纯 think 段 + 4 个工具段 = 5
    const segHeaders = [...container.querySelectorAll('.ccg-group-root:not([data-ccg-turn]) > .ccg-header')]
    assert.equal(segHeaders.length, 5, '应有 5 个步骤折叠栏（as-1 纯 think 段 + tc-revert/check/restore/verify）')
    // as-1 纯 think 段标题"思考了1次"，其余工具段"运行了Pwsh"
    assert.ok(segHeaders[0].textContent.includes('思考了1次'), '首个步骤折叠栏为纯 think 段')
    for (let i = 1; i < segHeaders.length; i++) {
      assert.ok(segHeaders[i].textContent.includes('运行了Pwsh'), '工具步骤折叠栏标题应为"运行了Pwsh"')
    }
    // text-only：as-1/2/3/4 段外 text（as-1 纯 think 段也有段外 text）
    assert.equal(container.querySelectorAll('.ccg-text-only').length, 4, '4 个 text-only（as-1/2/3/4）')
  })

  it('展开步骤折叠栏后工具卡片可见（手动展开覆盖默认折叠）', () => {
    clickHeader()
    // 找到第一个工具步骤折叠栏（"运行了Pwsh"）
    const segHeaders = [...container.querySelectorAll('.ccg-group-root:not([data-ccg-turn]) > .ccg-header')]
    const toolSeg = segHeaders.find(h => h.textContent.includes('运行了Pwsh'))
    assert.ok(toolSeg, '工具步骤折叠栏应存在')
    act(() => { toolSeg.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
    assert.equal(counts().cards, 1, '展开该段后其工具卡片可见')
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

  it('Bug2 回归：委托渲染内置工具卡片时透传 useConnectionGeneration（不再崩溃/abdicate）', () => {
    clickHeader()
    // 展开一个工具段 · 让工具卡片实际挂载
    const segHeaders = [...container.querySelectorAll('.ccg-group-root:not([data-ccg-turn]) > .ccg-header')]
    const toolSeg = segHeaders.find(h => h.textContent.includes('运行了Pwsh'))
    assert.ok(toolSeg)
    act(() => { toolSeg.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
    assert.ok(lastToolCallProps, '展开步骤折叠后应渲染内置工具卡片')
    assert.equal(typeof lastToolCallProps.useConnectionGeneration, 'function', 'useConnectionGeneration 必须注入并透传')
    const cards = container.querySelectorAll('.mock-tool-card')
    assert.equal(cards.length, 1, '只展开了一段 → 1 张工具卡片')
    for (const card of cards) {
      assert.equal(card.dataset.home, 'C:/Users/Test', '内置组件应能通过 useConnectionGeneration 读到 host home')
    }
  })

  it('回合折叠栏文案显示真实会话指标（已结束回合带"已完成"状态前缀）', () => {
    const title = container.querySelector('.ccg-header .ccg-title')
    assert.ok(title)
    // 闭合态：已折叠N步（滚轮数字只滚步数，sr-only 保留完整文案）
    const sr = title.querySelector('.ccg-sr-only')
    assert.ok(sr, '闭合回合折叠栏应有 sr-only 完整文本')
    assert.equal(sr.textContent, '已完成 | 耗时22分34秒 · 首字4.9s · 消耗370202token · 144tok/s · 缓存命中93.99% · 已折叠8步')
    assert.ok(container.querySelector('.ccg-header-round'), '回合折叠栏右侧应有"第x轮"')
    assert.equal(container.querySelector('.ccg-header-round').textContent, '第13轮')
  })
})

describe('运行中的回合：回合折叠栏从回复开始出现 + 实时指标 + 分隔线', () => {
  // 冻结时钟：运行中"消耗token"在真实基线上叠加动画偏移（每 tick +1/+11 交替 · 
  // tick 由随机间隔定时器驱动）。冻结 Date.now 后 liveNow 恒定 · 并把直播 tick 间隔
  // 临时拉到极大（测试期间定时器绝不触发） · 偏移恒为 0 · token 文案保持确定的 450 · 
  // 断言不依赖测试执行耗时。
  const realDateNow = Date.now
  const realLiveTickMs = T.CONFIG.liveTickMs
  let frozenNow = 0
  beforeEach(() => {
    frozenNow = Date.now()
    Date.now = () => frozenNow
    T.CONFIG.liveTickMs = 1e9 // 测试期间直播 tick 不触发
    T.turnOverrides.clear() // 模块级状态 · 避免测试间污染
    T.overrides.clear()
    T.liveTokenCache.clear()
    T.segmentLabelCache.clear()
    T.ttftCache.clear()
    mount(RUNNING)
  })
  afterEach(() => {
    act(() => root.unmount())
    document.body.innerHTML = ''
    T.turnOverrides.clear()
    T.overrides.clear()
    T.liveTokenCache.clear()
    T.segmentLabelCache.clear()
    T.ttftCache.clear()
    T.CONFIG.liveTickMs = realLiveTickMs
    Date.now = realDateNow
  })

  it('回复开始即渲染回合折叠栏：折叠栏 + 分隔线 + 纯 think 段/工具段步骤折叠栏（默认折叠）', () => {
    const c = counts()
    // 回合折叠栏 1 + as-run-1 纯 think 段步骤折叠栏 1 + tc-run 工具段步骤折叠栏 1
    assert.equal(c.headers, 3, '运行中应一个回合折叠栏 + 纯 think 段步骤折叠栏 + 工具段步骤折叠栏')
    assert.ok(container.querySelector('.ccg-turn-divider'), '回合折叠栏与内容之间应有分隔线')
    assert.ok(container.querySelector('.ccg-group-root[data-ccg-turn][data-ccg-open="true"]'), '运行中默认展开')
    // 步骤折叠始终默认收起：工具卡片隐藏
    assert.equal(c.cards, 0, '步骤折叠默认收起 · 工具卡片应隐藏')
    const segHeaders = [...container.querySelectorAll('.ccg-group-root:not([data-ccg-turn]) > .ccg-header')]
    assert.equal(segHeaders.length, 2, '应有 as-run-1 纯 think 段 + tc-run 工具段两个步骤折叠栏')
    // as-run-1 纯 think 段（fixture 含 text 块 → 已闭合）标题"思考了1次"；tc-run 段"运行了Pwsh"
    assert.ok(segHeaders[0].textContent.includes('思考了1次'), '纯 think 段步骤折叠栏标题应为"思考了1次"')
    assert.ok(segHeaders[1].textContent.includes('运行了Pwsh'), '工具段步骤折叠栏标题应为"运行了Pwsh"')
    // as-run-1 段外 text + as-run-2 段外 text（纯 think 段同样段外渲染 text 正文）
    assert.equal(c.assistants, 2, 'as-run-1 段外 text + as-run-2 段外 text')
    assert.equal(c.hidden, 1, 'as-run-2 非 leader 成员隐藏标记')
  })

  it('回合折叠栏文案实时显示耗时/token（token 累计确定 · 耗时随秒表走动）', () => {
    const title = container.querySelector('.ccg-header .ccg-title')
    assert.ok(title)
    // token 累计 = 130 + 260 + 60 = 450、缓存命中 66.67% 为确定值（本 describe 冻结了
    // Date.now · 运行中 token 的动画偏移恒为 0 · 不会把 450 推高）；
    // 耗时 ≈ 5 秒（秒数不确定）、tok/s = 60/耗时 实时估算（秒数不确定）。
    // 滚轮数字是视觉装饰（DOM 含 0-9 数字条） · 完整文案在 sr-only 文本上。
    const sr = title.querySelector('.ccg-sr-only')
    assert.ok(sr, '滚轮文案应有 sr-only 最终文本')
    assert.match(sr.textContent, /^耗时\d+秒 · 首字\d+\.\d+s · 消耗450token · \d+(\.\d+)?tok\/s · 缓存命中66\.67% · 待折叠\d+步$/)
  })

  it('点击回合折叠栏收起：成员隐藏、分隔线常驻；再点展开恢复', () => {
    clickHeader()
    let c = counts()
    assert.equal(c.headers, 1)
    assert.equal(c.cards, 0, '收起后工具调用隐藏')
    assert.equal(c.assistants, 0, '收起后折叠栏内容与 text 正文都隐藏')
    assert.equal(c.hidden, 2, '成员 tc-run / as-run-2 带隐藏标记（as-run-1 渲染回合折叠栏本身）')
    assert.ok(container.querySelector('.ccg-turn-divider'), '收起后分隔线仍常驻显示')
    clickHeader()
    c = counts()
    assert.ok(container.querySelector('.ccg-turn-divider'), '展开后分隔线仍在')
    assert.equal(c.cards, 0, '展开后步骤折叠仍默认收起')
    assert.equal(c.assistants, 2, 'text 正文段外可见')
    assert.equal(c.hidden, 1)
  })

  it('点击步骤折叠栏展开：工具卡片可见；再点收起', () => {
    // 找到 tc-run 步骤折叠栏（标题含"运行了Pwsh"）
    const segHeaders = [...container.querySelectorAll('.ccg-group-root:not([data-ccg-turn]) > .ccg-header')]
    const tcHeader = segHeaders.find(h => h.textContent.includes('运行了Pwsh'))
    assert.ok(tcHeader, 'tc-run 步骤折叠栏应存在')
    assert.equal(counts().cards, 0, '默认折叠 · 工具卡片隐藏')
    // textBody：as-run-1 纯 think 段段外 text + as-run-2 段外 text = 2
    assert.equal(container.querySelectorAll('.ccg-text-only').length, 2, 'as-run-1/2 段外 text 正文')
    act(() => { tcHeader.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
    assert.equal(counts().cards, 1, '展开步骤折叠后工具卡片可见')
    act(() => { tcHeader.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
    assert.equal(counts().cards, 0, '再点收起后工具卡片隐藏')
  })
})

describe('think 步骤折叠：纯 think 段也套步骤折叠栏（标题自研 ThinkSummary）', () => {
  // 冻结时钟 + 拉大 tick 间隔：与 RUNNING describe 相同的确定性手段
  const realDateNow = Date.now
  const realLiveTickMs = T.CONFIG.liveTickMs
  let frozenNow = 0
  beforeEach(() => {
    frozenNow = Date.now()
    Date.now = () => frozenNow
    T.CONFIG.liveTickMs = 1e9
    T.turnOverrides.clear()
    T.overrides.clear()
    T.liveTokenCache.clear()
    T.segmentLabelCache.clear()
    T.ttftCache.clear()
  })
  afterEach(() => {
    act(() => root.unmount())
    document.body.innerHTML = ''
    T.turnOverrides.clear()
    T.overrides.clear()
    T.liveTokenCache.clear()
    T.segmentLabelCache.clear()
    T.ttftCache.clear()
    T.CONFIG.liveTickMs = realLiveTickMs
    Date.now = realDateNow
  })

  it('纯 think 段：套步骤折叠栏 · 运行中标题"正在思考 · 最新一行"', () => {
    const thinkNode = (key, seq, text) => asNode(key, seq, { blocks: [{ kind: 'reasoning', text }] })
    const nodes = [userNode('u', 100), thinkNode('th', 200, '正在分析')]
    mount(buildSnapshot(nodes, { turnEnds: new Map() }))
    // 纯 think 段套步骤折叠栏（运行中标题"正在思考 · 最新一行"，思考全文默认收起）
    const segRoot = container.querySelector('.ccg-group-root:not([data-ccg-turn])')
    assert.ok(segRoot, '纯 think 段套步骤折叠栏')
    const title = segRoot.querySelector('.ccg-header .ccg-title')
    assert.ok(title.textContent.includes('正在思考'), '前缀"正在思考"')
    assert.ok(title.textContent.includes('正在分析'), 'think 内容作为标题摘要')
    // 思考全文默认收起：mock-assistant 不可见（官方 Think 行在步骤折叠栏内，被收起）
    assert.equal(container.querySelectorAll('.mock-assistant').length, 0, '思考全文被步骤折叠栏收起')
  })

  it('纯 think 段流式推进：步骤折叠栏标题跟随最新一行', () => {
    const thinkNode = (key, seq, text) => asNode(key, seq, { blocks: [{ kind: 'reasoning', text }] })
    const nodes = [userNode('u', 100), thinkNode('th', 200, '正在分析')]
    const { store } = mount(buildSnapshot(nodes, { turnEnds: new Map() }))
    const segRoot = container.querySelector('.ccg-group-root:not([data-ccg-turn])')
    assert.ok(segRoot, '步骤折叠栏存在')
    // 模拟流式 chunk：think 文本增长
    act(() => {
      store.setSnapshot(buildSnapshot([
        userNode('u', 100),
        thinkNode('th', 200, '正在分析\n正在深入思考仓库结构'),
      ], { turnEnds: new Map() }))
    })
    // 步骤折叠栏标题跟随最新一行
    const title = segRoot.querySelector('.ccg-header .ccg-title')
    assert.ok(title.textContent.includes('正在深入思考仓库结构'), '标题跟随最新一行（自研滚动效果）')
  })

  it('纯 think 段 + text 节点：步骤折叠栏 + 段外 text 正文可见', () => {
    const thinkNode = (key, seq, text) => asNode(key, seq, { blocks: [{ kind: 'reasoning', text }] })
    const textNode = (k, s, t) => makeNode(k, 'assistant-step', s, { data: { blocks: [{ kind: 'text', text: t || 'text' }] } })
    // 注：mount 的 root.render 基于初始快照静态创建（setSnapshot 只重渲染已挂载组件，
    // 无法挂载新加入的节点），因此闭合边界 text 必须放进初始快照。
    const nodes = [userNode('u', 100), thinkNode('th', 200, '正在分析'), textNode('msg', 300, '结果如下')]
    mount(buildSnapshot(nodes, { turnEnds: new Map() }))
    // th 段闭合（msg 出现）→ 标题"思考了1次"
    const segHeaders = [...container.querySelectorAll('.ccg-group-root:not([data-ccg-turn]) > .ccg-header .ccg-title')]
    const thTitle = segHeaders.find(t => t.textContent.includes('思考了'))
    assert.ok(thTitle, 'text 出现后步骤折叠栏标题"思考了1次"')
    assert.ok(thTitle.textContent.includes('思考了1次'), '标题"思考了1次"')
    // text 节点（纯 text，非 think）作为中间成员，回合折叠栏展开时可见
    const msgEl = container.querySelector('[data-node="msg"]')
    assert.ok(msgEl, 'text 节点可见')
  })

  it('think+text 节点（纯 think 段）：步骤折叠栏 + 段外 text 正文', () => {
    const thinkTextNode = (key, seq, think, text) => asNode(key, seq, {
      blocks: [{ kind: 'reasoning', text: think }, { kind: 'text', text }],
    })
    const nodes = [userNode('u', 100), thinkTextNode('msg', 200, '第一行思考\n完整思考内容', '这是正文')]
    mount(buildSnapshot(nodes, { turnEnds: new Map() }))
    // 纯 think 段（无工具）→ 步骤折叠栏 + 段外 text 正文
    const segRoot = container.querySelector('.ccg-group-root:not([data-ccg-turn])')
    assert.ok(segRoot, '纯 think+text 段有步骤折叠栏')
    // 段外 text 正文（ccg-text-only）
    const textOnly = container.querySelectorAll('.ccg-text-only')
    assert.equal(textOnly.length, 1, '段外 text 正文')
    // 段内 thinkOnly 被步骤折叠栏收起（不挂载），段外 text 1 份
    const assistants = container.querySelectorAll('.mock-assistant')
    assert.equal(assistants.length, 1, '段外 text 正文 1 份')
  })

  it('混合段（think + 工具）：步骤折叠栏标题使用自研 ThinkSummary（带 data-follow-end）', () => {
    const thinkNode = (key, seq, text) => asNode(key, seq, { blocks: [{ kind: 'reasoning', text }] })
    const textNode = (k, s, t) => makeNode(k, 'assistant-step', s, { data: { blocks: [{ kind: 'text', text: t || 'text' }] } })
    const toolWithArgs = (key, seq, { running = false, name = 'Pwsh', argsRaw } = {}) =>
      makeNode(key, 'tool-call', seq, { data: { root: running ? { callId: key, name, argsRaw } : { kind: 'tool-result', callId: key, name, argsRaw, isError: false } } })
    const nodes = [
      userNode('u', 100),
      textNode('as', 200), // 纯 text 边界（无 reasoning）
      toolWithArgs('tc', 300, { running: false, argsRaw: '{}' }),
      thinkNode('th', 310, '第一行分析\n正在验证结果'),
    ]
    const { store } = mount(buildSnapshot(nodes, { turnEnds: new Map() }))
    // 混合段有步骤折叠栏：最后节点是 think → 标题显示"正在思考 · 最新一行"
    const segTitle = () => {
      const segHeaders = [...container.querySelectorAll('.ccg-group-root:not([data-ccg-turn]) > .ccg-header .ccg-title')]
      return segHeaders.find(t => t.textContent.includes('正在思考'))
    }
    assert.ok(segTitle(), '混合段应有步骤折叠栏')
    assert.ok(segTitle().textContent.includes('正在思考'), '前缀"正在思考"')
    assert.ok(segTitle().textContent.includes('正在验证结果'), '最后一行作为标题摘要')
    // think 摘要元素（自研 ThinkSummary）
    const summary = container.querySelector('.ccg-think-summary')
    assert.ok(summary, 'think 摘要元素应存在')
    assert.equal(summary.dataset.followEnd, 'true', '运行中带 data-follow-end')
    // 流式更新：think 文本增长 · 标题跟随最新一行
    act(() => {
      store.setSnapshot(buildSnapshot([
        userNode('u', 100),
        textNode('as', 200),
        toolWithArgs('tc', 300, { running: false, argsRaw: '{}' }),
        thinkNode('th', 310, '第一行分析\n正在验证结果\n发现新问题'),
      ], { turnEnds: new Map() }))
    })
    assert.ok(segTitle().textContent.includes('发现新问题'), '标题跟随最新一行（自研滚动效果）')
  })
})

describe('滚轮数字（RollDigit / AnimatedLabel / 回合折叠栏 live 文案）', () => {
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

  it('RollDigit：每位数一个视窗 · 内部竖排 0-9 · 按 data-digit 定位（jsdom 无 WAAPI → 静态 transform）', () => {
    mountNode(React.createElement(T.RollDigit, { digit: 5 }))
    const cell = rcontainer.querySelector('.ccg-roll-cell')
    assert.ok(cell, '应有滚轮视窗')
    assert.equal(cell.dataset.digit, '5')
    const strip = cell.querySelector('.ccg-roll-strip')
    assert.ok(strip)
    assert.equal(strip.children.length, 10, '数字条应含 0-9')
    assert.equal(strip.children[9].textContent, '9')
    // translateY(-k*10%)：strip 高 10em · 10% = 1em = 一个数位
    assert.equal(strip.style.transform, 'translateY(-50%)')
  })

  it('RollDigit：数值变化后 transform 更新（滚动到新数位）', () => {
    mountNode(React.createElement(T.RollDigit, { digit: 5 }))
    rerender(React.createElement(T.RollDigit, { digit: 7 }))
    const strip = rcontainer.querySelector('.ccg-roll-strip')
    assert.equal(strip.style.transform, 'translateY(-70%)')
  })

  it('AnimatedLabel：数字拆成逐位滚轮、文字原样 · sr-only 保留完整最终文案', () => {
    mountNode(React.createElement(T.AnimatedLabel, { label: '耗时5秒 · 消耗450token · 12tok/s · 缓存命中66.67%' }))
    const cells = rcontainer.querySelectorAll('.ccg-roll-cell')
    // 数字 5 / 4 5 0 / 1 2 / 6 6 6 7 = 10 个数位（66.67 的小数点是文字 · 不拆滚轮）
    assert.equal(cells.length, 10)
    assert.deepEqual([...cells].map((c) => c.dataset.digit), ['5', '4', '5', '0', '1', '2', '6', '6', '6', '7'])
    const sr = rcontainer.querySelector('.ccg-sr-only')
    assert.ok(sr, '应有 sr-only 完整文案')
    assert.equal(sr.textContent, '耗时5秒 · 消耗450token · 12tok/s · 缓存命中66.67%')
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
    const h = (live) => React.createElement(T.GroupHeader, { count: 0, open: true, onToggle: () => {}, label: '耗时5秒 · 消耗450token', isTurn: true, live })
    mountNode(h(true))
    assert.equal(rcontainer.querySelectorAll('.ccg-roll-cell').length, 4)
    rerender(h(false))
    assert.equal(rcontainer.querySelectorAll('.ccg-roll-cell').length, 0, '非直播回退纯文本')
    assert.equal(rcontainer.querySelector('.ccg-title').textContent, '耗时5秒 · 消耗450token')
  })
})

describe('注册契约（Bug2 根因回归）', () => {
  it('所有 chat.node 条目都声明了 connectionGeneration inject', () => {
    const chatNodeEntries = slotRegistrations.filter((e) => e.options.name === 'conversation.chat.node')
    assert.equal(chatNodeEntries.length, 3, '应有 3 个 chat.node 插件条目（tool-call + assistant-step + context；user 格已让位退出）')
    for (const entry of chatNodeEntries) {
      const opts = entry.options
      assert.equal(typeof opts.inject, 'function', `条目 ${opts.key} 必须声明 inject`)
      const injectFace = opts.inject()
      const hookNames = Object.keys(injectFace.hooks)
      assert.ok(hookNames.includes('connectionGeneration'), `条目 ${opts.key} 的 inject 必须包含 connectionGeneration`)
    }
  })
  it('user 格不再注册（让位 user 消息专用插件）· dock 占位条按 id 共存注册', () => {
    assert.equal(
      slotRegistrations.some((e) => e.options.name === 'conversation.chat.node' && e.options.key === 'user'),
      false,
      '不得再注册 conversation.chat.node 的 user key（0 秒占位已迁往输入区 dock）',
    )
    const dock = slotRegistrations.find((e) => e.options.name === 'conversation.input.dock')
    assert.ok(dock, '应注册 conversation.input.dock 占位条（list slot，按 id 共存）')
    assert.equal(dock.options.id, 'turn-fold-running')
    assert.equal(dock.options.order, 10)
    assert.equal(dock.component, T.RunningTurnDock)
  })
})

// ── 回合折叠栏 0 秒占位（输入区 dock 条目 RunningTurnDock） ──
describe('回合折叠栏 0 秒占位（RunningTurnDock · conversation.input.dock）', () => {
  beforeEach(() => {
    T.liveTokenCache.clear()
    T.segmentLabelCache.clear()
    T.ttftCache.clear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    if (root) { root.unmount(); root = null; container.remove(); container = null }
  })
  function mountDock(snapshot, sessionId = 'sess-u') {
    const store = createSessionStore(snapshot)
    const useSession = makeUseSession(store)
    act(() => {
      root.render(React.createElement(T.RunningTurnDock, { useSession, sessionId, ...injectedHooks }))
    })
    return { store }
  }
  it('运行中 + user 是最后一条消息：dock 渲染占位回合折叠栏（耗时计时 + 回合号）', () => {
    const nodes = [userNode('u', 100)]
    const snapshot = buildSnapshot(nodes, {
      turnTimings: new Map([[13, { startTime: 1000000, endTime: undefined }]]),
    })
    snapshot.running = true
    mountDock(snapshot)
    const placeholder = container.querySelector('.ccg-dock-run .ccg-group-root[data-ccg-turn]')
    assert.ok(placeholder, '占位回合折叠栏存在')
    assert.ok(placeholder.textContent.includes('耗时'), '占位显示耗时')
    assert.ok(placeholder.textContent.includes('第13轮'), '右对齐显示运行中回合号（turnTimings）')
    // dock 条目独立渲染占位栏：不再委托内置 user 消息（user 格已让位）
    assert.equal(container.querySelector('.mock-user'), null, 'dock 内不渲染 user 消息本体')
  })
  it('会话未运行：不渲染占位', () => {
    const nodes = [userNode('u', 100)]
    const snapshot = buildSnapshot(nodes)
    snapshot.running = false
    mountDock(snapshot)
    assert.equal(container.querySelector('.ccg-dock-run'), null, '无占位')
  })
  it('user 之后有中间节点：不渲染占位（转交正式回合折叠栏）', () => {
    const nodes = [userNode('u', 100), asNode('as', 200), toolNode('tc', 300)]
    const snapshot = buildSnapshot(nodes)
    snapshot.running = true
    mountDock(snapshot)
    assert.equal(container.querySelector('.ccg-dock-run'), null, '无占位')
  })
  it('steering 是最后一条消息：不渲染占位（与旧 user 格占位行为一致）', () => {
    const nodes = [userNode('u', 100), makeNode('st', 'steering', 150, { data: {} })]
    const snapshot = buildSnapshot(nodes)
    snapshot.running = true
    mountDock(snapshot)
    assert.equal(container.querySelector('.ccg-dock-run'), null, '无占位')
  })
  it('foldMode=auto：不渲染占位（插件不接管折叠）', () => {
    const nodes = [userNode('u', 100)]
    const snapshot = buildSnapshot(nodes, {
      turnTimings: new Map([[13, { startTime: 1000000, endTime: undefined }]]),
    })
    snapshot.running = true
    T.setFoldMode('auto')
    mountDock(snapshot)
    assert.equal(container.querySelector('.ccg-dock-run'), null, 'auto 模式无占位')
    T.setFoldMode('turn-fold')
  })
})

// ── 排除工具（todo_write）：不套步骤折叠栏，只参与回合折叠 ──
describe('排除工具（todo_write）：不套步骤折叠栏，只参与回合折叠', () => {
  beforeEach(() => {
    T.turnOverrides.clear()
    T.overrides.clear()
    T.liveTokenCache.clear()
    T.segmentLabelCache.clear()
    T.ttftCache.clear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    document.body.innerHTML = ''
    T.turnOverrides.clear()
    T.overrides.clear()
    T.liveTokenCache.clear()
    T.segmentLabelCache.clear()
    T.ttftCache.clear()
  })
  const todoNode = (key, seq) => makeNode(key, 'tool-call', seq, {
    data: { root: { kind: 'tool-result', callId: key, name: 'todo_write', isError: false } },
  })
  const textNode = (k, s, t) => makeNode(k, 'assistant-step', s, { data: { blocks: [{ kind: 'text', text: t || '' }] } })
  function mountAll(snapshot, sessionId = 'sess') {
    const store = createSessionStore(snapshot)
    const useSession = makeUseSession(store)
    const propsFor = (node) => ({ node, useSession, sessionId, ...injectedHooks })
    act(() => {
      root.render(React.createElement('div', null,
        snapshot.chat.order
          .filter((k) => { const n = snapshot.chat.nodes.get(k); return n.kind !== 'user' && n.kind !== 'turn-tail' })
          .map((k) => {
            const node = snapshot.chat.nodes.get(k)
            const Comp = node.kind === 'tool-call' ? T.GroupedToolCallView : T.GroupedContextView
            return React.createElement(Comp, { key: k, ...propsFor(node) })
          }),
      ))
    })
    return { store, useSession }
  }

  it('排除工具在中间（非 headerKey）：官方工具卡片直接渲染，不套步骤折叠栏', () => {
    const nodes = [
      userNode('u', 100),
      textNode('as', 200, 'text'),
      toolNode('tc1', 300),
      todoNode('todo', 400),
      toolNode('tc2', 500),
      textNode('as2', 600, 'text'),
    ]
    const snapshot = buildSnapshot(nodes, { turnEnds: new Map() })
    mountAll(snapshot)
    // 回合折叠栏展开（运行中默认展开）
    assert.ok(container.querySelector('.ccg-group-root[data-ccg-turn]'), '回合折叠栏存在')
    // 排除工具无步骤折叠栏：查询 todo 的 data-call
    const todoCard = container.querySelector('[data-call="todo"]')
    assert.ok(todoCard, 'todo_write 官方工具卡片渲染')
    // todo_write 不应是任何步骤折叠栏的 leader
    const segHeaders = container.querySelectorAll('.ccg-group-root:not([data-ccg-turn]) > .ccg-header')
    for (const h of segHeaders) {
      assert.equal(h.textContent.includes('todo_write'), false, '步骤折叠栏不应包含 todo_write')
    }
    // tc1/tc2 各自有步骤折叠栏
    assert.equal(segHeaders.length, 2, 'tc1/tc2 各一个步骤折叠栏')
    // 回合折叠栏收起后 todo_write 隐藏
    const turnHeader = container.querySelector('.ccg-group-root[data-ccg-turn] > .ccg-header')
    assert.ok(turnHeader, '回合折叠栏头')
    act(() => { turnHeader.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
    assert.equal(container.querySelector('[data-call="todo"]'), null, '收起后 todo_write 隐藏')
  })

  it('排除工具是回合第一条中间节点（isTurnHeader）：渲染回合折叠栏 + 官方工具卡片，无步骤折叠栏', () => {
    const nodes = [
      userNode('u', 100),
      todoNode('todo', 200),
      textNode('as', 300, 'text'),
    ]
    const snapshot = buildSnapshot(nodes, { turnEnds: new Map() })
    mountAll(snapshot)
    // 回合折叠栏存在（todo_write 是 headerKey）
    const turnRoot = container.querySelector('.ccg-group-root[data-ccg-turn]')
    assert.ok(turnRoot, '回合折叠栏存在（由 todo_write 渲染）')
    // 无步骤折叠栏
    assert.equal(container.querySelectorAll('.ccg-group-root:not([data-ccg-turn])').length, 0, '无步骤折叠栏')
    // 官方工具卡片在回合折叠栏 FoldClip 内
    const todoCard = container.querySelector('[data-call="todo"]')
    assert.ok(todoCard, 'todo_write 官方工具卡片渲染')
    // 回合折叠栏收起后 todo_write 隐藏
    const turnHeader = turnRoot.querySelector('.ccg-header')
    assert.ok(turnHeader)
    act(() => { turnHeader.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
    assert.equal(container.querySelector('[data-call="todo"]'), null, '收起后 todo_write 隐藏')
  })
})

// ── 语言动态切换（跟随 DSH 的 document.documentElement.lang） ──
describe('语言动态切换', () => {
  it('turnHeaderLabel 随 document.documentElement.lang 在中文/英文间切换', () => {
    document.documentElement.lang = 'en-US'
    assert.equal(T.turnHeaderLabel(TURN13_METRICS), '22m 34s · TTFT 4.9s · 370202 tokens · 144 tok/s · cache hit 93.99%')
    document.documentElement.lang = 'zh-CN'
    assert.equal(T.turnHeaderLabel(TURN13_METRICS), '耗时22分34秒 · 首字4.9s · 消耗370202token · 144tok/s · 缓存命中93.99%')
    // 恢复（避免污染后续测试；无 lang 时回退 navigator zh-CN）
    document.documentElement.lang = ''
  })
})