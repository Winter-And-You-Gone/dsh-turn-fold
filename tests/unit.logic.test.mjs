// 纯函数单测：官方真实数据 → 指标 / 文案（无任何随机或伪造成分）。
//   - turnClockOf / computeTurnMetrics / readStepUsage（官方 TurnLocation 契约）
//   - 格式化：耗时 / tok/s / token 千位分组 / 状态词 / 轮次
//   - 字段显隐过滤与 localStorage 持久化
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { loadPlugin } from './helpers/loader.mjs'
import {
  T0, T1, TURN13_USAGE_STEPS, TURN13_EXPECT, OFFICIAL_TOKEN_USAGE,
  makeStepData,
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
  T.settings.foldIcon = 'poker'
  T.settings.stepSkin = 'poker'
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
  const steps13 = TURN13_USAGE_STEPS.map((usage, i) => makeStepData(i + 1, {
    usage,
    // 第 1 步 TTFT = 4.9s（官方 finalNode.timing 语义）
    timing: i === 0 ? { stepStartTime: T0 + 100, firstTokenTime: T0 + 5000 } : undefined,
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
    // tok/s = 真实输出 / 真实耗时 = 3273 / 1354.551s ≈ 2.4
    assert.equal(T.formatTokPerSec(metrics.tokensPerSecond), '2.4')
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

  it('运行中：耗时用 liveNow 实时补足；tok/s 仅在耗时 ≥1s 且已有输出时出现', () => {
    const clock = {
      number: 3, startMs: 1000, endMs: undefined, status: 'open', reason: undefined,
      data: null, steps: [],
    }
    const live = T.computeTurnMetrics(clock, [makeStepData(1, { usage: { inputTokens: 1000, outputTokens: 3214, cacheReadTokens: 2000 } })], undefined, 14000)
    assert.equal(live.durationMs, 13000)
    assert.equal(live.tokens, 6214)
    assert.equal(live.outputTokens, 3214)
    assert.equal(live.cacheHitPercent, '66.67')
    assert.ok(live.tokensPerSecond > 0)

    const early = T.computeTurnMetrics({ ...clock, startMs: 13000 }, [makeStepData(1, { usage: { outputTokens: 10 } })], undefined, 13500)
    assert.equal(early.durationMs, 500)
    assert.equal(early.tokensPerSecond, undefined) // <1s 不显示瞬时速率
  })

  it('同一数据对象重复出现只累加一次（引用去重）', () => {
    const acc = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, has: false, ttft: null, ttftStep: Infinity, counted: new Set() }
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
    assert.equal(filtered.outputTokens, 100)
    assert.equal(filtered.durationMs, 1000)
    assert.equal(filtered.cacheHitPercent, '50.00')
  })

  it('全部隐藏时返回原对象（文案兜底）', () => {
    for (const key of T.FIELD_KEYS) T.setFieldVisible(key, false)
    const metrics = { durationMs: 1000 }
    assert.equal(T.filterVisibleMetrics(metrics), metrics)
    for (const key of T.FIELD_KEYS) T.setFieldVisible(key, true)
  })

  it('设置写入 localStorage（dsh-turn-fold:settings）', () => {
    T.setFieldVisible('tokens', false)
    T.setFoldIconStyle('native')
    const raw = window.localStorage.getItem(T.SETTINGS_KEY)
    assert.ok(raw)
    const parsed = JSON.parse(raw)
    assert.equal(parsed.fields.tokens, false)
    assert.equal(parsed.foldIcon, 'native')
  })

  it('重新加载插件时从 localStorage 恢复', () => {
    T.setFieldVisible('tokens', false)
    T.setStepSkin('native')
    const { test: T2, window: win2 } = loadPlugin({ window })
    assert.equal(T2.settings.fields.tokens, false)
    assert.equal(T2.settings.stepSkin, 'native')
    assert.equal(T2.settings.fields.duration, true)
    assert.equal(win2, window)
    // 还原（后续测试依赖默认态）
    T2.setFieldVisible('tokens', true)
    T2.setStepSkin('poker')
    T2.setFoldIconStyle('poker')
  })
})
