# dsh-turn-fold

> [简体中文](README.md)（默认） | **English**

> DeepSeek Harness (DSH) native folding + poker-card visuals + per-turn performance metrics.

**DSH natively owns all folding semantics** (grouping, membership, disclosure state, paging, search reveal, history state); this plugin is a **pure UI enhancement** on top of the official fold engine:

1. **Enhanced Turn Process Bar**: replaces the official `turn-process` renderer with a richer turn bar — poker leading icon, duration, TTFT, tokens, tok/s, cache-hit rate, right-aligned "Turn N", and status words for abnormal endings (Stopped / Failed / Interrupted). Fold state comes **entirely from the official owner state** (`turnProcess.open / setOpen / foldable / hasContent`); clicking the bar only calls `turnProcess.setOpen()`, and member visibility is handled by the official seat.
2. **Running Turn Bar**: appears the moment the turn starts (the `turn/start` projection) — the official renderer renders nothing at that stage, and this plugin fills the gap: duration starts from 0s and ticks in real time, tokens / tok/s / cache-hit update as real data arrives. It is a **status surface only**: it maintains no fold state and hides no members; when the turn closes it hands over smoothly to the full collapsed turn bar.
3. **Poker Step Skin**: the official step group bar (`ChatGroupSeat` / `ProcessGroupHeader`) works as-is; the plugin adds a **pure-CSS** poker reskin via the official DOM hooks (`data-step-process-icon` / `data-process-activity`), mapping official activity semantics to suits (♥ think/questions · ♠ read/search · ♦ edit/write · ♣ commands/code · 🐋whale orchestration/plan/subagents). Soft dependency: if the hooks go away, the skin disappears and the official icons and folding stay intact.
4. **Real-metrics promise**: every number comes from official real data (`TurnLocation.start/end`, per-step `usage` and `finalNode.timing`, the official aggregated `tokenUsage` on turn-tail). **No fake growth** — the old +1/+11 animation offset is deleted: digits roll only when real data changes, and stay put when it doesn't.
5. **Plugin settings**: turn-bar field visibility (duration/TTFT/tokens/tok/s/cache-hit), leading icon style (poker / native), step skin (poker / native), persisted in `localStorage['dsh-turn-fold:settings']`. **Fully decoupled from the official transcriptView** — the official Compact / Standard / Detailed / Verbose modes keep working; the plugin only enhances their UI.

**Does not modify any `@deepseek-ai/dsh-*` source code.**

## Ownership boundary

| Owner | Scope |
| --- | --- |
| **DSH owns** | grouping · membership · disclosure (when/whether to fold) · paging · search reveal · history state · step group bar and its titles (official semantics like "Reading…", "Read 3 files") |
| **dsh-turn-fold owns** | enhanced turn bar · running turn status · poker visualization · metrics presentation · animations · plugin settings |

## Turn bar forms

```
Running (turn/start → turn/end):
  [flip animation] 0s · Turn 13                            ← appears at 0s, status surface
  ────────────────────────────────────────
  [official process content streams in (official liveProcess semantics, always expanded)]

  [flip animation] 13s · TTFT 0.8s · 3,214 tokens · 247 tok/s   ← updates on real data
  ────────────────────────────────────────

Turn closed (collapsed by default, click to expand):
  [stack/fan] 22m 34s · TTFT 4.9s · 370,202 tokens · 2.4 tok/s · Cache 93.99%   Turn 13
  ────────────────────────────────────────
  [final summary body (official rendering)]

Failed / stopped:
  [stack] Failed · 48s · 7,812 tokens · 28 tok/s           Turn 13
  [stack] Stopped · 21s · 3,201 tokens                     Turn 13
```

- **Metric sources (all official real data)**:
  - Duration: `TurnLocation.start.time → end.time` (live clock fills in while running);
  - TTFT: read from the official `finalNode.timing` (`firstTokenTime - stepStartTime`,
    same semantics as official statistics) once the first request settles;
  - Tokens / cache-hit: the official aggregated `tokenUsage` on turn-tail after the turn
    closes (`deriveTurnTokenUsage` folds every billed attempt, including retried ones;
    cache denominator = prompt-side total); while running or when absent, per-step usage
    accumulation is used (the official step data store is independent of node visibility,
    so hidden tool-only steps are still counted);
  - tok/s: real output tokens / real elapsed time (shown only at ≥1s, avoiding
    start-up spikes).
- **Rolling-digit animation**: while running, each digit rolls to its new value
  (odometer effect with back easing); a full sr-only copy keeps screen readers intact;
  degrades to static digits under "reduce motion".
- **Permanent divider line** below the bar (`--dsw-alias-line-secondary` token chain,
  theme-aware).
- **Accessibility**: `aria-expanded` / `aria-label`, keyboard operable (Enter / Space);
  non-collapsible turns (e.g. official Verbose semantics, aborted/failed turns) render
  as a static bar.
- **All four official transcript modes work**: the turn bar renders under Compact /
  Standard / Detailed / Verbose; `foldable=false` (e.g. Verbose) and paginated history
  (without `turn/start` in the window, where the official control is absent) degrade
  gracefully.

## Poker Step Skin

The official step group bar (official title semantics, official shimmer, official paging
and search reveal) works untouched; the plugin only reskins it:

- A **transparent-bodied** poker card (CSS mask, current-color stroke + suit pip,
  wallpaper shows through) replaces the official activity icon. The card shares **one
  design language** with the Turn-bar poker icon: a 24×24 pseudo-element (= the Turn
  container), a 16-unit mask rendered at 24px (1.5px/unit) → card outer edge ≈9.62×13.05px
  with a 1.05px stroke, pixel-identical on both sides;
- **Completed two-state icon** (fold-state aware): collapsed = a five-suit stack
  (♠ ♥ ♦ ♣ + whale, closed = cards put away), expanded = a five-card fan (open = cards
  looked through) — same plugin face pool as the completed step faces, with the
  geometry taken straight from the Turn bar's stack5/fan5 transform tables
  (`icons/default.json` data source). **Open/close has a morph transition**: pre-sampled
  stack5→fan5 interpolation frames (cubic-bezier(.22,1,.36,1) sampling, 400ms, each
  frame a static SVG) swapped frame-by-frame via CSS keyframes — the animation replays
  from the start on every state change (same-URL mask images share one SMIL timeline
  across the page in Chromium and do not restart on re-apply; the frame sequence
  sidesteps that). Overlaps use **real knockout masking**: each lower card carries an
  inline luminance mask whose occluder is a solid black card face (fill=black) covering
  the whole upper-card footprint — the card body stays transparent (wallpaper/image
  backgrounds show through) while lower strokes and pips never bleed through the upper
  card (occluders must be inlined shapes — Chromium does not render `<use>` references
  inside `<mask>` content). **The official chevron stays hidden under the Poker skin**
  (normal/hover/focus/active all show Poker; official hover tint and focus ring are
  untouched);
- The suit maps from the official `data-process-activity` value (single `ACTIVITY_SUIT`
  source generating the CSS): thinking/questions → ♥, read/readImage/search/webSearch/
  webFetch → ♠, edit/write → ♦, commands/code → ♣, subagents/plan/tools → 🐋whale
  (DeepSeek logo); unregistered activities fall back to ♥ (this mapping now mainly
  serves as the reduced-motion running fallback);
- **Running card flip · vertical diagonal axis** (same look as the Turn bar's running icon):
  a running step (official title shimmer. Soft running-state dependencies — DSH 0.1.7
  renders `data-text-shimmer`, DSH 0.2.0+ renders `data-shimmer`; both are real official
  historical contracts and the plugin supports both) flips the card around its own
  **top-left → bottom-right diagonal**: the four suits cycle as faces (♠ → ♥ → ♦ → ♣) and
  every flip to the back shows the DeepSeek whale. A self-running SVG (SMIL) is used as
  the card's CSS mask, so the stroke color keeps following `currentColor`:
  - **Design source**: the reference `docs/扑克牌轮换_动态蒙版遮挡_文件图标加强版.html`
    **row 5 "牌面翻转 · 竖直对角线轴"** (`renderDiagonalSpinCard()` →
    `svgAxisSpin(16, poker, 0, diagonalRestAngle())`);
  - **Value source**: `icons/default.json` alone (`pokerSpin.*` axis/geometry/keyframes,
    `pokerPips.*` suits, `pokerSpinDeepseek` back) — the same file the Turn bar's
    `buildPokerSpinSVG` reads, so the two axis angles cannot diverge under the shipped
    data source;
  - **Generated** by `node scripts/sync-step-anim.mjs` into the
    `>>> step-running-poker-svg` marker block of `client.js`. The script asserts the
    design source still wires row 5 (call site, conjugate transform, visibility windows,
    timings) **and** that every literal equals the data source (h, pokerRatio, r,
    pipScale, strokeW, the 73-frame scaleKeys/scaleKeyTimes), plus the axis identity
    `restAngle == atan(w/h)` (rounded to 4 decimals) — drift on either side fails the run;
  - **Structure**: the conjugate transform
    `translate(8,8) → scale(cosθ) → rotate(35.5377°) → translate(-8,-8)`. The scale group
    flips once every 1.6s (θ crossing 90°/270° swaps front/back at the zero-width edge),
    and the axis group (`class="tf-step-axis"`) brings the diagonal upright — visually a
    flip around that real diagonal. Four suit windows plus one back window (6.4s each,
    `discrete`) form one cycle: ♠ → back → ♥ → back → ♦ → back → ♣ → back → ♠;
  - **A single card needs no occlusion machinery**: the generated SVG contains no `mask`,
    `mask-type`, or phase groups (row 3's "two overlapping cards + four dynamic knockout
    masks" has no object on a single card);
  - **Recorded boundary**: this SVG is baked into `client.js` at build time; a runtime
    localStorage icon-pack override does not rewrite it (overrides only reach the Turn-bar
    flip and the runtime-generated completed two-state faces) — same nature as the old
    row-3 artifact;
  - The running look is independent of the card count, and when the step settles the
    shimmer disappears → automatic fallback to the completed two-state icon (collapsed
    stack / expanded fan) — pure CSS cascade, zero JS running state; static suit card
    under reduced motion;
  - The axis angle lives **only** in the SVG `transform` attribute: **CSS must never
    restate it** (a CSS transform silently overrides the attribute — the Turn bar hit
    exactly that bug). The step-side class name `tf-step-axis` is deliberately distinct
    from the Turn bar's `ccg-axis-rest-rotation`; guards live in
    `tests/unit.css.test.mjs` ("vertical diagonal axis flip contract");
- **Soft dependency**: every selector is pinned to the official DOM hooks; the gate is
  the skin `<style>` element's `disabled` property (the plugin never writes global
  `document.body` state) — if DSH renames the hooks, the **worst degradation is the skin
  disappearing and the official icon showing as-is**; official folding is unaffected.
  The running-state recognition relies on the official shimmer attributes (either
  one present → Running Step Poker animation; both absent → static Poker fallback;
  even if the visual hooks fail, Step Fold / Tool / Think / Turn Fold and page
  stability are never affected).

## Install

### Option 1 (recommended): install from npm

Published on npm: [@winteries/dsh-turn-fold](https://www.npmjs.com/package/@winteries/dsh-turn-fold)

```sh
# Official command (recommended)
dsh plugin --profile web add @winteries/dsh-turn-fold

# Or install from GitHub source
dsh plugin --profile web add github:Winter-And-You-Gone/dsh-turn-fold
```

`dsh plugin` adds the package to the profile's pnpm dependencies and appends it to the bundle layer (`dsh.profile.bundles`) automatically — no manual file edits. Verify with:

```sh
dsh --profile web --dump-config    # confirm the "@winteries/dsh-turn-fold" layer appears
```

Then **fully quit the DSH process and restart**.

### Option 2: manual `install.ps1`

```powershell
# Put the plugin directory into your existing plugin directory, then:
.\install.ps1 -PluginSource "<your plugin directory>"
# e.g. .\install.ps1 -PluginSource "C:\dsh-plugins\dsh-turn-fold"
# Without arguments the script uses its own directory as the plugin source
```

The script:
1. Creates a **Junction** at `~/.dsh/profiles/node_modules/@winteries/dsh-turn-fold` pointing to the plugin directory;
2. Appends a `- insert:` registration to `~/.dsh/profiles/web/cordis.patch.yml`;
3. Verifies `require.resolve` succeeds.

Then **fully quit the DSH process and restart**.

## Uninstall

```sh
# Official way: removes both the dependency and the plugin layer
dsh plugin --profile web remove @winteries/dsh-turn-fold
```

Manual (if installed via `install.ps1`):

```powershell
Remove-Item "$env:DSH_HOME\profiles\node_modules\@winteries\dsh-turn-fold" -Force   # remove the Junction
# and delete the matching insert block in cordis.patch.yml
```

## Tests

```sh
npm install        # first run: installs jsdom / react / react-dom (devDependencies)
npm test           # node --test over tests/
npm run check      # syntax check client.js / index.js
```

The suite loads the real `client.js` (via `__ModuleLoader__` injection + `__test`
exports — no copy-paste drift):

| File | Coverage |
| --- | --- |
| `unit.logic.test.mjs` | Metric pure functions: `turnClockOf` / `computeTurnMetrics` / `readStepUsage` (official TurnLocation / step usage / turn-tail aggregate), formatting, field visibility + localStorage persistence; identical inputs produce byte-identical outputs (no fake growth) |
| `unit.turn-renderer.test.mjs` | Turn renderer: `open=false → click → setOpen(true)`, `open=true → click → setOpen(false)`; `foldable=false`/aborted/error → static bar with no setOpen path; Running Bar appears at 0s, non-interactive, touches no fold state; smooth handover on turn close; degraded rendering without `turnProcess` |
| `unit.poker.test.mjs` | Activity→suit mapping (full official ProcessActivity vocabulary), stack/fan/flip SVG generation, component rendering, reduced-motion and no-WAAPI static fallback |
| `unit.css.test.mjs` | Step skin gate (`body[data-tf-step-skin]`) + official DOM hook rules; **architecture guard: the old engine's `:has()` hiding rules must be gone** |
| `unit.gear.test.mjs` | Settings popup: field checkboxes, persistence, icon style / step skin selectors (hooks-order guard) |
| `unit.compat.test.mjs` | **Registration audit: only `turn-process` is shadowed**, `exports.inject=['slots']`, priority-conflict yielding, soft degradation of registration errors; **architecture guard: zero old-engine identifiers / official-renderer delegation plumbing / transcriptView writes**; rendering compatibility across the four official transcript modes |
| `regression.test.mjs` | Historical regressions: live-clock orphan timer, **no fake token growth (unchanged data → unchanged digits)**, gear stopPropagation, degradation requirements (corrupt icon pack/settings fall back to defaults) |

> `--test-isolation=none` (built into `npm test`) is required on Windows sandboxes where
> spawning child processes is not allowed; plain Linux/macOS CI can use it too (Node ≥ 22.9).

## Poker leading icon

The turn bar's leading icon defaults to **animated poker cards** (⚙ gear on the bar →
"Turn bar icon" selector in the popup switches back to the official chevron):

- **Completed state**: stack of cards (≤3 tools+subagents → 3 cards, more → 5), fan when expanded;
- **Face pool**: ♠ ♥ ♦ ♣ + DeepSeek whale logo (**choose one of five**), remembered per turn;
- **Running state**: diagonal-axis card flip (four suits cycling, logo on the back), native
  SVG animation that survives re-renders;
- **Occlusion**: luminance mask cuts the overlapped region of lower cards following the
  upper card's transform; card bodies are transparent (correct over wallpapers);
- **Data source**: `icons/default.json` (suit paths, card geometry, stack/fan transforms,
  animation templates) — run `npm run sync:icons` to inject, `npm run icons:check` to verify.

## Custom icons (Agent Skill)

This plugin ships an **agent skill** `dsh-turn-fold-customize-icons` (the host half
`index.js` registers it via `ctx.skills`; active automatically when DSH 0.1.2+ ships
`@deepseek-ai/dsh-skill`). Tell your AI assistant "customize the poker icon", and it
loads the full workflow:

- **Data source**: `icons/default.json` (single source of truth)
- **Sync after edits**: `npm run sync:icons` → `npm run icons:check`
- **Quick preview**: write `localStorage['dsh-turn-fold:icons']` to override without code changes
- **Pitfall guide**: environment-specific SVG rendering quirks

The skill body lives in `assets/dsh-turn-fold-customize-icons.md` and ships with the npm package.

## CI & release

GitHub Actions runs syntax checks, the full `npm test` suite and `npm pack --dry-run` on
every PR / push to `main`; pushing a `v*` tag publishes to npm (OIDC Trusted Publishing)
and creates a GitHub Release.

```sh
npm version patch    # or minor / major: bumps the version and tags v*
git push --follow-tags
```

## How it works (why no source patches are needed)

- The DSH session UI is assembled from Cordis plugins + the slot system; every chat-flow
  block is dispatched through the `conversation.chat.node` keyed slot by node kind, and
  **registering the same key replaces that renderer (lowest renders)**.
- This plugin shadows the official `turn-process` renderer with `priority: -1` — the
  **only** official renderer it replaces. It does not shadow `tool-call` /
  `assistant-step` / `context` / `user`, does not scan official slot entries for
  delegation, and does not copy official inject hooks (official components are always
  rendered by their own official entries).
- **Fold semantics come entirely from the official owner state**: the official
  `ChatNodeSeat` builds `turnProcess = { spec, foldable, hasContent, open, setOpen }`
  for every node and hides/shows members itself (`data-turn-process-hidden`). The plugin
  bar only calls `turnProcess.setOpen(!open)` on click; `canCollapse` mirrors the
  official renderer (`foldable && hasContent`, and never collapsible for open/aborted/
  error turns — the official `turnProcessAlwaysOpen` semantics).
- **Running status bar**: the official `turn-process` node is projected at `turn/start`,
  but the official renderer returns null until the turn closes — the plugin renderer
  shows the Running Turn Bar in that phase (0s start, real metrics, no folding
  behavior). When the turn closes, the same renderer switches to the full bar.
- **Metrics read surface (read-only official data, no membership recomputation)**:
  `node.location.turn` (`TurnLocation`: start/end/status/reason/steps) + turn data store
  (`get('turn-tail')` official aggregate `tokenUsage`, `get('turn-process')` official
  spec) + per-step `data.get('assistant-step')` (usage / `finalNode.timing`). The
  snapshot is subscribed via `useChat` (a merged `SessionStandardProps` member) to drive
  re-renders; the step data store is independent of node visibility, so hidden
  tool-only steps are not missed.
- **Poker step skin (pure CSS)**: official `ChatGroupSeat` / `ProcessGroupHeader` render
  the step groups and titles as-is; the plugin CSS hides the official icon content
  inside `data-step-process-icon` and renders a poker card via `::before` + CSS mask,
  with the suit derived from `data-process-activity` through `ACTIVITY_SUIT` (JS mapping
  → CSS rules generated from the same source). Gate: `<body data-tf-step-skin="poker">`.
  **No MutationObserver, no React root appended to the official header, no plugin-owned
  step open state.**
- **Conflict-yielding registration**: before registering, the plugin probes whether
  `priority: -1` for the same key is taken (`ctx.slots.entries`) and yields to the next
  free value (official `0` is always reserved) with a `console.warn`.
- **Soft degradation on registration errors (never breaks DSH boot)**: all slot
  registrations go through one pipeline that catches both inject-declaration waits and
  register errors; a single failed entry only skips itself, logs a `console.warn` and
  shows one neutral degradation Toast. The host-half skill registration is equally
  double-guarded.
- **Settings are fully independent**: the plugin never reads — let alone writes — the
  official `transcriptView` field (locked by a source-level architecture-guard test).
  Plugin settings live in `localStorage['dsh-turn-fold:settings']` (field visibility,
  icon style, step skin); icon packs still use `localStorage['dsh-turn-fold:icons']`.
- **Locale follows the UI**: copy reads `document.documentElement.lang` (set by
  `dsh-client-locale` when DSH switches language), falling back to browser languages.

## Notes

- Compatibility target: the **DSH 0.1.7-rc.1 / rc.2 `conversation.chat.node` +
  `turn-process` owner-state contract**. The full contract surface exists from
  0.1.7-rc.1 onward (`TurnProcessOwnerProps`, the reactive `useTurnData` hook,
  `ChatNodeStore.turnDataSource` — verified against the rc.1 sources); rc.1 is the
  live-host-verified floor and rc.2 was re-verified by per-package contract diff.
  **Older versions are no longer declared compatible** — a dormant install does not
  count as compatibility; compatibility means the plugin's core features really work.
  If a DSH upgrade changes the contract above, this plugin may need a matching
  maintenance release (plugin maintenance, never source patches).
- **Declared host requirement**: `engines.dsh` = `>=0.1.7-rc.1 <=0.2.0-rc.2` in
  `package.json`. The plugin marketplace (dshmarket) reads this field from the npm
  `latest` manifest to show the badge and to block updates that certainly cannot
  satisfy it (the DSH host itself does not read it). The range is **closed** and locked
  to verified host versions: after each DSH upgrade, re-verify the contract before
  raising the ceiling in a release.
- **Integration dependency list** (check against DSH upgrades; audited via a
  contract-by-contract diff of 0.1.7-rc.2 `787b746b80` ↔ 0.2.0-rc.2 `c1b47e41fc`:
  the Public/stable contracts are byte-identical across both releases):
  - **Cordis activation**: `exports.inject = ["slots"]` + `ctx.inject(["slots"], …)`
    (the client slots service and keyed-slot registration semantics; the official
    `boot-client` is unchanged);
  - **Public/stable**: the `conversation.chat.node` keyed slot (`turn-process` key +
    `TurnProcessOwnerProps` owner state); `TurnLocation` (start/end/status/steps), the
    step data store (`assistant-step` usage/timing) and the turn data store
    (`turn-tail` / `turn-process`) — all from the official `dsh-client-ui-chat` /
    `dsh-client-ui-conversation` contracts;
  - **Soft visual dependency**: `data-step-process-icon` / `data-process-activity`
    (step skin only; failure = skin disappears, official icons and folding stay intact);
  - **Soft visual dependency (running state, dual contract)**: the official
    `TextShimmer`-rendered shimmer attribute (carried by the `ChatGroupSeat` title while
    `!data.closed`). The attribute name evolved across official versions — both are real
    official historical contracts (source evidence):
    - DSH 0.1.7 (release commit `787b746b807df83776957875683b8853c862ca2c`,
      `TextShimmer.tsx`: `data-text-shimmer={active || undefined}`) →
      `data-text-shimmer="true"`;
    - DSH 0.2.0+ (master, `TextShimmer.tsx`: `data-shimmer={active || undefined}`) →
      `data-shimmer="true"`.
    The plugin supports both: either one present → Running Step Poker animation
    (`:has()` matching swaps the card mask to the **vertical-diagonal-axis flip SVG** —
    suits ♠ → ♥ → ♦ → ♣ as faces plus the DeepSeek whale as the fixed back, one flip every
    1.6s, a 6.4s cycle, no occlusion machinery on a single card); both absent →
    completed two-state fallback (collapsed five-suit stack / expanded fan).
    **Used only to identify running steps for the poker flip animation**; when the
    official turn/step closes the attribute disappears, the animation rule stops
    matching, and the card settles with zero JS. Whether or not the visual hooks
    fail, Step Fold / Tool / Think / Turn Fold and page stability are never affected;
  - **Soft style injection (non-ideal, recorded as-is)**: the plugin injects two minimal
    `<style>` elements into `document.head` (base styles + the step skin). As of the
    current DSH master (21638c5631) there is no style-registration API for plain-JS
    client plugins (the only `createElement('style')` in the tree belongs to the web app
    itself), while the step skin must target the official DOM inside the official header
    and cannot live in the plugin's React subtree. Worst-case failure = missing turn-bar
    styling and no step skin; official folding is unaffected. The plugin will migrate
    once an official style extension point exists.
- Behavior changes compared to the previous generation (≤0.5.x):
  - Step grouping/titles are fully returned to the official engine — the plugin-made
    "Ran N commands / Read … / Thought N times" segment titles, in-title file-link
    copying, `[ +N -M ]` line stats and the title cache are deleted (official title
    semantics apply);
  - The "pending/folded N steps" field is deleted (membership is official; the plugin no
    longer counts steps);
  - **Fake token growth is deleted** — digits hold the real value between usage arrivals
    (no more +1/+11);
  - **Zero runtime dependency on host client packages** — chevron / notifications are
    plugin-owned (official practices: do not require Harness Client packages at
    runtime); the settings panel renders inside the opening turn bar's own React tree
    (no body portal / standalone root); metrics subscribe via the official smallest
    slices (`useTurnData('turn-tail')` + `turnDataSource(turn, 'assistant-step')`)
    instead of the whole snapshot;
  - The "Turn-Fold" transcript mode and the shadowed official settings row are deleted —
    the four official modes keep working and plugin settings are pure UI enhancements;
  - The 0s placeholder moved from "right below the user message" onto the official
    `turn-process` node: it appears when the turn starts (the `turn/start` projection);
    the sub-second window between sending and `turn/start` is covered by the official
    "Deep diving..." status line;
  - Running TTFT appears only after the first request settles (official timing; the
    render-time approximation is deleted).
