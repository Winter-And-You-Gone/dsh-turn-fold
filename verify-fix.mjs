// dsh-turn-fold fix verification: headerKey selection for turn-fold.
// Reconstructs turn-1 / turn-3 node flows from a real session log
// (e.g. <DSH_HOME>\sessions\<session-id>\session.jsonl.zstd)
// and compares OLD (pre-fix) vs NEW (post-fix) computeTurnFold headerKey.

// ---- node factory (mirrors chatNode in dsh-client-ui-conversation) ----
function node(key, kind, anchorSeq) {
  return { key, kind, anchorSeq };
}

// ---- reconstructed flows ----
// turn 1 (new session): context injection anchored BEFORE the user message.
const turn1 = {
  turn: 1,
  keys: [
    "ctx-approval",   // context  (seq 15, source plugin: approval policy note)
    "user-main",      // user     (seq 16, "分析一下当前插件")
    "as-step1",       // assistant-step (seq 130, think)
    "tool-1",         // tool-call      (seq 131)
    "ctx-skills",     // context  (seq 135, system-reminder skills)
    "as-step2",       // assistant-step (seq 383)
    "as-step3",       // assistant-step (seq 457)
    "as-step4",       // assistant-step (seq 2580)
    "as-final",       // assistant-step (seq 4444, final summary)
    "turn-tail"       // turn-tail      (seq 4445)
  ],
  nodes: new Map([
    ["ctx-approval", node("ctx-approval", "context", 15)],
    ["user-main", node("user-main", "user", 16)],
    ["as-step1", node("as-step1", "assistant-step", 130)],
    ["tool-1", node("tool-1", "tool-call", 131)],
    ["ctx-skills", node("ctx-skills", "context", 135)],
    ["as-step2", node("as-step2", "assistant-step", 383)],
    ["as-step3", node("as-step3", "assistant-step", 457)],
    ["as-step4", node("as-step4", "assistant-step", 2580)],
    ["as-final", node("as-final", "assistant-step", 4444)],
    ["turn-tail", node("turn-tail", "turn-tail", 4445)]
  ])
};

// turn 3: context injection AFTER the user message (should stay unchanged).
const turn3 = {
  turn: 3,
  keys: [
    "user-cont",      // user     (seq 4458, "继续")
    "ctx-vision",     // context  (seq 4460, vision-opencode notice)
    "as-t3s1",        // assistant-step
    "tool-3-1",       // tool-call
    "as-t3-final"     // assistant-step (final)
  ],
  nodes: new Map([
    ["user-cont", node("user-cont", "user", 4458)],
    ["ctx-vision", node("ctx-vision", "context", 4460)],
    ["as-t3s1", node("as-t3s1", "assistant-step", 4461)],
    ["tool-3-1", node("tool-3-1", "tool-call", 4465)],
    ["as-t3-final", node("as-t3-final", "assistant-step", 14497)]
  ])
};

// turn with NO user node (agent-initiated): must fall back to first intermediate.
const turnNoUser = {
  turn: 9,
  keys: ["ctx-a", "as-1", "tool-a", "as-final"],
  nodes: new Map([
    ["ctx-a", node("ctx-a", "context", 100)],
    ["as-1", node("as-1", "assistant-step", 101)],
    ["tool-a", node("tool-a", "tool-call", 102)],
    ["as-final", node("as-final", "assistant-step", 103)]
  ])
};

// turn with context injected BETWEEN two user messages: header must be after LAST user.
const turnTwoUsers = {
  turn: 10,
  keys: ["user-a", "ctx-mid", "user-b", "as-1", "tool-a", "as-final"],
  nodes: new Map([
    ["user-a", node("user-a", "user", 200)],
    ["ctx-mid", node("ctx-mid", "context", 201)],
    ["user-b", node("user-b", "user", 202)],
    ["as-1", node("as-1", "assistant-step", 203)],
    ["tool-a", node("tool-a", "tool-call", 204)],
    ["as-final", node("as-final", "assistant-step", 205)]
  ])
};

// ---- OLD (pre-fix) headerKey selection, copied verbatim from v0.2.2 ----
function headerKeyOld(keys, nodes) {
  let finalAssistantKey = null;
  for (const key of keys) {
    const n = nodes.get(key);
    if (!n) continue;
    if (n.kind === "assistant-step") finalAssistantKey = key;
  }
  let headerKey = null;
  for (const key of keys) {
    if (key === finalAssistantKey) continue;
    const n = nodes.get(key);
    if (n && (n.kind === "tool-call" || n.kind === "assistant-step" || n.kind === "context")) { headerKey = key; break; }
  }
  return headerKey;
}

// ---- NEW (post-fix) headerKey selection, copied verbatim from client.js ----
function headerKeyNew(keys, nodes) {
  let finalAssistantKey = null;
  for (const key of keys) {
    const n = nodes.get(key);
    if (!n) continue;
    if (n.kind === "assistant-step") finalAssistantKey = key;
  }
  let lastUserSeq = -1;
  for (const key of keys) {
    const un = nodes.get(key);
    if (un && un.kind === "user" && typeof un.anchorSeq === "number" && un.anchorSeq > lastUserSeq) lastUserSeq = un.anchorSeq;
  }
  let headerKey = null;
  for (const key of keys) {
    if (key === finalAssistantKey) continue;
    const node = nodes.get(key);
    if (!node || !(node.kind === "tool-call" || node.kind === "assistant-step" || node.kind === "context")) continue;
    if (node.kind === "context" && lastUserSeq >= 0 && typeof node.anchorSeq === "number" && node.anchorSeq <= lastUserSeq) continue;
    headerKey = key;
    break;
  }
  return headerKey;
}

function userSeqOf(keys, nodes) {
  let last = -1;
  for (const key of keys) { const n = nodes.get(key); if (n && n.kind === "user" && n.anchorSeq > last) last = n.anchorSeq; }
  return last;
}

let failures = 0;
function check(name, keys, nodes, expectedOld, expectedNew) {
  const oldH = headerKeyOld(keys, nodes);
  const newH = headerKeyNew(keys, nodes);
  const oldOk = oldH === expectedOld;
  const newOk = newH === expectedNew;
  if (!oldOk || !newOk) failures++;
  console.log(
    `[${name}]\n  old headerKey = ${oldH}${oldOk ? "" : `  <-- EXPECTED ${expectedOld}`}\n` +
    `  new headerKey = ${newH}${newOk ? "" : `  <-- EXPECTED ${expectedNew}`}\n` +
    `  lastUserSeq   = ${userSeqOf(keys, nodes)}`
  );
}

check("turn1 (new session, ctx before user)", turn1.keys, turn1.nodes, "ctx-approval", "as-step1");
check("turn3 (ctx after user, unchanged)", turn3.keys, turn3.nodes, "ctx-vision", "ctx-vision");
check("no-user turn (fallback)", turnNoUser.keys, turnNoUser.nodes, "ctx-a", "ctx-a");
check("two users + mid ctx", turnTwoUsers.keys, turnTwoUsers.nodes, "ctx-mid", "as-1");

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
