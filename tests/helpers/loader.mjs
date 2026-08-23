// 测试辅助：加载 client.js 的 factory，并把内部纯函数/组件通过 __test 导出。
//
// client.js 是 DSH client bundle（window.__ModuleLoader__.load({id, factory})），
// 内部函数（computeGroup 等）都闭包在 factory 里、不对外导出。测试不能复制粘贴
// 这些函数（会漂移），所以在源码的 `return module.exports;` 前注入一行 __test 导出，
// 用同一个 factory 实例拿到真实实现。注入只作用于测试加载的副本，对运行时无影响。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

export const CLIENT_JS = fileURLToPath(new URL('../../client.js', import.meta.url))

// __test 导出哪些名字（全部是 factory 内部的顶层函数/变量名）
const TEST_EXPORTS = [
  'CONFIG',
  'computeGroup',
  'computeTurnFold',
  'computeTurnMetrics',
  'projectLiveTokens',
  'turnDisplayMetrics',
  'turnHeaderLabel',
  'segmentLabel',
  'summarizeArgs',
  'formatTurnDuration',
  'formatTokPerSec',
  'turnNumber',
  'GroupedToolCallView',
  'GroupedAssistantView',
  'GroupedContextView',
  'GroupHeader',
  'RollDigit',
  'AnimatedLabel',
  'renderBuiltinToolCall',
  'renderToolview',
  'builtinComponent',
  'setTurnOpen',
  'setGroupOpen',
  'readOverride',
  'useTurnOverride',
  'useGroupOverride',
  'useLiveNow',
  'liveTokenCache',
  'liveTickState',
  'turnOverrides',
  'overrides',
  'hiddenMarker',
]

/**
 * 执行一次 client.js 的 factory，返回其 module.exports。
 * @param {object} [options]
 * @param {object} [options.react] 注入给 factory 的 react（缺省用 node_modules 的 react）
 * @param {object} [options.uiPrimitives] ui-primitives mock；缺省 undefined → 走插件兜底样式
 * @param {object} [options.window] jsdom window（缺省自动创建）
 * @returns {{ exports: object, test: object, window: object, document: object, React: object, registrations: Array }}
 */
export function loadPlugin(options = {}) {
  const require = createRequire(import.meta.url)
  const React = options.react ?? require('react')

  let rawSrc = readFileSync(CLIENT_JS, 'utf8')
  const marker = 'return module.exports;'
  if (!rawSrc.includes(marker)) throw new Error(`client.js 缺少注入标记: ${marker}`)
  const injected = rawSrc.replace(
    marker,
    `module.exports.__test = { ${TEST_EXPORTS.join(', ')} };\n\t\t${marker}`,
  )

  const { JSDOM } = require('jsdom')
  const win = options.window ?? new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/',
  }).window
  const doc = win.document

  const registrations = []
  let capturedFactory = null
  win.__ModuleLoader__ = {
    load(registration) {
      registrations.push(registration)
      if (registration.id === 'dsh-turn-fold') capturedFactory = registration.factory
    },
  }

  const uiPrimitives = options.uiPrimitives
  const mockRequire = (id) => {
    if (id === 'react') return React
    if (id === '@deepseek-ai/dsh-client-ui-primitives') {
      if (uiPrimitives === undefined) throw new Error('ui-primitives missing (fallback path)')
      return uiPrimitives
    }
    throw new Error(`unexpected require: ${id}`)
  }

  // 执行 bundle：顶层 `if (typeof window !== "undefined" && window.__ModuleLoader__)`
  const fn = new Function('window', 'document', 'require', injected)
  fn(win, doc, mockRequire)

  if (!capturedFactory) throw new Error('client.js 未注册 dsh-turn-fold factory（window/__ModuleLoader__ 条件未命中）')

  const moduleExports = capturedFactory(mockRequire)
  if (!moduleExports || typeof moduleExports.apply !== 'function') {
    throw new Error('factory 未返回预期的 module.exports（缺 apply）')
  }
  return {
    exports: moduleExports,
    test: moduleExports.__test,
    window: win,
    document: doc,
    React,
    registrations,
  }
}
