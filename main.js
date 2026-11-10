// claude-deck — composition root. The ONLY entrypoint (package.json `main`,
// and every .scratch probe does `require('../main.js')` after setting its
// CLAUDE_DECK_* env seams — keep this file at the repo root, and keep module
// loading as a consequence of requiring it).
//
// All the logic lives in src/main/ — one domain per module:
//   config.js             paths, constants, env seams (loaded first)
//   state.js              shared mutable registries (data only, no logic)
//   window.js             the BrowserWindow + send() push helper
//   settings-injection.js v35 per-spawn `--settings` payload
//   transcripts.js        low-level session .jsonl access
//   session-meta.js       sidebar head+tail meta scan (mtime-cached)
//   session-status.js     live status, watcher, busy-guard, PID reconcile
//   session-titles.js     close-time name/rename injection
//   session-activity.js   THE one-pass transcript parse (repos/plans/flags)
//   page-scheme.js        the privileged `deckpage:` scheme + 3-slot page store
//   ipc/*.js              one file per IPC handler family (ipc/page.js: `page-serve`)
//   plugin-*.js, plugins.js  the plugin host leaves, composed below (composePlugins) and served by ipc/plugins.js
// Wiring rule: modules never reach into each other's lifecycle — this file
// registers every IPC family and starts every watcher/tick, in one place.
'use strict';

const { app, Menu } = require('electron');

const { createWindow } = require('./src/main/window');
const { resolveShellEnv } = require('./src/main/shell-env');
const { startStatusWatcher } = require('./src/main/session-status');
const { registerPtyIpc, killAll } = require('./src/main/ipc/pty');
const { registerPanelTermIpc, killAllPanelTerms } = require('./src/main/ipc/panel-term');
const { registerSessionsIpc } = require('./src/main/ipc/sessions');
const { registerGitPanelIpc } = require('./src/main/ipc/git-panel');
const { registerGitlabIpc } = require('./src/main/ipc/gitlab');
const { registerGitlabDraftsIpc } = require('./src/main/ipc/gitlab-drafts');
const { registerPlansPanelIpc } = require('./src/main/ipc/plans-panel');
const { registerFilesPanelIpc } = require('./src/main/ipc/files-panel');
const { registerCommandsIpc } = require('./src/main/ipc/commands');
const { registerDialogsIpc } = require('./src/main/ipc/dialogs');
const { registerTranscriptIpc } = require('./src/main/ipc/transcript');
const {
  registerUsageIpc, startUsageWatcher, startUsageTick, startEstimatorColdPass,
} = require('./src/main/ipc/usage');
const { registerAiViewIpc } = require('./src/main/ipc/ai-view');
const { startRoomRouter } = require('./src/main/rooms');
const { registerRoomIpc } = require('./src/main/ipc/room');
const { runPreflight } = require('./src/main/preflight');
const { registerAskIpc, startAskWatcher } = require('./src/main/ipc/ask');
const { startPriceFeed } = require('./src/main/price-feed');
const { startCommandsFeed } = require('./src/main/commands-feed');
const { registerPageScheme, startPageProtocol } = require('./src/main/page-scheme');
const { registerPageIpc } = require('./src/main/ipc/page');
const { registerPluginsIpc, startPlugins, notifyPluginsChanged } = require('./src/main/ipc/plugins');

// Plugin host composition (daily-brief), built on the first use: userData is only final once a probe has set it, and
// no plugin means no fs access at all. The five modules know nothing of each other; this is where they meet.
let pluginDeps = null;
function composePlugins() {
  if (pluginDeps) return pluginDeps;
  const os = require('node:os');
  const path = require('node:path');
  const cfg = require('./src/main/config');
  const manifest = require('./src/main/plugin-manifest');
  const access = require('./src/main/plugin-access');
  const userData = app.getPath('userData');
  const pluginsDir = cfg.PLUGINS_DIR || path.join(userData, 'plugins');
  const dataRoot = path.join(userData, 'plugin-data');
  const nowFn = () => cfg.PLUGINS_NOW ?? Date.now();
  let user = null;
  try { user = os.userInfo(); } catch (_) { /* no passwd entry: the runner falls back to bash */ }
  const shellPath = cfg.PLUGINS_SHELL || (user && user.shell) || null; // ONE resolution for the listing and the launch
  const baseNames = cfg.PLUGIN_BASE_ENV;
  const reports = require('./src/main/plugin-reports').create(dataRoot, nowFn);
  // The host and the runner read a flat descriptor ({ id, label, trigger, argv, env, dir, ... }); the cwd is the real folder.
  let found = [];
  const scan = (dir, opts) => {
    found = manifest.scan(dir, opts).map(({ manifest: m, ...p }) => ({ ...p, ...m, dir: p.dirReal }));
    return found;
  };
  let host = null; // the runner reports an exit to the host, which is built from the runner
  const runner = require('./src/main/plugin-runner').create({
    reports, nowFn, shellPath, baseNames, validName: access.validName,
    onExit: (id, info) => { host.onExit(id, info); notifyPluginsChanged(); },
  });
  host = require('./src/main/plugins').create({
    pluginsDir, statePath: path.join(userData, 'plugins.json'), scan, access, runner, reports, nowFn, shellPath, baseNames,
  });
  pluginDeps = {
    host, runner, reports, access, shellPath, baseNames, pluginsDir, dataRoot, statePath: path.join(userData, 'plugins.json'),
    validateManifest: manifest.validateManifest, pluginOf: (id) => found.find((p) => p.id === id) || null,
  };
  return pluginDeps;
}

// IPC handlers are registered at require time of main.js (before app ready,
// before any renderer exists) — same guarantee as the historical monolith.
// The `deckpage:` scheme must be privileged before ready, so it is here too.
registerPageScheme();
registerPtyIpc();
registerPanelTermIpc();
registerSessionsIpc();
registerGitPanelIpc();
registerGitlabIpc();
registerGitlabDraftsIpc();
registerPlansPanelIpc();
registerFilesPanelIpc();
registerCommandsIpc();
registerDialogsIpc();
registerTranscriptIpc();
registerUsageIpc();
registerAiViewIpc();
registerRoomIpc();
registerAskIpc();
registerPageIpc();
registerPluginsIpc(composePlugins);

// ---------------------------------------------------------------------------
// On-demand perf report (CLAUDE_DECK_PERF=1, inert otherwise): after a 15 s
// warm-up, samples app.getAppMetrics() every 1 s for 60 s, then logs ONE line
// per process type/name with the average percentCPUUsage and
// idleWakeupsPerSecond (per process; `procs` = distinct processes seen).
// percentCPUUsage / idleWakeupsPerSecond cover the time since the previous
// call and read 0 on a process' first call, so the warm-up ends with one
// priming call and a process first seen later is skipped once. Log only:
// never quits the app.
// ---------------------------------------------------------------------------
function startPerfReport() {
  if (process.env.CLAUDE_DECK_PERF !== '1') return;
  const WARMUP_MS = 15000;
  const SAMPLE_MS = 1000;
  const SAMPLES = 60;
  const seen = new Set(); // pid:creationTime of processes already primed
  const groups = new Map(); // "Type[:name]" -> { cpu, wake, n, pids }
  const collect = (record) => {
    let metrics = [];
    try { metrics = app.getAppMetrics(); } catch (_) { return; }
    for (const m of metrics) {
      const id = `${m.pid}:${m.creationTime}`;
      if (!seen.has(id)) { seen.add(id); continue; } // first call reads 0
      if (!record) continue;
      const label = m.name || m.serviceName;
      const key = label ? `${m.type}:${label}` : m.type;
      const g = groups.get(key) || { cpu: 0, wake: 0, n: 0, pids: new Set() };
      g.cpu += m.cpu.percentCPUUsage;
      g.wake += m.cpu.idleWakeupsPerSecond;
      g.n += 1;
      g.pids.add(m.pid);
      groups.set(key, g);
    }
  };
  setTimeout(() => {
    collect(false); // prime
    let taken = 0;
    const timer = setInterval(() => {
      collect(true);
      if (++taken < SAMPLES) return;
      clearInterval(timer);
      console.log(`[perf] ${SAMPLES} samples x ${SAMPLE_MS} ms after ${WARMUP_MS / 1000} s warm-up (per-process averages)`);
      const rows = [...groups.entries()].sort((a, b) => b[1].cpu / b[1].n - a[1].cpu / a[1].n);
      for (const [key, g] of rows) {
        console.log(`[perf] ${key} cpu=${(g.cpu / g.n).toFixed(2)}% wakeups=${(g.wake / g.n).toFixed(1)}/s procs=${g.pids.size} n=${g.n}`);
      }
    }, SAMPLE_MS);
    timer.unref();
  }, WARMUP_MS).unref();
}

// ---------------------------------------------------------------------------
// App lifecycle.
// ---------------------------------------------------------------------------

app.whenReady().then(() => {
  startPerfReport();
  Menu.setApplicationMenu(null); // no native File/Edit/View/Window/Help bar
  // Pre-warm the login-shell env snapshot (memoized) so the FIRST pane-open
  // already has the user's ~/.bashrc exports (MCP secrets) without paying the
  // shell hop on the click path. Fire-and-forget: pty-open awaits it regardless.
  resolveShellEnv();
  startPageProtocol(); // before the window: a frame may load deckpage:// at once
  createWindow({ onClosed: killAll });
  // Warn (non-blocking) if a host prerequisite the deck can't ship (claude/jq)
  // is missing, instead of letting the dependent feature no-op silently.
  runPreflight();
  startStatusWatcher();
  // Inter-session room: watch ~/.claude/rooms/main.jsonl and inject each
  // message into its target pane's pty (begins at EOF -> no backlog replay).
  startRoomRouter();
  // Usage page prices: apply the stored LiteLLM feed, refresh it monthly (bundled table otherwise).
  startPriceFeed();
  // Composer « / » list: apply the stored Claude Code command list, refresh it monthly (bundled list otherwise).
  startCommandsFeed();
  startUsageWatcher();
  startUsageTick();
  // Ask channel: route the hook's question requests to their pane
  // (fail-safe: on any error the deck runs without it and the hook falls back to the TUI).
  startAskWatcher();
  // Plugins: the daily rule, once per start. Quitting the Deck leaves a running plugin alone (no before-quit hook).
  startPlugins(composePlugins);
  // estimator cold pass: chunked (40+ MB of transcripts on a busy rig), the
  // UI shows source A meanwhile and upgrades when B lands
  startEstimatorColdPass();
});
app.on('before-quit', () => { killAll(); killAllPanelTerms(); });
app.on('window-all-closed', () => app.quit());
