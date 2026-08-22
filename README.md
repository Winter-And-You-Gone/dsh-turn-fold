# dsh-turn-fold

> **简体中文**（默认） | [English](README.en.md)

> 受够了几十条工具调用占满屏幕？
> 也眼馋隔壁 Codex 的自动折叠？
> 那这个插件就是为你准备的。

DeepSeek Harness（DSH）**纯插件**，只负责**折叠**：
1. **段级分组自动折叠**：工具调用按 Think 分组，下一个 Think 出现后自动收成段级组头（Think 块保持内置默认，仅作分组边界）。
2. **整回合折叠**：一轮回复完成后，本回合所有 Think + 工具调用 + 上下文注入收成**一个大组头**，大组头显示本轮耗时/token/tok/s/缓存命中率；最终总结只显示正文。
3. **手动展开/收起**：点击组头切换。

**不修改任何 `@deepseek-ai/dsh-*` 源码。**

> **设计参考**：本插件的工具调用自动折叠功能与交互风格参考了 Codex（OpenAI）的工具调用自动折叠体验——
> 按思考段自动收起工具调用、点击组头即可展开查看细节。

## 功能一：段级分组自动折叠

```
Think：……（保持内置默认：收起、点击展开）
┌───────────────────────────────────────┐
│ › 运行了 3 条命令              [3]    │  ← 下一个 Think 出现后自动折叠成组
└───────────────────────────────────────┘
Think：……（保持内置默认）
┌───────────────────────────────────────┐
│ › 运行了 2 条命令              [2]    │
└───────────────────────────────────────┘
```

- **Think 保持内置默认**：收起、点击展开，插件不做任何改动（仅作为分组边界）。
- **自动折叠时机**：某组工具调用之后的**下一个 Think 出现时**，该组自动收起。
- **本轮保持展开**：下一个 Think 出现之前，当前这轮工具调用保持展开，可实时观看执行过程。
- **手动可展开/收起**：点击组头切换；手动选择会覆盖自动规则。
- **失败命令标红**：组内已有命令**执行失败**（工具结果 `isError`，含中断）时，组头文字变红，并在
  「运行了 N 条命令」后追加失败数，如 `运行了 6 条命令——2条执行失败`。

### 效果示意

折叠前后对比（左：工具调用全部展开、逐条显示；右：下一个 Think 出现后自动收成段级组头）：

<table>
  <tr>
    <td align="center"><b>折叠前</b></td>
    <td align="center"><b>折叠后</b></td>
  </tr>
  <tr>
    <td align="center"><img src="docs/images/segment-before-collapse.png" alt="折叠前" width="300"/></td>
    <td align="center"><img src="docs/images/segment-after-collapse.png" alt="折叠后" width="300"/></td>
  </tr>
</table>

## 功能二：整回合折叠成一个大组头

```
[用户消息]
[▸ 耗时5分12秒，消耗12345token，34tok/s，缓存命中80%]   ← 一个大组头
[最终总结正文]                                           ← 无 Think 行，只有正文
[耗时 · token 脚注]                                      ← 官方 turn-tail
```

- 一轮回复**完成**（输出最终总结、回合结束）后，本回合内所有 Think、工具调用和上下文注入
  自动收成**一个大组头**，只保留最终总结消息和官方耗时/token 脚注可见；
- **无工具调用也折叠**：回合内只有上下文注入 / Think、没有任何工具调用时，同样收成
  一个大组头（组头显示耗时/token 指标，不显示命令数）；
- **大组头显示本轮指标**：`耗时x时x分x秒（不足 1 小时只显示分秒，不足 1 分钟只显示秒），
  消耗xxx token，xxx tok/s，缓存命中 xx%`；某几项缺失时自动省略，全部缺失才回退为
  「运行了 N 条命令」；
- 点击大组头展开/收起整轮内容；重新打开历史会话时，已完成的回合同样保持整回合折叠；
- **折叠作用域不越过用户消息**：大组头只折叠「用户消息之后、agent 回复之间」的内容。
  锚定在用户消息**上方**的上下文行（如审批策略变更通知）不属于本回合输出区间，
  始终保持原样可见，绝不参与折叠，也不会被当作组头锚点——避免大组头「跨过」用户消息
  去折叠其上方的内容；
- **最终总结只显示正文**：回合结束后，最终总结消息内部自带的 Think 行也一并隐藏；
- **单条不分组**：两个 Think 之间只有 **1 条**命令时，不套段级组头，始终原样显示命令卡片；
  回合结束整回合折叠时它收进大组头，展开后恢复原样。

### 效果示意

回合结束后，整回合收成一个带指标的大组头，只保留最终总结正文：

![回合结束折叠](docs/images/turn-collapsed.png)

## 组件样式与行距

- **组头即官方样式**：组头直接复用官方 `DisclosureRow` 原语（`@deepseek-ai/dsh-client-ui-primitives`）
  渲染——24px 行高、16px 前导、官方 14px chevron（收起右向 / 展开下向）、14px/24px 标题，
  与 Think / 工具卡片的折叠行逐像素一致；
- **紧凑行距**：折叠组只占一行（24px）；被折叠的成员节点整行 `display:none`，不会残留空行，
  行距与官方消息完全一致（column 的 16px 节奏），折叠再多也不会越空越大。

## 安装

### 方式一（推荐）：从 npm 安装

本插件已发布到 npm registry：[dsh-turn-fold](https://www.npmjs.com/package/dsh-turn-fold)

```sh
# 官方命令（推荐）
dsh plugin --profile web add dsh-turn-fold

# 或从 GitHub 源码安装
dsh plugin --profile web add github:Winter-And-You-Gone/dsh-turn-fold
```

`dsh plugin` 会将包加入 profile 的 pnpm 依赖并自动追加到组合包层（`dsh.profile.bundles`），无需手动改任何文件。验证方式：

```sh
dsh --profile web --dump-config    # 确认输出中能看到 "dsh-turn-fold" 层
```

然后**完全退出 DSH 进程并重启**。

### 方式二：手工 `install.ps1`

```powershell
# 把插件目录放到你已有的插件目录，然后：
.\install.ps1 -PluginSource "<你的插件目录>"
# 例如：.\install.ps1 -PluginSource "C:\dsh-plugins\dsh-turn-fold"
# 不传参数时默认用脚本自身所在目录作为插件源
```

脚本会：
1. 在 `~/.dsh/profiles/node_modules/dsh-turn-fold` 建 **Junction** 指向插件目录；
2. 在 `~/.dsh/profiles/web/cordis.patch.yml` 追加一行 `- insert:` 注册；
3. 校验 `require.resolve` 可解析。

然后**完全退出 DSH 进程并重启**。

## 卸载

```sh
# 官方方式：同时移除依赖和插件层
dsh plugin --profile web remove dsh-turn-fold
```

手工方式（曾用 `install.ps1` 安装时）：

```powershell
Remove-Item "$env:DSH_HOME\profiles\node_modules\dsh-turn-fold" -Force   # 删 Junction
# 手动删掉 cordis.patch.yml 里对应的 insert 块
```

## CI 与发布

GitHub Actions 会在每次 PR / push 到 `main` 时自动运行语法检查、`verify-fix.mjs` 校验和
`npm pack --dry-run` 打包预检；推送 `v*` tag 时自动发布到 npm（OIDC Trusted Publishing，
无需长期 token）并创建 GitHub Release。

**一次性配置**（把 npm 包绑定到本仓库的 release workflow）：

```sh
npx npm@^11.15.0 trust github dsh-turn-fold \
  --repo Winter-And-You-Gone/dsh-turn-fold \
  --file release.yml \
  --allow-publish
```

也可以改为在 npmjs.com 网站账户设置里配置 Trusted Publishing。

**之后每次发版只需两步**：

```sh
npm version patch    # 或 minor / major：bump 版本并自动打 v* tag
git push --follow-tags
```

> 提示：`npm version` 要求工作区干净，先把待发布的改动提交；tag 名必须与
> `package.json` 的 `version` 一致（workflow 会校验，不一致即失败）。

## 工作原理（为什么不用改源码）

- DSH 会话 UI 是 Cordis 插件 + Slot 插槽系统拼出来的；聊天流每个块经
  `conversation.chat.node`（keyed slot）按类型分发渲染器。
- Slot 注册器官方支持 **不同 priority 覆盖**（`register at a different priority to shadow it, lowest renders`）。
  本插件用 `priority: -1` 覆盖内置的 `tool-call` / `assistant-step` / `context` 渲染器。
- 展开时通过 `ctx.slots.entries('conversation.chat.node')` 取到内置组件引用做**委托渲染**，
  工具卡片/Think 行/上下文注入的内容与样式与内置完全一致。
- 整回合折叠通过会话快照的 `turnEnds`（turn/end 事件驱动）判定回合完成，配合
  `chat.locations.getTurn()` 计算组头/成员/最终消息，再以 CSS `:has()` 隐藏成员 flowItem。

## 注意事项

- DSH 升级若改变上述槽位契约或内置组件 props，本插件可能需要随版本小改（属插件维护，非改源码）。
- 组头文案在 `client.js` 顶部 `CONFIG` 可调。
