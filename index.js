// dsh-turn-fold: DeepSeek Harness 插件（宿主半边）。
//
// 纯占位：保证该 loader entry 是"活的"（client-modules 只把活的 entry 编进
// window.__DSH_BOOT__），且 host（Node）进程能安全导入本包。
// 折叠 / 整回合折叠 / 大组头指标的全部逻辑都在前端 client.js。
export const name = 'dsh-turn-fold'

export function apply() {
  /* 折叠纯前端实现，宿主无逻辑。 */
}
