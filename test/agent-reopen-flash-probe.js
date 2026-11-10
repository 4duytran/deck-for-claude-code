// Reproduction + fix probe (plan decision D-RF, lot reopen-flash) — a pane opened on a session whose resumed
// run died with the old CLI flashed « running » (~2 s) before the lifecycle said « closed » (user D-U2).
//
// The ordering, MEASURED (INFO lines of this probe): the renderer's openPane calls setChatView(paneId, true) BEFORE
// window.api.openTerminal, so `transcript-subscribe` reaches main ahead of `pty-open`; the subscription's first
// agentStateSync runs while ptys has no entry for the pane. sessionLivenessSince then answers {live: true,
// sinceMs: null} (fresh `working` status file, no pane): no spawn time to compare the run against, so the dead run
// reads « running ». The pty entry (spawnedAt) lands a few ms later; the 2 s tick recomputes and pushes « closed ».
//
// Fixture (all records written BEFORE the pane opens; chat-bg-agent-resume's P scenario): a prompt, an Agent
// background dispatch + launch ACK, its task-notification, a user message, a SendMessage + the measured resume
// result (resumedAgentId), a closing text; status file `working` fresh. The "run" is dead: the fake TUI only
// starts when the pane opens, so every record of the run predates the pane's spawn.
//
// Gates, on every transcript-append push the pane receives (main side) and on the rendered cards (renderer side):
//   FLASH_no_live_state    no agentState with state running / waiting ever reaches the pane
//   FLASH_final_closed     the last agentState of BOTH ids is closed
//   FLASH_cards_never_live no card (dispatch, SendMessage) ever shows data-status running / pending in a sample
//   FLASH_roster_never_live no roster row (bgAgents) ever has state running / waiting
//   FLASH_cards_settled    both cards end ok / interrupted (the renderer settles `closed` only on a running card: see the gate)
//
// Run (repo root; the probe fakes HOME / XDG / the status and projects dirs itself):
//   env -u WAYLAND_DISPLAY XDG_SESSION_TYPE=x11 GDK_BACKEND=x11 CLAUDE_DECK_ZOOM=1.0 CLAUDE_DECK_PRICES_URL=http://127.0.0.1:1 \
//   CLAUDE_DECK_COMMANDS_URL=http://127.0.0.1:1 CLAUDE_DECK_PLUGINS_DIR=$(mktemp -d) CLAUDE_DECK_ASK_DIR=$(mktemp -d) \
//   xvfb-run -a -s "-screen 0 3840x2160x24 -nolisten tcp" timeout 180 node_modules/.bin/electron test/agent-reopen-flash-probe.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-probe-home-'));
process.env.HOME = FAKE_HOME;
process.env.XDG_CONFIG_HOME = path.join(FAKE_HOME, '.config');
process.env.XDG_CACHE_HOME = path.join(FAKE_HOME, '.cache');
process.env.XDG_DATA_HOME = path.join(FAKE_HOME, '.local', 'share');
for (const k of ['XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME']) {
  fs.mkdirSync(process.env[k], { recursive: true });
}
const WS = path.join(FAKE_HOME, 'Documents', 'workspace');
fs.mkdirSync(WS, { recursive: true });
const PROJ_ROOT = path.join(FAKE_HOME, '.claude', 'projects');
const PROJ_DIR = path.join(PROJ_ROOT, WS.replace(/\//g, '-'));
fs.mkdirSync(PROJ_DIR, { recursive: true });
const STATUS_DIR = path.join(FAKE_HOME, '.claude', 'deck-status');
fs.mkdirSync(STATUS_DIR, { recursive: true });
process.env.CLAUDE_DECK_STATUS_DIR = STATUS_DIR;
process.env.CLAUDE_DECK_PROJECTS_DIR = PROJ_ROOT;
process.env.CLAUDE_DECK_NO_OPEN = '1';
process.env.CLAUDE_DECK_AI_URL = 'about:blank';

// Fake claude TUI: a heartbeat line every 500 ms (the pty stays fresh), stdin swallowed.
const FAKE_BIN = path.join(FAKE_HOME, 'fake-claude.sh');
fs.writeFileSync(FAKE_BIN, [
  '#!/bin/bash',
  'stty raw -echo 2>/dev/null',
  "printf '\\033[?2004h'",
  '(',
  '  n=0',
  '  while kill -0 $$ 2>/dev/null; do',
  '    n=$((n+1))',
  "    printf '\\r\\033[2K● heartbeat %d\\n' \"$n\"",
  '    sleep 0.5',
  '  done',
  ') &',
  'exec cat > /dev/null',
  '',
].join('\n'), { mode: 0o755 });
process.env.CLAUDE_DECK_BIN = FAKE_BIN;
// No memoized shell env: every pty-open resolves the user's interactive shell again (what a reopen does after the
// 60 s TTL), so the spawn lands well after the chat subscription, the worst ordering the real app produces.
process.env.CLAUDE_DECK_SHELL_ENV_TTL_MS = '0';

// ------------------------------- main-side ordering trace (installed BEFORE main.js loads) -------------------------------
const T0 = Date.now();
const TRACE = [];
const trace = (k, v) => TRACE.push(Object.assign({ t: Date.now() - T0, k }, v));
const { ipcMain } = require('electron');
{
  const origHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (ch, fn) => origHandle(ch, (ch === 'transcript-subscribe' || ch === 'pty-open')
    ? async (e, ...a) => {
      trace(`${ch} enter`, { pane: a[0] && a[0].paneId });
      try { return await fn(e, ...a); } finally { trace(`${ch} leave`, { pane: a[0] && a[0].paneId }); }
    }
    : fn);
  const { ptys } = require(path.join(__dirname, '..', 'src', 'main', 'state'));
  const origSet = ptys.set.bind(ptys);
  ptys.set = (k, v) => { trace('ptys.set', { pane: k, spawnedAt: v && v.spawnedAt }); return origSet(k, v); };
  const ss = require(path.join(__dirname, '..', 'src', 'main', 'session-status'));
  const origSince = ss.sessionLivenessSince;
  ss.sessionLivenessSince = (sid) => { const r = origSince(sid); trace('sessionLivenessSince', { live: r.live, sinceMs: r.sinceMs }); return r; };
}

const SID = '95c00000-aaaa-4bbb-8ccc-000000000001';
const J = (o) => JSON.stringify(o) + '\n';
const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();
const T = (minAgo) => iso(minAgo * 60 * 1000);

// ------------------------------- measured record builders (chat-bg-agent-resume-probe.js) -------------------------------
const AGENT_ID = 'a9a5f512d9d175334';
const DISPATCH_ID = 'toolu_014KFD3nTCJf5erFG1SdcJWH'; // the Agent call id
const SEND_ID = 'toolu_01FFTRcK4FHNFj13bJ9GaVHp';     // the SendMessage call id
const CLIP = '…[clipped]';
const rUser = (text, ts) => J({ type: 'user', timestamp: ts, message: { role: 'user', content: text } });
const rText = (text, ts) => J({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text }] } });
const rAgentUse = (ts) => J({ type: 'assistant', timestamp: ts,
  message: { model: 'claude-opus-5-5', role: 'assistant',
    content: [{ type: 'tool_use', id: DISPATCH_ID, name: 'Agent',
      input: { description: 'Fix S2 stuck-busy strip', subagent_type: 'code-dev', prompt: `Repo: /x/project${CLIP}` },
      caller: { type: 'direct' } }],
    stop_reason: 'tool_use' } });
const rLaunchAck = (ts) => J({ type: 'user', timestamp: ts,
  toolUseResult: { isAsync: true, status: 'async_launched', agentId: AGENT_ID, description: 'Fix S2 stuck-busy strip',
    resolvedModel: 'claude-sonnet-5-5', prompt: `Repo: /x/project${CLIP}`,
    outputFile: `/tmp/tasks/${AGENT_ID}.output`, canReadOutputFile: true },
  message: { role: 'user', content: [{ tool_use_id: DISPATCH_ID, type: 'tool_result', content: [{ type: 'text',
    text: `Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.)\nagentId: ${AGENT_ID} (internal ID - do not mention to user. Use SendMessage with to: '${AGENT_ID}', summary: '<5-10 word recap>' to continue this agent.)\nThe agent is working in the background. You will be notified automatically when it completes.${CLIP}` }] }] } });
const rHandback = (ts) => J({ type: 'user', timestamp: ts, isMeta: true,
  origin: { kind: 'peer', from: AGENT_ID, senderTaskId: AGENT_ID, body: `[Subagent hand-back]${CLIP}`, handback: true },
  message: { role: 'user', content: `Another Claude session sent a message:\n<agent-message from="${AGENT_ID}">\n[Subagent hand-back] The text below is the final report of a subagent this session delegated to.${CLIP}\n</agent-message>` } });
const notifText = (toolUseId) => `<task-notification>\n<task-id>${AGENT_ID}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<output-file>/tmp/tasks/${AGENT_ID}.output</output-file>\n<status>completed</status>\n<summary>Agent "Fix S2 stuck-busy strip" finished</summary>\n<note>A task-notification fires each time this agent stops with no live background children of its own. The user can send it another message and resume it, so the same task-id may notify more than once.</note>\n<result>This agent's report was delivered to you as a message from "${AGENT_ID}" (its SubagentHandback call). Read it there; it is not repeated here.\n</result>\n<usage><subagent_tokens>223440</subagent_tokens><tool_uses>46</tool_uses><duration_ms>1080359</duration_ms></usage>\n</task-notification>`;
const rNotif = (toolUseId, ts) => J({ type: 'queue-operation', operation: 'enqueue', timestamp: ts, content: notifText(toolUseId) })
  + J({ type: 'queue-operation', operation: 'remove', timestamp: ts, content: notifText(toolUseId), reason: 'absorbed_mid_turn' })
  + J({ attachment: { type: 'queued_command', prompt: notifText(toolUseId), source_uuid: 'd742aab0-c560-4d83-9c15-c399982e3e8f',
      commandMode: 'task-notification', origin: { kind: 'task-notification', producer: 'session-task' }, timestamp: ts,
      usage: { totalTokens: 223440, toolUses: 46, durationMs: 1080359 } }, type: 'attachment', timestamp: ts });
const rSendUse = (ts) => J({ type: 'assistant', timestamp: ts,
  message: { model: 'claude-opus-5-5', role: 'assistant',
    content: [{ type: 'tool_use', id: SEND_ID, name: 'SendMessage',
      input: { to: AGENT_ID, summary: 'Follow-up: longer confirm for bg-only phantom clause', message: `Follow-up on your S2 fix${CLIP}` },
      caller: { type: 'direct' } }], stop_reason: 'tool_use' } });
const rSendResult = (ts) => {
  const body = { success: true, message: 'Resuming agent a9a5f51', resumedAgentId: AGENT_ID, pin: { id: AGENT_ID, name: AGENT_ID, ref: 'e96153' } };
  return J({ type: 'user', timestamp: ts, toolUseResult: body,
    message: { role: 'user', content: [{ tool_use_id: SEND_ID, type: 'tool_result', content: [{ type: 'text', text: JSON.stringify(body) }] }] } });
};

// Every record is written BEFORE the pane opens, 20..4 min in the past; the status file is a fresh `working`.
fs.writeFileSync(path.join(PROJ_DIR, `${SID}.jsonl`),
  J({ type: 'user', cwd: WS, timestamp: T(20), message: { role: 'user', content: 'Lance une revue en arrière-plan' } })
  + rText('Je m’en occupe.', T(19))
  + rAgentUse(T(18)) + rLaunchAck(T(18)) + rText('Agent lancé en arrière-plan.', T(17))
  + rHandback(T(10)) + rNotif(DISPATCH_ID, T(10))
  + rUser('Reprends-le avec le suivi', T(6))
  + rSendUse(T(5)) + rSendResult(T(5)) + rText('Agent relancé.', T(4)));
fs.writeFileSync(path.join(STATUS_DIR, `${SID}.json`),
  JSON.stringify({ status: 'working', event: 'UserPromptSubmit', ts: new Date().toISOString() }) + '\n');

require(path.join(__dirname, '..', 'main.js'));
require('electron').app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'deck-probe-')));

const { app, BrowserWindow } = require('electron');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = [];
let failed = 0;
let preFailed = 0;
function emit(s) { console.log(s); lines.push(s); }
function gate(id, ok, detail) { emit(`${ok ? 'PASS' : 'FAIL'} ${id} — ${detail}`); if (!ok) failed++; }
function pre(id, ok, detail) { emit(`${ok ? 'PASS' : 'FAIL'} ${id} [harness precondition] — ${detail}`); if (!ok) preFailed++; }
const until = async (fn, ms, step = 50) => {
  const t = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t > ms) return null;
    await sleep(step);
  }
};

app.whenReady().then(async () => {
  await sleep(1500);
  const wc = BrowserWindow.getAllWindows()[0].webContents;
  const js = async (code) => {
    try { return await wc.executeJavaScript(code, true); }
    catch (e) {
      console.log('=== JS FAILED IN RENDERER ===');
      console.log(code.slice(0, 300));
      console.log(String(e));
      app.exit(1);
      throw e;
    }
  };

  // every transcript-append push of the pane, as main sends it
  const PUSHES = [];
  {
    const origSend = wc.send.bind(wc);
    wc.send = (ch, ...a) => {
      try {
        const p = a[0];
        if (ch === 'transcript-append' && p) {
          PUSHES.push({ t: Date.now() - T0, paneId: p.paneId, reset: !!p.reset,
            events: (p.events || []).filter((e) => e.kind === 'agentState')
              .map((e) => ({ id: e.toolUseId, state: e.state, seq: e.seq })) });
        }
      } catch (_) { /* never break the app for the probe */ }
      return origSend(ch, ...a);
    };
  }

  // renderer sampler (5 ms): data-status of every card + state of every roster row, first seen and on each change
  await js(`(() => {
    window.__flash = { cards: [], rows: [] };
    const seenC = {}; const seenR = {};
    setInterval(() => {
      const t = Date.now();
      for (const [, p] of panes) {
        if (!p.chat) continue;
        for (const [id, el] of p.chat.toolIndex) {
          const s = el.dataset.status;
          if (seenC[id] !== s) { seenC[id] = s; window.__flash.cards.push({ t, id, status: s }); }
        }
        for (const [k, a] of p.chat.bgAgents) {
          const s = String(a.state) + (a.done ? '/done' : '');
          if (seenR[k] !== s) { seenR[k] = s; window.__flash.rows.push({ t, id: k, state: s }); }
        }
      }
    }, 5);
  })()`);

  const tOpen = Date.now() - T0;
  await js(`openPane({ resumeId: '${SID}', title: 'fixture-reopen' })`);

  // the lifecycle settles: both ids reach their final state; then one more full tick (2 s) to catch a late re-push
  const finalOf = () => {
    const last = new Map();
    for (const p of PUSHES) for (const e of p.events) last.set(e.id, e.state);
    return last;
  };
  const settled = await until(() => { const f = finalOf(); return f.get(DISPATCH_ID) === 'closed' && f.get(SEND_ID) === 'closed'; }, 12000);
  await sleep(2600);

  const flash = JSON.parse(await js('JSON.stringify(window.__flash)'));
  const all = PUSHES.flatMap((p) => p.events.map((e) => ({ t: p.t, ...e })));
  const rel = (t) => t - T0;

  for (const r of TRACE.filter((x) => /^(transcript-subscribe|pty-open|ptys\.set)/.test(x.k))) {
    emit(`INFO order t=${r.t} ms  ${r.k}${r.pane ? ` pane=${r.pane}` : ''}${r.spawnedAt ? ` spawnedAt=${r.spawnedAt - T0}` : ''}`);
  }
  for (const r of TRACE.filter((x) => x.k === 'sessionLivenessSince' && x.t >= tOpen)) {
    emit(`INFO liveness t=${r.t} ms  live=${r.live} sinceMs=${r.sinceMs === null ? null : r.sinceMs - T0}`);
  }
  emit(`INFO openPane called at t=${tOpen} ms`);
  for (const e of all) emit(`INFO push t=${e.t} ms  agentState ${e.id.slice(-6)} ${e.state} seq=${e.seq}`);
  for (const c of flash.cards) emit(`INFO card t=${rel(c.t)} ms  ${c.id.slice(-6)} data-status=${c.status}`);
  for (const r of flash.rows) emit(`INFO row  t=${rel(r.t)} ms  ${r.id.slice(-6)} state=${r.state}`);

  const ids = [DISPATCH_ID, SEND_ID];
  const lastC = (id) => { const l = flash.cards.filter((c) => c.id === id); return l.length ? l[l.length - 1].status : null; };
  pre('pre_flash_cards both the Agent dispatch card and the SendMessage card were rendered from the replay',
      ids.every((id) => flash.cards.some((c) => c.id === id)), JSON.stringify(ids.map((id) => [id.slice(-6), lastC(id)])));
  pre('pre_flash_spawn the pane\'s pty was registered by the real pty-open (spawnedAt recorded) and the lifecycle settled',
      !!settled && TRACE.some((r) => r.k === 'ptys.set'),
      JSON.stringify({ settled: !!settled, ptysSet: TRACE.filter((r) => r.k === 'ptys.set').map((r) => r.t) }));

  const live = all.filter((e) => e.state === 'running' || e.state === 'waiting');
  gate('FLASH_no_live_state — no agentState running / waiting ever reaches the pane (the run died with the previous CLI)',
       live.length === 0, JSON.stringify(live));
  const fin = finalOf();
  gate('FLASH_final_closed — the last agentState of BOTH ids is closed',
       ids.every((id) => fin.get(id) === 'closed'), JSON.stringify(ids.map((id) => [id.slice(-6), fin.get(id) || null])));
  const liveCards = flash.cards.filter((c) => c.status === 'running' || c.status === 'pending');
  gate('FLASH_cards_never_live — no card ever shows data-status running / pending in a 5 ms sample',
       liveCards.length === 0, JSON.stringify(liveCards.map((c) => [c.id.slice(-6), c.status, rel(c.t)])));
  const liveRows = flash.rows.filter((r) => /^(running|waiting)/.test(r.state));
  gate('FLASH_roster_never_live — no roster row ever has state running / waiting',
       liveRows.length === 0, JSON.stringify(liveRows.map((r) => [r.id.slice(-6), r.state, rel(r.t)])));
  // MEASURED: the renderer's `closed` rule (applyAgentCard -> settleBgCard) only settles a card that is `running`. With no
  // transient `running`, the replayed cards (the notification settled the dispatch, the resume result was consumed) stay `ok`:
  // turning them `interrupted` is a renderer change, outside this lot. The gate is the end state being settled, never live.
  gate('FLASH_cards_settled — both cards end in a settled status (ok / interrupted), never running / pending',
       ids.every((id) => lastC(id) === 'ok' || lastC(id) === 'interrupted'), JSON.stringify(ids.map((id) => [id.slice(-6), lastC(id)])));

  const harnessOk = preFailed === 0;
  emit(`HARNESS: ${harnessOk ? 'valid' : 'INVALID'} (${preFailed} precondition failure(s))`);
  emit(`VERDICT: ${failed === 0 && harnessOk ? 'ALL GREEN' : `RED (${failed} failing gate(s)${harnessOk ? '' : ', harness INVALID'})`}`);
  fs.writeFileSync(path.join(__dirname, 'agent-reopen-flash-probe.out'), lines.join('\n') + '\n');
  app.exit(failed === 0 && harnessOk ? 0 : 1);
});
