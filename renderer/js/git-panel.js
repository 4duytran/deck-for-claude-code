// claude-deck — renderer/git-panel (v39): read-only review of the session
// workspace before commit. Status is CHEAP (load on open + manual refresh +
// session-idle signal); per-file diffs are LAZY (fetched on click only) and
// rendered by diff2html (unified or side-by-side: the width decides until the
// user picks a format in the diff bar). Keyboard-first: the arrow keys on the
// list, Enter focuses the diff, Esc closes. The panel never steals keys from
// a focused xterm.
// NOTE (P1-09): this panel is a TAB of the docked side panel (side-panel.js).
// Showing it closes the previously active tab through side-panel.js, so the
// old git-panel <-> plans-panel import is gone. A session change reloads it
// through side-panel's onPaneSelected slot.
'use strict';

import { panes, overlayState } from './state.js';
import { registerSideTab, showSideTab, closeSidePanel, sp, toggleSidePanelMax } from './side-panel.js';
import { openAsk, composeCodeMessage, placeBubbles } from './code-ask.js';
import { diffRangeFromSelection, diffRowKey, diffRowsByKey } from './diff-select.js';
import { collapse, expand, spinWhile } from './motion.js';
import { skeleton, progressBar } from './loading.js';
import { DIFF_OPTS, createFormatLatch, mountDiffSwitches, applyWrap, syncSplitRows, pruneWordMarks, fileHeader, autoHideScrollbar, statBar, mountGapRows, gapNotice } from './diff-view.js';
import { gaps, expand as spliceDiff, matches } from './diff-expand.js';
import { mountGitGraph } from './git-graph.js';
import { mountGitRefs } from './git-refs.js';
import { mountGitCommit } from './git-commit.js';

const GP_KIND_LABEL = { staged: 'Indexés', unstaged: 'Non indexés', untracked: 'Non suivis' };

// ---- History: branch column, two-lane log, header chips, the uncommitted row --------------------------------------
// gp.shown = { ref: { kind, name }, pinned }: an unpinned view follows HEAD on every load, a pick pins its ref.
// gp.hist = the loaded log (pages concatenated); gp.sel = the selected row key ('wip' or a sha); gp.detail = detail mode.
const GLOG_PAGE_CAP = 1000; // main refuses a page past it ('page'); the cap note then replaces « Charger … »
const GLOG_STATE = { never: 'jamais poussée', level: '✓ poussée sur origin', diverged: "pas au même niveau qu'origin" };
let glogGraph = null; // git-graph.js instance, mounted on first use
let glogRefs = null; // git-refs.js instance
let glogSeq = 0; // log-only loads (a pick, « Charger … ») drop their stale answers; gpSeq covers the full loads
let glogCommit = null; // git-commit.js instance (the commit detail column)
let glogCSeq = 0; // commit detail loads: only the latest selection paints
let gpDiffSeq = 0; // file diff loads (status rows and commit files): only the latest open paints
let gpDiffReady = false; // #gp-diff holds the answer of gp.diffRow (false: skeleton, dropped answer, or blanked)

function gpMountHistory() {
  glogRefs = mountGitRefs(document.getElementById('glog-refs'), { onPick: gpPick });
  glogGraph = mountGitGraph(document.getElementById('glog-log'), {
    onSelect: (key) => { gp.sel = key; gpShowDetail(); },
    onMore: gpLoadMore,
  });
  glogCommit = mountGitCommit(document.getElementById('glog-commit'), {
    onFile: gpCommitFile,
    onCopy: (sha) => { window.api.clipboardWrite(sha); },
  });
  // The three scrolling columns: branches, the commit list git-graph.js builds, the detail.
  for (const el of [document.getElementById('glog-refs'), document.querySelector('#glog-log .glog-list'), document.getElementById('glog-detail')]) {
    if (el) autoHideScrollbar(el);
  }
}

const gpDefaultRef = () => (gp.refs && gp.refs.head && gp.refs.head.branch
  ? { kind: 'local', name: gp.refs.head.branch } : { kind: 'head' });

// The uncommitted row (K12): HEAD rows only; a clean head with dirty lots gives the lots-only row; else no row.
function gpWip() {
  const n = gp.rows.filter((r) => r.wt === '').length;
  if (n > 0) return { files: n, lotsOnly: false };
  return gp.rows.length > 0 ? { files: 0, lotsOnly: true } : null;
}

function gpMergeChips(into, from) { // chips come per page and may repeat on a trunk view: exact duplicates are dropped
  for (const [sha, list] of Object.entries(from || {})) {
    const have = into[sha] || (into[sha] = []);
    for (const c of list) if (!have.some((x) => x.kind === c.kind && x.text === c.text)) have.push(c);
  }
  return into;
}

// #glog-badge / #glog-state: filled from the log answer, hidden while empty (a null state shows nothing).
function gpSetHeadChips(ans) {
  const badge = document.getElementById('glog-badge');
  const state = document.getElementById('glog-state');
  const b = ans ? (ans.isHead ? 'branche actuelle' : 'lecture seule') : '';
  badge.textContent = b;
  badge.hidden = !b;
  badge.dataset.current = ans && ans.isHead ? 'true' : 'false';
  const origin = (gp.refs && gp.refs.trunk && gp.refs.trunk.origin) || (ans && ans.target) || '';
  let s = '';
  if (ans && ans.state === 'trunk-level') s = origin ? `✓ à jour avec ${origin}` : '';
  else if (ans && ans.state === 'trunk-behind') s = origin ? `pas à jour avec ${origin}` : '';
  else if (ans && ans.state) s = GLOG_STATE[ans.state] || '';
  state.textContent = s;
  state.hidden = !s;
  if (s) state.dataset.state = ans.state; else delete state.dataset.state;
}

// Detail column: the uncommitted row shows the head groups then the lot groups ('wip'), or the lot groups alone ('lots');
// a commit row shows #glog-commit; no row (picker, error, non-repo) leaves the plain list.
function gpShowDetail() {
  const wip = gp.hist && gp.hist.wip;
  const mode = gp.sel === 'wip' ? (wip && wip.lotsOnly ? 'lots' : 'wip') : gp.sel ? 'commit' : 'plain';
  document.getElementById('glog-wip-head').hidden = mode !== 'wip';
  document.getElementById('glog-commit').hidden = mode !== 'commit';
  document.getElementById('gp-files').hidden = mode === 'commit';
  if ((mode !== gp.detail || !document.getElementById('glog-diff').hidden) && !gpDiffSourceStays(mode)) gpHideDiff(); // a diff never stays over another detail, nor past its row in the same one
  gp.detail = mode;
  if (mode === 'commit') gpShowCommit(); else gpDropCommit();
}

// The open file diff belongs to the row it came from (gp.diffRow): a #gp-files row stays while it is still listed and the mode
// is not 'commit' (which hides the list), a commit file row only in 'commit'. So the history's first select('wip') keeps a
// diff opened from the list, and a lots-only list closes the diff of a head row that was committed (same identity as gpReopenDiff).
function gpDiffSourceStays(mode) {
  const d = gp.diffRow;
  if (!d) return false;
  if (d.kind === 'commit') return mode === 'commit';
  return mode !== 'commit' && gp.rows.some((r) => r.kind === d.kind && r.path === d.path && (r.wt || '') === (d.wt || ''));
}

// The commit row's detail: gp.commit = { key, sha, res, state }. The key holds what the kicker reads, so a reload of the same
// data keeps the shown detail; a new sha fetches `git-panel-commit` (the latest selection wins) and shuts the previous diff.
function gpShowCommit() {
  const h = gp.hist;
  const sha = gp.sel;
  const row = (h && h.rows.find((r) => r.sha === sha)) || { sha };
  const labels = { ...(h && h.labels), view: h && h.ans ? h.ans.view : '' };
  const key = [sha, row.seg, row.inLocal, labels.view, labels.local, labels.target].join('\0');
  let c = gp.commit;
  if (c && c.key === key && c.state !== 'fail') return;
  if (!c || c.sha !== sha) { gpHideDiff(); c = null; }
  if (c && c.res) { c.key = key; gpPaintCommit(c, row, labels); return; }
  c = gp.commit = { key, sha, res: null, state: 'loading' };
  gpFetchCommit(c, row, labels);
}

async function gpFetchCommit(c, row, labels) {
  const seq = ++glogCSeq;
  const host = document.getElementById('glog-commit');
  host.replaceChildren(skeleton());
  const res = await window.api.gitCommit(gp.target, c.sha).catch(() => null);
  if (seq !== glogCSeq || !gp.open || gp.commit !== c) return; // stale: another selection, a close or a drop
  if (!res || !res.ok) {
    c.state = 'fail';
    const box = document.createElement('div');
    box.className = 'gp-empty';
    box.textContent = '⚠ commit indisponible';
    host.replaceChildren(box);
    return;
  }
  c.res = res;
  c.state = 'ok';
  gpPaintCommit(c, row, labels);
}

function gpPaintCommit(c, row, labels) {
  glogCommit.show(c.res, row, labels);
  const d = gp.diffRow; // a repaint keeps the mark of the file whose diff is open
  if (d && d.kind === 'commit' && d.sha === c.sha) {
    for (const b of document.querySelectorAll('#glog-commit button.glog-file')) {
      if (b.dataset.path === d.path) b.setAttribute('aria-current', 'true');
    }
  }
}

function gpDropCommit() {
  if (!gp.commit) return;
  gp.commit = null;
  glogCSeq++;
  if (glogCommit) glogCommit.clear();
}

// A file of the shown commit: its diff opens in #glog-diff as a row { path, kind: 'commit', sha } (glyph = the commit's letter).
function gpCommitFile(path) {
  const c = gp.commit;
  if (!gp.open || !c || !c.res) return;
  const f = (c.res.files || []).find((x) => x.path === path);
  gpOpenDiff({ path, kind: 'commit', sha: c.sha, glyph: f ? f.status : '', wt: '' }, -1, false);
}

function gpClearHistory() {
  glogSeq++;
  gp.hist = null;
  gp.sel = null;
  if (glogGraph) { glogGraph.setData({ rows: [] }); glogRefs.setData({}); glogRefs.setShown(null); }
  gpSetHeadChips(null);
  gpShowDetail();
}

function gpPaintHistory() {
  const h = gp.hist;
  glogGraph.setData({ rows: h.rows, chips: h.chips, view: h.ans.view, labels: h.labels, wip: h.wip, more: h.more, capped: h.capped });
}

// Keeps the selection when its row survives; else the uncommitted row (lots-only included); else the tip.
function gpSelectDefault() {
  const h = gp.hist;
  const known = (k) => (k === 'wip' ? !!h.wip : h.rows.some((r) => r.sha === k));
  const tip = h.rows.some((r) => r.sha === h.ans.ref.sha) ? h.ans.ref.sha : (h.rows[0] && h.rows[0].sha);
  gp.sel = gp.sel && known(gp.sel) ? gp.sel : (h.wip ? 'wip' : tip || null);
  if (gp.sel) glogGraph.select(gp.sel);
  gpShowDetail();
}

// Status answered a repo: refs first (they name HEAD for the default view), then the log of the shown ref.
async function gpLoadHistory(seq, t, st) {
  if (!glogGraph) gpMountHistory();
  const refs = await window.api.gitRefs(t).catch(() => null);
  if (seq !== gpSeq || !gp.open) return;
  gp.refs = refs && refs.ok ? refs : null;
  gp.headBranch = st.branch;
  glogRefs.setData(gp.refs || {});
  if (!gp.shown || !gp.shown.pinned) gp.shown = { ref: gpDefaultRef(), pinned: false };
  return gpShowLog(seq, t);
}

// Page 0 of the shown ref, painted. A stale answer (newer load, pick, close) is dropped.
async function gpShowLog(seq, t) {
  const lseq = ++glogSeq;
  const live = () => seq === gpSeq && lseq === glogSeq && gp.open;
  let ans = await window.api.gitLog(t, gp.shown.ref, 0).catch(() => null);
  if (!live()) return;
  if (gp.shown.pinned && ans && ans.ok === false && ans.reason === 'ref') { // the pick is gone: back to HEAD
    gp.shown = { ref: gpDefaultRef(), pinned: false };
    ans = await window.api.gitLog(t, gp.shown.ref, 0).catch(() => null);
    if (!live()) return;
  }
  if (!ans || !ans.ok) { gpClearHistory(); return; }
  const trunk = (gp.refs && gp.refs.trunk) || {};
  const labels = { branch: ans.ref.name, target: ans.target || '', local: trunk.local || trunk.family || '' };
  const wip = ans.isHead ? gpWip() : null;
  const sig = JSON.stringify([ans, wip, labels]);
  if (!gp.hist || gp.hist.sig !== sig) { // identical data keeps the loaded pages
    gp.hist = { sig, ans, rows: ans.rows, chips: gpMergeChips({}, ans.chips), labels, wip, page: 0, more: ans.more === true, capped: false };
    gpPaintHistory();
  }
  gpSetBranch(ans.ref.kind === 'head' ? gp.headBranch : ans.ref.name);
  gpSetHeadChips(ans);
  glogRefs.setShown(ans.ref.kind === 'head' ? null : { kind: ans.ref.kind, name: ans.ref.name });
  gpSelectDefault();
}

function gpPick(ref) {
  if (!gp.open || !gp.target) return;
  gp.shown = { ref: { kind: ref.kind, name: ref.name }, pinned: true };
  gp.sel = null;
  gp.hist = null;
  gpShowLog(gpSeq, gp.target);
}

// « Charger 50 commits de plus »: the next page joins the loaded rows and chips (append() takes no chips).
async function gpLoadMore() {
  const h = gp.hist;
  if (!h || h.busy || !h.more) return;
  const seq = gpSeq;
  const lseq = glogSeq;
  const page = h.page + 1;
  h.busy = true;
  const ans = await window.api.gitLog(gp.target, gp.shown.ref, page).catch(() => null);
  h.busy = false;
  if (seq !== gpSeq || lseq !== glogSeq || !gp.open || gp.hist !== h) return;
  if (ans && ans.ok) {
    h.rows = h.rows.concat(ans.rows);
    gpMergeChips(h.chips, ans.chips);
    h.page = page;
    h.capped = ans.more === true && page >= GLOG_PAGE_CAP;
    h.more = ans.more === true && !h.capped;
  } else if (ans && ans.reason === 'page') {
    h.more = false;
    h.capped = true;
  } else return; // another failure: the button stays, the user can retry
  gpPaintHistory();
}
const gpLatch = createFormatLatch(); // width decides the format until the user picks one in the diff bar
let gpSwitches = null; // { setFormat } of the diff bar, mounted by initGitPanel
// v39.2: target = { paneId?, sessionId?, repoIndex? } — ids only. repoIndex
// addresses main's cached list of repos THIS SESSION touched (transcript
// truth); null means "let main decide" (picker if several, straight in if one).
export const gp = { open: false, target: null, rows: [], selected: -1,
  editors: null /* v53: cached open-with editor list (fetched once) */,
  lastRender: null /* { idx, full, format, res } — re-render key; res = the fetched diff, repainted without a second fetch */,
  // roots = target key -> repo root of the last status answer (nothing reads it since the compare pick left;
  // git-wt-ui-probe still clears it); root = shown repo.
  roots: new Map(), root: null,
  folds: new Map() /* repo root -> Set of folded "kind\0dir" keys, kept for the app run */ };
let gpSeq = 0; // the latest load wins: a slow answer never paints over a newer one
// The panel maximized the side panel itself (A11): leaving restores it and one Escape closes the panel.
// A user maximize (#sp-max, or made before the tab opened) stays, and Escape restores it first.
let gpAutoMax = false;
let gpIdleRefreshTimer = 0;

// Middle-truncate, tail-biased: the filename + extension stay readable.
function gpTruncate(p, max = 48) {
  if (p.length <= max) return p;
  const tail = Math.ceil(max * 0.62);
  return p.slice(0, max - tail - 1) + '…' + p.slice(-tail);
}

// Public entry (name and behaviour kept): shows the Git tab for `target`.
export function openGitPanel(target) { gpActivate(target, true); }

// focus=false on a session-change reload: the terminal just selected keeps the keys.
function gpActivate(target, focus) {
  const wasOpen = gp.open; // a session-change reload re-enters here: it never maximizes again
  overlayState.closeUsagePage?.(); // usage page: same rule (slot self-assigned by usage.js)
  overlayState.closeAgentJournal?.(); // S6b: journal-centric exclusivity (aj11); UD4/C7 — the room overlay is a pre-existing, out-of-scope coexistence, untouched here
  gp.target = { ...target, repoIndex: null };
  gp.open = true;
  gp.selected = -1;
  showSideTab('git', target); // closes the previous tab, unhides the panel
  if (!wasOpen && !sp.max) { // A11 / K8, the pattern of mr-review.js: the log wants room
    gpAutoMax = true;
    toggleSidePanelMax();
  }
  gpHideDiff();
  document.getElementById('gp-diff').innerHTML =
    '<div class="gp-empty">Sélectionne un fichier pour voir son diff</div>';
  // preventScroll (rule 8): a default focus() can scroll the whole document sideways.
  if (focus) document.getElementById('gp-files').focus({ preventScroll: true });
  gpLoadStatus();
}

// Closes the whole side panel when the Git tab is the active one.
export function closeGitPanel() { if (gp.open) closeSidePanel(); }

// The tab's own state reset — side-panel.js calls it when the panel closes or
// another tab is shown; it never calls back into the panel.
function gpDeactivate() {
  gpCloseOpenMenu(); // v53: never leave the open-with chooser orphaned
  gp.open = false;
  gp.target = null;
  gpHideDiff();
  gpDropCommit();
  if (gpAutoMax) { // a panel close already restored it; a switch to another tab did not
    gpAutoMax = false;
    if (sp.max) toggleSidePanelMax();
  }
}

const GP_ROOT_LABEL = '(racine)';
const gpDirOf = (p) => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); };
// A lot's folders fold on their own: the worktree id prefixes the key (the head, wt '', keeps today's key).
const gpFoldKey = (wt, kind, dir) => `${wt ? `${wt}\0` : ''}${kind}\0${dir}`;
const gpDirKey = (e) => gpFoldKey(e.wt, e.kind, gpDirOf(e.path));

function gpFolds() {
  const k = gp.root || '';
  if (!gp.folds.has(k)) gp.folds.set(k, new Set());
  return gp.folds.get(k);
}

// One folder of one kind group: a fold button, then its rows in ONE wrapper so a single
// collapse / expand animates the folder (per-row calls would measure every follower N times).
function gpDirGroup(kind, dir, entries, wt) {
  const key = gpFoldKey(wt, kind, dir);
  const folds = gpFolds();
  const folded = folds.has(key);
  const wrap = document.createElement('div');
  wrap.className = 'gp-dir';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'dv-dir';
  btn.setAttribute('aria-expanded', folded ? 'false' : 'true');
  const chev = document.createElement('span');
  chev.className = 'dv-chev';
  chev.setAttribute('aria-hidden', 'true');
  const name = document.createElement('span');
  name.className = 'gp-dir-name';
  name.textContent = dir || GP_ROOT_LABEL;
  name.title = dir;
  const count = document.createElement('span');
  count.className = 'dv-count';
  count.textContent = String(entries.length);
  const ico = document.createElement('i'); // folder icon, drawn by style.css
  ico.className = 'gp-dir-ico';
  ico.setAttribute('aria-hidden', 'true');
  btn.append(chev, ico, name, count);
  const body = document.createElement('div');
  body.className = 'gp-dir-rows';
  if (folded) body.style.display = 'none'; // end state, inline
  for (const e of entries) {
    const idx = gp.rows.length;
    gp.rows.push(e);
    body.appendChild(gpRow(e, idx));
  }
  btn.addEventListener('click', () => {
    const now = !folds.has(key);
    if (now) folds.add(key); else folds.delete(key);
    btn.setAttribute('aria-expanded', now ? 'false' : 'true');
    (now ? collapse : expand)(body);
  });
  wrap.append(btn, body);
  return wrap;
}

// The status letter of an entry (list pill and diff header); an unknown letter gives '' (rule 7).
const gpStatusLetter = (entry) => (entry.kind === 'untracked' ? 'A' : (/^[MADR]$/.test(entry.glyph) ? entry.glyph : ''));

function gpRow(entry, idx) {
  const row = document.createElement('div');
  row.className = 'gp-row';
  row.dataset.idx = idx;
  if (idx === gp.selected) row.classList.add('selected');
  const glyph = document.createElement('span');
  glyph.className = `gp-glyph gp-g-${entry.kind === 'untracked' ? 'new' : entry.glyph.toLowerCase()}`;
  glyph.textContent = entry.kind === 'untracked' ? '?' : entry.glyph;
  const st = gpStatusLetter(entry);
  const name = document.createElement('span');
  name.className = 'gp-path';
  name.textContent = entry.from
    ? `${gpTruncate(entry.from, 20)} → ${gpTruncate(entry.path, 26)}`
    : gpTruncate(entry.path);
  name.title = entry.from ? `${entry.from} → ${entry.path}` : entry.path;
  row.append(glyph);
  if (st) { // an unknown status letter shows no pill (rule 7)
    const pill = document.createElement('span');
    pill.className = 'dv-pill';
    pill.dataset.st = st;
    pill.textContent = st;
    row.append(pill);
  }
  row.append(name);
  if (entry.pills) { // 5-block diffstat bar; the numbers stay in the title
    const stat = document.createElement('span');
    stat.className = 'gp-stat';
    stat.title = `+${entry.pills.adds} −${entry.pills.dels}`;
    stat.appendChild(statBar(entry.pills.adds, entry.pills.dels));
    row.appendChild(stat);
  } else if (entry.kind === 'untracked') {
    const badge = document.createElement('span');
    badge.className = 'gp-pills';
    badge.innerHTML = '<i class="gp-add">new</i>';
    row.appendChild(badge);
  }
  // step-4 row actions (hover-revealed): copy path / open in editor. Both
  // stopPropagation — an action click must not also select + fetch the diff.
  const acts = document.createElement('span');
  acts.className = 'gp-acts';
  const copyBtn = document.createElement('button');
  copyBtn.className = 'gp-act';
  copyBtn.title = 'Copier le chemin';
  copyBtn.textContent = '⧉';
  copyBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    window.api.clipboardWrite(entry.path);
    copyBtn.textContent = '✓'; // tiny ack, reverts on next render
    setTimeout(() => { copyBtn.textContent = '⧉'; }, 900);
  });
  const openBtn = document.createElement('button');
  openBtn.className = 'gp-act';
  openBtn.title = "Ouvrir dans l'éditeur";
  openBtn.textContent = '↗';
  openBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    gpOpenMenu(openBtn, entry); // v53: chooser — pick the editor per click
  });
  acts.append(copyBtn, openBtn);
  row.appendChild(acts);
  row.addEventListener('click', () => gpLoadDiff(idx));
  return row;
}

// v53 open-with chooser — the ↗ action opens a small menu of the GUI editors
// main detected on PATH (+ system default); the user picks per click. The list
// can't change during the session, so it's fetched once and cached on gp.
async function gpEditors() {
  if (gp.editors) return gp.editors;
  const res = await window.api.gitEditors().catch(() => null);
  gp.editors = res && res.ok ? res.editors : [];
  return gp.editors;
}

function gpCloseOpenMenu() {
  const m = document.getElementById('gp-open-menu');
  if (m) m.remove();
  document.removeEventListener('click', gpOpenMenuAway, true);
}

// Outside-click dismiss (capture so it sees the click before row handlers).
function gpOpenMenuAway(e) {
  const m = document.getElementById('gp-open-menu');
  if (m && !m.contains(e.target)) gpCloseOpenMenu();
}

async function gpOpenMenu(anchor, entry) {
  gpCloseOpenMenu();
  const editors = await gpEditors();
  if (!gp.open) return; // panel closed during the async fetch
  const menu = document.createElement('div');
  menu.id = 'gp-open-menu';
  menu.className = 'gp-open-menu';
  menu.setAttribute('role', 'menu'); // a11y: match #ctx-menu / #new-menu pattern
  const items = [...editors, { id: 'system', label: 'Éditeur système' }];
  for (const ed of items) {
    const b = document.createElement('button');
    b.className = 'gp-open-item';
    b.setAttribute('role', 'menuitem');
    b.tabIndex = -1; // roving focus, out of the document tab order
    b.textContent = ed.label;
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      gpCloseOpenMenu();
      window.api.gitOpenFile(gp.target, entry.path, ed.id, entry.wt).catch(() => {});
    });
    menu.appendChild(b);
  }
  document.body.appendChild(menu);
  // Anchor under the ↗ button, right-aligned, clamped into the viewport.
  const r = anchor.getBoundingClientRect();
  const left = Math.max(4, r.right - menu.offsetWidth);
  let top = r.bottom + 4;
  if (top + menu.offsetHeight > window.innerHeight - 4) top = r.top - menu.offsetHeight - 4;
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
  // Keyboard-first (the panel's own claim): land on item 1, arrows rove, Enter
  // activates. Esc bubbles to the panel keydown (closes the menu, keeps panel).
  menu.addEventListener('keydown', (ev) => {
    const its = [...menu.querySelectorAll('.gp-open-item')];
    const i = its.indexOf(document.activeElement);
    if (ev.key === 'ArrowDown') { ev.preventDefault(); its[(i + 1) % its.length].focus(); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); its[(i - 1 + its.length) % its.length].focus(); }
    else if (ev.key === 'Enter' && document.activeElement) { ev.preventDefault(); document.activeElement.click(); }
  });
  (menu.querySelector('.gp-open-item') || menu).focus();
  // Defer the outside-click binding one tick so THIS opening click doesn't also
  // trip the dismiss handler and close the menu immediately. (Esc is handled
  // by the panel's own keydown so it can keep the panel open — see initGitPanel.)
  setTimeout(() => {
    if (document.getElementById('gp-open-menu')) {
      document.addEventListener('click', gpOpenMenuAway, true);
    }
  }, 0);
}

// Cache key of a panel target (see gp.roots).
const gpTargetKey = (t) =>
  `${t.paneId || ''}|${t.sessionId || ''}|${Number.isInteger(t.repoIndex) ? t.repoIndex : ''}`;

// Heading of a lot group in the worktree view; a detached lot (no branch) names no branch.
const gpLotText = (name, branch, head) => `En cours dans ${name}${branch ? ` (${branch})` : ''}, pas encore dans ${head}`;

// Head piece. The ref name is repo-controlled: textContent only. The text of the branch pill stays « ⎇ name »
// (the glyph span is the no-CSS fallback, style.css draws the branch icon in its place).
function gpSetBranch(name) {
  const el = document.getElementById('gp-branch');
  el.textContent = '';
  if (!name) return;
  const ico = document.createElement('span');
  ico.className = 'gp-branch-ico';
  ico.setAttribute('aria-hidden', 'true');
  ico.textContent = '⎇ ';
  const label = document.createElement('span');
  label.className = 'gp-branch-name';
  label.textContent = name;
  label.title = name;
  el.append(ico, label);
}

let gpBar = null; // the strip of a user-started refresh over kept rows
let gpPainted = null; // the target object the last settled load painted for

// Wait marker of a load that starts now. No row yet: placeholder rows, except that an automatic reload keeps the
// settled empty or error text of its own target (it would flash). Rows kept: a strip on top, only when the user asked.
// Every paint of a load replaces the host content, which drops the marker; a newer load drops the strip first.
function gpWait(filesEl, t, user) {
  if (gpBar) gpBar.remove();
  gpBar = null;
  if (!filesEl.querySelector('.gp-row')) {
    const keep = filesEl.querySelector('.gp-skeleton')
      || (!user && gpPainted === t && filesEl.querySelector('.gp-empty'));
    if (!keep) filesEl.replaceChildren(skeleton());
  } else if (user) {
    gpBar = progressBar();
    filesEl.prepend(gpBar);
  }
}

// `{ user: true }`: the refresh button only; every other caller is an automatic or navigational reload.
export function gpLoadStatus(opts) { return gpLoad(false, !!(opts && opts.user === true)); }

async function gpLoad(adopted, user = false) {
  if (!gp.open || !gp.target) return;
  const seq = ++gpSeq;
  const t = gp.target;
  const filesEl = document.getElementById('gp-files');
  gpWait(filesEl, t, user);
  const st = await window.api.gitStatus(t).catch(() => null);
  if (seq !== gpSeq || !gp.open) return; // closed while loading, or a newer load took over
  if (st && st.ok && st.root) {
    gp.root = st.root;
    gp.roots.set(gpTargetKey(t), st.root);
    if (Number.isInteger(st.repoIndex)) gp.roots.set(gpTargetKey({ ...t, repoIndex: st.repoIndex }), st.root);
    // A session repo reached from its workspace folder: run once more, addressed by the repoIndex main named.
    if (!adopted && Number.isInteger(st.repoIndex) && t.repoIndex !== st.repoIndex) {
      t.repoIndex = st.repoIndex;
      return gpLoad(true, user);
    }
  }
  gpPainted = t;
  overlayState.onGitRepo?.(gp.target, st && st.ok && st.root ? st.root : null); // root null: nothing settled, no MR entry
  // A5: repo and shown ref only. #glog-badge / #glog-state are slots filled from the log answer, never from here.
  if (st && st.ok && (gp.histTarget !== t || gp.histRoot !== (st.root || ''))) { // a new opening or another repo: the pin goes
    gp.shown = null;
    gp.sel = null;
    gp.hist = null;
    gp.histTarget = t;
    gp.histRoot = st.root || '';
  }
  const head = (repo, branch) => {
    document.getElementById('gp-repo').textContent = repo;
    gpSetBranch(branch && gp.shown && gp.shown.pinned ? gp.shown.ref.name : branch); // a pinned view names its own ref
  };
  // The log needs a repo answer, never a picker, a non-repo or an error one. The rest of this load paints the file
  // list synchronously, so gp.rows is complete when the history answers resume.
  if (st && st.ok && !st.repoPicker && !st.notRepo) {
    if (Number.isInteger(st.repoIndex)) t.repoIndex = st.repoIndex;
    gpLoadHistory(seq, t, st);
  } else { gpHideDiff(); gpClearHistory(); } // the file list is replaced (picker, non-repo, error): a status diff has no row left
  if (!st || !st.ok) {
    head('git', '');
    // st.reason is RAW git/simple-git stderr — repo-controlled strings
    // (branch names, paths) must never hit innerHTML. DOM + textContent.
    filesEl.textContent = '';
    const errBox = document.createElement('div');
    errBox.className = 'gp-empty';
    errBox.textContent = '⚠ status indisponible';
    const why = st && st.reason;
    if (why) {
      const small = document.createElement('small');
      small.textContent = why;
      errBox.appendChild(small);
    }
    filesEl.appendChild(errBox);
    gp.rows = [];
    return;
  }
  if (st.repoPicker) {
    // v39.2: multi-project session — ONLY the repos this session touched
    // (transcript truth), each with its touched-events count. Names are
    // repo-controlled strings: DOM + textContent, never innerHTML.
    gp.rows = [];
    head('session', '');
    filesEl.textContent = '';
    const h = document.createElement('h4');
    h.textContent = 'Projets de la session';
    filesEl.appendChild(h);
    st.repos.forEach((r, i) => {
      const row = document.createElement('div');
      row.className = 'gp-row';
      const glyph = document.createElement('span');
      glyph.className = 'gp-glyph gp-g-r';
      glyph.textContent = '⎇';
      const label = document.createElement('span');
      label.className = 'gp-path';
      label.textContent = r.name;
      const pills = document.createElement('span');
      pills.className = 'gp-pills';
      const i1 = document.createElement('i');
      i1.className = 'gp-add';
      i1.textContent = `${r.count} éditions`;
      pills.appendChild(i1);
      row.append(glyph, label, pills);
      row.addEventListener('click', () => {
        gp.target.repoIndex = i;
        gpLoadStatus();
      });
      filesEl.appendChild(row);
    });
    document.getElementById('gp-diff').innerHTML =
      '<div class="gp-empty">session multi-projets — sélectionne un projet à gauche</div>';
    return;
  }
  if (st.notRepo) {
    gp.rows = [];
    head('—', '');
    filesEl.innerHTML = st.sessionScoped
      ? '<div class="gp-empty">aucun projet git touché par cette session</div>'
      : '<div class="gp-empty">pas un dépôt git</div>';
    const repos = document.createElement('div'); // the folder's GitLab repos, painted by mr-review.js; in the DOM at once (rule 8)
    repos.className = 'gp-mr-repos';
    filesEl.appendChild(repos);
    overlayState.onGitFolder?.(gp.target, repos);
    return;
  }
  // v39.2: adopt main's effective index — a 1-repo session is entered
  // straight server-side; the lazy diff calls must address the SAME repo.
  if (Number.isInteger(st.repoIndex)) gp.target.repoIndex = st.repoIndex;
  const groups = [['staged', st.staged], ['unstaged', st.unstaged], ['untracked', st.untracked]];
  // Worktree view: the head groups above (wt ''), then ONE group per lot holding its changed + untracked rows. A lot with
  // nothing to show has no group.
  const sections = groups.map(([kind, list]) => ({ wt: '', kind, parts: [[kind, list]], n: list.length }));
  for (const lot of (st.worktree && Array.isArray(st.worktree.lots) ? st.worktree.lots : [])) {
    const parts = [['changed', lot.files || []], ['untracked', lot.untracked || []]];
    const n = parts[0][1].length + parts[1][1].length;
    if (n) sections.push({ wt: lot.id, lot, parts, n });
  }
  // v39.1 breadcrumb: inside a picked child repo, the repo name becomes a
  // "← back" affordance to the workspace repo list.
  head(st.repo, `${st.branch}`);
  // Breadcrumb only when a picker exists (multi-project session).
  const repoEl = document.getElementById('gp-repo');
  const hasPicker = (st.sessionRepos || 0) > 1;
  repoEl.classList.toggle('gp-back', hasPicker);
  if (hasPicker) {
    repoEl.textContent = `← ${st.repo}`;
    repoEl.title = 'Revenir aux projets de la session';
    repoEl.onclick = () => { gp.target.repoIndex = null; gpLoadStatus(); };
  } else {
    repoEl.title = '';
    repoEl.onclick = null;
  }
  if (st.clean) {
    filesEl.textContent = '';
    const none = document.createElement('div');
    none.className = 'gp-empty';
    none.textContent = st.scoped ? 'aucun fichier modifié par cette session ✓' : 'working tree clean ✓';
    filesEl.appendChild(none);
    gp.rows = [];
    gp.selected = -1;
    if (!gp.diffRow || gp.diffRow.kind !== 'commit') { // an open commit file diff belongs to its commit, not to this list
      document.getElementById('gp-diff').innerHTML = '';
      gpDiffReady = false;
      gpHideDiff();
    }
    return;
  }
  // Flat row list (keyboard nav) + grouped render. Selection survives a
  // refresh when the same (kind, path) is still present.
  const prev = gp.rows[gp.selected];
  const keepTop = filesEl.scrollTop; // a refresh keeps the user's place in the list
  gp.rows = [];
  filesEl.textContent = '';
  for (const sec of sections) {
    if (!sec.n) continue;
    const h = document.createElement('h4');
    if (sec.lot) { // names are repo-controlled: textContent only; the chip repeats the lot name for the eye (CSS .gp-src-tag)
      h.textContent = `${gpLotText(sec.lot.name, sec.lot.branch, sec.lot.base)} (${sec.n})`;
      const tag = document.createElement('span');
      tag.className = 'gp-src-tag';
      tag.textContent = sec.lot.name;
      tag.title = sec.lot.name;
      tag.style.textTransform = 'none'; // the heading is upper-cased by style.css: a worktree name keeps its case
      h.append(' ', tag);
    } else {
      h.textContent = `${GP_KIND_LABEL[sec.kind]} (${sec.n})`;
    }
    filesEl.appendChild(h);
    // Folders in order of first appearance; gp.rows follows the DOM so selection, the arrow keys and the diff agree.
    for (const [kind, list] of sec.parts) {
      const byDir = new Map();
      for (const entry of list) {
        const e = { ...entry, kind, wt: sec.wt };
        const d = gpDirOf(e.path);
        if (!byDir.has(d)) byDir.set(d, []);
        byDir.get(d).push(e);
      }
      for (const [dir, entries] of byDir) filesEl.appendChild(gpDirGroup(kind, dir, entries, sec.wt));
    }
  }
  // Row identity is wt|kind|path: the same path in the head and in a lot are two rows.
  gp.selected = prev
    ? gp.rows.findIndex((r) => r.wt === prev.wt && r.kind === prev.kind && r.path === prev.path)
    : -1;
  if (gp.selected >= 0) gpHighlight(false);
  filesEl.scrollTop = keepTop;
}

// `reveal`: a user move scrolls the selected row into view; a refresh only repaints the highlight.
function gpHighlight(reveal) {
  document.querySelectorAll('#gp-files .gp-row').forEach((r) =>
    r.classList.toggle('selected', Number(r.dataset.idx) === gp.selected));
  const sel = document.querySelector('#gp-files .gp-row.selected');
  if (reveal && sel) sel.scrollIntoView({ block: 'nearest' });
}

// The file diff overlay (#glog-diff) covers the log column: gpLoadDiff opens it, « ← Historique » and the close button shut it.
function gpHideDiff() {
  gpDiffSeq++; // a diff still on its way never paints into a closed overlay
  const el = document.getElementById('glog-diff');
  if (el) el.hidden = true;
}

// Enter on the selected status row: the overlay may still hold a commit file's diff or an unpainted skeleton, so it is only
// un-hidden when it holds THIS row's painted answer (same worktree, kind and path); otherwise the row's diff is loaded.
function gpReopenDiff() {
  const row = gp.rows[gp.selected];
  const d = gp.diffRow;
  if (row && d && gpDiffReady && d.kind === row.kind && d.path === row.path && (d.wt || '') === (row.wt || '')) {
    document.getElementById('glog-diff').hidden = false;
    return;
  }
  gpLoadDiff(gp.selected);
}

export async function gpLoadDiff(idx, full = false) {
  const row = gp.rows[idx];
  if (!row) return;
  gp.selected = idx;
  gpHighlight(!full); // "voir tout" re-fetches the same row: no list scroll
  return gpOpenDiff(row, idx, full);
}

// Opens #glog-diff on `row` and paints its diff: a status row (kind staged / unstaged / untracked / changed, idx >= 0, rides
// gitDiff) or a commit file (kind 'commit', sha, idx -1, rides gitCommitDiff). gp.diffRow = the row the overlay belongs to.
async function gpOpenDiff(row, idx, full) {
  const seq = ++gpDiffSeq;
  const commit = row.kind === 'commit';
  gp.diffRow = row;
  gpDiffReady = false;
  document.getElementById('glog-diff').hidden = false; // before the fetch: the skeleton shows in the overlay
  const diffEl = document.getElementById('gp-diff');
  diffEl.replaceChildren(skeleton());
  const res = await (commit
    ? window.api.gitCommitDiff(gp.target, row.sha, row.path, full)
    : window.api.gitDiff(gp.target, row.path, row.kind, full, undefined, row.wt || undefined)).catch(() => null);
  if (!gp.open || seq !== gpDiffSeq || (!commit && gp.rows[gp.selected] !== row)) return; // stale response — drop
  gpDiffReady = true; // whatever paints below (diff, note or error) is this row's answer
  if (!res || !res.ok) {
    diffEl.innerHTML = '<div class="gp-empty">⚠ diff indisponible</div>';
    if (res && res.reason === 'wt') gpLoadStatus(); // the lot is gone since the list was built: rebuild the list
    return;
  }
  if (res.binary) {
    diffEl.innerHTML = '<div class="gp-empty">fichier binaire modifié — pas de rendu</div>';
    return;
  }
  if (res.symlink) {
    // Untracked symlink: rendering would show the TARGET's content (possibly
    // outside the repo) — name the link, never render through it.
    diffEl.textContent = '';
    const box = document.createElement('div');
    box.className = 'gp-empty';
    box.textContent = `lien symbolique → ${res.target} — contenu non affiché`;
    diffEl.appendChild(box);
    return;
  }
  if (!res.diff || !res.diff.trim()) {
    diffEl.innerHTML = '<div class="gp-empty">aucun diff</div>';
    return;
  }
  gpPaintDiff(idx, row, full, res, false);
}

// Paints a fetched diff: one section per file (sticky header + body). The format comes from the latch (the width until the user
// picks one). `keepScroll` repaints in place (a format pick or a threshold crossing) without a second fetch.
function gpPaintDiff(idx, row, full, res, keepScroll) {
  const diffEl = document.getElementById('gp-diff');
  const format = gpLatch.wanted(diffEl.clientWidth);
  const top = keepScroll ? diffEl.scrollTop : 0;
  const opts = { ...DIFF_OPTS, outputFormat: format };
  const files = Diff2Html.parse(res.diff, opts);
  diffEl.innerHTML = res.capped
    ? `<div class="gp-capped">diff tronqué à la frontière de hunk — ${res.totalLines} lignes au total
         <button class="gp-more">voir tout</button></div>`
    : '';
  for (const f of files) diffEl.append(gpFileSection(diffEl, row, f, files.length === 1, opts));
  const canExpand = gpExpandable(row, res, files);
  if (canExpand) gpMountGaps(diffEl, row, res);
  const more = diffEl.querySelector('.gp-more');
  if (more) more.addEventListener('click', () => (row.kind === 'commit' ? gpOpenDiff(row, idx, true) : gpLoadDiff(idx, true)));
  pruneWordMarks(diffEl);
  if (format === 'side-by-side') syncSplitRows(diffEl);
  diffEl.scrollTop = top;
  gp.lastRender = { idx, row, full, format, res, canExpand };
  if (res.fileLines === undefined) { // first paint of this answer: one read of the new side gives the line count below the last hunk
    res.fileLines = null;
    if (canExpand && !res.capped) gpPrefetchLines(row);
  }
  if (gpSwitches) gpSwitches.setFormat(format);
  gpWireAsk(diffEl);
  placeBubbles(gpAskScope(row), gpPlaceBubble);
  // v54: mount the sticky proxy AFTER layout — scrollWidth is unreliable in the
  // same tick on a large diff. Re-check lastRender so a fast re-render wins.
  requestAnimationFrame(() => { if (gp.lastRender && gp.lastRender.row === row) gpMountHScroll(diffEl); });
}

const GP_SPLICE_CAP_LINES = 1500; // = GIT_DIFF_CAP_LINES of main: a spliced diff past it is refused, never truncated

// Context expansion needs one text file with a diff against a known new side: not a new / deleted / untracked / binary / symlink row.
function gpExpandable(row, res, files) {
  if (files.length !== 1 || res.binary || res.symlink || row.kind === 'untracked') return false;
  return !files[0].isNew && !files[0].isDeleted && !files[0].isBinary;
}

// The request of the file read: the diff channels' own args, so main picks the side the diff was made against.
function gpFileReq(row) {
  return row.kind === 'commit' ? { file: row.path, sha: row.sha } : { file: row.path, kind: row.kind, wt: row.wt || undefined };
}

const gpLineCount = (text) => (text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0);

// Gap rows come from the hunk headers (above, between) and from the file length (below the last hunk, never on a capped diff).
function gpMountGaps(diffEl, row, res) {
  const g = gaps(res.diff, res.capped || typeof res.fileLines !== 'number' ? null : res.fileLines);
  if (g) mountGapRows(diffEl, g, (pick) => gpSplice(row, pick));
}

// The read behind the « below last » count; the answer lands without a repaint and is dropped once another row owns the view.
function gpPrefetchLines(row) {
  Promise.resolve(window.api.gitFileAt(gp.target, gpFileReq(row))).catch(() => null).then((a) => {
    const shown = gp.lastRender;
    if (!gp.open || !shown || shown.row !== row || !a || !a.ok || typeof a.text !== 'string') return;
    shown.res.fileLines = gpLineCount(a.text);
    const diffEl = document.getElementById('gp-diff');
    gpMountGaps(diffEl, row, shown.res);
    if (shown.format === 'side-by-side') syncSplitRows(diffEl);
  });
}

// The folded hunks of the first table, by header text (the gap strips are not part of it).
function gpFoldedHeads(diffEl) {
  const table = diffEl.querySelector('.d2h-diff-table');
  const rows = table ? [...table.querySelectorAll(':scope > tbody > tr')].filter((tr) => tr.querySelector('.d2h-info')) : [];
  return rows.map((tr) => ({ tr, text: gpHeadText(tr) }));
}

function gpHeadText(tr) {
  const cell = tr.lastElementChild.cloneNode(true);
  cell.querySelectorAll('.dx-gap').forEach((el) => el.remove());
  return cell.textContent.trim();
}

// A pick on a gap row: the file is read again (the worktree and the index move), checked against the diff, spliced, repainted in place.
async function gpSplice(row, pick) {
  const at = gp.lastRender;
  if (!gp.open || !at || at.row !== row) return;
  const res0 = at.res;
  const a = await Promise.resolve(window.api.gitFileAt(gp.target, gpFileReq(row))).catch(() => null);
  const shown = gp.lastRender;
  if (!gp.open || !shown || shown.row !== row || shown.res !== res0) return; // late answer: the user moved on or the diff changed
  const diffEl = document.getElementById('gp-diff');
  if (a && a.ok && a.capped) { gapNotice(diffEl, 'Fichier trop volumineux pour déplier'); return; }
  if (!a || !a.ok || a.binary || typeof a.text !== 'string') return;
  if (!matches(res0.diff, a.text)) { gapNotice(diffEl, 'Fichier modifié depuis le diff — rafraîchir'); return; }
  const next = spliceDiff(res0.diff, a.text, pick);
  if (next === null || next === res0.diff) return;
  if (next.split('\n').length > GP_SPLICE_CAP_LINES) { gapNotice(diffEl, 'Diff trop long — ouvre le fichier'); return; }
  const folded = new Set(gpFoldedHeads(diffEl).filter((h) => h.tr.classList.contains('gp-folded')).map((h) => h.text));
  gpPaintDiff(shown.idx, row, shown.full, { ...res0, diff: next, fileLines: gpLineCount(a.text) }, true);
  for (const h of gpFoldedHeads(diffEl)) if (folded.has(h.text)) h.tr.lastElementChild.click(); // the fold handler toggles it back
}

// `.dv-file` = sticky header + `.dv-body`; a fold hides the body through motion.js (inline end state).
// A single-file diff takes the list's own path and status letter; several files take their parsed ones.
function gpFileSection(diffEl, row, f, single, opts) {
  const sec = document.createElement('div');
  sec.className = 'dv-file';
  const body = document.createElement('div');
  body.className = 'dv-body';
  body.innerHTML = Diff2Html.html([f], opts);
  const head = fileHeader({
    path: single ? row.path : (f.isDeleted ? f.oldName : f.newName),
    status: single ? gpStatusLetter(row) : (f.isNew ? 'A' : f.isDeleted ? 'D' : f.isRename ? 'R' : 'M'),
    add: f.addedLines,
    del: f.deletedLines,
    onFold: (folded) => { // a fold changes the column widths: re-measure (or drop) the sticky proxy
      Promise.resolve((folded ? collapse : expand)(body)).then(() => gpMountHScroll(diffEl));
    },
  });
  sec.append(head, body);
  return sec;
}

// Re-renders the shown diff in the format the latch now wants (a pick, or the width crossing the threshold).
function gpRepaint() {
  const shown = gp.lastRender;
  if (!gp.open || !shown || gp.diffRow !== shown.row) return; // a newer open owns the overlay
  if (gpLatch.wanted(document.getElementById('gp-diff').clientWidth) === shown.format) return;
  gpPaintDiff(shown.idx, shown.row, shown.full, shown.res, true);
}

// The diff bar sits above the scroller (`#gp-diff` stays the scroll root): a column wrapper holds the bar and `#gp-diff`.
// Layout and skin live in style.css; the wrapper follows the `hidden` flag of `#gp-diff` (MR view) through `:has()`.
function gpMountDiffBar(diffEl) {
  const col = document.createElement('div');
  col.id = 'gp-diffc';
  const bar = document.createElement('div');
  bar.className = 'gp-diffbar';
  diffEl.before(col);
  col.append(bar, diffEl);
  gpSwitches = mountDiffSwitches(bar, {
    format: gpLatch.wanted(0),
    wrap: true,
    onFormat: (f) => { gpLatch.pick(f); gpRepaint(); },
    onWrap: (on) => { applyWrap(diffEl, on); gpMountHScroll(diffEl); },
  });
  const hint = document.createElement('span'); // the ask gesture, as board E
  hint.className = 'gp-diffbar-hint';
  hint.textContent = 'Sélectionne des lignes pour demander à Claude';
  bar.appendChild(hint);
}

// « Demander à Claude » on a selection of the diff (R2) and the answer thread as a row under its last line (R3).
// Side-by-side: the bubble row sits in the column of its key (new = right, old = left), a spacer row of the same height
// in the other column keeps the two tables row-aligned (the hunk fold walks rows by index).
// The empty third field is the commit sha of a commit file (a status row has none).
const gpAskScope = (row) => `gpdiff\n${gp.root}\n${row.sha || ''}\n${row.wt || ''}\n${row.kind}\n${row.path}`;
let gpAskWired = false;

function gpWireAsk(diffEl) {
  if (gpAskWired) return;
  gpAskWired = true;
  diffEl.addEventListener('mouseup', gpAskFromSelection);
  diffEl.addEventListener('keyup', gpAskFromSelection);
}

function gpAskFromSelection(e) {
  const shown = gp.lastRender;
  const row = shown && shown.row;
  if (!gp.open || !row || gp.diffRow !== row) return;
  if (e.type === 'keyup' && (!e.shiftKey || e.target.closest('input, textarea'))) return;
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || sel.isCollapsed) return;
  const range = sel.getRangeAt(0);
  const inside = (n) => !!(n && (n.nodeType === 1 ? n : n.parentElement).closest('.ca-bubble, .ca-popup'));
  if (inside(range.startContainer) || inside(range.endContainer)) return;
  const span = diffRangeFromSelection(document.getElementById('gp-diff'));
  if (!span) return;
  const ref = `${row.path}:L${span.start}-L${span.end}${span.side === 'old' ? ' (ancien fichier)' : ''}`;
  openAsk({
    anchorEl: range.getBoundingClientRect(),
    anchor: diffRowKey(span.lastRow),
    threadRef: ref,
    scope: gpAskScope(row),
    compose: (question) => composeCodeMessage(ref, span.lines, question),
    placeBubble: gpPlaceBubble,
  });
}

// Insert `tr` after `row` and after the ask rows already following it (send order). Both columns hold the same number of
// ask rows after aligned rows, so the two insertions land on the same row index.
function gpInsertAskRow(row, tr) {
  let after = row;
  while (after.nextElementSibling && after.nextElementSibling.classList.contains('gp-ask-row')) after = after.nextElementSibling;
  after.after(tr);
}

function gpDropAskRow(tr) {
  if (!tr) return;
  if (tr._gpRO) tr._gpRO.disconnect();
  if (tr._gpSpacer) tr._gpSpacer.remove();
  tr.remove();
}

// The `placeBubble` of the diff: a full-width row after the anchor row; side-by-side, plus a spacer row in the other column.
function gpPlaceBubble(bubble, key) {
  gpDropAskRow(bubble.closest('tr.gp-ask-row'));
  const [anchorRow, mateRow] = gp.lastRender ? diffRowsByKey(document.getElementById('gp-diff'), key) : [];
  if (!anchorRow) return;
  const tr = document.createElement('tr');
  tr.className = 'gp-ask-row';
  const td = tr.appendChild(document.createElement('td'));
  td.colSpan = 2;
  const slot = td.appendChild(document.createElement('div'));
  slot.className = 'ca-slot';
  slot.appendChild(bubble);
  gpInsertAskRow(anchorRow, tr);
  if (!mateRow) return;
  const spacer = document.createElement('tr');
  spacer.className = 'gp-ask-row';
  spacer.appendChild(document.createElement('td')).colSpan = 2;
  gpInsertAskRow(mateRow, spacer);
  const sync = () => { spacer.style.height = `${tr.getBoundingClientRect().height}px`; };
  tr._gpRO = new ResizeObserver(sync);
  tr._gpRO.observe(tr);
  tr._gpSpacer = spacer;
  sync();
}

// v54: sticky horizontal scrollbar for the side-by-side view. The native
// per-column h-bar lives at the BOTTOM of the full-height column (off-screen on
// a long file), so reviewing the FIRST lines of a long diff leaves no reachable
// bar. This mounts a thin proxy pinned to the viewport bottom (position:sticky)
// whose scroll drives both columns — and vice-versa via the sync listener.
// Sized so proxy.scrollLeft maps 1:1 to a column's scrollLeft (clamped/column).
function gpMountHScroll(diffEl) {
  const old = diffEl.querySelector('.gp-hscroll');
  if (old) old.remove();
  const cols = diffEl.querySelectorAll('.d2h-file-side-diff');
  if (cols.length < 2) return; // line-by-line has no split to drive
  const colClientW = cols[0].clientWidth;
  const maxScrollW = Math.max(...[...cols].map((c) => c.scrollWidth));
  const range = maxScrollW - colClientW; // a column's horizontal scroll range
  if (range <= 1) return; // nothing overflows -> no bar needed
  const bar = document.createElement('div');
  bar.className = 'gp-hscroll';
  const spacer = document.createElement('div');
  spacer.className = 'gp-hscroll-spacer';
  bar.appendChild(spacer);
  diffEl.appendChild(bar);
  // proxy.scrollLeft maxes at (spacerW - barClientW); pick spacerW so that max
  // equals `range` -> the proxy maps 1:1 onto a column's scrollLeft.
  spacer.style.width = `${range + bar.clientWidth}px`;
}

function gpMove(delta) {
  if (!gp.rows.length) return;
  const folds = gpFolds();
  let next = gp.selected < 0 ? (delta > 0 ? 0 : gp.rows.length - 1) : gp.selected + delta;
  while (next >= 0 && next < gp.rows.length && folds.has(gpDirKey(gp.rows[next]))) next += delta; // skip folded rows
  if (next < 0 || next >= gp.rows.length || next === gp.selected) return;
  gpLoadDiff(next);
}

// v39 live refresh — no polling: when the panel's session settles
// (idle/waiting = CC just finished writing files), re-run the cheap status.
// Debounced: Stop + Notification can land back-to-back.
// v39.1: the panel can target a pane OR a sidebar session directly.
export function gpNotifySessionStatus(sessionId, status) {
  if (gp.open && gp.target && (status === 'idle' || status === 'waiting')) {
    const pane = gp.target.paneId ? panes.get(gp.target.paneId) : null;
    const match = (pane && pane.sessionId === sessionId)
      || gp.target.sessionId === sessionId;
    if (match) {
      clearTimeout(gpIdleRefreshTimer);
      gpIdleRefreshTimer = setTimeout(() => gpLoadStatus(), 350);
    }
  }
}

// Delegated listeners + keyboard nav + responsive re-render — from boot.js.
export function initGitPanel() {
  // step-4 collapse/expand hunks — one delegated listener: a click on a hunk
  // header (@@ row) folds every line row until the next header. diff2html
  // emits plain <tr>s, so the fold is a class walk, no re-parse.
  // v39.1: side-by-side renders TWO row-synchronized tables — fold by ROW
  // INDEX across every tbody, not by sibling walk in the clicked one (probe
  // t15 caught the half-folded split view).
  document.getElementById('gp-diff').addEventListener('click', (e) => {
    const info = e.target.closest && e.target.closest('tr:has(.d2h-info), .d2h-info');
    if (!info) return;
    const headerRow = info.closest('tr') || info;
    const tbody = headerRow.closest('tbody');
    if (!tbody) return;
    const rows = [...tbody.rows];
    const startIdx = rows.indexOf(headerRow);
    let endIdx = rows.length;
    for (let i = startIdx + 1; i < rows.length; i++) {
      if (rows[i].querySelector('.d2h-info')) { endIdx = i; break; }
    }
    const folded = !headerRow.classList.contains('gp-folded');
    for (const tb of document.querySelectorAll('#gp-diff tbody')) {
      const trs = [...tb.rows];
      if (trs[startIdx]) trs[startIdx].classList.toggle('gp-folded', folded);
      for (let i = startIdx + 1; i < Math.min(endIdx, trs.length); i++) {
        trs[i].classList.toggle('gp-hunk-folded', folded);
      }
    }
    gpMountHScroll(document.getElementById('gp-diff')); // v54: fold changes column width -> re-measure (or drop) the proxy
  });

  // Diff bar (format + wrap switches), wrap on by default, auto-hide scrollbar on the diff.
  const diffRoot = document.getElementById('gp-diff');
  gpMountDiffBar(diffRoot);
  applyWrap(diffRoot, true);
  autoHideScrollbar(diffRoot);

  // Responsive re-render: when the latch's format (the width, until the user picks one) differs
  // from the shown one, repaint the diff in it.
  const gpDiffRO = new ResizeObserver(() => {
    if (!gp.open || !gp.lastRender) return;
    const diffEl = document.getElementById('gp-diff');
    if (!diffEl.clientWidth) return; // the overlay is closed: nothing to measure
    const want = gpLatch.wanted(diffEl.clientWidth);
    if (want !== gp.lastRender.format && gp.lastRender.row) {
      clearTimeout(gpDiffRO._t);
      gpDiffRO._t = setTimeout(gpRepaint, 250);
    } else if (want === 'side-by-side') {
      // v54: width changed but still split -> the column scroll range moved, so
      // the sticky proxy's spacer is stale and wrapped rows may have drifted. Re-measure (don't re-render).
      clearTimeout(gpDiffRO._h);
      gpDiffRO._h = setTimeout(() => { syncSplitRows(diffEl); gpMountHScroll(diffEl); }, 120);
    }
  });
  gpDiffRO.observe(diffRoot);

  // v53 horizontal scroll sync — side-by-side renders TWO independently
  // h-scrollable code columns (.d2h-file-side-diff, overflow-x:scroll). A wide
  // line scrolled in one side drifts out of step with the other, breaking the
  // row alignment that makes the split view readable. Mirror scrollLeft both
  // ways. Capture phase: scroll doesn't bubble, so we catch it on the
  // container. rAF-gated guard: a programmatic scrollLeft set fires its OWN
  // scroll event next; the flag swallows it, released next frame so genuine
  // user scrolls always pass.
  let gpScrollSyncing = false;
  document.getElementById('gp-diff').addEventListener('scroll', (e) => {
    if (gpScrollSyncing) return;
    const t = e.target;
    const isCol = t.classList && t.classList.contains('d2h-file-side-diff');
    const isProxy = t.classList && t.classList.contains('gp-hscroll'); // v54 sticky bar
    if (!isCol && !isProxy) return; // vertical #gp-diff scroll -> not our business
    const diffEl = document.getElementById('gp-diff');
    const members = [...diffEl.querySelectorAll('.d2h-file-side-diff'),
      diffEl.querySelector('.gp-hscroll')].filter(Boolean);
    if (members.length < 2) return;
    const x = t.scrollLeft;
    gpScrollSyncing = true;
    for (const m of members) {
      if (m !== t && m.scrollLeft !== x) m.scrollLeft = x; // !== keeps the echo a no-op
    }
    requestAnimationFrame(() => { gpScrollSyncing = false; });
  }, true);

  document.addEventListener('keydown', (e) => {
    if (!gp.open || e.defaultPrevented) return; // a key an inner module already took is not ours
    // NEVER steal keys from a focused terminal — the panel is keyboard-first
    // only while the user is interacting with it.
    if (e.target && e.target.closest && e.target.closest('.pane-term')) return;
    if (e.key === 'Escape') {
      // v53: an open chooser eats Escape first — close it, keep the panel open.
      if (document.getElementById('gp-open-menu')) { gpCloseOpenMenu(); e.preventDefault(); return; }
      closeSidePanel(); e.preventDefault(); return;
    }
    // Fields keep their letters and arrows; the shown MR sub-view owns every key of its own modules.
    if (e.target && e.target.closest && e.target.closest('.ca-popup, .ca-bubble, #gp-mr:not([hidden]), input, textarea, select, [contenteditable]')) return;
    if (document.getElementById('gp-files').hidden) return; // a commit is the detail: the file list keys wait
    if (e.key === 'ArrowDown') { gpMove(1); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { gpMove(-1); e.preventDefault(); }
    else if (e.key === 'Enter' && gp.selected >= 0 && !(e.target && e.target.closest && e.target.closest('button'))) { // a focused button keeps its Enter
      gpReopenDiff(); // the selected row's diff, back after « ← Historique »
      document.getElementById('gp-diff').focus({ preventScroll: true });
      e.preventDefault();
    }
  });

  // ownEscape: the keydown handler above owns Escape (an open chooser eats the first one).
  registerSideTab('git', {
    open: (t, o) => gpActivate(t, !(o && o.keepFocus)),
    close: gpDeactivate,
    ownEscape: true,
    autoMax: () => gpAutoMax,
    userMax: () => { gpAutoMax = false; },
  });
  document.getElementById('gp-close').addEventListener('click', closeGitPanel);
  document.getElementById('gp-refresh').addEventListener('click', (e) => spinWhile(e.currentTarget, gpLoadStatus({ user: true })));
  for (const sel of ['.glog-diff-back', '.glog-diff-close']) {
    document.querySelector(`#glog-diff ${sel}`).addEventListener('click', () => {
      gpHideDiff();
      const back = gp.detail === 'commit' ? document.querySelector('#glog-commit button.glog-file[aria-current]') : document.getElementById('gp-files');
      if (back) back.focus({ preventScroll: true });
    });
  }
  // The MR sub-view (mr-review.js) swaps itself with the log columns through its own `hidden` flag.
  const mrEl = document.getElementById('gp-mr');
  const cols = document.querySelector('#gp-body > .glog-cols');
  const syncCols = () => { cols.hidden = !mrEl.hidden; };
  new MutationObserver(syncCols).observe(mrEl, { attributes: true, attributeFilter: ['hidden'] });
  syncCols();
}
