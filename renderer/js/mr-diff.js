// claude-deck — renderer/mr-diff: the diff column of the MR view. A bar (the shared format and wrap switches at the left, prev /
// « i / n » / next at the right) over a Diff2Html pane that opens with the shared sticky file header. A press on a code row selects
// it, a drag or Shift+press extends the range, and the ask / comment box opens under the last row at once (no « + » button). Rows
// under a line (box, threads, drafts) go through insertRow / removeRow: in the unified view they hang in the table; in the split
// view each one is shown as ONE block over both halves (`div.mr-wide`) with an equal `tr.mr-wide-spacer` in each half (D16).
// A file the caller can expand gets gap controls between and after its hunks; the expanded context rows (`dx-ctx`) take no box.
// No IO: the caller's callbacks do the work.
import { createBox } from './mr-box.js';
import { diffRangeFromRows, diffRowKey, diffRowsByKey } from './diff-select.js';
import { DIFF_OPTS, createFormatLatch, mountDiffSwitches, applyWrap, syncSplitRows, pruneWordMarks, fileHeader, autoHideScrollbar, mountGapRows, gapNotice } from './diff-view.js';
import { gaps, newSideLines } from './diff-expand.js';
import { collapse, expand } from './motion.js';

const EXTRA = 'tr.mr-thread-row, tr.mr-draft-row, tr.mr-ask-row, tr.mr-box-row, tr.mr-spacer, tr.mr-wide-spacer, tr.gp-ask-row';
const NO_PICK = `${EXTRA}, .mr-wide, .mr-box, .ca-slot, a, button, input, textarea`;
const STATUSES = new Set(['M', 'A', 'D', 'R']);

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

const isCode = (tr) => !tr.matches(EXTRA) && !!tr.querySelector('.d2h-code-line-ctn') && !tr.querySelector('.d2h-emptyplaceholder');

// The last of the rows that hang under `row` (threads, drafts, boxes, spacers of the other column).
function trailing(row) {
  let r = row;
  while (r.nextElementSibling && r.nextElementSibling.matches(EXTRA)) r = r.nextElementSibling;
  return r;
}

const pathOf = (file) => String((file && (file.newPath || file.oldPath)) || '');

// Changed lines of a unified diff: those after the first hunk header (the file header lines are not counted).
function countChanges(text) {
  const at = text.search(/^@@ /m);
  let add = 0;
  let del = 0;
  if (at >= 0) {
    for (const l of text.slice(at).split('\n')) {
      if (l[0] === '+') add += 1;
      else if (l[0] === '-') del += 1;
    }
  }
  return { add, del };
}

// onAsk / onComment(range, text) -> { ok, notice } | Promise of it (range: diffRangeFromRows); decorate(pane, file) runs after
// every render; onSeen(path, on) reports the « Vu » button of the file header (path = the file's newPath, as mr-tree keys it).
// show(file, diffText, label, pos): diffText is a unified diff Diff2Html can parse (with its file header lines); pos = { i, n }
// (1-based rank of the file in the tree, file count) fills the « i / n » counter, which stays empty and hidden without it.
// setSeen(path, on) mirrors a mark made elsewhere, silently; marks are forgotten by show(null, ...) (another MR).
// expandable(file) -> bool turns the gap controls on for that file; a pick calls onExpand(file, {hunk, dir, n}, text) -> { text } | { notice }
// (or a promise of it): text = the diff with the context added, drawn in place of the shown one with the scroll position kept, notice = a
// refusal shown above the diff. setFileLines(n) hands over the file's line count (the control under the last hunk needs it);
// show() forgets both the expansion and the count.
export function mountMrDiff(host, { onPrev, onNext, onAsk, onComment, decorate, onSeen, expandable, onExpand } = {}) {
  const bar = el('div', 'mr-diff-bar');
  // The file header of the pane shows the path; this label stays only as a visually hidden node (title, tests, screen readers).
  const path = el('span', 'mr-diff-path');
  path.setAttribute('aria-hidden', 'true');
  path.style.cssText = 'position:absolute;width:1px;height:1px;margin:-1px;padding:0;border:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap';
  const nav = (cls, glyph, label, fn) => {
    const b = el('button', cls, glyph);
    b.type = 'button';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.addEventListener('click', () => { if (typeof fn === 'function') fn(); });
    return b;
  };
  const prev = nav('mr-prev mr-diff-prev', '‹', 'Fichier précédent', onPrev);
  const next = nav('mr-next mr-diff-next', '›', 'Fichier suivant', onNext);
  const posEl = el('span', 'mr-diff-pos');
  prev.style.marginLeft = 'auto'; // the counter and the arrows sit at the right edge, the switches at the left
  function setPos(p) {
    const ok = !!p && Number.isInteger(p.i) && Number.isInteger(p.n) && p.i >= 1 && p.i <= p.n;
    posEl.textContent = ok ? `${p.i} / ${p.n}` : '';
    posEl.hidden = !ok;
    posEl.style.display = ok ? '' : 'none'; // survives a stylesheet that sets its own display
  }
  setPos(null);
  const pane = el('div', 'mr-diff');
  const latch = createFormatLatch(); // the width decides until the user picks a format, then the pick wins
  const switches = mountDiffSwitches(bar, {
    format: 'line-by-line',
    wrap: true,
    onFormat(f) {
      latch.pick(f);
      if (shown && f !== format) draw(true);
      else switches.setFormat(format);
    },
    onWrap: (on) => applyWrap(pane, on),
  });
  bar.append(path, prev, posEl, next); // after the switches, which mountDiffSwitches appended
  applyWrap(pane, true);
  autoHideScrollbar(pane);
  host.append(bar, pane);

  let shown = null; // { file, text, base, lines, label, add, del }: text = base (what show() got) plus expanded context, lines = file length
  let pendingTop = null; // scrollTop to give back once the last chunk of an expansion has landed
  let format = 'line-by-line';
  const seenPaths = new Map(); // path -> « Vu » state, for the header of a file shown later
  let pick = null; // { anchor, range }: the live selection
  let drag = null; // { anchor, focus }: a press still down
  let boxState = null; // { box, tr, range, under, hold }: hold = { first, last, focus } while a re-render has the box row out
  let painted = [];
  const links = new Map(); // inserted row -> { layer, sps, box, h } (split view only): the wide layer, its two spacers, its container

  // ---- rows under a line ------------------------------------------------------------------------------------------------
  // Split view (K8): the row lives in a `div.mr-wide` layer laid over the split container (`box`), at the top of its spacer in the
  // hit's half (sps[0]); each half holds an equal `tr.mr-wide-spacer` so the code rows below stay paired. The layer's height drives
  // both spacers; its top follows the spacer, which moves whenever a row above changes height.
  const setHeights = (l, h) => {
    if (l.h !== undefined && Math.abs(l.h - h) < 0.01) return;
    l.h = h;
    for (const sp of l.sps) sp.style.height = `${h}px`;
  };
  const topOf = (l) => l.sps[0].getBoundingClientRect().top - l.box.getBoundingClientRect().top - l.box.clientTop;

  // One block, one layout: both measures first, then the writes. Used right after an insertion (the block must sit right at once).
  function placeOne(l) {
    const h = l.layer.getBoundingClientRect().height;
    const top = topOf(l);
    setHeights(l, h);
    l.layer.style.top = `${top}px`;
  }

  // Every block: heights first (they move the rows below), then the tops.
  function layoutWides() {
    const all = [...links.values()].filter((l) => l.layer.isConnected);
    if (!all.length) return;
    const hs = all.map((l) => l.layer.getBoundingClientRect().height);
    all.forEach((l, i) => setHeights(l, hs[i]));
    const tops = all.map(topOf);
    all.forEach((l, i) => { l.layer.style.top = `${tops[i]}px`; });
  }

  let layoutQueued = false;
  function scheduleLayout() { // one pass for a burst of insertions / removals
    if (layoutQueued) return;
    layoutQueued = true;
    queueMicrotask(() => { layoutQueued = false; layoutWides(); });
  }
  // Only the layers are observed: a fold or a wrap inside a block moves what is below it. A change above the blocks (a re-wrap
  // after a resize) is followed through syncSplit, called by the width observer below.
  const blockRo = new ResizeObserver(layoutWides);
  const syncSplit = () => { syncSplitRows(pane); layoutWides(); };

  function removeRow(tr) {
    const l = links.get(tr);
    if (l) {
      blockRo.unobserve(l.layer);
      l.layer.remove();
      for (const sp of l.sps) sp.remove();
      links.delete(tr);
      if (links.size) scheduleLayout();
    }
    tr.remove();
  }

  // The spacer in the hit's half stands in for the row itself; the one in the other half stays the old empty twin (`mr-spacer`
  // plus the row's classes, minus its enter animation, which would shift the rect the layer is placed from).
  const spacerOf = (cls) => {
    const sp = el('tr', cls.join(' '));
    const td = sp.appendChild(el('td'));
    td.colSpan = 2;
    td.style.cssText = 'padding:0;border:0';
    return sp;
  };

  function wideRow(hit, mate, tr) {
    const box = hit.closest('.d2h-file-side-diff').parentElement;
    if (getComputedStyle(box).position === 'static') box.style.position = 'relative';
    const sps = [spacerOf(['mr-wide-spacer']), spacerOf([...[...tr.classList].filter((c) => c !== 'mr-enter'), 'mr-wide-spacer', 'mr-spacer'])];
    trailing(hit).after(sps[0]);
    trailing(mate).after(sps[1]);
    const layer = el('div', 'mr-wide');
    layer.style.cssText = 'position:absolute;left:0;right:0;top:0';
    const table = el('table'); // a row needs a table around it; the wide layer is not a Diff2Html table
    table.style.cssText = 'width:100%;table-layout:fixed;border-collapse:collapse;border-spacing:0';
    table.appendChild(el('tbody')).append(tr);
    layer.append(table);
    box.append(layer);
    const l = { layer, sps, box };
    links.set(tr, l);
    blockRo.observe(layer);
    placeOne(l);
    if (links.size > 1) scheduleLayout(); // the blocks below this one moved down
  }

  // `tr` goes after the trailing rows of the row `key` names, in that row's column. Split view: it is shown over both halves and
  // each half gets an empty twin of the block's height, so both columns keep their sectionRowIndex aligned. false = no such row.
  function insertRow(key, tr) {
    if (tr.isConnected || links.has(tr)) removeRow(tr);
    const [hit, mate] = diffRowsByKey(pane, key);
    if (!hit) return false;
    if (mate) wideRow(hit, mate, tr);
    else trailing(hit).after(tr);
    return true;
  }

  // ---- selection --------------------------------------------------------------------------------------------------------
  // The code rows a range covers, bottom row first.
  function rangeRows(range) {
    const rows = [range.lastRow];
    for (let r = range.lastRow.previousElementSibling; r && rows.length < range.lines.length; r = r.previousElementSibling) {
      if (isCode(r)) rows.push(r);
    }
    return rows;
  }

  function paint(range) {
    for (const r of painted) r.classList.remove('mr-sel', 'mr-sel-first', 'mr-sel-last');
    painted = [];
    if (!range) return;
    const rows = rangeRows(range);
    for (const r of rows) r.classList.add('mr-sel');
    rows[0].classList.add('mr-sel-last');
    rows[rows.length - 1].classList.add('mr-sel-first');
    painted = rows;
  }

  function clearPick() {
    pick = null;
    paint(null);
  }

  // The box leaves: the highlight clears at once, its row once the pop-out has run.
  function endBox(st) {
    if (boxState === st) {
      boxState = null;
      clearPick();
    }
    return st.box.close().then(() => removeRow(st.tr));
  }

  async function submit(st, mode, text) {
    const cb = mode === 'comment' ? onComment : onAsk;
    if (typeof cb !== 'function') return { ok: false, notice: 'Action indisponible' };
    const res = await cb(st.range, text);
    if (res && res.ok) endBox(st); // closes before the box's own close, so the row follows the exit animation
    return res;
  }

  function openBox(range) {
    const st = boxState;
    const key = diffRowKey(range.lastRow);
    if (st && st.tr.isConnected && st.under === range.lastRow) {
      st.range = range;
      st.box.focus();
      return;
    }
    if (st) { // a new pick moves the same box, its text kept
      st.range = range;
      if (!insertRow(key, st.tr)) { endBox(st); return; }
      st.under = range.lastRow;
      st.hold = null;
      st.box.focus();
      return;
    }
    const tr = el('tr', 'mr-box-row');
    const fresh = { range, under: range.lastRow, tr, box: null };
    fresh.box = createBox({
      popup: true,
      mode: 'ask',
      onSubmit: (mode, text) => submit(fresh, mode, text),
      onCancel: () => { endBox(fresh); },
    });
    tr.appendChild(el('td')).colSpan = 2;
    tr.firstChild.append(fresh.box.el);
    if (!insertRow(key, tr)) {
      clearPick();
      return;
    }
    boxState = fresh;
  }

  // A same-file re-render keeps the open box (U5: only Esc / « Annuler » close it). The range goes down to row keys before the
  // rows are replaced; the box row, with its text and mode, waits detached until the render ends and is put back by restoreBox.
  function holdBox() {
    const st = boxState;
    if (st && !st.hold) {
      const rows = rangeRows(st.range);
      st.hold = { first: diffRowKey(rows[rows.length - 1]), last: diffRowKey(st.range.lastRow), focus: st.tr.contains(document.activeElement) };
    }
    return st;
  }

  // Runs once, after the last chunk and decorate: the range is rebuilt from the keys in the new rows, the box goes back under its
  // last row (after the thread / draft rows, as when it was opened) with the highlight. A row that is gone takes the box with it.
  // The range is rebuilt in the LAST row's column (R7 anchors a comment on that row): the first row's mate in that column may
  // sit below it after a format switch, then the range ends at the last row and its start shrinks to it.
  function restoreBox() {
    const st = boxState;
    if (!st || !st.hold) return;
    const { first, last, focus } = st.hold;
    const end = diffRowsByKey(pane, last)[0];
    const top = diffRowsByKey(pane, first)[0];
    let range = end && top ? diffRangeFromRows(pane, end, top) : null;
    if (range && diffRowKey(range.lastRow) !== last) range = diffRangeFromRows(pane, end, end);
    if (!range || diffRowKey(range.lastRow) !== last || !insertRow(last, st.tr)) {
      boxState = null;
      return;
    }
    const rows = rangeRows(range);
    st.hold = null;
    st.range = range;
    st.under = range.lastRow;
    pick = { anchor: rows[rows.length - 1], range };
    paint(range);
    if (focus) st.box.focus();
  }

  // A pointer over a wide block counts as over its spacer: the layer sits at the end of the split container in document order.
  function rowUnder(target) {
    if (!target || !target.closest) return null;
    const wide = target.closest('.mr-wide');
    if (wide) {
      for (const l of links.values()) if (l.layer === wide) return l.sps[0];
    }
    return target.closest('tr');
  }

  function onMove(e) {
    const tr = rowUnder(e.target);
    if (!drag || !tr || tr === drag.focus || !pane.contains(tr)) return;
    drag.focus = tr;
    const range = diffRangeFromRows(pane, drag.anchor, tr);
    if (!range) return;
    pick.range = range;
    paint(range);
  }

  function endDrag() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    drag = null;
  }

  // A range over expanded context opens no box: the highlight goes back to the open box's range, or clears.
  function resumePick() {
    const st = boxState;
    if (!st || !st.tr.isConnected || !st.under.isConnected) { clearPick(); return; }
    const rows = rangeRows(st.range);
    pick = { anchor: rows[rows.length - 1], range: st.range };
    paint(st.range);
  }

  function onUp() {
    const done = drag;
    endDrag();
    if (!done || !pick) return;
    if (rangeRows(pick.range).some((r) => r.classList.contains('dx-ctx'))) resumePick();
    else openBox(pick.range);
  }

  function onDown(e) {
    if (e.button !== 0 || !e.target.closest || e.target.closest(NO_PICK)) return;
    const tr = e.target.closest('tr');
    if (!tr || !pane.contains(tr) || tr.classList.contains('dx-ctx')) return;
    const anchor = e.shiftKey && pick && pick.anchor.isConnected ? pick.anchor : tr;
    const range = diffRangeFromRows(pane, anchor, tr);
    if (!range) return;
    e.preventDefault(); // no native text selection under the drag
    endDrag();
    pick = { anchor, range };
    drag = { anchor, focus: tr };
    paint(range);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }
  pane.addEventListener('mousedown', onDown);

  // ---- render -----------------------------------------------------------------------------------------------------------
  // The diff is cut at hunk boundaries into chunks of about CHUNK_BYTES (header lines repeated, so each parses alone). Chunk 0
  // is drawn at once; the others are built detached and their rows moved into the live tables, one per task with a frame
  // between (D13: a 60 KB file drawn in one task blocks 75-140 ms, mostly table layout). `seq` drops the chunks of an older
  // render; `data-rendering` is set on the pane until the last chunk landed, and decorate runs once, after it.
  const CHUNK_BYTES = 8000; // 15 KB chunks still hit 50-55 ms frames on a 1640-row split table (measured)
  const d2hOpts = (f) => ({ ...DIFF_OPTS, outputFormat: f });
  const diffBodies = (root) => [...root.querySelectorAll('table.d2h-diff-table')].map((t) => t.tBodies[0]);
  const nextTurn = () => new Promise((resolve) => { // after a frame so each chunk paints; the timer covers a hidden window
    const t = setTimeout(resolve, 60);
    requestAnimationFrame(() => { clearTimeout(t); setTimeout(resolve, 0); });
  });
  let seq = 0;

  function chunksOf(text) {
    const at = text.search(/^@@ /m);
    if (at <= 0 || text.length <= CHUNK_BYTES) return [text];
    const head = text.slice(0, at);
    const out = [];
    let cur = '';
    for (const hunk of text.slice(at).split(/(?=^@@ )/m)) {
      cur += hunk;
      if (cur.length >= CHUNK_BYTES) {
        out.push(head + cur);
        cur = '';
      }
    }
    if (cur) out.push(head + cur);
    return out;
  }

  // The file header sits above the Diff2Html wrapper in the pane (the scroller), so it sticks for the whole file; a fold hides the
  // wrapper (motion.js, inline end state) and an unfold re-syncs the split rows, which a hidden table could not measure.
  function buildHeader() {
    const { file, label, add, del } = shown;
    const key = pathOf(file);
    const head = fileHeader({
      path: label,
      status: STATUSES.has(file && file.status) ? file.status : 'M',
      add,
      del,
      seen: seenPaths.get(key) === true,
      onFold(folded) {
        const body = head.nextElementSibling;
        if (!body) return;
        if (folded) collapse(body);
        else { expand(body); syncSplit(); }
      },
      onSeen: typeof onSeen === 'function' ? (on) => { seenPaths.set(key, on); onSeen(key, on); } : undefined,
    });
    return head;
  }

  // Gap controls for an expandable file. Re-run by setFileLines, which mountGapRows tolerates (it removes the old ones first).
  function mountGaps() {
    if (typeof expandable !== 'function' || !shown.text.trim() || !expandable(shown.file)) return;
    const g = gaps(shown.text, shown.lines);
    if (g) mountGapRows(pane, g, pickGap);
  }

  // A row whose new-side number is not in the text show() was given is expanded context: no ask, no comment on it.
  function markSpliced() {
    if (shown.text === shown.base) return;
    const known = newSideLines(shown.base);
    for (const tr of pane.querySelectorAll('.d2h-diff-table > tbody > tr')) {
      if (!isCode(tr)) continue;
      const key = diffRowKey(tr);
      if (key[0] === 'n' && !known.has(Number(key.slice(1)))) tr.classList.add('dx-ctx');
    }
  }

  async function pickGap(req) {
    const cur = shown;
    if (typeof onExpand !== 'function' || !cur) return;
    const sent = cur.text;
    let res = null;
    try {
      res = await onExpand(cur.file, req, sent);
    } catch (e) {
      console.error('[mr-diff] expand failed', e);
      res = { notice: 'Impossible d’afficher plus de contexte' };
    }
    if (shown !== cur || cur.text !== sent || !res) return; // another file, or an older expansion landed meanwhile
    if (typeof res.text === 'string' && res.text && res.text !== sent) {
      cur.text = res.text;
      pendingTop = pane.scrollTop;
      draw(true);
    } else if (res.notice) {
      gapNotice(pane, res.notice);
    }
  }

  function finishRender() {
    delete pane.dataset.rendering;
    pruneWordMarks(pane);
    mountGaps();
    markSpliced();
    syncSplit();
    if (typeof decorate === 'function') decorate(pane, shown.file);
    restoreBox();
    if (pendingTop != null) { // after the box (its focus may scroll) and the last chunk: the rows above are all there again
      pane.scrollTop = pendingTop;
      pendingTop = null;
    }
  }

  async function drawRest(mine, parts, fmt) {
    try {
      for (let i = 1; i < parts.length; i++) {
        await nextTurn();
        if (mine !== seq) return;
        const tmp = document.createElement('div');
        tmp.innerHTML = Diff2Html.html(parts[i], d2hOpts(fmt));
        const dst = diffBodies(pane);
        diffBodies(tmp).forEach((body, k) => { if (dst[k]) dst[k].append(...body.children); });
      }
    } catch (e) {
      console.error('[mr-diff] chunk render failed', e);
      if (mine === seq) {
        delete pane.dataset.rendering;
        pendingTop = null;
        pane.append(el('div', 'mr-diff-note', 'Affichage du diff interrompu'));
      }
      return;
    }
    if (mine === seq) finishRender();
  }

  // keepBox: a re-render of the same file (format pick, width threshold); a show() of another file drops the box.
  function draw(keepBox) {
    seq += 1;
    delete pane.dataset.rendering;
    endDrag();
    boxState = keepBox ? holdBox() : null;
    clearPick();
    blockRo.disconnect();
    links.clear();
    format = latch.wanted(pane.clientWidth);
    switches.setFormat(format);
    if (!shown || !shown.text.trim()) {
      boxState = null;
      pane.replaceChildren(el('div', 'mr-diff-note', 'Aucune différence à afficher'));
      if (shown) finishRender(); // decorate runs after every render, this one included
      return;
    }
    const parts = chunksOf(shown.text);
    pane.innerHTML = Diff2Html.html(parts[0], d2hOpts(format));
    pane.prepend(buildHeader());
    if (parts.length === 1) {
      finishRender();
      return;
    }
    pane.dataset.rendering = 'chunks';
    drawRest(seq, parts, format);
  }

  // A fresh `.mr-swap` fade (opacity only, in the CSS) for every file switch; the style flush restarts a running one.
  function swap() {
    pane.classList.remove('mr-swap');
    void getComputedStyle(pane).animationName;
    pane.classList.add('mr-swap');
  }
  pane.addEventListener('animationend', (e) => {
    if (e.target === pane && e.animationName === 'mr-swap') pane.classList.remove('mr-swap');
  });

  function show(file, diffText, label, pos) {
    const text = typeof diffText === 'string' ? diffText : '';
    if (!file) seenPaths.clear();
    shown = { file, text, base: text, lines: null, label: label || '', ...countChanges(text) };
    pendingTop = null;
    path.textContent = label || '';
    path.title = label || '';
    setPos(pos);
    swap();
    draw();
    pane.scrollTop = 0;
  }

  function setFileLines(n) {
    if (!shown) return;
    shown.lines = Number.isInteger(n) && n >= 0 ? n : null;
    if (pane.dataset.rendering) return; // finishRender mounts the controls with the count
    mountGaps();
    syncSplit();
  }

  function setSeen(p, on) {
    const key = String(p);
    seenPaths.set(key, !!on);
    const btn = pane.querySelector('.dv-fh .dv-seen');
    if (btn && shown && pathOf(shown.file) === key) btn.setAttribute('aria-pressed', String(!!on));
  }

  // Width: re-render when the latch now wants another format (a pick makes it never do), else re-align the split rows.
  let roTimer = 0;
  new ResizeObserver(() => {
    if (!shown) return;
    clearTimeout(roTimer);
    roTimer = setTimeout(() => {
      if (!shown) return;
      if (latch.wanted(pane.clientWidth) !== format) draw(true);
      else if (format === 'side-by-side' && !pane.dataset.rendering && pane.querySelector('.d2h-wrapper')?.getClientRects().length) syncSplit();
    }, 150);
  }).observe(pane);

  return { show, insertRow, removeRow, pane, setSeen, setFileLines };
}
