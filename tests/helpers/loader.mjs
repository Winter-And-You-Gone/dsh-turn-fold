// 测试辅助：加载 client.js 的 factory，并把内部纯函数/组件通过 __test 导出。
//
// client.js 是 DSH client bundle（window.__ModuleLoader__.load({id, factory})），
// 内部函数（computeTurnMetrics 等）都闭包在 factory 里、不对外导出。测试不能复制粘贴
// 这些函数（会漂移），所以在源码的 `return module.exports;` 前注入一行 __test 导出，
// 用同一个 factory 实例拿到真实实现。注入只作用于测试加载的副本，对运行时无影响。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

export const CLIENT_JS = fileURLToPath(new URL('../../client.js', import.meta.url))

// __test 导出哪些名字（全部是 factory 内部的顶层函数/变量名）
const TEST_EXPORTS = [
  // 设置（Fold Enhancements，独立于官方 transcriptView）
  'FIELD_KEYS',
  'SETTINGS_KEY',
  'settings',
  'exports',
  'filterVisibleMetrics',
  'setFieldVisible',
  'useFieldVisibility',
  'setIconStyle',
  'getIconStyle',
  'useIconStyle',
  'applyIconStyle',
  'NativeChevronIcon',
  'SKIN_CSS_ID',
  'CSS_ID',
  'saveSettings',
  // 设置面板共享状态（面板由打开者栏内渲染，无 body portal）
  'popupState',
  'setPopupOpen',
  'getPopupState',
  'subscribePopup',
  'SettingsDialog',
  // Step Poker Skin
  'ACTIVITY_SUIT',
  'activitySuitOf',
  'buildStepSkinCss',
  'suitMaskImage',
  'stepCompletedGroupMask',
  'stepCompletedGroupSvg',
  'stepMorphTransforms',
  'stepMorphProgress',
  'MORPH_FRAMES',
  'stepMorphKeyframes',
  'cssBezierEase',
  // Step 牌数桥（官方 group snapshot → 视觉选择器；只读）
  'STEP_CARD_CSS_ID',
  'STEP_CARD_SMALL_MAX',
  'STEP_CARD_COUNT_SMALL',
  'STEP_CARD_COUNT_LARGE',
  'stepCardToolCallCount',
  'stepCardCountOfGroup',
  'stepCardGroupState',
  'cssAttrValue',
  'buildStepCardRulesCss',
  'writeStepCardRules',
  'registerStepCardBridge',
  'unregisterStepCardBridge',
  'promoteStepCardLeader',
  'stepCardBridgeSessions',
  'stepCardRulesBySession',
  'stepCardPendingCleanup',
  'hostCapabilitiesOf',
  'detectHostCapabilitiesAtRegistration',
  'hostCapabilityState',
  'hostCapabilityLog',
  'resolveHostFeature',
  'adoptRegistrationCapabilities',
  'reportHostCapabilities',
  'reportResolvedHostMode',
  'slotHasEntry',
  'activateLegacyTurnEngine',
  'activateLegacyStepEngine',
  'getLegacyEngineActivations',
  'resetHostCapabilityDiagnostics',
  'selectConversationGroupContract',
  'selectChatNodeShape',
  'probeOfficialSessionScope',
  'resolveLegacyStepCapability',
  'resetOfficialSessionScopeProbe',
  'writeStepCardRulesMerged',
  'clearStepCardRulesForSession',
  'cleanupCompletedStepSession',
  'scheduleCompletedStepSessionCleanup',
  'completedStepTopFace',
  'completedFacesArrangement',
  'completedFaceSetFor',
  'completedFaceSetCss',
  'completedStepTopFaces',
  'completedStepTopBags',
  'completedFaceSets',
  'getCompletedStepFaceCount',
  'hasCompletedStepBag',
  'getStepCardBridgeInstanceCount',
  'getStepCardBridgeLeaderCount',
  'getStepCardBridgeSessionCount',
  'faceSeedOf',
  'seededFaceRandom',
  'sessionKeyOf',
  'STEP_FACE_CSS_ID',
  'selectChatGroupedView',
  'selectChatGroupedEntries',
  'StepCardRulesBridge',
  'StepCardRuleWriter',
  'StepCardGroupProbe',
  // 运行中秒表时钟（固定 1000ms）
  'useLiveNow',
  'subscribeTicks',
  'getTickVersion',
  'tickListeners',
  'liveTickMs',
  // 指标（全部来自官方真实数据）
  'turnClockOf',
  'readStepUsage',
  'computeTurnMetrics',
  // 运行中 token 视觉增长（presentation-only）
  'visualTokenTickMs',
  'visualTokenCap',
  'visualTokenBootstrapCap',
  'visualTokenBootstrapValue',
  'visualTokenStepForTick',
  'visualTokenOffsetForTicks',
  'assistantBlockVisible',
  'assistantVisibleGenerationActive',
  'visualTokenShouldSubscribe',
  'notifyVisualTokenTick',
  'getVisualTokenTick',
  'getVisualTokenListenerCount',
  'isVisualTokenTimerRunning',
  'subscribeVisualTokenTicks',
  'subscribeReducedMotion',
  'usePrefersReducedMotion',
  'useDisplayTokenAnimation',
  'withDisplayTokens',
  'prefersReducedMotion',
  'selectDurableTurnMetrics',
  'observedTtft',
  'rememberObservedTtft',
  'readObservedTtft',
  'cacheHitPercent',
  'formatTurnDuration',
  'formatTokPerSec',
  'formatTokenCount',
  'turnHeaderLabel',
  'turnStatusLabel',
  'turnRoundLabel',
  // 扑克视觉
  'turnPokerIcon',
  'PokerIcon',
  'PokerSpinIcon',
  'buildPokerSVGBase',
  'buildPokerSpinSVG',
  'pokerTransforms',
  'pokerPaintOrder',
  'foldSuitFor',
  'pokerFacePool',
  'shufflePokerFaces',
  'nextTurnPokerFace',
  'pokerBags',
  'pokerFaceAssigned',
  'ICONS_STORAGE_KEY',
  'POKER_PIPS',
  'POKER_SUITS',
  'POKER_R',
  'POKER_SPIN_DEEPSEEK',
  'iconConfig',
  'ICON_DEFAULTS',
  'loadIconConfig',
  'NOTICE_VERSION',
  // 滚轮数字 / Turn 栏
  'RollDigit',
  'AnimatedLabel',
  'TurnBarView',
  'EnhancedTurnProcessView',
  'normalizeTurnProcessOwner',
  'NativeChevronIcon',
  'specCardCountFromSpec',
  'selectTurnNodeSource',
  // 齿轮 / 注册管道
  'GearIconSvg',
  'GearOptionSelector',
  'IconStyleSelector',
  'noteSlotDegradation',
  'safeRegisterSlot',
  'resolveSlotPriority',
  // i18n
  'currentLocale',
  '_T',
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
  // 默认复用模块级单例 JSDOM（--test-isolation=none 下 7 份 factory 共存，
  // 每次调用新建 JSDOM 会撞环境进程内存上限）。
  const defaultWin = globalThis.__tfSharedWindow ??= new JSDOM(
    '<!DOCTYPE html><html><head></head><body></body></html>',
    { pretendToBeVisual: true, url: 'http://localhost/' },
  ).window
  const win = options.window ?? defaultWin
  const doc = win.document

  const registrations = []
  let capturedFactory = null
  win.__ModuleLoader__ = {
    load(registration) {
      registrations.push(registration)
      if (registration.id === '@winteries/dsh-turn-fold') capturedFactory = registration.factory
    },
  }

  const mockRequire = (id) => {
    if (id === 'react') return React
    throw new Error(`unexpected require: ${id}`)
  }

  // 执行 bundle：顶层 `if (typeof window !== "undefined" && window.__ModuleLoader__)`
  const fn = new Function('window', 'document', 'require', injected)
  fn(win, doc, mockRequire)

  if (!capturedFactory) throw new Error('client.js 未注册 @winteries/dsh-turn-fold factory（window/__ModuleLoader__ 条件未命中）')

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
