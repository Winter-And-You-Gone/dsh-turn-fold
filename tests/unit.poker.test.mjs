// Poker 视觉测试（插件签名视觉保留验证）：
//   - 活动 → 花色映射（thinking→♥ read→♠ edit→♦ commands→♣ 编排→鲸鱼）
//   - 牌堆/扇形 SVG（3 牌 / 5 牌 / 鲸鱼牌面）与运行中翻牌 SVG
//   - 组件渲染（PokerIcon / PokerSpinIcon）与 reduced-motion / 无 WAAPI 的静态降级
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { loadPlugin } from './helpers/loader.mjs'

const require = createRequire(import.meta.url)

import dom, { sharedWindow, sharedDocument } from './helpers/dom.mjs'

// 官方 UI 原语桩：chevron 图标 / Toast（组件身份稳定即可，渲染为空元素）
const PRIMITIVES_STUB = {
  IconChevronDownOutline14: function IconChevronDownStub() { return null },
  IconChevronRightOutline14: function IconChevronRightStub() { return null },
  Toast: function ToastStub() { return null },
}
const { test: T } = loadPlugin({ window: sharedWindow })
const react = require('react')

let container = null
let root = null
function mount(el) {
  container = sharedDocument.createElement('div')
  sharedDocument.body.appendChild(container)
  root = createRoot(container)
  act(() => { root.render(el) })
}

beforeEach(() => {
  sharedWindow.localStorage.clear()
  T.setIconStyle('poker')
})

afterEach(() => {
  if (root) {
    act(() => { root.unmount() })
    root = null
  }
  if (container) {
    container.remove()
    container = null
  }
})

describe('活动 → 花色映射（Step Poker Skin 数据源）', () => {
  it('goal 指定映射：thinking→heart read→spade edit→diamond commands→club 编排→whale', () => {
    assert.equal(T.activitySuitOf('thinking'), 'heart')
    assert.equal(T.activitySuitOf('questions'), 'heart')
    assert.equal(T.activitySuitOf('read'), 'spade')
    assert.equal(T.activitySuitOf('readImage'), 'spade')
    assert.equal(T.activitySuitOf('search'), 'spade')
    assert.equal(T.activitySuitOf('webSearch'), 'spade')
    assert.equal(T.activitySuitOf('webFetch'), 'spade')
    assert.equal(T.activitySuitOf('edit'), 'diamond')
    assert.equal(T.activitySuitOf('write'), 'diamond')
    assert.equal(T.activitySuitOf('commands'), 'club')
    assert.equal(T.activitySuitOf('code'), 'club')
    assert.equal(T.activitySuitOf('subagents'), 'whale')
    assert.equal(T.activitySuitOf('plan'), 'whale')
    assert.equal(T.activitySuitOf('tools'), 'whale')
  })

  it('未登记活动回退 heart（官方默认 activity=thinking 同款）', () => {
    assert.equal(T.activitySuitOf('somethingNew'), 'heart')
    assert.equal(T.activitySuitOf(undefined), 'heart')
  })

  it('官方 ProcessActivity 词表全覆盖', () => {
    const official = ['thinking', 'read', 'readImage', 'search', 'edit', 'write', 'commands', 'code', 'webSearch', 'webFetch', 'subagents', 'plan', 'questions', 'tools']
    for (const a of official) assert.ok(T.ACTIVITY_SUIT[a] !== undefined, '缺活动 ' + a)
  })
})

describe('SVG 生成', () => {
  it('buildPokerSVGBase(3)：3 张牌 + 各牌独立 mask', () => {
    const svg = T.buildPokerSVGBase(3, 'spade')
    assert.equal((svg.match(/ccg-poker-card/g) || []).length, 3)
    assert.equal((svg.match(/<mask /g) || []).length, 3)
    assert.ok(svg.includes('ccg-poker-pip'), '花色点已注入')
  })

  it('buildPokerSVGBase(5, deepseek)：5 张牌 + 鲸鱼 defs', () => {
    const svg = T.buildPokerSVGBase(5, 'deepseek')
    assert.equal((svg.match(/ccg-poker-card/g) || []).length, 5)
    assert.ok(svg.includes('ccg-poker-logo-'), '鲸鱼 logo 注入 defs')
    assert.ok(svg.includes('use href="#ccg-poker-logo-'), 'pip 引用鲸鱼')
  })

  it('buildPokerSpinSVG：四花色循环 + DeepSeek 背面 + 唯一 id 替换', () => {
    const svg = T.buildPokerSpinSVG('uid42')
    assert.ok(svg.includes('axis-deepseek-uid42'), 'uid 替换')
    // 花色名不出现在 markup（可见性用 SMIL 关键帧驱动）：4 组正面 + 1 组背面 = 5 组循环
    assert.equal((svg.match(/<animate /g) || []).length, 5, '四花色 + 背面的循环动画')
    assert.ok(svg.includes('axis-deepseek-uid42'), '鲸鱼背面')
    assert.ok(svg.includes('animateTransform'), '翻转动画')
    assert.ok(svg.includes('repeatCount="indefinite"'))
  })

  it('pokerTransforms：牌堆 ↔ 扇形两套位姿', () => {
    const stack = T.pokerTransforms(3, false)
    const fan = T.pokerTransforms(3, true)
    assert.notDeepEqual(stack, fan)
    assert.equal(Object.keys(T.pokerTransforms(5, false)).length, 5)
  })

  it('pokerFacePool：注入数据后含鲸鱼牌面', () => {
    assert.ok(T.POKER_SPIN_DEEPSEEK, 'ICON_DEFAULTS 已注入鲸鱼数据')
    assert.deepEqual(T.pokerFacePool(), ['spade', 'heart', 'diamond', 'club', 'deepseek'])
  })

  it('foldSuitFor：同一 session + turn 牌面稳定，且属于牌面池', () => {
    const pool = T.pokerFacePool()
    const suit = T.foldSuitFor('sess-stable', 13)
    assert.equal(T.foldSuitFor('sess-stable', 13), suit)
    assert.ok(pool.includes(suit))
    assert.ok(T.pokerFaceAssigned.has('sess-stable|turn:13'), '缓存 key 必须含 session 身份')
  })

  it('suitMaskImage：四花色 + 鲸鱼都能产出 mask data-URI', () => {
    for (const suit of ['heart', 'spade', 'diamond', 'club', 'whale']) {
      const img = T.suitMaskImage(suit)
      assert.ok(img.startsWith('url("data:image/svg+xml,'), suit + ' mask 缺失')
    }
  })
})

// ── 回合折叠栏运行态 = 牌面翻转·竖直对角线轴（回归守卫） ──
// 曾经的 bug：CSS 里有一条 `.ccg-poker-icon .ccg-axis-rest-rotation{transform:rotate(0deg)}`
// 想做过“收起中轴 ⇄ 展开对角线轴”的开合过渡（配套的 data-spin-open 后来没人再挂），
// 结果 CSS transform 永久覆盖了 SVG transform 属性 → 运行中图标静默退化成纵向中轴。
// 轴角只认 SVG 属性（数据源 icons/default.json → pokerSpin.restAngle）。
describe('运行中翻牌轴 = 竖直对角线轴', () => {
  const spin = T.ICON_DEFAULTS.pokerSpin
  const cardW = spin.h * spin.pokerRatio
  const axisDeg = Math.atan(cardW / spin.h) * 180 / Math.PI   // 5:7 卡牌 ≈ 35.5377°

  const axisOf = (svg) => {
    const m = svg.match(/class="ccg-axis-rest-rotation" transform="rotate\((-?[0-9.]+)\)"/)
    return m ? Number(m[1]) : null
  }

  it('buildPokerSpinSVG：轴角 = atan(w/h)，5:7 卡牌 ≈ 35.5377°', () => {
    const angle = axisOf(T.buildPokerSpinSVG('axis-uid'))
    assert.notEqual(angle, null, '翻牌 SVG 必须带 ccg-axis-rest-rotation 旋转轴')
    assert.ok(Math.abs(angle - axisDeg) < 1e-3, '轴角应为 ' + axisDeg.toFixed(4) + '°，实际 ' + angle)
    assert.ok(Math.abs(angle - 35.5377) < 0.01, '真实扑克牌比例下竖直对角线轴 ≈ 35.5377°，实际 ' + angle)
  })

  it('几何：绕卡牌中心转该角后，左上→右下对角线竖直（dx≈0 且过中心）', () => {
    const th = axisDeg * Math.PI / 180
    const rot = (x, y) => [x * Math.cos(th) - y * Math.sin(th), x * Math.sin(th) + y * Math.cos(th)]
    const tl = rot(-cardW / 2, -spin.h / 2)
    const br = rot(cardW / 2, spin.h / 2)
    assert.ok(Math.abs(tl[0] - br[0]) < 1e-9, '对角线两端必须落在同一条竖直线上')
    assert.ok(Math.abs(tl[0]) < 1e-9, '这条竖直线必须过卡牌中心')
  })

  it('结构：squash 在根坐标系（横轴）→ 翻转轴就是这条竖直对角线；原点 = 卡牌中心', () => {
    const svg = T.buildPokerSpinSVG('axis-uid-2')
    // ① scaleX 必须包在 rotate 之外（否则翻转轴跟着卡牌一起转，就不是竖直对角线了）
    assert.ok(svg.indexOf('animateTransform') < svg.indexOf('ccg-axis-rest-rotation'),
      '共轭结构：translate(8,8) → scaleX(cosθ) → rotate(restAngle) → translate(-8,-8)')
    assert.ok(svg.includes('<g transform="translate(8 8)">'), '视图中心平移到原点')
    // ② rotate g 内层是 translate(-8 -8)：卡牌中心落在旋转局部原点（CSS 的 view-box 原点不是它）
    const tail = svg.slice(svg.indexOf('ccg-axis-rest-rotation'), svg.indexOf('ccg-axis-rest-rotation') + 200)
    assert.ok(/transform="rotate\(-?[0-9.]+\)"><g transform="translate\(-8 -8\)">/.test(tail),
      'rotate 必须绕局部原点（= 卡牌中心）旋转：' + tail.slice(0, 160))
  })

  it('CSS 不得覆盖该轴（回归守卫：CSS transform 会压掉 SVG transform 属性）', () => {
    const tag = sharedDocument.querySelector('style[data-plugin-css="' + T.CSS_ID + '"]')
    assert.ok(tag, '基础样式表已注入')
    assert.ok(!tag.textContent.includes('ccg-axis-rest-rotation'),
      'CSS 不得出现 .ccg-axis-rest-rotation —— CSS transform 覆盖 attribute 会把竖直对角线轴压回纵向中轴')
  })

  it('PokerSpinIcon：无 data-spin-open 之类的开合开关（运行态轴角恒定）', () => {
    mount(react.createElement(T.PokerSpinIcon, null))
    const icon = container.querySelector('.ccg-poker-icon')
    assert.ok(icon, '运行中图标已渲染')
    assert.equal(icon.getAttribute('data-spin-open'), null, '运行态不再有开合角度开关')
    const rendered = axisOf(container.querySelector('.ccg-poker-svg').innerHTML)
    assert.ok(Math.abs(rendered - axisDeg) < 1e-3, '渲染出的轴角 = 竖直对角线轴，实际 ' + rendered)
  })

  it('数据源没有"假旋钮"：死字段已删，留下的旋钮真的驱动输出', () => {
    // 背景：数据源曾经带着 pokerAnimSVG / scaleKeys / scaleKeyTimes / strokeW —— 运行时一个都不读
    // （builder 用 client.js 里的字面量），用户改 JSON 或写图标包**看起来生效、实际无效**。
    // 现在：关键帧改成公式（frames 旋钮），描边/时长也真的读数据源；这三条守卫把"假旋钮"
    // 挡在门外。
    const raw = JSON.parse(readFileSync(new URL('../icons/default.json', import.meta.url), 'utf8'))
    assert.ok(!('pokerAnimSVG' in raw), 'pokerAnimSVG（54 KB、零消费者）不得回到数据源')
    for (const dead of ['scaleKeys', 'scaleKeyTimes']) {
      assert.ok(!(dead in raw.pokerSpin), 'pokerSpin.' + dead + ' 是生成物，不该存进数据源（会与公式分叉）')
    }
    // 公式 ↔ 旧表：frames = 72（5°/步）时逐字节等同历史字面量（视觉零变化）
    const csv = T.pokerSpinFrameCsv(72)
    assert.equal(csv.scale.split(';').length, 73, '73 个关键帧（72 步转一圈）')
    assert.ok(csv.scale.startsWith('1 1;0.996195 1;0.984808 1;0.965926 1'), 'cos(5°k) 序列：' + csv.scale.slice(0, 40))
    assert.ok(csv.scale.includes(';-1 1;'), '经过 -1（背面零宽切面）')
    assert.equal(csv.keyTimes.split(';').length, 73)
    assert.ok(csv.keyTimes.startsWith('0;0.013889;0.027778') && csv.keyTimes.endsWith(';1'), 'k/72 时间轴')
    const svg = T.buildPokerSpinSVG('knob-check')
    assert.ok(svg.includes('values="' + csv.scale + '"'), 'builder 必须用同一份公式（数据源 frames 驱动）')
    assert.ok(svg.includes('stroke-width="' + T.ICON_DEFAULTS.pokerSpin.strokeW + '"'), '描边读数据源 strokeW')
    assert.ok(svg.includes('dur="1.6s"') && svg.includes('dur="6.4s"'), '默认时长：1.6s/翻牌、6.4s/整轮')
  })

  it('图标包的 pokerSpin 旋钮真的生效（strokeW / frames / flipMs 一路到渲染）', () => {
    // 这条是"方便用户自定义"的验收：写一个图标包 → 刷新 → 图标真的变，而不是假旋钮。
    const pack = {
      meta: T.ICON_DEFAULTS.meta,
      pokerPips: T.ICON_DEFAULTS.pokerPips,
      pokerSpin: { strokeW: 2, frames: 36, flipMs: 800 },
    }
    sharedWindow.localStorage.setItem('dsh-turn-fold:icons', JSON.stringify(pack))
    try {
      const { test: T2 } = loadPlugin({ window: sharedWindow })
      const svg = T2.buildPokerSpinSVG('pack-check')
      assert.ok(svg.includes('stroke-width="2"'), 'strokeW 旋钮生效')
      const csv36 = T2.pokerSpinFrameCsv(36)
      assert.equal(csv36.scale.split(';').length, 37, 'frames=36 → 37 个值')
      assert.ok(svg.includes('values="' + csv36.scale + '"'), 'frames 旋钮生效（10°/步的 cos 序列）')
      assert.ok(svg.includes('dur="0.8s"'), 'flipMs 旋钮生效（800ms）')
      assert.ok(svg.includes('dur="3.2s"'), '整轮 = 4 × flipMs')
    } finally {
      sharedWindow.localStorage.removeItem('dsh-turn-fold:icons')
    }
  })
})

// ── Turn 顶层牌面：per-session shuffle bag（本轮修复） ──
describe('Turn 顶层牌面 shuffle bag', () => {
  it('shufflePokerFaces：Fisher–Yates 只做置换（集合/长度不变、不改入参、RNG 决定顺序）', () => {
    const faces = ['a', 'b', 'c', 'd', 'e']
    const zero = T.shufflePokerFaces(faces, () => 0)
    assert.deepEqual(faces, ['a', 'b', 'c', 'd', 'e'], '不得修改入参')
    assert.deepEqual(zero.slice().sort(), faces.slice().sort(), '只置换，不增删')
    assert.notDeepEqual(zero, faces, 'RNG=0 时确实换了顺序（不是恒等）')
    assert.deepEqual(T.shufflePokerFaces(faces, () => 0), zero, '同一 RNG → 结果确定')
  })

  it('一个完整 bag 内不重复：连续 5 个不同 Turn → 五种牌面各出现一次', () => {
    const pool = T.pokerFacePool()
    assert.equal(pool.length, 5, '五牌面池（含鲸鱼）')
    const suits = [1, 2, 3, 4, 5].map((n) => T.foldSuitFor('bag-fill-1', n))
    assert.equal(new Set(suits).size, 5, '同一批内不得重复：' + suits.join(','))
    for (const s of suits) assert.ok(pool.includes(s))
  })

  it('第二个 bag 重新洗牌，且每一批仍是完整集合（连续 10 个 Turn）', () => {
    const all = []
    for (let n = 1; n <= 10; n += 1) all.push(T.foldSuitFor('bag-fill-2', n))
    assert.equal(new Set(all.slice(0, 5)).size, 5, '第一批 5 种全出现：' + all.slice(0, 5).join(','))
    assert.equal(new Set(all.slice(5)).size, 5, '第二批 5 种全出现：' + all.slice(5).join(','))
  })

  it('袋边界不连续重复：重洗后首张 !== 上一批末张（确定性 RNG，连续 4 批）', () => {
    const state = { remaining: [], previous: undefined, pool: '' }
    const size = T.pokerFacePool().length
    const hands = []
    for (let i = 0; i < size * 4; i += 1) hands.push(T.nextTurnPokerFace(state, () => 0))
    for (let b = 0; b < 4; b += 1) {
      assert.equal(new Set(hands.slice(b * size, (b + 1) * size)).size, size, '第 ' + (b + 1) + ' 批仍是完整集合')
      if (b > 0) assert.notEqual(hands[b * size], hands[b * size - 1], '第 ' + (b + 1) + ' 批首张不得等于上一批末张')
    }
  })

  it('重洗首张与上一批末张相同时会被换位消解（构造冲突场景）', () => {
    const pool = T.pokerFacePool()
    // rnd()=0 的 Fisher–Yates 置换首张 = pool[1]（heart）→ 直接制造冲突
    const state = { remaining: [], previous: 'heart', pool: pool.join(',') }
    const face = T.nextTurnPokerFace(state, () => 0)
    assert.notEqual(face, 'heart', '冲突必须被换位消解')
    assert.equal(state.remaining.length, pool.length - 1, '换位不丢牌')
    assert.equal(new Set(state.remaining.concat([face])).size, pool.length, '整袋仍是完整集合')
  })

  it('session 隔离：不同 session 的相同 Turn number 是不同 key，两袋互不消费', () => {
    const before = T.pokerBags.size
    assert.equal(T.foldSuitFor('iso-sess-A', 1), T.foldSuitFor('iso-sess-A', 1), 'A/turn1 稳定')
    assert.equal(T.foldSuitFor('iso-sess-B', 1), T.foldSuitFor('iso-sess-B', 1), 'B/turn1 稳定')
    assert.ok(T.pokerFaceAssigned.has('iso-sess-A|turn:1') && T.pokerFaceAssigned.has('iso-sess-B|turn:1'))
    assert.equal(T.pokerBags.size, before + 2, '每个 session 一个独立 bag')
    assert.notEqual(T.pokerBags.get('iso-sess-A'), T.pokerBags.get('iso-sess-B'), 'bag 对象不同')
    // 两个 session 各自消费 5 个 Turn：各有自己的完整一批（互不消耗对方余量）
    for (let n = 2; n <= 5; n += 1) { T.foldSuitFor('iso-sess-A', n); T.foldSuitFor('iso-sess-B', n) }
    const a = [1, 2, 3, 4, 5].map((n) => T.pokerFaceAssigned.get('iso-sess-A|turn:' + n))
    const b = [1, 2, 3, 4, 5].map((n) => T.pokerFaceAssigned.get('iso-sess-B|turn:' + n))
    assert.equal(new Set(a).size, 5, 'session A 一批完整：' + a.join(','))
    assert.equal(new Set(b).size, 5, 'session B 一批完整：' + b.join(','))
    // 不要求两个 session 的花色不同（随机允许碰巧相同），只要求状态独立
    assert.equal(T.pokerBags.get('iso-sess-A').remaining.length, 0)
    assert.equal(T.pokerBags.get('iso-sess-B').remaining.length, 0)
  })

  it('鲸鱼数据缺失 → 退化为四花色池，每 4 个 Turn 完整遍历一次', () => {
    const pack = { meta: { name: 'no-deepseek-pack', compat: '>=0.0.0' } }
    sharedWindow.localStorage.setItem(T.ICONS_STORAGE_KEY, JSON.stringify(pack))
    try {
      const { test: T4 } = loadPlugin({ window: sharedWindow })
      assert.deepEqual(T4.pokerFacePool(), ['spade', 'heart', 'diamond', 'club'], '无鲸鱼数据 → 四牌面池')
      const first = [1, 2, 3, 4].map((n) => T4.foldSuitFor('no-ds-session', n))
      const second = [5, 6, 7, 8].map((n) => T4.foldSuitFor('no-ds-session', n))
      assert.equal(new Set(first).size, 4, '第一批 4 种全出现：' + first.join(','))
      assert.equal(new Set(second).size, 4, '第二批 4 种全出现：' + second.join(','))
      assert.notEqual(second[0], first[3], '四牌面模式同样避免跨批连续重复')
    } finally {
      sharedWindow.localStorage.clear()
    }
  })

  it('Running Turn 仍走 PokerSpinIcon，且不消耗 shuffle bag', () => {
    const bagKey = 'running-no-consume'
    T.foldSuitFor(bagKey, 1)                       // 先建袋
    const before = T.pokerBags.get(bagKey).remaining.length
    const live = T.turnPokerIcon('poker', 4, true, false, 2, true, bagKey)
    assert.equal(live.type, T.PokerSpinIcon, '运行中仍是翻牌动画')
    assert.equal(T.pokerBags.get(bagKey).remaining.length, before, 'running 调用不得消耗牌面')
    const settled = T.turnPokerIcon('poker', 4, false, false, 2, true, bagKey)
    assert.equal(settled.type, T.PokerIcon)
    assert.equal(settled.props.suit, T.foldSuitFor(bagKey, 2), '结束后从 bag 取牌面')
  })

  it('鲸鱼牌面渲染为 Logo 引用（SVG 用 <use href="#ccg-poker-logo-*">）', () => {
    const session = 'deepseek-render-session'
    let sawWhale = false
    for (let n = 1; n <= 5; n += 1) if (T.foldSuitFor(session, n) === 'deepseek') sawWhale = true
    assert.ok(sawWhale, '一个完整 bag 内必然出现鲸鱼牌面')
    mount(react.createElement(T.PokerIcon, { count: 3, suit: 'deepseek', open: false }))
    const pip = container.querySelector('.ccg-poker-pip')
    assert.ok(pip, '牌面 pip 存在')
    assert.ok(pip.innerHTML.includes('ccg-poker-logo-'), '鲸鱼牌面以 Logo <use> 渲染：' + pip.innerHTML)
  })

  it('重渲染 / 开合不改变同一 Turn 的牌面（组件级 + SVG 牌面一致）', () => {
    const session = 'rerender-session'
    const bar = (open) => react.createElement(T.TurnBarView, {
      running: false, open: open, canToggle: true, turnNumber: 21, label: '完成 · 1秒',
      poker: T.turnPokerIcon('poker', 3, false, open, 21, true, session), round: '第21轮',
    })
    mount(bar(false))
    const suit = T.foldSuitFor(session, 21)
    assert.equal(T.turnPokerIcon('poker', 3, false, false, 21, true, session).props.suit, suit)
    const pipHtml = container.querySelector('.ccg-poker-pip').innerHTML
    if (suit === 'deepseek') assert.ok(pipHtml.includes('ccg-poker-logo-'), '鲸鱼牌面渲染为 Logo')
    else assert.ok(pipHtml.includes(T.POKER_PIPS[suit].path.slice(0, 30)), suit + ' 牌面渲染为对应花色 glyph')
    for (const open of [true, false, true]) {
      act(() => { root.render(bar(open)) })
      assert.equal(T.foldSuitFor(session, 21), suit, '开合/重渲染后花色不变')
      assert.equal(T.turnPokerIcon('poker', 3, false, open, 21, true, session).props.suit, suit)
      assert.equal(container.querySelector('.ccg-poker-pip').innerHTML, pipHtml, '渲染出的牌面内容不变')
    }
  })
})

describe('组件渲染与降级', () => {
  it('PokerIcon 渲染出 svg 与 3 张牌', () => {
    mount(react.createElement(T.PokerIcon, { count: 3, suit: 'heart', open: false }))
    const svg = container.querySelector('.ccg-poker-icon svg')
    assert.ok(svg)
    assert.equal(container.querySelectorAll('.ccg-poker-card').length, 3)
  })

  it('PokerSpinIcon 渲染翻牌动画 SVG', () => {
    mount(react.createElement(T.PokerSpinIcon, null))
    assert.ok(container.querySelector('.ccg-poker-icon .ccg-poker-svg svg'))
  })

  it('无 WAAPI 环境（jsdom）→ RollDigit 直接定位、无动画调用', () => {
    mount(react.createElement(T.RollDigit, { digit: 3 }))
    const strip = container.querySelector('.ccg-roll-strip')
    assert.ok(strip)
    assert.equal(strip.style.transform, 'translateY(-30%)')
  })

  it('prefers-reduced-motion → RollDigit 静态定位', () => {
    dom.window.matchMedia = (q) => ({ matches: q.includes('reduce'), addListener() {}, removeListener() {} })
    try {
      mount(react.createElement(T.RollDigit, { digit: 7 }))
      const strip = container.querySelector('.ccg-roll-strip')
      assert.equal(strip.style.transform, 'translateY(-70%)')
    } finally {
      delete dom.window.matchMedia
    }
  })

  it('AnimatedLabel：数字段逐位滚动 + sr-only 完整文案', () => {
    mount(react.createElement(T.AnimatedLabel, { label: '耗时1分32秒' }))
    assert.ok(container.querySelector('.ccg-sr-only').textContent === '耗时1分32秒')
    assert.ok(container.querySelectorAll('.ccg-roll-cell').length >= 3, '数字位滚动窗')
  })

  it('turnPokerIcon：poker 风格运行中→翻牌、结束→牌堆；native→官方几何 chevron（running/不可折叠→undefined）', () => {
    // 渲染层 smoke：返回元素类型正确
    const live = T.turnPokerIcon('poker', 4, true, false, 13, true)
    assert.ok(live, '运行中返回翻牌图标元素')
    const closed = T.turnPokerIcon('poker', 4, false, false, 13, true)
    assert.ok(closed, '结束返回牌堆图标元素')
    T.setIconStyle('native')
    const chevron = T.turnPokerIcon('native', 4, false, false, 13, true)
    assert.ok(chevron, 'native 结束且可折叠 → 官方风格 chevron 元素')
    assert.equal(chevron.props.open, false, '收起态向下')
    assert.ok(T.turnPokerIcon('native', 4, false, true, 13, true).props.open, '展开态 rotate(180deg)')
    assert.equal(T.turnPokerIcon('native', 4, true, false, 13, true), undefined, 'native 运行中无前导图标（官方如此）')
    assert.equal(T.turnPokerIcon('native', 4, false, false, 13, false), undefined, 'native 不可折叠（Verbose）无 chevron（官方如此）')
    T.setIconStyle('poker')
  })
})

// ══════════════════════════════════════════════════════════════════════
// 3 张牌身份连续性：stack ↔ fan 是同一张牌，层级与身份都不交换
// ══════════════════════════════════════════════════════════════════════
// 旧实现 fan3 = { 1: -26°, 2: +26°, 3: 0° } ⇒ 收起时的顶牌 card3 展开后**留在中间**，
// card2 跑到最右并（配合 order [1,3,2]）变成顶层——顶牌身份被顶替。
// 正确映射与 fan5 同构：居中那张不带旋转，两侧对称，id 越大越靠右（顶牌向右展开）。
describe('3 张牌身份连续性（stack ↔ fan 同一 card id）', () => {
  const rotateOf = (s) => { const m = /rotate\(([-\d.]+) 8 12\)/.exec(s); return m ? Number(m[1]) : 0 }
  const translateOf = (s) => { const m = /translate\(([-\d.]+), ([-\d.]+)\)/.exec(s); return { x: Number(m[1]), y: Number(m[2]) } }

  it('stack3：card1 底（右下）、card2 中、card3 顶（左上）', () => {
    const stack = T.pokerTransforms(3, false)
    const [c1, c2, c3] = [translateOf(stack[1]), translateOf(stack[2]), translateOf(stack[3])]
    assert.ok(c1.x > c2.x && c2.x > c3.x, 'x 递减：card1 最右、card3 最左')
    assert.ok(c1.y > c2.y && c2.y > c3.y, 'y 递减：card1 最下、card3 最上（顶牌）')
    assert.equal(rotateOf(stack[1]) + rotateOf(stack[2]) + rotateOf(stack[3]), 0, '牌堆无旋转')
  })

  it('fan3：card1 左（-26°）、card2 居中（0°）、card3 右（+26°）', () => {
    const fan = T.pokerTransforms(3, true)
    assert.equal(rotateOf(fan[1]), -26, 'card1 = 左牌')
    assert.equal(rotateOf(fan[2]), 0, 'card2 = 中牌（居中不旋转）')
    assert.equal(rotateOf(fan[3]), 26, 'card3 = 右牌（原顶牌向右展开）')
  })

  it('fan3 三张统一 translate(0, -0.18)（只改身份映射，不动几何量）', () => {
    const fan = T.pokerTransforms(3, true)
    for (const i of [1, 2, 3]) {
      const t = translateOf(fan[i])
      assert.equal(t.x, 0, 'card' + i + ' tx')
      assert.equal(t.y, -0.18, 'card' + i + ' ty')
    }
  })

  it('身份方向连续：底层牌向左、顶牌向右（与 fan5 同一规律）', () => {
    const fan3 = T.pokerTransforms(3, true), fan5 = T.pokerTransforms(5, true)
    assert.ok(rotateOf(fan3[1]) < 0 && rotateOf(fan3[3]) > 0, '3 张：id 小在左、id 大在右')
    assert.ok(rotateOf(fan5[1]) < 0 && rotateOf(fan5[5]) > 0, '5 张同规律')
    assert.equal(rotateOf(fan5[3]), 0, '5 张居中那张也不旋转（fan3 与 fan5 同构）')
    // 每张牌在 stack 里越靠上（y 越小），fan 里越靠右（角度越大）——身份不被交换
    const stack3 = T.pokerTransforms(3, false)
    const order = [1, 2, 3].sort((a, b) => translateOf(stack3[b]).y - translateOf(stack3[a]).y)
    const angles = order.map((i) => rotateOf(fan3[i]))
    assert.deepEqual(angles, [-26, 0, 26], 'stack 从下到上 ↔ fan 从左到右一一对应：' + JSON.stringify(angles))
  })

  it('绘制顺序 = 身份序（开合一致）：card3 在两种状态下都是 z-top', () => {
    assert.deepEqual(T.pokerPaintOrder(3), [1, 2, 3], '3 张 closed')
    assert.deepEqual(T.pokerPaintOrder(5), [1, 2, 3, 4, 5], '5 张 closed')
    // 旧 bug 的形态：3 张展开曾是 [1,3,2]（card2 压顶）
    assert.notDeepEqual(T.pokerPaintOrder(3), [1, 3, 2], '不得再用 [1,3,2]')
    const zOf = (count) => Object.fromEntries(T.pokerPaintOrder(count).map((id, index) => [id, index]))
    for (const count of [3, 5]) {
      const z = zOf(count)
      assert.equal(z[count], count - 1, '最大 id 的牌必须最上层')
      assert.ok(z[3] > z[2] && z[2] > z[1], 'z 随 id 递增')
    }
  })

  it('iconConfig 数据源与代码 fallback 的 fan3 必须逐值一致（单一事实来源）', async () => {
    const { readFileSync } = await import('node:fs')
    const json = JSON.parse(readFileSync(new URL('../icons/default.json', import.meta.url), 'utf8'))
    const embedded = T.ICON_DEFAULTS.pokerTransforms
    assert.deepEqual(embedded.fan3, json.pokerTransforms.fan3, 'ICON_DEFAULTS 与 default.json 一致')
    const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
    const fallback = /: t\.fan3 \|\| \{ ([^}]+) \}/.exec(source)
    assert.ok(fallback, 'client.js 里存在 fan3 fallback')
    for (const [id, value] of Object.entries(json.pokerTransforms.fan3)) {
      assert.ok(fallback[1].includes(`${id}: "${value}"`), 'fallback 缺少/不匹配 card' + id + '：' + value)
    }
  })
})
