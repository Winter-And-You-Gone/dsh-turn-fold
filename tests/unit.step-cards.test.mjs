// Step 牌数（Process Group tool call count → 3 / 5 张牌）测试。
//
// 契约（用户规则）：
//   本 Process Group 的 toolCallCount = Σ 官方 summary.counts[].count（求和，不是 length）
//     ≤ 3 → 3 张牌；≥ 4 → 5 张牌
//   取不到 / 形状异常 / 旧宿主 → 5 张（安全 fallback，绝不猜 3 张）
//
// 数据路径（全部官方现成 API，只读）：
//   props.useConversation（官方 SessionStandardProps，ui-conversation 经
//     ctx.uiSession.provide({hooks:['conversation']}) 下发）
//   → ConversationSnapshot.views.grouped('chat')
//   → ConversationGroupedView.entries / groupSource(key)
//   → GroupSnapshot<ProcessGroupData>.data.summary.counts
// 出口 = 官方 DOM 事实 data-chat-group-key 上的视觉选择器（不写官方 DOM、不改官方属性）。
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { loadPlugin } from './helpers/loader.mjs'
import { TURN13_STEP_TIMINGS, TURN13_USAGE_STEPS, TURN13_EXPECT_TPS, makeStepData } from './helpers/fixtures.mjs'

const require = createRequire(import.meta.url)

// ── 全局 jsdom 环境（与其它测试文件共享单例） ──
import dom, { sharedWindow, sharedDocument } from './helpers/dom.mjs'

const { test: T } = loadPlugin({ window: sharedWindow })
const react = require('react')

function skinCss() {
  const tag = sharedDocument.querySelector('style[data-plugin-css="' + T.SKIN_CSS_ID + '"]')
  assert.ok(tag, '皮肤样式表已注入')
  return tag.textContent
}
function cardRulesCss() {
  const tag = sharedDocument.querySelector('style[data-plugin-css="' + T.STEP_CARD_CSS_ID + '"]')
  assert.ok(tag, '牌数桥样式表已注入')
  return tag.textContent
}
function decodeMask(uri) {
  const m = String(uri).match(/url\("data:image\/svg\+xml,([^"]+)"\)/)
  assert.ok(m, 'mask 应为 data-URI')
  return decodeURIComponent(m[1])
}
/** 从「组根宿主选择器」（可 matches 的形态）取出真实牌层变换表。 */
function layerTransformsOf(svg) {
  return [...svg.matchAll(/<g mask="url\(#scc-m\d\)"><g transform="([^"]+)">/g)].map((m) => m[1])
}

// ══════════════════════════════════════════════════════════════════════
// A. counts → 牌数（官方 summary.counts 求和）
// ══════════════════════════════════════════════════════════════════════
describe('Step 牌数 A：官方 counts 求和 → 3/5 张', () => {
  const snapshotOf = (counts) => ({ key: 'k', members: [], data: { turn: 1, closed: true, summary: { counts, running: undefined, runningDetail: '' } } })

  it('0 tool（counts=[]）→ 3 张', () => {
    assert.equal(T.stepCardToolCallCount([]), 0)
    assert.equal(T.stepCardCountOfGroup(snapshotOf([])), 3)
  })
  it('1 tool → 3 张', () => {
    assert.equal(T.stepCardCountOfGroup(snapshotOf([{ kind: 'read', count: 1 }])), 3)
  })
  it('2 tools → 3 张', () => {
    assert.equal(T.stepCardCountOfGroup(snapshotOf([{ kind: 'read', count: 2 }])), 3)
  })
  it('3 tools → 3 张（边界）', () => {
    assert.equal(T.stepCardCountOfGroup(snapshotOf([{ kind: 'read', count: 3 }])), 3)
  })
  it('4 tools → 5 张（边界）', () => {
    assert.equal(T.stepCardCountOfGroup(snapshotOf([{ kind: 'read', count: 4 }])), 5)
  })
  it('8 tools → 5 张', () => {
    assert.equal(T.stepCardCountOfGroup(snapshotOf([{ kind: 'edit', count: 8 }])), 5)
  })
  it('多 activity 求和而不是 counts.length：[{read:2},{edit:1}] → 3 张', () => {
    const counts = [{ kind: 'read', count: 2 }, { kind: 'edit', count: 1 }]
    assert.equal(counts.length, 2, 'counts.length 是 2——若误用 length 会得 3 张的巧合')
    assert.equal(T.stepCardToolCallCount(counts), 3)
    assert.equal(T.stepCardCountOfGroup(snapshotOf(counts)), 3)
  })
  it('多 activity 求和：[{read:2},{edit:2}] → 4 → 5 张（length=2 会误判 3 张）', () => {
    const counts = [{ kind: 'read', count: 2 }, { kind: 'edit', count: 2 }]
    assert.equal(T.stepCardToolCallCount(counts), 4)
    assert.equal(T.stepCardCountOfGroup(snapshotOf(counts)), 5)
  })
  it('group data 缺失 / 形状异常 → undefined（调用方回落 5 张，绝不猜 3 张）', () => {
    for (const bad of [undefined, null, {}, { data: {} }, { data: { summary: {} } },
      { data: { summary: { counts: null } } },
      { data: { summary: { counts: [{ kind: 'read', count: -1 }] } } },
      { data: { summary: { counts: [{ kind: 'read', count: '2' }] } } }]) {
      assert.equal(T.stepCardCountOfGroup(bad), undefined, '形状异常必须 undefined：' + JSON.stringify(bad))
    }
  })
  it('阈值常量与规则一致：≤3 → 3 张、≥4 → 5 张', () => {
    assert.equal(T.STEP_CARD_SMALL_MAX, 3)
    assert.equal(T.STEP_CARD_COUNT_SMALL, 3)
    assert.equal(T.STEP_CARD_COUNT_LARGE, 5)
  })
})

// ══════════════════════════════════════════════════════════════════════
// B. 几何：3 张必须是真正 3 张（复用 pokerTransforms(3, …)）
// ══════════════════════════════════════════════════════════════════════
describe('Step 牌数 B：3 张几何 = Turn 栏 3 张同一设计系统', () => {
  it('3 张 closed：三层真实牌 = pokerTransforms(3, false) 逐值一致，且只有 3 层', () => {
    const svg = decodeMask(T.stepCompletedGroupMask(3, false))
    const layers = layerTransformsOf(svg)
    const tfs = T.pokerTransforms(3, false)
    assert.equal(layers.length, 3, '必须真正 3 张（不是画 5 张藏 2 张）')
    for (let i = 1; i <= 3; i++) assert.equal(layers[i - 1], tfs[i], 'card' + i + ' = stack3 变换')
    assert.equal((svg.match(/id="scc-g\d"/g) || []).length, 3, '3 个真实牌 glyph')
    assert.equal((svg.match(/<mask /g) || []).length, 3, '3 个遮挡 mask')
    assert.ok(!svg.includes('scc-g4') && !svg.includes('scc-g5'), '不得残留第 4/5 张牌')
  })
  it('3 张 open：三层真实牌 = pokerTransforms(3, true) 逐值一致（±26° 扇形）', () => {
    const svg = decodeMask(T.stepCompletedGroupMask(3, true))
    const layers = layerTransformsOf(svg)
    const tfs = T.pokerTransforms(3, true)
    assert.equal(layers.length, 3)
    for (let i = 1; i <= 3; i++) assert.equal(layers[i - 1], tfs[i], 'card' + i + ' = fan3 变换')
    assert.equal(layers.filter((t) => t.includes('rotate(')).length, 2, 'fan3 = 两侧各 ±26°、中间牌不转')
    assert.ok(layers.some((t) => t.includes('rotate(-26 8 12)')) && layers.some((t) => t.includes('rotate(26 8 12)')), '扇角必须复用 fan3 真实数据')
  })
  it('3 张几何参数与 Turn 栏 3 张同源：hThree=8.5 / y=3.5 / pipScaleThree', () => {
    const svg = decodeMask(T.stepCompletedGroupMask(3, false))
    assert.ok(svg.includes('height="8.5"'), '牌高取 hThree')
    assert.ok(svg.includes('y="3.5"'), '3 张牌 y 取 3.5')
    const scale = /scale\((0\.28\d*)\)/.exec(svg)
    assert.ok(scale && Math.abs(Number(scale[1]) - 0.28) < 1e-6, '花色点缩放取 pipScaleThree=0.28')
  })
  it('5 张几何零回归：仍是 hFive=8 / y=4 / pipScaleFive / stack5·fan5', () => {
    for (const fan of [false, true]) {
      const svg = decodeMask(T.stepCompletedGroupMask(5, fan))
      const layers = layerTransformsOf(svg)
      const tfs = T.pokerTransforms(5, fan)
      assert.equal(layers.length, 5, '5 张仍是 5 层')
      for (let i = 1; i <= 5; i++) assert.equal(layers[i - 1], tfs[i], 'card' + i + ' = stack5/fan5 原值')
      assert.ok(svg.includes('height="8"') && svg.includes('y="4"'), '5 张仍取 hFive/y=4')
    }
    const stack5 = decodeMask(T.stepCompletedGroupMask(5, false))
    assert.ok(/scale\(0\.24\d*\)/.test(stack5), '花色点缩放仍是 pipScaleFive=0.24')
  })
  it('牌面 = 运行态轮换序列前缀（diamond→club→spade），未新建 Step 专属牌面池', () => {
    const svg = decodeMask(T.stepCompletedGroupMask(3, false))
    const order = ['diamond', 'club', 'spade', 'heart', 'deepseek']
    assert.ok(order.slice(0, 3).every((suit) => svg.includes(T.POKER_PIPS[suit].path) ||
      svg.includes(String(T.POKER_SPIN_DEEPSEEK).slice(0, 40).replace(/id="[^"]*"/, '')) ||
      svg.includes('M23.748 4.482')), '3 张牌面应取轮换序列前 3 张的既有花色数据')
  })
})

// ══════════════════════════════════════════════════════════════════════
// C. Knockout：3 张也必须真遮挡
// ══════════════════════════════════════════════════════════════════════
describe('Step 牌数 C：3 张 knockout 完整', () => {
  it('owner 只被 z 更高的牌挖（3 张）：owner1 有 2 个 occluder、owner2 有 1 个、owner3 有 0 个', () => {
    for (const fan of [false, true]) {
      const svg = decodeMask(T.stepCompletedGroupMask(3, fan))
      const masks = [...svg.matchAll(/<mask id="scc-m(\d)"[\s\S]*?<\/mask>/g)]
      assert.equal(masks.length, 3, '3 张 owner 各一个 mask（fan=' + fan + '）')
      for (const m of masks) {
        const owner = Number(m[1])
        const cuts = [...m[0].matchAll(/<g transform="([^"]+)">/g)].filter((x) => !x[1].includes('scale('))
        assert.equal(cuts.length, 3 - owner, 'owner ' + owner + ' 只被 z 更高者挖')
      }
    }
  })
  it('5 张 knockout 零回归：owner i 被 5-i 张挖、mask 数 5', () => {
    for (const fan of [false, true]) {
      const svg = decodeMask(T.stepCompletedGroupMask(5, fan))
      const masks = [...svg.matchAll(/<mask id="scc-m(\d)"[\s\S]*?<\/mask>/g)]
      assert.equal(masks.length, 5)
      for (const m of masks) {
        const owner = Number(m[1])
        const cuts = [...m[0].matchAll(/<g transform="([^"]+)">/g)].filter((x) => !x[1].includes('scale('))
        assert.equal(cuts.length, 5 - owner, 'owner ' + owner + ' 只被 z 更高者挖')
      }
    }
  })
  it('3 张 occluder 是实心黑牌面（fill=#000 + stroke=#000，按 3 张几何）', () => {
    const svg = decodeMask(T.stepCompletedGroupMask(3, true))
    const mask1 = svg.match(/<mask id="scc-m1"[\s\S]*?<\/mask>/)[0]
    const occ = [...mask1.matchAll(/<rect x="[\d.]+" y="3\.5" width="[\d.]+" height="8\.5" rx="1\.08" fill="#000" stroke="#000" stroke-width="0\.7"\/>/g)]
    assert.equal(occ.length, 2, 'owner-1 的 2 个 occluder 必须是实心黑 3 张牌面')
  })
  it('5 张 occluder 仍是实心黑 5 张牌面（零回归）', () => {
    const svg = decodeMask(T.stepCompletedGroupMask(5, true))
    const mask1 = svg.match(/<mask id="scc-m1"[\s\S]*?<\/mask>/)[0]
    const occ = [...mask1.matchAll(/<rect x="5\.14\d*" y="4" width="5\.71\d*" height="8" rx="1\.08" fill="#000" stroke="#000" stroke-width="0\.7"\/>/g)]
    assert.equal(occ.length, 4)
  })
  it('下层 stroke/pip 不穿透：mask 内不得用 <use>（Chromium 不渲染导致 occluder 丢失）；真实牌 rect 一律 fill=none', () => {
    for (const count of [3, 5]) {
      for (const fan of [false, true]) {
        const svg = decodeMask(T.stepCompletedGroupMask(count, fan))
        const masks = [...svg.matchAll(/<mask id="scc-m\d"[\s\S]*?<\/mask>/g)]
        for (const m of masks) {
          assert.ok(!m[0].includes('<use'), count + ' 张 mask 内容不得使用 <use>（owner ' + m[1] + '）')
        }
        const defsPart = svg.slice(0, svg.indexOf('<mask '))
        for (const rect of defsPart.matchAll(/<rect [^/]*\/>/g)) {
          assert.ok(rect[0].includes('fill="none"'), '真实牌 rect 必须透明卡面：' + rect[0].slice(0, 60))
        }
      }
    }
  })
})

// ══════════════════════════════════════════════════════════════════════
// D. Morph：3 张也必须是 16 帧、端点精确
// ══════════════════════════════════════════════════════════════════════
describe('Step 牌数 D：3 张 morph 与 5 张同规格（16 帧 / 400ms）', () => {
  const frameCount = (kf) => (kf.match(/mask-image:/g) || []).length
  it('3 张双向 keyframes：0% 端点 + 16 中间帧（与 5 张同帧数）', () => {
    for (const [name, from, to] of [['tf-step-open-3', 0, 1], ['tf-step-close-3', 1, 0]]) {
      const kf = T.stepMorphKeyframes(name, 3, from === 1)
      assert.ok(kf.startsWith('@keyframes ' + name + '{'), '3 张 keyframes 名字：' + name)
      assert.equal(frameCount(kf), 17, name + ' 必须 1 端点 + 16 中间帧')
      assert.ok(!/100%\{/.test(kf), name + ' 100% 必须省略（回落常驻端点）')
      const fromMask = T.stepCompletedGroupMask(3, from === 1)
      assert.ok(kf.includes('0%{mask-image:' + fromMask + '}'), name + ' 0% 必须等于出发端点')
      for (let k = 1; k <= 16; k++) {
        assert.ok(kf.includes((k * 100 / 17).toFixed(6) + '%{mask-image:url("data:image/svg+xml'), name + ' 帧 ' + k + ' 缺失')
      }
      // 末帧（k=16，u=16/17）几何 = stepMorphTransforms(3, stepMorphProgress(u, fromFan))
      const lastU = 16 / 17
      const lastUri = 'url("data:image/svg+xml,' + encodeURIComponent(
        T.stepCompletedGroupSvg(3, T.stepMorphTransforms(3, T.stepMorphProgress(lastU, from === 1)))) + '")'
      assert.ok(kf.includes((16 * 100 / 17).toFixed(6) + '%{mask-image:' + lastUri + '}'), name + ' 帧序列用 3 张插值几何')
      void to
    }
  })
  it('3 张 morph 端点逐值 = stack3 / fan3（复用同一插值公式）', () => {
    const zero = T.stepMorphTransforms(3, 0), one = T.stepMorphTransforms(3, 1)
    const stack = T.pokerTransforms(3, false), fan = T.pokerTransforms(3, true)
    for (let i = 1; i <= 3; i++) {
      const zt = /translate\(([-\d.]+), ([-\d.]+)\)/.exec(zero[i])
      const st = /translate\(([-\d.]+), ([-\d.]+)\)/.exec(stack[i])
      assert.ok(Math.abs(Number(zt[1]) - Number(st[1])) < 1e-6 && Math.abs(Number(zt[2]) - Number(st[2])) < 1e-6, 't=0 card' + i + ' = stack3')
      const ot = /translate\(([-\d.]+), ([-\d.]+)\)/.exec(one[i])
      const ft = /translate\(([-\d.]+), ([-\d.]+)\)/.exec(fan[i])
      assert.ok(Math.abs(Number(ot[1]) - Number(ft[1])) < 1e-6 && Math.abs(Number(ot[2]) - Number(ft[2])) < 1e-6, 't=1 card' + i + ' = fan3')
      const odeg = /rotate\(([-\d.]+) 8 12\)/.exec(one[i])
      const fdeg = /rotate\(([-\d.]+) 8 12\)/.exec(fan[i])
      if (!fdeg) assert.ok(!odeg || Math.abs(Number(odeg[1])) < 1e-6, 'fan3 中间牌无旋转')
      else assert.ok(odeg && Math.abs(Number(odeg[1]) - Number(fdeg[1])) < 1e-6, 't=1 card' + i + ' rotate = fan3')
    }
  })
  it('3 张每帧：真实牌与 occluder 同帧同变换（逐帧 knockout）', () => {
    const t = 0.5
    const tfs = T.stepMorphTransforms(3, t)
    const svg = decodeMask('url("data:image/svg+xml,' + encodeURIComponent(T.stepCompletedGroupSvg(3, tfs)) + '")')
    const layers = layerTransformsOf(svg)
    assert.equal(layers.length, 3)
    for (let i = 1; i <= 3; i++) assert.equal(layers[i - 1], tfs[i], '真实牌 card' + i + ' = 插值表')
    const mask1 = svg.match(/<mask id="scc-m1"[\s\S]*?<\/mask>/)[0]
    const occ = [...mask1.matchAll(/<g transform="([^"]+)">/g)].map((m) => m[1])
    assert.deepEqual(occ, [tfs[2], tfs[3]], 'owner-1 的 occluder 与同帧更高层同步')
    const midDeg = Number(/rotate\((-?[\d.]+) 8 12\)/.exec(tfs[1])[1])
    assert.ok(midDeg < 0 && midDeg > -26, '中间帧 card1 rotate 应在 (-26°,0°) 开区间：' + midDeg)
  })
  it('5 张 morph 零回归：仍 16 帧、端点 = stack5/fan5', () => {
    for (const [name, from] of [['tf-step-open', 0], ['tf-step-close', 1]]) {
      const kf = T.stepMorphKeyframes(name, 5, from === 1)
      assert.equal(frameCount(kf), 17)
      assert.ok(kf.includes('0%{mask-image:' + T.stepCompletedGroupMask(5, from === 1) + '}'))
    }
    const zero = T.stepMorphTransforms(5, 0), stack = T.pokerTransforms(5, false)
    for (let i = 1; i <= 5; i++) {
      const zt = /translate\(([-\d.]+), ([-\d.]+)\)/.exec(zero[i])
      const st = /translate\(([-\d.]+), ([-\d.]+)\)/.exec(stack[i])
      assert.ok(Math.abs(Number(zt[1]) - Number(st[1])) < 1e-6 && Math.abs(Number(zt[2]) - Number(st[2])) < 1e-6)
    }
  })
  it('皮肤表内同时存在 5 张与 3 张两套 keyframes（各 17 帧）', () => {
    const css = skinCss()
    for (const name of ['tf-step-open', 'tf-step-close', 'tf-step-open-3', 'tf-step-close-3']) {
      const line = css.split('\n').find((l) => l.includes('@keyframes ' + name + '{'))
      assert.ok(line, name + ' 缺失')
      assert.equal(frameCount(line), 17, name + ' 帧数必须 17（16 帧采样）')
    }
    // 3 张端点资产只声明一次（供逐组规则引用）
    const varLine = css.split('\n').find((l) => l.startsWith('[data-step-process]{--tf-stack-3:'))
    assert.ok(varLine && varLine.includes('--tf-fan-3:'), '3 张端点变量规则缺失')
    assert.equal((css.match(/--tf-stack-3:/g) || []).length, 1, '3 张 mask 数据 URI 只能声明一次')
  })
})

// ══════════════════════════════════════════════════════════════════════
// E. 桥：官方 group snapshot → [data-chat-group-key] 视觉选择器
// ══════════════════════════════════════════════════════════════════════
describe('Step 牌数 E：只读视觉桥', () => {
  const GROUP3 = '["process","node-a",null]'
  const GROUP5 = '["process","node-b",null]'
  function groupData(counts) {
    return { turn: 1, closed: true, summary: { counts, running: undefined, runningDetail: '' } }
  }
  function buildGrouped(entries, sources) {
    return { entries, groupSource: (key) => sources.get(key) }
  }
  function makeSource(initial) {
    let value = initial
    const listeners = new Set()
    return {
      getSnapshot: () => value,
      subscribe(l) { listeners.add(l); return () => { listeners.delete(l) } },
      set(next) { value = next; for (const l of [...listeners]) l() },
    }
  }
  function makeStore(initial) {
    let snap = initial
    const listeners = new Set()
    return {
      getSnapshot: () => snap,
      subscribe(l) { listeners.add(l); return () => { listeners.delete(l) } },
      set(next) { snap = next; for (const l of [...listeners]) l() },
    }
  }
  const entriesOf = (keys) => keys.map((key) => ({ kind: 'group', key }))

  it('纯函数：3 张组产出两条规则（牌堆 + 扇形）、5 张组不产出', () => {
    const css = T.buildStepCardRulesCss({ [GROUP3]: 3, [GROUP5]: 5 })
    const lines = css.split('\n').filter(Boolean)
    assert.equal(lines.length, 2, '只有 3 张组产出规则')
    assert.ok(lines[0].includes('[data-chat-group-key="' + T.cssAttrValue(GROUP3) + '"]'), '规则按官方 groupKey 定位')
    assert.ok(lines[0].includes('--tf-stack-3') && lines[0].includes('animation-name:tf-step-close-3'), '牌堆规则')
    assert.ok(lines[1].includes('--tf-fan-3') && lines[1].includes('animation-name:tf-step-open-3'), '扇形规则')
    assert.ok(lines[1].includes('[data-process-activity][aria-expanded="true"]'), '扇形规则挂在官方展开态上')
    for (const line of lines) {
      assert.ok(line.includes(':not(:has([data-shimmer="true"]))'), '规则必须排除 running（否则压掉五牌面轮换）')
      assert.ok(line.includes(':not(:has([data-text-shimmer="true"]))'), '双契约都要排除')
    }
    assert.ok(!css.includes(GROUP5), '5 张组不得产出任何覆盖规则（默认即 5 张）')
  })
  it('纯函数：空表 / null → 空 CSS（fallback 态）', () => {
    assert.equal(T.buildStepCardRulesCss({}), '')
    assert.equal(T.buildStepCardRulesCss(null), '')
    assert.equal(T.buildStepCardRulesCss({ [GROUP3]: undefined }), '')
  })
  it('groupKey CSS 转义：JSON 文本里的引号必须转义（否则选择器语法错误）', () => {
    const escaped = T.cssAttrValue(GROUP3)
    assert.equal(escaped, '[\\"process\\",\\"node-a\\",null]')
    const css = T.buildStepCardRulesCss({ [GROUP3]: 3 })
    assert.ok(css.includes('data-chat-group-key="' + escaped + '"'))
  })
  it('官方 DOM 命中：组根带 data-step-process + data-chat-group-key，生成的选择器能 matches', () => {
    const css = T.buildStepCardRulesCss({ [GROUP3]: 3 })
    const selectors = css.split('\n').filter(Boolean).map((l) => l.slice(0, l.indexOf('{')))
    const host = sharedDocument.createElement('div')
    host.setAttribute('data-step-process', '')
    host.setAttribute('data-chat-group-key', GROUP3)
    const button = sharedDocument.createElement('button')
    button.setAttribute('data-process-activity', 'edit')
    const icon = sharedDocument.createElement('span')
    icon.setAttribute('data-step-process-icon', '')
    button.appendChild(icon)
    host.appendChild(button)
    sharedDocument.body.appendChild(host)
    try {
      const hostSel = (sel) => sel.slice(0, sel.lastIndexOf(' [data-step-process-icon]::'))
      // 牌堆规则挂在组根（含 whole-group shimmer 排除），扇形规则挂在官方 header 按钮上
      const target = (sel) => (sel.includes('[data-process-activity]') ? button : host)
      assert.ok(target(selectors[0]).matches(hostSel(selectors[0])), '收起态应命中 3 张牌堆规则')
      assert.ok(!target(selectors[1]).matches(hostSel(selectors[1])), '收起态不得命中扇形规则')
      button.setAttribute('aria-expanded', 'true')
      assert.ok(target(selectors[1]).matches(hostSel(selectors[1])), '展开态应命中 3 张扇形规则')
      // running（官方 shimmer 在场）→ 两条规则都不得命中（轮换优先）
      const shimmer = sharedDocument.createElement('span')
      shimmer.setAttribute('data-shimmer', 'true')
      button.appendChild(shimmer)
      assert.ok(!target(selectors[0]).matches(hostSel(selectors[0])), 'running 不得命中牌堆规则')
      assert.ok(!target(selectors[1]).matches(hostSel(selectors[1])), 'running 不得命中扇形规则')
      // 别的组不受影响
      host.setAttribute('data-chat-group-key', GROUP5)
      shimmer.remove()
      assert.ok(!target(selectors[0]).matches(hostSel(selectors[0])), '其他 groupKey 不得命中')
    } finally { host.remove() }
  })

  // ── 全链路：React 订阅官方 group snapshot（fixture 复刻官方形状） ──
  let root = null, container = null
  beforeEach(() => {
    container = sharedDocument.createElement('div')
    sharedDocument.body.appendChild(container)
    root = createRoot(container)
    T.writeStepCardRules(null)
  })
  afterEach(() => {
    act(() => { root.unmount() })
    container.remove()
    T.writeStepCardRules(null)
  })
  function renderBridge(store, grouped) {
    const useConversation = (selector) => react.useSyncExternalStore(
      store.subscribe, () => selector(store.getSnapshot()))
    const snapshot = { views: { grouped: () => grouped } }
    const view = () => react.createElement(T.StepCardRulesBridge, { useConversation })
    act(() => { root.render(react.createElement(view)) })
    void snapshot
  }
  it('3 张组 → 写入覆盖规则；4 张组 → 不写（回落 5 张）', () => {
    const sources = new Map([
      [GROUP3, makeSource({ key: GROUP3, members: [], data: groupData([{ kind: 'read', count: 2 }, { kind: 'edit', count: 1 }]) })],
      [GROUP5, makeSource({ key: GROUP5, members: [], data: groupData([{ kind: 'read', count: 4 }]) })],
    ])
    const grouped = buildGrouped(entriesOf([GROUP3, GROUP5]), sources)
    const store = makeStore({ views: { grouped: () => grouped } })
    renderBridge(store, grouped)
    const css = cardRulesCss()
    assert.ok(css.includes('[data-chat-group-key="' + T.cssAttrValue(GROUP3) + '"]'), '3 张组规则已写入')
    assert.ok(css.includes('--tf-stack-3') && css.includes('--tf-fan-3'))
    assert.ok(!css.includes(T.cssAttrValue(GROUP5)), '4 张组不得写规则（默认 5 张）')
  })
  it('组数据实时更新：3 → 4 张工具时规则被撤下（回到 5 张 fallback）', () => {
    const src = makeSource({ key: GROUP3, members: [], data: groupData([{ kind: 'read', count: 3 }]) })
    const grouped = buildGrouped(entriesOf([GROUP3]), new Map([[GROUP3, src]]))
    const store = makeStore({ views: { grouped: () => grouped } })
    renderBridge(store, grouped)
    assert.ok(cardRulesCss().includes('[data-chat-group-key="'), '初始 3 张 → 有规则')
    act(() => { src.set({ key: GROUP3, members: [], data: groupData([{ kind: 'read', count: 4 }]) }) })
    assert.equal(cardRulesCss(), '', '变 4 张后规则必须撤下（不得残留 3 张）')
  })
  it('组消失（entries 移除）→ 规则撤下；组重新出现 → 规则恢复', () => {
    const src = makeSource({ key: GROUP3, members: [], data: groupData([{ kind: 'read', count: 1 }]) })
    const sources = new Map([[GROUP3, src]])
    const grouped = buildGrouped(entriesOf([GROUP3]), sources)
    const store = makeStore({ views: { grouped: () => grouped } })
    renderBridge(store, grouped)
    assert.ok(cardRulesCss().includes('[data-chat-group-key="'), '初始有规则')
    const gone = buildGrouped([], sources)
    act(() => { store.set({ views: { grouped: () => gone } }) })
    void grouped
    // 重新渲染以应用新 entries
    const useConversation = (selector) => react.useSyncExternalStore(store.subscribe, () => selector(store.getSnapshot()))
    act(() => { root.render(react.createElement(() => react.createElement(T.StepCardRulesBridge, { useConversation }))) })
    assert.equal(cardRulesCss(), '', '组消失后不得残留规则')
  })
  it('拿不到 group 源（旧宿主 / 无 useConversation）→ 不写任何规则 = 5 张 fallback', () => {
    act(() => { root.render(react.createElement(T.StepCardRulesBridge, {})) })
    assert.equal(cardRulesCss(), '', '无 useConversation 不得产出规则')
    const grouped = { entries: entriesOf([GROUP3]), groupSource: () => undefined }
    const store = makeStore({ views: { grouped: () => grouped } })
    renderBridge(store, grouped)
    assert.equal(cardRulesCss(), '', 'groupSource 缺席不得产出规则（绝不猜 3 张）')
  })
  it('leader 卸载 → 清空规则（回落安全态）', () => {
    const src = makeSource({ key: GROUP3, members: [], data: groupData([{ kind: 'read', count: 2 }]) })
    const grouped = buildGrouped(entriesOf([GROUP3]), new Map([[GROUP3, src]]))
    const store = makeStore({ views: { grouped: () => grouped } })
    renderBridge(store, grouped)
    assert.ok(cardRulesCss().includes('[data-chat-group-key="'), '先有规则')
    act(() => { root.unmount() })
    assert.equal(cardRulesCss(), '', 'leader 卸载必须清空规则')
    root = createRoot(container)
  })
  it('官方数据路径契约：只读 views.grouped("chat")（不重建 group store、不复制分组算法）', async () => {
    const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8'))
    assert.ok(src.includes('snapshot.views.grouped("chat")'), '必须走官方 ConversationViewSnapshotStore.grouped')
    for (const banned of ['MutationObserver', 'querySelectorAll("[data-chat-call-id]', 'setInterval(', 'requestAnimationFrame(']) {
      assert.ok(!src.includes(banned), '桥不得使用 ' + banned)
    }
  })
})

// ══════════════════════════════════════════════════════════════════════
// F. 回归：running / hover-focus / 双契约 / reduced-motion / Turn 栏
// ══════════════════════════════════════════════════════════════════════
describe('Step 牌数 F：零回归', () => {
  it('running 五牌面轮换未受影响（规则、相位、牌面顺序原样）', () => {
    const css = skinCss()
    const running = css.split('\n').find((l) => l.includes(':has([data-shimmer="true"]) [data-step-process-icon]::before{') && l.includes('-webkit-mask-image:url("data:image/svg+xml'))
    assert.ok(running, 'running 轮换规则缺失')
    const m = running.match(/-webkit-mask-image:url\("(data:image\/svg\+xml,[^"]+)"\)/)
    const svg = decodeURIComponent(m[1].slice('data:image/svg+xml,'.length))
    for (let n = 1; n <= 5; n++) assert.ok(svg.includes('<g id="phase-' + n + '">'), 'phase-' + n)
    assert.equal((svg.match(/type="rotate" values="/g) || []).length >= 20, true)
    assert.ok(svg.includes('id="card-deepseek"'), '五牌面（含鲸鱼）原样')
    // running 与 tool count 无关：规则本身不引用 --tf-stack-3/-fan-3
    assert.ok(!running.includes('--tf-stack-3') && !running.includes('--tf-fan-3'), 'running 动画必须与牌数无关')
  })
  it('运行中不受牌数影响：3 张组的桥规则被 shimmer 排除子句挡掉', () => {
    const css = T.buildStepCardRulesCss({ '["process","n",null]': 3 })
    const selectors = css.split('\n').filter(Boolean).map((l) => l.slice(0, l.indexOf('{')))
    for (const sel of selectors) {
      assert.ok(sel.includes(':not(:has([data-shimmer="true"]))') && sel.includes(':not(:has([data-text-shimmer="true"]))'))
    }
  })
  it('hover/focus 不让位逻辑未回归；visibility 总控原样', () => {
    const css = skinCss()
    assert.ok(!css.includes(':not(:hover)') && !css.includes(':not(:focus-visible)'), '不得出现 hover/focus 让位')
    assert.ok(css.includes('button[data-process-activity] [data-step-process-icon]{opacity:1}'), 'icon 恒显总控')
    assert.ok(css.includes('button[data-process-activity] [data-step-process-chevron]{opacity:0}'), 'chevron 恒隐总控')
  })
  it('双 shimmer 契约与 completed 双态规则原样（arm 未被牌数改动）', () => {
    const css = skinCss()
    assert.ok(css.includes('data-text-shimmer="true"') && css.includes('data-shimmer="true"'))
    const base = css.split('\n').find((l) => l.includes('[data-step-process-icon]::before{content:""'))
    assert.ok(base.includes('animation:tf-step-close .4s linear 1'), '默认（5 张）收起动画原样')
    const fan = css.split('\n').find((l) => l.includes('[aria-expanded="true"]') && l.includes('animation:tf-step-open .4s linear 1'))
    assert.ok(fan, '默认（5 张）展开动画原样')
  })
  it('reduced-motion：动画关闭规则原样；3 张覆盖只改 mask/animation-name，不需要额外媒体查询', () => {
    const css = skinCss()
    const rm = css.split('\n').filter((l) => l.includes('@media (prefers-reduced-motion:reduce)'))
    assert.ok(rm.some((l) => l.includes('animation:none') && l.includes('[data-step-process-icon]::before')), 'completed morph 关闭规则仍在')
    assert.ok(rm.some((l) => l.includes('mask-image:var(--tf-suit)')), 'running 静态回落仍在')
    // 3 张覆盖规则只写 mask-image / animation-name —— reduced-motion 的 animation:none
    // 在静态表、覆盖规则只改 mask 与动画名；animation:none 的层叠优先级更高（更晚的媒体块
    // 与覆盖规则同为长写属性，但 animation:none 是 shorthand 的 none→animation-name:none，
    // 覆盖规则会把它改回帧序名）。所以覆盖规则必须在 reduced-motion 下也不启动动画：
    const css3 = T.buildStepCardRulesCss({ k: 3 })
    assert.ok(!css3.includes('animation:'), '覆盖规则不得用 animation 简写（只允许 animation-name）')
  })
  it('Turn 栏扑克零改动：3/5 张变换表与 Turn 栏读数同源同值', () => {
    assert.deepEqual(T.pokerTransforms(3, false), { 1: 'translate(1, 2.25)', 2: 'translate(0, 0.25)', 3: 'translate(-1, -1.75)' })
    assert.deepEqual(Object.keys(T.pokerTransforms(5, true)).length, 5)
    assert.equal(T.POKER_R, 1.08)
  })
  it('TTFT/TPS 零回归：官方 timings fixture 的 TPS 仍为 ' + TURN13_EXPECT_TPS, () => {
    const steps = TURN13_USAGE_STEPS.map((usage, i) => {
      const timing = TURN13_STEP_TIMINGS[i]
      return { data: makeStepData(i + 1, { usage, timing }) }
    })
    void steps
    // 时间断言：官方 decode 语义（每步 completedTime - firstTokenTime）
    const decodeMs = TURN13_STEP_TIMINGS.reduce((sum, t) => sum + (t.completedTime - t.firstTokenTime), 0)
    const outTokens = TURN13_USAGE_STEPS.reduce((sum, u) => sum + u.outputTokens, 0)
    assert.equal(T.formatTokPerSec(outTokens / (decodeMs / 1000)), TURN13_EXPECT_TPS)
  })
})

// ══════════════════════════════════════════════════════════════════════
// G. morph easing 方向：close 必须是同一 easing 的镜像（1-E(u)），不是时间反转（E(1-u)）
// ══════════════════════════════════════════════════════════════════════
describe('Step 牌数 G：morph easing 方向对称', () => {
  const E = (x) => T.cssBezierEase(x)
  const U = (k) => k / (T.MORPH_FRAMES + 1)
  const num = (s, re) => { const m = re.exec(s); return m ? Number(m[1]) : 0 }
  const tx = (s) => num(s, /translate\(([-\d.]+)/)
  const ty = (s) => num(s, /translate\([-\d.]+, ([-\d.]+)\)/)
  const degOf = (s) => num(s, /rotate\(([-\d.]+) 8 12\)/)

  it('open 几何进度 = E(u)：u = 0 / .25 / .5 / .75 / 1 逐值', () => {
    assert.equal(T.stepMorphProgress(0, false), 0, 'u=0 → 0（stack）')
    for (const u of [0.25, 0.5, 0.75]) assert.equal(T.stepMorphProgress(u, false), E(u), 'u=' + u + ' → E(u)')
    assert.equal(T.stepMorphProgress(1, false), 1, 'u=1 → 1（fan）')
  })
  it('close 几何进度 = 1 - E(u)：u = 0 / .25 / .5 / .75 / 1 逐值', () => {
    assert.equal(T.stepMorphProgress(0, true), 1, 'u=0 → 1（fan）')
    for (const u of [0.25, 0.5, 0.75]) assert.equal(T.stepMorphProgress(u, true), 1 - E(u), 'u=' + u + ' → 1-E(u)')
    assert.equal(T.stepMorphProgress(1, true), 0, 'u=1 → 0（stack）')
  })
  it('close 不是时间反转：1-E(u) ≠ E(1-u)（多个中间点）', () => {
    for (const u of [0.25, 0.5, 0.75]) {
      assert.notEqual(T.stepMorphProgress(u, true), E(1 - u), 'u=' + u + ' 的 close 进度不得等于 E(1-u)')
    }
    // 差异的量级：u=0.25 时正确式已走掉 ~76%，时间反转只走掉 ~0.3%
    assert.ok(T.stepMorphProgress(0.25, true) < 0.3, 'close 前段应已走掉大半：' + T.stepMorphProgress(0.25, true))
    assert.ok(E(1 - 0.25) > 0.99, '（对照）时间反转式此时几乎没动：' + E(1 - 0.25))
  })
  it('手感对称：openProgress(u) + closeProgress(u) = 1（多采样点）', () => {
    for (const u of [0, 1 / 17, 0.25, 0.5, 0.75, 16 / 17, 1]) {
      assert.ok(Math.abs(T.stepMorphProgress(u, false) + T.stepMorphProgress(u, true) - 1) < 1e-12,
        'u=' + u + ' 两方向进度必须互补（同一 easing）')
    }
  })
  it('两个方向都"起步快、后段减速"：逐帧位移单调递减，且两方向首帧位移相同', () => {
    const deltasOf = (fromFan) => {
      const p0 = fromFan ? 1 : 0
      let prev = p0
      const out = []
      for (let k = 1; k <= T.MORPH_FRAMES; k++) {
        const p = T.stepMorphProgress(U(k), fromFan)
        out.push(Math.abs(p - prev))
        prev = p
      }
      return out
    }
    const open = deltasOf(false), close = deltasOf(true)
    for (const [label, deltas] of [['open', open], ['close', close]]) {
      for (const d of deltas) assert.ok(d > 0, label + ' 每帧都必须朝目标前进')
      for (let i = 1; i < deltas.length; i++) {
        assert.ok(deltas[i] <= deltas[i - 1] + 1e-12,
          label + ' 位移必须单调递减（起手最快、后段减速）：帧' + (i + 1) + ' ' + deltas[i] + ' > 帧' + i + ' ' + deltas[i - 1])
      }
      assert.ok(deltas[0] > 0.2, label + ' 首帧位移必须已很明显（≈24%）：' + deltas[0])
      assert.ok(deltas[deltas.length - 1] < 0.02, label + ' 末帧位移必须很小（平滑收尾）：' + deltas[deltas.length - 1])
    }
    assert.ok(Math.abs(open[0] - close[0]) < 1e-12, 'open / close 首帧位移必须相同')
    assert.ok(Math.abs(open[8] - close[8]) < 1e-12, 'open / close 中段位移必须相同')
    // 对照：旧实现（时间反转 E(1-u)）的首帧位移几乎为 0 —— 这就是"收起前段偏慢"的根因
    assert.ok(Math.abs((1 - E(16 / 17)) - 0) < 0.01, '（对照）时间反转式首帧几乎不动：' + (1 - E(16 / 17)))
  })
  it('几何 helper 不再偷偷做 easing：progress=0.5 恰为端点中点（不是 E(0.5)）', () => {
    for (const count of [3, 5]) {
      const stack = T.pokerTransforms(count, false), fan = T.pokerTransforms(count, true)
      const mid = T.stepMorphTransforms(count, 0.5)
      for (let i = 1; i <= count; i++) {
        const wantX = (tx(stack[i]) + tx(fan[i])) / 2, wantY = (ty(stack[i]) + ty(fan[i])) / 2
        assert.ok(Math.abs(tx(mid[i]) - wantX) < 1e-3, 'count=' + count + ' card' + i + ' tx 必须线性中点')
        assert.ok(Math.abs(ty(mid[i]) - wantY) < 1e-3, 'count=' + count + ' card' + i + ' ty 必须线性中点')
      }
      // 若 helper 里仍套 easing，mid 会落在 E(0.5)≈0.961 处（远离中点）
      assert.ok(Math.abs(E(0.5) - 0.5) > 0.4, '（对照）E(0.5) 明显偏离线性中点')
    }
  })
  it('端点：open 起点 stack3/5、终点 fan3/5；close 起点 fan3/5、终点 stack3/5', () => {
    for (const count of [3, 5]) {
      const stack = T.pokerTransforms(count, false), fan = T.pokerTransforms(count, true)
      const atStack = T.stepMorphTransforms(count, 0), atFan = T.stepMorphTransforms(count, 1)
      for (let i = 1; i <= count; i++) {
        assert.equal(atStack[i], 'translate(' + tx(stack[i]).toFixed(3) + ', ' + ty(stack[i]).toFixed(3) + ')',
          count + ' 张 progress=0 必须是 stack')
        assert.ok(Math.abs(degOf(atStack[i])) < 1e-9, 'stack 端点不得带旋转')
        assert.ok(Math.abs(tx(atFan[i]) - tx(fan[i])) < 1e-3 && Math.abs(ty(atFan[i]) - ty(fan[i])) < 1e-3,
          count + ' 张 progress=1 的 translate 必须是 fan')
        assert.ok(Math.abs(degOf(atFan[i]) - degOf(fan[i])) < 1e-3, count + ' 张 progress=1 的 rotate 必须是 fan')
      }
      // 端点映射：open 0→1 / close 1→0
      assert.equal(T.stepMorphProgress(0, false), 0)
      assert.equal(T.stepMorphProgress(1, false), 1)
      assert.equal(T.stepMorphProgress(0, true), 1)
      assert.equal(T.stepMorphProgress(1, true), 0)
    }
  })
  it('keyframes 层：0% = 出发点端点，末帧已贴近目标端点，100% 仍省略', () => {
    for (const count of [3, 5]) {
      for (const fromFan of [false, true]) {
        const name = 'kf-probe-' + count + '-' + fromFan
        const kf = T.stepMorphKeyframes(name, count, fromFan)
        assert.ok(kf.includes('0%{mask-image:' + T.stepCompletedGroupMask(count, fromFan) + '}'),
          name + ' 0% 必须是出发点端点（open=stack / close=fan）')
        assert.ok(!/100%\{/.test(kf), name + ' 100% 仍省略（回落常驻端点，freeze 语义不变）')
        const lastProgress = T.stepMorphProgress(16 / 17, fromFan)
        const target = fromFan ? 0 : 1
        assert.ok(Math.abs(lastProgress - target) < 0.01, name + ' 末帧必须已贴近目标端点：' + lastProgress)
        assert.equal((kf.match(/mask-image:/g) || []).length, 17, name + ' 必须仍是 1 端点 + 16 中间帧')
      }
    }
    assert.equal(T.MORPH_FRAMES, 16, 'MORPH_FRAMES 必须仍是 16')
  })
  it('close 方向的帧内 knockout 仍逐帧同步（几何改了，遮挡必须跟着改）', () => {
    for (const count of [3, 5]) {
      for (const k of [3, 9, 16]) {
        const progress = T.stepMorphProgress(k / 17, true)
        const tfs = T.stepMorphTransforms(count, progress)
        const svg = decodeMask('url("data:image/svg+xml,' + encodeURIComponent(T.stepCompletedGroupSvg(count, tfs)) + '")')
        const layers = layerTransformsOf(svg)
        assert.equal(layers.length, count, count + ' 张 close 帧真实牌层数')
        for (let i = 1; i <= count; i++) assert.equal(layers[i - 1], tfs[i], '真实牌 card' + i + ' = 该帧几何')
        const mask1 = svg.match(/<mask id="scc-m1"[\s\S]*?<\/mask>/)[0]
        const occ = [...mask1.matchAll(/<g transform="([^"]+)">/g)].map((m) => m[1])
        for (let j = 2; j <= count; j++) {
          assert.equal(occ[j - 2], tfs[j], 'owner-1 的 occluder 必须与同帧 card' + j + ' 同步')
        }
      }
    }
  })
  it('动画时长与 easing 来源不变：皮肤里仍是 .4s linear，且 keyframes 不含额外缓动', () => {
    const css = skinCss()
    const base = css.split('\n').find((l) => l.includes('[data-step-process-icon]::before{content:""'))
    assert.ok(base.includes('animation:tf-step-close .4s linear 1'), 'closed 收拢仍是 400ms linear')
    const fan = css.split('\n').find((l) => l.includes('[aria-expanded="true"]') && l.includes('animation:tf-step-open .4s linear 1'))
    assert.ok(fan, 'open 展开仍是 400ms linear')
    for (const name of ['tf-step-open', 'tf-step-close', 'tf-step-open-3', 'tf-step-close-3']) {
      const line = css.split('\n').find((l) => l.includes('@keyframes ' + name + '{'))
      assert.ok(line, name + ' 缺失')
      assert.ok(!line.includes('animation-timing-function'), name + ' 不得在帧内再叠加缓动（easing 已进位姿采样）')
    }
  })
})
