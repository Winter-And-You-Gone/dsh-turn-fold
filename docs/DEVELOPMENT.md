# 测试与发布（工程附录）

> 本文是 [README](../README.md) 的工程细节附录：测试套件索引、CI 与发版流程。

## 测试

```sh
npm install        # 首次：安装 jsdom / react / react-dom（devDependencies）
npm test           # node --test 运行 tests/ 下的全部测试
npm run check      # 语法检查 client.js / index.js
```

测试套件（`tests/`）直接加载真实 `client.js`（经 `__ModuleLoader__` 注入 + `__test`
导出，无复制粘贴漂移）。下表是按能力分层的**主要**文件，不是全量清单（完整清单见
`tests/` 目录）：

| 文件 | 覆盖 |
| --- | --- |
| `unit.logic.test.mjs` | 指标纯函数：`turnClockOf` / `computeTurnMetrics` / `readStepUsage`（官方 TurnLocation / step usage / turn-tail 聚合三来源）、格式化、字段显隐与 localStorage 持久化；同一输入两次计算结果逐字段相等（无伪造增长） |
| `unit.turn-renderer.test.mjs` | Turn 渲染器：`open=false → 点击 → setOpen(true)`、`open=true → 点击 → setOpen(false)`；`foldable=false`/aborted/error → 静态栏无 setOpen 通道；Running Bar 0 秒出现、非交互、不触碰 Fold 状态；回合结束平滑交接；`turnProcess` 缺失降级 |
| `unit.poker.test.mjs` | 活动→花色映射（官方 ProcessActivity 词表全覆盖）、牌堆/扇形/翻牌 SVG 生成、**运行中翻牌轴 = 竖直对角线轴（轴角 = atan(w/h) + 几何/原点校验 + CSS 覆盖回归守卫）**、组件渲染、reduced-motion 与无 WAAPI 静态降级 |
| `unit.step-cards.test.mjs` | Step 牌数桥：官方 `counts` 求和 → 3/5 张、3 张 morph 身份连续、逐组 mask 几何、桥全链路（groupSource 订阅、同域规则撤销/恢复、leader 卸载清空）；**步骤文件清单：路径抽取（结算态/运行中/preparing/截断/目录型工具/转义）、basename 去重 + `+N` 截断、会话作用域双支、运行中也输出、参数变化跟随刷新、无 ChatNodeStore 时降级为空** |
| `unit.css.test.mjs` | Step 皮总闸（`applyIconStyle()` 切两张样式表的 `disabled`）与官方 DOM 钩子规则；**平面旋转契约（倾斜只在展开态：收起 = 正立、展开 = 35.5°，由官方 `aria-expanded` 驱动，两份资产只差最外层 `<g class="tf-step-flat-rotation">` 包装；`tf-step-flat-rotation` 包住全部相位、角 = 数据源 `pokerSpin.restAngle` 且四舍五入 == 参考稿字面量 35.5、五相位/72 animateTransform/15 animate/0.8s×82/4s×5 全部原样、±3.1° 二维小角度、四蒙版挖空、poker 5:7 卡牌）**；**架构守卫：旧 Fold Engine 的 `:has()` 隐藏规则必须消失** |
| `unit.gear.test.mjs` | 设置弹窗：字段 checkbox 双向绑定、设置持久化、图标风格 / Step 皮选择器（hooks 顺序守卫）；**「动态扑克牌」预览的牌面每秒轮换（纯函数位移 + 真实直播时钟驱动 + 关窗退订）** |
| `unit.compat.test.mjs` | **注册审计：仅 shadow `turn-process` 一个 key**、`exports.inject=['slots']`、priority 冲突让位、注册异常软降级；**架构守卫：旧引擎标识符 / 官方 renderer 代理层 / transcriptView 写入扫描为零（剥注释后同时扫 `client.js` 与 `index.js`）；插件零滚动权限（`.scrollTop` 写入 0 处、无 `scrollIntoView`/`scrollTo`/`overflow-anchor`、不读 `data-chat-following-tail`、不扫 `data-conversation-scroll`、无任何 DOM 观察器）；样式注入失败不得带崩插件激活（appendChild 抛错仍能注册）**；官方四档 transcript 模式渲染兼容 |
| `regression.test.mjs` | 历史回归：直播时钟空转定时器、**禁止假 Token 增长（真实数据不变 → 数字不变）**、齿轮 stopPropagation、降级要求（图标包/设置损坏回退默认） |
| `unit.host-compat.test.mjs` | 跨版本能力矩阵（三态语义、UNKNOWN ≠ LEGACY）、注册门控（Modern 宿主 legacy 激活恒 0；legacy 宿主注册期只记 Turn）、selector 完整 host 逐支生成 + jsdom 双树命中、运行时 resolution（未就绪保持 unknown / 契约缺失才 legacy / 已定论不翻转）、metrics 与 Turn fold 解耦（reactive/fallback/unknown）、诊断两行制（probing → resolved） |
| `unit.step-session-scope.test.mjs` | 会话作用域：selector 前缀与转义、裸会话分支回归锁定、same groupKey 双树隔离、tree-only 多会话安全降级（撤下 session-specific 覆盖、恢复无需刷新、completedFaceSets 保留、running 轮换不受影响） |
| `unit.docs.test.mjs` | **中英文档对齐守卫（README + docs/ 附录）**：语言中立事实（区间/标识符/commit/选择器/存储键）两侧原样一致；平行章节的成对表述（样式注入六类、运行中指标口径、已知问题节）两侧都在；样式注入清单条数 == `client.js` 的实际注入处数（改了一侧忘另一侧 → 红）；`NOTICE_VERSION` == `package.json` 的 `version`（发版忘了同步 → 红）；README 体积上限（工程细节留在 docs/） |

> 在 Windows 沙箱等无法 spawn 子进程的环境下需要 `--test-isolation=none`（已在
> `npm test` 中内置）；普通 Linux/macOS CI 同样可用该参数。
> **Node 版本**：插件运行时（`engines.node`）跟随 DSH 本体 = `^22.19.0 || >=24.0.0`；
> 而**跑测试**还需要 devDependencies 里的 jsdom 30，它要求 `^22.22.2 || ^24.15.0 || >=26`
> ——CI 固定用 Node 24。Node 版本不满足时 `npm install` 只会给一条 EBADENGINE 警告，
> 不影响插件在 DSH 里加载。


## CI 与发布

GitHub Actions 会在每次 PR / push 到 `main` 或 `better` 时自动运行语法检查、`npm test`
全套测试、图标数据源防漂移校验和 `npm pack --dry-run` 打包内容断言；推送 `v*` tag 时
自动发布到 npm（OIDC Trusted Publishing，无需长期 token）并创建 GitHub Release。
**一次性配置**（把 npm 包绑定到本仓库的 release workflow）：

```sh
npx npm@^11.15.0 trust github @winteries/dsh-turn-fold \
  --repo Winter-And-You-Gone/dsh-turn-fold \
  --file release.yml \
  --allow-publish

# 旧包名也在同一份源码上再发布一次（已装旧包的用户，其更新走旧包名）——
# 漏配这一条，Release 里那一步 publish 会认证失败：
npx npm@^11.15.0 trust github dsh-turn-fold \
  --repo Winter-And-You-Gone/dsh-turn-fold \
  --file release.yml \
  --allow-publish
```

也可以改为在 npmjs.com 网站账户设置里配置 Trusted Publishing。

**发布审批门（建议配置）**：publish job 绑定了 `npm-publish` environment。在仓库
Settings → Environments 里给该 environment 加 required reviewers 之后，**任何 `v*` tag
推送都必须人工批准才会真正 publish**（tag 推送本身即触发，没有第二道确认）——
本机没有 npm 撤包权限，发错的版本只能由用户在网页端处理，所以这道门是唯一的事前闸门。
未配置 reviewers 时该 environment 不产生保护（行为与从前一致）。

**之后每次发版三步**：

```sh
npm version patch        # 或 minor / major：bump 版本并自动打 v* tag
# 手动把 client.js 的 NOTICE_VERSION 改成同一个版本号（守卫会校验，见下）
git push --follow-tags
```

> 提示：`npm version` 要求工作区干净，先把待发布的改动提交；tag 名必须与
> `package.json` 的 `version` 一致（workflow 会校验，不一致即失败）。
> `NOTICE_VERSION`（图标包 `meta.compat` 的比较基准）必须与 `package.json` 的
> `version` 逐字相同——`npm test` 里有守卫，忘了同步会在 Release 的测试步骤直接红。
