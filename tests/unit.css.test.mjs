// CSS 测试：验证 client.js 注入的样式规则在真实 DOM 上生效——
// 被折叠的成员 flowItem（含 [data-ccg-hidden] 标记）display:none，
// 展开（移除标记）恢复显示，再次收起重新隐藏。
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { loadPlugin } from './helpers/loader.mjs'

const require = createRequire(import.meta.url)
const { JSDOM } = require('jsdom')

function makeFlowItem(doc, kind, contentHtml) {
  const el = doc.createElement('div')
  el.setAttribute('data-chat-flow-kind', kind)
  const slot = doc.createElement('div')
  slot.setAttribute('data-slot', 'conversation.chat.node')
  slot.style.display = 'contents'
  slot.innerHTML = contentHtml
  el.appendChild(slot)
  return el
}

describe('CSS 折叠隐藏规则', () => {
  const { document } = loadPlugin()

  it('注入的 style 标签包含 :has() 隐藏规则', () => {
    const tag = document.querySelector('style[data-plugin-css="dsh-turn-fold/style"]')
    assert.ok(tag, '插件应注入 style 标签')
    const css = tag.textContent
    assert.match(css, /\[data-chat-flow-kind\]:has\(\[data-ccg-hidden\]\)\{display:none\}/)
    assert.match(css, /\[data-ccg-turn-folded\] \[data-variant="think"\]\{display:none\}/)
  })

  it('注入的 style 标签包含回合折叠栏分隔线规则（折叠栏与内容之间的水平细线）', () => {
    const tag = document.querySelector('style[data-plugin-css="dsh-turn-fold/style"]')
    const css = tag.textContent
    assert.match(css, /\.ccg-turn-divider\{height:1px/, '分隔线应为 1px 水平细线')
    assert.match(css, /\.ccg-group-root\[data-ccg-open\]:not\(\[data-ccg-turn\]\) > \.ccg-fold-clip\{margin-top:16px\}/,
      '展开间距应挂在直接子元素 .ccg-fold-clip 上（16px，排除回合栏）——header 在 DisclosureRow 内部 DOM，挂 header 无法既命中又不跨层泄漏')
    assert.doesNotMatch(css, /\.ccg-group-root\[data-ccg-open\][^{]*\.ccg-header\{margin/,
      '不得再用 header 承载展开间距（后代选择器跨层泄漏 / > 选择器匹配不上 DisclosureRow 内部 DOM）')
    // 防跳动：fold-clip 的 margin-top 参与过渡（收起时 16px 间距随高度一起动画，
    // 不在收起开始瞬间瞬跳）；占位栏补 16px 顶部间距（交接给正式栏不位移）
    assert.match(css, /transition:grid-template-rows \.28s[^}]*margin-top \.28s/, 'fold-clip 过渡应包含 margin-top')
    assert.match(css, /\.ccg-group-root\[data-ccg-placeholder\]\{margin-top:16px\}/, '占位栏应补 16px 顶部间距')
  })

  it('展开间距不跨层泄漏：回合嵌套段自己的 fold-clip 命中 16px，回合的不命中', () => {
    // 结构模拟真实 DOM：header 在 DisclosureRow 内部包装层里（非 group-root 直接子元素）
    const turn = document.createElement('div')
    turn.className = 'ccg-group-root'
    turn.setAttribute('data-ccg-turn', 'true')
    turn.setAttribute('data-ccg-open', 'true')
    turn.innerHTML =
      '<div class="disclosure-wrap"><div class="ccg-header">回合折叠栏</div></div>' +
      '<div class="ccg-turn-divider"></div>' +
      '<div class="ccg-fold-clip ccg-fold-clip-open"><div class="ccg-fold-body">' +
        '<div class="ccg-group-root" data-ccg-open="true">' +
          '<div class="disclosure-wrap"><div class="ccg-header">步骤折叠栏</div></div>' +
          '<div class="ccg-fold-clip ccg-fold-clip-open"><div class="ccg-fold-body">成员行</div></div>' +
        '</div>' +
      '</div></div>'
    document.body.appendChild(turn)
    const clips = turn.querySelectorAll('.ccg-fold-clip')
    assert.equal(clips.length, 2)
    assert.equal(parseInt(document.defaultView.getComputedStyle(clips[0]).marginTop, 10), 0,
      '回合折叠栏的 fold-clip 不应获得 16px（间距由分隔线承担）')
    assert.equal(parseInt(document.defaultView.getComputedStyle(clips[1]).marginTop, 10), 16,
      '嵌套步骤折叠栏自己的 fold-clip 应获得 16px（与成员间距同节奏）')
    document.body.removeChild(turn)
  })

  it('注入的 style 标签包含滚轮数字规则与 sr-only 规则', () => {
    const tag = document.querySelector('style[data-plugin-css="dsh-turn-fold/style"]')
    const css = tag.textContent
    assert.match(css, /\.ccg-roll-cell\{display:inline-block;width:1ch;height:1em;overflow:hidden/, '数位视窗应裁切为 1ch×1em')
    assert.match(css, /\.ccg-roll-strip\{display:flex;flex-direction:column\}/, '数字条竖排 0-9')
    assert.match(css, /\.ccg-sr-only\{position:absolute;width:1px;height:1px/, 'sr-only 完整文案应视觉隐藏')
  })

  it('成员含 hidden 标记 → flowItem display:none（收起状态）', () => {
    const el = makeFlowItem(document, 'tool-call', '<span data-ccg-hidden="true" style="display:none"></span>')
    document.body.appendChild(el)
    const cs = document.defaultView.getComputedStyle(el)
    assert.equal(cs.display, 'none')
    document.body.removeChild(el)
  })

  it('无 hidden 标记 → flowItem 正常显示（展开状态）', () => {
    const el = makeFlowItem(document, 'tool-call', '<div class="tool-card">content</div>')
    document.body.appendChild(el)
    const cs = document.defaultView.getComputedStyle(el)
    assert.notEqual(cs.display, 'none')
    document.body.removeChild(el)
  })

  it('回归 Bug2 场景（CSS 层面）：展开 → 收起 → 重新隐藏', () => {
    const el = makeFlowItem(document, 'tool-call', '<span data-ccg-hidden="true" style="display:none"></span>')
    document.body.appendChild(el)
    const slot = el.querySelector('[data-slot]')
    assert.equal(document.defaultView.getComputedStyle(el).display, 'none', '初始收起')
    // 模拟展开：替换内容为卡片
    slot.innerHTML = '<div class="tool-card">card</div>'
    assert.notEqual(document.defaultView.getComputedStyle(el).display, 'none', '展开后显示')
    // 模拟收起：替换回 hidden 标记
    slot.innerHTML = '<span data-ccg-hidden="true" style="display:none"></span>'
    assert.equal(document.defaultView.getComputedStyle(el).display, 'none', '收起后重新隐藏')
    document.body.removeChild(el)
  })

  it('无 hidden 标记的普通节点（user 等）不受影响', () => {
    const el = makeFlowItem(document, 'user', '<div class="user-msg">用户消息</div>')
    document.body.appendChild(el)
    const cs = document.defaultView.getComputedStyle(el)
    assert.notEqual(cs.display, 'none', '不含 hidden 标记的节点不应被隐藏')
    document.body.removeChild(el)
  })

  it('规则对任意 kind 的成员生效（assistant-step 成员同样隐藏）', () => {
    const el = makeFlowItem(document, 'assistant-step', '<span data-ccg-hidden="true" style="display:none"></span>')
    document.body.appendChild(el)
    assert.equal(document.defaultView.getComputedStyle(el).display, 'none')
    document.body.removeChild(el)
  })

  it('文件名链接：悬停变蓝 + 白色下划实线（底态透明下划线占位，可过渡淡入）', () => {
    const tag = document.querySelector('style[data-plugin-css="dsh-turn-fold/style"]')
    const css = tag.textContent
    assert.match(css, /\.ccg-file-link\{[^}]*text-decoration-line:underline[^}]*text-decoration-color:transparent/,
      '底态应有透明下划线占位（悬停时颜色过渡淡入）')
    assert.match(css, /\.ccg-file-link:hover\{color:#4D6BFE!important;text-decoration-color:#fff!important\}/,
      '悬停应变官方蓝 + 白色下划实线')
    // 行为：底态下划线不可见（透明），悬停后变白
    const el = document.createElement('span')
    el.className = 'ccg-file-link'
    document.body.appendChild(el)
    const view = document.defaultView
    assert.equal(view.getComputedStyle(el).textDecorationColor, 'rgba(0, 0, 0, 0)', '底态下划线透明')
    document.body.removeChild(el)
  })

  it('段外 text 正文首尾块 margin 钳制为 0（镜像官方重置，防止与 16px padding/gap 叠加）', () => {    // 模拟官方 AssistantMarkdown 结构：root > body > .markdown > p（p 自带 margin:16px 0，
    // 运行中的官方 bundle 首尾重置未必生效——插件用 >*>*>*> 结构选择器钳制）
    const el = document.createElement('div')
    el.className = 'ccg-text-only'
    el.innerHTML = '<div class="root"><div class="body"><div class="markdown">' +
      '<p style="margin:16px 0">正文段落</p>' +
      '</div></div></div>'
    document.body.appendChild(el)
    const cs = document.defaultView.getComputedStyle(el.querySelector('p'))
    assert.equal(cs.marginTop, '0px', '首块 margin-top 应被钳为 0（含覆盖内联 margin）')
    assert.equal(cs.marginBottom, '0px', '尾块 margin-bottom 应被钳为 0')
    document.body.removeChild(el)
  })

  it('text-only 内非首尾块的 margin 不受钳制（多段落内部间距保持官方值）', () => {
    const el = document.createElement('div')
    el.className = 'ccg-text-only'
    el.innerHTML = '<div><div><div class="markdown">' +
      '<p style="margin:16px 0">第一段</p>' +
      '<p style="margin:16px 0">第二段</p>' +
      '</div></div></div>'
    document.body.appendChild(el)
    const ps = el.querySelectorAll('p')
    assert.equal(document.defaultView.getComputedStyle(ps[0]).marginTop, '0px')
    assert.equal(document.defaultView.getComputedStyle(ps[1]).marginBottom, '0px')
    // 中间块的 margin 不动（此例两段互为首尾，构造三段验证中段）
    el.innerHTML = '<div><div><div class="markdown">' +
      '<p>一</p><p style="margin:16px 0">二</p><p>三</p>' +
      '</div></div></div>'
    const mid = el.querySelectorAll('p')[1]
    assert.equal(document.defaultView.getComputedStyle(mid).marginTop, '16px', '中段 margin-top 不应被钳制')
    assert.equal(document.defaultView.getComputedStyle(mid).marginBottom, '16px', '中段 margin-bottom 不应被钳制')
    document.body.removeChild(el)
  })

  it('最终总结包装器 [data-ccg-turn-folded] 首尾块 margin 同样钳制', () => {
    const el = document.createElement('div')
    el.setAttribute('data-ccg-turn-folded', 'true')
    el.innerHTML = '<div class="root"><div class="body"><div class="markdown">' +
      '<p style="margin:16px 0">最终总结</p>' +
      '</div></div></div>'
    document.body.appendChild(el)
    const cs = document.defaultView.getComputedStyle(el.querySelector('p'))
    assert.equal(cs.marginTop, '0px', '最终总结首块 margin-top 应被钳为 0')
    document.body.removeChild(el)
  })
})
