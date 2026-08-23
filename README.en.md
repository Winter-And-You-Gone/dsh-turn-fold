# dsh-turn-fold

> [简体中文](README.md)（默认） | **English**

> Tired of dozens of tool calls filling your screen?
> Envious of Codex's auto-collapse next door?
> Then this plugin is made for you.

A **pure plugin** for DeepSeek Harness (DSH) that only handles **collapsing**:
1. **Segment-level auto-collapse**: all tool calls and Think blocks between two text messages are grouped into **one segment-level group header**, **collapsed by default**; while running, the header dynamically shows "Running `ToolName` · description" or "Thinking · content", switching to "Ran N commands" (Think blocks don't count) once the next text message appears.
2. **Live big header**: the big group header appears as soon as the agent's reply starts, with the reply loading line by line below it; the header shows duration / tokens / tok/s / cache-hit rate in real time, separated from the content by a divider line.
3. **Whole-turn collapse**: after a reply finishes, all Think blocks + tool calls + context injections of that turn collapse into **one big group header** (collapsed by default); only the final summary text stays visible.
4. **Manual expand/collapse**: click a group header to toggle.

**Does not modify any `@deepseek-ai/dsh-*` source code.**

## Feature 1: Segment-level auto-collapse

```
text: First, check the repo status.                    ← text appears directly
┌────────────────────────────────────────────────────┐
│ › Running Pwsh · Commit 1: core +tests              │  ← running: shows current tool dynamically
└────────────────────────────────────────────────────┘
text: …                                               ← next text message
┌────────────────────────────────────────────────────┐
│ › Ran 3 commands                            [3]     │  ← segment closed: shows command count
└────────────────────────────────────────────────────┘
```

- **Segment = content between two text messages**: consecutive tool calls and Think blocks mix into one segment (Think no longer breaks the group); text-carrying assistant messages are the segment boundaries, and the text itself is always displayed directly.
- **Always collapsed by default**: segment-level headers are **always collapsed by default** (even while running) — while running, only text messages and segment header rows are visible; tool cards and Think content appear only when clicking the segment header.
- **Dynamic title while running**: before the next text message appears (segment not closed), the header shows the last node in the segment — tool calls show "Running `ToolName` · parameter summary" (e.g. "Running Pwsh · Commit 1: core +tests"), Think blocks show "Thinking · content" (content updates live as streaming progresses).
- **Closed segment title**: once the next text message appears, the header becomes "Ran N commands" (N = tool calls in the segment, Think blocks don't count); a Think-only segment (no tools) shows "Think" when closed.
- **Manual expand/collapse**: click a segment header to toggle; manual choices override the auto rule.
- **Failed commands turn red**: when a command in the group **failed** (tool result `isError`, interrupted counts too), the group header text turns red and the failed count is appended after "Ran N commands", e.g. `Ran 6 commands——2 failed`.

### Screenshots

Before/after collapse (left: all tool calls expanded, listed one by one; right: auto-collapsed into segment-level group headers after the next text message):

<table>
  <tr>
    <td align="center"><b>Before collapse</b></td>
    <td align="center"><b>After collapse</b></td>
  </tr>
  <tr>
    <td align="center"><img src="docs/images/segment-before-collapse.png" alt="Before collapse" width="300"/></td>
    <td align="center"><img src="docs/images/segment-after-collapse.png" alt="After collapse" width="300"/></td>
  </tr>
</table>

## Feature 2: Live big header + collapse the whole turn into one big header

```
[User message]
[▸ 5m12s, 12345 tokens, 34 tok/s, 80% cache hit]   ← big header, appears at reply start
─────────────────────────────────────────────      ← divider line
[Think / tool calls loading one by one…]            ← expanded by default while running
[Final summary body]                                ← no Think lines, only body
[duration · token footer]                           ← official turn-tail
```

- **The big header appears at reply start**: as soon as the first piece of the agent's reply shows up, the big header appears at the top of the turn, expanded by default, with Think blocks / tool calls loading below the divider line — no more waiting until the turn ends to see the metrics;
- **Metrics update in real time**: **the duration seconds tick every second** (timed from the turn's `turn/start`), **"tokens consumed" refreshes at a randomized interval (125–250ms by default) and keeps growing**, tok/s is estimated live from output tokens / elapsed time, and the cache-hit rate is computed live from usage; once the turn ends, everything switches to the official authoritative values (turn-tail tok/s, exact `turn/end` duration);
- **"Tokens consumed" grows with a continuous animation**: real `usage` only arrives when a request completes, so between two arrivals the number would stall — while running, a purely cosmetic animation offset is added on top of the real baseline, advancing per actual tick in an alternating **+1 / +11** loop (ones digit +1 per tick, tens digit +1 every 2 ticks, higher digits follow via carry); each tick interval is `liveTickMs` × a random factor (`liveTickJitter`…1, 125–250ms by default), so the digits jump at an irregular pace, more like a real generation rate than a metronome; when new usage arrives only the baseline snaps to the real value — the offset keeps accumulating, so the number never steps back. The base interval and the jitter are tunable via `CONFIG.liveTickMs` and `CONFIG.liveTickJitter`;
- **Odometer-style digit animation**: while the turn is running, each digit of the changing numbers rolls to its new value independently (odometer/slot-wheel effect with springy easing; the roll duration adapts to change frequency — fast-changing digits like the token ones digit use a short roll slightly shorter than the refresh interval so every tick completes cleanly, slow ones like the duration seconds keep the 350ms springy roll) — every digit is its own 1ch-wide window with a vertical 0-9 strip, like a counting drum; a visually hidden sr-only copy keeps the full label readable for screen readers, and the animation degrades to static digits when the system prefers reduced motion;
- **Divider always below the header**: a 1px horizontal line always sits below the big header text (`.ccg-turn-divider`, colored with the official `--dsw-alias-line-secondary` token, adapting to light/dark themes) — **visible in both collapsed and expanded states**, acting as the visual boundary between the header and the content when expanded;
- After a turn **finishes** (final summary output, turn end), the big header auto-collapses: all Think blocks, tool calls and context injections of that turn
  collapse into **one big group header**, keeping only the final summary message and the official duration/token footer visible (turns the user expanded manually stay expanded);
- **The big header shows this turn's metrics**: `duration (xh xm xs, or just m s under 1 hour, or just s under 1 minute), N tokens, N tok/s, cache hit NN%`; missing items are omitted automatically, and only when all are missing does it fall back to "Ran N commands";
- Click the big header to expand/collapse the whole turn; when reopening a historical session, completed turns stay collapsed as well;
- **The fold never crosses the user message**: the big header only folds content between the user message and the agent's reply.
  Context rows anchored **above** the user message (e.g. approval-policy change notices) are not part of this turn's output
  interval: they stay visible as-is, never participate in the fold, and are never used as the header anchor — so the big
  header can never fold content sitting above the user message;
- **Final summary shows only body**: after the turn ends, Think lines inside the final summary message are hidden too;
- **Status labels**: turns that ended abnormally (user-stopped / interrupted) get a status prefix on the big header,
  e.g. `Stopped | 5m 12s, ...`; normally completed turns show no extra label;
- **Single items are grouped too**: when there is only **1** command (or 1 Think block) between two text messages, a segment-level header is still applied — "Running `ToolName` · …" while running, "Ran 1 command" once text appears; at turn end it is folded into the big header, and the segment header row is visible after expanding the big header.

### Screenshots

After the turn ends, the whole turn collapses into one big header with metrics, keeping only the final summary body:

![Turn-end collapse](docs/images/turn-collapsed.png)

## Component styles & spacing

- **Group header = official style**: the header reuses the official `DisclosureRow` primitive (`@deepseek-ai/dsh-client-ui-primitives`) — 24px row height, 16px leading, official 14px chevron (right when collapsed / down when expanded), 14px/24px title, pixel-identical to the Think / tool-card collapse rows;
- **Big header divider**: a 1px horizontal divider line (`.ccg-turn-divider`, colored with the official `--dsw-alias-line-secondary` token) always renders below the big header text — visible in both collapsed and expanded states, with 4px / 8px spacing above and below;
- **Compact spacing**: a collapsed group takes one row (24px); folded member nodes are `display:none` entirely, leaving no residual blank rows, so spacing matches official messages exactly (column's 16px rhythm) no matter how much is collapsed.
- **Transition animations**: expanding smoothly grows the content from 0 to its measured height (JS-measured, driven by the Web Animations API) with a fade-in and a slight upward shift (280ms); collapsing plays a shrink animation (200ms) before unmounting the content; animations are disabled automatically when the system prefers reduced motion. During a running turn, the content stays in "live mode" (height auto, no clipping of growing streaming content).
- **Odometer digits**: while running, the big header's numbers (duration/tokens/tok/s/cache-hit) are split into 1ch-wide rolling windows per digit, rolling to new values on change (350ms springy easing); after the turn ends the label falls back to plain text.
- **Localization**: UI text follows the browser language — Simplified Chinese or English.
- **Accessibility**: headers expose `aria-label` / `aria-expanded` and are keyboard-operable (Enter / Space to toggle).

## Installation

### Option 1 (recommended): install from npm

This plugin is published on the npm registry: [dsh-turn-fold](https://www.npmjs.com/package/dsh-turn-fold)

```sh
# Official command (recommended)
dsh plugin --profile web add dsh-turn-fold

# Or install from the GitHub source
dsh plugin --profile web add github:Winter-And-You-Gone/dsh-turn-fold
```

`dsh plugin` adds the package to the profile's pnpm dependencies and appends it to the bundle layer
(`dsh.profile.bundles`) automatically — no manual file edits. To verify:

```sh
dsh --profile web --dump-config    # confirm a "dsh-turn-fold" layer appears in the output
```

Then **fully exit the DSH process and restart**.

### Option 2: manual `install.ps1`

```powershell
# Put the plugin directory into your existing plugins directory, then:
.\install.ps1 -PluginSource "<your-plugin-directory>"
# e.g. .\install.ps1 -PluginSource "C:\dsh-plugins\dsh-turn-fold"
# When no argument is given, the script uses its own directory as the plugin source
```

The script will:
1. Create a **Junction** at `~/.dsh/profiles/node_modules/dsh-turn-fold` pointing to the plugin directory;
2. Append a `- insert:` registration line to `~/.dsh/profiles/web/cordis.patch.yml`;
3. Verify `require.resolve` resolves.

Then **fully exit the DSH process and restart**.

## Uninstall

```sh
# Official way: removes both the dependency and the plugin layer
dsh plugin --profile web remove dsh-turn-fold
```

Manual way (when previously installed via `install.ps1`):

```powershell
Remove-Item "$env:DSH_HOME\profiles\node_modules\dsh-turn-fold" -Force   # remove the Junction
# Manually remove the corresponding insert block from cordis.patch.yml
```

## Testing

```sh
npm install        # first time: installs jsdom / react / react-dom (devDependencies)
npm test           # node --test runs the whole suite under tests/
npm run check      # syntax check client.js / index.js
```

The test suite (`tests/`) loads the real `client.js` directly (via `__ModuleLoader__`
injection + `__test` export, no copy-paste drift) and is layered in four parts:

| File | Coverage |
| --- | --- |
| `unit.logic.test.mjs` | Pure functions: `computeGroup` segment grouping, `computeTurnFold` whole-turn fold, `computeTurnMetrics` / `turnHeaderLabel` metrics label, `turnNumber`; includes every historical verify-fix scenario plus real session data (TURN13) |
| `unit.render.test.mjs` | React rendering: initial collapse → click big header to expand → collapse again; `useHostDescription` kit-hook passthrough during builtin delegated rendering; slot registration contract (inject declaration) |
| `unit.css.test.mjs` | CSS `:has()` hiding rules take effect on a real DOM (including the expand → collapse round trip) |
| `regression.test.mjs` | Historical bug regressions: node-object replacement (Bug1), missing inject crash/abdicate (Bug2), no-tool-call turns also fold (v0.2.3), fold scope never crosses the user message (v0.2.2), manual segment expand/collapse |

> In sandboxed environments that cannot spawn child processes (e.g. Windows
> sandbox), `--test-isolation=none` is required (already built into `npm test`);
> it also works on regular Linux/macOS CI (Node ≥ 22.9).

## CI and release

GitHub Actions runs syntax checks, the full `npm test` suite and an
`npm pack --dry-run` preflight for every pull request and every push to `main`.
Pushing a `v*` tag publishes to npm automatically (OIDC Trusted Publishing, no
long-lived token) and creates a GitHub Release.

**One-time setup** (bind the npm package to this repository's release workflow):

```sh
npx npm@^11.15.0 trust github dsh-turn-fold \
  --repo Winter-And-You-Gone/dsh-turn-fold \
  --file release.yml \
  --allow-publish
```

You can also configure Trusted Publishing in your npmjs.com account settings.

**After that, each release is two steps:**

```sh
npm version patch    # or minor / major: bumps the version and tags it v*
git push --follow-tags
```

> Note: `npm version` requires a clean working tree — commit your changes first.
> The tag name must match the `version` field in `package.json` (the workflow
> verifies this and fails otherwise).

## How it works (why no source changes)

- The DSH session UI is assembled from Cordis plugins + a Slot system; each block of the chat stream is dispatched to its renderer by type through `conversation.chat.node` (keyed slot).
- The slot registry officially supports **overriding at different priorities** (`register at a different priority to shadow it, lowest renders`). This plugin uses `priority: -1` to shadow the built-in `tool-call` / `assistant-step` / `context` renderers.
- When expanded, it uses `ctx.slots.entries('conversation.chat.node')` to grab the built-in component references for **delegated rendering**, so tool cards / Think lines / context injections keep exactly the built-in content and styles.
- Whole-turn collapse determines turn completion via the session snapshot's `turnEnds` (driven by turn/end events), uses `chat.locations.getTurn()` to compute the header/members/final message, then hides member flowItems with CSS `:has()`. While a turn is running, `turnTimings` (the `turn/start` event provides `startTime`) marks it as started, so the big header appears immediately: duration ticks in real time via a clock running at a randomized interval (every `CONFIG.liveTickMs` × 0.5–1, 125–250ms by default, `Date.now()`), "tokens consumed" keeps growing through a per-tick +1/+11 alternating animation offset layered on the real value (the baseline snaps to real `usage` when it arrives), and all metrics switch to authoritative values after `turn/end`.

## Notes

- If a DSH upgrade changes the above slot contracts or built-in component props, this plugin may need small adjustments per version (that is plugin maintenance, not source modification).
- The group header text is tunable in `CONFIG` at the top of `client.js`.
