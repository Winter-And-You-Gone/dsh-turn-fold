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

describe('Step Poker Running Animation（官方 data-text-shimmer 识别）', () => {
  it('running 识别规则存在且挂在官方 data-text-shimmer 上（软依赖）', () => {
    const skin = skinEl().textContent
    assert.ok(
      skin.includes('[data-step-process]:has([data-text-shimmer="true"]) [data-step-process-icon]::before{animation:'),
      'running 动画规则缺失',
    )
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

  it('reduced-motion：running 动画禁用 → 回落静态 activity 牌', () => {
    const skin = skinEl().textContent
    assert.ok(
      skin.includes('@media (prefers-reduced-motion:reduce){[data-step-process]:has([data-text-shimmer="true"]) [data-step-process-icon]::before{animation:none}}'),
      'reduced-motion 关闭 running 动画的规则缺失',
    )
  })

  it('data-shimmer 钩子缺失的最坏退化 = 静态牌（CSS 结构守卫）', () => {
    const skin = skinEl().textContent
    // running 规则只追加 animation、不改静态声明——移除 :has() 规则后静态皮完整
    const withoutRunning = skin
      .split('\n')
      .filter((l) => !l.includes('[data-text-shimmer'))
      .join('\n')
    assert.ok(withoutRunning.includes('[data-step-process] [data-step-process-icon]::before{'), '静态牌渲染位仍在')
    assert.ok(withoutRunning.includes('--tf-suit:'), '静态花色映射仍在')
    // 动画"应用"随钩子退场（@keyframes 定义留存为无引用的死代码，不产生任何动画）
    assert.ok(!withoutRunning.includes('animation:tf-flip'), '动画应用规则随钩子一起退场')
  })
})

describe('架构守卫：旧折叠引擎 CSS 必须消失', () => {
  it('无 :has() 成员隐藏、无 hidden 标记选择器、无旧折叠容器', () => {
    const css = baseCss() + '\n' + skinEl().textContent
    // :has() 唯一合法用途 = 运行态识别（官方 data-text-shimmer）；
    // 旧折叠引擎用 :has() 隐藏成员 flowItem——那是被删除的 Fold Engine 行为。
    const hasLines = css.split('\n').filter((l) => l.includes(':has('))
    for (const line of hasLines) {
      assert.ok(line.includes('[data-text-shimmer="true"]'), ':has() 仅允许用于 data-text-shimmer 运行态识别：' + line)
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

