// claude-deck — renderer/mr-tree: the file column of the MR review (board D). Head with the file count and the fold-all
// buttons, files grouped by foldable directory, status pill, thread / draft / seen marks and a 5-block diffstat, a
// progress line with a key hint, a filter field, up / down arrow keys (hidden rows skipped). Pure DOM, no IO; its one
// import is statBar of diff-view.js (itself import-free). Every path and count reaches the page through textContent;
// fold motion is injected (mount options collapse / expand).
import { statBar } from './diff-view.js';

const STATUSES = new Set(['M', 'A', 'D', 'R']);
const ROOT_LABEL = '(racine)';
const MINUS = '−';
// The diffstat numbers stay readable to assistive tech and to the old selectors while the bar is the visible form.
const VISUALLY_HIDDEN = { position: 'absolute', width: '1px', height: '1px', overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' };

const pathOf = (f) => String(f.newPath || f.oldPath || '');
const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const baseOf = (p) => p.slice(p.lastIndexOf('/') + 1);
const countOf = (n) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);
const show = (el, on) => { el.hidden = !on; el.style.display = on ? '' : 'none'; };

function node(tag, cls, text) {
  const el = document.createElement(tag);
  el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

// An icon-only button: the name lives in aria-label and title, the stylesheet draws the icon.
function iconButton(cls, label) {
  const b = node('button', cls);
  b.type = 'button';
  b.setAttribute('aria-label', label);
  b.title = label;
  return b;
}

function countMark(cls, n, one, many) {
  const el = node('span', cls, String(n));
  el.title = `${n} ${n > 1 ? many : one}`;
  return el;
}

// Added / deleted lines of one file's unified diff text. Only lines after a hunk header count, so a
// deleted "-- x" (shown "--- x") is a deletion, never a file header.
export function diffStat(text) {
  let add = 0;
  let del = 0;
  if (typeof text !== 'string') return { add, del };
  let inHunk = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('@@')) inHunk = true;
    else if (line.startsWith('diff --git ')) inHunk = false;
    else if (!inHunk) continue;
    else if (line[0] === '+') add++;
    else if (line[0] === '-') del++;
  }
  return { add, del };
}

export function mountMrTree(host, { onSelect, onSeen, collapse, expand } = {}) {
  const hideRow = typeof collapse === 'function' ? collapse : (el) => show(el, false);
  const showRow = typeof expand === 'function' ? expand : (el) => show(el, true);
  const root = node('div', 'mr-tree');
  const progress = node('div', 'mr-tree-progress');
  const progressLabel = node('span', 'mr-tree-progress-label');
  const progressBar = node('div', 'mr-tree-progress-bar');
  const progressFill = document.createElement('i');
  progressBar.append(progressFill);
  const hint = node('div', 'mr-tree-hint');
  hint.append(node('kbd', '', '↓'), node('kbd', '', '↑'), node('span', 'mr-tree-hint-text', 'fichier suivant ou précédent'));
  progress.append(progressLabel, progressBar, hint);
  const filter = node('input', 'mr-tree-filter');
  filter.type = 'text';
  filter.placeholder = 'Filtrer les fichiers';
  filter.setAttribute('aria-label', 'Filtrer les fichiers');
  filter.autocomplete = 'off';
  filter.spellcheck = false;
  const head = node('div', 'mr-tree-head');
  const headCount = node('span', 'mr-tree-count', '0');
  const foldAll = iconButton('mr-tree-foldall', 'Tout replier');
  const unfoldAll = iconButton('mr-tree-foldall', 'Tout déplier');
  head.append(node('span', 'mr-tree-title', 'Fichiers'), headCount, foldAll, unfoldAll);
  const empty = node('div', 'mr-empty', 'Aucun fichier ne correspond');
  show(progress, false);
  show(head, false);
  show(empty, false);
  root.append(head, filter, empty, progress); // the head opens the column and the review progress closes it (board D)
  host.replaceChildren(root);

  const folded = new Set(); // folded directory keys, kept for the app run (survives setFiles)
  const seen = new Set(); // idx of the files marked seen
  let files = [];
  let counts = [];
  let draftCounts = []; // setDraftCounts: an entry wins over the drafts of setCounts
  let sel = -1;
  let rows = []; // idx -> {btn, stat, marks}
  let dirs = []; // [{el, btn, key, idxs}] in displayed order
  let dirOfIdx = []; // idx -> its dirs entry
  let idxOfPath = new Map();
  let haystack = []; // idx -> lower-cased paths the filter matches
  let match = new Set(); // idx the filter keeps
  let order = []; // idx in displayed order
  let posOf = new Map();
  let visible = new Set(); // idx matching the filter in an unfolded directory

  function syncTab() {
    const first = order.find((i) => visible.has(i));
    const cur = sel >= 0 && visible.has(sel) ? sel : first;
    rows.forEach((r, i) => { r.btn.tabIndex = i === cur ? 0 : -1; });
  }

  // Instant repaint of every directory and row from the filter and the fold set.
  function refresh() {
    visible = new Set();
    for (const d of dirs) {
      const isFolded = folded.has(d.key);
      d.btn.setAttribute('aria-expanded', String(!isFolded));
      let n = 0;
      for (const i of d.idxs) {
        const kept = match.has(i);
        const on = kept && !isFolded;
        show(rows[i].btn, on);
        if (on) visible.add(i);
        if (kept) n++;
      }
      show(d.el, n > 0);
    }
    show(empty, files.length > 0 && match.size === 0);
    show(head, files.length > 0);
    syncTab();
  }

  function applyFilter() {
    const needle = filter.value.trim().toLowerCase();
    match = new Set();
    files.forEach((_, i) => { if (!needle || haystack[i].includes(needle)) match.add(i); });
    // a search reveals its hits: a folder holding one is unfolded
    if (needle) for (const d of dirs) if (d.idxs.some((i) => match.has(i))) folded.delete(d.key);
    refresh();
  }

  function setFolded(d, on) {
    if (folded.has(d.key) === on) return;
    if (on) folded.add(d.key); else folded.delete(d.key);
    d.btn.setAttribute('aria-expanded', String(!on));
    for (const i of d.idxs) {
      if (!match.has(i)) continue;
      if (on) visible.delete(i); else visible.add(i);
      (on ? hideRow : showRow)(rows[i].btn);
    }
    syncTab();
  }

  function paintProgress() {
    show(progress, files.length > 0);
    progressLabel.textContent = `Revue ${seen.size} / ${files.length} vus`;
    progressFill.style.width = `${files.length ? (seen.size / files.length) * 100 : 0}%`;
  }

  // Silent for the caller's own sync; onSeen reports every real change of state, whatever its source.
  function setSeen(path, on) {
    const i = idxOfPath.get(String(path));
    if (i === undefined) return;
    const want = !!on;
    if (seen.has(i) === want) return;
    if (want) seen.add(i); else seen.delete(i);
    rows[i].btn.classList.toggle('seen', want);
    paintMarks(i);
    paintProgress();
    if (typeof onSeen === 'function') onSeen(String(path), want);
  }

  function draftsOf(i) {
    const d = draftCounts[i];
    if (d === undefined || d === null) return (counts[i] || {}).drafts;
    return typeof d === 'object' ? d.drafts : d;
  }

  // Threads, drafts and seen marks of one row, in that order, just before the diffstat. The old
  // mr-file-* classes stay on the count marks: probes and the stylesheet still key off them.
  function paintMarks(i) {
    const r = rows[i];
    r.marks.forEach((el) => el.remove());
    r.marks = [];
    const t = countOf((counts[i] || {}).threads);
    const d = countOf(draftsOf(i));
    if (t) r.marks.push(countMark('mr-file-threads mr-tree-threads', t, 'fil', 'fils'));
    if (d) r.marks.push(countMark('mr-file-drafts mr-tree-drafts', d, 'brouillon', 'brouillons'));
    if (seen.has(i)) {
      const mark = node('span', 'mr-tree-seen', '✓');
      mark.title = 'Vu';
      r.marks.push(mark);
    }
    r.stat.before(...r.marks);
  }

  const applyCounts = () => rows.forEach((_, i) => paintMarks(i));

  function buildFile(f, i) {
    const path = pathOf(f);
    const st = STATUSES.has(f.status) ? f.status : 'M';
    const btn = node('button', 'mr-file');
    btn.type = 'button';
    btn.dataset.idx = String(i);
    btn.tabIndex = -1;
    btn.title = st === 'R' && f.oldPath ? `${f.oldPath} → ${path}` : path;
    const status = node('span', 'mr-file-status dv-pill', st);
    status.dataset.s = st;
    status.dataset.st = st;
    const stat = node('span', 'mr-file-stat');
    if (f.tooLarge || f.collapsed) {
      stat.textContent = '—'; // counts unknown, never a fake +0 -0
      stat.title = 'Diff non fourni';
    } else {
      const { add, del } = diffStat(f.diff);
      const nums = [node('span', 'add', `+${add}`), node('span', 'del', `${MINUS}${del}`)];
      for (const n of nums) Object.assign(n.style, VISUALLY_HIDDEN);
      stat.title = `+${add} ${MINUS}${del}`;
      stat.append(...nums, statBar(add, del));
    }
    btn.append(status, node('span', 'mr-file-name', baseOf(path)), stat);
    btn.addEventListener('click', () => select(i));
    return { btn, stat };
  }

  function buildDir(dir) {
    const g = { el: node('div', 'mr-dir'), key: dir, idxs: [] };
    g.btn = node('button', 'dv-dir');
    g.btn.type = 'button';
    g.btn.title = dir || ROOT_LABEL;
    g.btn.setAttribute('aria-expanded', 'true');
    const chev = node('span', 'dv-chev');
    chev.setAttribute('aria-hidden', 'true');
    g.count = node('span', 'dv-count', '0');
    const ico = node('i', 'mr-tree-ico'); // the stylesheet draws the folder icon
    ico.setAttribute('aria-hidden', 'true');
    g.btn.append(chev, ico, node('span', 'mr-dir-name', dir || ROOT_LABEL), g.count);
    g.btn.addEventListener('click', () => setFolded(g, !folded.has(g.key)));
    g.el.append(g.btn);
    return g;
  }

  function setFiles(next) {
    files = Array.isArray(next) ? next : [];
    sel = -1;
    seen.clear(); // marks belong to one list of files: the caller replays them through setSeen
    for (const d of dirs) d.el.remove();
    rows = [];
    dirs = [];
    dirOfIdx = [];
    haystack = [];
    idxOfPath = new Map();
    const byDir = new Map();
    files.forEach((raw, i) => {
      const f = raw && typeof raw === 'object' ? raw : {};
      const path = pathOf(f);
      const dir = dirOf(path);
      let g = byDir.get(dir);
      if (!g) {
        g = buildDir(dir);
        byDir.set(dir, g);
        dirs.push(g);
      }
      const { btn, stat } = buildFile(f, i);
      g.el.append(btn);
      g.idxs.push(i);
      dirOfIdx[i] = g;
      rows[i] = { btn, stat, marks: [] };
      haystack[i] = `${path}\n${f.oldPath || ''}`.toLowerCase();
      if (path) idxOfPath.set(path, i);
    });
    for (const g of dirs) g.count.textContent = String(g.idxs.length);
    order = dirs.flatMap((d) => d.idxs);
    posOf = new Map(order.map((idx, p) => [idx, p]));
    empty.before(...dirs.map((d) => d.el));
    headCount.textContent = String(files.length);
    paintProgress();
    applyCounts();
    applyFilter();
  }

  function setCounts(next) {
    counts = Array.isArray(next) ? next : []; // held across setFiles: discussions may land before the files
    applyCounts();
  }

  function setDraftCounts(next) {
    draftCounts = Array.isArray(next) ? next : []; // held across setFiles, like setCounts
    applyCounts();
  }

  function paint(i) {
    if (sel >= 0 && rows[sel]) {
      rows[sel].btn.classList.remove('sel');
      rows[sel].btn.removeAttribute('aria-current');
    }
    sel = i;
    rows[i].btn.classList.add('sel');
    rows[i].btn.setAttribute('aria-current', 'true');
    syncTab();
  }

  function select(i) {
    if (!Number.isInteger(i) || i < 0 || i >= files.length || i === sel) return sel;
    if (!match.has(i)) { filter.value = ''; applyFilter(); } // keep the selection visible
    if (!visible.has(i)) setFolded(dirOfIdx[i], false);
    paint(i);
    if (rows[i].btn.scrollIntoView) rows[i].btn.scrollIntoView({ block: 'nearest' });
    if (typeof onSelect === 'function') onSelect(i, { i: posOf.get(i) + 1, n: order.length }); // display rank, folds and filter ignored
    return sel;
  }

  // One step to the next (delta > 0) or previous (delta < 0) visible file, from displayed position
  // `from` (a fractional one sits between rows); every caller passes 1 or -1.
  function step(delta, from) {
    const dir = Math.sign(Number(delta));
    if (!dir) return sel; // zero or non-numeric: no move
    const vis = order.filter((i) => visible.has(i));
    if (!vis.length) return sel;
    const p = from ?? (sel >= 0 ? posOf.get(sel) : undefined);
    if (p === undefined) return select(vis[0]);
    const next = dir > 0
      ? vis.find((i) => posOf.get(i) > p)
      : [...vis].reverse().find((i) => posOf.get(i) < p);
    return next === undefined ? sel : select(next);
  }

  const move = (delta) => step(delta);

  // Where a key press starts: the focused file row, or just before the focused folder's first row.
  function startOf(target) {
    const row = target.closest ? target.closest('.mr-file') : null;
    if (row && posOf.has(Number(row.dataset.idx))) return posOf.get(Number(row.dataset.idx));
    const btn = target.closest ? target.closest('.dv-dir') : null;
    const d = btn && dirs.find((x) => x.btn === btn);
    return d ? posOf.get(d.idxs[0]) - 0.5 : undefined;
  }

  filter.addEventListener('input', applyFilter);
  foldAll.addEventListener('click', () => dirs.forEach((d) => setFolded(d, true)));
  unfoldAll.addEventListener('click', () => dirs.forEach((d) => setFolded(d, false)));
  root.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const typing = e.target === filter; // from the filter the arrows step from the selection and keep the focus
    let delta = 0;
    if (e.key === 'ArrowDown') delta = 1;
    else if (e.key === 'ArrowUp') delta = -1;
    else return;
    e.preventDefault();
    step(delta, typing ? undefined : startOf(e.target));
    if (!typing && sel >= 0) rows[sel].btn.focus({ preventScroll: true });
  });

  return { setFiles, setCounts, setDraftCounts, select, move, setSeen };
}
