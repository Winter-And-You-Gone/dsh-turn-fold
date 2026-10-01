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
  function runningRuleOf(skin) {
    const line = skin.split('\n').find((l) => l.includes('{animation:tf-flip'))
    assert.ok(line, 'running 动画规则缺失')
    return line
  }
  function runningDeclarationOf(skin) {
    const line = runningRuleOf(skin)
    return line.slice(line.indexOf('{') + 1, line.lastIndexOf('}'))
  }
  function runningSelectorsOf(skin) {
    return runningRuleOf(skin).slice(0, runningRuleOf(skin).indexOf('{')).split(',')
  }
  // matches() 不能带伪元素：running 选择器以 " [data-step-process-icon]::before" 结尾，
  // 去掉伪元素后剩下的宿主部分（[data-step-process]:has(...)）才是可匹配的元素选择器。
  function hostSelectorOf(sel) {
    const marker = ' [data-step-process-icon]::before'
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

  it('双契约 running 规则存在：0.1.7 data-text-shimmer 与 0.2.0+ data-shimmer 都在', () => {
    const skin = skinEl().textContent
    assert.ok(
      skin.includes('[data-step-process]:has([data-text-shimmer="true"]) [data-step-process-icon]::before'),
      '0.1.7 官方契约（data-text-shimmer）的 running 选择器缺失',
    )
    assert.ok(
      skin.includes('[data-step-process]:has([data-shimmer="true"]) [data-step-process-icon]::before'),
      '0.2.0+ 官方契约（data-shimmer）的 running 选择器缺失',
    )
  })

  it('0.1.7 DOM：data-text-shimmer="true" → running 命中，animationName 含 tf-flip + tf-cycle', () => {
    const skin = skinEl().textContent
    const { host, cleanup } = stepDom('0.1.7')
    try {
      const sel = runningSelectorsOf(skin).find((s) => s.includes('[data-text-shimmer="true"]'))
      assert.ok(sel, '0.1.7 契约选择器缺失')
      assert.ok(host.matches(hostSelectorOf(sel)), '0.1.7 官方 DOM 未命中 running 选择器')
      const decl = runningDeclarationOf(skin)
      assert.ok(decl.includes('tf-flip'), '动画声明缺 tf-flip')
      assert.ok(decl.includes('tf-cycle'), '动画声明缺 tf-cycle')
    } finally { cleanup() }
  })

  it('0.2.0+ DOM：data-shimmer="true" → running 命中，同一动画声明', () => {
    const skin = skinEl().textContent
    const { host, cleanup } = stepDom('0.2.0')
    try {
      const sel = runningSelectorsOf(skin).find((s) => s.includes('[data-shimmer="true"]') && !s.includes('data-text-shimmer'))
      assert.ok(sel, '0.2.0+ 契约选择器缺失')
      assert.ok(host.matches(hostSelectorOf(sel)), '0.2.0+ 官方 DOM 未命中 running 选择器')
      const decl = runningDeclarationOf(skin)
      assert.ok(decl.includes('tf-flip') && decl.includes('tf-cycle'))
    } finally { cleanup() }
  })

  it('两属性都不存在 → running 不命中，回落静态 activity 牌', () => {
    const skin = skinEl().textContent
    const { host, icon, cleanup } = stepDom(null)
    try {
      // 无 shimmer：双契约选择器逐个都不命中（nwsapi 列表匹配限制，见 runningSelectorsOf 注释）
      for (const sel of runningSelectorsOf(skin)) {
        assert.ok(!host.matches(hostSelectorOf(sel)), '无 shimmer 时 running 不应命中：' + sel)
      }
      // 静态牌：host 标记 activity → icon 命中静态映射（mask = var(--tf-suit)）
      host.setAttribute('data-process-activity', 'edit')
      const staticRule = skin.split('\n').find((l) => l.includes('[data-process-activity="edit"] [data-step-process-icon]'))
      assert.ok(staticRule && staticRule.includes('--tf-suit:'), '静态 activity 花色映射缺失')
      assert.ok(icon.matches(staticRule.slice(0, staticRule.indexOf('{'))), '静态牌选择器命中官方 DOM')
    } finally { cleanup() }
  })

  it('completed 静态花色：thinking → ♥、edit → ♦、commands → ♣（与 JS 映射同源，无动画）', () => {
    const skin = skinEl().textContent
    for (const [activity, suit] of [['thinking', 'heart'], ['edit', 'diamond'], ['commands', 'club']]) {
      const rule = skin.split('\n').find((l) => l.includes('[data-process-activity="' + activity + '"] [data-step-process-icon]'))
      assert.ok(rule, activity + ' 静态规则缺失')
      assert.ok(rule.includes('--tf-suit:' + T.suitMaskImage(suit)), activity + ' 静态花色不是 ' + suit)
      assert.ok(!rule.includes('animation:tf-flip'), activity + ' 静态规则不得携带 running 动画')
    }
  })

  it('双属性同时存在 → 正常命中，且只应用一次动画声明（不产生两套视觉）', () => {
    const skin = skinEl().textContent
    const { host, cleanup } = stepDom('both')
    try {
      // 两个契约选择器对同一 DOM 各自命中（nwsapi 列表匹配限制，逐个断言）
      for (const sel of runningSelectorsOf(skin)) {
        assert.ok(host.matches(hostSelectorOf(sel)), '双属性 DOM 未命中选择器：' + sel)
      }
      // 两个选择器挂同一规则（选择器列表 + 单个 animation 声明）→ 浏览器只应用一次
      assert.equal((skin.match(/animation:tf-flip/g) || []).length, 1, 'running 动画声明必须恰好一次')
    } finally { cleanup() }
  })

  it('动画 = 翻牌（scaleX）+ 花色轮换（mask discrete）双 keyframes', () => {
    const skin = skinEl().textContent
    assert.ok(skin.includes('@keyframes tf-flip{0%{transform:scaleX(1)}50%{transform:scaleX(0)}100%{transform:scaleX(1)}}'), '翻牌 keyframes 缺失')
    // 花色轮换：spade → heart → diamond → club → whale → spade（0/20/40/60/80/100%）
    const cycle = skin.slice(skin.indexOf('@keyframes tf-cycle{'))
    assert.ok(cycle.includes(T.suitMaskImage('spade')), 'cycle 含 spade')
    assert.ok(cycle.includes(T.suitMaskImage('heart')), 'cycle 含 heart')
    assert.ok(cycle.includes(T.suitMaskImage('diamond')), 'cycle 含 diamond')
    assert.ok(cycle.includes(T.suitMaskImage('club')), 'cycle 含 club')
    assert.ok(cycle.includes(T.suitMaskImage('whale')), 'cycle 含 whale')
  })

  it('discrete 跳变点与牌侧面（scaleX=0）对齐：mask 帧间中点 = 10%/30%/50%/70%/90%', () => {
    // 0.8s flip 循环的 scaleX(0) 时刻 = 0.4/1.2/2.0/2.8/3.6s；4s cycle 的 discrete
    // 中点跳变 = 0.4/1.2/2.0/2.8/3.6s（帧 0/20/40/60/80/100%）——同一时刻，
    // 牌在侧面瞬间换花色、展开即新牌（翻牌观感而非 opacity 闪烁）。
    const skin = skinEl().textContent
    const cycleStart = skin.indexOf('@keyframes tf-cycle{')
    const cycle = skin.slice(cycleStart, skin.indexOf('}/**/', cycleStart) > 0 ? skin.indexOf('}/**/', cycleStart) + 1 : skin.length)
    for (const pct of ['0%', '20%', '40%', '60%', '80%', '100%']) {
      assert.ok(cycle.includes(pct), 'cycle 缺帧 ' + pct)
    }
  })

  it('running 与静态映射共存：动画 keyframes 覆盖静态 mask，静态 --tf-suit 规则不删', () => {
    const skin = skinEl().textContent
    // 静态映射（completed 用）保持原样
    assert.ok(skin.includes('[data-process-activity="edit"] [data-step-process-icon]'), '静态 edit 映射缺失')
    assert.ok(skin.includes('--tf-suit:'), '静态 mask 变量缺失')
    const staticCount = (skin.match(/--tf-suit:/g) || []).length
    assert.ok(staticCount >= 5, '静态映射规则数量异常：' + staticCount)
  })

  it('reduced-motion：running 动画禁用（双契约选择器都在）→ 回落静态 activity 牌', () => {
    const skin = skinEl().textContent
    const line = skin.split('\n').find((l) => l.includes('@media (prefers-reduced-motion:reduce)') && l.includes('animation:none'))
    assert.ok(line, 'reduced-motion 关闭 running 动画的规则缺失')
    assert.ok(line.includes('[data-text-shimmer="true"]'), 'reduced-motion 缺 0.1.7 契约选择器')
    assert.ok(line.includes('[data-shimmer="true"]'), 'reduced-motion 缺 0.2.0+ 契约选择器')
  })

  it('shimmer 钩子缺失的最坏退化 = 静态牌（CSS 结构守卫，双契约属性一并退场）', () => {
    const skin = skinEl().textContent
    // running 规则只追加 animation、不改静态声明——移除任一 shimmer 钩子规则后静态皮完整
    const withoutRunning = skin
      .split('\n')
      .filter((l) => !l.includes('[data-shimmer') && !l.includes('[data-text-shimmer'))
      .join('\n')
    assert.ok(withoutRunning.includes('[data-step-process] [data-step-process-icon]::before{'), '静态牌渲染位仍在')
    assert.ok(withoutRunning.includes('--tf-suit:'), '静态花色映射仍在')
    // 动画"应用"随钩子退场（@keyframes 定义留存为无引用的死代码，不产生任何动画）
    assert.ok(!withoutRunning.includes('animation:tf-flip'), '动画应用规则随钩子一起退场')
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

