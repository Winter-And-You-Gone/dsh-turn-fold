// 运行中 token 视觉增长（presentation-only）测试。
//
// 架构边界（本轮核心）：
//   canonicalTokens —— 官方真实数据（computeTurnMetrics / usage / turn-tail），唯一权威值，
//                      参与 tok/s / 缓存 / TTFT / durable projection。
//   displayTokens   —— 仅 Running Turn UI 使用的展示值 = canonical + 小的、有上限的视觉偏移；
//                      不持久化、不进 projection、不进任何统计、settle 后必然归零。
// 本文件锁死三件事：canonical 纯度（同输入 100 次结果完全一致）、展示层边界
//（cap / 校准 / 暂停 / reduced-motion / 无基线不伪造）、以及展示值不污染其它字段。
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

/** 直接驱动 useDisplayTokenAnimation（只测展示层，不经完整栏）。 */
function Probe(props) {
  const value = T.useDisplayTokenAnimation(props.running, props.canonical, props.active)
  return react.createElement('span', { 'data-probe': 'tokens' }, value === undefined ? 'undefined' : String(value))
}
function renderProbe(props) {
  act(() => { root.render(react.createElement(Probe, props)) })
  return container.querySelector('[data-probe="tokens"]').textContent
}
/** 推进 n 个视觉 tick（确定性；不用真实 sleep）。 */
function tick(n) {
  act(() => { for (let i = 0; i < n; i += 1) T.notifyVisualTokenTick() })
}

// ══════════════════════════════════════════════════════════════════════
// A. canonical 纯度：真实数据层不含任何展示偏移
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

  it('视觉偏移不进入任何持久化面：settings / projection 源都读不到', () => {
    const src = require('node:fs').readFileSync(new URL('../client.js', import.meta.url), 'utf8')
    // 偏移只在 useDisplayTokenAnimation 的本地 ref 里；不得出现在 saveSettings / projection wire 里
    const saveBlock = src.slice(src.indexOf('function saveSettings'), src.indexOf('// -- 字段显隐 --'))
    assert.ok(!/visualToken|displayTokens/.test(saveBlock), 'settings 持久化不得涉及视觉偏移')
    const indexSrc = require('node:fs').readFileSync(new URL('../index.js', import.meta.url), 'utf8')
    assert.ok(!/visualToken|displayTokens/.test(indexSrc), '宿主 projection 不得涉及视觉偏移')
  })
})

// ══════════════════════════════════════════════════════════════════════
// B. 展示层：cap / 步长 / 校准 / 暂停 / 归零
// ══════════════════════════════════════════════════════════════════════
describe('token 视觉增长 B：展示层边界', () => {
  it('cap 公式：min(500, max(20, canonical × 5%))', () => {
    assert.equal(T.visualTokenCap(0), 0)
    assert.equal(T.visualTokenCap(-5), 0)
    assert.equal(T.visualTokenCap(100), 20, '小回合至少 20')
    assert.equal(T.visualTokenCap(1000), 50)
    assert.equal(T.visualTokenCap(10000), 500)
    assert.equal(T.visualTokenCap(100000), 500, '绝对上限 500')
  })
  it('步长序列确定性：+1 +1 +10 循环，累计偏移闭式正确', () => {
    assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map((n) => T.visualTokenStepForTick(n)), [1, 1, 10, 1, 1, 10, 1])
    assert.deepEqual([0, 1, 2, 3, 6, 9, 30].map((n) => T.visualTokenOffsetForTicks(n)), [0, 1, 2, 12, 24, 36, 120])
  })
  it('tick 周期固定 200ms（无随机 jitter）', () => {
    assert.equal(T.visualTokenTickMs, 200)
  })
  it('running=false → display === canonical（无任何偏移）', () => {
    assert.equal(renderProbe({ running: false, canonical: 1234, active: true }), '1234')
    tick(50)
    assert.equal(renderProbe({ running: false, canonical: 1234, active: true }), '1234', 'settle 后 tick 不得改动显示')
  })
  it('canonical 缺失 → undefined（UI 保持 "— token"，绝不从 0 伪增）', () => {
    assert.equal(renderProbe({ running: true, canonical: undefined, active: true }), 'undefined')
    tick(20)
    assert.equal(renderProbe({ running: true, canonical: undefined, active: true }), 'undefined')
  })
  it('generationActive=false → 不增长（工具执行/等待阶段暂停）', () => {
    assert.equal(renderProbe({ running: true, canonical: 1000, active: false }), '1000')
    tick(30)
    assert.equal(renderProbe({ running: true, canonical: 1000, active: false }), '1000')
  })
  it('running && active → 随 tick 增长，且 display 永远 >= canonical', () => {
    assert.equal(renderProbe({ running: true, canonical: 1000, active: true }), '1000', '起点就是真实值')
    let previous = 1000
    for (const n of [1, 3, 5, 10]) {
      tick(n)
      const value = Number(renderProbe({ running: true, canonical: 1000, active: true }))
      assert.ok(value > previous, '应持续增长：' + value)
      assert.ok(value >= 1000, 'display 不得低于 canonical：' + value)
      previous = value
    }
  })
  it('达到 cap 后停住（canonical 20,000 → 最大 20,500）', () => {
    renderProbe({ running: true, canonical: 20000, active: true })
    tick(300)
    assert.equal(renderProbe({ running: true, canonical: 20000, active: true }), '20500', '恰好停在 cap')
    tick(50)
    assert.equal(renderProbe({ running: true, canonical: 20000, active: true }), '20500', '不得越过 cap')
  })
  it('canonical 更新 → 下一帧立即校准到新真实值，偏移归零后重新增长', () => {
    renderProbe({ running: true, canonical: 1000, active: true })
    tick(12)
    const grown = Number(renderProbe({ running: true, canonical: 1000, active: true }))
    assert.ok(grown > 1000, '先增长：' + grown)
    // 官方 usage 更新到 1500：同一帧内必须立刻显示 1500（不得慢慢滚过去）
    assert.equal(renderProbe({ running: true, canonical: 1500, active: true }), '1500')
    tick(3)
    assert.equal(renderProbe({ running: true, canonical: 1500, active: true }), '1512', '从新基线重新按步长增长')
  })
  it('running true → false：display === canonical 且偏移清零', () => {
    renderProbe({ running: true, canonical: 1000, active: true })
    tick(9)
    assert.ok(Number(renderProbe({ running: true, canonical: 1000, active: true })) > 1000)
    assert.equal(renderProbe({ running: false, canonical: 1000, active: true }), '1000', 'settle 立即归真实值')
    // 再回到 running：从 0 偏移重新开始（settle 期间不累积）
    assert.equal(renderProbe({ running: true, canonical: 1000, active: true }), '1000')
  })
  it('暂停 → 恢复：工具阶段冻结偏移，恢复生成后从冻结值继续', () => {
    renderProbe({ running: true, canonical: 1000, active: true })
    tick(6)                                            // +24
    const frozen = Number(renderProbe({ running: true, canonical: 1000, active: true }))
    assert.equal(frozen, 1024)
    // 真实时序：工具开始执行 → 先切到 active=false（一次渲染），随后的 tick 才不增长
    renderProbe({ running: true, canonical: 1000, active: false })
    tick(20)
    assert.equal(Number(renderProbe({ running: true, canonical: 1000, active: false })), frozen, '暂停期间冻结')
    // 恢复生成 → 切回 active=true，随后的 tick 从冻结值继续
    renderProbe({ running: true, canonical: 1000, active: true })
    tick(3)
    assert.equal(Number(renderProbe({ running: true, canonical: 1000, active: true })), frozen + 12, '从冻结偏移继续')
  })
  it('reduced-motion → 不增长，直接显示真实值', () => {
    const original = sharedWindow.matchMedia
    sharedWindow.matchMedia = function () { return { matches: true } }
    try {
      assert.equal(renderProbe({ running: true, canonical: 1000, active: true }), '1000')
      tick(50)
      assert.equal(renderProbe({ running: true, canonical: 1000, active: true }), '1000', 'reduced-motion 下数字不跳')
    } finally {
      if (original === undefined) delete sharedWindow.matchMedia
      else sharedWindow.matchMedia = original
    }
  })
})

// ══════════════════════════════════════════════════════════════════════
// C. generationActive 判定：官方 assistant-step.status === 'running'
// ══════════════════════════════════════════════════════════════════════
describe('token 视觉增长 C：generationActive 判定', () => {
  it('有任一 running 的 assistant-step → true；全部 settled/null → false', () => {
    assert.equal(T.assistantGenerationActive([]), false)
    assert.equal(T.assistantGenerationActive(undefined), false)
    assert.equal(T.assistantGenerationActive([undefined, null]), false)
    assert.equal(T.assistantGenerationActive([makeStepData(1, { usage: { outputTokens: 10 } })]), false, 'settled 不算生成中')
    assert.equal(T.assistantGenerationActive([makeRunningStepData(1, { time: T0 + 100 })]), true)
    assert.equal(T.assistantGenerationActive([makeStepData(1, { usage: { outputTokens: 10 } }), makeRunningStepData(2, { time: T0 + 200 })]), true)
  })
})

// ══════════════════════════════════════════════════════════════════════
// D. 端到端：Running Turn 栏的视觉值会动、读屏值恒为 canonical、其它字段零污染
// ══════════════════════════════════════════════════════════════════════
describe('token 视觉增长 D：Running Turn 栏端到端', () => {
  const settledStep = makeStepData(1, {
    usage: { inputTokens: 1000, outputTokens: 3214, cacheReadTokens: 2000 },
    timing: { stepStartTime: T0, firstTokenTime: T0 + 800, completedTime: T0 + 13000 },
  })
  const runningStep2 = makeRunningStepData(2, { time: T0 + 20100 })
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
  /** 从滚动数字条重建视觉文案（sr-only 之外的可见文字）。 */
  function visualLabel() {
    const labelRoot = container.querySelector('.ccg-roll-label')
    if (!labelRoot) return container.querySelector('.ccg-turn-bar-label').textContent
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
  const srLabel = () => container.querySelector('.ccg-sr-only').textContent

  it('真实基线未到 → 显示 — token（不从 0 伪增）；tick 也不改', () => {
    render(runningProps([makeRunningStepData(1, { time: T0 + 100 })]))
    assert.ok(visualLabel().includes('— token'), '无真实 token 基线：' + visualLabel())
    tick(20)
    assert.ok(visualLabel().includes('— token'), '不得凭空出现数字：' + visualLabel())
  })

  it('assistant 生成中 → 视觉 token 连续增长，而读屏值恒为 canonical', () => {
    render(runningProps([settledStep, runningStep2]))
    const canonical = srLabel()
    assert.ok(canonical.includes('6,214 token'), 'canonical = 计费输入 + 输出（无 turn-tail 时的 step 聚合）：' + canonical)
    assert.equal(visualLabel(), canonical, '起点视觉 = 真实值')
    tick(30)
    const visual = visualLabel()
    assert.notEqual(visual, canonical, '视觉值必须已经增长：' + visual)
    assert.ok(visual.includes('token'), '视觉文案结构不变')
    assert.equal(srLabel(), canonical, '读屏值恒为 canonical（不随动画变化）')
    // 其它字段零污染：耗时/首字/tok-s/缓存 在视觉与读屏两侧一致
    for (const field of ['首字', 'tok/s', '缓存']) {
      assert.ok(visual.includes(field) && canonical.includes(field), field + ' 两侧都在：' + visual)
    }

    for (const segment of ['首字0.8s', '263tok/s', '缓存66.67%']) {
      assert.ok(visual.includes(segment) && canonical.includes(segment), segment + ' 在视觉与读屏两侧一致：' + visual)
    }
  })

  it('生命周期：assistant 生成 → 工具执行暂停 → 重新生成恢复 → settle 归真实值', () => {
    // 1) assistant 生成中（step2 running）
    render(runningProps([settledStep, runningStep2]))
    tick(12)
    const growing = visualLabel()
    assert.notEqual(growing, srLabel(), '生成中应增长')
    // 2) 工具执行：step2 已 settle（工具还在跑），没有 running step → 暂停
    const settledStep2 = makeStepData(2, { usage: { inputTokens: 500, outputTokens: 700, cacheReadTokens: 1000 } })
    render(runningProps([settledStep, settledStep2]))
    const paused = visualLabel()
    tick(20)
    assert.equal(visualLabel(), paused, '工具执行期间数字必须停住')
    // 3) 下一个 step 开始生成 → 恢复增长
    render(runningProps([settledStep, settledStep2, makeRunningStepData(3, { time: T0 + 40100 })]))
    tick(3)
    assert.notEqual(visualLabel(), paused, '恢复生成后继续变化')
    // 4) settle：Turn 关闭 → 只剩真实值
    render({
      node: makeTurnNode({ status: 'closed', startTime: T0, endTime: T1, reason: 'completed', steps: [] }),
      turnProcess: makeTurnProcessOwner(),
      useTurnData: makeUseTurnData({ tail: { tokenUsage: OFFICIAL_TOKEN_USAGE } }),
      useChat: makeUseChat(makeStepsSource([settledStep, settledStep2]), 13),
    })
    const settledLabel = container.querySelector('.ccg-turn-bar-label').textContent
    assert.ok(settledLabel.includes('370,202 token'), 'settle 后 = 官方真实 token：' + settledLabel)
    tick(40)
    assert.ok(container.querySelector('.ccg-turn-bar-label').textContent.includes('370,202 token'), 'settle 后 tick 不改动')
  })
})
