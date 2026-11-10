// claude-deck — ipc/plans-panel (v40): plans the session made/consumed — list
// from the transcript truth (sessionPlans, same one-pass parse as the git
// panel), content lazy per plan. Same provenance discipline: the renderer
// addresses plans by INDEX into main's cached (sorted) list; absolute paths
// never cross the IPC boundary — only display names do.
'use strict';

const { ipcMain } = require('electron');
const fs = require('fs');
const fsp = require('fs/promises');
const { sessionPlans, effectiveSessionId } = require('../session-activity');
const { fileKeyOf } = require('../file-key');

const PLAN_MAX_BYTES = 1024 * 1024; // plans are tens of KB; 1MB = sanity cap

function registerPlansPanelIpc() {
  ipcMain.handle('plans-list', async (_e, target = {}) => {
    const sessionId = effectiveSessionId(target);
    if (!sessionId) return { ok: false, reason: 'no-session' };
    const plans = await sessionPlans(sessionId);
    return {
      ok: true,
      plans: plans.map((p) => ({
        kind: p.kind, name: p.name, written: p.written, events: p.events, ts: p.ts,
        exists: p.kind === 'inline' ? true : fs.existsSync(p.path),
      })),
    };
  });

  ipcMain.handle('plans-get', async (_e, { planIndex, expectName, ...target } = {}) => {
    const sessionId = effectiveSessionId(target);
    if (!sessionId || !Number.isInteger(planIndex)) return { ok: false, reason: 'bad-target' };
    const plans = await sessionPlans(sessionId);
    const p = plans[planIndex];
    if (!p) return { ok: false, reason: 'plan introuvable', stale: true };
    // Identity check: the live transcript can grow (and re-sort) between the
    // renderer's list and this get — if the index now points at a DIFFERENT
    // plan than the row the user clicked, refuse instead of serving the wrong
    // one; the renderer re-syncs its list.
    if (typeof expectName === 'string' && expectName && p.name !== expectName) {
      return { ok: false, reason: 'liste périmée — re-synchronisation', stale: true };
    }
    if (p.kind === 'inline') return { ok: true, name: p.name, markdown: p.content };
    try {
      const st = await fsp.stat(p.path);
      if (!st.isFile()) return { ok: false, reason: 'pas un fichier' };
      if (st.size > PLAN_MAX_BYTES) return { ok: false, reason: 'plan trop volumineux (>1MB)' };
      const markdown = await fsp.readFile(p.path, 'utf8');
      // The opaque identity of the file (same helper as files-read), so a plan and the Files tab share ONE ask thread list.
      const fileKey = fileKeyOf(await fsp.realpath(p.path));
      return { ok: true, name: p.name, markdown, fileKey };
    } catch (_) {
      return { ok: false, reason: 'fichier introuvable (supprimé ou déplacé)' };
    }
  });
}

module.exports = { registerPlansPanelIpc };
