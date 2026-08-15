# dsh-turn-fold

> [简体中文](README.md)（默认） | **English**

A **pure plugin** for DeepSeek Harness (DSH) that only handles **collapsing**:
1. **Segment-level auto-collapse**: tool calls are grouped by Think; once the next Think appears, the group automatically collapses into a segment-level group header (Think blocks keep their built-in defaults and only act as group boundaries).
2. **Whole-turn collapse**: after a reply finishes, all Think blocks + tool calls + context injections of that turn collapse into **one big group header**, which shows the turn's duration / tokens / tok/s / cache-hit rate; only the final summary text stays visible.
3. **Manual expand/collapse**: click a group header to toggle.

**Does not modify any `@deepseek-ai/dsh-*` source code.**

## Feature 1: Segment-level auto-collapse

```
Think: ……（keeps built-in default: collapsed, click to expand）
┌───────────────────────────────────────┐
│ › Ran 3 commands              [3]     │  ← auto-collapses after the next Think
└───────────────────────────────────────┘
Think: ……（keeps built-in default）
┌───────────────────────────────────────┐
│ › Ran 2 commands              [2]     │
└───────────────────────────────────────┘
```

- **Think keeps built-in default**: collapsed, click to expand; the plugin makes no changes to it (only uses it as a group boundary).
- **Auto-collapse timing**: when the **next Think** after a group of tool calls appears, that group auto-collapses.
- **Stays expanded during the turn**: until the next Think appears, the current group of tool calls stays expanded so you can watch execution live.
- **Manual expand/collapse**: click a group header to toggle; manual choices override the auto rule.

## Feature 2: Collapse the whole turn into one big header

```
[User message]
[▸ 5m12s, 12345 tokens, 34 tok/s, 80% cache hit]   ← one big group header
[Final summary body]                                ← no Think lines, only body
[duration · token footer]                           ← official turn-tail
```

- After a turn **finishes** (final summary output, turn end), all Think blocks, tool calls and context injections of that turn
  auto-collapse into **one big group header**, keeping only the final summary message and the official duration/token footer visible;
- **The big header shows this turn's metrics**: `duration (xh xm xs, or just m s under 1 hour, or just s under 1 minute), N tokens, N tok/s, cache hit NN%`; missing items are omitted automatically, and only when all are missing does it fall back to "Ran N commands";
- Click the big header to expand/collapse the whole turn; when reopening a historical session, completed turns stay collapsed as well;
- **Final summary shows only body**: after the turn ends, Think lines inside the final summary message are hidden too;
- **Single items are not grouped**: when there is only **1** command between two Think blocks, no segment-level header is applied and the command card is always rendered as-is; at turn end it is folded into the big header, and returns to normal once expanded.

## Component styles & spacing

- **Group header = official style**: the header reuses the official `DisclosureRow` primitive (`@deepseek-ai/dsh-client-ui-primitives`) — 24px row height, 16px leading, official 14px chevron (right when collapsed / down when expanded), 14px/24px title, pixel-identical to the Think / tool-card collapse rows;
- **Compact spacing**: a collapsed group takes one row (24px); folded member nodes are `display:none` entirely, leaving no residual blank rows, so spacing matches official messages exactly (column's 16px rhythm) no matter how much is collapsed.

## Installation

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

```powershell
Remove-Item "$env:DSH_HOME\profiles\node_modules\dsh-turn-fold" -Force   # remove the Junction
# Manually remove the corresponding insert block from cordis.patch.yml
```

## How it works (why no source changes)

- The DSH session UI is assembled from Cordis plugins + a Slot system; each block of the chat stream is dispatched to its renderer by type through `conversation.chat.node` (keyed slot).
- The slot registry officially supports **overriding at different priorities** (`register at a different priority to shadow it, lowest renders`). This plugin uses `priority: -1` to shadow the built-in `tool-call` / `assistant-step` / `context` renderers.
- When expanded, it uses `ctx.slots.entries('conversation.chat.node')` to grab the built-in component references for **delegated rendering**, so tool cards / Think lines / context injections keep exactly the built-in content and styles.
- Whole-turn collapse determines turn completion via the session snapshot's `turnEnds` (driven by turn/end events), uses `chat.locations.getTurn()` to compute the header/members/final message, then hides member flowItems with CSS `:has()`.

## Notes

- If a DSH upgrade changes the above slot contracts or built-in component props, this plugin may need small adjustments per version (that is plugin maintenance, not source modification).
- The group header text is tunable in `CONFIG` at the top of `client.js`.
