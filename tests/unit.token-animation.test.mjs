// 运行中 token 视觉增长（presentation-only）测试。
//
// 架构边界（本轮核心）：
//   canonicalTokens —— 官方真实数据（computeTurnMetrics / usage / turn-tail），唯一权威值，
//                      参与 tok/s / 缓存 / TTFT / durable projection。
//   displayTokens   —— 仅 Running Turn UI 使用的展示值，两阶段：
//                      有 canonical → canonical + 小的、有上限的视觉偏移；
//                      无 canonical → bootstrap 计数（第 1 帧 1，之后 +1/+1/+10，封顶 500），
//                      仅当 **running 的 assistant-step 已出现可见 text/reasoning** 时启动。
//                      不持久化、不进 projection、不进任何统计、settle 后必然归零。
// 本文件锁死：canonical 纯度、bootstrap 边界与封顶、官方可见语义判定、
// 校准/暂停/settle 归零、reduced-motion 立即归零，以及
// **没有活动动画时 ticker 彻底停表**（100 个历史 Turn = 0 listener + 0 timer）。
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { loadPlugin } from './helpers/loader.mjs'
import {
  T0, T1, OFFICIAL_TOKEN_USAGE,
  makeTurnNode, makeTurnProcessOwner, makeUseTurnData, makeStepsSource, makeUseChat,
  makeStep, makeStepData, makeRunningStepData,
} from './helpers/fixtures.mjs'

const require = createRequire(import.meta.url)
import dom, { sharedWindow, sharedDocument } from './helpers/dom.mjs'

const { test: T } = loadPlugin({ window: sharedWindow })
const react = require('react')

let container = null
let root = null
function mount() {
  container = sharedDocument.createElement('div')
  sharedDocument.body.appendChild(container)
  root = createRoot(container)
}
beforeEach(() => { mount() })
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  container = null
  root = null
})

/** 直接驱动 useDisplayTokenAnimation（只测展示层，不经完整栏）。
 *  第 4 参 fieldEnabled：undefined/true = Token 字段开启；false = 用户关闭。 */
function Probe(props) {
  const value = T.useDisplayTokenAnimation(props.running, props.canonical, props.visible, props.fieldEnabled)
  return react.createElement('span', { 'data-probe': 'tokens' }, value === undefined ? 'undefined' : String(value))
}
function renderProbe(props) {
  act(() => { root.render(react.createElement(Probe, Object.assign({ fieldEnabled: true }, props))) })
  return container.querySelector('[data-probe="tokens"]').textContent
}
/** 推进 n 个视觉 tick（确定性；不用真实 sleep）。 */
function tick(n) {
  act(() => { for (let i = 0; i < n; i += 1) T.notifyVisualTokenTick() })
}
const listenerCount = () => T.getVisualTokenListenerCount()
const timerRunning = () => T.isVisualTokenTimerRunning()

/** 从滚动数字条重建视觉文案（跳过 sr-only，用 data-digit 还原数字）。 */
function readVisualLabel(rootEl) {
  const labelRoot = rootEl.querySelector('.ccg-roll-label')
  if (!labelRoot) return rootEl.querySelector('.ccg-turn-bar-label').textContent
  let out = ''
  for (const child of labelRoot.children) {
    if (child.classList.contains('ccg-sr-only')) continue
    if (child.classList.contains('ccg-roll-num')) {
      for (const piece of child.children) {
        if (piece.classList.contains('ccg-roll-cell')) out += piece.getAttribute('data-digit')
        else out += piece.textContent
      }
    } else out += child.textContent
  }
  return out
}
const readSrLabel = (rootEl) => rootEl.querySelector('.ccg-sr-only').textContent
/** 视觉文案里的 token 数值（读不到数字 → null）。 */
function visualTokenCount(rootEl) {
  const m = /([\d,]+)\s*token/.exec(readVisualLabel(rootEl))
  return m ? Number(m[1].replace(/,/g, '')) : null
}

/** 可切换的 reduced-motion 媒体查询 mock（带 change 订阅，验证响应式归零）。 */
function makeReducedMotionMock(initial) {
  const state = { matches: initial === true, listeners: new Set() }
  const mql = {
    get matches() { return state.matches },
    addEventListener(type, fn) { if (type === 'change') state.listeners.add(fn) },
    removeEventListener(type, fn) { if (type === 'change') state.listeners.delete(fn) },
  }
  return {
    mql,
    /** 切换运行时的 reduced-motion 并派发 change（组件应重渲染 → 立即归 canonical）。 */
    set(value) {
      state.matches = value === true
      act(() => { for (const fn of [...state.listeners]) fn({ matches: state.matches }) })
    },
    subscriptions: () => state.listeners.size,
  }
}
function withMatchMedia(mock, fn) {
  const original = sharedWindow.matchMedia
  sharedWindow.matchMedia = mock
  try { fn() } finally {
    if (original === undefined) delete sharedWindow.matchMedia
    else sharedWindow.matchMedia = original
  }
}
const REASONING = (text) => ({ kind: 'reasoning', text })

// ══════════════════════════════════════════════════════════════════════
// A. canonical 纯度：真实数据层不含任何展示值
// ══════════════════════════════════════════════════════════════════════
describe('token 视觉增长 A：canonical 纯度（computeTurnMetrics 零污染）', () => {
  const clock = { number: 13, startMs: T0, endMs: T1, status: 'closed', reason: 'completed', data: null, steps: [] }
  const steps = [
    makeStepData(1, { usage: { inputTokens: 1000, outputTokens: 3214, cacheReadTokens: 2000 }, timing: { stepStartTime: T0, firstTokenTime: T0 + 800, completedTime: T0 + 13000 } }),
    makeStepData(2, { usage: { inputTokens: 500, outputTokens: 700, cacheReadTokens: 1000 }, timing: { stepStartTime: T0 + 20000, firstTokenTime: T0 + 20800, completedTime: T0 + 30000 } }),
  ]

  it('同一输入连续调用 100 次：tokens / tok-s / cache hit / ttft 逐次完全一致', () => {
    const first = T.computeTurnMetrics(clock, steps, { tokenUsage: OFFICIAL_TOKEN_USAGE }, undefined, undefined, 'sess')
    for (let i = 0; i < 100; i += 1) {
      const again = T.computeTurnMetrics(clock, steps, { tokenUsage: OFFICIAL_TOKEN_USAGE }, undefined, undefined, 'sess')
      assert.equal(again.tokens, first.tokens, '第 ' + i + ' 次 tokens 必须一致')
      assert.equal(again.tokensPerSecond, first.tokensPerSecond, '第 ' + i + ' 次 tok/s 必须一致')
      assert.equal(again.cacheHitPercent, first.cacheHitPercent, '第 ' + i + ' 次 cache hit 必须一致')
      assert.equal(again.ttftMs, first.ttftMs, '第 ' + i + ' 次 ttft 必须一致')
      assert.equal(again.durationMs, first.durationMs, '第 ' + i + ' 次 duration 必须一致')
    }
  })

  it('视觉 tick 推进（最多 200 次）不影响任何 canonical 值', () => {
    const before = T.computeTurnMetrics(clock, steps, { tokenUsage: OFFICIAL_TOKEN_USAGE }, undefined, undefined, 'sess')
    tick(200)
    const after = T.computeTurnMetrics(clock, steps, { tokenUsage: OFFICIAL_TOKEN_USAGE }, undefined, undefined, 'sess')
    assert.deepEqual(after, before, 'tick 不得改动 canonical 指标')
  })

  it('无 usage 时 canonical.tokens 恒为 undefined——bootstrap 绝不回写真实数据', () => {
    const running = makeRunningStepData(1, { time: T0 + 100, blocks: [REASONING('正在分析请求')] })
    const openClock = { number: 13, startMs: T0, endMs: undefined, status: 'open', reason: undefined, data: null, steps: [] }
    const metrics = T.computeTurnMetrics(openClock, [running], undefined, T0 + 5000, undefined, 'sess')
    assert.equal(metrics.tokens, undefined, 'running 阶段官方 usage 未到 → tokens 仍是 undefined')
    assert.equal(metrics.tokensPerSecond, undefined, 'tok/s 必须保持 undefined（不得由展示值推出）')
    assert.equal(metrics.cacheHitPercent, undefined, 'cache hit 必须保持 undefined')
  })

  it('withDisplayTokens 只覆盖 tokens 槽位，且不修改原始对象（零副作用）', () => {
    const filtered = { durationMs: 18000, ttftMs: 2500, tokens: undefined, tokensPerSecond: undefined, cacheHitPercent: undefined }
    const out = T.withDisplayTokens(filtered, true, 37)
    assert.equal(out.tokens, 37, '展示值进入副本')
    assert.equal(filtered.tokens, undefined, '原对象不得被修改（metrics 仍无 token）')
    assert.equal(out.durationMs, 18000, '耗时保持 canonical')
    assert.equal(out.ttftMs, 2500, '首字保持 canonical')
    assert.equal(out.tokensPerSecond, undefined, 'tok/s 不得因展示值出现')
    assert.equal(out.cacheHitPercent, undefined, '缓存命中不得因展示值出现')
  })

  it('withDisplayTokens 区分「字段关闭」与「值未到」', () => {
    // 用户关闭 Token 字段：槽位不存在 → 展示值绝不把字段加回来
    const off = { durationMs: 18000, ttftMs: 2500 }
    assert.equal(T.withDisplayTokens(off, true, 37), off, '字段关闭：原样返回')
    assert.ok(!Object.prototype.hasOwnProperty.call(T.withDisplayTokens(off, true, 37), 'tokens'))
    // 字段开启但真实值未到：槽位存在（undefined）→ 允许展示值填充
    const on = { durationMs: 18000, tokens: undefined }
    assert.equal(T.withDisplayTokens(on, true, 37).tokens, 37, '字段开启：展示值填充')
    // 非运行中 / 无展示值：一律不动
    assert.equal(T.withDisplayTokens(on, false, 37), on)
    assert.equal(T.withDisplayTokens(on, true, undefined), on)
  })

  it('视觉值不进入任何持久化面：settings / projection 源都读不到', () => {
    const src = require('node:fs').readFileSync(new URL('../client.js', import.meta.url), 'utf8')
    const saveBlock = src.slice(src.indexOf('function saveSettings'), src.indexOf('// -- 字段显隐 --'))
    assert.ok(!/visualToken|displayTokens|bootstrap/i.test(saveBlock), 'settings 持久化不得涉及视觉值')
    const indexSrc = require('node:fs').readFileSync(new URL('../index.js', import.meta.url), 'utf8')
    assert.ok(!/visualToken|displayTokens|bootstrap/i.test(indexSrc), '宿主 projection 不得涉及视觉值')
  })

  it('组件只在 UI 槽位使用展示值：sr-only 仍取 canonical', () => {
    const src = require('node:fs').readFileSync(new URL('../client.js', import.meta.url), 'utf8')
    assert.ok(src.includes('var canonicalLabel = turnHeaderLabel(filtered)'), 'sr-only 必须由 canonical filtered 生成')
    assert.ok(src.includes('srLabel: canonicalLabel'), 'srLabel 必须传 canonicalLabel')
    assert.ok(src.includes('var label = turnHeaderLabel(withDisplayTokens(filtered, running, displayTokens))'), '视觉文案才用展示值')
  })
})

// ══════════════════════════════════════════════════════════════════════
// B. bootstrap：无 canonical 也允许启动（presentation-only）
// ══════════════════════════════════════════════════════════════════════
describe('token 视觉增长 B：无 canonical 的 bootstrap', () => {
  it('bootstrap 值序列：第 1 帧 1，之后 +1/+1/+10（与截图场景一致）', () => {
    assert.equal(T.visualTokenBootstrapCap, 500)
    assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 12].map((n) => T.visualTokenBootstrapValue(n)), [1, 2, 3, 13, 14, 15, 25, 49])
  })
  it('bootstrap 封顶 500（真实 usage 迟迟不来也不无限增长）', () => {
    assert.equal(T.visualTokenBootstrapValue(1000), 500)
    assert.equal(T.visualTokenBootstrapValue(100000), 500)
  })
  it('running + 可见输出 + 无 canonical → 第一帧就是 1（不等 200ms），随后持续增长', () => {
    assert.equal(renderProbe({ running: true, canonical: undefined, visible: true }), '1')
    assert.equal(listenerCount(), 1, '启动即订阅 ticker')
    assert.equal(timerRunning(), true, '首个订阅者起表')
    assert.deepEqual(
      [1, 1, 1, 1].map((n) => { tick(n); return renderProbe({ running: true, canonical: undefined, visible: true }) }),
      ['2', '3', '13', '14'],
      '节奏 = +1/+1/+10',
    )
  })
  it('running 但还没有可见输出 → 保持 undefined，且不订阅（推进 100 tick 也不动）', () => {
    assert.equal(renderProbe({ running: true, canonical: undefined, visible: false }), 'undefined')
    assert.equal(listenerCount(), 0, '无可见输出不得订阅')
    assert.equal(timerRunning(), false, 'timer 必须为 null')
    tick(100)
    assert.equal(renderProbe({ running: true, canonical: undefined, visible: false }), 'undefined')
    assert.equal(listenerCount(), 0)
    assert.equal(timerRunning(), false)
  })
  it('同一 step 出现首个可见 block → 立即启动（同实例，无 mount 抖动）', () => {
    renderProbe({ running: true, canonical: undefined, visible: false })
    assert.equal(listenerCount(), 0)
    assert.equal(renderProbe({ running: true, canonical: undefined, visible: true }), '1', '出现可见内容即从 1 起')
    assert.equal(listenerCount(), 1)
    assert.equal(timerRunning(), true)
  })
  it('新挂载的栏不得把此前累计的 tick 一次性算成增长（回归：tick 锚定）', () => {
    tick(300) // 全局 tick 已经很大
    assert.equal(renderProbe({ running: true, canonical: undefined, visible: true }), '1')
    tick(1)
    assert.equal(renderProbe({ running: true, canonical: undefined, visible: true }), '2', '从挂载点起算，不跳 cap')
  })
  it('工具阶段（可见生成结束、canonical 仍未到）→ 冻结 provisional 值 + 退订；恢复后继续', () => {
    renderProbe({ running: true, canonical: undefined, visible: true })
    tick(6)
    const frozen = renderProbe({ running: true, canonical: undefined, visible: true })
    assert.equal(frozen, '25', '1 + 24')
    // 工具执行：该 step 已 settle → visible=false
    assert.equal(renderProbe({ running: true, canonical: undefined, visible: false }), frozen, '不得退回 — token')
    assert.equal(listenerCount(), 0, '工具阶段必须退订')
    assert.equal(timerRunning(), false, '没有订阅者 → timer 彻底停止')
    tick(100)
    assert.equal(renderProbe({ running: true, canonical: undefined, visible: false }), frozen, '冻结期间不增长')
    // 下一个 assistant-step 出现可见输出 → 从冻结值继续
    assert.equal(renderProbe({ running: true, canonical: undefined, visible: true }), frozen)
    tick(1)
    assert.equal(renderProbe({ running: true, canonical: undefined, visible: true }), '26', '恢复增长')
  })
  it('canonical 首次到达 → 立即校准（offset 归零），下一 tick 从真实值继续', () => {
    renderProbe({ running: true, canonical: undefined, visible: true })
    tick(19) // provisional 已到 1 + 73 = 74
    assert.equal(renderProbe({ running: true, canonical: undefined, visible: true }), '74')
    assert.equal(renderProbe({ running: true, canonical: 6214, visible: true }), '6214', 'display 立即等于官方真实值')
    tick(1)
    assert.equal(renderProbe({ running: true, canonical: 6214, visible: true }), '6215', '不是 6214 + 73')
    tick(2)
    assert.equal(renderProbe({ running: true, canonical: 6214, visible: true }), '6226', '从新基线按 +1/+1/+10 增长')
  })
  it('settle：bootstrap 全部清零（历史会话 / F5 绝不留假值）', () => {
    renderProbe({ running: true, canonical: undefined, visible: true })
    tick(5)
    assert.notEqual(renderProbe({ running: true, canonical: undefined, visible: true }), 'undefined')
    assert.equal(renderProbe({ running: false, canonical: undefined, visible: true }), 'undefined', 'settle 且无真实值 → —')
    assert.equal(listenerCount(), 0)
    assert.equal(timerRunning(), false)
    tick(20)
    assert.equal(renderProbe({ running: false, canonical: undefined, visible: true }), 'undefined')
  })
  it('Token 字段关闭 → 不订阅、不产生任何视觉值', () => {
    assert.equal(renderProbe({ running: true, canonical: 1000, visible: true, fieldEnabled: false }), '1000', '有真实值就显示真实值')
    assert.equal(listenerCount(), 0, '字段关闭不得订阅 ticker')
    assert.equal(timerRunning(), false)
    assert.equal(renderProbe({ running: true, canonical: undefined, visible: true, fieldEnabled: false }), 'undefined', '无真实值保持 —')
    tick(50)
    assert.equal(listenerCount(), 0)
    assert.equal(timerRunning(), false)
  })
})

// ══════════════════════════════════════════════════════════════════════
// C. 可见生成判定：官方 assistant-step 语义（不看历史 step 的旧文本）
// ══════════════════════════════════════════════════════════════════════
describe('token 视觉增长 C：assistant 可见输出判定', () => {
  it('assistantBlockVisible：与官方 blockIsVisible 等价', () => {
    assert.equal(T.assistantBlockVisible(undefined), false)
    assert.equal(T.assistantBlockVisible(null), false)
    assert.equal(T.assistantBlockVisible({ kind: 'tool-call', callId: 'c', name: 'read', argsRaw: '{}' }), false, 'tool-call 不算可见')
    assert.equal(T.assistantBlockVisible({ kind: 'text', text: '' }), false)
    assert.equal(T.assistantBlockVisible({ kind: 'text', text: '   \n\t ' }), false, '空白不算可见')
    assert.equal(T.assistantBlockVisible({ kind: 'text', text: 'For the leg' }), true)
    assert.equal(T.assistantBlockVisible({ kind: 'reasoning', text: '' }), false)
    assert.equal(T.assistantBlockVisible({ kind: 'reasoning', text: '正在分析请求' }), true)
    assert.equal(T.assistantBlockVisible({ kind: 'image', attachment: {} }), true, '其它非 tool-call block 视为可见')
    assert.equal(T.assistantBlockVisible({ kind: 'other', block: {} }), true)
  })
  it('只看 running step：历史 settled step 的旧文本不得启动', () => {
    const settledWithText = Object.assign(makeStepData(1, {}), { blocks: [REASONING('旧的分析文字')] })
    assert.equal(T.assistantVisibleGenerationActive([settledWithText]), false, 'settled step 的文本不算')
    assert.equal(T.assistantVisibleGenerationActive([settledWithText, makeRunningStepData(2, { blocks: [] })]), false, 'running step 还没有可见输出')
    assert.equal(T.assistantVisibleGenerationActive([settledWithText, makeRunningStepData(2, { blocks: [REASONING('新输出')] })]), true)
    assert.equal(T.assistantVisibleGenerationActive([settledWithText, makeRunningStepData(2, { blocks: [{ kind: 'tool-call', callId: 'c', name: 'read', argsRaw: '{}' }] })]), false, '只有 tool-call → 不算可见生成')
    assert.equal(T.assistantVisibleGenerationActive([]), false)
    assert.equal(T.assistantVisibleGenerationActive(undefined), false)
    assert.equal(T.assistantVisibleGenerationActive([undefined, null]), false)
  })
  it('visualTokenShouldSubscribe：只有真正可能变化的组合才订阅', () => {
    const cases = [
      [true, true, true, false, true],    // running + 可见输出 + 字段开 + 非 reduced → 订阅
      [false, true, true, false, false],  // 历史 / settled
      [true, false, true, false, false],  // 工具执行 / 等待 / 尚无可见输出
      [true, true, false, false, false],  // Token 字段关闭
      [true, true, true, true, false],    // reduced-motion
      [true, true, undefined, false, true],
      [true, true, true, undefined, true],
    ]
    for (const [running, visible, field, reduced, expected] of cases) {
      assert.equal(T.visualTokenShouldSubscribe(running, visible, field, reduced), expected,
        JSON.stringify({ running, visible, field, reduced }))
    }
  })
})

// ══════════════════════════════════════════════════════════════════════
// D. reduced-motion：立即归 canonical/— 并退订
// ══════════════════════════════════════════════════════════════════════
describe('token 视觉增长 D：reduced-motion', () => {
  it('一开始就 reduced-motion → 不增长、不订阅，直接显示真实值', () => {
    withMatchMedia(() => ({ matches: true }), () => {
      assert.equal(renderProbe({ running: true, canonical: 1000, visible: true }), '1000')
      assert.equal(listenerCount(), 0, 'reduced-motion 不得订阅 ticker')
      assert.equal(timerRunning(), false)
      tick(50)
      assert.equal(renderProbe({ running: true, canonical: 1000, visible: true }), '1000')
    })
  })
  it('运行中开启 reduced-motion → 已有偏移立即归零（不是"停止增长但保留 6334"）', () => {
    const mock = makeReducedMotionMock(false)
    withMatchMedia(() => mock.mql, () => {
      assert.equal(renderProbe({ running: true, canonical: 6214, visible: true }), '6214')
      tick(12)
      const grown = Number(renderProbe({ running: true, canonical: 6214, visible: true }))
      assert.ok(grown > 6214, '先正常增长：' + grown)
      mock.set(true) // 用户在会话中途打开系统"减少动态效果"
      assert.equal(renderProbe({ running: true, canonical: 6214, visible: true }), '6214', '立即归真实值')
      assert.equal(listenerCount(), 0, '同时退订 ticker')
      assert.equal(timerRunning(), false)
      tick(30)
      assert.equal(renderProbe({ running: true, canonical: 6214, visible: true }), '6214')
    })
  })
  it('无 canonical 时开启 reduced-motion → 立即回到 —（清 bootstrap）', () => {
    const mock = makeReducedMotionMock(false)
    withMatchMedia(() => mock.mql, () => {
      renderProbe({ running: true, canonical: undefined, visible: true })
      tick(3)
      assert.notEqual(renderProbe({ running: true, canonical: undefined, visible: true }), 'undefined')
      mock.set(true)
      assert.equal(renderProbe({ running: true, canonical: undefined, visible: true }), 'undefined', 'provisional 值不得残留')
      assert.equal(listenerCount(), 0)
      assert.equal(timerRunning(), false)
    })
  })
  it('关闭 reduced-motion → 下一个可见生成周期可重新增长（从 canonical 起）', () => {
    const mock = makeReducedMotionMock(false)
    withMatchMedia(() => mock.mql, () => {
      renderProbe({ running: true, canonical: 5000, visible: true })
      mock.set(true)
      assert.equal(renderProbe({ running: true, canonical: 5000, visible: true }), '5000')
      assert.equal(listenerCount(), 0)
      mock.set(false)
      assert.equal(renderProbe({ running: true, canonical: 5000, visible: true }), '5000', '恢复仍从真实值起')
      assert.equal(listenerCount(), 1, '重新订阅')
      tick(3)
      assert.equal(renderProbe({ running: true, canonical: 5000, visible: true }), '5012', '重新按步长增长')
    })
  })
})

// ══════════════════════════════════════════════════════════════════════
// E. 性能：历史 / settled / 工具阶段绝不订阅 200ms ticker
// ══════════════════════════════════════════════════════════════════════
describe('token 视觉增长 E：ticker 订阅面（性能回归）', () => {
  it('挂载 100 个历史 Turn：0 listener + timer === null，且 tick 不触发任何重渲染', () => {
    let renders = 0
    function HistoricalBar() {
      renders += 1
      T.useDisplayTokenAnimation(false, 1234, false, true)
      return null
    }
    const children = []
    for (let i = 0; i < 100; i += 1) children.push(react.createElement(HistoricalBar, { key: i }))
    act(() => { root.render(react.createElement(react.Fragment, null, children)) })
    const baseline = renders
    assert.ok(baseline >= 100, '100 个历史 Turn 都已挂载：' + baseline)
    assert.equal(listenerCount(), 0, '历史 Turn 不得进入 visualTokenListeners')
    assert.equal(timerRunning(), false, '没有活动动画 → interval 必须已 clear')
    tick(25)
    assert.equal(listenerCount(), 0)
    assert.equal(timerRunning(), false)
    assert.equal(renders, baseline, 'tick 不得触发任何历史 Turn 重渲染')
  })

  it('加入 1 个真正动画的 Turn：listeners = 1、timer 运行；settle 后回到 0 / null', () => {
    const states = { running: true, visible: true, canonical: 100 }
    function Bar(props) {
      T.useDisplayTokenAnimation(props.running, props.canonical, props.visible, true)
      return null
    }
    act(() => { root.render(react.createElement(Bar, states)) })
    assert.equal(listenerCount(), 1)
    assert.equal(timerRunning(), true)
    act(() => { root.render(react.createElement(Bar, Object.assign({}, states, { running: false }))) })
    assert.equal(listenerCount(), 0, 'settle 后退订')
    assert.equal(timerRunning(), false, '最后一个订阅者退出 → timer 停止')
  })

  it('多个 active Turn 共享同一个 module 级 interval（不各起一个表）', () => {
    function Bar(props) {
      T.useDisplayTokenAnimation(props.running, props.canonical, props.visible, true)
      return null
    }
    act(() => {
      root.render(react.createElement(react.Fragment, null,
        react.createElement(Bar, { key: 'a', running: true, visible: true, canonical: 100 }),
        react.createElement(Bar, { key: 'b', running: true, visible: true, canonical: 200 }),
      ))
    })
    assert.equal(listenerCount(), 2, '两个订阅者')
    assert.equal(timerRunning(), true, '仍只有一个 interval')
    act(() => {
      root.render(react.createElement(react.Fragment, null,
        react.createElement(Bar, { key: 'a', running: true, visible: true, canonical: 100 }),
        react.createElement(Bar, { key: 'b', running: false, visible: true, canonical: 200 }),
      ))
    })
    assert.equal(listenerCount(), 1, '一个退出后另一个仍在')
    assert.equal(timerRunning(), true, 'timer 继续为剩余订阅者服务')
  })
})

// ══════════════════════════════════════════════════════════════════════
// F. 端到端：Running Turn 栏（截图场景 + 完整生命周期）
// ══════════════════════════════════════════════════════════════════════
describe('token 视觉增长 F：Running Turn 栏端到端', () => {
  const settledStep = makeStepData(1, {
    usage: { inputTokens: 1000, outputTokens: 3214, cacheReadTokens: 2000 },
    timing: { stepStartTime: T0, firstTokenTime: T0 + 800, completedTime: T0 + 13000 },
  })
  const CANONICAL_AFTER_FIRST_USAGE = '6,214 token' // 1000 + 2000 + 3214
  function runningProps(stepDataList) {
    const steps = makeStepsSource(stepDataList)
    return {
      node: makeTurnNode({ status: 'open', startTime: T0, endTime: null, reason: undefined, steps: [] }),
      turnProcess: makeTurnProcessOwner(),
      useTurnData: makeUseTurnData({}),
      useChat: makeUseChat(steps, 13),
    }
  }
  function render(props) { act(() => { root.render(react.createElement(T.EnhancedTurnProcessView, props)) }) }
  const visualLabel = () => readVisualLabel(container)
  const srLabel = () => readSrLabel(container)
  const visualTokens = () => visualTokenCount(container)

  it('截图场景：reasoning 已出现但官方 usage 未到 → 视觉从 1 起增长，读屏/tok-s 仍为 —', () => {
    render(runningProps([makeRunningStepData(1, { time: T0 + 100, blocks: [REASONING('正在分析请求 · For the leg, use ...')] })]))
    assert.equal(visualTokens(), 1, '第一帧 visual token 必须已经出现（不是 —）：' + visualLabel())
    assert.ok(srLabel().includes('— token'), '读屏值仍是 — token（canonical 未到）：' + srLabel())
    assert.ok(visualLabel().includes('— tok/s'), 'tok/s 不得因展示值出现：' + visualLabel())
    assert.equal(listenerCount(), 1, '可见生成 → 订阅 ticker')
    tick(1)
    assert.equal(visualTokens(), 2, '+1 节奏')
    tick(2)
    assert.equal(visualTokens(), 13, '+1/+10 节奏')
    assert.ok(srLabel().includes('— token'), '推进 tick 后读屏仍是 — token')
    assert.ok(visualLabel().includes('— tok/s'), 'tok/s 仍为 —')
  })

  it('reasoning 文本到达之前不启动（running 但 blocks 为空 → — token，不订阅）', () => {
    render(runningProps([makeRunningStepData(1, { time: T0 + 100, blocks: [] })]))
    assert.ok(visualLabel().includes('— token'), '不得提前启动：' + visualLabel())
    assert.equal(listenerCount(), 0)
    assert.equal(timerRunning(), false)
    tick(100)
    assert.ok(visualLabel().includes('— token'))
    assert.equal(listenerCount(), 0)
    // 同一实例：可见 reasoning 一到 → 立即启动
    render(runningProps([makeRunningStepData(1, { time: T0 + 100, blocks: [REASONING('开始分析')] })]))
    assert.equal(visualTokens(), 1, '出现可见内容即从 1 起：' + visualLabel())
    assert.equal(listenerCount(), 1)
    assert.ok(srLabel().includes('— token'), '读屏仍为 —')
  })

  it('完整生命周期：无输出 → 可见启动 → 工具冻结/退订 → 恢复 → 官方 usage 校准 → 继续 → settle 归真实值', () => {
    // A. running，尚无可见输出，无 canonical
    render(runningProps([makeRunningStepData(1, { time: T0 + 100, blocks: [] })]))
    assert.ok(visualLabel().includes('— token'))
    assert.equal(listenerCount(), 0)
    // B. reasoning 首字出现 → bootstrap 1 → 增长
    render(runningProps([makeRunningStepData(1, { time: T0 + 100, blocks: [REASONING('For the leg, use ...')] })]))
    assert.equal(visualTokens(), 1)
    tick(6)
    const provisional = visualTokens()
    assert.equal(provisional, 25)
    assert.ok(srLabel().includes('— token'))
    // C. 工具执行：step1 已 settle（官方 usage 已到），此刻没有 running step → 立即校准 + 退订
    render(runningProps([settledStep]))
    assert.equal(visualTokens(), 6214, '官方 usage 一到立即校准（display = canonical）')
    assert.ok(srLabel().includes(CANONICAL_AFTER_FIRST_USAGE), '读屏同步为真实值')
    assert.equal(listenerCount(), 0, '工具阶段退订')
    assert.equal(timerRunning(), false)
    tick(30)
    assert.equal(visualTokens(), 6214, '工具执行期间冻结在真实值')
    // D. 下一个 assistant-step 可见输出 → 从 canonical 基线继续增长
    render(runningProps([settledStep, makeRunningStepData(2, { time: T0 + 40100, blocks: [REASONING('继续分析')] })]))
    assert.equal(listenerCount(), 1)
    const tpsAtResume = /([\d.]+)tok\/s/.exec(visualLabel())[1]
    tick(3)
    assert.equal(visualTokens(), 6226, 'canonical + 12')
    assert.ok(srLabel().includes(CANONICAL_AFTER_FIRST_USAGE), '读屏值恒为 canonical：' + srLabel())
    assert.equal(/([\d.]+)tok\/s/.exec(visualLabel())[1], tpsAtResume, 'tok/s 是真实 decode 值，不随视觉增长变化')
    assert.equal(/([\d.]+)tok\/s/.exec(srLabel())[1], tpsAtResume, '视觉与读屏 tok/s 完全一致')
    // E. settle：只剩真实值（canonical），tick 无效
    render({
      node: makeTurnNode({ status: 'closed', startTime: T0, endTime: T1, reason: 'completed', steps: [] }),
      turnProcess: makeTurnProcessOwner(),
      useTurnData: makeUseTurnData({ tail: { tokenUsage: OFFICIAL_TOKEN_USAGE } }),
      useChat: makeUseChat(makeStepsSource([settledStep]), 13),
    })
    const settledLabel = container.querySelector('.ccg-turn-bar-label').textContent
    assert.ok(settledLabel.includes('370,202 token'), 'settle 后 = 官方真实 token：' + settledLabel)
    assert.equal(listenerCount(), 0)
    assert.equal(timerRunning(), false)
    tick(40)
    assert.ok(container.querySelector('.ccg-turn-bar-label').textContent.includes('370,202 token'), 'settle 后 tick 不改动')
  })

  it('F5 / 历史会话：settled Turn 只显示官方真实值，不订阅 ticker、不残留 provisional', () => {
    render({
      node: makeTurnNode({ status: 'closed', startTime: T0, endTime: T1, reason: 'completed', steps: [] }),
      turnProcess: makeTurnProcessOwner(),
      useTurnData: makeUseTurnData({ tail: { tokenUsage: OFFICIAL_TOKEN_USAGE } }),
      useChat: makeUseChat(makeStepsSource([settledStep, makeStepData(2, { usage: { inputTokens: 500, outputTokens: 700, cacheReadTokens: 1000 } })]), 13),
    })
    assert.ok(container.querySelector('.ccg-turn-bar-label').textContent.includes('370,202 token'))
    assert.equal(listenerCount(), 0, '历史 Turn 不订阅')
    assert.equal(timerRunning(), false)
    tick(50)
    assert.ok(container.querySelector('.ccg-turn-bar-label').textContent.includes('370,202 token'))
  })
})

// ══════════════════════════════════════════════════════════════════════
// G. StrictMode 生命周期（subscribe/unsubscribe replay 不得泄漏或重复启动）
// ══════════════════════════════════════════════════════════════════════
describe('token 视觉增长 G：StrictMode', () => {
  it('StrictMode 下：挂载不跳 cap、工具阶段退订、settle 后 0 listener + timer 停止', () => {
    const states = { running: true, visible: false, canonical: undefined }
    function Bar(props) {
      T.useDisplayTokenAnimation(props.running, props.canonical, props.visible, true)
      return null
    }
    const strict = (props) => react.createElement(react.StrictMode, null, react.createElement(Bar, props))
    // A. running 但无可见输出：不得订阅、不得有任何 provisional
    act(() => { root.render(strict(states)) })
    assert.equal(listenerCount(), 0, 'StrictMode：无可见输出不订阅')
    assert.equal(timerRunning(), false)
    // B. 可见输出 → 订阅（StrictMode 会 replay subscribe/unsubscribe：只能剩 1 个订阅者）
    act(() => { root.render(strict(Object.assign({}, states, { visible: true }))) })
    assert.equal(listenerCount(), 1, 'StrictMode replay 后不得残留重复订阅：' + listenerCount())
    assert.equal(timerRunning(), true)
    // C. 工具阶段退订
    act(() => { root.render(strict(Object.assign({}, states, { visible: false, canonical: 6214 }))) })
    assert.equal(listenerCount(), 0)
    assert.equal(timerRunning(), false)
    // D. settle 后依然干净
    act(() => { root.render(strict(Object.assign({}, states, { running: false, canonical: 6214 }))) })
    assert.equal(listenerCount(), 0)
    assert.equal(timerRunning(), false)
  })
  it('StrictMode 端到端（真实栏）：可见启动 → 增长 → 校准 → settle 不残留', () => {
    const stepWithText = () => makeRunningStepData(1, { time: T0 + 100, blocks: [REASONING('For the leg, use ...')] })
    function render(props) {
      act(() => {
        root.render(react.createElement(react.StrictMode, null, react.createElement(T.EnhancedTurnProcessView, props)))
      })
    }
    const props = (list) => ({
      node: makeTurnNode({ status: 'open', startTime: T0, endTime: null, reason: undefined, steps: [] }),
      turnProcess: makeTurnProcessOwner(),
      useTurnData: makeUseTurnData({}),
      useChat: makeUseChat(makeStepsSource(list), 13),
    })
    render(props([stepWithText()]))
    assert.equal(listenerCount(), 1)
    const visual = () => readVisualLabel(container)
    assert.ok(visual().includes('token'), 'StrictMode 下栏正常渲染：' + visual())
    assert.equal(visualTokenCount(container), 1, 'StrictMode 下 bootstrap 正常从 1 起（不得一挂载就跳 cap）：' + visual())
    assert.ok(readSrLabel(container).includes('— token'), '读屏仍为 —：' + readSrLabel(container))
    tick(2)
    assert.equal(visualTokenCount(container), 3, '严格模式下增长节奏正常：' + visual())
    render({
      node: makeTurnNode({ status: 'closed', startTime: T0, endTime: T1, reason: 'completed', steps: [] }),
      turnProcess: makeTurnProcessOwner(),
      useTurnData: makeUseTurnData({ tail: { tokenUsage: OFFICIAL_TOKEN_USAGE } }),
      useChat: makeUseChat(makeStepsSource([]), 13),
    })
    assert.equal(listenerCount(), 0, 'settle 后退订')
    assert.equal(timerRunning(), false)
    assert.ok(readVisualLabel(container).includes('370,202 token'), 'settle 后 = 官方真实值：' + readVisualLabel(container))
  })
})
