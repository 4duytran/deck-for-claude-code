// claude-deck — preload: the ONLY bridge between renderer and main.
// contextIsolation is ON; the renderer gets this minimal surface and nothing else.
'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const api = {
  // Spawn a `claude` PTY for a pane.
  // opts: { paneId, cwd?, resumeId?, newName?, cols, rows } — newName (v28) =
  // optional creation name; main then fixes the session id (--session-id) and
  // returns it in the result for pane adoption.
  openTerminal: (opts) => ipcRenderer.invoke('pty-open', opts),
  // Keyboard input from xterm -> PTY. Optional tag (e.g. 'retry-cr') marks a
  // write's kind for the diagnostic send trace only — omitted, the payload
  // shape is byte-identical to before.
  writeInput: (paneId, data, tag) => ipcRenderer.send('pty-input',
    tag === undefined ? { paneId, data } : { paneId, data, tag }),
  // Diagnostic send trace only: the chat send retry poll gave up (guard name +
  // lengths/geometry, never text). Send-only; main validates every field and
  // silently drops anything outside the fixed shape.
  traceRetrySkip: (info) => ipcRenderer.send('send-trace-retry-skip', info),
  // v47.x /clear re-anchor — arm a pane-scoped, one-shot adopter for THIS
  // pane's imminent « /clear » fork (the L1 content-lineage detector refuses
  // it by design). Renderer sends this BEFORE pasting /clear so the dir
  // snapshot precedes the new file; main does all the IO.
  expectClear: (paneId) => ipcRenderer.send('pane-expect-clear', { paneId }),
  // Keep PTY dimensions in sync with the pane (fit addon).
  resize: (paneId, cols, rows) => ipcRenderer.send('pty-resize', { paneId, cols, rows }),
  // Close a pane's PTY.
  kill: (paneId) => ipcRenderer.send('pty-kill', { paneId }),
  // Scan ~/.claude/projects for past sessions, grouped by project cwd.
  listSessions: () => ipcRenderer.invoke('sessions-list'),
  // Session actions — main process enforces the busy-guard (live PID / status).
  renameSession: (sessionId, newName) => ipcRenderer.invoke('session-rename', { sessionId, newName }),
  deleteSession: (sessionId) => ipcRenderer.invoke('session-delete', { sessionId }),
  // New-session folder picker (v13): native dialog, default dir, pre-spawn guard.
  pickFolder: () => ipcRenderer.invoke('dialog-pick-folder'),
  dirExists: (p) => ipcRenderer.invoke('dir-exists', p),
  // Composer attachments: native file picker in the session folder -> { paths, roots };
  // roots only for a drop; pathForFile = the disk path of a dropped File ('' when it has none);
  // attachThumb = a data: miniature of an image file (96 px max edge), null when it has none.
  pickFiles: (target) => ipcRenderer.invoke('dialog-pick-files', target),
  attachRoots: (target) => ipcRenderer.invoke('attach-roots', target),
  attachThumb: (p) => ipcRenderer.invoke('attach-thumb', p),
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file) || ''; } catch (_) { return ''; }
  },
  defaultSessionDir: () => ipcRenderer.invoke('default-session-dir'),
  // alacritty alignment: selection -> X11 PRIMARY (copy-on-select). The paste
  // half is native: Chromium/Linux pastes PRIMARY on middle-click by itself.
  writePrimary: (text) => ipcRenderer.send('primary-write', text),
  // Smart Ctrl+C/V (desktop reflexes à la VS Code/Windows Terminal): the
  // renderer decides per keystroke, these talk to the system CLIPBOARD.
  clipboardWrite: (text) => ipcRenderer.send('clipboard-write', text),
  clipboardRead: () => ipcRenderer.invoke('clipboard-read'),
  // Claude AI mode (v19): show/position/hide the ONE native WebContentsView.
  // bounds = the #ai-frame placeholder rect ({x, y, width, height}, CSS px).
  aiShow: (bounds) => ipcRenderer.send('ai-show', bounds),
  aiHide: () => ipcRenderer.send('ai-hide'),
  aiBounds: (bounds) => ipcRenderer.send('ai-bounds', bounds),
  // v22 escape hatch: claude.ai pages without the native sidebar (/design…)
  // have no in-page way back — the deck header hosts a back button.
  aiBack: () => ipcRenderer.send('ai-back'),
  // Usage quotas (5h/7j) collected by the statusline script into deck-usage.json.
  getUsage: () => ipcRenderer.invoke('usage-get'),
  // Remembered Claude plan: null | 'pro' | 'max' | 'ultra'; resolves {plan}, {error:'plan'} or {error:'write'}.
  setUsagePlan: (plan) => ipcRenderer.invoke('usage-set-plan', plan),
  onUsageUpdate: (cb) => ipcRenderer.on('usage-update', (_e, payload) => cb(payload)),
  // Usage page report (ipc/usage.js): period = '24h' | '7d' | '30d' | '90d'; resolves the aggregated report.
  getUsageReport: (period) => ipcRenderer.invoke('usage-report', period),
  // Question drawer (hook channel): a pending ask pushes {id, kind, paneId, ...} on 'ask-request',
  // 'ask-closed' {id} when it is gone (request unlinked or pane closed); askAnswer resolves {ok}.
  askAnswer: (id, answer) => ipcRenderer.invoke('ask-answer', id, answer),
  onAskRequest: (cb) => ipcRenderer.on('ask-request', (_e, payload) => cb(payload)),
  onAskClosed: (cb) => ipcRenderer.on('ask-closed', (_e, payload) => cb(payload)),
  // Git panel (v39, retargeted v39.1): read-only git state of a session's
  // workspace. target = { paneId?, sessionId?, sub? } — ids only, main
  // resolves every path. Status cheap; diffs lazy per file.
  // B29: an optional `base` (a name from gitBranches) compares merge-base(base, HEAD)
  // to the working tree, read-only; without it both calls answer as before.
  gitStatus: (target, base) => ipcRenderer.invoke('git-panel-status', base ? { ...target, base } : target),
  // `wt` (worktree view only): the lot id of the row; absent = the head's own rows.
  gitDiff: (target, file, kind, full, base, wt) => ipcRenderer.invoke('git-panel-diff',
    { ...target, file, kind, full, ...(base ? { base } : {}), ...(wt ? { wt } : {}) }),
  gitBranches: (target) => ipcRenderer.invoke('git-panel-branches', target),
  // Two-lane log: the refs main lists, and one page of the log of a listed ref ({kind, name}); main validates both.
  gitRefs: (target) => ipcRenderer.invoke('git-panel-refs', target),
  gitLog: (target, ref, page) => ipcRenderer.invoke('git-panel-log', { ...target, ref, page }),
  // One commit of the log: its message and files, then one file's diff (`sha` is a full 40-hex id; main validates both).
  gitCommit: (target, sha) => ipcRenderer.invoke('git-panel-commit', { ...target, sha }),
  gitCommitDiff: (target, sha, file, full) => ipcRenderer.invoke('git-panel-commit-diff', { ...target, sha, file, full }),
  // New side of a diff row as text: `req` = the diff call's own args ({file, kind, wt, base} or {sha, file}).
  gitFileAt: (target, req) => ipcRenderer.invoke('git-panel-file-at', { ...target, ...req }),
  // v53: GUI editors detected on PATH for the open-with chooser (ids+labels).
  gitEditors: () => ipcRenderer.invoke('git-panel-editors'),
  // `wt` (worktree view only): the lot id of the row, as for gitDiff; absent = the head's own rows.
  gitOpenFile: (target, file, editor, wt) => ipcRenderer.invoke('git-panel-open',
    { ...target, file, editor, ...(wt ? { wt } : {}) }),
  // GitLab MR review (deck-mr-review): the repo is resolved from the same target, host / project from its remote
  // in main (handlers in src/main/ipc/gitlab.js). gitlabMrs lists the open MRs, gitlabMr reads one MR
  // (whole, or one `part`: version | diffs | discussions), gitlabUser gives the signed-in username of the target's host.
  gitlabMrs: (target) => ipcRenderer.invoke('gitlab-mrs', target),
  gitlabMr: (target, iid, part) => ipcRenderer.invoke('gitlab-mr', { ...target, iid, part }),
  gitlabUser: (target) => ipcRenderer.invoke('gitlab-user', target),
  gitlabFileRaw: (target, path, ref) => ipcRenderer.invoke('gitlab-file-raw', { ...target, path, ref }),
  // Names of the GitLab repos one level under a session folder that is not a repo (the MR choice). A pick travels as
  // `subRepo: name` on a copy of the target; main re-checks the name against this listing.
  gitlabFolderRepos: (target) => ipcRenderer.invoke('gitlab-folder-repos', target),
  // Review drafts of one MR (R6), kept in main's userData until sent; the store key comes from the repo remote.
  gitlabDrafts: (target, iid) => ipcRenderer.invoke('gitlab-drafts-list', { target, iid }),
  gitlabDraftSave: (target, iid, draft) => ipcRenderer.invoke('gitlab-draft-save', { target, iid, draft }),
  gitlabDraftDelete: (target, iid, id) => ipcRenderer.invoke('gitlab-draft-delete', { target, iid, id }),
  gitlabSubmit: (target, iid, ids) => ipcRenderer.invoke('gitlab-submit', { target, iid, ids }),
  gitlabApprove: (target, iid, headSha) => ipcRenderer.invoke('gitlab-approve', { target, iid, headSha }),
  // Plans panel (v40): plans the session made/consumed — list from the
  // transcript truth (same parse as the git panel), content lazy per plan,
  // addressed by index into main's cached list (paths never cross the IPC).
  plansList: (target) => ipcRenderer.invoke('plans-list', target),
  // expectName = identity guard: main refuses if the index drifted (live
  // transcript re-sorted between list and get) instead of serving the wrong plan.
  planGet: (target, planIndex, expectName) => ipcRenderer.invoke('plans-get', { ...target, planIndex, expectName }),
  // Files panel (P1-08): read-only browsing of the session folder. target = { paneId?, sessionId? };
  // rel / relOrAbs are folder-relative or absolute paths, main refuses anything outside the folder.
  filesList: (target, rel) => ipcRenderer.invoke('files-list', { ...target, rel }),
  filesRead: (target, relOrAbs) => ipcRenderer.invoke('files-read', { ...target, rel: relOrAbs }),
  // Closed frame transport: main stores the page bytes for `slot` ('files' | 'plans' | 'plugin') and answers
  // { ok, url } with a fresh deckpage:// URL (or { ok:false, error: 'badSlot' | 'badHtml' | 'tooLarge' }).
  pageServe: (slot, html) => ipcRenderer.invoke('page-serve', { slot, html }),
  // Plugin host (daily-brief): every call answers { ok:true, ... } or { ok:false, error:'<French line>' }, except the two
  // lists. Variable NAMES and statuses only ever cross this bridge, never a value. `plugins-changed` is pushed after any
  // state change (toggle, run start / end, import, delete, startup).
  pluginsList: () => ipcRenderer.invoke('plugins-list'),
  pluginsSetEnabled: (id, enabled) => ipcRenderer.invoke('plugins-set-enabled', { id, enabled }),
  pluginsSetRetention: (id, days) => ipcRenderer.invoke('plugins-set-retention', { id, days }),
  pluginsSetEnvMap: (id, map) => ipcRenderer.invoke('plugins-set-env-map', { id, map }),
  pluginsSetOption: (id, name, value) => ipcRenderer.invoke('plugins-set-option', { id, name, value }),
  pluginsAccess: (id) => ipcRenderer.invoke('plugins-access', { id }),
  pluginsDetect: (arg) => ipcRenderer.invoke('plugins-detect', arg),
  pluginsRunNow: (id) => ipcRenderer.invoke('plugins-run-now', { id }),
  pluginsStop: (id) => ipcRenderer.invoke('plugins-stop', { id }),
  pluginsHistory: (id, filter) => ipcRenderer.invoke('plugins-history', { id, filter }),
  pluginsOpenReport: (id, stem) => ipcRenderer.invoke('plugins-open-report', { id, stem }),
  pluginsReadLog: (id, stem) => ipcRenderer.invoke('plugins-read-log', { id, stem }),
  pluginsPick: () => ipcRenderer.invoke('plugins-pick'),
  pluginsImport: (token, opts) => ipcRenderer.invoke('plugins-import', { token, opts }),
  pluginsDeleteCard: (id) => ipcRenderer.invoke('plugins-delete-card', { id }),
  pluginsDelete: (id) => ipcRenderer.invoke('plugins-delete', { id }),
  onPluginsChanged: (cb) => ipcRenderer.on('plugins-changed', () => cb()),
  // Escape typed anywhere in the Deck window, the report frame included (payload-less push from window.js)
  onPluginViewEscape: (cb) => ipcRenderer.on('plugin-view-escape', () => cb()),
  filesSearch: (target, query) => ipcRenderer.invoke('files-search', { ...target, query }),
  // Composer « / » picker (B24 K5): official commands + the user's skills / commands from disk, each
  // { name, args, desc, source: 'cli'|'user'|'project' } sorted by name; main resolves the folder from paneId.
  commandsList: (paneId) => ipcRenderer.invoke('commands-list', { paneId }),
  // Chat view (v42): per-pane transcript subscription. Subscribe replies
  // with the initial bounded read; increments then arrive on the
  // 'transcript-append' push (routed by paneId, reset flag = rebuild).
  transcriptSubscribe: (target) => ipcRenderer.invoke('transcript-subscribe', target),
  transcriptUnsubscribe: (paneId) => ipcRenderer.send('transcript-unsubscribe', { paneId }),
  // v46.3: phantom-busy reconciliation — the chat's TUI scan proved the
  // session sits at its prompt while the status file still says busy (an
  // interrupt that left no transcript trace). Guarded main-side: only a
  // busy entry flips, the hooks always win the file afterwards.
  statusReconcileIdle: (target) => ipcRenderer.send('status-reconcile-idle', target),
  // The permission menu left the terminal (two consecutive « no menu, composer
  // visible » reads of the pane): main restores the status held before the
  // menu. target = { paneId, sessionId, seenAt } (seenAt = epoch ms of the
  // first read). Guarded main-side: only a `waiting` record older than seenAt.
  statusMenuGone: (target) => ipcRenderer.send('status-menu-gone', target),
  onTranscriptAppend: (cb) => ipcRenderer.on('transcript-append', (_e, payload) => cb(payload)),
  // v46.6: sub-agent live activity — tool calls tailed from the sub-agent's
  // own transcript while its dispatch card is pending (routed by paneId +
  // toolUseId; the chat shows WHAT the agent is doing, terminal-face parity).
  onSubagentAppend: (cb) => ipcRenderer.on('subagent-append', (_e, payload) => cb(payload)),
  // Single global subscriptions; the renderer routes events by paneId.
  onData: (cb) => ipcRenderer.on('pty-data', (_e, payload) => cb(payload)),
  onExit: (cb) => ipcRenderer.on('pty-exit', (_e, payload) => cb(payload)),
  // Panel terminal tab: a shell in the session's own workspace (src/main/ipc/panel-term.js). Ids only, keyed by termId.
  panelTermOpen: (opts) => ipcRenderer.invoke('panel-term-open', opts),
  panelTermInput: (msg) => ipcRenderer.send('panel-term-input', msg),
  panelTermResize: (msg) => ipcRenderer.send('panel-term-resize', msg),
  panelTermKill: (msg) => ipcRenderer.send('panel-term-kill', msg),
  panelTermReset: () => ipcRenderer.send('panel-term-reset'),
  onPanelTermData: (cb) => ipcRenderer.on('panel-term-data', (_e, payload) => cb(payload)),
  onPanelTermExit: (cb) => ipcRenderer.on('panel-term-exit', (_e, payload) => cb(payload)),
  // Live session status pushed from the deck-status watcher (routed by sessionId).
  onSessionStatus: (cb) => ipcRenderer.on('session-status', (_e, payload) => cb(payload)),
  // v47: per-session context-window fill (live push from the transcript reader, routed by sessionId).
  onSessionContext: (cb) => ipcRenderer.on('session-context', (_e, payload) => cb(payload)),
  // Session effort level read from the statusline data ({sessionId, level|null}, routed by sessionId).
  onSessionEffort: (cb) => ipcRenderer.on('session-effort', (_e, payload) => cb(payload)),
  // v41: presence flags computed by the background queue (routed by sessionId).
  onSessionFlags: (cb) => ipcRenderer.on('session-flags', (_e, payload) => cb(payload)),
  // Agent journal (S4): per-agent tool-call event feed for the sidebar overlay.
  // target = { sessionId, toolUseId } only — no pane identifier crosses this
  // bridge, main resolves every path (rule 3). Subscribe replies with the
  // initial bounded read; increments arrive on the 'agent-journal-append' push.
  agentJournalSubscribe: (target) => ipcRenderer.invoke('agent-journal-subscribe', target),
  agentJournalUnsubscribe: () => ipcRenderer.send('agent-journal-unsubscribe'),
  onAgentJournalAppend: (cb) => ipcRenderer.on('agent-journal-append', (_e, p) => cb(p)),
  // Inter-session room chat: bounded recent feed + live registry, a human post
  // (from:'user', label 'you'), and the live push as each routed message lands.
  roomRecent: (limit) => ipcRenderer.invoke('room-recent', limit),
  roomWho: () => ipcRenderer.invoke('room-who'),
  roomSend: (to, text) => ipcRenderer.invoke('room-send', { to, text }),
  roomClear: () => ipcRenderer.invoke('room-clear'),
  onRoomAppend: (cb) => ipcRenderer.on('room-append', (_e, msg) => cb(msg)),
  // Lifecycle control (room spawn/resume): main forwards a validated control
  // record; the renderer (room-control.js) drives openPane from it.
  onRoomControl: (cb) => ipcRenderer.on('room-control', (_e, rec) => cb(rec)),
};

contextBridge.exposeInMainWorld('api', api);
