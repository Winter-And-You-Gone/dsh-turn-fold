// dsh-turn-fold: DeepSeek Harness 插件（宿主半边）。
//
// 折叠 / 整回合折叠 / 回合折叠栏指标的全部逻辑都在前端 client.js，宿主半边
// 只做一件事：把「自定义图标」agent skill 注册进 DSH 的 skill 目录
// （ctx.skills.registerProvider），让 AI 代理在用户想改折叠栏图标时能加载
// 完整自定义流程（icons/default.json → sync:icons 注入 → 校验 → 重启提醒）。
//
// skill 正文在 assets/dsh-turn-fold-customize-icons.md，随 npm 包分发；
// 与官方 skill-badge 插件（@deepseek-ai/dsh-skill-badge）同一机制。
//
// 注意：本文件必须「零外部依赖」——不 import 任何 @deepseek-ai/ 或第三方包，
// 避免在 DSH 不同版本/装配下因包解析失败导致整个插件加载崩溃。
// - node:fs 和 node:url 是 Node 内置，安全。
// - @deepseek-ai/dsh-skill 的 BUNDLED_SKILL_RANK = 600，直接写死。
// - ctx.skills 通过 ctx.inject 延迟注入，不存在时不阻塞。
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-turn-fold'

// BUNDLED_SKILL_RANK 硬编码（来自 @deepseek-ai/dsh-skill，值 = 600）。
// 不在顶层 import 该包：profile node_modules 里可能没有它，会导致加载失败。
const BUNDLED_SKILL_RANK = 600

/** skill 正文（随包 asset，与 index.js 同目录的 assets/ 下）。 */
const SKILL_BODY_URL = new URL('assets/dsh-turn-fold-customize-icons.md', import.meta.url)
/** 相对资源基目录：skill 正文提到的 icons/、scripts/、docs/ 都相对插件包根。 */
const RESOURCE_BASE = Object.freeze({
  kind: 'directory',
  path: fileURLToPath(new URL('.', import.meta.url)),
})
const INVOCATION = Object.freeze({ modelInvocable: true, userInvocable: true })
const DESCRIPTION = 'Customize the dsh-turn-fold plugin\'s fold-bar icons (poker cards / card stack / fan / flip / spin animations). Use this Skill when the user wants to change the look of the step/turn fold bar icons, add a new suit or face design, tweak card geometry (corner radius, fan angle, stack offset), replace the running spin animation, or restore the official default chevron. Covers the icon data source (icons/default.json), the sync-inject pipeline (npm run sync:icons), the runtime localStorage override (dsh-turn-fold:icons), validation & fallback rules, and the SVG pitfalls unique to this user\'s browser.'

const CANDIDATE = Object.freeze({
  name: 'dsh-turn-fold-customize-icons',
  description: DESCRIPTION,
  invocation: INVOCATION,
  provider: 'dsh-turn-fold',
  source: 'bundled',
  resourceBase: RESOURCE_BASE,
  rank: BUNDLED_SKILL_RANK,
  locator: SKILL_BODY_URL,
})

const provider = {
  name: 'dsh-turn-fold',
  list: () => Promise.resolve([CANDIDATE]),
  async get(_candidate) {
    return {
      name: CANDIDATE.name,
      description: CANDIDATE.description,
      invocation: CANDIDATE.invocation,
      provider: CANDIDATE.provider,
      source: CANDIDATE.source,
      resourceBase: RESOURCE_BASE,
      content: await readFile(SKILL_BODY_URL, 'utf8'),
    }
  },
}

/** @param {import('@deepseek-ai/cordis').Context} ctx */
export function apply(ctx) {
  // 用 ctx.inject 延迟注册：`skills` 服务就绪后回调执行。旧版 DSH（无 skills
  // 服务）不阻塞、不报错——折叠功能仍在前端正常工作，仅自定义图标 skill 不可用。
  // 两层守卫各管一段：外层包 inject 本身同步抛，内层包延迟回调体内抛——回调是
  // 延迟执行的，外层 try/catch 包不住它的栈。
  const tryRegisterProvider = (scope) => {
    try {
      scope.skills.registerProvider(() => provider)
    } catch (error) {
      console.warn('[dsh-turn-fold] skill provider registration skipped:', error)
    }
  }
  try {
    ctx.inject(['skills'], tryRegisterProvider)
  } catch (error) {
    console.warn('[dsh-turn-fold] skill provider registration skipped:', error)
  }
}