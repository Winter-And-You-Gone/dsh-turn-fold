// completed Step / Process Group 的牌面分配测试（本轮修复）。
//
// 旧行为：completed 牌堆的牌面是固定序 [diamond, club, spade, heart, deepseek]
//   → "牌数决定顶牌"：3 张永远 ♠、5 张永远 🐋。
// 新行为：
//   · 每个 session 一个 **top face shuffle bag**（与 Turn 顶层 poker 共用 shuffle 纯函数，
//     bag 状态独立）：一批内五种顶牌各出现一次、重洗后首张 ≠ 上一批末张；
//   · 每组整套排列 = f(count, topFace)：cardN = 该组分配到的 top face，组内不重复，
//     5 张用满牌面池（池不足时把重复牌面放在最下层 card1）；
//   · 身份 = sessionKey + 官方 groupKey；只有 closed 组参与（running 不消耗 bag）；
//   · 资产按 (count, topFace) 懒生成、永久缓存、追加式写入——逐组规则只引用变量，
//     CSS 体积不随组数膨胀。
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { loadPlugin } from './helpers/loader.mjs'

const require = createRequire(import.meta.url)

import dom, { sharedWindow, sharedDocument } from './helpers/dom.mjs'

const { test: T } = loadPlugin({ window: sharedWindow })

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
/** 一张 card 的 glyph 标记（用于从 mask SVG 反查该 card 的牌面）。 */
function faceMarker(face, whaleMarkup) {
  if (face === 'deepseek') return whaleMarkup.slice(0, 60)
  return T.POKER_PIPS[face].path.slice(0, 30);
}
/** 从 completed 组 mask SVG 反查「每张 card 的牌面」（按 card id 顺序）。 */
function facesOfSvg(svg, whaleMarkup) {
  const pool = T.pokerFacePool()
  const out = []
  for (let i = 1; i <= 5; i += 1) {
    const m = new RegExp('<g id="scc-g' + i + '">([\\s\\S]*?)</g></g>').exec(svg)
    if (!m) break
    const glyph = m[1]
    const hit = pool.find((face) => glyph.includes(faceMarker(face, whaleMarkup)))
    out.push(hit === undefined ? 'unknown' : hit)
  }
  return out
}
const WHALE = String(T.POKER_SPIN_DEEPSEEK).replace(/id="[^"]*"/, '')
const facesOfMaskUri = (uri) => facesOfSvg(decodeMask(uri), WHALE)

// ══════════════════════════════════════════════════════════════════════
// A. regression：牌数不再决定顶牌
// ══════════════════════════════════════════════════════════════════════
describe('Step 牌面 A：牌数不再决定顶牌（回归锁）', () => {
  it('一批 5 个组 → 顶牌五种各一次（不可能"3 张永远 ♠ / 5 张永远 🐋"）', () => {
    const session = 'faces-regression-session'
    const tops = [1, 2, 3, 4, 5].map((n) => T.completedStepTopFace(session, 'group-' + n))
    assert.equal(new Set(tops).size, 5, '一批内五种顶牌各出现一次：' + tops.join(','))
    // 五顶牌里必然包含非 spade / 非 deepseek 的组 → 旧的固定顶牌行为不可能再出现
    assert.ok(tops.filter((f) => f !== 'spade').length >= 4, '3 张组不可能全部 spade')
    assert.ok(tops.filter((f) => f !== 'deepseek').length >= 4, '5 张组不可能全部 deepseek')
    for (const top of tops) {
      const f3 = T.completedFacesArrangement(3, top)
      const f5 = T.completedFacesArrangement(5, top)
      assert.equal(f3[2], top, '3 张：card3 = 该组 top face')
      assert.equal(f5[4], top, '5 张：card5 = 该组 top face')
      assert.notEqual(f3.join(','), 'diamond,club,spade', '3 张不得回到固定序 ♦ ♣ ♠')
    }
  })
  it('确定性：同 top face 恒得同一套排列（无隐藏随机源）', () => {
    const top = T.completedStepTopFace('faces-determinism', 'g1')
    assert.deepEqual(T.completedFacesArrangement(3, top), T.completedFacesArrangement(3, top))
    assert.deepEqual(T.completedFacesArrangement(5, top), T.completedFacesArrangement(5, top))
  })
})

// ══════════════════════════════════════════════════════════════════════
// B/C. bag：一批完整遍历 + 跨批不连续重复
// ══════════════════════════════════════════════════════════════════════
describe('Step 牌面 B/C：top-face shuffle bag', () => {
  it('五牌面池：连续 5 个组 Set.size === 5；第二批复用新一批（仍 5 种）', () => {
    const session = 'bag-session-5'
    const tops = []
    for (let n = 1; n <= 10; n += 1) tops.push(T.completedStepTopFace(session, 'g' + n))
    assert.equal(new Set(tops.slice(0, 5)).size, 5, '第一批：' + tops.slice(0, 5).join(','))
    assert.equal(new Set(tops.slice(5)).size, 5, '第二批：' + tops.slice(5).join(','))
    assert.equal(new Set(tops).size, 5, '顶牌只能来自池内五种')
  })
  it('袋边界：上一批末张 ≠ 下一批首张（连续 3 批确定性验证）', () => {
    const session = 'bag-boundary'
    const tops = []
    for (let n = 1; n <= 15; n += 1) tops.push(T.completedStepTopFace(session, 'g' + n))
    for (let batch = 1; batch < 3; batch += 1) {
      assert.notEqual(tops[batch * 5], tops[batch * 5 - 1], '第 ' + (batch + 1) + ' 批首张不得等于上一批末张')
    }
  })
  it('四牌面池（鲸鱼数据缺失）→ 连续 4 个组 Set.size === 4', () => {
    const pack = { meta: { name: 'no-deepseek-pack', compat: '>=0.0.0' } }
    sharedWindow.localStorage.setItem(T.ICONS_STORAGE_KEY, JSON.stringify(pack))
    try {
      const { test: T4 } = loadPlugin({ window: sharedWindow })
      assert.deepEqual(T4.pokerFacePool(), ['spade', 'heart', 'diamond', 'club'], '四牌面池')
      const tops = [1, 2, 3, 4].map((n) => T4.completedStepTopFace('bag-session-4', 'g' + n))
      assert.equal(new Set(tops).size, 4, '一批四种顶牌各一次：' + tops.join(','))
      const next = [5, 6, 7, 8].map((n) => T4.completedStepTopFace('bag-session-4', 'g' + n))
      assert.equal(new Set(next).size, 4)
      assert.notEqual(next[0], tops[3], '四牌面模式同样避免跨批连续重复')
      // 池只有 4 面却要 5 张：不得异常，重复牌面落在最下层 card1
      const f5 = T4.completedFacesArrangement(5, tops[0])
      assert.equal(f5.length, 5)
      assert.equal(f5[4], tops[0], '顶牌仍是分配的 top face')
      assert.ok(new Set(f5).size >= 4, '不得退化成固定序列：' + f5.join(','))
      assert.equal(f5[0], f5[4], '重复牌面放在最下层 card1（被压住、最不显眼）')
    } finally {
      sharedWindow.localStorage.clear()
    }
  })
})

// ══════════════════════════════════════════════════════════════════════
// D/E/F. 同一组稳定 / 不同组独立 / session 隔离
// ══════════════════════════════════════════════════════════════════════
describe('Step 牌面 D/E/F：稳定性与隔离', () => {
  it('同一 session + groupKey：多次取 faces[] 逐项相同（顶牌与全套顺序）', () => {
    const key = 'stable-group'
    const first = T.completedFaceSetFor(3, T.completedStepTopFace('stable-session', key)).faces
    for (let i = 0; i < 20; i += 1) {
      const top = T.completedStepTopFace('stable-session', key)
      assert.deepEqual(T.completedFaceSetFor(3, top).faces, first, '第 ' + i + ' 次取必须逐项一致')
    }
    assert.deepEqual(first, T.completedFacesArrangement(3, first[2]), '排列由顶牌唯一决定（无隐藏随机）')
  })
  it('不同 group 独立：3 张组不再共用同一固定序', () => {
    const session = 'independent-session'
    const sets = ['a', 'b', 'c'].map((g) => {
      const top = T.completedStepTopFace(session, g)
      return T.completedFaceSetFor(3, top).faces
    })
    for (const faces of sets) assert.equal(new Set(faces).size, 3, '组内不重复：' + faces.join(','))
    assert.ok(new Set(sets.map((f) => f[2])).size >= 2, '三个组不得共用同一顶牌')
    assert.ok(new Set(sets.map((f) => f.join(','))).size >= 2, '三个组不得共用同一排列')
  })
  it('session 隔离：同 groupKey 在两个 session 是两条独立记录，bag 互不消费', () => {
    const before = T.completedStepTopBags.size
    const topA = T.completedStepTopFace('iso-session-A', 'same-group')
    const topB = T.completedStepTopFace('iso-session-B', 'same-group')
    assert.ok(T.completedStepTopFaces.has('iso-session-A|group:same-group'), 'A 的记录 key 含 session')
    assert.ok(T.completedStepTopFaces.has('iso-session-B|group:same-group'), 'B 的记录 key 含 session')
    assert.equal(T.completedStepTopBags.size, before + 2, '每 session 一个独立 bag')
    assert.notEqual(T.completedStepTopBags.get('iso-session-A'), T.completedStepTopBags.get('iso-session-B'), 'bag 对象不同')
    // 两个 session 各自消费 5 个组 → 各自一批完整（互不消耗对方余量）
    const a = [topA]
    const b = [topB]
    for (let n = 2; n <= 5; n += 1) {
      a.push(T.completedStepTopFace('iso-session-A', 'g' + n))
      b.push(T.completedStepTopFace('iso-session-B', 'g' + n))
    }
    assert.equal(new Set(a).size, 5, 'session A 一批完整：' + a.join(','))
    assert.equal(new Set(b).size, 5, 'session B 一批完整：' + b.join(','))
    assert.equal(T.completedStepTopBags.get('iso-session-A').remaining.length, 0)
    assert.equal(T.completedStepTopBags.get('iso-session-B').remaining.length, 0)
    // 不要求两个 session 的花色不同（随机允许碰巧相同），只要求状态独立
    void topA; void topB
  })
})

// ══════════════════════════════════════════════════════════════════════
// G/H. 组内排列：3 张不重复、5 张用满牌面池
// ══════════════════════════════════════════════════════════════════════
describe('Step 牌面 G/H：组内排列', () => {
  it('3 张组：length 3、组内不重复、card3 = 分配的 top face', () => {
    const session = 'arrangement-3'
    for (let n = 1; n <= 5; n += 1) {
      const top = T.completedStepTopFace(session, 'g' + n)
      const faces = T.completedFacesArrangement(3, top)
      assert.equal(faces.length, 3)
      assert.equal(new Set(faces).size, 3, '组内不得重复：' + faces.join(','))
      assert.equal(faces[2], top, 'card3 必为分配的 top face')
      for (const face of faces) assert.ok(T.pokerFacePool().includes(face), '只能使用牌面池内的牌面')
    }
  })
  it('5 张组：length 5、恰好用满牌面池、card5 = 分配的 top face；四花色模式不崩', () => {
    const session = 'arrangement-5'
    const pool = T.pokerFacePool()
    for (let n = 1; n <= 5; n += 1) {
      const top = T.completedStepTopFace(session, 'g' + n)
      const faces = T.completedFacesArrangement(5, top)
      assert.equal(faces.length, 5)
      assert.equal(new Set(faces).size, 5, '组内不得重复：' + faces.join(','))
      assert.deepEqual(new Set(faces), new Set(pool), '5 张恰好用满牌面池')
      assert.equal(faces[4], top, 'card5 必为分配的 top face')
    }
  })
})

// ══════════════════════════════════════════════════════════════════════
// I. 开合 / 逐帧：每张 card 的牌面身份不变
// ══════════════════════════════════════════════════════════════════════
describe('Step 牌面 I：开合与逐帧的牌身份连续', () => {
  it('closed → open → closed → open：每张 card 的 face 逐项一致（含 mask SVG 反查）', () => {
    const top = T.completedStepTopFace('morph-faces-session', 'morph-group')
    const set = T.completedFaceSetFor(3, top)
    const closed = facesOfMaskUri(T.stepCompletedGroupMask(3, false, set.faces))
    const open = facesOfMaskUri(T.stepCompletedGroupMask(3, true, set.faces))
    assert.deepEqual(closed, set.faces, 'closed 端点每张牌的 face = 分配值')
    assert.deepEqual(open, set.faces, 'open 端点每张牌的 face = 分配值（同一身份序）')
    for (const fan of [false, true]) {
      assert.deepEqual(facesOfMaskUri(T.stepCompletedGroupMask(3, fan, set.faces)), set.faces, '重复渲染逐项不变')
    }
    // morph 中间帧（任一进度）的每张牌 face 也必须不变
    const mid = decodeMask('url("data:image/svg+xml,' +
      encodeURIComponent(T.stepCompletedGroupSvg(3, T.stepMorphTransforms(3, 0.5), set.faces)) + '")')
    assert.deepEqual(facesOfSvg(mid, WHALE), set.faces, '中间帧的身份序不变')
  })
  it('5 张组同样：端点与中间帧的 card face 逐项一致', () => {
    const top = T.completedStepTopFace('morph-faces-session', 'morph-group-5')
    const set = T.completedFaceSetFor(5, top)
    for (const fan of [false, true]) {
      assert.deepEqual(facesOfMaskUri(T.stepCompletedGroupMask(5, fan, set.faces)), set.faces)
    }
    const mid = decodeMask('url("data:image/svg+xml,' +
      encodeURIComponent(T.stepCompletedGroupSvg(5, T.stepMorphTransforms(5, 0.31), set.faces)) + '")')
    assert.deepEqual(facesOfSvg(mid, WHALE), set.faces)
  })
})

// ══════════════════════════════════════════════════════════════════════
// J. CSS 重建稳定 + 体积不随组数膨胀
// ══════════════════════════════════════════════════════════════════════
describe('Step 牌面 J：CSS 重建稳定与体积', () => {
  const mapOf = (keys, count) => Object.fromEntries(keys.map((k) => [k, { count, closed: true }]))
  it('buildStepCardRulesCss 重复执行逐字节一致；无关组增删不影响既有组', () => {
    const session = 'css-rebuild-session'
    const map = { g1: { count: 3, closed: true }, g2: { count: 5, closed: true }, g3: { count: 3, closed: true } }
    const css1 = T.buildStepCardRulesCss(map, session)
    const css2 = T.buildStepCardRulesCss(map, session)
    assert.equal(css1, css2, '同一 map 两次结果必须一致（随机不得藏在 CSS builder 里）')
    const more = Object.assign({}, map, { g4: { count: 5, closed: true }, g5: { count: 3, closed: true } })
    const css3 = T.buildStepCardRulesCss(more, session)
    const linesOf = (css, key) => css.split('\n').filter((l) => l.includes(T.cssAttrValue(key)))
    for (const key of Object.keys(map)) {
      assert.deepEqual(linesOf(css3, key), linesOf(css1, key), key + ' 的规则行逐字节不变')
    }
    const fewer = { g1: map.g1, g2: map.g2 }
    assert.deepEqual(linesOf(T.buildStepCardRulesCss(fewer, session), 'g1'), linesOf(css1, 'g1'), '删组不影响保留组')
    // 变体资产同样确定性（同 set → 同 CSS）
    const set = T.completedFaceSetFor(3, T.completedStepTopFace(session, 'g1'))
    assert.equal(T.completedFaceSetCss(set), T.completedFaceSetCss(set))
  })
  it('逐组规则只引用变量：不内联 data-URI、体积与组数线性且很小', () => {
    const session = 'css-size-session'
    const one = T.buildStepCardRulesCss({ g1: { count: 3, closed: true } }, session)
    assert.ok(one.length < 1400, '单组规则必须很小（只引用 set 变量）：' + one.length)
    assert.ok(!one.includes('data:image/svg+xml'), '逐组规则不得内联 mask 数据 URI')
    const many = T.buildStepCardRulesCss(mapOf(Array.from({ length: 20 }, (_, i) => 'g' + i), 3), session)
    assert.ok(many.length < 20 * 1400, '20 组也必须是纯规则（资产在变体表里）：' + many.length)
    assert.ok(!many.includes('data:image/svg+xml'), '20 组规则同样不得内联资产')
    // 变体资产按 (count, topFace) 复用：重复请求同一键不产生新资产
    const a = T.completedFaceSetFor(3, 'heart')
    const b = T.completedFaceSetFor(3, 'heart')
    assert.equal(a, b, '同键返回同一 set（不重复生成资产）')
    assert.equal(T.completedFaceSetFor(3, 'heart').faces, a.faces)
  })
  it('变体资产只追加一次（幂等），且 set id 唯一', () => {
    const set = T.completedFaceSetFor(3, T.pokerFacePool()[0])
    const css = T.completedFaceSetCss(set)
    assert.ok(css.includes('--tf-face-' + set.id + '-stack:') && css.includes('--tf-face-' + set.id + '-fan:'), '端点变量')
    assert.ok(css.includes('@keyframes tf-face-open-' + set.id + '{') && css.includes('@keyframes tf-face-close-' + set.id + '{'), '双向帧序')
    const ids = new Set()
    for (const key of ['spade', 'heart', 'diamond', 'club', 'deepseek']) {
      ids.add(T.completedFaceSetFor(3, key).id)
      ids.add(T.completedFaceSetFor(5, key).id)
    }
    assert.equal(ids.size, 10, '每 (count, topFace) 一个唯一 set：' + ids.size)
  })
})

// ══════════════════════════════════════════════════════════════════════
// K. running 组不参与牌面分配
// ══════════════════════════════════════════════════════════════════════
describe('Step 牌面 K：running 组不消耗 bag', () => {
  it('closed:false 的组：不产出规则、不建 bag、不占 bag 名额；settle 后才分配', () => {
    const session = 'running-session'
    const bagsBefore = T.completedStepTopBags.size
    const facesBefore = T.completedStepTopFaces.size
    assert.equal(T.buildStepCardRulesCss({ run1: { count: 3, closed: false }, run2: { count: 5, closed: false } }, session), '', 'running 组不产出规则')
    assert.equal(T.completedStepTopBags.size, bagsBefore, 'running 不得建 bag')
    assert.equal(T.completedStepTopFaces.size, facesBefore, 'running 不得占名额')
    assert.ok(!T.completedStepTopBags.has(session), '该 session 不得因 running 组建袋')
    // 该 session 的 5 个组 settle 后 → 仍是完整一批（若 running 消耗过，这里会缺一个）
    const tops = []
    for (let n = 1; n <= 5; n += 1) {
      T.buildStepCardRulesCss({ ['g' + n]: { count: 3, closed: true } }, session)
      tops.push(T.completedStepTopFace(session, 'g' + n))
    }
    assert.equal(new Set(tops).size, 5, 'running 不消耗 bag：settle 后 5 个组仍是完整一批：' + tops.join(','))
  })
  it('桥写入的规则里 running 组不出现；run 组 settle 后同一 groupKey 才出现', () => {
    T.writeStepCardRules(null)
    const session = 'running-bridge-session'
    T.writeStepCardRules({ runA: { count: 3, closed: false } }, session)
    assert.equal(cardRulesCss(), '', 'running 组不写规则')
    T.writeStepCardRules({ runA: { count: 3, closed: true } }, session)
    const css = cardRulesCss()
    assert.ok(css.includes('[data-chat-group-key="runA"]'), 'settle 后写入规则')
    for (const line of css.split('\n').filter(Boolean)) {
      assert.ok(line.includes(':not(:has([data-shimmer="true"]))'), '规则仍排除 running（轮换优先）')
    }
    T.writeStepCardRules(null)
  })
})

// ══════════════════════════════════════════════════════════════════════
// L. 不持久化（presentation state）
// ══════════════════════════════════════════════════════════════════════
describe('Step 牌面 L：不持久化', () => {
  it('牌面分配不写 localStorage / 不进保存设置', () => {
    const src = require('node:fs').readFileSync(new URL('../client.js', import.meta.url), 'utf8')
    const saveBlock = src.slice(src.indexOf('function saveSettings'), src.indexOf('// -- 字段显隐 --'))
    assert.ok(!/completedStepTopFace|completedFaceSet|tf-face/.test(saveBlock), 'settings 持久化不得涉及牌面分配')
    const indexSrc = require('node:fs').readFileSync(new URL('../index.js', import.meta.url), 'utf8')
    assert.ok(!/completedStepTopFace|completedFaceSet/.test(indexSrc), '宿主 projection 不得涉及牌面分配')
  })
})
