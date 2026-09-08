# Customize dsh-turn-fold Icons

The plugin's fold-bar icons are **poker cards** (default style) or the **official chevron** (`default` style, picked in the gear popup). Poker icon data is externalized; edit the data source, not hard-coded strings.

## Icon data source & pipeline

```
dsh-turn-fold/
├── icons/default.json        ← 唯一数据源（meta / pokerR / pokerPips / pokerSVGBase /
│                                pokerTransforms / pokerSpin / pokerAnimSVG / pokerSpinDeepseek）
├── scripts/sync-icons.mjs    ← --inject 注入到 client.js；无参运行 = 校验一致性
└── client.js                 ← 内联 `/*__ICON_DEFAULTS__*/` 块承载注入的默认值
```

- **改图标**：编辑 `icons/default.json`，然后 `npm run sync:icons`（把内容注入 client.js 的 `ICON_DEFAULTS` 内联块）。
- **校验**：`npm run icons:check`（比较 default.json 与 client.js 内联块是否逐字节一致）。
- **运行时回退**：`loadIconConfig()` 优先读 `localStorage['dsh-turn-fold:icons']`（校验 `meta.compat`），缺失/损坏/不兼容时回退 `ICON_DEFAULTS`。

## Two customization paths

### Path A — edit the data source (recommended, versioned)
1. Edit `icons/default.json`.
2. Run `npm run sync:icons` to inject, then `npm run icons:check` to confirm.
3. Restart DSH Desktop (or refresh the web GUI) so the bundle reloads `client.js`.
Remind the user: desktop loads a snapshot bundle at startup — **a restart is required** or the fold bars appear "gone" with no code error.

### Path B — runtime localStorage override (no code change, session-local)
Write a complete icon package (same shape as `icons/default.json`, including `meta.compat`) to `localStorage['dsh-turn-fold:icons']`. It wins over the built-in defaults until removed. To reset: `localStorage.removeItem('dsh-turn-fold:icons')`.

## Icon package structure (icons/default.json)

```jsonc
{
  "meta": { "version": 1, "compat": ">=0.3.1" },
  "pokerR": 1.08,                     // card corner radius
  "pokerPips": {                      // suit path data (24-unit space, fill currentColor)
    "spade":   { "path": "<path d=.../>", "cx": 12, "cy": 12, "factor": 1 },
    "heart":   { ... }, "diamond": { ... }, "club": { ... }
  },
  "pokerSVGBase":    { ... },          // card face base
  "pokerTransforms": { ... },          // stack/fan geometry
  "pokerSpin":       { ... },          // flip animation
  "pokerAnimSVG":    "...",            // running 5-face rotation animation (largest block)
  "pokerSpinDeepseek":"..."            // DeepSeek face
}
```

## The official default chevron is NOT in the JSON

`default` style uses the **official ui-primitives icons** (`IconChevronRightOutline14` / `IconChevronDownOutline14` via `DisclosureRow`), with a small inline `DefaultChevronIcon` fallback. It follows the DSH theme and is not part of `icons/default.json` — do not try to relocate it.

## Critical SVG pitfalls (this user's browser / DSH environment)

Recorded in `MEMORY.md`; respect them or icons render transparent/blank:
- **`fill="var(--xxx)"` as an SVG presentation attribute does NOT work** → transparent cards. Use CSS classes or literal values.
- **CSS cannot override an explicit `fill` on `<defs>` content referenced by `<use>`** → never write `fill` in defs; inherit from the `<use>` element and control via CSS.
- **`clip-rule="evenodd"` clip-path does not work** → drop clip-path entirely.
- **CSS `transform-origin` on SVG `<g>` is unreliable** → use `translate(cx,cy) → animateTransform scale → translate(-cx,-cy)` or `animateTransform additive="sum"`.
- **`display:none` / wrong attribute-selector level hides whole blocks** → prefer `visibility:hidden`; put `[data-top]` on the correct `<g>` level.
- Masks: use `mask-type:luminance` (white=visible, black=hidden); black occluder must be larger than the card (e.g. 8.72 vs 8, rx 1.86 vs 1.5) so stroke is fully knocked out; suffix mask ids/urls uniquely per instance.

## Workflow

1. Ask the user what to change: card look, suit design, geometry (corner radius / fan angle / stack offset), running animation, or switching to the official chevron.
2. Prefer **Path A** (versioned, reproducible). If the user only wants a quick local preview, offer **Path B**.
3. After edits, always: `npm run sync:icons`, `npm run icons:check`, `node --check client.js`, and `npm test` (the suite asserts icon-related rendering).
4. Remind the user to **restart DSH Desktop / refresh the web GUI** before judging the result.
