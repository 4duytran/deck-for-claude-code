// claude-deck — renderer/mr-review (deck-mr-review R4 / R5, deck-mr-ui V1 / V2a): the git panel's « Merge requests » entry, the open-MR
// list and the MR view. git-panel.js reports each settled repo through overlayState.onGitRepo(target, root | null); the entry shows only
// when the MR list call answers for that repo (D7: any other outcome = not GitLab = nothing shown, memoized per repo root for the app run).
// The view is three columns (files tree, diff, rail) filled part by part by mr-load.js: the header and skeletons paint from the list row
// at once. GitLab text reaches the DOM through textContent; note bodies through markdown-it html:false (D16).
'use strict';

import { overlayState } from './state.js';
import { sp, toggleSidePanelMax } from './side-panel.js';
import { sendAsk, composeCodeMessage, placeBubbles } from './code-ask.js';
import { createBox } from './mr-box.js';
import { diffRowKey, diffRowsByKey } from './diff-select.js';
import { exitThen, collapse, expand, fadeIn } from './motion.js';
import { autoHideScrollbar } from './diff-view.js';
import { mountMrList, initials, ago } from './mr-list.js';
import { mountMrTree, diffStat } from './mr-tree.js';
import { mountMrDiff } from './mr-diff.js';
import { expand as expandDiff, matches } from './diff-expand.js';
import { mountMrRail } from './mr-rail.js';
import { skeleton, inlineBar } from './loading.js';
import { loadMrParts } from './mr-load.js';

const TRUNC_NOTE = 'Merge request trop volumineuse : fichiers ou discussions tronqués';
const NO_DIFF_NOTE = 'Diff non fourni par GitLab (fichier trop volumineux)';
const EMPTY_DIFF_NOTE = 'Aucun diff à afficher';
const TAG_OBSOLETE = 'position obsolète';
const TAG_NO_DIFF = 'diff non fourni';
const STEP_LABELS = { version: 'Version', files: 'Fichiers', discussions: 'Discussions' };
const PART_STEP = { version: 'version', diffs: 'files', discussions: 'discussions' }; // IPC part -> step chip
const PART_NOUN = { version: 'la version', diffs: 'les fichiers', discussions: 'les discussions', drafts: 'les brouillons' };
const MINUS = '−';

// Live state (probe seam): detected = repo root -> Promise<whole detection answer | null>; current = { target, root }
// of the shown repo; view = the state of the MR view while one is shown.
export const mr = { detected: new Map(), current: null, open: false, view: null };
let folderSeq = 0; // answers of the folder choice: only the latest, still-shown not-repo target paints
const kept = new Map(); // repo root -> last good list answer: every showing of the list paints it at once
let ui = null; // { root, me, api } the mounted list of the shown repo
let listSeq = 0; // the latest list call wins
let viewSeq = 0; // the latest MR call wins
let viewEl = null;
let vparts = null; // the mounted columns and header fields of the MR view
let autoMax = false; // the view maximized the side panel itself (D6): leaving restores it
const lineSets = new WeakMap(); // file -> { o: Set(old line numbers), n: Set(new line numbers) } of its parsed hunks

// markdown-it html:false escapes raw HTML (same rule as files-panel.js); null if the vendor script is missing.
const mdr = (typeof markdownit !== 'undefined') ? markdownit({ html: false, linkify: true }) : null;

const byId = (id) => document.getElementById(id);

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

const setShown = (e, on) => { e.hidden = !on; e.style.display = on ? '' : 'none'; };

const isList = (res) => !!(res && res.ok === true && Array.isArray(res.mrs));

// The detection call is the first list call: its answer is kept whole (the first showing paints it) and the entry shows on an ok one.
function detect(root, target) {
  if (!mr.detected.has(root)) {
    mr.detected.set(root, Promise.resolve()
      .then(() => window.api.gitlabMrs(target))
      .then((res) => {
        if (isList(res) && !kept.has(root)) kept.set(root, res);
        return res;
      }, () => null));
  }
  return mr.detected.get(root).then(isList);
}

// An MR view carries its own header bar: the git head and the list's back bar stay hidden (inline) while it shows.
function hideChrome(on) {
  for (const e of [byId('gp-head'), byId('gp-mr').querySelector('.mr-head')]) if (e) e.style.display = on ? 'none' : '';
}

function leaveView() {
  viewSeq++;
  const v = mr.view;
  stopLive(v);
  if (v && v.load) v.load.cancel();
  mr.view = null;
  if (autoMax) { // D6: only a maximize the view made is undone (a panel close already restored it)
    autoMax = false;
    if (sp.max) toggleSidePanelMax();
  }
  byId('gp-mr').classList.remove('mr-in-view');
  hideChrome(false);
  if (viewEl) viewEl.hidden = true;
  const heading = byId('gp-mr').querySelector('.mr-heading');
  if (heading && heading.dataset.list) heading.textContent = heading.dataset.list;
}

function showStatus() {
  listSeq++;
  leaveView();
  mr.open = false;
  byId('gp-mr').hidden = true;
  byId('gp-files').hidden = false;
  byId('gp-diff').hidden = false;
}

function showSubview() {
  leaveView();
  mr.open = true;
  byId('gp-files').hidden = true;
  byId('gp-diff').hidden = true;
  byId('gp-mr').hidden = false;
}

// Identity of a not-repo base target: a folder pick keeps while the refreshed target is the same one.
const baseKey = (t) => `${t.paneId || ''}|${t.sessionId || ''}`;

function onGitRepo(target, root) {
  folderSeq++; // any settled load drops a folder answer still in flight
  const cur = mr.current;
  if (!root && cur && cur.base !== undefined && cur.base === baseKey(target)) return; // refresh of the same folder: the pick, its list and view stay
  const prevRoot = mr.current && mr.current.root;
  mr.current = root ? { target: { ...target }, root } : null;
  if (prevRoot === (root || null)) { // refresh of the same repo: the entry and an open list stay as they are
    if (!root) return;
  } else {
    byId('gp-mr-btn').hidden = true;
    showStatus();
    if (!root) return;
  }
  const mine = mr.current;
  detect(root, mine.target).then((ok) => {
    if (mr.current && mr.current.root === mine.root) byId('gp-mr-btn').hidden = !ok;
  });
}

// ---- Folder choice: a session folder that is not a repository (M1/M2) ----------------------------------------
// git-panel.js hands over the empty slot of its not-repo state. The answer lists the GitLab repos one level under the folder; a pick opens
// today's list on a copy of the target carrying that name (main resolves it, never the renderer). `root` is a renderer-side identity only.

function pickFolderRepo(base, name) {
  const key = baseKey(base);
  mr.current = { target: { ...base, subRepo: name }, root: `folder:${JSON.stringify([key, name])}`, base: key };
  openList();
}

function onGitFolder(target, slot) {
  const seq = ++folderSeq;
  Promise.resolve()
    .then(() => window.api.gitlabFolderRepos(target))
    .catch(() => null)
    .then((res) => {
      if (seq !== folderSeq || !slot.isConnected) return; // another load settled meanwhile, or the slot was rebuilt
      if (!res || res.ok !== true || !Array.isArray(res.repos)) return;
      const names = res.repos.filter((n) => typeof n === 'string' && n);
      if (!names.length) return; // nothing to choose: nothing shown (rule 7)
      const heading = document.createElement('h4');
      heading.textContent = 'Merge requests';
      const buttons = names.map((name) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'gp-mr-repo';
        b.textContent = name;
        b.addEventListener('click', () => pickFolderRepo(target, name));
        return b;
      });
      slot.replaceChildren(heading, ...buttons);
    });
}

function notice(listEl, message, detail) {
  const box = document.createElement('div');
  box.className = 'mr-empty';
  box.textContent = message;
  if (detail) {
    const small = document.createElement('small');
    small.textContent = detail;
    box.appendChild(small);
  }
  listEl.appendChild(box);
}

// One mounted list per repo root: another repo gets a fresh host, which drops the previous list's filters and document listener.
function listFor(mine) {
  if (ui && ui.root === mine.root) return ui;
  let host = byId('gp-mr-list');
  if (ui) {
    const fresh = host.cloneNode(false);
    host.replaceWith(fresh);
    host = fresh;
  }
  const made = { root: mine.root, me: null, api: null };
  made.api = mountMrList(host, {
    onOpen: openMr,
    onRetry: () => {
      if (ui !== made || !mr.current || mr.current.root !== made.root) return;
      made.api.setError(null);
      showList();
    },
  });
  ui = made;
  return made;
}

function paint(cur) {
  const res = kept.get(cur.root);
  if (res) cur.api.setData({ mrs: res.mrs, truncated: res.truncated === true, me: cur.me });
}

// A showing of the list (entry click, back from an MR view, « Réessayer »): paint the kept list at once, then one background call.
function showList() {
  const mine = mr.current;
  if (!mine) return;
  const seq = ++listSeq;
  byId('gp-mr-note').hidden = true; // the list draws its own cap note
  const cur = listFor(mine);
  const live = () => seq === listSeq && ui === cur && !!mr.current && mr.current.root === mine.root;
  cur.api.setError(null);
  cur.api.setBusy(true);
  paint(cur);
  Promise.resolve()
    .then(() => window.api.gitlabUser(mine.target)) // main's memo answers after the first read
    .then((u) => {
      if (!u || u.ok !== true || typeof u.username !== 'string' || !u.username) return;
      cur.me = u.username;
      if (ui === cur) paint(cur);
    }, () => {});
  Promise.resolve()
    .then(() => window.api.gitlabMrs(mine.target))
    .catch(() => null)
    .then((res) => {
      if (!live()) return;
      if (!sp.open || sp.tab !== 'git') { showStatus(); return; } // panel closed meanwhile: never reopen on a stale list
      cur.api.setBusy(false);
      if (isList(res)) {
        kept.set(mine.root, res);
        cur.api.setError(null);
        paint(cur);
      } else {
        cur.api.setError(res && typeof res.message === 'string' ? res.message : '');
      }
    });
}

function openList() {
  if (!mr.current) return;
  showSubview();
  showList();
}

// ---- MR view (R5) ------------------------------------------------------------------------------------------

const cleanPath = (p) => String(p).replace(/[\r\n]+/g, ' '); // a path never breaks the synthesized header apart
// D14: GitLab sends hunks only; Diff2Html needs a git file header in front of them.
function synthDiff(f) {
  const o = cleanPath(f.oldPath || f.newPath);
  const n = cleanPath(f.newPath);
  return `diff --git a/${o} b/${n}\n--- a/${o}\n+++ b/${n}\n${f.diff}`;
}

function fmtDate(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso || '') : d.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
}

function linesOf(f) {
  let sets = lineSets.get(f);
  if (!sets) {
    sets = { o: new Set(), n: new Set() };
    try {
      for (const file of Diff2Html.parse(synthDiff(f))) {
        for (const block of file.blocks) {
          for (const l of block.lines) {
            if (l.oldNumber != null) sets.o.add(l.oldNumber);
            if (l.newNumber != null) sets.n.add(l.newNumber);
          }
        }
      }
    } catch (_) { /* unparsable hunks: no line is in the diff */ }
    lineSets.set(f, sets);
  }
  return sets;
}

const anchorLine = (p) => (p.newLine != null ? p.newLine : p.oldLine);
const threadFileIdx = (files, p) => files.findIndex((f) => f.newPath === p.newPath && (p.oldPath == null || f.oldPath === p.oldPath));
const threadKey = (p) => (p.newLine != null ? `n${p.newLine}` : (p.oldLine != null ? `o${p.oldLine}` : null));

// Where each diff thread goes: inline[i] = threads shown in file i's diff, header = [{ thread, tag }] shown away from a line.
function placeThreads(res) {
  const inline = res.files.map(() => []);
  const header = [];
  for (const t of res.diffThreads) {
    const p = t.position;
    const idx = threadFileIdx(res.files, p);
    const f = idx < 0 ? null : res.files[idx];
    if (!f) header.push({ thread: t, tag: TAG_OBSOLETE });
    else if (f.diff == null) header.push({ thread: t, tag: TAG_NO_DIFF });
    else if ((p.newLine != null ? linesOf(f).n.has(p.newLine) : linesOf(f).o.has(p.oldLine))) inline[idx].push(t);
    else header.push({ thread: t, tag: TAG_OBSOLETE });
  }
  return { inline, header };
}

function renderBody(host, text) {
  if (!mdr) { host.textContent = text; return; }
  host.innerHTML = mdr.render(text); // markdown-it, html:false
  for (const a of host.querySelectorAll('a')) a.removeAttribute('href'); // links stay text: nothing navigates from a note
  for (const img of host.querySelectorAll('img')) img.replaceWith(document.createTextNode(img.getAttribute('alt') || '')); // no remote fetch
}

const newChip = () => el('span', 'mr-note-new', 'Nouveau');
// A7: a note the view's first successful discussions read did not hold (nothing is new until that read). An edited note keeps its id.
const isNewNote = (n) => { const v = mr.view; return !!v && v.firstNoteIds != null && n.id != null && !v.firstNoteIds.has(n.id); };

// `quiet`: the first note of an inline card, whose author, date and « résolu » mark already sit in the card head.
function noteItem(n, quiet = false) {
  const box = el('div', 'mr-note-item');
  const body = el('div', 'mr-note-body');
  renderBody(body, n.body);
  if (quiet) {
    if (isNewNote(n)) box.append(newChip());
    box.append(body);
    return box;
  }
  const meta = el('div', 'mr-note-meta');
  meta.append(el('span', 'mr-note-author', n.author), el('span', 'mr-note-date', fmtDate(n.createdAt)));
  if (n.resolved) meta.append(el('span', 'mr-note-resolved', 'résolu'));
  if (isNewNote(n)) meta.append(newChip());
  box.append(meta, body);
  return box;
}

// head = { label, tag } for a thread shown away from its line, null otherwise.
function threadBox(t, head) {
  const box = el('div', 'mr-thread');
  if (head) {
    const h = el('div', 'mr-thread-head');
    if (head.label) h.append(el('span', 'mr-thread-pos', head.label));
    if (head.tag) h.append(el('span', 'mr-tag', head.tag));
    box.append(h);
  }
  for (const n of t.notes) box.append(noteItem(n));
  return box;
}

const positionLabel = (p) => `${p.newPath || p.oldPath || ''}:${anchorLine(p) ?? ''}`;

const SUMMARY_CHARS = 80;

// An inline thread: head (avatar, author, line, relative time, fold button), a one-line summary shown while folded, the notes.
// `folded` = ids of the threads folded in this view, so a redraw of the rows keeps them folded.
function threadCard(t, folded, drafts = []) {
  const first = t.notes[0] || {};
  const author = String(first.author || '');
  const id = t.id ?? first.id;
  const card = el('div', 'mr-thread-card');
  const head = el('div', 'mr-thread-head');
  const fold = button('', 'mr-thread-fold', () => {
    const open = fold.getAttribute('aria-expanded') !== 'true';
    if (open) folded.delete(id); else folded.add(id);
    setOpen(open, true);
  });
  head.append(el('span', 'mr-avatar', initials(author)), el('span', 'mr-thread-author', author));
  const line = t.position ? anchorLine(t.position) : null;
  if (line != null) head.append(el('span', 'mr-thread-pos', `L${line}`));
  const rel = ago(first.createdAt);
  if (rel) {
    const time = el('span', 'mr-thread-time', rel);
    time.title = fmtDate(first.createdAt);
    head.append(time);
  }
  if (first.resolved) head.append(el('span', 'mr-note-resolved', 'résolu'));
  head.append(el('span', 'mr-thread-count', messageCount(t.notes.length)), fold);
  const flat = String(first.body || '').replace(/\s+/g, ' ').trim();
  const summary = el('div', 'mr-thread-summary', `${author} · ${flat.length > SUMMARY_CHARS ? `${flat.slice(0, SUMMARY_CHARS)}…` : flat}`);
  const body = el('div', 'mr-thread-body');
  t.notes.forEach((n, k) => body.append(noteItem(n, k === 0)));
  if (hasThreadId(t)) { // the reply drafts of this thread sit after its notes, then the footer
    const mine = el('div', 'mr-thread-drafts');
    mine.dataset.id = t.id;
    for (const d of replyDraftsOf(drafts, t.id)) mine.append(draftBox(d));
    body.append(mine, threadFoot(t));
  }
  card.append(head, summary, body);
  function setOpen(open, animate) {
    const label = open ? 'Replier le fil' : 'Déplier le fil';
    fold.setAttribute('aria-expanded', String(open));
    fold.setAttribute('aria-label', label);
    fold.title = label;
    if (!animate) { setShown(body, open); setShown(summary, !open); return; }
    if (open) { expand(body); collapse(summary); } else { collapse(body); expand(summary); } // the row's spacer follows (mr-diff insertRow)
  }
  setOpen(!folded.has(id), false);
  return card;
}

function threadRow(t, folded, drafts) {
  const row = el('tr', 'mr-thread-row mr-enter');
  const cell = el('td');
  cell.colSpan = 2;
  cell.append(threadCard(t, folded, drafts));
  if (hasThreadId(t)) { // where this thread's box sits (D12), under the card and as wide as it
    const slot = el('div', 'mr-thread-slot');
    slot.dataset.id = t.id;
    cell.append(slot);
  }
  row.append(cell);
  return row;
}

// ---- « Vu » marks -------------------------------------------------------------------------------------------------------
// The diff header and the tree row show the same mark: each reports its changes here and the other is told silently. The tree
// reports every real change, so `mirroring` stops the echo of a mirrored one. Paths are kept per MR for the app run (nothing on disk).
const seenMarks = new Map(); // MR key (repo root + iid) -> Set of seen file paths
let mirroring = false;

function onSeenMark(path, on, fromTree) {
  const v = mr.view;
  if (mirroring || !v || !vparts) return;
  let set = seenMarks.get(v.seenKey);
  if (!set) seenMarks.set(v.seenKey, set = new Set());
  if (on) set.add(path); else set.delete(path);
  mirroring = true;
  try { (fromTree ? vparts.diff : vparts.tree).setSeen(path, on); } finally { mirroring = false; }
}

// After setFiles (clears the tree marks) and the show(null) of resetView (clears the diff's): put the kept marks back.
function replaySeen(v) {
  const set = seenMarks.get(v.seenKey);
  if (!set || !set.size || !vparts) return;
  mirroring = true;
  try {
    for (const path of set) { vparts.tree.setSeen(path, true); vparts.diff.setSeen(path, true); }
  } finally { mirroring = false; }
}

// ---- Ask Claude about lines (R2 / R3) and review drafts (R6) ---------------------------------------------------------
// Everything that sits under a diff line is one full-width <tr> (thread, draft, ask bubble), kept in creation order.
// A draft body is user / Claude text: textContent in the view, a <textarea> value in the editor (D16).

const DRAFTS_UNAVAILABLE = '⚠ Brouillons indisponibles';

const sameFile = (f, p) => f.newPath === p.new && (p.old == null || f.oldPath === p.old);
const isGeneral = (d) => d.kind === 'general';
const isReplyDraft = (d) => d.kind === 'reply';
const isLineDraft = (d) => d.kind !== 'general' && d.kind !== 'reply'; // D11: only a line draft has a path and a line
const draftKey = (d) => (d.newLine != null ? `n${d.newLine}` : `o${d.oldLine}`);
const draftLabel = (d) => (isGeneral(d) ? 'Sur toute la MR' : (isReplyDraft(d) ? replyLabel(d) : `${d.path.new || d.path.old || ''}:${d.newLine ?? d.oldLine ?? ''}`));
const askScope = (v, f) => `mr\n${mr.current ? mr.current.root : ''}\n${v.iid}\n${f.newPath}`;
const threadScope = (v, id) => `mr\n${mr.current ? mr.current.root : ''}\n${v.iid}\n#thread\n${id}`; // the answers about one thread (D12)
const failText = (res, fallback) => (res && typeof res.message === 'string' && res.message ? res.message : fallback);
const liveView = (v) => mr.view === v && !!mr.current; // an async answer still belongs to the view that asked

function button(label, cls, onClick) {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

// The « Modifier » editors of the shown rows, by draft id, held while decorateRows rebuilds them: draftBox opens a held draft's editor again
// with its text, then restoreEditors puts back the caret and the focus. A draft that left the store is not rebuilt: its held editor is dropped.
let heldEditors = null;
const inSpacer = (n) => !!n.closest('tr.mr-spacer, tr.mr-wide-spacer');

function holdEditors(root) {
  const held = new Map();
  for (const ta of root.querySelectorAll('.mr-draft textarea.mr-draft-edit')) {
    if (inSpacer(ta)) continue;
    held.set(ta.closest('.mr-draft').dataset.id, { value: ta.value, from: ta.selectionStart, to: ta.selectionEnd, dir: ta.selectionDirection, focus: document.activeElement === ta });
  }
  return held;
}

function restoreEditors(root, held) {
  for (const [id, s] of held) {
    const ta = [...root.querySelectorAll(`.mr-draft[data-id="${CSS.escape(id)}"] textarea.mr-draft-edit`)].find((t) => !inSpacer(t));
    if (!ta) continue;
    if (s.focus) ta.focus({ preventScroll: true });
    try { ta.setSelectionRange(s.from, s.to, s.dir || 'none'); } catch (_) { /* no selection on this field */ }
  }
}

// label = the position, only for a draft shown away from its line.
function draftBox(d, label, editing) {
  const kept = !editing && heldEditors ? heldEditors.get(String(d.id)) : null;
  const open = editing || !!kept;
  const reply = isReplyDraft(d); // a reply draft sits in its thread card: it names itself, not a position
  const box = el('div', reply ? 'mr-draft mr-draft-reply' : 'mr-draft');
  box.dataset.id = d.id;
  const head = el('div', 'mr-draft-head');
  if (reply) {
    head.append(el('span', 'mr-draft-tag', 'Brouillon de réponse'));
    if (isSendable(d)) head.append(el('span', 'mr-draft-sep', ' · '), el('span', 'mr-draft-hint', 'pas encore envoyé · part avec « Envoyer la revue »'));
  } else {
    head.append(el('span', 'mr-draft-tag', 'Brouillon'));
    if (label) head.append(el('span', 'mr-draft-pos', label));
  }
  if (d.error) head.append(el('span', d.uncertain ? 'mr-draft-error mr-draft-uncertain' : 'mr-draft-error', d.error));
  box.append(head);
  const actions = el('div', 'mr-draft-actions');
  if (!open) {
    const edit = () => {
      const next = draftBox(d, label, true);
      box.replaceWith(next);
      next.querySelector('textarea').focus({ preventScroll: true });
    };
    actions.append(button('Modifier', 'mr-draft-edit-btn', edit), button('Supprimer', 'mr-draft-del', () => deleteDraft(box, d)));
    box.append(el('div', 'mr-draft-body', d.body), actions);
    return box;
  }
  const ta = el('textarea', 'mr-draft-edit');
  ta.value = kept ? kept.value : d.body;
  ta.rows = 4;
  ta.setAttribute('aria-label', 'Texte du brouillon');
  const note = el('div', 'mr-draft-note');
  note.hidden = true;
  note.setAttribute('role', 'alert');
  actions.append(button('Enregistrer', 'mr-draft-save', () => saveDraftEdit(box, d, label, ta, note)),
    button('Annuler', 'mr-draft-cancel', () => box.replaceWith(draftBox(d, label))));
  box.append(ta, note, actions);
  return box;
}

const inlineBoxes = (id) => viewEl.querySelectorAll(`.mr-draft[data-id="${CSS.escape(String(id))}"]`);
const replyDraftsOf = (drafts, id) => (drafts || []).filter((d) => isReplyDraft(d) && d.discussionId === id);

// A box already in the host stays (an open editor keeps its text), a gone draft's box leaves.
function fillDraftHost(host, want) {
  for (const b of [...host.children]) if (!want.some((d) => String(d.id) === b.dataset.id)) b.remove();
  for (const d of want) if (![...host.children].some((b) => b.dataset.id === String(d.id))) host.append(draftBox(d));
}

// Every shown card holds the reply drafts of its thread. A general thread has no card: its drafts sit in its rail item's slot (the same
// element across rail repaints, so an editor open there is not rebuilt), before the thread box; the host exists only while there is a draft.
function syncReplyDrafts(v) {
  const pane = vparts && vparts.diff && vparts.diff.pane;
  if (pane) {
    for (const host of pane.querySelectorAll('.mr-thread-drafts')) {
      if (!host.closest('tr.mr-spacer, tr.mr-wide-spacer')) fillDraftHost(host, replyDraftsOf(v.drafts, host.dataset.id));
    }
  }
  for (const t of (v.res && v.res.general) || []) {
    const home = hasThreadId(t) ? railHome(t.id) : null;
    if (!home) continue;
    const want = replyDraftsOf(v.drafts, t.id);
    let host = home.slot.querySelector(':scope > .mr-thread-drafts');
    if (!want.length) { if (host) host.remove(); continue; }
    if (!host) {
      host = el('div', 'mr-thread-drafts');
      host.dataset.id = t.id;
      home.slot.prepend(host);
    }
    fillDraftHost(host, want);
  }
}

// The inline editor and the rail save through here: the store first, then every box of the draft, the rail, the counts and the bar follow.
async function saveDraftBody(v, d, body) {
  const res = await window.api.gitlabDraftSave(mr.current.target, v.iid, { ...d, body }).catch(() => null);
  if (!liveView(v)) return { ok: false, notice: '' };
  if (!res || res.ok !== true || !res.draft) return { ok: false, notice: failText(res, 'Enregistrement impossible') };
  const i = v.drafts.findIndex((x) => x.id === d.id);
  if (i >= 0) v.drafts[i] = res.draft;
  for (const box of inlineBoxes(d.id)) {
    const pos = box.querySelector('.mr-draft-pos');
    box.replaceWith(draftBox(res.draft, pos ? pos.textContent : undefined));
  }
  updateDraftBar(); // a saved draft leaves the uncertain state: « Envoyer la revue (N) » counts it again
  return { ok: true };
}

async function saveDraftEdit(box, d, label, ta, note) {
  const v = mr.view;
  if (!v || !mr.current) return;
  const res = await saveDraftBody(v, d, ta.value);
  if (res.ok || !liveView(v)) return;
  note.textContent = res.notice;
  note.hidden = false;
}

// `box` is the inline button's own box (null from the rail): every inline copy of the draft leaves, rows through the pop-out.
async function deleteDraft(box, d) {
  const v = mr.view;
  if (!v || !mr.current) return;
  const res = await window.api.gitlabDraftDelete(mr.current.target, v.iid, d.id).catch(() => null);
  if (!liveView(v)) return;
  if (!res || res.ok !== true) { updateDraftBar(failText(res, 'Suppression impossible')); return; }
  v.drafts = v.drafts.filter((x) => x.id !== d.id);
  const boxes = [...inlineBoxes(d.id)];
  if (box && !boxes.includes(box)) boxes.push(box);
  for (const b of boxes) {
    const row = b.closest('tr.mr-draft-row');
    if (!row) { b.remove(); continue; }
    v.rows.delete(row);
    exitThen(row).then(() => vparts.diff.removeRow(row));
  }
  updateDraftBar();
}

// « Brouillons (N) » plus the drafts of a file that is not in the MR (nowhere else to show them) and the last failure; the tree counts
// and the rail follow every change of the drafts.
function updateDraftBar(error) {
  const v = mr.view;
  const bar = viewEl && viewEl.querySelector('.mr-drafts-bar');
  if (!bar || !v || !v.drafts) return;
  refreshCounts(v);
  syncReplyDrafts(v);
  if (v.draftsDone) vparts.rail.setDrafts(v.drafts); // before that the rail keeps its loader
  const msg = error || v.draftsError;
  bar.replaceChildren();
  if (v.drafts.length) bar.append(el('div', 'mr-drafts-count', `Brouillons (${v.drafts.length})`));
  if (msg) bar.append(el('div', 'mr-drafts-error', msg));
  if (v.filesReady) for (const d of v.drafts) if (isLineDraft(d) && !v.res.files.some((f) => sameFile(f, d.path))) bar.append(draftBox(d, draftLabel(d)));
  syncActions();
  bar.hidden = !bar.children.length;
}

// ---- Send the review and approve (R7) --------------------------------------------------------------------------------
// Each write sits behind its own modal in the MR view; the default focus is « Annuler », so a stray Enter confirms nothing.
// Drafts, paths and GitLab errors reach the dialog through textContent only (D16).

const CHANGED_409 = 'la MR a changé (409) — rouvre-la'; // D13
const NOTHING_TO_SEND = 'Rien à envoyer : les brouillons « peut-être publié » ne sont pas renvoyés';
const isSendable = (d) => !d.uncertain; // an uncertain draft (its POST timed out) is never counted nor sent again
let dialog = null; // the open confirmation: { root, opener, busy }

const shownHead = (v) => (v.res && v.res.version && typeof v.res.version.head === 'string' ? v.res.version.head : '');

// The rail's own « Envoyer la revue (N) » (disabled at 0; N counts the sendable drafts, general ones included) and « Approuver » in the view header.
function syncActions() {
  const v = mr.view;
  if (!v || !vparts) return;
  let approve = viewEl.querySelector('.mr-approve-btn');
  if (!approve) {
    approve = button('Approuver', 'mr-approve-btn', (e) => askApprove(e.currentTarget));
    vparts.toggle.before(approve);
  }
  const sendable = v.drafts.filter(isSendable).length;
  vparts.rail.setSubmit(sendable, sendable > 0);
  approve.disabled = !!v.approved || !shownHead(v);
  approve.textContent = v.approved ? 'Approuvée' : 'Approuver';
}

// The dialog leaves through the pop-out (opacity / transform) and is inert while it does; the next one sweeps what still leaves.
function closeDialog() {
  const d = dialog;
  dialog = null;
  if (!d) return;
  if (!viewEl || viewEl.hidden) d.root.remove(); // a hidden view runs no exit: the dialog would linger and show over the next MR
  else {
    d.root.inert = true;
    exitThen(d.root).then(() => d.root.remove());
  }
  if (d.opener && d.opener.isConnected && !d.opener.hidden) d.opener.focus({ preventScroll: true });
}

function dialogItem(d) {
  const item = el('div', 'mr-dialog-item');
  item.dataset.id = d.id;
  item.append(el('div', 'mr-dialog-pos', draftLabel(d)), el('div', 'mr-dialog-body', d.body));
  if (d.error) item.append(el('div', d.uncertain ? 'mr-dialog-error mr-dialog-uncertain' : 'mr-dialog-error', d.error));
  return item;
}

// onConfirm(ui) runs with both buttons disabled; ui.live() tells whether this dialog is still the open one.
function openDialog({ opener, title, text, confirmLabel, drafts, onConfirm }) {
  closeDialog();
  for (const n of viewEl.querySelectorAll('.mr-dialog-backdrop')) n.remove();
  const root = el('div', 'mr-dialog-backdrop');
  root.setAttribute('data-sp-popup', ''); // side-panel.js: an open popup owns the next Escape, the maximized panel keeps its size
  const box = el('div', 'mr-dialog mr-pop');
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-label', title);
  box.tabIndex = -1;
  const lead = el('div', 'mr-dialog-text', text);
  const list = el('div', 'mr-dialog-list');
  const msg = el('div', 'mr-dialog-msg');
  msg.setAttribute('role', 'alert');
  msg.hidden = true;
  const d = { root, opener, busy: false };
  const cancel = button('Annuler', 'mr-dialog-cancel', () => { if (!d.busy) closeDialog(); });
  const bar = inlineBar(); // in « Confirmer » while d.busy
  const confirm = button(confirmLabel, 'mr-dialog-confirm', async () => {
    if (d.busy) return;
    d.busy = true;
    cancel.disabled = true;
    confirm.disabled = true;
    confirm.append(bar);
    msg.hidden = true;
    box.focus({ preventScroll: true });
    try { await onConfirm(ui); } catch (_) { if (ui.live()) ui.say('Échec inattendu'); }
    if (!ui.live()) return;
    d.busy = false;
    bar.remove();
    cancel.disabled = false;
    confirm.disabled = false;
    cancel.focus({ preventScroll: true });
  });
  const ui = {
    live: () => dialog === d,
    say: (t) => { msg.textContent = t; msg.hidden = !t; },
    lead: (t) => { lead.textContent = t; },
    items: (ds) => { list.replaceChildren(...ds.map(dialogItem)); },
    keepOpen: () => { cancel.textContent = 'Fermer'; },
    finish: (t) => { lead.textContent = t; list.replaceChildren(); bar.remove(); confirm.hidden = true; cancel.textContent = 'Fermer'; },
  };
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { // closes the dialog only, never the side panel behind it
      e.preventDefault();
      e.stopPropagation();
      if (!d.busy) closeDialog();
    } else if (e.key === 'Tab') { // focus stays inside the modal
      e.preventDefault();
      const ring = [cancel, confirm].filter((b) => !b.disabled && !b.hidden);
      if (!ring.length) return;
      ring[(ring.indexOf(document.activeElement) + (e.shiftKey ? -1 : 1) + ring.length) % ring.length].focus({ preventScroll: true });
    }
  });
  const actions = el('div', 'mr-dialog-actions');
  actions.append(cancel, confirm);
  box.append(el('div', 'mr-dialog-title', title), lead, list, msg, actions);
  root.append(box);
  ui.items(drafts || []);
  viewEl.append(root);
  dialog = d;
  cancel.focus({ preventScroll: true });
  return ui;
}

// Sent drafts leave the view, the failed ones keep their error (main stores it too).
function refreshDrafts(v) {
  redecorate(v); // no redraw: the scroll position and an open line box stay
  updateDraftBar();
}

function askSubmit(opener) {
  const v = mr.view;
  const cur = mr.current;
  if (!v || !v.drafts || !v.drafts.some(isSendable) || !cur) return;
  let listed = v.drafts.slice();
  openDialog({
    opener, title: 'Envoyer la revue à GitLab', confirmLabel: 'Confirmer', drafts: listed,
    text: `Les brouillons ci-dessous seront publiés sur !${v.iid}. Rien n'est envoyé avant ta confirmation.${v.drafts.some((d) => d.uncertain) ? ' Ceux marqués « peut-être publié » ne sont pas renvoyés.' : ''}`,
    onConfirm: async (ui) => {
      const ids = listed.filter(isSendable).map((d) => d.id);
      if (!ids.length) { ui.say(NOTHING_TO_SEND); return; }
      const res = await window.api.gitlabSubmit(cur.target, v.iid, ids).catch(() => null);
      if (!liveView(v) || !ui.live()) return;
      if (!res || res.ok !== true || !Array.isArray(res.results)) { ui.say(failText(res, 'Envoi impossible')); return; }
      const sent = new Set();
      const failed = new Map();
      for (const r of res.results) {
        if (!r) continue;
        if (r.ok === true) sent.add(String(r.id));
        else failed.set(String(r.id), { error: typeof r.error === 'string' && r.error ? r.error : 'Envoi impossible', uncertain: r.uncertain === true });
      }
      const was = new Set(listed.map((d) => String(d.id)));
      v.drafts = v.drafts.filter((d) => !sent.has(String(d.id))).map((d) => {
        const f = failed.get(String(d.id));
        return f ? { ...d, ...f } : d;
      });
      listed = v.drafts.filter((d) => was.has(String(d.id)));
      refreshDrafts(v);
      if (!listed.length) { ui.finish('Revue envoyée.'); return; }
      ui.items(listed);
      ui.lead(listed.some(isSendable) ? 'Ces brouillons n\'ont pas été envoyés : ils restent ici avec leur erreur. Confirmer réessaie.'
        : 'Ces brouillons ne sont pas renvoyés : vérifie sur GitLab s\'ils y sont, puis modifie-les ou supprime-les.');
      ui.keepOpen();
    },
  });
}

function askApprove(opener) {
  const v = mr.view;
  const cur = mr.current;
  const head = v ? shownHead(v) : '';
  if (!v || !v.res || !cur || !head || v.approved) return;
  openDialog({
    opener, title: 'Approuver la merge request', confirmLabel: 'Confirmer',
    text: `Approuver !${v.iid} au commit ${head.slice(0, 8)} ? Si la MR a avancé depuis, GitLab refuse.`,
    onConfirm: async (ui) => {
      const res = await window.api.gitlabApprove(cur.target, v.iid, head).catch(() => null);
      if (!liveView(v) || !ui.live()) return;
      if (res && res.ok === true) { v.approved = true; updateDraftBar(); ui.finish('MR approuvée.'); return; }
      ui.say(res && res.status === 409 ? CHANGED_409 : failText(res, 'Approbation impossible'));
    },
  });
}

function draftRow(d) {
  const row = el('tr', 'mr-draft-row');
  const cell = el('td');
  cell.colSpan = 2;
  cell.append(draftBox(d));
  row.append(cell);
  return row;
}

// A line the shown diff no longer has: the draft goes to the top of the pane with its position.
function placeDraft(pane, d) {
  const tr = draftRow(d);
  tr.classList.add('mr-enter');
  if (vparts.diff.insertRow(draftKey(d), tr)) {
    if (mr.view) mr.view.rows.add(tr);
  } else {
    const box = draftBox(d, draftLabel(d));
    box.classList.add('mr-lost');
    pane.prepend(box);
  }
}

// Answers { ok, notice } so a line box keeps its text on a refusal; the row goes under the draft's line, after the box row still open there.
async function createDraft(where, body) {
  const v = mr.view;
  const cur = mr.current;
  if (!v || !v.res || !cur || cur.root !== where.root || v.iid !== where.iid) return { ok: false, notice: 'Brouillon non enregistré' };
  const { path: p, kind, oldLine, newLine, version } = where;
  const res = await window.api.gitlabDraftSave(cur.target, v.iid, { path: p, kind, oldLine, newLine, body, version }).catch(() => null);
  if (!liveView(v)) return { ok: false, notice: 'Brouillon non enregistré' };
  if (!res || res.ok !== true || !res.draft) return { ok: false, notice: failText(res, 'Brouillon non enregistré') };
  v.drafts.push(res.draft);
  const f = v.res.files[v.selected];
  const pane = vparts.diff.pane;
  if (f && pane && sameFile(f, res.draft.path)) placeDraft(pane, res.draft);
  updateDraftBar();
  return { ok: true };
}

// The bubble goes after the anchor line and the rows already under it (anchor = { key, where }); its row is kept with the view's rows.
function placeAskBubble(bubble, anchor) {
  const v = mr.view;
  const old = bubble.closest('tr.mr-ask-row');
  if (old) {
    if (v) v.rows.delete(old);
    vparts.diff.removeRow(old);
  }
  if (!v || !anchor) return;
  const tr = el('tr', 'mr-ask-row mr-enter');
  const td = el('td');
  td.colSpan = 2;
  const slot = el('div', 'ca-slot');
  slot.append(bubble);
  td.append(slot);
  tr.append(td);
  if (vparts.diff.insertRow(anchor.key, tr)) v.rows.add(tr);
}

// What a line box acts on: the file this view shows (mr-diff never passes it) and the position of the range's LAST row (R7).
function lineTarget(range) {
  const v = mr.view;
  const f = v && v.res && v.selected != null ? v.res.files[v.selected] : null;
  if (!f || f.diff == null || !mr.current || !range || !range.last) return null;
  const { kind, old: oldLine, new: newLine } = range.last;
  if (oldLine == null && newLine == null) return null;
  const ver = v.res.version || {};
  const where = {
    root: mr.current.root, iid: v.iid, path: { old: f.oldPath ?? null, new: f.newPath },
    kind: kind === 'ctx' || kind === 'add' || kind === 'del' ? kind : (oldLine != null && newLine != null ? 'ctx' : (newLine != null ? 'add' : 'del')),
    oldLine, newLine, version: { base: ver.base, start: ver.start, head: ver.head },
  };
  return { v, f, where };
}

function onLineAsk(range, question) {
  const t = lineTarget(range);
  if (!t) return { ok: false, notice: 'Action indisponible' };
  const { v, f, where } = t;
  const old = range.side === 'old';
  const ref = `${old ? (f.oldPath || f.newPath) : f.newPath}:L${range.start}-L${range.end}${old ? ' (ancien fichier)' : ''}`;
  return sendAsk({
    question,
    anchor: { key: diffRowKey(range.lastRow), where },
    threadRef: ref,
    scope: askScope(v, f),
    compose: (q) => composeCodeMessage(ref, range.lines, q),
    placeBubble: placeAskBubble,
    bubbleActions: [{
      label: 'Utiliser comme commentaire',
      title: 'Garder la réponse comme brouillon de commentaire',
      run: async ({ thread }) => {
        const turn = [...thread.turns].reverse().find((x) => x.state === 'done' && x.answer);
        if (!turn) { updateDraftBar('Réponse non terminée — attends la fin avant de l’utiliser'); return; }
        const res = await createDraft(thread.anchor.where, turn.answer);
        if (!res.ok) updateDraftBar(res.notice);
      },
    }],
  });
}

function onLineComment(range, body) {
  const t = lineTarget(range);
  return t ? createDraft(t.where, body) : { ok: false, notice: 'Action indisponible' };
}

// ---- The whole MR from the rail (U7, U8): a question to Claude and a general draft ------------------------------------

const mrScope = (v) => `mr\n${mr.current ? mr.current.root : ''}\n${v.iid}\n`; // no file part: the answers about the MR itself

// D14: the question names the MR it is about (title and branches from the list row).
function mrQuestion(v, question) {
  const r = v.row;
  const branches = r.source && r.target ? ` (${r.source} → ${r.target})` : '';
  return `Question sur la merge request !${v.iid} « ${r.title == null ? '' : String(r.title)} »${branches}\n\n${question}`;
}

// A draft with no file and no line; answers { ok, notice } like createDraft.
async function createGeneralDraft(v, body) {
  const cur = mr.current;
  if (!liveView(v) || !cur) return { ok: false, notice: 'Brouillon non enregistré' };
  const res = await window.api.gitlabDraftSave(cur.target, v.iid, { kind: 'general', body }).catch(() => null);
  if (!liveView(v)) return { ok: false, notice: 'Brouillon non enregistré' };
  if (!res || res.ok !== true || !res.draft) return { ok: false, notice: failText(res, 'Brouillon non enregistré') };
  v.drafts.push(res.draft);
  updateDraftBar();
  return { ok: true };
}

function onMrAsk(question) {
  const v = mr.view;
  if (!v || !mr.current) return { ok: false, notice: 'Action indisponible' };
  return sendAsk({
    question,
    anchor: null,
    threadRef: `!${v.iid}`,
    scope: mrScope(v),
    compose: (q) => mrQuestion(v, q),
    placeBubble: (bubble) => vparts.rail.placeClaude(bubble),
    bubbleActions: [{
      label: 'Utiliser comme commentaire',
      title: 'Garder la réponse comme brouillon de commentaire sur toute la MR',
      run: async ({ thread }) => {
        const cv = mr.view; // the bubble comes back in every later view of this MR: act on the one shown now
        if (!cv || thread.scope !== mrScope(cv)) return;
        const turn = [...thread.turns].reverse().find((x) => x.state === 'done' && x.answer);
        if (!turn) { updateDraftBar('Réponse non terminée — attends la fin avant de l’utiliser'); return; }
        const res = await createGeneralDraft(cv, turn.answer);
        if (!res.ok && liveView(cv)) updateDraftBar(res.notice);
      },
    }],
  });
}

function onMrComment(body) {
  const v = mr.view;
  return v && mr.current ? createGeneralDraft(v, body) : { ok: false, notice: 'Action indisponible' };
}

// The one rail fold: every MR opens with the rail folded, at any width; only the user's pick unfolds it, for the life of the view.
const RAIL_FADE_KF = [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }];

// The column width snaps; the content that appears (the strip on fold, the sections on unfold) fades in through motion.js
// `fadeIn` (opacity / transform on the Deck tokens, nothing under reduced motion).
function fadeRailContent(root, open) {
  fadeIn([...root.children].filter((c) => c.classList.contains('mr-rail-strip') !== open), RAIL_FADE_KF);
}

// `animate`: a fold the user or the width triggered. The reset at view open snaps.
function setRailOpen(open, animate = false) {
  const p = vparts;
  const changed = p.cols.classList.contains('rail-open') !== open;
  p.cols.classList.toggle('rail-open', open);
  p.toggle.setAttribute('aria-expanded', String(open));
  p.rail.setFolded(!open);
  const root = animate && changed ? p.cols.querySelector('.mr-rail') : null;
  if (root) fadeRailContent(root, open);
}

// The header toggle and the strip chevron are the user's pick; a width change never unfolds the rail.
function pickRail(open) {
  setRailOpen(open, true);
}

function mountRail(host) {
  return mountMrRail(host, {
    onFoldChange: (folded) => pickRail(!folded),
    onJump: jumpTo,
    onEditDraft: (d, body) => (mr.view && mr.current ? saveDraftBody(mr.view, d, body) : { ok: false, notice: 'Enregistrement impossible' }),
    onDeleteDraft: (d) => deleteDraft(null, d),
    onAsk: onMrAsk,
    onComment: onMrComment,
    onSubmit: askSubmit,
    onThreadReply: (t) => openThreadBox(t, 'comment', 'rail'),
    onThreadAsk: (t) => openThreadBox(t, 'ask', 'rail'),
  });
}

// ---- Columns, progressive load (V2a) ----------------------------------------------------------------------------

function replay(e) { // restart the one-shot .mr-enter animation
  e.classList.remove('mr-enter');
  void e.offsetWidth;
  e.classList.add('mr-enter');
}

function startSkeletons(v) {
  const p = vparts;
  for (const s of viewEl.querySelectorAll('.gp-skeleton')) s.remove();
  const root = p.colTree.querySelector('.mr-tree');
  if (root) root.style.display = 'none';
  v.skel = { tree: skeleton(), diff: skeleton() };
  p.colTree.append(v.skel.tree);
  p.diff.pane.style.display = 'none';
  p.diff.pane.before(v.skel.diff);
}

function endSkeleton(v, which) {
  const s = v.skel && v.skel[which];
  if (!s) return;
  v.skel[which] = null;
  s.remove();
  const target = which === 'tree' ? vparts.colTree.querySelector('.mr-tree') : vparts.diff.pane;
  if (!target) return;
  target.style.display = '';
  replay(target);
}

function resetView(v) {
  const p = vparts;
  const r = v.row;
  const title = r.title == null ? '' : String(r.title);
  p.f.avatar.textContent = initials(r.author, r.username);
  p.f.iid.textContent = `!${v.iid}`;
  p.f.title.textContent = title;
  p.f.title.title = title;
  p.f.author.textContent = r.author || r.username || '';
  p.f.branches.textContent = r.source && r.target ? `${r.source} → ${r.target}` : '';
  const rel = r.updatedAt ? ago(r.updatedAt) : '';
  p.f.updated.textContent = rel ? `mis à jour ${rel}` : '';
  if (rel) p.f.updated.title = fmtDate(r.updatedAt); else p.f.updated.removeAttribute('title');
  p.f.files.textContent = '';
  p.f.add.textContent = '';
  p.f.del.textContent = '';
  for (const [k, s] of Object.entries(p.steps)) { s.className = 'mr-step'; s.textContent = STEP_LABELS[k]; s.removeAttribute('title'); }
  p.stepsEl.hidden = false;
  p.failHost.replaceChildren();
  p.threadsHost.replaceChildren();
  setShown(p.threadsHost, false);
  setShown(p.trunc, false);
  p.bar.replaceChildren();
  p.bar.hidden = true;
  p.tree.setFiles([]);
  p.tree.setCounts([]); // counts outlive setFiles: a new MR starts from none
  p.tree.setDraftCounts([]);
  p.rail = mountRail(p.cols.querySelector('.mr-col-rail')); // fresh: no thread, draft, answer or typed text of the previous MR
  p.rail.setDescription(typeof r.description === 'string' ? r.description : ''); // from the list row: no extra call
  placeBubbles(mrScope(v), (bubble) => p.rail.placeClaude(bubble)); // the answers already given about this MR come back
  syncActions();
  setRailOpen(false); // every MR opens with the rail folded
  startSkeletons(v); // it sweeps every skeleton of the view: the rail loader goes in after it
  p.rail.setLoading(['threads', 'review']); // until the discussions and the drafts answer or fail
  p.diff.show(null, '', ''); // forget the previous MR's file: a resize re-render must not bring it back
}

function markStep(key, state, label) {
  const s = vparts.steps[key];
  s.classList.add(state);
  if (label) s.textContent = label;
  // The chips only report the load: once every part answered they hide (their done / fail classes stay in the DOM).
  vparts.stepsEl.hidden = Object.values(vparts.steps).every((c) => c.classList.contains('done') || c.classList.contains('fail'));
}

const syncTrunc = (v) => setShown(vparts.trunc, !!(v.truncFiles || v.truncDisc));

// Tree badges: threads (setCounts) and drafts (setDraftCounts, one entry per file, 0 included) per file, from whatever has arrived so far.
function refreshCounts(v) {
  if (!v.filesReady) return;
  const counts = v.res.files.map(() => ({ threads: 0 }));
  const drafts = v.res.files.map(() => 0);
  if (v.discReady) {
    for (const t of v.res.diffThreads) {
      const i = threadFileIdx(v.res.files, t.position);
      if (i >= 0) counts[i].threads++;
    }
  }
  for (const d of v.drafts) {
    let i = -1;
    if (isLineDraft(d)) i = v.res.files.findIndex((f) => sameFile(f, d.path));
    else if (isReplyDraft(d)) { // a reply counts for the file of the thread it answers (a general thread has none)
      const t = findThread(v, d.discussionId);
      if (t && t.position) i = threadFileIdx(v.res.files, t.position);
    }
    if (i >= 0) drafts[i]++;
  }
  vparts.tree.setCounts(counts);
  vparts.tree.setDraftCounts(drafts);
}

// Threads that have no line to sit on (file gone, no diff, line gone) are listed above the diff with their tag.
function renderOffLine(v) {
  const host = vparts.threadsHost;
  host.replaceChildren();
  const entries = v.placed.header;
  if (entries.length) {
    host.append(el('div', 'mr-threads-title', `Fils hors du diff (${entries.length})`));
    for (const h of entries) host.append(threadBox(h.thread, { label: positionLabel(h.thread.position), tag: h.tag }));
  }
  setShown(host, entries.length > 0);
}

function place(v) {
  if (!v.filesReady || !v.discReady) return;
  v.placed = placeThreads(v.res);
  renderOffLine(v);
}

function scrollToKey(v) {
  const key = v.jumpKey;
  v.jumpKey = null;
  const hit = key ? diffRowsByKey(vparts.diff.pane, key)[0] : null;
  if (hit) hit.scrollIntoView({ block: 'center' });
}

// Idempotent: rows put in by an earlier call are removed first (the diff column runs it once per render; late answers run it again).
function decorateRows(pane, file) {
  const v = mr.view;
  if (!v || v.res.files[v.selected] !== file) return;
  const held = holdBoxField(); // the rows below are rebuilt: a thread box in one of them is parked, then put back
  const editors = holdEditors(pane); // an open draft editor is rebuilt by draftBox with its text, then gets its caret and focus back
  heldEditors = editors;
  try {
    for (const tr of v.rows) if (tr.isConnected) vparts.diff.removeRow(tr);
    v.rows.clear();
    if (file.diff == null || file.diff === '') pane.replaceChildren(el('div', 'mr-diff-note', file.diff == null ? NO_DIFF_NOTE : EMPTY_DIFF_NOTE));
    for (const n of pane.querySelectorAll(':scope > .mr-lost')) n.remove();
    const lost = [];
    for (const t of v.placed ? v.placed.inline[v.selected] : []) {
      const tr = threadRow(t, v.folded, v.drafts);
      if (vparts.diff.insertRow(threadKey(t.position), tr)) v.rows.add(tr);
      else lost.push(t);
    }
    for (const t of lost.reverse()) {
      const box = threadBox(t, { label: positionLabel(t.position), tag: TAG_OBSOLETE });
      box.classList.add('mr-lost');
      pane.prepend(box);
    }
    for (const d of v.drafts) if (isLineDraft(d) && sameFile(file, d.path)) placeDraft(pane, d);
  } finally {
    heldEditors = null;
  }
  placeBubbles(askScope(v, file), placeAskBubble); // the answer bubbles of this file come back after every draw
  placeThreadBubbles(v); // so do the thread ones (their card is new, or gone: then their rail item holds them)
  reattachThreadBoxes(v);
  restoreEditors(pane, editors);
  restoreBoxField(held);
  scrollToKey(v);
}

// ---- Thread card footer and thread box (A2 / A3, D12) --------------------------------------------------------------------
// « Répondre » and « Demander à Claude » open ONE box per thread under its card (v.threadUi); a repaint re-appends the same node,
// so the typed text and the mode stay. A reply is saved as a draft in « Ma revue », never posted (kind 'reply').

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICON_REPLY = ['M9 17 4 12l5-5', 'M20 18v-2a4 4 0 0 0-4-4H4'];
const ICON_SPARK = ['M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z'];
const THREAD_LABELS = {
  group: 'Répondre à un fil ou demander à Claude',
  ask: { mode: 'Demander à Claude', hint: 'Pose ta question à Claude sur ce fil…', label: 'Question à Claude sur ce fil', send: 'Envoyer' },
  comment: { mode: 'Répondre', hint: 'Écris ta réponse…', label: 'Réponse au fil', send: 'Ajouter à ma revue' },
};

const hasThreadId = (t) => typeof t.id === 'string' && t.id !== '';
const messageCount = (n) => `${n} message${n > 1 ? 's' : ''}`;
const threadAuthor = (t) => String((t.notes && t.notes[0] && t.notes[0].author) || '');
// French elision: « d’Alice », « d’Émile », « d’Hugo » (a vowel or h, accents read off by NFD), else « de Bob ».
const deName = (name) => (/^[aeiouhœæ]/i.test(name.normalize('NFD')) ? `d’${name}` : `de ${name}`);
const threadWhere = (t) => (t.position ? positionLabel(t.position) : 'Général'); // D16
const threadHeads = (t) => ({
  ask: `Question à Claude sur ce fil · ${threadWhere(t)}`,
  comment: `Réponse au fil ${deName(threadAuthor(t))} · ${threadWhere(t)}`,
});
const findThread = (v, id) => [...((v.res && v.res.diffThreads) || []), ...((v.res && v.res.general) || [])].find((t) => t.id === id) || null;

// « Réponse au fil d’<auteur> » / « de <auteur> » · <chemin>:<ligne> (« · Général »); « Réponse à un fil » when the thread is not listed.
function replyLabel(d) {
  const v = mr.view;
  const t = v ? findThread(v, d.discussionId) : null;
  return t ? `Réponse au fil ${deName(threadAuthor(t))} · ${threadWhere(t)}` : 'Réponse à un fil';
}

function svgIcon(paths) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of paths) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}

function threadFoot(t) {
  const foot = el('div', 'mr-thread-foot');
  for (const [cls, label, icon, mode] of [['mr-thread-reply', 'Répondre', ICON_REPLY, 'comment'], ['mr-thread-ask', 'Demander à Claude', ICON_SPARK, 'ask']]) {
    const b = button('', `mr-thread-pill ${cls}`, () => openThreadBox(t, mode));
    b.append(svgIcon(icon), label);
    foot.append(b);
  }
  return foot;
}

const threadUiOf = (v) => v.threadUi || (v.threadUi = new Map()); // discussion id -> { box, host: 'card' | 'rail', from: the surface last clicked }

// The slot under a thread's rail item, null while the rail does not list the thread.
function railHome(id) {
  const slot = vparts && vparts.rail && typeof vparts.rail.threadSlot === 'function' ? vparts.rail.threadSlot(id) : null;
  return slot ? { slot, host: 'rail' } : null;
}

// Where a thread's box goes now: its rail item when it was opened there, else the slot under its shown card, else the rail item.
function threadHome(id, from) {
  const rail = from === 'rail' ? railHome(id) : null;
  if (rail) return rail;
  const pane = vparts && vparts.diff.pane;
  const card = pane && [...pane.querySelectorAll('.mr-thread-slot')].find((s) => s.dataset.id === id && !s.closest('tr.mr-spacer, tr.mr-wide-spacer'));
  return card ? { slot: card, host: 'card' } : railHome(id);
}

function reattachThreadBoxes(v) {
  if (!v.threadUi) return;
  for (const [id, cur] of v.threadUi) {
    const home = threadHome(id, cur.from);
    if (!home) continue;
    cur.host = home.host;
    if (cur.box.el.parentNode !== home.slot) {
      cur.box.el.classList.add('kept'); // a moved box does not play its entrance again
      home.slot.append(cur.box.el);
    }
  }
}

// Focus and caret of a thread box's field, kept across the rebuild of the rows around it (a detached node loses its focus).
function holdBoxField() {
  const a = document.activeElement;
  if (!a || a.tagName !== 'TEXTAREA' || !a.closest('.mr-thread-slot, .mr-rail-thread-slot')) return null;
  return { el: a, from: a.selectionStart, to: a.selectionEnd, dir: a.selectionDirection };
}

function restoreBoxField(f) {
  if (!f || !f.el.isConnected) return;
  if (document.activeElement !== f.el) f.el.focus({ preventScroll: true });
  try { f.el.setSelectionRange(f.from, f.to, f.dir || 'none'); } catch (_) { /* no selection on this field */ }
}

function closeThreadBox(v, id) {
  const cur = v.threadUi && v.threadUi.get(id);
  if (!cur) return;
  v.threadUi.delete(id);
  cur.box.close().then(() => cur.box.el.remove());
}

// mode: 'comment' (« Répondre ») or 'ask'. An open box keeps its text; the pill only picks the mode. from: 'card' (the inline pill) or
// 'rail' (the item's button): the box sits where it was last asked from, and a repaint keeps it there.
function openThreadBox(t, mode, from = 'card') {
  const v = mr.view;
  if (!v || !mr.current || !hasThreadId(t)) return;
  const id = t.id;
  const ui = threadUiOf(v);
  const open = ui.get(id);
  if (open) {
    open.from = from;
    reattachThreadBoxes(v);
    const pick = open.box.el.querySelector(`.mr-box-mode[data-mode="${mode}"]`);
    if (pick && !pick.classList.contains('on')) pick.click();
    open.box.focus();
    return;
  }
  const box = createBox({
    popup: false,
    mode,
    labels: THREAD_LABELS,
    heads: threadHeads(t),
    onSubmit: (m, text) => (m === 'ask' ? askThread(v, t, text) : createThreadReply(v, id, text, box)),
    onCancel: () => closeThreadBox(v, id),
  });
  ui.set(id, { box, host: from, from });
  reattachThreadBoxes(v);
  box.focus();
}

// D14: a thread as the lines of the message: « <auteur> — <date> : », the body lines, a blank line, per note.
function threadNoteLines(t) {
  const lines = [];
  for (const n of t.notes || []) lines.push(`${n.author} — ${fmtDate(n.createdAt)} :`, ...String(n.body ?? '').split(/\r?\n/), '');
  return lines;
}

// composeCodeMessage(…, '') ends with its « … coupé : » line(s) when it cut the lines; a body line can never sit that close to the end.
const CUT_TAIL = /\n… coupé : [^\n]*\n(?:… coupé : [^\n]*\n)?\n$/;

// « Demander à Claude » from a thread box: the whole thread goes to the session through sendAsk, the bubble lands under the thread.
// The thread is read again at send time (a refresh may have brought notes); a refusal places nothing, keeps the text and shows its notice.
function askThread(v, t, question) {
  const cur = findThread(v, t.id) || t;
  if (!liveView(v) || !Array.isArray(cur.notes) || !cur.notes.length) return { ok: false, notice: 'Action indisponible' };
  const line = cur.position ? positionLabel(cur.position) : '';
  const ref = `!${v.iid} · fil ${line || 'général'}`; // the bubble's display ref
  const msgRef = `MR ${ref}`; // the message never starts with « ! » (bash mode of the Claude Code prompt)
  const lines = threadNoteLines(cur);
  const n = cur.notes.length;
  const cut = CUT_TAIL.test(composeCodeMessage(msgRef, lines, ''));
  const res = sendAsk({
    question,
    anchor: { id: cur.id },
    threadRef: `${ref} · ${threadAuthor(cur)}`,
    scope: threadScope(v, cur.id),
    compose: (q) => composeCodeMessage(msgRef, lines, q),
    sentNote: `Envoyé à la session : ${n > 1 ? `les ${n} messages` : 'le message'} du fil${line ? `, sa ligne ${line}` : ''} et ta question.${cut ? ' (fil coupé à l’envoi)' : ''}`,
    placeBubble: placeThreadBubble,
  });
  if (res.ok) closeThreadBox(v, cur.id);
  return res;
}

// The bubble goes in the slot under the thread's inline card when that card is shown, else under its rail item (D12), above an open box.
// A bubble already in its slot stays put, so a repaint does not take the focus of its « Continuer le fil » field.
function placeThreadBubble(bubble, anchor) {
  const home = mr.view && anchor ? threadHome(anchor.id, 'card') : null;
  if (!home || bubble.parentNode === home.slot) return;
  home.slot.insertBefore(bubble, home.slot.querySelector(':scope > .mr-box'));
}

function placeThreadBubbles(v) {
  for (const t of [...((v.res && v.res.diffThreads) || []), ...((v.res && v.res.general) || [])]) {
    if (hasThreadId(t)) placeBubbles(threadScope(v, t.id), placeThreadBubble);
  }
}

// A reply is a draft { kind: 'reply', discussionId, body }; answers { ok, notice } like createDraft, and closes the box once stored.
// Only the box that sent it: « Annuler » may have closed it during the save and a new box may sit on the thread by now.
async function createThreadReply(v, id, body, box) {
  const cur = mr.current;
  if (!liveView(v) || !cur) return { ok: false, notice: 'Brouillon non enregistré' };
  const res = await window.api.gitlabDraftSave(cur.target, v.iid, { kind: 'reply', discussionId: id, body }).catch(() => null);
  if (!liveView(v)) return { ok: false, notice: 'Brouillon non enregistré' };
  if (!res || res.ok !== true || !res.draft) return { ok: false, notice: failText(res, 'Brouillon non enregistré') };
  v.drafts.push(res.draft);
  if (v.threadUi && v.threadUi.get(id)?.box === box) closeThreadBox(v, id);
  updateDraftBar();
  return { ok: true };
}

// An answer landed after the file was drawn: place it without drawing the file again (a render still running decorates by itself).
function redecorate(v) {
  const pane = vparts.diff.pane;
  const f = v.selected != null ? v.res.files[v.selected] : null;
  if (f && !pane.dataset.rendering) decorateRows(pane, f);
}

const STALE_FILE_NOTICE = 'Fichier modifié depuis le diff — rafraîchir';
const FILE_CAPPED_NOTICE = 'Fichier trop volumineux pour déplier';
const FILE_BINARY_NOTICE = 'Fichier binaire : rien à déplier';
const FILE_FAIL_NOTICE = 'Impossible de charger le fichier';

// Context expansion. The text of a file at the shown head is fetched once per view (`v.fileText`: head + NUL + path -> Promise of
// the answer). A failed answer is evicted so the next pick asks again; capped and binary answers stay (fixed for that sha).
const expandable = (f) => {
  const v = mr.view;
  return !!v && !!f && typeof f.diff === 'string' && f.diff !== '' && f.status !== 'A' && f.status !== 'D'
    && typeof f.newPath === 'string' && f.newPath !== '' && !!shownHead(v);
};

function fileTextOf(v, f) {
  const head = shownHead(v);
  const target = mr.current && mr.current.target;
  if (!head || !target) return Promise.resolve({ ok: false });
  const key = `${head}\0${f.newPath}`;
  let p = v.fileText.get(key);
  if (!p) {
    p = (async () => {
      let res = null;
      try { res = await window.api.gitlabFileRaw(target, f.newPath, head); } catch (_) { res = null; }
      if (res && res.ok === true) return res;
      if (v.fileText.get(key) === p) v.fileText.delete(key);
      return res && typeof res === 'object' ? res : { ok: false };
    })();
    v.fileText.set(key, p);
  }
  return p;
}

const lineCount = (t) => (t === '' ? 0 : t.split('\n').length - (t.endsWith('\n') ? 1 : 0));

// The tail control needs the file's line count: asked after show() (it forgets the count), dropped when the user moved on.
function prefetchLines(v, f) {
  const i = v.selected;
  fileTextOf(v, f).then((res) => {
    if (!res || res.ok !== true || typeof res.text !== 'string' || mr.view !== v || v.selected !== i || !vparts) return;
    vparts.diff.setFileLines(lineCount(res.text));
  });
}

async function onExpand(file, req, text) {
  const v = mr.view;
  if (!v) return null;
  const res = await fileTextOf(v, file);
  if (!res || res.ok !== true) return { notice: failText(res, FILE_FAIL_NOTICE) };
  if (res.capped) return { notice: FILE_CAPPED_NOTICE };
  if (res.binary) return { notice: FILE_BINARY_NOTICE };
  if (typeof res.text !== 'string' || !matches(text, res.text)) return { notice: STALE_FILE_NOTICE };
  return { text: expandDiff(text, res.text, req) };
}

// `pos` = { i, n } from the tree (K1 / K2): forwarded as the 4th argument of `show`, none passed when the tree sends none.
function showFile(i, pos) {
  const v = mr.view;
  const f = v && v.res.files[i];
  if (!f || !vparts) return;
  v.selected = i;
  endSkeleton(v, 'diff');
  const label = f.oldPath && f.oldPath !== f.newPath ? `${f.oldPath} → ${f.newPath}` : f.newPath;
  const blank = f.diff == null || f.diff === ''; // show() ends in decorateRows, which writes the note
  const text = blank ? '' : synthDiff(f);
  if (pos) vparts.diff.show(f, text, label, pos); else vparts.diff.show(f, text, label);
  if (expandable(f)) prefetchLines(v, f);
}

function jumpTo(pos) {
  const v = mr.view;
  if (!v || !v.filesReady || !pos) return;
  const i = threadFileIdx(v.res.files, pos);
  if (i < 0) return;
  v.jumpKey = threadKey(pos);
  if (v.selected !== i) vparts.tree.select(i);
  else if (!vparts.diff.pane.dataset.rendering) scrollToKey(v); // a render still running scrolls from decorate
}

function onVersion(v, ver) {
  v.res.version = ver;
  markStep('version', 'done', `Version ${String(ver.head || '').slice(0, 7)}`.trim());
  vparts.steps.version.title = `Version ${ver.id ?? ''}`.trim();
  updateDraftBar(); // « Approuver » needs the head
  const shown = v.selected != null ? v.res.files[v.selected] : null;
  if (shown && expandable(shown)) prefetchLines(v, shown); // the file was drawn before the head was known
}

function onFiles(v, files, truncated) {
  v.res.files = files;
  v.res.truncated = truncated;
  v.filesReady = true;
  v.truncFiles = truncated;
  markStep('files', 'done');
  let add = 0;
  let del = 0;
  for (const f of files) {
    if (f.diff == null) continue;
    const s = diffStat(f.diff);
    add += s.add;
    del += s.del;
  }
  vparts.f.files.textContent = `${files.length} ${files.length > 1 ? 'fichiers' : 'fichier'}`;
  vparts.f.add.textContent = `+${add}`;
  vparts.f.del.textContent = `${MINUS}${del}`;
  vparts.tree.setFiles(files);
  replaySeen(v);
  endSkeleton(v, 'tree');
  syncTrunc(v);
  place(v);
  updateDraftBar(); // the drafts of a file outside the MR can be told now; refreshes the tree counts
  if (!files.length) {
    endSkeleton(v, 'diff');
    vparts.diff.pane.replaceChildren();
    notice(vparts.diff.pane, 'Aucun fichier modifié');
    return;
  }
  vparts.tree.select(0);
}

function onDiscussions(v, d) {
  if (!v.firstNoteIds) v.firstNoteIds = new Set([...d.diffThreads, ...d.general].flatMap((t) => (t.notes || []).map((n) => n.id))); // the first successful read is the baseline
  v.res.diffThreads = d.diffThreads;
  v.res.general = d.general;
  v.discReady = true;
  v.truncDisc = d.truncated === true;
  markStep('discussions', 'done');
  vparts.rail.setThreads(d, { isNew: isNewNote });
  reattachThreadBoxes(v); // the rail items are new nodes; their slots, and what sits in them, are the same elements
  placeThreadBubbles(v); // a fresh rail (the MR opened again) gets its answers back
  syncReplyDrafts(v);
  syncTrunc(v);
  place(v);
  refreshCounts(v);
  redecorate(v);
}

function onDrafts(v, drafts) {
  v.drafts = drafts;
  v.draftsDone = true;
  v.draftsError = '';
  updateDraftBar();
  redecorate(v);
}

function onPartError(v, part, message) {
  if (PART_STEP[part]) markStep(PART_STEP[part], 'fail');
  if (part === 'diffs') {
    endSkeleton(v, 'tree');
    endSkeleton(v, 'diff');
    vparts.diff.pane.replaceChildren();
  } else if (part === 'drafts') {
    v.draftsDone = true;
    v.draftsError = DRAFTS_UNAVAILABLE;
    updateDraftBar();
  } else if (part === 'discussions') {
    vparts.rail.setThreads(null); // ends the rail loader; the empty text is the right state after a failure
  }
  const row = el('div', 'mr-fail');
  row.append(el('span', null, `Impossible de charger ${PART_NOUN[part]} : ${message}`), button('Réessayer', '', () => openMr(v.row)));
  vparts.failHost.append(row);
}

function ensureView() {
  if (viewEl) return viewEl;
  viewEl = el('div');
  viewEl.id = 'gp-mr-view';
  viewEl.hidden = true;
  const head = el('div', 'mr-view-head');
  const f = {};
  for (const [k, cls] of [['avatar', 'mr-avatar'], ['iid', 'mr-view-head-iid'], ['title', 'mr-view-head-title'], ['author', 'mr-view-head-author'],
    ['branches', 'mr-view-head-branches'], ['updated', 'mr-view-head-updated'], ['files', 'mr-view-head-files'], ['stat', 'mr-view-head-stat']]) f[k] = el('span', cls);
  f.add = el('span', 'add');
  f.del = el('span', 'del');
  f.stat.append(f.add, f.del);
  const stepsEl = el('div', 'mr-steps');
  const steps = {};
  for (const k of Object.keys(STEP_LABELS)) {
    steps[k] = el('span', 'mr-step', STEP_LABELS[k]);
    steps[k].dataset.step = k;
    stepsEl.append(steps[k]);
  }
  const cols = el('div', 'mr-cols');
  const toggle = button('', 'mr-rail-toggle', () => pickRail(!cols.classList.contains('rail-open'))); // icon-only (drawn by the stylesheet)
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-label', 'Fils et revue');
  toggle.title = 'Fils et revue';
  const back = button('‹ MR', 'mr-view-back', goBack);
  back.setAttribute('aria-label', 'Retour à la liste');
  head.append(back, f.avatar, f.iid, f.title, f.author, f.branches, f.updated, f.files, f.stat, stepsEl, toggle);
  const colTree = el('div', 'mr-col-tree');
  const colDiff = el('div', 'mr-col-diff');
  const colRail = el('div', 'mr-col-rail');
  const failHost = el('div');
  const trunc = el('div', 'mr-note', TRUNC_NOTE);
  const threadsHost = el('div', 'mr-threads');
  const bar = el('div', 'mr-drafts-bar');
  setShown(trunc, false);
  setShown(threadsHost, false);
  bar.hidden = true;
  colDiff.append(failHost, trunc, threadsHost, bar); // the diff column appends its bar and pane after these
  const tree = mountMrTree(colTree, { onSelect: showFile, collapse, expand, onSeen: (path, on) => onSeenMark(path, on, true) });
  const treeScroller = colTree.querySelector('.mr-tree');
  if (treeScroller) autoHideScrollbar(treeScroller);
  const diff = mountMrDiff(colDiff, {
    onPrev: () => tree.move(-1),
    onNext: () => tree.move(1),
    onAsk: onLineAsk,
    onComment: onLineComment,
    decorate: decorateRows,
    onSeen: (path, on) => onSeenMark(path, on, false),
    expandable,
    onExpand,
  });
  const rail = mountRail(colRail);
  cols.append(colTree, colDiff, colRail);
  viewEl.append(head, cols);
  vparts = { f, steps, stepsEl, cols, toggle, colTree, colDiff, failHost, trunc, threadsHost, bar, tree, diff, rail };
  viewEl.addEventListener('keydown', (e) => { // the vertical arrows walk the files; typing and the rail keep their keys
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || !mr.view) return;
    if (e.target.closest && e.target.closest('input, textarea, select, [contenteditable], .mr-col-rail, .mr-dialog-backdrop')) return;
    const delta = e.key === 'ArrowDown' ? 1 : (e.key === 'ArrowUp' ? -1 : 0);
    if (!delta) return;
    e.preventDefault();
    vparts.tree.move(delta);
  });
  byId('gp-mr').appendChild(viewEl);
  return viewEl;
}

function openMr(row) {
  const mine = mr.current;
  const iid = Number(row && row.iid);
  if (!mine || !Number.isInteger(iid)) return;
  ensureView();
  closeDialog();
  if (mr.view && mr.view.load) mr.view.load.cancel(); // mr-load has no sequence guard of its own
  const seq = ++viewSeq;
  const v = {
    iid, row, res: { ok: true, files: [], diffThreads: [], general: [], version: null, truncated: false }, placed: null, selected: null,
    drafts: [], draftsError: '', draftsDone: false, filesReady: false, discReady: false, truncFiles: false, truncDisc: false, rows: new Set(), skel: null,
    jumpKey: null, load: null, folded: new Set(), seenKey: `${mine.root}\n${iid}`, fileText: new Map(),
  };
  mr.view = v;
  const heading = byId('gp-mr').querySelector('.mr-heading');
  if (!heading.dataset.list) heading.dataset.list = heading.textContent;
  heading.textContent = `!${iid} ${row.title == null ? '' : String(row.title)}`;
  byId('gp-mr').classList.add('mr-in-view');
  hideChrome(true);
  if (!sp.max) { // D6: the review wants room; only a maximize made here is undone on leaving
    autoMax = true;
    toggleSidePanelMax();
  }
  viewEl.hidden = false;
  replay(viewEl);
  resetView(v);
  const live = () => mr.view === v && viewSeq === seq && !!mr.current && mr.current.root === mine.root;
  v.discBusy = true; // the first discussions read is the one in flight until it answers or fails
  v.discSig = null;
  v.discAt = 0;
  v.liveTimer = null;
  v.tickLoad = null;
  v.load = loadMrParts(mine.target, iid, {
    onVersion: (ver) => { if (live()) onVersion(v, ver); },
    onFiles: (files, truncated) => { if (live()) onFiles(v, files, truncated); },
    onDiscussions: (d) => {
      if (!live()) return;
      v.discBusy = false;
      v.discSig = discSig(d);
      v.discAt = Date.now();
      onDiscussions(v, d);
    },
    onDrafts: (drafts) => { if (live()) onDrafts(v, drafts); },
    onError: (part, message) => {
      if (!live()) return;
      if (part === 'discussions') v.discBusy = false;
      onPartError(v, part, message);
    },
  });
  startLive(v, live, mine.target);
}

// ---- live refresh: the shown MR re-reads its discussions every REFRESH_MS, one read in flight, stopped by every exit (leaveView) ----
const REFRESH_MS = 12000;
let refreshOwner = null;

const discSig = (d) => JSON.stringify({ diffThreads: d.diffThreads, general: d.general, truncated: d.truncated === true });

function startLive(v, live, target) {
  if (refreshOwner && refreshOwner !== v) stopLive(refreshOwner);
  refreshOwner = v;
  v.liveTimer = setInterval(() => liveTick(v, live, target), REFRESH_MS);
  v.freshTimer = setInterval(() => paintFresh(v), 1000);
}

// A6: the rail head shows the age of the last successful discussions read (v.discAt); nothing before the first one.
function paintFresh(v) {
  if (mr.view !== v || !vparts || !v.discAt) return;
  vparts.rail.setFresh(Math.floor((Date.now() - v.discAt) / 1000));
}

function stopLive(v) {
  if (!v) return;
  if (v.liveTimer) { clearInterval(v.liveTimer); v.liveTimer = null; }
  if (v.freshTimer) { clearInterval(v.freshTimer); v.freshTimer = null; }
  if (v.tickLoad) { v.tickLoad.cancel(); v.tickLoad = null; } // a late answer paints nothing
  if (refreshOwner === v) refreshOwner = null;
}

function liveTick(v, live, target) {
  if (!live()) { stopLive(v); return; }
  if (v.discBusy) return;
  v.discBusy = true;
  v.tickLoad = loadMrParts(target, v.iid, {
    onDiscussions: (d) => { v.discBusy = false; v.tickLoad = null; if (live()) applyRefresh(v, d); },
    onError: () => { v.discBusy = false; v.tickLoad = null; }, // no .mr-fail, the threads stay; the next tick tries again
  }, ['discussions']);
}

// What a scroller keeps in view across a repaint: a node that survives it and where it sits in the scroller (measured from the
// scroller's own top, so content that moves the scroller itself, « Fils hors du diff », is no shift). The diff column pins the open
// line box, else the first diff line shown (line rows are not rebuilt); the rail pins the first thread item shown, found again by id.
function pinOf(n) {
  const view = n.getBoundingClientRect();
  const shown = (e) => { const r = e.getBoundingClientRect(); return r.bottom > view.top && r.top < view.bottom; };
  const at = (e) => e.getBoundingClientRect().top - view.top;
  if (n === vparts.diff.pane) {
    const box = n.querySelector('tr.mr-box-row');
    const row = box && shown(box) ? box : [...n.querySelectorAll('.d2h-code-line-ctn')].find(shown)?.closest('tr');
    return row ? { find: () => (row.isConnected ? row : null), top: at(row) } : null;
  }
  const item = [...n.querySelectorAll('.mr-rail-thread')].find((e) => e.dataset.id != null && shown(e));
  if (!item) return null;
  const id = item.dataset.id;
  return { find: () => [...n.querySelectorAll('.mr-rail-thread')].find((e) => e.dataset.id === id) || null, top: at(item) };
}

let anchorRestore = null; // { frame, scroll }: overflow-anchor values waiting for the next frame (a hidden window runs none)

function restoreAnchors() {
  if (!anchorRestore) return;
  cancelAnimationFrame(anchorRestore.frame);
  for (const { n, anchor } of anchorRestore.scroll) n.style.overflowAnchor = anchor;
  anchorRestore = null;
}

// Scroll offsets of the diff column and of the rail, plus the focused field, kept across a repaint of live DOM.
function holdUi() {
  restoreAnchors(); // a refresh before the last one's frame ran must not save that one's 'none' as the value to restore
  const nodes = [];
  const climb = (n) => { for (; n && n !== viewEl.parentElement; n = n.parentElement) nodes.push(n); };
  climb(vparts.diff.pane);
  const colRail = vparts.cols.querySelector('.mr-col-rail');
  if (colRail) { climb(colRail); nodes.push(...colRail.querySelectorAll('*')); }
  const scroll = [...new Set(nodes)].filter((n) => n.scrollTop > 0).map((n) => ({ n, top: n.scrollTop, anchor: n.style.overflowAnchor, pin: pinOf(n) }));
  for (const s of scroll) s.n.style.overflowAnchor = 'none'; // Chromium scroll anchoring must not move what is restored below
  const a = document.activeElement;
  const field = a && viewEl.contains(a) && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT')
    ? { el: a, from: a.selectionStart, to: a.selectionEnd, dir: a.selectionDirection } : null;
  const railId = a && a.classList && a.classList.contains('mr-rail-thread') ? a.dataset.id : null;
  return { scroll, field, railId };
}

function releaseUi(h) {
  for (const { n, top, pin } of h.scroll) {
    if (!n.isConnected) continue;
    const now = pin && pin.find();
    n.scrollTop = now ? n.scrollTop + now.getBoundingClientRect().top - n.getBoundingClientRect().top - pin.top : top; // content landed above moves the offset with it
  }
  anchorRestore = { scroll: h.scroll, frame: requestAnimationFrame(restoreAnchors) }; // anchoring back once the frame is laid out
  const f = h.field;
  if (f && f.el.isConnected) {
    if (document.activeElement !== f.el) f.el.focus({ preventScroll: true });
    if (f.from != null && (f.el.selectionStart !== f.from || f.el.selectionEnd !== f.to)) {
      try { f.el.setSelectionRange(f.from, f.to, f.dir || 'none'); } catch (_) { /* input type without a selection */ }
    }
  }
  if (h.railId != null && !(document.activeElement && viewEl.contains(document.activeElement))) {
    const hit = [...vparts.cols.querySelectorAll('.mr-rail-thread')].find((r) => r.dataset.id === h.railId);
    if (hit) hit.focus({ preventScroll: true });
  }
}

// A first read that failed leaves a fail row and a red chip: the first good tick clears both, then applies like onDiscussions.
function dropDiscFail() {
  const lead = `Impossible de charger ${PART_NOUN.discussions} :`;
  for (const r of [...vparts.failHost.children]) if ((r.firstChild ? r.firstChild.textContent : '').startsWith(lead)) r.remove();
  vparts.steps.discussions.classList.remove('fail');
}

function applyRefresh(v, d) {
  v.discAt = Date.now();
  const sig = discSig(d);
  if (v.discReady && sig === v.discSig) return; // same answer: nothing is repainted
  if (!v.discReady) dropDiscFail();
  v.discSig = sig;
  const held = holdUi();
  const seen = new Set([...v.rows].map((tr) => tr.textContent));
  onDiscussions(v, d);
  for (const tr of v.rows) if (tr.isConnected && seen.has(tr.textContent)) tr.classList.remove('mr-enter'); // only new or changed cards enter
  releaseUi(held);
}

// The back action of both back buttons: #gp-mr-back (the list) and .mr-view-back (the view header).
function goBack() {
  if (mr.view) { // inside an MR: back to the list (a showing), not to the status list
    leaveView();
    showList();
    replay(byId('gp-mr-list')); // U11: the list enters (opacity / transform) while already visible and clickable
    byId('gp-mr-list').focus({ preventScroll: true });
    return;
  }
  showStatus();
  byId('gp-files').focus({ preventScroll: true });
}

export function initMrReview() {
  overlayState.onGitRepo = onGitRepo;
  overlayState.onGitFolder = onGitFolder;
  const staticHeading = byId('gp-mr').querySelector('.mr-heading'); // the list's own heading (mr-list.js) is the one shown
  if (staticHeading) staticHeading.style.display = 'none'; // still written by openMr / leaveView
  // The tab hides (panel closed, another tab shown): no entry of the previous repo lingers, and the next
  // opening starts on the status list.
  new MutationObserver(() => {
    if (!byId('git-panel').hidden) return;
    folderSeq++;
    mr.current = null;
    byId('gp-mr-btn').hidden = true;
    showStatus();
  })
    .observe(byId('git-panel'), { attributes: true, attributeFilter: ['hidden'] });
  byId('gp-mr-btn').addEventListener('click', openList);
  byId('gp-mr-back').addEventListener('click', goBack);
}
