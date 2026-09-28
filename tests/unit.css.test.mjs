// CSS 契约测试：
//   - Turn 栏 / 齿轮弹窗 / 滚轮数字样式存在
//   - Step Poker Skin：body 属性总闸 + 官方 DOM 钩子（data-step-process*）+ 活动映射规则
//   - 架构守卫：旧折叠引擎的 CSS 隐藏机制（:has() 隐藏成员、hidden 标记、
//     fold-clip / group-root / 旧 header）必须全部消失
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { loadPlugin } from './helpers/loader.mjs'

const { test: T, document, window } = loadPlugin({ uiPrimitives: {} })

function styleText() {
  const tag = document.querySelector('style[data-plugin-css="dsh-turn-fold/style"]')
  assert.ok(tag, '插件样式表已注入')
  return tag.textContent
}

beforeEach(() => {
  window.localStorage.clear()
  T.applyStepSkinAttr()
})

describe('Turn 栏样式', () => {
  it('核心类全部注入', () => {
    const css = styleText()
    for (const cls of ['.ccg-turn-bar{', '.ccg-turn-bar-label{', '.ccg-turn-bar-right{', '.ccg-turn-bar-chevron{', '.ccg-turn-divider{']) {
      assert.ok(css.includes(cls), '缺少 ' + cls)
    }
  })

  it('非交互态样式钩子（data-tf-static / data-open 旋转箭头）', () => {
    const css = styleText()
    assert.ok(css.includes('[data-tf-static]'))
    assert.ok(css.includes('.ccg-turn-bar[data-open] .ccg-turn-bar-chevron'))
  })
})

describe('Step Poker Skin（官方结构 + 软 DOM 依赖）', () => {
  it('皮肤由 body 属性总闸（data-tf-step-skin）控制', () => {
    const css = styleText()
    assert.ok(css.includes('body[data-tf-step-skin="poker"]'))
    // 所有皮肤规则都挂在总闸之下：不含脱离 body 前缀的 data-step-process 规则
    for (const line of css.split('\n')) {
      if (line.includes('data-step-process')) {
        assert.ok(line.startsWith('body[data-tf-step-skin="poker"]'), '皮肤规则必须挂在总闸下：' + line)
      }
    }
  })

  it('官方 DOM 钩子（data-step-process / data-step-process-icon / data-process-activity）全部命中', () => {
    const css = styleText()
    assert.ok(css.includes('[data-step-process] [data-step-process-icon] > *{display:none}'), '官方图标内容隐藏')
    assert.ok(css.includes('[data-step-process] [data-step-process-icon]::before'), '卡牌渲染位')
  })

  it('活动 → 花色映射规则（官方 ProcessActivity 词表）', () => {
    const css = styleText()
    const activities = ['thinking', 'read', 'readImage', 'search', 'edit', 'write', 'commands', 'code', 'webSearch', 'webFetch', 'subagents', 'plan', 'questions', 'tools']
    for (const activity of activities) {
      assert.ok(css.includes('[data-process-activity="' + activity + '"]'), '缺少活动规则 ' + activity)
    }
    assert.ok(css.includes('data:image/svg+xml'), '卡牌 mask data-URI')
  })

  it('花色 JS 映射与 CSS 规则一致（同源生成）', () => {
    const css = styleText()
    const suits = new Set(Object.values(T.ACTIVITY_SUIT))
    for (const suit of suits) {
      if (suit === 'whale' && !T.POKER_SPIN_DEEPSEEK) continue
      // 每个花色至少有一条映射规则（同花色活动合并选择器）
      const activity = Object.keys(T.ACTIVITY_SUIT).find((a) => T.ACTIVITY_SUIT[a] === suit)
      assert.ok(css.includes('[data-process-activity="' + activity + '"]'), suit + ' 规则缺失')
    }
  })
})

describe('架构守卫：旧折叠引擎 CSS 必须消失', () => {
  it('无 :has() 成员隐藏、无 hidden 标记选择器、无旧折叠容器', () => {
    const css = styleText()
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
    const css = styleText()
    assert.ok(css.includes('@media (prefers-reduced-motion:reduce)'))
  })
})

describe('body 属性开关（applyStepSkinAttr）', () => {
  it('apply 后默认 poker；setStepSkin("native") 移除；改回恢复', () => {
    assert.equal(document.body.getAttribute(T.STEP_SKIN_ATTR), 'poker')
    T.setStepSkin('native')
    assert.equal(document.body.getAttribute(T.STEP_SKIN_ATTR), null)
    T.setStepSkin('poker')
    assert.equal(document.body.getAttribute(T.STEP_SKIN_ATTR), 'poker')
  })

  it('非法皮肤值被忽略', () => {
    T.setStepSkin('random')
    assert.equal(document.body.getAttribute(T.STEP_SKIN_ATTR), 'poker')
    T.setStepSkin(undefined)
    assert.equal(document.body.getAttribute(T.STEP_SKIN_ATTR), 'poker')
  })
})
