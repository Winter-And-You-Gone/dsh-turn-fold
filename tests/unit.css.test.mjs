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

describe('架构守卫：旧折叠引擎 CSS 必须消失', () => {
  it('无 :has() 成员隐藏、无 hidden 标记选择器、无旧折叠容器', () => {
    const css = baseCss() + '\n' + skinEl().textContent
    assert.ok(!css.includes(':has('), ':has() 隐藏规则必须删除')
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
