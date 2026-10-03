// 纯函数单测：官方真实数据 → 指标 / 文案（无任何随机或伪造成分）。
//   - turnClockOf / computeTurnMetrics / readStepUsage（官方 TurnLocation 契约）
//   - 格式化：耗时 / tok/s / token 千位分组 / 状态词 / 轮次
//   - 字段显隐过滤与 localStorage 持久化
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { loadPlugin } from './helpers/loader.mjs'
import {
  T0, T1, TURN13_USAGE_STEPS, TURN13_EXPECT, TURN13_STEP_TIMINGS, TURN13_EXPECT_TPS,
  OFFICIAL_TOKEN_USAGE,
  makeStepData, makeRunningStepData, makeStep,
} from './helpers/fixtures.mjs'

const { test: T, window } = loadPlugin({ uiPrimitives: {} })

function setLang(lang) {
  window.document.documentElement.lang = lang
}

beforeEach(() => {
  setLang('zh-CN')
  window.localStorage.clear()
  // 恢复默认字段显隐（设置在模块级持久化，测试间互不污染）
  for (const key of T.FIELD_KEYS) T.setFieldVisible(key, true)
  T.settings.iconStyle = 'poker'
  T.settings.iconStyle = 'poker'
  // 运行时 TTFT 观察缓存是模块级（跨用例共享）——每个用例从干净状态开始
  T.observedTtft.clear()
})

describe('turnClockOf（官方 TurnLocation 读取）', () => {
  it('提取 start/end/status/reason 与 data store', () => {
    const node = {
      kind: 'turn-process',
      data: { turn: 13 },
      location: {
        kind: 'turn',
        turn: {
          turn: 13,
          status: 'closed',
          start: { time: T0 },
          end: { time: T1, data: { reason: { kind: 'completed' } } },
          steps: [],
          data: { get: () => undefined },
        },
      },
    }
    const clock = T.turnClockOf(node)
    assert.equal(clock.number, 13)
    assert.equal(clock.startMs, T0)
    assert.equal(clock.endMs, T1)
    assert.equal(clock.status, 'closed')
    assert.equal(clock.reason, 'completed')
    assert.equal(typeof clock.data.get, 'function')
  })

  it('非回合定位返回 null；aborted reason 原样带出', () => {
    assert.equal(T.turnClockOf({ kind: 'turn-process', data: {}, location: { kind: 'session' } }), null)
    assert.equal(T.turnClockOf(undefined), null)
    const aborted = T.turnClockOf({
      kind: 'turn-process', data: {},
      location: { kind: 'turn', turn: { turn: 1, status: 'closed', start: { time: 1 }, end: { time: 2, data: { reason: { kind: 'aborted' } } }, steps: [], data: { get: () => undefined } } },
    })
    assert.equal(aborted.reason, 'aborted')
  })
})

describe('computeTurnMetrics（官方真实数据，无伪造增长）', () => {
  // steps13：5 步各带官方 AssistantTiming（stepStart/firstToken/completed），
  // 第 1 步 TTFT = 4.9s（官方 finalNode.timing 语义）
  const steps13 = TURN13_USAGE_STEPS.map((usage, i) => makeStepData(i + 1, {
    usage,
    timing: TURN13_STEP_TIMINGS[i],
  }))

  it('官方聚合 tokenUsage 优先（turn-tail），数值与手工核算一致', () => {
    const clock = {
      number: 13, startMs: T0, endMs: T1, status: 'closed', reason: 'completed',
      data: null, steps: [],
    }
    const metrics = T.computeTurnMetrics(clock, [], { tokenUsage: OFFICIAL_TOKEN_USAGE }, undefined)
    assert.equal(metrics.durationMs, TURN13_EXPECT.durationMs)
    assert.equal(metrics.tokens, TURN13_EXPECT.tokens)
    assert.equal(metrics.outputTokens, TURN13_EXPECT.outputTokens)
    assert.equal(metrics.cacheHitPercent, TURN13_EXPECT.cacheHitPercent)
    assert.equal(metrics.ttftMs, undefined) // 无 step 数据 → 无 TTFT
    assert.equal(metrics.tokensPerSecond, undefined) // 无 settled step → 不计 TPS
  })

  it('无官方聚合时按 step usage 累加（step data 与节点可见性无关，隐藏步骤同样计入）', () => {
    const clock = {
      number: 13, startMs: T0, endMs: T1, status: 'closed', reason: 'completed',
      data: null, steps: [],
    }
    const metrics = T.computeTurnMetrics(clock, steps13, undefined, undefined)
    assert.equal(metrics.durationMs, TURN13_EXPECT.durationMs)
    assert.equal(metrics.tokens, TURN13_EXPECT.tokens)
    assert.equal(metrics.outputTokens, TURN13_EXPECT.outputTokens)
    assert.equal(metrics.cacheHitPercent, TURN13_EXPECT.cacheHitPercent)
    assert.equal(metrics.ttftMs, 4900)
    // tok/s = 官方 decode-speed 语义：ΣoutputTokens / Σ(completed-firstToken)
    // = 3273 / 1325.5s ≈ 2.4693 → '2.5'（与整个 Turn 墙钟时长无关）
    assert.equal(T.formatTokPerSec(metrics.tokensPerSecond), TURN13_EXPECT_TPS)
  })

  it('TPS 官方 decode 语义：单 step 100tok/1s → 100；两步加权 (100+200)/(1s+2s) → 100', () => {
    const clock = { number: 1, startMs: 0, endMs: 900000, status: 'closed', reason: 'completed', data: null, steps: [] }
    const one = T.computeTurnMetrics(clock, [makeStepData(1, {
      usage: { outputTokens: 100 },
      timing: { stepStartTime: 1000, firstTokenTime: 1000, completedTime: 2000 },
    })], undefined, undefined)
    assert.equal(T.formatTokPerSec(one.tokensPerSecond), '100')

    const two = T.computeTurnMetrics(clock, [
      makeStepData(1, { usage: { outputTokens: 100 }, timing: { stepStartTime: 1000, firstTokenTime: 1000, completedTime: 2000 } }),
      // step2 与 step1 之间隔 400s 工具执行（8000→8400 不进分母）
      makeStepData(2, { usage: { outputTokens: 200 }, timing: { stepStartTime: 8400000, firstTokenTime: 8400500, completedTime: 10400500 } }),
    ], undefined, undefined)
    // Σ = 300 tok / (1000ms + 2000000ms) → 300/2001s ≈ 0.1499 → '0.1'
    assert.equal(T.formatTokPerSec(two.tokensPerSecond), T.formatTokPerSec(300 / ((1000 + 2000000) / 1000)))
  })

  it('TPS 排除规则：缺 outputTokens / 缺 firstTokenTime / running 未 settle 的 step 都不计', () => {
    const clock = { number: 1, startMs: 0, endMs: 900000, status: 'closed', reason: 'completed', data: null, steps: [] }
    const good = makeStepData(1, { usage: { outputTokens: 100 }, timing: { stepStartTime: 1000, firstTokenTime: 1000, completedTime: 2000 } })
    // 缺 outputTokens（finalNode.usage 无该字段）
    const noOut = makeStepData(2, { timing: { stepStartTime: 3000, firstTokenTime: 3100, completedTime: 5000 } })
    noOut.finalNode.usage = { inputTokens: 500 }
    // 缺 firstTokenTime（官方 AssistantTiming 允许 null——窗口外的 step）
    const noFirst = makeStepData(3, { usage: { outputTokens: 999 }, timing: { stepStartTime: null, firstTokenTime: null, completedTime: 6000 } })
    // running 未 settle（无 finalNode）——usage 再大也不计
    const running = { ...makeRunningStepData(4, { time: 6500 }), usage: { outputTokens: 5000 } }
    const metrics = T.computeTurnMetrics(clock, [good, noOut, noFirst, running], undefined, undefined)
    assert.equal(metrics.tokensPerSecond, 100) // 只有 good 计入：100tok / 1s
    assert.equal(metrics.ttftMs, 0) // TTFT 取 step 号最小者（good 的 exact = 0ms）
  })

  it('TPS 与整个 Turn 墙钟时长无关（改 endMs 不影响 tok/s）', () => {
    const step = makeStepData(1, { usage: { outputTokens: 100 }, timing: { stepStartTime: 1000, firstTokenTime: 1000, completedTime: 2000 } })
    const a = T.computeTurnMetrics({ number: 1, startMs: 0, endMs: 5000, status: 'closed', reason: 'completed', data: null, steps: [] }, [step], undefined, undefined)
    const b = T.computeTurnMetrics({ number: 1, startMs: 0, endMs: 9999999, status: 'closed', reason: 'completed', data: null, steps: [] }, [step], undefined, undefined)
    assert.equal(a.tokensPerSecond, b.tokensPerSecond)
  })

  it('同一输入两次计算结果逐字段相等（确定性，无随机增长）', () => {
    const clock = {
      number: 13, startMs: T0, endMs: T1, status: 'closed', reason: 'completed',
      data: null, steps: [],
    }
    const a = T.computeTurnMetrics(clock, steps13, undefined, undefined)
    const b = T.computeTurnMetrics(clock, steps13, undefined, undefined)
    assert.deepEqual(a, b)
  })

  it('运行中：耗时用 liveNow 实时补足；settled step 计入 TPS、running step 不计', () => {
    const clock = {
      number: 3, startMs: 1000, endMs: undefined, status: 'open', reason: undefined,
      data: null, steps: [],
    }
    const live = T.computeTurnMetrics(clock, [makeStepData(1, { usage: { inputTokens: 1000, outputTokens: 3214, cacheReadTokens: 2000 } })], undefined, 14000)
    assert.equal(live.durationMs, 13000)
    assert.equal(live.tokens, 6214)
    assert.equal(live.outputTokens, 3214)
    assert.equal(live.cacheHitPercent, '66.67')
    // step1 的 data 无 finalNode（fixture 未给 timing）→ running 视角无 settled step → 不计
    assert.equal(live.tokensPerSecond, undefined)

    // settled step（有 decode timing）在运行中同样计入；running 的 step2 不计
    const settled1 = makeStepData(1, { usage: { outputTokens: 100 }, timing: { stepStartTime: 1000, firstTokenTime: 1000, completedTime: 2000 } })
    const running2 = makeRunningStepData(2, { time: 8000 })
    const mixed = T.computeTurnMetrics(clock, [settled1, running2], undefined, 14000)
    assert.equal(T.formatTokPerSec(mixed.tokensPerSecond), '100')
  })

  it('同一数据对象重复出现只累加一次（引用去重）', () => {
    const acc = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, has: false, ttft: null, ttftStep: Infinity, ttftExact: false, decodeMs: 0, decodeTokens: 0, counted: new Set() }
    const data = makeStepData(1, { usage: { inputTokens: 100, outputTokens: 10 } })
    T.readStepUsage(data, acc)
    T.readStepUsage(data, acc)
    assert.equal(acc.input, 100)
    assert.equal(acc.output, 10)
  })

  it('无任何数据返回 null', () => {
    assert.equal(T.computeTurnMetrics({ number: 1, startMs: undefined, endMs: undefined, status: 'closed', data: null, steps: [] }, [], undefined, undefined), null)
  })
})

describe('TTFT 两层值（provisional 可见首字 → exact 官方覆盖）', () => {
  const clock13 = (steps) => ({ number: 13, startMs: T0, endMs: undefined, status: 'open', reason: undefined, data: null, steps })

  it('running 且无可见内容（data.time 缺失）→ 无 TTFT 候选（保持 —）', () => {
    const step1 = makeStep(1, makeRunningStepData(1, {}), T0 + 100) // 无 time
    const metrics = T.computeTurnMetrics(clock13([step1]), [step1.data.get('assistant-step')], undefined, Date.now())
    assert.equal(metrics.ttftMs, undefined)
  })

  it('provisional：running + firstVisibleTime + step/start → 可见首字延迟', () => {
    // data.time = T0+1300（第一个可见 reasoning block）、step/start = T0+100 → 1.2s
    const step1 = makeStep(1, makeRunningStepData(1, { time: T0 + 1300 }), T0 + 100)
    const metrics = T.computeTurnMetrics(clock13([step1]), [step1.data.get('assistant-step')], undefined, Date.now())
    assert.equal(metrics.ttftMs, 1200)
  })

  it('exact 覆盖 provisional：同一 step settle 后 finalNode.timing 生效', () => {
    const settled = makeStepData(1, {
      usage: { outputTokens: 50 },
      timing: { stepStartTime: T0 + 100, firstTokenTime: T0 + 900, completedTime: T0 + 3000 },
    })
    const step1 = makeStep(1, settled, T0 + 100)
    const metrics = T.computeTurnMetrics(clock13([step1]), [settled], undefined, Date.now())
    assert.equal(metrics.ttftMs, 800) // 官方 exact：900-100
  })

  it('exact 与 provisional 并存时取 step 号最小者；step 号相同 exact 优先', () => {
    // step1 仍 running（provisional 1.2s）、step2 已 settled（exact 0.3s）——step 号小者胜
    const step1 = makeStep(1, makeRunningStepData(1, { time: T0 + 1300 }), T0 + 100)
    const settled2 = makeStepData(2, { timing: { stepStartTime: T0 + 5000, firstTokenTime: T0 + 5300, completedTime: T0 + 8000 } })
    const step2 = makeStep(2, settled2, T0 + 5000)
    const m1 = T.computeTurnMetrics(clock13([step1, step2]), [step1.data.get('assistant-step'), settled2], undefined, Date.now())
    assert.equal(m1.ttftMs, 1200) // step1 更小 → provisional 生效
    // 同一 step：provisional 先记、settle 后 exact 覆盖（官方数据链替换快照对象）
    const step1b = makeStep(1, makeRunningStepData(1, { time: T0 + 1300 }), T0 + 100)
    const acc = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, has: false, ttft: null, ttftStep: Infinity, ttftExact: false, decodeMs: 0, decodeTokens: 0, counted: new Set() }
    T.readStepUsage(step1b.data.get('assistant-step'), acc, T0 + 100)
    assert.equal(acc.ttft, 1200)
    assert.equal(acc.ttftExact, false)
    const settled1 = makeStepData(1, { timing: { stepStartTime: T0 + 100, firstTokenTime: T0 + 900, completedTime: T0 + 3000 } })
    T.readStepUsage(settled1, acc, T0 + 100)
    assert.equal(acc.ttft, 800)
    assert.equal(acc.ttftExact, true)
  })

  it('retry 不产生负值：data.time 早于 step/start（时钟/重试边界）被 Math.max(0) 钳制', () => {
    const step1 = makeStep(1, makeRunningStepData(1, { time: T0 - 500 }), T0 + 100)
    const metrics = T.computeTurnMetrics(clock13([step1]), [step1.data.get('assistant-step')], undefined, Date.now())
    assert.equal(metrics.ttftMs, 0)
  })

  it('无法可靠得到 stepStartTime（clock.steps 缺该步 / start 缺失）→ 保持 —（禁止猜时间）', () => {
    const step1 = makeStep(1, makeRunningStepData(1, { time: T0 + 1300 })) // 无 start
    const metrics = T.computeTurnMetrics(clock13([step1]), [step1.data.get('assistant-step')], undefined, Date.now())
    assert.equal(metrics.ttftMs, undefined)
    const step2 = makeStep(2, makeRunningStepData(2, { time: T0 + 1300 }), T0 + 100)
    const mismatch = T.computeTurnMetrics(clock13([step2]), [makeRunningStepData(1, { time: T0 + 1300 })], undefined, Date.now())
    // data.step=1 在 clock.steps（只有 step2）里找不到 → 无 stepStartTime → —
    assert.equal(mismatch.ttftMs, undefined)
  })

  it('settled 的 exact 优先于同 turn 内任何 running provisional（官方 timing 就绪即校正）', () => {
    const settled1 = makeStepData(1, { timing: { stepStartTime: T0 + 100, firstTokenTime: T0 + 900, completedTime: T0 + 3000 } })
    const step1 = makeStep(1, settled1, T0 + 100)
    const running2 = makeRunningStepData(2, { time: T0 + 5200 })
    const step2 = makeStep(2, running2, T0 + 5000)
    const metrics = T.computeTurnMetrics(clock13([step1, step2]), [settled1, running2], undefined, Date.now())
    assert.equal(metrics.ttftMs, 800) // step1 exact 覆盖一切 provisional
  })
})

describe('格式化（中英文）', () => {
  it('formatTurnDuration：秒 / 分秒 / 时分秒', () => {
    setLang('zh-CN')
    assert.equal(T.formatTurnDuration(0), '0秒')
    assert.equal(T.formatTurnDuration(49000), '49秒')
    assert.equal(T.formatTurnDuration(92000), '1分32秒')
    assert.equal(T.formatTurnDuration(4932000), '1时22分12秒')
    setLang('en')
    assert.equal(T.formatTurnDuration(92000), '1m 32s')
    assert.equal(T.formatTurnDuration(4932000), '1h 22m 12s')
  })

  it('formatTokPerSec / formatTokenCount', () => {
    assert.equal(T.formatTokPerSec(34.2), '34')
    assert.equal(T.formatTokPerSec(7.64), '7.6')
    assert.equal(T.formatTokenCount(12345), '12,345')
    assert.equal(T.formatTokenCount(370202), '370,202')
    assert.equal(T.formatTokenCount(999), '999')
  })

  it('turnHeaderLabel：目标样式（zh / en）', () => {
    setLang('zh-CN')
    assert.equal(
      T.turnHeaderLabel({ durationMs: 92000, ttftMs: 1200, tokens: 12345, tokensPerSecond: 34.2, cacheHitPercent: '80.00' }),
      '耗时1分32秒 · 首字1.2s · 12,345 token · 34tok/s · 缓存80.00%',
    )
    setLang('en')
    assert.equal(
      T.turnHeaderLabel({ durationMs: 92000, ttftMs: 1200, tokens: 12345, tokensPerSecond: 34.2, cacheHitPercent: '80.00' }),
      '1m 32s · TTFT 1.2s · 12,345 tokens · 34 tok/s · Cache 80.00%',
    )
    assert.equal(T.turnHeaderLabel(null), '')
    assert.equal(T.turnHeaderLabel({}), '')
  })

  it('槽位渲染：启用字段无值显示 —（running 0 秒起布局稳定，绝不伪造）', () => {
    setLang('zh-CN')
    // running 刚开局：只有 duration，其余启用槽位全部 —（与用户目标文案逐字一致）
    assert.equal(
      T.turnHeaderLabel(T.filterVisibleMetrics({ durationMs: 0 })),
      '耗时0秒 · 首字— · — token · — tok/s · 缓存—',
    )
    // 真实值陆续到达：只替换 —，段结构不变
    assert.equal(
      T.turnHeaderLabel(T.filterVisibleMetrics({ durationMs: 6000, ttftMs: 800 })),
      '耗时6秒 · 首字0.8s · — token · — tok/s · 缓存—',
    )
    assert.equal(
      T.turnHeaderLabel(T.filterVisibleMetrics({ durationMs: 4000, ttftMs: 700, tokens: 8432, outputTokens: 8400, tokensPerSecond: 2100, cacheHitPercent: '91.42' })),
      '耗时4秒 · 首字0.7s · 8,432 token · 2100tok/s · 缓存91.42%',
    )
    setLang('en')
    assert.equal(
      T.turnHeaderLabel(T.filterVisibleMetrics({ durationMs: 3000 })),
      '3s · TTFT — · — tokens · — tok/s · Cache —',
    )
  })

  it('槽位不伪造：computeTurnMetrics 的 result 中未产生的字段在槽位渲染下是 —，不是 0 或假数', () => {
    setLang('zh-CN')
    // 运行中无 usage：tokens/ttft/tps/cache 全 undefined（官方真实数据缺失）→ 槽位 —
    const clock = { number: 1, startMs: 1000, endMs: undefined, status: 'open', reason: undefined, data: null, steps: [] }
    const metrics = T.computeTurnMetrics(clock, [], undefined, 4000)
    assert.equal(metrics.tokens, undefined)
    assert.equal(metrics.ttftMs, undefined)
    assert.equal(metrics.cacheHitPercent, undefined)
    const label = T.turnHeaderLabel(T.filterVisibleMetrics(metrics))
    assert.equal(label, '耗时3秒 · 首字— · — token · — tok/s · 缓存—')
    assert.ok(!/\d[\d,]*(?:\.\d+)?\s*token/.test(label), '不得出现伪造 token 数字：' + label)
  })

  it('turnStatusLabel：aborted→已停止 / error→运行失败 / max-tokens→已中断 / completed→无词', () => {
    setLang('zh-CN')
    assert.equal(T.turnStatusLabel('aborted'), '已停止')
    assert.equal(T.turnStatusLabel('error'), '运行失败')
    assert.equal(T.turnStatusLabel('max-tokens'), '已中断')
    assert.equal(T.turnStatusLabel('completed'), null)
    assert.equal(T.turnStatusLabel(undefined), null)
    setLang('en')
    assert.equal(T.turnStatusLabel('aborted'), 'Stopped')
    assert.equal(T.turnStatusLabel('error'), 'Failed')
  })

  it('turnRoundLabel', () => {
    setLang('zh-CN')
    assert.equal(T.turnRoundLabel(13), '第13轮')
    setLang('en')
    assert.equal(T.turnRoundLabel(13), 'Turn 13')
    assert.equal(T.turnRoundLabel(undefined), '')
  })
})

describe('字段显隐（filterVisibleMetrics + 持久化）', () => {
  it('隐藏字段被剔除；outputTokens（tok/s 计算用）始终保留', () => {
    T.setFieldVisible('tokens', false)
    const filtered = T.filterVisibleMetrics({ durationMs: 1000, tokens: 500, outputTokens: 100, cacheHitPercent: '50.00' })
    assert.equal(filtered.tokens, undefined)
    assert.ok(!('tokens' in filtered), '隐藏字段不得保留槽位（既不显示值也不显示 —）')
    assert.equal(filtered.outputTokens, 100)
    assert.equal(filtered.durationMs, 1000)
    assert.equal(filtered.cacheHitPercent, '50.00')
  })

  it('隐藏字段在槽位渲染下整段消失（不因占位加回）', () => {
    setLang('zh-CN')
    T.setFieldVisible('ttft', false)
    const label = T.turnHeaderLabel(T.filterVisibleMetrics({ durationMs: 8000, ttftMs: undefined, tokens: 12345, outputTokens: 11000, tokensPerSecond: 1800, cacheHitPercent: '88.12' }))
    assert.equal(label, '耗时8秒 · 12,345 token · 1800tok/s · 缓存88.12%')
    assert.ok(!label.includes('首字'), '关闭的 TTFT 字段不得出现（连 — 也不显示）')
    T.setFieldVisible('ttft', true)
  })

  it('全部隐藏时返回空对象（turnHeaderLabel → 空文案 → 调用方 fallback 兜底）', () => {
    for (const key of T.FIELD_KEYS) T.setFieldVisible(key, false)
    const metrics = { durationMs: 1000 }
    assert.deepEqual(T.filterVisibleMetrics(metrics), {})
    assert.equal(T.turnHeaderLabel(T.filterVisibleMetrics(metrics)), '')
    for (const key of T.FIELD_KEYS) T.setFieldVisible(key, true)
  })

  it('设置写入 localStorage（dsh-turn-fold:settings）', () => {
    T.setFieldVisible('tokens', false)
    T.setIconStyle('native')
    const raw = window.localStorage.getItem(T.SETTINGS_KEY)
    assert.ok(raw)
    const parsed = JSON.parse(raw)
    assert.equal(parsed.fields.tokens, false)
    assert.equal(parsed.iconStyle, 'native')
  })

  it('重新加载插件时从 localStorage 恢复', () => {
    T.setFieldVisible('tokens', false)
    T.setIconStyle('native')
    const { test: T2, window: win2 } = loadPlugin({ window })
    assert.equal(T2.settings.fields.tokens, false)
    assert.equal(T2.settings.iconStyle, 'native')
    assert.equal(T2.settings.fields.duration, true)
    assert.equal(win2, window)
    // 还原（后续测试依赖默认态）
    T2.setFieldVisible('tokens', true)
    T2.setIconStyle('poker')
    T2.setIconStyle('poker')
  })
})

// ══════════════════════════════════════════════════════════════════════
// durable Turn 指标（插件 projection "turnFoldMetrics"）与观察缓存
// ══════════════════════════════════════════════════════════════════════
// 背景：客户端 assistant 节点的 finalNode.timing.firstTokenTime 只由 live chunk
// 记录（官方 assistant.ts:146/154），刷新/历史重建后为 null —— TTFT 与 decode
// 分母同时消失。durable projection 由 host 按落盘事件折叠，reload 后仍在。
describe('durable Turn 指标（reload / 历史会话的数据来源）', () => {
  const closedClock = (steps) => ({ number: 13, startMs: T0, endMs: T1, status: 'closed', reason: 'completed', data: null, steps })

  it('settle 后客户端无 timing（历史重建形态）→ durable 提供 TTFT 与 decode TPS', () => {
    const noTiming = makeStepData(1, { usage: { outputTokens: 200 } })
    const metrics = T.computeTurnMetrics(closedClock([makeStep(1, noTiming, T0)]), [noTiming], undefined, undefined,
      { ttftMs: 4200, decodeMs: 2000, decodeTokens: 200 }, 'sess-1')
    assert.equal(metrics.ttftMs, 4200, 'TTFT 来自 durable（不是 —）')
    assert.equal(metrics.tokensPerSecond, 100, 'TPS = 200 tok / 2s')
  })

  it('durable 的 TTFT 优先于客户端 exact（同一谓词，但 durable 跨 reload 存在）', () => {
    const settled = makeStepData(1, {
      usage: { outputTokens: 200 },
      timing: { stepStartTime: T0, firstTokenTime: T0 + 800, completedTime: T0 + 3000 },
    })
    const metrics = T.computeTurnMetrics(closedClock([makeStep(1, settled, T0)]), [settled], undefined, undefined,
      { ttftMs: 750, decodeMs: 2200, decodeTokens: 200 }, 'sess-1')
    assert.equal(metrics.ttftMs, 750)
    assert.equal(metrics.tokensPerSecond, 200 / 2.2)
  })

  it('durable 只有 TTFT、没有 decode → TPS 仍由客户端 step 聚合（两者互补，不互相拖累）', () => {
    const settled = makeStepData(1, {
      usage: { outputTokens: 100 },
      timing: { stepStartTime: T0, firstTokenTime: T0 + 500, completedTime: T0 + 1500 },
    })
    const metrics = T.computeTurnMetrics(closedClock([makeStep(1, settled, T0)]), [settled], undefined, undefined,
      { ttftMs: 480, decodeMs: 0, decodeTokens: 0 }, 'sess-1')
    assert.equal(metrics.ttftMs, 480, 'durable 的 exact TTFT 生效')
    assert.equal(metrics.tokensPerSecond, 100, 'decode 回落到客户端聚合（100 tok / 1s）')
  })

  it('durable 缺失（旧宿主 / projection 未注册）→ 现有客户端路径完全不变', () => {
    const settled = makeStepData(1, {
      usage: { outputTokens: 100 },
      timing: { stepStartTime: T0, firstTokenTime: T0 + 800, completedTime: T0 + 1800 },
    })
    const metrics = T.computeTurnMetrics(closedClock([makeStep(1, settled, T0)]), [settled], undefined, undefined, undefined, 'sess-1')
    assert.equal(metrics.ttftMs, 800)
    assert.equal(metrics.tokensPerSecond, 100)
  })

  it('durable 只影响 TTFT / TPS：token 总数、缓存命中、耗时保持官方值', () => {
    const settled = makeStepData(1, { usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30 } })
    const base = { number: 13, startMs: T0, endMs: T1, status: 'closed', reason: 'completed', data: null, steps: [makeStep(1, settled, T0)] }
    const without = T.computeTurnMetrics(base, [settled], { tokenUsage: OFFICIAL_TOKEN_USAGE }, undefined, undefined, 'sess-1')
    const withDurable = T.computeTurnMetrics(base, [settled], { tokenUsage: OFFICIAL_TOKEN_USAGE }, undefined,
      { ttftMs: 123, decodeMs: 1000, decodeTokens: 77 }, 'sess-1')
    assert.equal(withDurable.tokens, without.tokens)
    assert.equal(withDurable.outputTokens, without.outputTokens)
    assert.equal(withDurable.cacheHitPercent, without.cacheHitPercent)
    assert.equal(withDurable.durationMs, without.durationMs)
  })

  it('selectDurableTurnMetrics 只取本回合那一条（不做整表订阅）', () => {
    const select = T.selectDurableTurnMetrics(13)
    const row13 = { ttftMs: 1, decodeMs: 2, decodeTokens: 3 }
    assert.equal(select({ turns: { 13: row13, 14: { decodeMs: 9, decodeTokens: 9 } } }), row13)
    assert.equal(select({ turns: {} }), undefined)
    assert.equal(select(undefined), undefined)
    assert.equal(T.selectDurableTurnMetrics(undefined)({ turns: { 13: row13 } }), undefined)
  })
})

describe('观察到的真实 TTFT 缓存（settle 后不无缘无故退回 —）', () => {
  const openClock = (steps) => ({ number: 13, startMs: T0, endMs: undefined, status: 'open', reason: undefined, data: null, steps })
  const closedClock = (steps) => ({ number: 13, startMs: T0, endMs: T1, status: 'closed', reason: 'completed', data: null, steps })

  it('running 观察到 provisional，settle 后 exact 与 durable 都缺失 → 继续显示该真实值', () => {
    const running = makeRunningStepData(1, { time: T0 + 1300 })
    const step1 = makeStep(1, running, T0 + 100)
    const first = T.computeTurnMetrics(openClock([step1]), [running], undefined, Date.now(), undefined, 'sess-9')
    assert.equal(first.ttftMs, 1200, 'provisional 可见首字延迟')
    // settle：客户端快照换成无 timing 的形态（历史重建），且 durable 不可用
    const noTiming = makeStepData(1, { usage: { outputTokens: 10 } })
    const second = T.computeTurnMetrics(closedClock([makeStep(1, noTiming, T0 + 100)]), [noTiming], undefined, undefined, undefined, 'sess-9')
    assert.equal(second.ttftMs, 1200, '不得退回 —（该值本次运行真实观察过）')
  })

  it('从未观察过该回合 → 保持 —（不估算、不插值、不跨回合借值）', () => {
    const noTiming = makeStepData(1, { usage: { outputTokens: 10 } })
    const metrics = T.computeTurnMetrics(closedClock([makeStep(1, noTiming, T0)]), [noTiming], undefined, undefined, undefined, 'sess-fresh')
    assert.equal(metrics.ttftMs, undefined)
    assert.equal(T.readObservedTtft('sess-fresh', 13), null)
  })

  it('durable 到达时用 durable（缓存不掩盖更新更全的来源）', () => {
    T.rememberObservedTtft('sess-10', 13, 1200)
    const noTiming = makeStepData(1, { usage: { outputTokens: 10 } })
    const metrics = T.computeTurnMetrics(closedClock([makeStep(1, noTiming, T0)]), [noTiming], undefined, undefined,
      { ttftMs: 900, decodeMs: 500, decodeTokens: 10 }, 'sess-10')
    assert.equal(metrics.ttftMs, 900)
  })

  it('缓存按 session + turn 隔离', () => {
    T.rememberObservedTtft('sess-a', 13, 111)
    assert.equal(T.readObservedTtft('sess-a', 13), 111)
    assert.equal(T.readObservedTtft('sess-a', 14), null)
    assert.equal(T.readObservedTtft('sess-b', 13), null)
    assert.equal(T.readObservedTtft(undefined, 13), null)
  })
})
