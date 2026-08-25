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
    assert.match(css, /\.ccg-group-root\[data-ccg-turn\]\[data-ccg-open\] \.ccg-header\{margin-bottom:0\}/, '回合折叠栏展开时折叠栏底距由分隔线接管')
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
})
