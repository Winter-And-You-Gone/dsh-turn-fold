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
