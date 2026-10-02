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

describe('Step Poker Running Animation（官方 shimmer 双契约）', () => {
  // 从皮肤 CSS 里提取真实的 running 选择器与动画声明（单一事实来源，测试不复制选择器）。
  // 注意：nwsapi（jsdom 选择器引擎）对含 :has() 的选择器列表 matches() 会整体返回 false
  //（单项明明命中）——真实浏览器按列表语义正确应用；因此 fixture 断言按单个选择器逐个做。
  function runningRuleOf(skin, face) {
    const line = skin.split('\n').find((l) => l.includes('{animation:tf-flip-' + face))
    assert.ok(line, face + ' running 动画规则缺失')
    return line
  }
  function runningDeclarationOf(skin, face) {
    const line = runningRuleOf(skin, face)
    return line.slice(line.indexOf('{') + 1, line.lastIndexOf('}'))
  }
  function runningSelectorsOf(skin, face) {
    const line = runningRuleOf(skin, face)
    return line.slice(0, line.indexOf('{')).split(',')
  }
  // matches() 不能带伪元素：running 选择器以 " [data-step-process-icon]::before|::after" 结尾，
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

  it('双契约 running 规则存在：0.1.7 data-text-shimmer 与 0.2.0+ data-shimmer 都在（front/back 两面）', () => {
    const skin = skinEl().textContent
    for (const face of ['before', 'after']) {
      assert.ok(
        skin.includes('[data-step-process]:has([data-text-shimmer="true"]) [data-step-process-icon]::' + face),
        '0.1.7 官方契约（data-text-shimmer）的 ' + face + ' running 选择器缺失',
      )
      assert.ok(
        skin.includes('[data-step-process]:has([data-shimmer="true"]) [data-step-process-icon]::' + face),
        '0.2.0+ 官方契约（data-shimmer）的 ' + face + ' running 选择器缺失',
      )
    }
  })

  it('0.1.7 DOM：data-text-shimmer="true" → front/back 翻牌生效（rotateY 3D 翻转）', () => {
    const skin = skinEl().textContent
    const { host, cleanup } = stepDom('0.1.7')
    try {
      const frontSel = runningSelectorsOf(skin, 'front').find((s) => s.includes('[data-text-shimmer="true"]'))
      const backSel = runningSelectorsOf(skin, 'back').find((s) => s.includes('[data-text-shimmer="true"]'))
      assert.ok(frontSel && backSel, '0.1.7 契约选择器缺失')
      assert.ok(host.matches(hostSelectorOf(frontSel)), '0.1.7 官方 DOM 未命中 front 选择器')
      assert.ok(host.matches(hostSelectorOf(backSel)), '0.1.7 官方 DOM 未命中 back 选择器')
      assert.ok(runningDeclarationOf(skin, 'front').includes('tf-flip-front'), 'front 动画缺 tf-flip-front')
      assert.ok(runningDeclarationOf(skin, 'back').includes('tf-flip-back'), 'back 动画缺 tf-flip-back')
    } finally { cleanup() }
  })

  it('0.2.0+ DOM：data-shimmer="true" → front/back 翻牌生效', () => {
    const skin = skinEl().textContent
    const { host, cleanup } = stepDom('0.2.0')
    try {
      const frontSel = runningSelectorsOf(skin, 'front').find((s) => s.includes('[data-shimmer="true"]') && !s.includes('data-text-shimmer'))
      const backSel = runningSelectorsOf(skin, 'back').find((s) => s.includes('[data-shimmer="true"]') && !s.includes('data-text-shimmer'))
      assert.ok(frontSel && backSel, '0.2.0+ 契约选择器缺失')
      assert.ok(host.matches(hostSelectorOf(frontSel)), '0.2.0+ 官方 DOM 未命中 front 选择器')
      assert.ok(host.matches(hostSelectorOf(backSel)), '0.2.0+ 官方 DOM 未命中 back 选择器')
      assert.ok(runningDeclarationOf(skin, 'front').includes('tf-flip-front') && runningDeclarationOf(skin, 'back').includes('tf-flip-back'))
    } finally { cleanup() }
  })

  it('两属性都不存在 → front/back 都不命中，回落静态 activity 牌', () => {
    const skin = skinEl().textContent
    const { host, icon, cleanup } = stepDom(null)
    try {
      // 无 shimmer：双契约 × 双面的选择器逐个都不命中（nwsapi 列表匹配限制，见 runningSelectorsOf 注释）
      for (const face of ['front', 'back']) {
        for (const sel of runningSelectorsOf(skin, face)) {
          assert.ok(!host.matches(hostSelectorOf(sel)), '无 shimmer 时 ' + face + ' 不应命中：' + sel)
        }
      }
      // 静态牌：host 标记 activity → icon 命中静态映射（mask = var(--tf-suit)）
      host.setAttribute('data-process-activity', 'edit')
      const staticRule = skin.split('\n').find((l) => l.includes('[data-process-activity="edit"] [data-step-process-icon]'))
      assert.ok(staticRule && staticRule.includes('--tf-suit:'), '静态 activity 花色映射缺失')
      assert.ok(icon.matches(staticRule.slice(0, staticRule.indexOf('{'))), '静态牌选择器命中官方 DOM')
    } finally { cleanup() }
  })

  it('completed 静态花色：thinking → ♥、search → ♠、edit → ♦、commands → ♣（与 JS 映射同源，无动画）', () => {
    const skin = skinEl().textContent
    for (const [activity, suit] of [['thinking', 'heart'], ['search', 'spade'], ['edit', 'diamond'], ['commands', 'club']]) {
      const rule = skin.split('\n').find((l) => l.includes('[data-process-activity="' + activity + '"] [data-step-process-icon]'))
      assert.ok(rule, activity + ' 静态规则缺失')
      assert.ok(rule.includes('--tf-suit:' + T.suitMaskImage(suit)), activity + ' 静态花色不是 ' + suit)
      assert.ok(!rule.includes('animation:tf-flip'), activity + ' 静态规则不得携带 running 动画')
    }
  })

  it('双属性同时存在 → 仍只是一套 front/back 动画（front 恰一条、back 恰一条）', () => {
    const skin = skinEl().textContent
    const { host, cleanup } = stepDom('both')
    try {
      // 两个契约选择器对同一 DOM 在各面上各自命中（nwsapi 列表匹配限制，逐个断言）
      for (const face of ['front', 'back']) {
        for (const sel of runningSelectorsOf(skin, face)) {
          assert.ok(host.matches(hostSelectorOf(sel)), '双属性 DOM 未命中 ' + face + ' 选择器：' + sel)
        }
      }
      // 每面 = 一条选择器列表规则 + 单个 animation 声明 → 浏览器每个伪元素只应用一次
      assert.equal((skin.match(/animation:tf-flip-front/g) || []).length, 1, 'front 动画声明必须恰好一次')
      assert.equal((skin.match(/animation:tf-flip-back/g) || []).length, 1, 'back 动画声明必须恰好一次')
    } finally { cleanup() }
  })

  it('动画 = 单张牌 front/back 3D 翻转：keyframes 全部为 rotateY，无 scaleX、无 mask 变化', () => {
    const skin = skinEl().textContent
    const front = skin.slice(skin.indexOf('@keyframes tf-flip-front{'), skin.indexOf('@keyframes tf-flip-back{'))
    assert.ok(front.includes('rotateY(0deg)'), 'front 缺 0° 帧')
    assert.ok(front.includes('rotateY(180deg)'), 'front 缺 180° 帧')
    assert.ok(front.includes('rotateY(360deg)'), 'front 缺 360° 帧')
    assert.ok(!front.includes('scaleX'), 'front 不得用 scaleX 压缩替代真翻转')
    assert.ok(!front.includes('mask'), 'front 不得在动画中改 mask（运行中不换花色）')
    const back = skin.slice(skin.indexOf('@keyframes tf-flip-back{'))
    assert.ok(back.includes('rotateY(180deg)') && back.includes('rotateY(360deg)') && back.includes('rotateY(540deg)'), 'back 缺 180° 偏移相位')
    assert.ok(!back.includes('mask'), 'back 不得在动画中改 mask')
  })

  it('背面 = 统一 DeepSeek 牌背（镜像绘制，与旧版回合运行卡背同款），正面 = 当前 activity 花色', () => {
    const skin = skinEl().textContent
    const backMask = T.stepPokerBackMask()
    assert.ok(backMask && backMask.length > 100, '牌背 mask 未生成')
    assert.ok(skin.includes('--tf-back:' + backMask), '皮肤未使用 stepPokerBackMask 作为 --tf-back')
    assert.ok(
      skin.includes('[data-step-process] [data-step-process-icon]::before{-webkit-mask:var(--tf-suit) center/contain no-repeat;mask:var(--tf-suit) center/contain no-repeat}'),
      'front 必须使用静态 --tf-suit（当前 activity 花色）',
    )
    assert.ok(
      skin.includes('[data-step-process] [data-step-process-icon]::after{-webkit-mask:var(--tf-back) center/contain no-repeat;mask:var(--tf-back) center/contain no-repeat;transform:rotateY(180deg)}'),
      'back 必须使用 --tf-back（统一牌背）且基态背对',
    )
    // 牌背与任何花色正面都不同色块（镜像 whale ≠ 未镜像 whale / 四花色）
    for (const suit of ['spade', 'heart', 'diamond', 'club', 'whale']) {
      assert.notEqual(backMask, T.suitMaskImage(suit), '牌背不得与 ' + suit + ' 正面相同')
    }
  })

  it('几何守卫：两面 absolute 同 inset 同尺寸同 backface，icon 布局不变', () => {
    const skin = skinEl().textContent
    const base = skin.split('\n').find((l) => l.includes('[data-step-process-icon]::before,[data-step-process] [data-step-process-icon]::after{content:""'))
    assert.ok(base, '双面基座规则缺失')
    assert.ok(base.includes('position:absolute') && base.includes('inset:0') && base.includes('margin:auto'), '两面必须 absolute + inset:0 + margin:auto')
    assert.ok(base.includes('width:14px') && base.includes('height:20px'), '两面必须同尺寸 14×20')
    assert.ok(base.includes('backface-visibility:hidden'), '两面必须 backface-visibility:hidden')
    assert.ok(skin.includes('perspective:160px'), '3D 翻转需要透视（挂在 icon span 上）')
  })

  it('running 与静态映射共存：动画 keyframes 覆盖静态 mask，静态 --tf-suit 规则不删', () => {
    const skin = skinEl().textContent
    // 静态映射（completed 用）保持原样
    assert.ok(skin.includes('[data-process-activity="edit"] [data-step-process-icon]'), '静态 edit 映射缺失')
    assert.ok(skin.includes('--tf-suit:'), '静态 mask 变量缺失')
    const staticCount = (skin.match(/--tf-suit:/g) || []).length
    assert.ok(staticCount >= 5, '静态映射规则数量异常：' + staticCount)
  })

  it('shimmer 钩子缺失的最坏退化 = 静态牌（CSS 结构守卫，双契约属性一并退场）', () => {
    const skin = skinEl().textContent
    // running 规则只追加 animation、不改静态声明——移除任一 shimmer 钩子规则后静态皮完整
    const withoutRunning = skin
      .split('\n')
      .filter((l) => !l.includes('[data-shimmer') && !l.includes('[data-text-shimmer'))
      .join('\n')
    assert.ok(withoutRunning.includes('[data-step-process] [data-step-process-icon]::before'), '静态牌渲染位仍在')
    assert.ok(withoutRunning.includes('[data-step-process] [data-step-process-icon]::after'), '背面渲染位仍在（基态背对不可见）')
    assert.ok(withoutRunning.includes('--tf-suit:'), '静态花色映射仍在')
    // 动画"应用"随钩子退场（@keyframes 定义留存为无引用的死代码，不产生任何动画）
    assert.ok(!withoutRunning.includes('animation:tf-flip'), '动画应用规则随钩子一起退场')
  })

  it('reduced-motion：front/back 动画都禁用 → 正面静态 activity 牌、背面基态隐藏', () => {
    const skin = skinEl().textContent
    const line = skin.split('\n').find((l) => l.includes('@media (prefers-reduced-motion:reduce)') && l.includes('animation:none'))
    assert.ok(line, 'reduced-motion 关闭 running 动画的规则缺失')
    assert.ok(line.includes('[data-text-shimmer="true"]'), 'reduced-motion 缺 0.1.7 契约选择器')
    assert.ok(line.includes('[data-shimmer="true"]'), 'reduced-motion 缺 0.2.0+ 契约选择器')
    assert.ok(line.includes('[data-step-process-icon]::before'), 'reduced-motion 必须覆盖正面')
    assert.ok(line.includes('[data-step-process-icon]::after'), 'reduced-motion 必须覆盖背面')
    assert.ok(line.includes('animation:none'), 'reduced-motion 下两面 animation 必须为 none（不 rotateY、不闪烁）')
  })

  it('running → completed：shimmer 移除后 running 规则不再命中，静态 activity 牌回归', () => {
    const skin = skinEl().textContent
    const { host, cleanup } = stepDom('0.2.0')
    try {
      const sel = runningSelectorsOf(skin, 'front').find((s) => s.includes('[data-shimmer="true"]') && !s.includes('data-text-shimmer'))
      assert.ok(sel, '0.2.0+ front 选择器缺失')
      assert.ok(host.matches(hostSelectorOf(sel)), 'running 中应命中 running 选择器')
      // 官方回合结束：shimmer 属性消失（同一渲染器继续存在）
      host.querySelector('[data-shimmer]').removeAttribute('data-shimmer')
      assert.ok(!host.matches(hostSelectorOf(sel)), 'shimmer 移除后 running 选择器不得再命中')
      // 静态映射仍在（正面回落 activity 花色；背面基态背对不可见）
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

