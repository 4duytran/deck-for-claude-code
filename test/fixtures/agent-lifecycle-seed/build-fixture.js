#!/usr/bin/env node
// Regenerates the synthetic agent-lifecycle seed fixture next to this file (deterministic: no clock, no randomness).
//   node test/fixtures/agent-lifecycle-seed/build-fixture.js
// Every record is written by hand below from the SHAPE of a real session; no text, id, path or timestamp is copied
// from one. The timestamps are literal constants chosen so that the three probes' own literals hold (see README).
// After a change, update the two byte sizes pinned by the `fixture_intact` gate of agent-lifecycle-seed-probe.js.
'use strict';

const fs = require('fs');
const path = require('path');

const SID = '00000000-0000-4000-8000-00000000a001'; // session id
const AID = 'a0000000000000a01'; // sub-agent id
const tid = (tag) => `toolu_${String(tag).padStart(24, '0')}`; // 30-char tool_use ids
const DISPATCH = tid('d001'); // the parent's Agent tool_use (the key of agentStatesOf)
const CWD = '/home/user/project';

let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
const tail = { userType: 'external', entrypoint: 'cli', cwd: CWD, sessionId: SID, version: '0.0.0', gitBranch: 'HEAD', slug: 'synthetic-fixture' };

// One builder per file: the main transcript (own = false) and the sub-agent's own file (own = true, all sidechain).
function builder(own) {
  let parent = null;
  const mk = (type, timestamp, body) => {
    const id = uuid();
    const r = { parentUuid: parent, isSidechain: own, ...(own ? { agentId: AID } : {}), ...body, type, uuid: id, timestamp, ...tail };
    parent = id;
    return r;
  };
  return {
    user: (ts, content, extra) => mk('user', ts, { message: { role: 'user', content }, ...extra }),
    result: (ts, toolUseId, content, tur) => mk('user', ts, {
      message: { role: 'user', content: [{ tool_use_id: toolUseId, type: 'tool_result', content }] },
      ...(tur ? { toolUseResult: tur } : {}),
    }),
    assistant: (ts, stop, blocks) => mk('assistant', ts, { message: { role: 'assistant', model: 'synthetic-model-1', content: blocks, stop_reason: stop } }),
    attachment: (ts, attachment) => mk('attachment', ts, { attachment }),
    system: (ts, subtype, extra) => mk('system', ts, { subtype, ...extra }),
  };
}

const notice = (taskId, toolUseId, summary) => [
  '<task-notification>', `<task-id>${taskId}</task-id>`, `<tool-use-id>${toolUseId}</tool-use-id>`,
  '<status>completed</status>', `<summary>${summary}</summary>`, '</task-notification>',
].join('\n');
const queued = (prompt) => ({
  type: 'queued_command', prompt, source_uuid: 'src-0001', delivery_id: 'dlv-0001', commandMode: 'task-notification',
  origin: { kind: 'task-notification', producer: 'session-task' },
});
const hook = (event, name) => ({ type: 'hook_success', hookName: name || event, toolUseID: 'hook-0001', hookEvent: event, content: '', stdout: '', stderr: '', exitCode: 0, command: 'true', durationMs: 1 });
const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });

// ---- the main transcript (7 records) ---------------------------------------------------------------------------
const M = builder(false);
const main = [
  M.user('2026-11-07T17:35:00.000Z', 'Run the synthetic task.'),
  M.assistant('2026-11-07T17:35:29.174Z', 'tool_use', [toolUse(DISPATCH, 'Agent', {
    subagent_type: 'worker', description: 'synthetic sub-agent task', run_in_background: true, prompt: 'synthetic task prompt',
  })]),
  M.result('2026-11-07T17:35:54.370Z', DISPATCH,
    [{ type: 'text', text: `Async agent launched successfully.\nagentId: ${AID} (synthetic ack)` }],
    { isAsync: true, status: 'async_launched', agentId: AID, description: 'synthetic sub-agent task', prompt: 'synthetic task prompt', canReadOutputFile: true, canContinueAgent: true }),
  // The parent-side "waiting" notice, 6 ms after the agent's first own tail (own record 13): it must NOT beat that tail.
  { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-11-07T17:51:46.045Z', sessionId: SID,
    content: notice(AID, DISPATCH, 'Agent "synthetic sub-agent task" is waiting on its own background work') },
  M.attachment('2026-11-07T17:51:46.045Z', queued(notice(AID, DISPATCH, 'Agent "synthetic sub-agent task" is waiting on its own background work'))),
  // The parent keeps writing after the agent's final tail and never records a completion for DISPATCH.
  M.assistant('2026-11-07T17:57:45.000Z', 'end_turn', [{ type: 'text', text: 'Synthetic reply.' }]),
  M.system('2026-11-07T17:58:30.000Z', 'turn_duration', { durationMs: 1000 }),
];

// ---- the sub-agent's own transcript (22 records, indices 0-21, every one isSidechain) --------------------------
const O = builder(true);
const B1 = tid('b001');
const B2 = tid('b002');
const H1 = tid('e001');
const H2 = tid('e002');
const own = [
  /* 0 */ O.user('2026-11-07T17:35:54.344Z', 'synthetic task prompt'),
  /* 1 */ O.attachment('2026-11-07T17:35:54.395Z', hook('SubagentStart', 'SubagentStart:worker')),
  /* 2 */ { type: 'api-request-blob', sessionId: SID, hash: '0'.repeat(64), message: { role: 'system', content: [{ type: 'text', text: 'synthetic blob' }] } }, // no timestamp
  /* 3 */ O.assistant('2026-11-07T17:36:10.000Z', 'tool_use', [toolUse(tid('c001'), 'Read', { file_path: '/home/user/project/notes.txt' })]),
  /* 4 */ O.result('2026-11-07T17:36:10.500Z', tid('c001'), 'synthetic output', { type: 'text' }),
  // background child 1: launched, then closed by its notification (openChildren 1 -> 0)
  /* 5 */ O.assistant('2026-11-07T17:46:58.748Z', 'tool_use', [toolUse(B1, 'Bash', { command: 'true', description: 'synthetic', run_in_background: true })]),
  /* 6 */ O.result('2026-11-07T17:46:59.100Z', B1, 'Command running in the background', { backgroundTaskId: 'bg0001' }),
  /* 7 */ O.attachment('2026-11-07T17:47:07.187Z', queued(notice('bg0001', B1, 'Background command finished'))),
  // background child 2
  /* 8 */ O.assistant('2026-11-07T17:50:12.669Z', 'tool_use', [toolUse(B2, 'Bash', { command: 'true', description: 'synthetic', run_in_background: true })]),
  /* 9 */ O.result('2026-11-07T17:50:13.000Z', B2, 'Command running in the background', { backgroundTaskId: 'bg0002' }),
  /* 10 */ O.attachment('2026-11-07T17:50:19.042Z', queued(notice('bg0002', B2, 'Background command finished'))),
  // first hand-back tail: handback tool_use -> its tool_result -> the stop hook attachment (no open child)
  /* 11 */ O.assistant('2026-11-07T17:51:45.308Z', 'tool_use', [toolUse(H1, 'SubagentHandback', { message: 'synthetic report' })]),
  /* 12 */ O.result('2026-11-07T17:51:45.615Z', H1, 'Report delivered.', { success: true, message: 'synthetic' }),
  /* 13 */ O.attachment('2026-11-07T17:51:46.039Z', hook('SubagentStop')),
  // the wake-up: a later own record clears the terminal state and the agent runs again
  /* 14 */ O.user('2026-11-07T17:57:07.026Z', notice('bg0002', B2, 'Background command finished')),
  /* 15 */ O.attachment('2026-11-07T17:57:07.061Z', hook('SubagentStart', 'SubagentStart:worker')),
  /* 16 */ O.attachment('2026-11-07T17:57:07.069Z', hook('SubagentStart', 'SubagentStart:worker')),
  /* 17 */ O.assistant('2026-11-07T17:57:11.596Z', 'end_turn', [{ type: 'text', text: 'synthetic answer' }]),
  /* 18 */ O.user('2026-11-07T17:57:11.772Z', 'synthetic follow-up'),
  // final hand-back tail, the one the probes read
  /* 19 */ O.assistant('2026-11-07T17:57:28.464Z', 'tool_use', [toolUse(H2, 'SubagentHandback', { message: 'synthetic final report' })]),
  /* 20 */ O.result('2026-11-07T17:57:28.628Z', H2, 'Report delivered.', { success: true, message: 'synthetic' }),
  /* 21 */ O.attachment('2026-11-07T17:57:28.829Z', hook('SubagentStop')),
];

const meta = {
  agentType: 'worker', isBuiltIn: false, launchedWithDefaults: true, description: 'synthetic sub-agent task', toolUseId: DISPATCH,
  spawnDepth: 1, requestShape: 'background', requestNonInteractive: true, pickedEffortModel: 'synthetic-model-1', finished: true,
};

const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const subDir = path.join(__dirname, SID, 'subagents');
fs.mkdirSync(subDir, { recursive: true });
const out = [
  [path.join(__dirname, `${SID}.jsonl`), jsonl(main), main.length],
  [path.join(subDir, `agent-${AID}.jsonl`), jsonl(own), own.length],
  [path.join(subDir, `agent-${AID}.meta.json`), JSON.stringify(meta), 1],
];
for (const [file, body, n] of out) {
  fs.writeFileSync(file, body);
  console.log(`${path.relative(__dirname, file)}: ${n} record(s), ${Buffer.byteLength(body)} bytes`);
}
