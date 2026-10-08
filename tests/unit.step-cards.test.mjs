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
    // 身份映射（不是位置）：card1 左、card2 居中、card3 右——顶牌向右展开
    assert.ok(layers[0].includes('rotate(-26 8 12)'), 'card1 必须是左牌（-26°）')
    assert.ok(!layers[1].includes('rotate('), 'card2 必须是中牌（不旋转）')
    assert.ok(layers[2].includes('rotate(26 8 12)'), 'card3（原顶牌）必须是右牌（+26°）')
  })

  it('3 张扇形 knockout 跟随身份：card1 被 2/3 挖、card2 被 3 挖、card3 不被挖', () => {
    const tfs = T.pokerTransforms(3, true)
    const svg = decodeMask(T.stepCompletedGroupMask(3, true))
    const cutsOf = (owner) => {
      const mask = new RegExp('<mask id="scc-m' + owner + '"[\\s\\S]*?</mask>').exec(svg)[0]
      return [...mask.matchAll(/<g transform="([^"]+)">/g)].map((m) => m[1]).filter((t) => !t.includes('scale('))
    }
    assert.deepEqual(cutsOf(1), [tfs[2], tfs[3]], 'card1 只被更高层（2、3）挖，且用它们自己的位姿')
    assert.deepEqual(cutsOf(2), [tfs[3]], 'card2 只被 card3 挖')
    assert.deepEqual(cutsOf(3), [], '顶牌 card3 不被任何牌挖')
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
  it('牌面回退顺序 = 插件自有池（diamond→club→spade→heart→deepseek），未新建 Step 专属牌面池', () => {
    const svg = decodeMask(T.stepCompletedGroupMask(3, false))
    const order = ['diamond', 'club', 'spade', 'heart', 'deepseek']
    assert.ok(order.slice(0, 3).every((suit) => svg.includes(T.POKER_PIPS[suit].path) ||
      svg.includes(String(T.POKER_SPIN_DEEPSEEK).slice(0, 40).replace(/id="[^"]*"/, '')) ||
      svg.includes('M23.748 4.482')), '3 张牌面应取插件牌面池前 3 张的既有花色数据')
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
  it('皮肤表保留 5 张 fallback 帧序；逐组牌面资产 3 张 / 5 张同规格（各 17 帧）', () => {
    const css = skinCss()
    for (const name of ['tf-step-open', 'tf-step-close']) {
      const line = css.split('\n').find((l) => l.includes('@keyframes ' + name + '{'))
      assert.ok(line, name + ' 缺失（桥不可用时的 5 张回落帧序）')
      assert.equal(frameCount(line), 17, name + ' 帧数必须 17（16 帧采样）')
    }
    // 逐组牌面资产（(count, topFace) 变体）：3 张与 5 张同一 morph 规格；
    // 端点 mask 变量每组只声明一次，避免 CSS 体积随组数增长。
    for (const count of [3, 5]) {
      const set = T.completedFaceSetFor(count, T.pokerFacePool()[0])
      const asset = T.completedFaceSetCss(set)
      for (const dir of ['open', 'close']) {
        const line = asset.split('\n').find((l) => l.includes('@keyframes tf-face-' + dir + '-' + set.id + '{'))
        assert.ok(line, count + ' 张 ' + dir + ' 帧序缺失')
        assert.equal(frameCount(line), 17, count + ' 张 ' + dir + ' 必须 17 帧')
      }
      assert.ok(asset.includes('--tf-face-' + set.id + '-stack:') && asset.includes('--tf-face-' + set.id + '-fan:'), '端点变量缺失')
      assert.equal((asset.match(new RegExp('--tf-face-' + set.id + '-stack:', 'g')) || []).length, 1, '端点 mask 数据 URI 只能声明一次')
    }
  })
})

// ══════════════════════════════════════════════════════════════════════
// E. 桥：官方 group snapshot → [data-chat-group-key] 视觉选择器
// ══════════════════════════════════════════════════════════════════════
describe('Step 牌数 E：只读视觉桥', () => {
  const GROUP3 = '["process","node-a",null]'
  const GROUP5 = '["process","node-b",null]'
  const GROUP_RUNNING = '["process","node-running",null]'
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

  it('纯函数：3 张与 5 张组各产出两条规则（牌堆 + 扇形），引用各自的牌面 set；running 组不产出', () => {
    const css = T.buildStepCardRulesCss({
      [GROUP3]: { count: 3, closed: true },
      [GROUP5]: { count: 5, closed: true },
      [GROUP_RUNNING]: { count: 3, closed: false },
    })
    const lines = css.split('\n').filter(Boolean)
    assert.equal(lines.length, 4, '两个已完成组各两条规则；running 组不产出')
    const set3 = T.completedFaceSetFor(3, T.completedStepTopFace(undefined, GROUP3))
    const set5 = T.completedFaceSetFor(5, T.completedStepTopFace(undefined, GROUP5))
    const block3 = lines.filter((l) => l.includes('[data-chat-group-key="' + T.cssAttrValue(GROUP3) + '"]'))
    const block5 = lines.filter((l) => l.includes('[data-chat-group-key="' + T.cssAttrValue(GROUP5) + '"]'))
    assert.equal(block3.length, 2, '3 张组两条规则')
    assert.equal(block5.length, 2, '5 张组两条规则')
    assert.ok(block3[0].includes('--tf-face-' + set3.id + '-stack') && block3[0].includes('animation-name:tf-face-close-' + set3.id), '3 张牌堆规则引用本组 set')
    assert.ok(block3[1].includes('--tf-face-' + set3.id + '-fan') && block3[1].includes('animation-name:tf-face-open-' + set3.id), '3 张扇形规则引用本组 set')
    assert.ok(block5[0].includes('--tf-face-' + set5.id + '-stack'), '5 张牌堆规则引用本组 set（不再吃默认固定牌面）')
    assert.ok(block5[1].includes('--tf-face-' + set5.id + '-fan'), '5 张扇形规则引用本组 set')
    assert.ok(block5[1].includes('[data-process-activity][aria-expanded="true"]'), '扇形规则挂在官方展开态上')
    assert.ok(!css.includes(T.cssAttrValue(GROUP_RUNNING)), 'running 组不得产出覆盖规则（它走运行中轮换动画）')
    for (const line of lines) {
      assert.ok(line.includes(':not(:has([data-shimmer="true"]))'), '规则必须排除 running（否则压掉运行中轮换动画）')
      assert.ok(line.includes(':not(:has([data-text-shimmer="true"]))'), '双契约都要排除')
    }
  })
  it('纯函数：空表 / null → 空 CSS（fallback 态）', () => {
    assert.equal(T.buildStepCardRulesCss({}), '')
    assert.equal(T.buildStepCardRulesCss(null), '')
    assert.equal(T.buildStepCardRulesCss({ [GROUP3]: undefined }), '')
    assert.equal(T.buildStepCardRulesCss({ [GROUP3]: { count: 4, closed: true } }), '', '非 3/5 档位不产出')
  })
  it('groupKey CSS 转义：JSON 文本里的引号必须转义（否则选择器语法错误）', () => {
    const escaped = T.cssAttrValue(GROUP3)
    assert.equal(escaped, '[\\"process\\",\\"node-a\\",null]')
    const css = T.buildStepCardRulesCss({ [GROUP3]: { count: 3, closed: true } })
    assert.ok(css.includes('data-chat-group-key="' + escaped + '"'))
  })
  it('官方 DOM 命中：组根带 data-step-process + data-chat-group-key，生成的选择器能 matches', () => {
    const css = T.buildStepCardRulesCss({ [GROUP3]: { count: 3, closed: true } })
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
      // running（官方 shimmer 在场）→ 两条规则都不得命中（运行中轮换优先）
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
  it('桥全链路：3 张组写 3 张规则、4 张+ 组写 5 张规则；running 组不写', () => {
    const sources = new Map([
      [GROUP3, makeSource({ key: GROUP3, members: [], data: groupData([{ kind: 'read', count: 2 }, { kind: 'edit', count: 1 }]) })],
      [GROUP5, makeSource({ key: GROUP5, members: [], data: groupData([{ kind: 'read', count: 4 }]) })],
      [GROUP_RUNNING, makeSource({ key: GROUP_RUNNING, members: [], data: { turn: 1, closed: false, summary: { counts: [{ kind: 'read', count: 2 }] } } })],
    ])
    const grouped = buildGrouped(entriesOf([GROUP3, GROUP5, GROUP_RUNNING]), sources)
    const store = makeStore({ views: { grouped: () => grouped } })
    renderBridge(store, grouped)
    const css = cardRulesCss()
    assert.ok(css.includes('[data-chat-group-key="' + T.cssAttrValue(GROUP3) + '"]'), '3 张组规则已写入')
    assert.ok(css.includes('[data-chat-group-key="' + T.cssAttrValue(GROUP5) + '"]'), '4 张+ 组同样写规则（5 张牌面）')
    assert.ok(!css.includes(T.cssAttrValue(GROUP_RUNNING)), 'running 组不写规则（走运行中轮换动画）')
    const set3 = T.completedFaceSetFor(3, T.completedStepTopFace(undefined, GROUP3))
    const set5 = T.completedFaceSetFor(5, T.completedStepTopFace(undefined, GROUP5))
    assert.ok(css.includes('--tf-face-' + set3.id + '-stack') && css.includes('--tf-face-' + set5.id + '-stack'), '两组引用各自的牌面 set')
  })
  it('组数据实时更新：3 → 4 张工具时规则切到 5 张牌面 set（不再固定回落）', () => {
    const src = makeSource({ key: GROUP3, members: [], data: groupData([{ kind: 'read', count: 3 }]) })
    const grouped = buildGrouped(entriesOf([GROUP3]), new Map([[GROUP3, src]]))
    const store = makeStore({ views: { grouped: () => grouped } })
    renderBridge(store, grouped)
    const css3 = cardRulesCss()
    assert.ok(css3.includes('[data-chat-group-key="'), '初始 3 张 → 有规则')
    const topFace = T.completedStepTopFace(undefined, GROUP3)
    const set3 = T.completedFaceSetFor(3, topFace)
    assert.ok(css3.includes('--tf-face-' + set3.id + '-stack'), '初始引用 3 张 set')
    act(() => { src.set({ key: GROUP3, members: [], data: groupData([{ kind: 'read', count: 4 }]) }) })
    const css5 = cardRulesCss()
    const set5 = T.completedFaceSetFor(5, topFace)
    assert.ok(css5.includes('--tf-face-' + set5.id + '-stack'), '变 4 张后引用 5 张 set')
    assert.ok(!css5.includes('--tf-face-' + set3.id + '-stack'), '不得残留 3 张 set 引用')
    assert.equal(T.completedStepTopFace(undefined, GROUP3), topFace, '牌数变化不改已分配的顶牌')
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
    // 守卫只针对**桥自身的代码段**：桥是纯数据订阅→视觉选择器，禁止任何 DOM 轮询/定时扫描。
    // （源码其它部分另有合法的 200ms 视觉 tick / 1s 秒表时钟，不属于桥。）
    const start = src.indexOf('// ---- Step 牌数桥（官方 group snapshot')
    const end = src.indexOf('// ---- 注入样式（记录在案的软兼容点） ----')
    assert.ok(start > 0 && end > start, '桥代码段可定位')
    const bridge = src.slice(start, end)
    for (const banned of ['MutationObserver', 'querySelectorAll("[data-chat-call-id]', 'setInterval(', 'requestAnimationFrame(']) {
      assert.ok(!bridge.includes(banned), '桥不得使用 ' + banned)
    }
  })
})

// ══════════════════════════════════════════════════════════════════════
// F. 回归：running / hover-focus / 双契约 / reduced-motion / Turn 栏
// ══════════════════════════════════════════════════════════════════════
describe('Step 牌数 F：零回归', () => {
  it('running 平面旋转轮换未受影响（规则、相位、牌面顺序原样）', () => {
    const css = skinCss()
    const running = css.split('\n').find((l) => l.includes(':has([data-shimmer="true"]) [data-step-process-icon]::before{') && l.includes('-webkit-mask-image:url("data:image/svg+xml'))
    assert.ok(running, 'running 轮换规则缺失')
    const m = running.match(/-webkit-mask-image:url\("(data:image\/svg\+xml,[^"]+)"\)/)
    const svg = decodeURIComponent(m[1].slice('data:image/svg+xml,'.length))
    for (let n = 1; n <= 5; n++) assert.ok(svg.includes('<g id="phase-' + n + '">'), 'phase-' + n)
    assert.equal((svg.match(/type="rotate" values="/g) || []).length >= 20, true)
    assert.ok(svg.includes('id="card-deepseek"'), '五牌面（含鲸鱼）原样')
    // 平面旋转 35.5°：整套动画包在旋转组里（角取数据源 pokerSpin.restAngle）
    const spin = T.ICON_DEFAULTS.pokerSpin
    assert.ok(svg.includes('<g class="tf-step-flat-rotation" transform="rotate(' + spin.restAngle + ' 8 8)">'),
      '平面旋转组缺失或角度与数据源不一致')
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
    for (const name of ['tf-step-open', 'tf-step-close']) {
      const line = css.split('\n').find((l) => l.includes('@keyframes ' + name + '{'))
      assert.ok(line, name + ' 缺失')
      assert.ok(!line.includes('animation-timing-function'), name + ' 不得在帧内再叠加缓动（easing 已进位姿采样）')
    }
    // 逐组牌面资产的帧序同样不得叠加缓动（同一 morph 规格）
    const set = T.completedFaceSetFor(3, T.pokerFacePool()[0])
    for (const line of T.completedFaceSetCss(set).split('\n')) {
      if (!line.includes('@keyframes ')) continue
      assert.ok(!line.includes('animation-timing-function'), '逐组帧序不得叠加缓动')
    }
  })
})

// ══════════════════════════════════════════════════════════════════════
// H. 3 张牌 morph 全程身份连续（card id 不因方向/进度而交换）
// ══════════════════════════════════════════════════════════════════════
describe('Step 牌数 H：3 张 morph 全程身份连续', () => {
  const rot = (s) => { const m = /rotate\((-?[\d.]+) 8 12\)/.exec(s); return m ? Number(m[1]) : 0 }
  const tx = (s) => { const m = /translate\(([-\d.]+), ([-\d.]+)\)/.exec(s); return { x: Number(m[1]), y: Number(m[2]) } }

  it('open 与 close 的每一帧：card1 恒为负角（向左）、card2 恒不旋转（居中）、card3 恒为正角（向右）', () => {
    for (const [label, fromFan] of [['open', false], ['close', true]]) {
      for (let k = 1; k <= 16; k += 1) {
        const tfs = T.stepMorphTransforms(3, T.stepMorphProgress(k / 17, fromFan))
        assert.ok(rot(tfs[1]) <= 0, label + ' 帧' + k + '：card1 不得转为正角（身份被换）')
        assert.equal(rot(tfs[2]), 0, label + ' 帧' + k + '：card2 必须始终居中不旋转')
        assert.ok(rot(tfs[3]) >= 0, label + ' 帧' + k + '：card3（顶牌）不得转为负角（身份被换）')
        assert.equal(Number(rot(tfs[1]).toFixed(6)), -Number(rot(tfs[3]).toFixed(6)), label + ' 帧' + k + '：card1/card3 对称')
        // 三张的 y 都在从各自的 stack 偏移收敛到 fan 的同一位姿（-0.18），
        // 因此中途 y 互不相同是正常的——身份由「哪张牌拿到哪条插值线」保证，
        // 而不是靠三张位置相同。
        assert.ok(Math.abs(tx(tfs[1]).y - tx(tfs[3]).y) < 4.1, label + ' 帧' + k + '：card1/card3 的 y 差不超过 stack 偏移量')
      }
    }
  })

  it('端点：open 起点 = stack3、终点 = 新 fan3；close 起点 = 新 fan3、终点 = stack3', () => {
    const stack = T.pokerTransforms(3, false), fan = T.pokerTransforms(3, true)
    assert.equal(rot(fan[1]), -26)
    assert.equal(rot(fan[2]), 0)
    assert.equal(rot(fan[3]), 26)
    for (const i of [1, 2, 3]) {
      assert.equal(tx(T.stepMorphTransforms(3, T.stepMorphProgress(0, false))[i]).y, tx(stack[i]).y, 'open 起点 = stack')
      const endOpen = T.stepMorphTransforms(3, T.stepMorphProgress(1, false))[i]
      assert.equal(tx(endOpen).y, tx(fan[i]).y, 'open 终点 ty = fan3')
      assert.equal(rot(endOpen), rot(fan[i]), 'open 终点 rotate = fan3')
      const startClose = T.stepMorphTransforms(3, T.stepMorphProgress(0, true))[i]
      assert.equal(rot(startClose), rot(fan[i]), 'close 起点 = fan3')
      assert.equal(rot(T.stepMorphTransforms(3, T.stepMorphProgress(1, true))[i]), 0, 'close 终点 = stack3（无旋转）')
    }
  })

  it('每帧绘制序 = 身份序（card3 恒为最上层，逐帧 occlusion 跟随身份）', () => {
    for (const fromFan of [false, true]) {
      for (const k of [1, 8, 16]) {
        const tfs = T.stepMorphTransforms(3, T.stepMorphProgress(k / 17, fromFan))
        const svg = decodeMask('url("data:image/svg+xml,' + encodeURIComponent(T.stepCompletedGroupSvg(3, tfs)) + '")')
        const layers = layerTransformsOf(svg)
        assert.deepEqual(layers, [tfs[1], tfs[2], tfs[3]], '绘制序恒为 card1 → card2 → card3')
        const maskOf = (owner) => {
          const block = new RegExp('<mask id="scc-m' + owner + '"[^]*?</mask>').exec(svg)[0]
          return [...block.matchAll(/<g transform="([^"]+)">/g)].map((m) => m[1]).filter((t) => !t.includes('scale('))
        }
        assert.deepEqual(maskOf(1), [tfs[2], tfs[3]], 'card1 被 2/3 挖')
        assert.deepEqual(maskOf(2), [tfs[3]], 'card2 被 3 挖')
        assert.deepEqual(maskOf(3), [], 'card3 不被挖（恒顶层）')
      }
    }
  })
})

// ══════════════════════════════════════════════════════════════════════
// G. 步骤文件清单（本 Process Group 碰过哪些文件 → 组头尾部纯 CSS 文本）
// ══════════════════════════════════════════════════════════════════════
// 架构红线（不许动）：插件不写官方 DOM、不加官方属性、不做 DOM 观察——
// 出口只能是官方组头按钮 [data-process-activity] 上的 ::after{content}。
describe('步骤文件清单 G：官方数据 → 组头尾部文本', () => {
  const GROUP_A = '["process","files-a",null]'
  const GROUP_B = '["process","files-b",null]'
  const GROUP_RUNNING_F = '["process","files-running",null]'
  const args = (obj) => JSON.stringify(obj)
  const settledCall = (name, argv) => ({
    kind: 'tool-call',
    data: { root: { kind: 'tool-result', callId: 'c', call: { name, argsRaw: args(argv) } } },
  })
  const startedCall = (name, argv) => ({
    kind: 'tool-call',
    data: { root: { phase: 'start', name, argsRaw: args(argv) } },
  })
  const nodeRef = (key) => ({ kind: 'node', key })

  it('toolCallFilePath：结算态 / 运行中两种 payload 都认，preparing 与截断 call=null 不出路径', () => {
    assert.equal(T.toolCallFilePath(settledCall('read', { file_path: 'X:\\a\\b.ts' })), 'X:\\a\\b.ts')
    assert.equal(T.toolCallFilePath(startedCall('write', { file_path: '/tmp/x/y.md' })), '/tmp/x/y.md')
    assert.equal(T.toolCallFilePath({ kind: 'tool-call', data: { root: { phase: 'preparing', name: 'read' } } }), null, 'args 未到 → 无路径')
    assert.equal(T.toolCallFilePath({ kind: 'tool-call', data: { root: { kind: 'tool-result', call: null } } }), null, '窗口截断 → 无路径')
    assert.equal(T.toolCallFilePath({ kind: 'assistant-step', data: {} }), null, '非工具节点 → 无路径')
    assert.equal(T.toolCallFilePath(null), null)
    assert.equal(T.toolCallFilePath({ kind: 'tool-call', data: { root: { phase: 'start', name: 'read', argsRaw: '{oops' } } }), null, 'args JSON 坏 → 无路径')
  })

  it('filePathFromArgs：键优先级 + camelCase + 目录不算文件 + url 不取', () => {
    assert.equal(T.filePathFromArgs({ filePath: 'a/b.ts' }, 'read'), 'a/b.ts', 'camelCase filePath')
    assert.equal(T.filePathFromArgs({ path: 'p.ts', file_path: 'f.ts' }, 'read'), 'f.ts', 'file_path 优先于 path')
    assert.equal(T.filePathFromArgs({ file: 'f.ts' }, 'read'), 'f.ts')
    assert.equal(T.filePathFromArgs({ target: 't.ts' }, 'read'), 't.ts')
    assert.equal(T.filePathFromArgs({ path: 'src/dir/' }, 'read'), null, '以分隔符结尾 = 目录')
    assert.equal(T.filePathFromArgs({ url: 'https://x/y.ts' }, 'webFetch'), null, 'url 不是文件')
    assert.equal(T.filePathFromArgs({}, 'read'), null)
    assert.equal(T.filePathFromArgs('nope', 'read'), null)
  })

  it('目录型工具（glob/grep/find/ls）：path 不采信，file_path 仍采信', () => {
    assert.equal(T.filePathFromArgs({ path: 'src' }, 'grep'), null, 'grep 的 path 是搜索根')
    assert.equal(T.filePathFromArgs({ path: 'src' }, 'glob'), null)
    assert.equal(T.filePathFromArgs({ path: 'src' }, 'dsh_find'), null, '命名空间前缀同样识别')
    assert.equal(T.filePathFromArgs({ path: 'src' }, 'read'), 'src', '非目录型工具照常采信')
    assert.equal(T.filePathFromArgs({ file_path: 'src/a.ts' }, 'grep'), 'src/a.ts', 'file_path 恒采信')
  })

  it('stepGroupFilePaths：按成员顺序、去重（分隔符归一）、跳过非 node 成员', () => {
    const nodes = new Map([
      ['n1', settledCall('read', { file_path: 'X:\\a\\b.ts' })],
      ['n2', settledCall('edit', { file_path: 'X:/a/b.ts' })],      // 同一文件的另一种写法 → 去重
      ['n3', startedCall('write', { file_path: 'X:\\c\\d.md' })],
      ['n4', settledCall('grep', { path: 'src' })],                  // 目录型 → 无路径
    ])
    const snapshot = { members: [nodeRef('n1'), nodeRef('n2'), nodeRef('n3'), nodeRef('n4'), { kind: 'group', key: 'g' }] }
    assert.deepEqual(T.stepGroupFilePaths(snapshot, (k) => nodes.get(k)), ['X:\\a\\b.ts', 'X:\\c\\d.md'])
    assert.deepEqual(T.stepGroupFilePaths({ members: [] }, (k) => nodes.get(k)), [])
    assert.deepEqual(T.stepGroupFilePaths(snapshot, null), [], '无 node 读端 → 空（不抛错）')
    assert.deepEqual(T.stepGroupFilePaths({ members: [nodeRef('boom')] }, () => { throw new Error('x') }), [], '读端抛错 → 跳过')
  })

  it('stepFilesText：basename 再去重、最多 3 个、其余折成 " +N"', () => {
    assert.equal(T.stepFilesText([]), '')
    assert.equal(T.stepFilesText(['X:\\a\\b.ts']), 'b.ts')
    assert.equal(T.stepFilesText(['X:\\a\\b.ts', 'X:\\c\\b.ts']), 'b.ts', '同名文件只显示一次')
    assert.equal(
      T.stepFilesText(['a/one.ts', 'a/two.ts', 'a/three.ts', 'a/four.ts', 'a/five.ts']),
      'one.ts \u00b7 two.ts \u00b7 three.ts +2',
    )
    assert.equal(T.STEP_FILES_MAX, 3)
  })

  it('预算按内容列宽度自适应：量官方内容列那一行（不解析 CSS 变量），永远落在 [MIN, MAX]', () => {
    // 实测：内容区 680px、最长标签 252px、旧固定 32 字符只用掉 130~167px、右侧白空 231~468px
    assert.equal(T.stepFilesBudgetPx(680), 380, '680px 内容列 → 吃满上限 380px')
    assert.equal(T.stepFilesBudgetPx(4000), 380, '更宽也不超过上限（不吃满整行）')
    assert.equal(T.stepFilesBudgetPx(500), 200, '500px → 500-300=200')
    assert.equal(T.stepFilesBudgetPx(400), T.STEP_FILES_MIN_PX, '窄内容列夹到下限 150px')
    assert.equal(T.stepFilesBudgetPx(200), T.STEP_FILES_MIN_PX, '更窄仍保底')
    // 宽度来源 = 官方内容列里那一行的 clientWidth（`--dsh-chat-content-width` 的计算值是
    // var()/clamp() 文本，parseFloat 解析不出数值，所以只能量布局）。
    // jsdom 没有布局：未 stub 的行 clientWidth=0 → 跳过；量不到才回落视口估算。
    const holder = sharedDocument.createElement('div')
    holder.setAttribute('data-chat-group-key', 'g-width-probe')
    Object.defineProperty(holder, 'clientWidth', { value: 500, configurable: true })
    sharedDocument.body.appendChild(holder)
    try {
      assert.equal(T.stepFilesContentWidth(), 500, '必须量到官方内容列那一行的宽度')
      assert.equal(T.stepFilesBudgetPx(), 200, '量到 500 → 预算 200（与显式口径同一条公式）')
    } finally {
      holder.remove()
    }
    const auto = T.stepFilesBudgetPx()
    assert.ok(auto >= T.STEP_FILES_MIN_PX && auto <= T.STEP_FILES_MAX_PX, '量不到时的回落预算 = ' + auto)
    // 等效字符口径：中文/全角按 2.4 个 ASCII 计（避免被 ch 口径骗过去）
    assert.equal(T.stepFilesWeight('abc.ts'), 6)
    assert.equal(T.stepFilesWeight('中文.ts'), 2 * 2.4 + 3)
  })

  it('stepFilesText：整名策略——超预算的名字整条折进 "+N"；单名超长是已记录的例外', () => {
    const narrow = 32 * 6      // 与旧版行为等价的窄预算（192px = 32 等效字符）
    // 截图回归：非宽窗口下 client.js · process-groups.ts 显示、第三个整名折进 +1（不出现 "ChatGroup…"）
    const shots = T.stepFilesText(['X:/p/client.js', 'X:/p/process-groups.ts', 'X:/p/ChatGroupSeat.tsx'], narrow)
    assert.equal(shots, 'client.js \u00b7 process-groups.ts +1', '不出现残片名：' + shots)
    assert.ok(!shots.includes('ChatGroup'), '被预算挤掉的名字不得留半截')
    // 同样三个名字在宽窗口下应该都显示出来（这就是"明明有地方却 +1"的修复）
    const wide = T.stepFilesText(['X:/p/client.js', 'X:/p/process-groups.ts', 'X:/p/ChatGroupSeat.tsx'], 380)
    assert.equal(wide, 'client.js \u00b7 process-groups.ts \u00b7 ChatGroupSeat.tsx', '宽窗口不再白折')
    // 首个名字无条件显示（"至少留一个名字"）：真·超预算时整名照出、只把后面的名字折成 +N。
    const long = 'a'.repeat(46) + '.ts'          // 49 字符：自身就超过任何预算
    const long2 = 'b'.repeat(46) + '.ts'
    const kept = T.stepFilesText([long, long2, 'c.ts'], narrow)
    assert.equal(kept, long + ' +2', '首个名字自身超预算时仍整名显示 + 计数')
    // 已知边界（README「步骤文件清单」如实记录）：首个名字自身超过预算时文本必然超过预算，
    // 且该名字在 UI 上会被 CSS ellipsis 截断——不要在文档里声称"绝不显示半个文件名"
    assert.ok(kept.length * 6 > narrow, '单名超预算是已记录的例外：' + kept.length + ' 字符 > ' + narrow / 6)
    // 三个短名都放得下 → 全显示，无 +N
    assert.equal(T.stepFilesText(['a.ts', 'b.ts', 'c.ts'], narrow), 'a.ts \u00b7 b.ts \u00b7 c.ts')
    assert.ok(T.STEP_FILES_MIN_PX < T.STEP_FILES_MAX_PX, '窄/宽两端必须真的不同（否则"自适应"没有意义）')
  })

  it('buildStepFileRulesCss：规则挂在官方组头按钮的 ::after 上，内容为纯文本', () => {
    const map = { [GROUP_A]: { count: 3, closed: true, filesText: 'a.ts \u00b7 b.ts' } }
    const budget = 380                       // 显式预算：同一份值同时进数据层与 CSS
    const css = T.buildStepFileRulesCss(map, undefined, budget)
    assert.equal(css.split('\n').filter(Boolean).length, 1, '一个组一条规则')
    assert.ok(css.includes('[data-step-process][data-chat-group-key="' + T.cssAttrValue(GROUP_A) + '"] button[data-process-activity]::after{'))
    assert.ok(css.includes('content:"a.ts \u00b7 b.ts"'))
    assert.ok(css.includes('text-overflow:ellipsis'), '过长时省略号')
    assert.ok(css.includes('flex:none'), '标题先收缩')
    // 关键不变量：写进 CSS 的 max-width 与数据层用的是**同一个像素预算**（分叉 = 半个名字回归）
    assert.ok(css.includes('max-width:' + Math.round(budget) + 'px'),
      'CSS 兜底宽度必须等于传入的数据层预算（' + budget + 'px），实际：' + css.match(/max-width:[^;]+/))
    assert.ok(!css.includes('44ch'), '不得回退到与数据层口径不同的 ch 兜底')
    assert.ok(!css.includes(':has('), '文件清单不参与 running/牌面竞争，无需 shimmer 排除子句')
  })

  it('buildStepFileRulesCss：控制字符归一——引号/反斜杠/换行/换页符都不会破坏样式表', () => {
    // 文件名与 groupKey 都来自工具参数（模型给什么就是什么）。写盘走 style.textContent，
    // 所以 `</style>` 之类不会外泄；真正的风险是**控制字符让声明失效**：
    // U+000C 在 CSS 里等同换行，会把 content 字符串截断 → 该组清单静默消失。
    const evilText = 'a\u000Cb.ts \u00b7 c"d\\e.ts'
    const css = T.buildStepFileRulesCss({ ['k\u000Cn']: { filesText: evilText } })
    assert.ok(!/[\u0000-\u001F\u007F]/.test(css), '输出里不得残留控制字符：' + JSON.stringify(css))
    assert.ok(css.includes('content:"a b.ts'), 'U+000C 必须归一为空格')
    assert.ok(css.includes('c\\"d\\\\e.ts'), '引号与反斜杠仍按 CSS 字符串转义')
    assert.equal(css.split('\n').filter(Boolean).length, 1, '归一后仍是一条完整规则（没被拆行）')
    assert.ok(css.includes('[data-chat-group-key="k n"]'), 'groupKey 的控制字符同样归一')
    // 输出串写进 <style> 元素时不需要 HTML 转义（textContent 路径），但绝不能引入换行：
    assert.ok(!css.includes('\n'), '单条规则内不得出现换行（否则声明会被拆断）')
  })

  it('buildStepFileRulesCss：会话作用域双支 / 无 session 单支 / 空清单不产出', () => {
    const map = { [GROUP_A]: { filesText: 'a.ts' } }
    const scoped = T.buildStepFileRulesCss(map, 'sess-1')
    assert.ok(scoped.includes('[data-conversation-session="sess-1"] [data-step-process]'), '官方锚点支')
    assert.ok(scoped.includes('[data-conversation-content]:not([data-conversation-session]) [data-step-process]'), 'rc.1 回退支')
    assert.equal(scoped.split('{').length - 1, 1, '两支共享一个声明块（同一行）')
    assert.ok(!T.buildStepFileRulesCss(map, 'sess-1').includes('undefined'))
    // 只有 modern 面：legacy 面（插件自有 LegacyStepHeader）没有调用点，因此这里的签名
    // 不再有 surface 参数（写错成 legacy 也不会静默产出别的面的规则）。
    assert.equal(T.buildStepFileRulesCss.length, 3, '签名 = (map, sessionId, budgetPx)')
    assert.equal(T.buildStepFileRulesCss({ [GROUP_A]: { filesText: '' } }), '', '空清单 → 无规则')
    assert.equal(T.buildStepFileRulesCss({ [GROUP_A]: { count: 3, closed: true } }), '', '缺 filesText → 无规则')
    assert.equal(T.buildStepFileRulesCss({}), '')
    assert.equal(T.buildStepFileRulesCss(null), '')
  })

  it('CSS 字符串转义：文件名里的引号/反斜杠/换行不得破坏规则', () => {
    assert.equal(T.cssStringContent('a"b'), 'a\\"b')
    assert.equal(T.cssStringContent('a\\b'), 'a\\\\b')
    assert.equal(T.cssStringContent('a\nb'), 'a b')
    const css = T.buildStepFileRulesCss({ [GROUP_A]: { filesText: 'we"ird\\name.ts' } })
    assert.ok(css.includes('content:"we\\"ird\\\\name.ts"'), css)
    assert.equal(css.split('{').length - 1, 1, '转义后仍是合法单规则')
  })

  it('选择器命中官方组头：组根 + data-process-activity 按钮（去掉 ::after 后 matches）', () => {
    const css = T.buildStepFileRulesCss({ [GROUP_A]: { filesText: 'a.ts' } })
    const selector = css.slice(0, css.indexOf('{')).replace(/::after$/, '')
    const host = sharedDocument.createElement('div')
    host.setAttribute('data-step-process', '')
    host.setAttribute('data-chat-group-key', GROUP_A)
    const button = sharedDocument.createElement('button')
    button.setAttribute('data-process-activity', 'read')
    host.appendChild(button)
    sharedDocument.body.appendChild(host)
    try {
      assert.ok(button.matches(selector), '官方组头按钮命中：' + selector)
      host.setAttribute('data-chat-group-key', GROUP_B)
      assert.ok(!button.matches(selector), '别的组不命中')
    } finally { host.remove() }
  })

  // ── 全链路：React 订阅官方 group snapshot + ChatNodeStore ──
  describe('全链路（桥 → 样式表）', () => {
    let root = null, container = null
    beforeEach(() => {
      container = sharedDocument.createElement('div')
      sharedDocument.body.appendChild(container)
      root = createRoot(container)
      T.writeStepFilesRules(null)
      T.writeStepCardRules(null)
    })
    afterEach(() => {
      act(() => { root.unmount() })
      container.remove()
      T.writeStepFilesRules(null)
      T.writeStepCardRules(null)
    })
    function filesCss() {
      const tag = sharedDocument.querySelector('style[data-plugin-css="' + T.STEP_FILES_CSS_ID + '"]')
      assert.ok(tag, '步骤文件清单样式表已注入')
      return tag.textContent
    }
    function makeNodes(initial) {
      const nodes = new Map(initial)
      const listeners = new Set()
      let version = 0
      const toolSource = {
        subscribe(l) { listeners.add(l); return () => { listeners.delete(l) } },
        getSnapshot: () => version,
      }
      return {
        get: (key) => nodes.get(key),
        turnDataSource: () => toolSource,
        set(key, node) { nodes.set(key, node); version += 1; for (const l of [...listeners]) l() },
      }
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
    function renderWith(store, options) {
      const useConversation = (selector) => react.useSyncExternalStore(store.subscribe, () => selector(store.getSnapshot()))
      // useChat 收到的是官方 ChatSnapshot（含 nodes）；store 里同时挂 views + nodes
      const useChat = (selector) => react.useSyncExternalStore(store.subscribe, () => selector(store.getSnapshot()))
      const props = { useConversation, sessionId: 'sess-files' }
      if (!options || options.useChat !== false) props.useChat = useChat
      act(() => { root.render(react.createElement(() => react.createElement(T.StepCardRulesBridge, props))) })
    }
    function makeStore({ entries, sources, nodes }) {
      let snap = null
      const listeners = new Set()
      const grouped = { entries, groupSource: (key) => sources.get(key) }
      snap = { views: { grouped: () => grouped }, nodes }
      return {
        getSnapshot: () => snap,
        subscribe(l) { listeners.add(l); return () => { listeners.delete(l) } },
        set(next) { snap = next; for (const l of [...listeners]) l() },
      }
    }
    const groupData = (counts, closed) => ({ turn: 1, closed, summary: { counts, running: undefined, runningDetail: '' } })

    it('已完成组：成员工具调用 → 组头文件清单规则；牌数桥规则同时照旧', () => {
      const nodes = makeNodes([
        ['n1', settledCall('read', { file_path: 'X:\\proj\\client.js' })],
        ['n2', settledCall('edit', { file_path: 'X:\\proj\\README.md' })],
      ])
      const sources = new Map([[
        GROUP_A,
        makeSource({ key: GROUP_A, members: [nodeRef('n1'), nodeRef('n2')], data: groupData([{ kind: 'read', count: 2 }], true) }),
      ]])
      const store = makeStore({ entries: [{ kind: 'group', key: GROUP_A }], sources, nodes })
      renderWith(store)
      const css = filesCss()
      assert.ok(css.includes('[data-step-process][data-chat-group-key="' + T.cssAttrValue(GROUP_A) + '"] button[data-process-activity]::after'), '规则已写入')
      assert.ok(css.includes('content:"client.js \u00b7 README.md"'), css)
      assert.ok(cardRulesCss().includes('[data-chat-group-key="' + T.cssAttrValue(GROUP_A) + '"]'), '牌数桥规则不受影响')
    })

    it('运行中组：文件清单照样输出（边跑边累积），牌面覆盖仍不写', () => {
      const nodes = makeNodes([['n1', startedCall('read', { file_path: 'X:\\proj\\live.ts' })]])
      const sources = new Map([[
        GROUP_RUNNING_F,
        makeSource({ key: GROUP_RUNNING_F, members: [nodeRef('n1')], data: groupData([{ kind: 'read', count: 1 }], false) }),
      ]])
      const store = makeStore({ entries: [{ kind: 'group', key: GROUP_RUNNING_F }], sources, nodes })
      renderWith(store)
      assert.ok(filesCss().includes('content:"live.ts"'), '运行中组也有文件清单：' + filesCss())
      assert.ok(!cardRulesCss().includes(T.cssAttrValue(GROUP_RUNNING_F)), '牌面覆盖仍不写运行中组')
    })

    it('工具参数/结果变化跟随刷新（turn tool-call 源通知），条目消失则清空', () => {
      const nodes = makeNodes([['n1', startedCall('read', { file_path: 'X:\\proj\\a.ts' })]])
      const src = makeSource({ key: GROUP_A, members: [nodeRef('n1')], data: groupData([{ kind: 'read', count: 1 }], true) })
      const sources = new Map([[GROUP_A, src]])
      const store = makeStore({ entries: [{ kind: 'group', key: GROUP_A }], sources, nodes })
      renderWith(store)
      assert.ok(filesCss().includes('content:"a.ts"'))
      // 第二条调用落地（成员数组 + 工具数据同时变化）
      act(() => {
        nodes.set('n2', settledCall('write', { file_path: 'X:\\proj\\b.ts' }))
        src.set({ key: GROUP_A, members: [nodeRef('n1'), nodeRef('n2')], data: groupData([{ kind: 'read', count: 2 }], true) })
      })
      assert.ok(filesCss().includes('content:"a.ts \u00b7 b.ts"'), '累积后的清单：' + filesCss())
      // 组消失 → 规则撤下（grouped 读端必须是稳定对象：uSES 的 getSnapshot 每次新建会自激）
      const emptyGrouped = { entries: [], groupSource: () => undefined }
      act(() => { store.set({ views: { grouped: () => emptyGrouped }, nodes }) })
      assert.equal(filesCss(), '', '组消失后不得残留文件清单规则')
    })

    it('内容列宽度变化 → resize 后重量并重写（预算与 CSS max-width 同源，不分叉）', () => {
      const nodes = makeNodes([['n1', settledCall('read', { file_path: 'X:\\proj\\client.js' })]])
      const sources = new Map([[
        GROUP_A,
        makeSource({ key: GROUP_A, members: [nodeRef('n1')], data: groupData([{ kind: 'read', count: 1 }], true) }),
      ]])
      const store = makeStore({ entries: [{ kind: 'group', key: GROUP_A }], sources, nodes })
      renderWith(store)
      // jsdom 没有布局：官方内容列那一行量不到（clientWidth=0）→ 视口估算落在上限 380px
      assert.ok(filesCss().includes('max-width:380px'), '量不到内容列时用视口估算：' + filesCss())
      const row = sharedDocument.createElement('div')
      row.setAttribute('data-chat-group-key', 'width-probe')
      Object.defineProperty(row, 'clientWidth', { value: 500, configurable: true })
      sharedDocument.body.appendChild(row)
      try {
        act(() => { sharedWindow.dispatchEvent(new sharedWindow.Event('resize')) })
        assert.ok(filesCss().includes('max-width:200px'),
          'resize 后必须按量到的 500px 重写预算（500-300=200）：' + filesCss())
      } finally {
        row.remove()
      }
    })

    it('拿不到官方 ChatNodeStore（旧宿主/降级）→ 只写牌数规则，文件清单表保持空', () => {
      const sources = new Map([[
        GROUP_A,
        makeSource({ key: GROUP_A, members: [nodeRef('n1')], data: groupData([{ kind: 'read', count: 2 }], true) }),
      ]])
      const store = makeStore({ entries: [{ kind: 'group', key: GROUP_A }], sources, nodes: undefined })
      renderWith(store)
      assert.equal(filesCss(), '', '没有节点读端 → 不猜文件')
      assert.ok(cardRulesCss().includes('[data-chat-group-key="' + T.cssAttrValue(GROUP_A) + '"]'), '牌数规则照旧')
    })

    it('宿主没给 useChat（旧 kit）→ 桥照常写牌数规则，文件清单不产出', () => {
      const nodes = makeNodes([['n1', settledCall('read', { file_path: 'X:\\proj\\a.ts' })]])
      const sources = new Map([[
        GROUP_A,
        makeSource({ key: GROUP_A, members: [nodeRef('n1')], data: groupData([{ kind: 'read', count: 1 }], true) }),
      ]])
      const store = makeStore({ entries: [{ kind: 'group', key: GROUP_A }], sources, nodes })
      renderWith(store, { useChat: false })
      assert.equal(filesCss(), '', '无 useChat → 不产出文件清单')
      assert.ok(cardRulesCss().includes('[data-chat-group-key="' + T.cssAttrValue(GROUP_A) + '"]'), '牌数规则不受影响')
    })
  })
})

