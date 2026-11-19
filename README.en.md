# dsh-turn-fold

> [简体中文](README.md)（默认） | **English**

> DeepSeek Harness (DSH) native folding + poker-card visuals + per-turn performance metrics.

A **pure UI enhancement** on top of DSH's official fold engine. It **does not modify any
`@deepseek-ai/dsh-*` source code**.

## Features

- **Enhanced turn bar**: poker leading icon, duration, TTFT, tokens, tok/s, cache-hit rate,
  right-aligned "Turn N", and status words for abnormal endings (Stopped / Failed /
  Interrupted). Fold state comes **entirely from the official owner state** (`turnProcess`:
  `open / setOpen / foldable / hasContent`); clicking only calls `turnProcess.setOpen()`,
  and member visibility is handled by the official seat.
- **Running turn bar**: appears at `turn/start`, counts duration from 0s, and updates
  tokens / tok/s / cache-hit as real data arrives. A status surface only — it keeps no
  fold state.
- **Poker step skin**: the official step group bar works as-is; a pure-CSS reskin runs on
  the official DOM hooks (`data-step-process-icon` / `data-process-activity`). Suits map
  from activity semantics: ♥ think/questions · ♠ read/search · ♦ edit/write · ♣ commands/code
  · 🐋 orchestration/plan/subagents. If the hooks disappear, the skin disappears and the
  official icons and folding stay intact.
- **Real metrics**: every statistic comes from official data (`TurnLocation`, per-step
  `usage`, `finalNode.timing`, the aggregated `tokenUsage` on turn-tail). The running token
  also shows a **presentation-only visual counter** that affects display only: it takes part
  in no statistic (tok/s, cache, TTFT, durable projection) and is never persisted.
- **Plugin settings**: turn-bar field visibility plus **one unified fold-icon mode**
  `iconStyle` (animated poker / official icons; one setting drives both Turn and Step),
  stored in `localStorage['dsh-turn-fold:settings']`. Fully decoupled from the official
  `transcriptView` — Compact / Standard / Detailed / Verbose all keep working.

## Ownership boundary

| Owner | Scope |
| --- | --- |
| **DSH owns** | grouping · membership · disclosure (when/whether to fold) · paging · search reveal · history state · step group bar and its titles (official semantics like "Reading…", "Read 3 files") |
| **dsh-turn-fold owns** | enhanced turn bar · running turn status · poker visualization · metrics presentation · animations · plugin settings |

## Turn bar forms

```
Running (turn/start → turn/end):
  [flip animation] 0s · TTFT — · — tokens · — tok/s · Cache —   ← every slot present from 0s
  ────────────────────────────────────────
  [official process content streams in (official liveProcess semantics, always expanded)]

  [flip animation] 13s · TTFT 0.8s · 3,214 tokens · 247 tok/s · Cache —
  ────────────────────────────────────────        ← arriving real data only replaces the —

Turn closed (collapsed by default, click to expand):
  [stack/fan] 22m 34s · TTFT 4.9s · 370,202 tokens · 2.4 tok/s · Cache 93.99%   Turn 13
  ────────────────────────────────────────
  [final summary body (official rendering)]

Failed / stopped:
  [stack] Failed · 48s · TTFT — · 7,812 tokens · 28 tok/s · Cache —   Turn 13
```

- **Field slots always exist**: enabled fields occupy their slots from 0s (showing `—`
  without data), and arriving real data only replaces the `—`; disabled fields disappear
  entirely. Statistics are never fabricated (no estimation, no data = `—`). Screen-reader
  text is always the official real value.
- **Metric sources**: duration from `TurnLocation.start/end`; TTFT and tok/s are
  **durable first** (the plugin's own `turnFoldMetrics` projection, still present after a
  reload or in historical sessions), then client-side `finalNode.timing` and the step
  aggregate; tok/s is **decode-speed**, the same definition as the official StatsPills.
  Full semantics, visual-counter cadence and fallbacks: [docs/INTERNALS.en.md](docs/INTERNALS.en.md).
- **Accessibility**: `aria-expanded` / `aria-label`, operable with Enter / Space;
  non-collapsible turns (Verbose, aborted/failed) render as a static bar.
- **All four official transcript modes work**: Compact / Standard / Detailed / Verbose.

## Poker step skin

- A **transparent-bodied** poker card (CSS mask, current-color stroke + suit pip, wallpaper
  showing through) replaces the official activity icon, sharing one 24×24 canvas and
  geometry with the Turn-bar icon.
- **Completed two-state**: collapsed = a suit-card stack, expanded = a fan; card count
  follows the group's tool-call count (≤3 → 3 cards, ≥4 → 5 cards), with a morph transition
  and real knockout masking.
- **Running state**: five equal faces (♠ ♥ ♦ ♣ + the DeepSeek whale) rotate; **upright while
  collapsed, flat-rotated 35.5° only when expanded** (driven by the official
  `aria-expanded`, pure CSS). Deliberately different from the Turn bar's vertical-diagonal
  axis flip.
- **Step file list**: the group header's tail shows the files this step touched (basenames,
  de-duplicated, at most 3, the rest folded into ` +N`); read-only official data through
  CSS `::after`, with no official DOM writes.

Reskin details, face allocation, icon data source and recorded boundaries:
[docs/POKER-SKIN.en.md](docs/POKER-SKIN.en.md).

## Install

### Option 1 (recommended): install from npm

Published on npm: [@winteries/dsh-turn-fold](https://www.npmjs.com/package/@winteries/dsh-turn-fold)

```sh
# Official command (recommended)
dsh plugin --profile web add @winteries/dsh-turn-fold

# Or install from GitHub source
dsh plugin --profile web add github:Winter-And-You-Gone/dsh-turn-fold
```

`dsh plugin` adds the package to the profile's pnpm dependencies and appends it to the
bundle layer (`dsh.profile.bundles`) automatically — no manual file edits. Verify with:

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

The script creates a Junction, appends a `- insert:` registration to
`~/.dsh/profiles/web/cordis.patch.yml`, and verifies `require.resolve`. Then **fully quit
the DSH process and restart**.

## Uninstall

```sh
# Official way: removes both the dependency and the plugin layer
dsh plugin --profile web remove @winteries/dsh-turn-fold
```

Manual (if installed via `install.ps1`): remove the
`~/.dsh/profiles/node_modules/@winteries/dsh-turn-fold` Junction and delete the matching
`insert` block in `cordis.patch.yml`.

## Settings

Open the settings with the ⚙ gear on the right of the turn bar:

- **Turn-bar fields**: duration / TTFT / tokens / tok/s / cache hit, each toggled separately.
- **Fold icons**: one unified selector drives both the Turn leading icon and the Step skin.
  - **Animated poker (poker, default)**: Turn completed = stack/fan, running = flip
    animation; Step completed = stack/fan, running = five-face rotation · flat-rotated
    35.5° when expanded.
  - **Official icons (native)**: Turn keeps the whole enhanced bar and only swaps the
    leading icon for an official-style chevron; Step fully restores the official
    `ProcessGroupHeader` icons and interactions.
- **Migration**: the old `foldIcon` / `stepSkin` fields migrate to `iconStyle` when read;
  the next save writes only the new field.
- Switching needs no page refresh (`applyIconStyle()` flips the `disabled` gate on the two
  skin stylesheets synchronously).

## Compatibility

`engines.dsh` = `>=0.1.7-rc.1` (**floor only, no ceiling**). Since DSH 0.2.1 the host
enforces this field; a floor-only range satisfies every future version, and incompatibility
on unverified versions is absorbed by crash isolation (failed probes → zero registration; a
crashed renderer → official SlotErrorBoundary placeholder; failed activation → app-boot
per-entry containment).

| DSH version | Evidence level |
| --- | --- |
| 0.1.7-rc.1 · 0.1.7-rc.2 · 0.2.0-rc.2 | **LIVE-HOST VERIFIED** |
| 0.2.1-rc.2 · 0.2.2-rc.1 | **CONTRACT-VERIFIED + LOAD/APPLY VERIFIED** |
| 0.2.1-rc.3 · 0.2.2-rc.2 · 0.2.2-rc.3 | **CONTRACT-VERIFIED** |

Capability probing, the Legacy layer, the per-version matrix and the live-host acceptance
records are documented in Chinese only: [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md).

## Custom icons

The plugin ships an agent skill `dsh-turn-fold-customize-icons`. Tell your AI assistant
"customize the poker icon" and it loads the full workflow:

- Data source: `icons/default.json` (single source of truth)
- Sync after edits: `npm run sync:icons` → `npm run icons:check`
- Quick preview: write `localStorage['dsh-turn-fold:icons']` to override without code changes
- Pitfall guide: SVG rendering quirks and what an icon pack does (and does not) reach

The skill body lives in `assets/dsh-turn-fold-customize-icons.md` and ships with the npm
package.

## Tests

```sh
npm install        # first run: installs jsdom / react / react-dom (devDependencies)
npm test           # node --test over tests/
npm run check      # syntax check client.js / index.js
```

The suite loads the real `client.js` (via `__ModuleLoader__` injection + `__test` exports —
no copy-paste drift). Test-suite index, CI and release flow:
[docs/DEVELOPMENT.en.md](docs/DEVELOPMENT.en.md).

## Known issue

The running turn bar is about 37px taller than the official row and sits at the top of the
turn, above the reading anchor; it participates in the observed "follow release" chain.
The **root cause is not yet pinned down**. Per the user's rule the plugin adds no
compensation or patch (no scroll writes, no official follow-state reads, no DOM
observation), and guard tests pin "zero scroll writes". Symptoms, evidence and the leading
lead: [docs/INTERNALS.en.md](docs/INTERNALS.en.md).

## License

[MIT](LICENSE)
