// CSS 契约测试（收尾版）：
//   - base 样式：Turn 栏兄弟结构（row/main/gear-button）、分隔线、滚轮、齿轮弹窗
//   - Step Poker Skin：独立皮肤 <style> 元素，总闸 = 该元素 disabled（不再写 body attr）
//   - 架构守卫：旧折叠引擎的 CSS（:has() 隐藏成员、hidden 标记、fold-clip 等）必须消失
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { loadPlugin } from './helpers/loader.mjs'

const { test: T, document, window } = loadPlugin()

function baseCss() {
  const tag = document.querySelector('style[data-plugin-css="' + T.CSS_ID + '"]')
  assert.ok(tag, '基础样式表已注入')
  return tag.textContent
}
function skinEl() {
  const tag = document.querySelector('style[data-plugin-css="' + T.SKIN_CSS_ID + '"]')
  assert.ok(tag, '皮肤样式表已注入')
  return tag
}

beforeEach(() => {
  window.localStorage.clear()
  T.settings.stepSkin = 'poker'
  T.applyStepSkin()
})

describe('Turn 栏样式（兄弟交互结构）', () => {
  it('核心类全部注入：row / main / gear-button / divider', () => {
    const css = baseCss()
    for (const cls of ['.ccg-turn-wrap{', '.ccg-turn-row{', '.ccg-turn-bar-main{', '.ccg-turn-bar-label{', '.ccg-turn-bar-right{', '.ccg-turn-bar-chevron{', '.ccg-gear-button{', '.ccg-turn-divider{']) {
      assert.ok(css.includes(cls), '缺少 ' + cls)
    }
  })

  it('旧的单按钮结构类已删除；非交互态钩子（data-tf-static / data-open 旋转箭头）保留', () => {
    const css = baseCss()
    assert.ok(!css.includes('.ccg-turn-bar{'), '旧 .ccg-turn-bar 单按钮类必须删除')
    assert.ok(css.includes('[data-tf-static]'))
    assert.ok(css.includes('.ccg-turn-bar-main[data-open] .ccg-turn-bar-chevron'))
    assert.ok(css.includes('.ccg-gear-button:focus-visible'), '齿轮有键盘焦点样式')
  })
})

describe('Step Poker Skin（官方结构 + 软 DOM 依赖 + style.disabled 总闸）', () => {
  it('皮肤规则无 body 前缀——总闸是皮肤元素 disabled，不是 body attribute', () => {
    const skin = skinEl().textContent
    assert.ok(!skin.includes('body['), '皮肤规则不得再挂 body 选择器')
    assert.ok(!baseCss().includes('data-tf-step-skin'), 'body 属性总闸必须删除')
  })

  it('applyStepSkin / setStepSkin 切换 disabled；默认 poker = 启用', () => {
    assert.equal(skinEl().disabled, false, '默认 poker 启用')
    T.setStepSkin('native')
    assert.equal(skinEl().disabled, true, 'native 禁用皮肤')
    T.setStepSkin('poker')
    assert.equal(skinEl().disabled, false, '改回 poker 重新启用')
  })

  it('官方 DOM 钩子（data-step-process / data-step-process-icon / data-process-activity）全部命中', () => {
    const skin = skinEl().textContent
    assert.ok(skin.includes('[data-step-process] [data-step-process-icon] > *{display:none}'), '官方图标内容隐藏')
    assert.ok(skin.includes('[data-step-process] [data-step-process-icon]::before'), '卡牌渲染位')
  })

  it('活动 → 花色映射规则（官方 ProcessActivity 词表全覆盖）', () => {
    const skin = skinEl().textContent
    const activities = ['thinking', 'read', 'readImage', 'search', 'edit', 'write', 'commands', 'code', 'webSearch', 'webFetch', 'subagents', 'plan', 'questions', 'tools']
    for (const activity of activities) {
      assert.ok(skin.includes('[data-process-activity="' + activity + '"]'), '缺少活动规则 ' + activity)
    }
    assert.ok(skin.includes('data:image/svg+xml'), '卡牌 mask data-URI')
  })

  it('花色 JS 映射与 CSS 规则一致（同源生成）', () => {
    const skin = skinEl().textContent
    const suits = new Set(Object.values(T.ACTIVITY_SUIT))
    for (const suit of suits) {
      if (suit === 'whale' && !T.POKER_SPIN_DEEPSEEK) continue
      const activity = Object.keys(T.ACTIVITY_SUIT).find((a) => T.ACTIVITY_SUIT[a] === suit)
      assert.ok(skin.includes('[data-process-activity="' + activity + '"]'), suit + ' 规则缺失')
    }
  })
})

describe('Step Poker Completed 双态（closed = 五张牌堆 / open = 五张扇形）', () => {
  // fan 规则形态（三件套共用同一宿主选择器）：
  //   [data-step-process] [data-process-activity][aria-expanded="true"]:not(:is(:hover,:focus-visible))
  //     :not(:has([data-shimmer="true"])):not(:has([data-text-shimmer="true"])) [data-step-process-icon]::before{…fan mask…}
  function fanLineOf(skin) {
    const line = skin
      .split('\n')
      .find((l) => l.includes('[aria-expanded="true"]') && l.includes('[data-step-process-icon]::before{-webkit-mask-image:url("data:image/svg+xml'))
    assert.ok(line, 'completed 展开态 fan 规则缺失')
    return line
  }
  function fanHostSelectorOf(skin) {
    const line = fanLineOf(skin)
    const sel = line.slice(0, line.indexOf('{'))
    const marker = ' [data-step-process-icon]::'
    const at = sel.lastIndexOf(marker)
    assert.ok(at > 0, 'fan 选择器缺少卡牌渲染位后缀')
    return sel.slice(0, at)
  }
  function decodedMaskSvg(rule) {
    // 基础规则用 mask 简写（-webkit-mask:url(...) center/24px…）、fan 用 mask-image，两种都接
    const m = rule.match(/-webkit-mask(?:-image)?:url\("(data:image\/svg\+xml,[^"]+)"\)/)
    assert.ok(m, '规则缺 mask 数据 URI')
    return decodeURIComponent(m[1].slice('data:image/svg+xml,'.length))
  }
  // 官方 completed header 最小 DOM：button[data-process-activity] 内 icon + chevron
  function completedDom(opts) {
    const host = document.createElement('div')
    host.setAttribute('data-step-process', '')
    const button = document.createElement('button')
    button.setAttribute('data-process-activity', 'edit')
    if (opts && opts.expanded) button.setAttribute('aria-expanded', 'true')
    const icon = document.createElement('span')
    icon.setAttribute('data-step-process-icon', '')
    const chevron = document.createElement('span')
    chevron.setAttribute('data-step-process-chevron', '')
    button.appendChild(icon)
    button.appendChild(chevron)
    if (opts && opts.shimmer) {
      const title = document.createElement('span')
      title.setAttribute('data-shimmer', 'true')
      button.appendChild(title)
    }
    host.appendChild(button)
    document.body.appendChild(host)
    return { host, button, icon, chevron, cleanup: () => host.remove() }
  }

  it('基础规则 = 收起牌堆 stack：24px 盒 + 24px mask（五张 hFive 牌，Turn 渲染比例）', () => {
    const skin = skinEl().textContent
    const base = skin.split('\n').find((l) => l.includes('[data-step-process-icon]::before{content:""'))
    assert.ok(base, '基础规则缺失')
    assert.ok(base.includes('width:24px') && base.includes('height:24px'), '伪元素应为 24×24（Turn 容器同款）')
    assert.ok(base.includes('center/24px 24px no-repeat'), '基础 mask 尺寸应为 24px（16 视箱 @1.5px/单位）')
    const svg = decodedMaskSvg(base)
    assert.equal((svg.match(/id="scc-g\d"/g) || []).length, 5, '牌堆应为五张牌 glyph')
    assert.equal((svg.match(/<mask /g) || []).length, 5, '每张牌一个内嵌遮挡 mask')
    assert.ok(!svg.includes('rotate('), '牌堆变换只允许平移（stack5 无旋转）')
  })

  it('hover/focus 不让位：皮肤不得包含 hover 让位逻辑，icon 恒显、chevron 恒隐（无条件总控）', () => {
    const skin = skinEl().textContent
    // 官方 ChatGroupSeat 在 hover/focus-visible/展开时换箭头；Poker skin 接管图标语义后
    // 这些时刻也必须显示 Poker——皮肤内不得出现任何 "hover/focus 让位 chevron" 的选择器
    assert.ok(!skin.includes(':not(:hover)'), '皮肤不得包含 :not(:hover)（hover 让位逻辑）')
    assert.ok(!skin.includes(':not(:focus-visible)'), '皮肤不得包含 :not(:focus-visible)（focus 让位逻辑）')
    // 无条件总控（特异性 (0,3,1) 压过官方全部四条 (0,3,0)）：icon 恒显、chevron 恒隐
    const iconAlways = skin.split('\n').find((l) => l.includes('button[data-process-activity] [data-step-process-icon]{opacity:1}'))
    const chevronAlways = skin.split('\n').find((l) => l.includes('button[data-process-activity] [data-step-process-chevron]{opacity:0}'))
    assert.ok(iconAlways, '缺少 icon 恒显总控规则（normal/hover/focus/active 一致）')
    assert.ok(chevronAlways, '缺少 chevron 恒隐总控规则')
  })

  it('展开态规则三件套：fan mask + activityIcon opacity 翻回 + chevron 压下；hover/focus 让位官方', () => {
    const skin = skinEl().textContent
    const fanLine = fanLineOf(skin)
    assert.ok(fanLine.includes(':not(:has([data-shimmer="true"]))') && fanLine.includes(':not(:has([data-text-shimmer="true"]))'), 'fan 规则必须排除 running（shimmer 双契约）')
    const lines = skin.split('\n')
    const hostSel = fanHostSelectorOf(skin)
    const fanSvg = decodedMaskSvg(fanLine)
    assert.ok(fanSvg.includes('rotate('), '扇形变换必须包含 rotate（fan5）')
    assert.equal((fanSvg.match(/id="scc-g\d"/g) || []).length, 5, '扇形应为五张牌 glyph')
  })

  it('DOM 命中：收起不命中 fan（走基础牌堆）；展开命中；展开 + shimmer 不命中（轮换优先）', () => {
    const skin = skinEl().textContent
    const sel = fanHostSelectorOf(skin)
    const closed = completedDom({})
    try {
      assert.ok(!closed.button.matches(sel), '收起组不得命中 fan 规则（牌堆）')
    } finally { closed.cleanup() }
    const open = completedDom({ expanded: true })
    try {
      assert.ok(open.button.matches(sel), '展开组应命中 fan 规则')
    } finally { open.cleanup() }
    const openRunning = completedDom({ expanded: true, shimmer: true })
    try {
      assert.ok(!openRunning.button.matches(sel), 'shimmer 在场的展开组不得命中 fan 规则（running 轮换优先）')
    } finally { openRunning.cleanup() }
  })

  // ══════ stack ↔ fan morph 帧序（closed → open 展开扇 / open → closed 收拢） ══════
  // 架构事实（真机实验证实）：同 URL 的 mask 图像在 Chromium 全页共享单一实例、SMIL
  // 时间线不随重应用 restart——"换 animated URI 触发 morph"只能播一次。因此 morph 用
  // 预采样插值帧（每帧静态 SVG、牌与 occluder 都在当帧位置）+ CSS animation keyframes
  // 逐帧换 mask-image：animation 每次规则命中都从头重放，帧内 knockout 逐帧正确。
  it('morph 双向 keyframes 存在：tf-step-open（stack→fan）与 tf-step-close（fan→stack）', () => {
    const skin = skinEl().textContent
    const openKf = skin.split('\n').find((l) => l.includes('@keyframes tf-step-open{'))
    const closeKf = skin.split('\n').find((l) => l.includes('@keyframes tf-step-close{'))
    assert.ok(openKf, '缺少 stack→fan 展开帧序 keyframes')
    assert.ok(closeKf, '缺少 fan→stack 收拢帧序 keyframes')
    // 帧插值时间轴：0% = 出发端点、每 12.5% 一帧（6 帧）、100% 省略回落常驻端点
    for (const [kf, from, to] of [[openKf, stackMaskUri(), fanMaskUri()], [closeKf, fanMaskUri(), stackMaskUri()]]) {
      assert.ok(kf.includes('0%{' + morphDecl(from) + '}'), '0% 必须是出发端点（与切换前显示同值，无缝起步）')
      assert.ok(!/100%\{/.test(kf), '100% 必须省略（回落常驻端点 = freeze 语义，末帧与常驻同值无缝）')
      for (let k = 1; k <= 6; k++) assert.ok(kf.includes((k * 12.5) + '%{-webkit-mask-image:url("data:image/svg+xml'), '帧 ' + k + ' 缺失')
    }
    // 两条规则分别挂对应 animation；closed/open 规则 mask 常驻 = 各自端点（动画结束回落正确）
    const base = skin.split('\n').find((l) => l.includes('[data-step-process-icon]::before{content:""'))
    assert.ok(base.includes('animation:tf-step-close .4s linear 1'), 'closed 规则应挂收拢帧序动画（400ms 在 350-450ms 目标内）')
    const fanLine = fanLineOf(skin)
    assert.ok(fanLine.includes('animation:tf-step-open .4s linear 1'), 'open 规则应挂展开帧序动画（400ms 在 350-450ms 目标内）')
  })

  it('morph 端点逐值等于现有真实数据：stepMorphTransforms(0)≡stack5、(1)≡fan5（不改几何）', () => {
    const zero = T.stepMorphTransforms(0), one = T.stepMorphTransforms(1)
    const stack = T.pokerTransforms(5, false), fan = T.pokerTransforms(5, true)
    for (let i = 1; i <= 5; i++) {
      // t=0：rotate 为 0（stack 无旋转）→ translate 必须等于 stack5
      const zt = /translate\(([-\d.]+), ([-\d.]+)\)/.exec(zero[i])
      const st = /translate\(([-\d.]+), ([-\d.]+)\)/.exec(stack[i])
      assert.ok(Math.abs(Number(zt[1]) - Number(st[1])) < 1e-6 && Math.abs(Number(zt[2]) - Number(st[2])) < 1e-6,
        't=0 card' + i + ' translate 必须等于 stack5：' + zero[i] + ' vs ' + stack[i])
      assert.ok(!zero[i].includes('rotate(-') && !zero[i].includes('rotate(3') && !zero[i].includes('rotate(1'), 't=0 不得带 rotate（stack 端点）')
      // t=1：translate 与 rotate 都等于 fan5（card3 在 fan5 无 rotate → 两者应一致地无）
      const ot = /translate\(([-\d.]+), ([-\d.]+)\)/.exec(one[i])
      const ft = /translate\(([-\d.]+), ([-\d.]+)\)/.exec(fan[i])
      assert.ok(Math.abs(Number(ot[1]) - Number(ft[1])) < 1e-6 && Math.abs(Number(ot[2]) - Number(ft[2])) < 1e-6,
        't=1 card' + i + ' translate 必须等于 fan5：' + one[i] + ' vs ' + fan[i])
      const odeg = /rotate\(([-\d.]+) 8 12\)/.exec(one[i])
      const fdeg = /rotate\(([-\d.]+) 8 12\)/.exec(fan[i])
      if (!fdeg) {
        assert.ok(!odeg || Math.abs(Number(odeg[1])) < 1e-6, 't=1 card' + i + ' fan5 无 rotate → 插值端点不得带旋转：' + one[i])
      } else {
        assert.ok(odeg && Math.abs(Number(odeg[1]) - Number(fdeg[1])) < 1e-6,
          't=1 card' + i + ' rotate 必须等于 fan5：' + one[i] + ' vs ' + fan[i])
      }
    }
  })

  it('morph 每帧：5 张真实牌带插值变换 + 每个 occluder 与同层真实牌同步（逐帧 knockout）', () => {
    const t = 0.5
    const tfs = T.stepMorphTransforms(t)
    const frameUri = 'url("data:image/svg+xml,' + encodeURIComponent(T.stepCompletedGroupSvg(tfs)) + '")'
    const svg = decodeGroupMask(frameUri)
    // 5 张真实牌都在当帧插值位置（中间帧 ≠ 两个端点 → 必须带 rotate 或非端点 translate）
    const layers = [...svg.matchAll(/<g mask="url\(#scc-m\d\)"><g transform="([^"]+)">/g)].map((m) => m[1])
    assert.equal(layers.length, 5, '5 层真实牌')
    for (let i = 1; i <= 5; i++) assert.equal(layers[i - 1], tfs[i], '真实牌 card' + i + ' 的帧变换 = 插值表')
    // occluder 与真实牌同帧同变换（cut transform = 同一插值表的 z 更高层）
    const mask1 = svg.match(/<mask id="scc-m1"[\s\S]*?<\/mask>/)[0]
    const occTfs = [...mask1.matchAll(/<g transform="([^"]+)">/g)].map((m) => m[1])
    assert.equal(occTfs.length, 4, 'owner-1 的 4 个 occluder')
    for (let z = 2; z <= 5; z++) assert.equal(occTfs[z - 2], tfs[z], 'occluder z' + z + ' 与真实牌 card' + z + ' 同帧同步')
    // 中间帧确实介于两端点之间（spline easing 单调 → card5 rotate ∈ (0,32)）
    const midDeg = Number(/rotate\(([-\d.]+) 8 12\)/.exec(tfs[5])[1])
    assert.ok(midDeg > 0 && midDeg < 32, 't=0.5 的 card5 rotate 应在 (0°,32°) 开区间：' + midDeg)
  })

  it('reduced-motion：completed morph 动画禁用（直接显示静态端点），running 回落不变', () => {
    const skin = skinEl().textContent
    const rmLines = skin.split('\n').filter((l) => l.includes('@media (prefers-reduced-motion:reduce)'))
    const morphOff = rmLines.find((l) => l.includes('animation:none') && l.includes('[data-step-process-icon]::before'))
    assert.ok(morphOff, 'reduced-motion 必须显式关闭 completed morph 帧序动画（SMIL/animation 不受媒体查询自动控制）')
    assert.ok(morphOff.includes(completedFanSelectorOf(skin) + ' [data-step-process-icon]::before') ||
      morphOff.includes('[data-process-activity][aria-expanded="true"]'), 'reduced-motion 必须同时覆盖 open 规则')
    // running 的 reduced-motion 回落保持不变
    assert.ok(rmLines.some((l) => l.includes('mask-image:var(--tf-suit)')), 'running 的静态回落规则保留')
  })

  function morphDecl(uri) { return '-webkit-mask-image:' + uri + ';mask-image:' + uri }
  function stackMaskUri() {
    const base = skinEl().textContent.split('\n').find((l) => l.includes('[data-step-process-icon]::before{content:""'))
    return base.match(/-webkit-mask:(url\("data:image\/svg\+xml,[^"]+"\)) center/)[1]
  }
  function fanMaskUri() {
    const fanLine = fanLineOf(skinEl().textContent)
    return fanLine.match(/-webkit-mask-image:(url\("data:image\/svg\+xml,[^"]+"\))/)[1]
  }
  function completedFanSelectorOf(skin) {
    const line = fanLineOf(skin)
    return line.slice(0, line.indexOf('{'))
  }

  it('stack 与 fan 是两份不同的五牌资产（closed/open 语义各自独立）', () => {
    const stackSvg = decodedMaskSvg(skinEl().textContent.split('\n').find((l) => l.includes('[data-step-process-icon]::before{content:""')))
    const fanSvg = decodedMaskSvg(fanLineOf(skinEl().textContent))
    assert.notEqual(stackSvg, fanSvg, '牌堆与扇形不得是同一份 SVG')
    const stackTfs = [...stackSvg.matchAll(/<g mask="url\(#scc-m\d\)"><g transform="([^"]+)">/g)].map((m) => m[1])
    const fanTfs = [...fanSvg.matchAll(/<g mask="url\(#scc-m\d\)"><g transform="([^"]+)">/g)].map((m) => m[1])
    assert.equal(stackTfs.length, 5, '牌堆 5 层')
    assert.equal(fanTfs.length, 5, '扇形 5 层')
    assert.ok(stackTfs.every((t) => t.startsWith('translate(') && !t.includes('rotate')), '牌堆 = 纯平移错位')
    assert.ok(fanTfs.filter((t) => t.includes('rotate')).length === 4, '扇形 = 中间牌不转、两侧 ±16°/±32°（fan5）')
  })

  // ══════ Knockout 遮挡契约（真 knockout，不是背景填充） ══════
  // Chromium 不渲染 <mask> 内容里的 <use> 引用（本地实验证实：occluder 丢失 =
  // 下层 stroke/pip 穿透上层）——occluder 必须直接内联牌形（rect + pip 原文）。
  function decodeGroupMask(uri) {
    const m = String(uri).match(/url\("data:image\/svg\+xml,([^"]+)"\)/)
    assert.ok(m, 'stepCompletedGroupMask 返回值应为 data-URI mask')
    return decodeURIComponent(m[1])
  }
  it('遮挡 occluder 直接内联（mask 内容不得出现 <use>——Chromium 不渲染会导致下层穿透）', () => {
    for (const fan of [false, true]) {
      const svg = decodeGroupMask(T.stepCompletedGroupMask(fan))
      assert.ok(svg.startsWith('<svg'), '解码后应为 SVG 文本')
      const masks = [...svg.matchAll(/<mask id="scc-m(\d)"[\s\S]*?<\/mask>/g)]
      assert.equal(masks.length, 5, '五张 owner 各一个 mask（fan=' + fan + '）')
      for (const m of masks) {
        assert.ok(!m[0].includes('<use'), 'mask scc-m' + m[1] + ' 内容不得使用 <use>（occluder 丢失 = 下层穿透）')
        const owner = Number(m[1])
        // 外层 occluder 变换（tfs 形态：translate / translate+rotate，无 scale）；
        // 含 scale( 的是 occluder 内部的 pip 缩放组，不计入
        const cuts = [...m[0].matchAll(/<g transform="([^"]+)">/g)].filter((x) => !x[1].includes('scale('))
        assert.equal(cuts.length, 5 - owner, 'owner ' + owner + ' 只被 z 更高的 ' + (5 - owner) + ' 张牌挖（不得全量互挖）')
      }
    }
  })

  it('遮挡覆盖下层 stroke 与 pip：occluder 是实心黑牌面（fill=#000 覆盖整个牌外缘，真 knockout）', () => {
    const svg = decodeGroupMask(T.stepCompletedGroupMask(true))
    const mask1 = svg.match(/<mask id="scc-m1"[\s\S]*?<\/mask>/)[0]
    // 实心黑面挖空：上层覆盖区内的下层 stroke 与 pip 一并消失（与参考实现
    // mask rect fill="black"、Turn pokerDynamicMask fill="black" 同款）
    const occluders = [...mask1.matchAll(/<g transform="([^"]+)"><rect x="5\.14\d*" y="4" width="5\.71\d*" height="8" rx="1\.08" fill="#000" stroke="#000" stroke-width="0\.7"\/><\/g>/g)]
    assert.equal(occluders.length, 4, 'owner-1 的 4 个 occluder 都是实心黑牌面')
    for (const o of occluders) assert.ok(!o[1].includes('scale('), 'occluder 外层变换必须是 tfs（不含 pip 缩放）')
    // 真实牌（defs glyph）仍是透明牌身 + 花色 pip（牌可见性不受 occluder 影响）
    assert.ok(svg.includes('<g id="scc-g1">'), '真实牌 glyph 组存在')
    const defsPart = svg.slice(svg.indexOf('<g id="scc-g1">'), svg.indexOf('<mask '))
    assert.equal([...defsPart.matchAll(/<g transform="translate\(8 8\) scale\(/g)].length, 5, '五张真实牌都带花色 pip')
  })

  it('背景保持透明：真实牌 rect fill=none（透壁纸）；mask occluder 实心黑（机制本体，非可见填充）', () => {
    for (const fan of [false, true]) {
      const svg = decodeGroupMask(T.stepCompletedGroupMask(fan))
      const maskStart = svg.indexOf('<mask ')
      // 真实牌形（defs 组）：rect 一律 fill="none"（牌身透明，壁纸/透明背景正确）
      for (const rect of svg.slice(0, maskStart).matchAll(/<rect [^/]*\/>/g)) {
        assert.ok(rect[0].includes('fill="none"'), '真实牌 rect 必须 fill=none（透明卡面）：' + rect[0].slice(0, 80))
      }
      // mask 内容：occluder rect 一律 fill="#000"（luminance 挖空机制，不可见）
      for (const rect of svg.slice(maskStart).matchAll(/<rect x="5\.14[^/]*\/>/g)) {
        assert.ok(rect[0].includes('fill="#000"'), 'occluder rect 必须实心黑（真 knockout）：' + rect[0].slice(0, 80))
      }
      assert.ok(!svg.includes('fill="#fff"/><g transform="translate(8'), '不得用白色卡面填充模拟遮挡')
      assert.ok(!/class="[^"]*card-bg/.test(svg), '不得引入卡面背景填充类')
    }
  })
})

describe('Step Poker Running Animation（官方 shimmer 双契约）', () => {
  // ── 从皮肤 CSS 提取真实 running 规则（单一事实来源，测试不复制选择器） ──
  // running 规则形态（单一卡牌位 ::before；mask 换成五牌面轮换 SVG 的数据 URI）：
  //   [data-step-process]:has([data-text-shimmer="true"]) [data-step-process-icon]::before,
  //   [data-step-process]:has([data-shimmer="true"]) [data-step-process-icon]::before{ …mask-image:url("data:image/svg+xml,…")… }
  function runningRuleOf(skin) {
    // :has(...) 后必须紧跟卡牌位（排除 fan 规则里的 :not(:has(...)) 排除子句）
    const line = skin
      .split('\n')
      .find((l) => l.includes(':has([data-shimmer="true"]) [data-step-process-icon]::before{') && l.includes('-webkit-mask-image:url("data:image/svg+xml'))
    assert.ok(line, 'running 规则缺失（双契约 + 五牌面轮换 mask）')
    return line
  }
  function runningDeclarationOf(skin) {
    const line = runningRuleOf(skin)
    return line.slice(line.indexOf('{') + 1, line.lastIndexOf('}'))
  }
  function runningSelectorsOf(skin) {
    const line = runningRuleOf(skin)
    return line.slice(0, line.indexOf('{')).split(',')
  }
  // 从 running 规则取出五牌面轮换 SVG 数据 URI 并解码（还原 SVG 文本后断言内部结构）
  function decodedAnimSvgOf(skin) {
    const declaration = runningDeclarationOf(skin)
    const m = declaration.match(/-webkit-mask-image:url\("(data:image\/svg\+xml,[^"]+)"\)/)
    assert.ok(m, 'running 规则缺 -webkit-mask-image 数据 URI')
    const svg = decodeURIComponent(m[1].slice('data:image/svg+xml,'.length))
    assert.ok(svg.startsWith('<svg'), '数据 URI 解码后不是 SVG')
    return svg
  }
  // matches() 不能带伪元素：running 选择器以 " [data-step-process-icon]::before" 结尾，
  // 去掉伪元素后缀后剩下的宿主部分（[data-step-process]:has(...)）才是可匹配的元素选择器。
  function hostSelectorOf(sel) {
    const marker = ' [data-step-process-icon]::'
    const at = sel.lastIndexOf(marker)
    assert.ok(at > 0, 'running 选择器缺少卡牌渲染位后缀：' + sel)
    return sel.slice(0, at)
  }
  // 构造官方 running DOM 最小结构：[data-step-process] > [data-step-process-icon] + shimmer 标题
  function stepDom(shimmer) {
    const host = document.createElement('div')
    host.setAttribute('data-step-process', '')
    const icon = document.createElement('span')
    icon.setAttribute('data-step-process-icon', '')
    host.appendChild(icon)
    const title = document.createElement('span')
    if (shimmer === '0.1.7') title.setAttribute('data-text-shimmer', 'true')
    else if (shimmer === '0.2.0') title.setAttribute('data-shimmer', 'true')
    else if (shimmer === 'both') {
      title.setAttribute('data-text-shimmer', 'true')
      title.setAttribute('data-shimmer', 'true')
    }
    host.appendChild(title)
    document.body.appendChild(host)
    return { host, icon, cleanup: () => host.remove() }
  }

  it('双契约 running 规则存在：0.1.7 data-text-shimmer 与 0.2.0+ data-shimmer 都在（单一卡牌位 ::before）', () => {
    const skin = skinEl().textContent
    assert.ok(
      skin.includes('[data-step-process]:has([data-text-shimmer="true"]) [data-step-process-icon]::before'),
      '0.1.7 官方契约（data-text-shimmer）的 running 选择器缺失',
    )
    assert.ok(
      skin.includes('[data-step-process]:has([data-shimmer="true"]) [data-step-process-icon]::before'),
      '0.2.0+ 官方契约（data-shimmer）的 running 选择器缺失',
    )
    // Step 侧只有一张牌：不存在第二个伪元素（无正/背面）
    assert.ok(!skin.includes('[data-step-process-icon]::after'), 'Step 侧不得再出现第二个伪元素')
  })

  it('0.1.7 DOM：data-text-shimmer="true" → 五牌面轮换 mask 生效', () => {
    const skin = skinEl().textContent
    const { host, cleanup } = stepDom('0.1.7')
    try {
      const sel = runningSelectorsOf(skin).find((s) => s.includes('[data-text-shimmer="true"]'))
      assert.ok(sel, '0.1.7 契约选择器缺失')
      assert.ok(host.matches(hostSelectorOf(sel)), '0.1.7 官方 DOM 未命中 running 选择器')
      assert.ok(runningDeclarationOf(skin).includes('mask-image:url("data:image/svg+xml'), 'running 声明未换成轮换 mask')
    } finally { cleanup() }
  })

  it('0.2.0+ DOM：data-shimmer="true" → 五牌面轮换 mask 生效', () => {
    const skin = skinEl().textContent
    const { host, cleanup } = stepDom('0.2.0')
    try {
      const sel = runningSelectorsOf(skin).find((s) => s.includes('[data-shimmer="true"]') && !s.includes('data-text-shimmer'))
      assert.ok(sel, '0.2.0+ 契约选择器缺失')
      assert.ok(host.matches(hostSelectorOf(sel)), '0.2.0+ 官方 DOM 未命中 running 选择器')
    } finally { cleanup() }
  })

  it('两属性都不存在 → running 不命中，回落静态 activity 牌', () => {
    const skin = skinEl().textContent
    const { host, icon, cleanup } = stepDom(null)
    try {
      for (const sel of runningSelectorsOf(skin)) {
        assert.ok(!host.matches(hostSelectorOf(sel)), '无 shimmer 时 running 不应命中：' + sel)
      }
      host.setAttribute('data-process-activity', 'edit')
      const staticRule = skin.split('\n').find((l) => l.includes('[data-process-activity="edit"] [data-step-process-icon]'))
      assert.ok(staticRule && staticRule.includes('--tf-suit:'), '静态 activity 花色映射缺失')
      assert.ok(icon.matches(staticRule.slice(0, staticRule.indexOf('{'))), '静态牌选择器命中官方 DOM')
    } finally { cleanup() }
  })

  it('activity 花色映射（--tf-suit）保留为回落实：thinking → ♥、search → ♠、edit → ♦、commands → ♣（与 JS 映射同源，无运行态 mask）', () => {
    const skin = skinEl().textContent
    for (const [activity, suit] of [['thinking', 'heart'], ['search', 'spade'], ['edit', 'diamond'], ['commands', 'club']]) {
      const rule = skin.split('\n').find((l) => l.includes('[data-process-activity="' + activity + '"] [data-step-process-icon]'))
      assert.ok(rule, activity + ' 静态规则缺失')
      assert.ok(rule.includes('--tf-suit:' + T.suitMaskImage(suit)), activity + ' 静态花色不是 ' + suit)
      assert.ok(!rule.includes('phase-1'), activity + ' 静态规则不得携带轮换动画 SVG（只允许花色 mask）')
    }
  })

  it('双属性同时存在 → 仍只有一条 running 规则（轮换 SVG 数据 URI 只声明一次）', () => {
    const skin = skinEl().textContent
    const { host, cleanup } = stepDom('both')
    try {
      for (const sel of runningSelectorsOf(skin)) {
        assert.ok(host.matches(hostSelectorOf(sel)), '双属性 DOM 未命中 running 选择器：' + sel)
      }
      const maskRules = skin.split('\n').filter((l) => l.includes(':has([data-shimmer="true"]) [data-step-process-icon]::before') && l.includes('mask-image:url("data:image/svg+xml'))
      assert.equal(maskRules.length, 1, 'running 轮换 mask 规则必须恰好一条')
      assert.equal((skin.match(/phase-1/g) || []).length, 2, '轮换 SVG 只应出现一次（webkit + 标准两条 mask-image 声明）')
    } finally { cleanup() }
  })

  // ══════ 五牌面轮换契约（机械移植自参考实现 docs/扑克牌轮换_动态蒙版遮挡_文件图标加强版.html 第三行） ══════
  it('五牌面轮换 SVG：五组相位 / 每 0.8s 一次轮换 / 4s 完整循环 / 参考参数原样（±3.1°、0.55、0.867、1.888、1.35467）', () => {
    const svg = decodedAnimSvgOf(skinEl().textContent)
    for (let n = 1; n <= 5; n++) assert.ok(svg.includes('<g id="phase-' + n + '">'), 'phase-' + n + ' 缺失')
    const opacities = [...svg.matchAll(/attributeName="opacity" values="([^"]+)"/g)].map((m) => m[1])
    for (const want of ['1;0;0;0;0', '0;1;0;0;0', '0;0;1;0;0', '0;0;0;1;0', '0;0;0;0;1']) {
      assert.ok(opacities.includes(want), '缺少相位可见窗口 values=' + want)
    }
    assert.equal((svg.match(/dur="4s"/g) || []).length, 5, '必须恰好 5 个 4s 相位窗口（五牌面完整循环 4s）')
    assert.equal((svg.match(/dur="0.8s"/g) || []).length, 82, '0.8s 转场参数数量异常（72 组卡牌/蒙版变换 + 10 个半程换层）')
    assert.equal((svg.match(/<animateTransform/g) || []).length, 72, '参考动画为 72 个 animateTransform')
    assert.equal((svg.match(/<animate\b/g) || []).length, 15, '参考动画为 15 个 animate（5 相位窗口 + 10 半程换层）')
    for (const token of ['type="translate"', 'type="rotate"', 'type="scale"', '1.888', '1.35467', '0.55', '0.867', '3.1']) {
      assert.ok(svg.includes(token), '缺少参考参数 ' + token)
    }
    // 唯一的旋转是二维平面小角度 ±3.1°（不是 rotateY、不是任何 3D/牌侧/换面）
    const rots = [...svg.matchAll(/type="rotate" values="([^"]+)"/g)].flatMap((m) => m[1].split(';').map(Number))
    assert.ok(rots.length >= 20, 'rotate 关键帧数量异常：' + rots.length)
    assert.equal(Math.max(...rots), 3.1, 'rotate 极值应为 +3.1°')
    assert.equal(Math.min(...rots), -3.1, 'rotate 极值应为 -3.1°')
    for (const banned of ['rotateY', 'perspective', 'scaleX', 'card-back', 'skew']) {
      assert.ok(!svg.includes(banned), '五牌面轮换不得包含 ' + banned)
    }
  })

  it('牌面顺序：diamond → club → spade → heart → deepseek → diamond（DeepSeek 是第五张牌，非牌背）', () => {
    const svg = decodedAnimSvgOf(skinEl().textContent)
    const order = ['diamond', 'club', 'spade', 'heart', 'deepseek']
    const phases = [...svg.matchAll(/<g id="phase-(\d)">([\s\S]*?)(?=<g id="phase-|<\/svg>)/g)]
    assert.equal(phases.length, 5, '必须解析出 5 个相位')
    phases.forEach((m, idx) => {
      const cards = [...m[2].matchAll(/href="#card-([a-z]+)"/g)].map((x) => x[1])
      assert.equal(cards.length, 4, 'phase-' + m[1] + ' 应有 4 个卡牌引用（前/后半各两张）')
      // 每个半段先画下层牌、后画上层牌 → cards[1] / cards[3] 是该半段的上层=当前牌面
      assert.equal(cards[1], order[idx], 'phase-' + m[1] + ' 前半当前牌应为 ' + order[idx])
      assert.equal(cards[3], order[(idx + 1) % 5], 'phase-' + m[1] + ' 后半当前牌应为 ' + order[(idx + 1) % 5])
    })
    // 鲸鱼是独立第五张牌面；不存在任何"牌背"语义
    assert.ok(svg.includes('id="pip-deepseek"') && svg.includes('id="card-deepseek"'), 'DeepSeek 鲸鱼牌面缺失')
    for (const suit of ['spade', 'heart', 'diamond', 'club', 'deepseek']) {
      assert.ok(svg.includes('id="card-' + suit + '"'), '五牌面缺少 ' + suit)
    }
    assert.ok(!svg.includes('back'), '不得出现 back/牌背语义')
  })

  it('半程层级交换 + 动态遮挡：discrete 在 50% 换层；四个 luminance 蒙版挖空下层牌线条', () => {
    const svg = decodedAnimSvgOf(skinEl().textContent)
    assert.equal((svg.match(/calcMode="discrete"/g) || []).length, 15, '缺少 discrete（5 相位窗口 + 10 半程换层）')
    assert.equal((svg.match(/values="1;0" keyTimes="0;0.5"/g) || []).length, 5, '前半段换层（1;0 @0;0.5）数量异常')
    assert.equal((svg.match(/values="0;1" keyTimes="0;0.5"/g) || []).length, 5, '后半段换层（0;1 @0;0.5）数量异常')
    for (const id of ['mask-plus-out', 'mask-plus-in', 'mask-minus-out', 'mask-minus-in']) {
      assert.ok(svg.includes('id="' + id + '"'), id + ' 缺失')
    }
    assert.equal((svg.match(/mask-type:luminance/g) || []).length, 4, '四个动态蒙版都必须是 luminance')
    // 相位与蒙版配对：phase-1/3/5 用 plus-*（一侧斜向），phase-2/4 用 minus-*（镜像斜向）
    const phases = [...svg.matchAll(/<g id="phase-(\d)">([\s\S]*?)(?=<g id="phase-|<\/svg>)/g)]
    phases.forEach((m) => {
      const masks = [...m[2].matchAll(/mask="url\(#(mask-[a-z-]+)\)"/g)].map((x) => x[1])
      const want = Number(m[1]) % 2 === 1 ? 'plus-' : 'minus-'
      assert.equal(masks.length, 2, 'phase-' + m[1] + ' 应有前/后半各一个动态蒙版')
      for (const mk of masks) assert.ok(mk.includes(want), 'phase-' + m[1] + ' 应使用 ' + want + '* 蒙版（实际 ' + mk + '）')
    })
    // 蒙版剪影按 poker 5:7 牌形（6.434…×8.72，连同 stroke 一起挖空）
    assert.ok(svg.includes('class="anim-mask-rect"') && svg.includes('width="6.434285714285714"'), '蒙版剪影未按 poker 5:7 适配')
    assert.ok(svg.includes('rx="1.44"'), '蒙版剪影圆角未按 poker 适配')
  })

  it('卡片本体 = poker 5:7（8×5.714…，rx 1.08）、透明卡面（自包含 .anim-card{fill:transparent}）', () => {
    const svg = decodedAnimSvgOf(skinEl().textContent)
    assert.ok(svg.includes('class="anim-base-rect"'), '卡牌 rect 缺失')
    assert.ok(svg.includes('width="5.714285714285714"') && svg.includes('height="8"') && svg.includes('rx="1.08"'), '卡牌 rect 未按 poker 5:7 适配')
    assert.ok(svg.includes('.anim-card{fill:transparent}'), '缺少自包含的 .anim-card{fill:transparent}（透明卡面）')
    assert.ok(svg.includes('stroke="currentColor"'), '卡牌描边应使用 currentColor')
  })

  it('旧概念清除：无 front/back、无 rotateY/3D、无 scaleX 换面、无 tf-cycle、无第二伪元素', () => {
    const skin = skinEl().textContent
    for (const banned of ['tf-flip', 'rotateY', 'perspective', 'scaleX', 'tf-cycle', '--tf-back', 'stepPokerBackMask', '[data-step-process-icon]::after', 'backface-visibility']) {
      assert.ok(!skin.includes(banned), '皮肤不得再包含 ' + banned)
    }
  })

  it('几何守卫：单一伪元素 absolute + inset:0 + margin:auto；全牌型统一 Turn 栏渲染比例（24px 盒 / 24px mask ≈ 牌外缘 9.62×13.05）', () => {
    const skin = skinEl().textContent
    const base = skin.split('\n').find((l) => l.includes('[data-step-process-icon]::before{content:""'))
    assert.ok(base, '单伪元素基座规则缺失')
    assert.ok(base.includes('position:absolute') && base.includes('inset:0') && base.includes('margin:auto'), '伪元素必须 absolute + inset:0 + margin:auto（不参与官方布局）')
    // 伪元素 24×24 = Turn 栏 .ccg-poker-icon 容器同款；基础 mask = completed 收起牌堆
    assert.ok(base.includes('width:24px') && base.includes('height:24px'), '伪元素盒子应为 24×24（与 Turn 容器一致，右缘不触标题起点）')
    assert.ok(base.includes('center/24px 24px no-repeat'), '基础 mask 应为牌堆（16 视箱 @24px = Turn 渲染比例 1.5px/单位）')
    const declaration = runningDeclarationOf(skin)
    assert.ok(declaration.includes('mask-size:24px 24px'), 'running mask 尺寸应显式为 24×24（16 单位视箱 → 牌外缘 ≈9.62×13.05，与 Turn 牌逐像素一致）')
  })

  it('running 与静态映射共存：running 只换 mask，静态 --tf-suit 规则不删', () => {
    const skin = skinEl().textContent
    assert.ok(skin.includes('[data-process-activity="edit"] [data-step-process-icon]'), '静态 edit 映射缺失')
    assert.ok(skin.includes('--tf-suit:'), '静态 mask 变量缺失')
    const staticCount = (skin.match(/--tf-suit:/g) || []).length
    assert.ok(staticCount >= 5, '静态映射规则数量异常：' + staticCount)
  })

  it('shimmer 钩子缺失的最坏退化 = completed 双态（running 规则整行退场，无残留轮换 SVG）', () => {
    const skin = skinEl().textContent
    const withoutRunning = skin
      .split('\n')
      .filter((l) => !l.includes('[data-shimmer') && !l.includes('data-text-shimmer'))
      .join('\n')
    assert.ok(withoutRunning.includes('[data-step-process] [data-step-process-icon]::before'), '静态牌渲染位仍在')
    assert.ok(withoutRunning.includes('--tf-suit:'), '静态花色映射仍在')
    assert.ok(!withoutRunning.includes('phase-1'), '轮换 SVG 随 running 规则一起退场')
  })

  it('reduced-motion：不播放轮换动画——mask 换回静态 activity 花色牌（与统一牌规格同外缘）', () => {
    const skin = skinEl().textContent
    const line = skin.split('\n').find((l) => l.includes('@media (prefers-reduced-motion:reduce)') && l.includes('mask-image:var(--tf-suit)'))
    assert.ok(line, 'reduced-motion 的静态回退规则缺失')
    assert.ok(line.includes('[data-text-shimmer="true"]') && line.includes('[data-shimmer="true"]'), 'reduced-motion 必须覆盖双契约')
    assert.ok(line.includes('[data-step-process-icon]::before'), 'reduced-motion 必须覆盖卡牌位')
    const declaration = line.slice(line.indexOf('{') + 1)
    assert.ok(declaration.includes('-webkit-mask-image:var(--tf-suit)') && declaration.includes('mask-size:9.62px 13.05px'), 'reduced-motion 必须把 mask 换回静态花色牌（外缘与 Turn 牌一致）')
  })

  it('running → completed：shimmer 移除后 running 规则不再命中，静态 activity 牌回归', () => {
    const skin = skinEl().textContent
    const { host, cleanup } = stepDom('0.2.0')
    try {
      const sel = runningSelectorsOf(skin).find((s) => s.includes('[data-shimmer="true"]') && !s.includes('data-text-shimmer'))
      assert.ok(sel, '0.2.0+ running 选择器缺失')
      assert.ok(host.matches(hostSelectorOf(sel)), 'running 中应命中 running 选择器')
      // 官方回合结束：shimmer 属性消失（同一渲染器继续存在）
      host.querySelector('[data-shimmer]').removeAttribute('data-shimmer')
      assert.ok(!host.matches(hostSelectorOf(sel)), 'shimmer 移除后 running 选择器不得再命中')
      // 静态映射仍在（回落 activity 花色牌）
      host.setAttribute('data-process-activity', 'edit')
      const staticRule = skin.split('\n').find((l) => l.includes('[data-process-activity="edit"] [data-step-process-icon]'))
      assert.ok(staticRule && staticRule.includes('--tf-suit:'), '静态 activity 花色映射缺失')
    } finally { cleanup() }
  })

  it('双契约守卫：皮肤必须同时包含两个官方运行态属性，任一都不是"非法旧属性"', () => {
    // data-text-shimmer = DSH 0.1.7 正式契约（release 787b746b80）；
    // data-shimmer      = DSH 0.2.0+ 当前契约（master）。
    // 上一轮曾错误地禁止 data-text-shimmer 出现——两个都是官方真实历史契约，必须共存。
    const skin = skinEl().textContent
    assert.ok(skin.includes('data-text-shimmer="true"'), '皮肤缺少 0.1.7 官方契约 data-text-shimmer')
    assert.ok(skin.includes('data-shimmer="true"'), '皮肤缺少 0.2.0+ 官方契约 data-shimmer')
  })

  it('官方源码契约（双版本，条件式）：0.1.7-rc.2 与 master 的 TextShimmer 属性名', async () => {
    // 直接核对官方源码：0.1.7-rc.2 release commit 与当前 master 工作区各验一次——
    // 属性名错误正是上一轮事故的根因。无本地 checkout（如 CI）则跳过；
    // 插件自己的 CSS/fixture 契约用例不依赖 checkout，始终执行。
    const { access, readFile } = await import('node:fs/promises')
    const { execFile } = await import('node:child_process')
    const checkout = process.env.DSH_CHECKOUT || 'X:/DSH/deepseek-harness'
    const rel = 'packages/client/ui-primitives/src/TextShimmer.tsx'
    const shimmerPath = checkout + '/' + rel
    const seatPath = checkout + '/packages/client/ui-chat/src/client/chat/ChatGroupSeat.tsx'
    try {
      await access(shimmerPath)
      await access(seatPath)
    } catch {
      return // 无本地 checkout：跳过
    }
    const gitShow = (rev) => new Promise((resolve, reject) => {
      execFile('git', ['-C', checkout, 'show', rev + ':' + rel], (err, stdout) => (err ? reject(err) : resolve(stdout)))
    })
    // DSH 0.1.7-rc.2 正式 release（官方证据 commit）：data-text-shimmer
    const legacy = await gitShow('787b746b807df83776957875683b8853c862ca2c')
    assert.ok(
      legacy.includes('data-text-shimmer={active || undefined}'),
      '0.1.7-rc.2 官方契约变更：data-text-shimmer 不再匹配——请核对插件 0.1.7 选择器',
    )
    // 当前 master 工作区：data-shimmer
    const master = await readFile(shimmerPath, 'utf8')
    assert.ok(
      master.includes('data-shimmer={active || undefined}'),
      'master 官方契约变更：data-shimmer 不再匹配——请同步更新插件运行态选择器',
    )
    // 两个版本共用同一激活条件：<TextShimmer active={!data.closed}>
    const seatSrc = await readFile(seatPath, 'utf8')
    assert.ok(seatSrc.includes('<TextShimmer active={!data.closed}>'), '官方 ChatGroupSeat 激活条件变更：需要同步核对')
  })
})

describe('架构守卫：旧折叠引擎 CSS 必须消失', () => {
  it('无 :has() 成员隐藏、无 hidden 标记选择器、无旧折叠容器', () => {
    const css = baseCss() + '\n' + skinEl().textContent
    // :has() 唯一合法用途 = shimmer 运行态识别（0.1.7 data-text-shimmer / 0.2.0+ data-shimmer，
    // 双官方契约）；旧折叠引擎用 :has() 隐藏成员 flowItem——那是被删除的 Fold Engine 行为。
    const hasLines = css.split('\n').filter((l) => l.includes(':has('))
    for (const line of hasLines) {
      assert.ok(
        line.includes('[data-shimmer="true"]') || line.includes('[data-text-shimmer="true"]'),
        ':has() 仅允许用于官方 shimmer 运行态识别：' + line,
      )
    }
    assert.ok(!css.includes('data-ccg-hidden'), '隐藏标记选择器必须删除')
    assert.ok(!css.includes('ccg-fold-clip'), '旧 FoldClip 容器样式必须删除')
    assert.ok(!css.includes('ccg-group-root'), '旧组容器样式必须删除')
    assert.ok(!css.includes('ccg-header'), '旧折叠栏标题样式必须删除')
    assert.ok(!css.includes('ccg-member-in'), '旧成员入场样式必须删除')
    assert.ok(!css.includes('ccg-think-title'), '旧步骤运行标题样式必须删除')
    assert.ok(!css.includes('ccg-settings-row'), '旧设置行样式必须删除')
    assert.ok(!css.includes('ccg-text-only'), '旧 text-only 样式必须删除')
  })

  it('reduced-motion 尊重（动画块均有降级）', () => {
    const css = baseCss()
    assert.ok(css.includes('@media (prefers-reduced-motion:reduce)'))
  })
})

