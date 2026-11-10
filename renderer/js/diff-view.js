// claude-deck — renderer/diff-view: the parts the Git diff and the MR diff share (format latch, switches, wrap, split row sync,
// word-mark pruning, file header, auto-hide scrollbar, expand-context gap rows). Pure DOM, no IO, no imports; text reaches the DOM
// through textContent only.
const SPLIT_MIN_PX = 980; // side-by-side only when the pane can hold both halves
const FORMATS = ['line-by-line', 'side-by-side'];
const SEGMENTS = [['line-by-line', 'Unifié'], ['side-by-side', 'Côte à côte']];
const PRUNE_RATIO = 0.5; // a line whose marked share of non-blank text exceeds this is a rewrite, not a word edit
const HIDE_MS = 900;
const STAT_BLOCKS = 5;

export const DIFF_OPTS = Object.freeze({ drawFileList: false, matching: 'lines' });

function make(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

const nonBlank = (s) => s.replace(/\s/g, '').length;
const count = (n) => Math.max(0, Math.trunc(Number(n)) || 0);

// The user's pick latches: until one is made the width decides, afterwards it wins at any width.
export function createFormatLatch() {
  let picked = null;
  return {
    wanted: (width) => picked || (width >= SPLIT_MIN_PX ? 'side-by-side' : 'line-by-line'),
    pick(format) {
      if (FORMATS.includes(format)) picked = format;
    },
  };
}

// `setFormat` only mirrors a format the caller decided on (no callback); a click on a button also mirrors it, then calls onFormat.
export function mountDiffSwitches(bar, { format = 'line-by-line', wrap = true, onFormat, onWrap } = {}) {
  const seg = make('div', 'dv-seg');
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', 'Affichage du diff');
  const buttons = SEGMENTS.map(([f, label]) => {
    const b = make('button', null, label);
    b.type = 'button';
    b.dataset.format = f;
    b.addEventListener('click', () => {
      setFormat(f);
      if (typeof onFormat === 'function') onFormat(f);
    });
    return b;
  });
  seg.append(...buttons);
  const toggle = make('button', 'dv-wrap-toggle', 'Retour à la ligne');
  toggle.type = 'button';
  toggle.setAttribute('role', 'switch');
  toggle.setAttribute('aria-checked', String(wrap !== false));
  toggle.addEventListener('click', () => {
    const on = toggle.getAttribute('aria-checked') !== 'true';
    toggle.setAttribute('aria-checked', String(on));
    if (typeof onWrap === 'function') onWrap(on);
  });
  // the wrap switch only means something in unified; the inline display survives a stylesheet that sets its own
  function setFormat(f) {
    for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.format === f));
    const hide = f === 'side-by-side';
    toggle.hidden = hide;
    toggle.style.display = hide ? 'none' : '';
  }
  setFormat(format);
  bar.append(seg, toggle);
  return { setFormat };
}

export function applyWrap(pane, on) {
  pane.classList.toggle('dv-wrap', !!on);
  pane.classList.toggle('dv-nowrap', !on);
}

const synced = new WeakSet(); // rows whose inline height this module wrote

// Row i of the two halves of a file gets the same height: the shorter one is stretched. Heights written by a previous call are
// dropped first, then every height is read, then every write is made (one layout for the whole pass).
export function syncSplitRows(root) {
  const byFile = new Map();
  for (const side of root.querySelectorAll('.d2h-file-side-diff')) {
    const list = byFile.get(side.parentElement);
    if (list) list.push(side);
    else byFile.set(side.parentElement, [side]);
  }
  const pairs = [];
  for (const sides of byFile.values()) {
    if (sides.length !== 2) continue;
    const [a, b] = sides.map((s) => [...s.querySelectorAll('.d2h-diff-table > tbody > tr')]);
    for (let i = 0; i < Math.min(a.length, b.length); i += 1) pairs.push([a[i], b[i]]);
  }
  for (const pair of pairs) {
    for (const tr of pair) {
      if (!synced.has(tr)) continue;
      tr.style.height = '';
      synced.delete(tr);
    }
  }
  const heights = pairs.map(([a, b]) => [a.getBoundingClientRect().height, b.getBoundingClientRect().height]);
  pairs.forEach(([a, b], i) => {
    const [ha, hb] = heights[i];
    const tall = Math.max(ha, hb);
    const short = ha < hb ? a : hb < ha ? b : null;
    if (!short || tall - Math.min(ha, hb) < 0.5) return;
    short.style.height = `${tall}px`;
    synced.add(short);
  });
}

// A line that is mostly marked is a rewrite: its marks say nothing, so they are unwrapped (the text stays).
export function pruneWordMarks(root) {
  const marked = new Map(); // code line -> non-blank characters inside its marks
  for (const m of root.querySelectorAll('.d2h-code-line-ctn ins, .d2h-code-line-ctn del')) {
    const ctn = m.closest('.d2h-code-line-ctn');
    marked.set(ctn, (marked.get(ctn) || 0) + nonBlank(m.textContent));
  }
  const rewrites = [];
  for (const [ctn, n] of marked) {
    if (n > PRUNE_RATIO * nonBlank(ctn.textContent)) rewrites.push(ctn);
  }
  for (const ctn of rewrites) {
    for (const m of ctn.querySelectorAll('ins, del')) m.replaceWith(...m.childNodes);
    ctn.normalize();
  }
}

export function statBar(add, del) {
  const total = add + del;
  let a = total ? Math.round((add / total) * STAT_BLOCKS) : 0;
  if (add > 0 && a === 0) a = 1;
  if (del > 0 && a === STAT_BLOCKS) a = STAT_BLOCKS - 1;
  const d = total ? STAT_BLOCKS - a : 0;
  const bar = make('span', 'dv-stat');
  bar.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < STAT_BLOCKS; i += 1) bar.append(make('i', i < a ? 'a' : i < a + d ? 'd' : 'n'));
  return bar;
}

// The caller hides or shows the file body from onFold(folded); the header only owns its own state.
export function fileHeader({ path, status, add, del, seen, onFold, onSeen } = {}) {
  const head = make('div', 'dv-fh');
  const chev = make('button', 'dv-fh-chev', '▾');
  chev.type = 'button';
  chev.setAttribute('aria-expanded', 'true');
  chev.setAttribute('aria-label', 'Replier le fichier');
  chev.addEventListener('click', () => {
    const expanded = chev.getAttribute('aria-expanded') !== 'true';
    chev.setAttribute('aria-expanded', String(expanded));
    chev.setAttribute('aria-label', expanded ? 'Replier le fichier' : 'Déplier le fichier');
    if (typeof onFold === 'function') onFold(!expanded);
  });
  head.append(chev);
  if (status) {
    const pill = make('span', 'dv-pill', String(status));
    pill.dataset.st = String(status);
    head.append(pill);
  }
  const a = count(add);
  const d = count(del);
  head.append(make('span', 'dv-fh-path', path == null ? '' : String(path)), make('span', 'dv-fh-add', `+${a}`), make('span', 'dv-fh-del', `−${d}`), statBar(a, d));
  if (typeof onSeen === 'function') {
    const btn = make('button', 'dv-seen', 'Vu');
    btn.type = 'button';
    btn.setAttribute('aria-pressed', String(!!seen));
    btn.addEventListener('click', () => {
      const on = btn.getAttribute('aria-pressed') !== 'true';
      btn.setAttribute('aria-pressed', String(on));
      onSeen(on);
    });
    head.append(btn);
  }
  return head;
}

// The scrollbar shows while the element scrolls and for HIDE_MS after the last scroll (the stylesheet keys off .is-scrolling).
export function autoHideScrollbar(el) {
  if (el.classList.contains('dv-scroll')) return;
  el.classList.add('dv-scroll');
  let timer = 0;
  el.addEventListener('scroll', () => {
    if (!el.classList.contains('is-scrolling')) el.classList.add('is-scrolling');
    clearTimeout(timer);
    timer = setTimeout(() => el.classList.remove('is-scrolling'), HIDE_MS);
  }, { passive: true });
}

const GAP_STEP = 20;
const GAP_UP = `↑ ${GAP_STEP} lignes`;
const GAP_DOWN = `↓ ${GAP_STEP} lignes`;
const GAP_ALL = 'Tout afficher';

function gapButton(label, pick, onPick) {
  const b = make('button', 'dx-gap-btn', label);
  b.type = 'button';
  b.addEventListener('click', (e) => {
    e.stopPropagation(); // the git panel folds a hunk on a click anywhere in its header row
    if (typeof onPick === 'function') onPick({ ...pick });
  });
  return b;
}

function gapStrip(buttons) {
  const strip = make('div', 'dx-gap');
  strip.append(...buttons);
  return strip;
}

// Expand controls of one file. `above[k]` = hidden lines above hunk k, `below` = hidden lines after the last hunk (null = unknown).
// They live in the existing hunk header rows of the FIRST table; the closing row goes into EVERY tbody so split rows stay index-aligned.
// onPick({hunk, dir, n}): up/down grow a hunk by n lines, `all` fills the gap above `hunk` (n = its size); the tail's all is down + Infinity.
export function mountGapRows(root, { above, below } = {}, onPick) {
  for (const el of root.querySelectorAll('.dx-gap, .dx-gap-tail')) el.remove();
  const tables = [...root.querySelectorAll('.d2h-diff-table')];
  if (!tables.length) return;
  const gaps = Array.isArray(above) ? above.map(count) : [];
  const heads = [...tables[0].querySelectorAll(':scope > tbody > tr')].filter((tr) => tr.querySelector('.d2h-info'));
  heads.forEach((tr, k) => {
    const n = gaps[k] || 0;
    if (!n) return;
    const buttons = [];
    if (n > GAP_STEP) {
      buttons.push(gapButton(GAP_UP, { hunk: k, dir: 'up', n: GAP_STEP }, onPick));
      if (k > 0) buttons.push(gapButton(GAP_DOWN, { hunk: k - 1, dir: 'down', n: GAP_STEP }, onPick));
    }
    buttons.push(gapButton(GAP_ALL, { hunk: k, dir: 'all', n }, onPick));
    const cell = tr.lastElementChild;
    (cell.querySelector(':scope > div') || cell).append(gapStrip(buttons)); // inside the header line: one row, the text keeps its place
  });
  const tail = count(below);
  if (!tail || !heads.length) return;
  const last = heads.length - 1;
  root.querySelectorAll('.d2h-diff-table > tbody').forEach((tbody, i) => {
    const row = make('tr', 'dx-gap-tail');
    const cell = make('td');
    cell.colSpan = 2;
    if (i === 0) {
      const buttons = [];
      if (tail > GAP_STEP) buttons.push(gapButton(GAP_DOWN, { hunk: last, dir: 'down', n: GAP_STEP }, onPick));
      buttons.push(gapButton(GAP_ALL, { hunk: last, dir: 'down', n: Infinity }, onPick));
      cell.append(gapStrip(buttons));
    }
    row.append(cell);
    tbody.append(row);
  });
}

// One status line above the diff (a refused or failed expansion). A new text replaces the line, an empty one removes it.
export function gapNotice(root, text) {
  for (const el of root.querySelectorAll('.dx-gap-notice')) el.remove();
  const s = text == null ? '' : String(text);
  if (!s) return null;
  const note = make('div', 'dx-gap-notice', s);
  note.setAttribute('role', 'status');
  const first = root.querySelector('.d2h-wrapper');
  if (first) first.before(note);
  else root.prepend(note);
  return note;
}
