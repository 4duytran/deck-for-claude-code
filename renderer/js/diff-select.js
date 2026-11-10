// claude-deck — renderer/diff-select: the lines a selection covers in a diff2html view (line-by-line or side-by-side),
// with their old / new file numbers. Pure DOM, no imports.
'use strict';

const CTN = '.d2h-code-line-ctn';

// A code row: not a hunk header, not an empty-side placeholder, not a bubble row.
function isCodeRow(tr) {
  return !tr.classList.contains('gp-ask-row') && !!tr.querySelector(CTN) && !tr.querySelector('.d2h-emptyplaceholder');
}

function numOf(el) {
  const n = el ? parseInt(el.textContent.trim(), 10) : NaN;
  return Number.isFinite(n) ? n : null;
}

function kindOf(tr) {
  const cell = tr.querySelector(CTN).closest('td');
  if (cell.classList.contains('d2h-del')) return 'del';
  if (cell.classList.contains('d2h-ins')) return 'add';
  return 'ctx';
}

// { kind, old, new } of a code row; a number is null on a side the row does not have. Side-by-side: the own number comes
// from the column (left = old, right = new), a context row takes the other one from its mate at the same row index.
function rowNumbers(tr) {
  const kind = kindOf(tr);
  const own = tr.closest('.d2h-file-side-diff');
  if (!own) return { kind, old: numOf(tr.querySelector('.line-num1')), new: numOf(tr.querySelector('.line-num2')) };
  const cols = [...own.parentElement.children].filter((c) => c.classList.contains('d2h-file-side-diff'));
  const left = cols[0] === own;
  const mine = numOf(tr.querySelector('.d2h-code-side-linenumber'));
  if (kind !== 'ctx') return { kind, old: left ? mine : null, new: left ? null : mine };
  const mate = cols[left ? 1 : 0].querySelector('tbody').rows[tr.sectionRowIndex];
  const other = mate ? numOf(mate.querySelector('.d2h-code-side-linenumber')) : null;
  return { kind, old: left ? mine : other, new: left ? other : mine };
}

// Stable key of a code row across re-renders: n<new number>, else o<old number>.
export function diffRowKey(tr) {
  const n = rowNumbers(tr);
  return n.new != null ? `n${n.new}` : `o${n.old}`;
}

// The code row(s) of a key: unified = the row; side-by-side = the row in its own column (n -> right, o -> left) then its mate.
export function diffRowsByKey(container, key) {
  const panes = [...container.querySelectorAll('.d2h-file-side-diff')];
  const rows = (root) => [...root.querySelectorAll('tbody tr')].filter(isCodeRow);
  if (panes.length !== 2) return rows(container).filter((tr) => diffRowKey(tr) === key);
  const [oldCol, newCol] = panes;
  const [own, other] = key[0] === 'n' ? [newCol, oldCol] : [oldCol, newCol];
  const hit = rows(own).find((tr) => diffRowKey(tr) === key);
  if (!hit) return [];
  const mate = other.querySelector('tbody').rows[hit.sectionRowIndex];
  return mate ? [hit, mate] : [hit];
}

// A row is touched when the range clipped to its code text is not collapsed (an end at a line start does not select that line).
function touches(range, ctn) {
  const full = document.createRange();
  full.selectNodeContents(ctn);
  const sub = range.cloneRange();
  if (sub.compareBoundaryPoints(Range.START_TO_START, full) < 0) sub.setStart(full.startContainer, full.startOffset);
  if (sub.compareBoundaryPoints(Range.END_TO_END, full) > 0) sub.setEnd(full.endContainer, full.endOffset);
  return !sub.collapsed;
}

const paneOf = (tr) => tr.closest('.d2h-file-side-diff');
const follows = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING); // b comes after a in the document

// { side, kinds, start, end, lines, lastRow } of consecutive code rows of one column. side = 'new' when any row is not a
// removal (numbers from the new file), else 'old'; null when no row carries a number on that side.
function rangeOfRows(picked) {
  const infos = picked.map((tr) => ({ ...rowNumbers(tr), text: tr.querySelector(CTN).textContent }));
  const side = infos.some((i) => i.kind !== 'del') ? 'new' : 'old';
  const nums = infos.map((i) => i[side]).filter((n) => n != null);
  if (!nums.length) return null;
  return {
    side,
    kinds: [...new Set(infos.map((i) => i.kind))],
    start: Math.min(...nums),
    end: Math.max(...nums),
    lines: infos.map((i) => i.text),
    lastRow: picked[picked.length - 1],
  };
}

// { side, kinds, start, end, lines, lastRow } of the live selection inside `container`, or null. Rows between the first and
// last touched row are included by index (blank lines); side-by-side, the column of the first touched row decides.
export function diffRangeFromSelection(container) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  const all = [...container.querySelectorAll('tbody tr')].filter(isCodeRow);
  const touched = all.filter((tr) => range.intersectsNode(tr) && touches(range, tr.querySelector(CTN)));
  if (!touched.length) return null;
  const pane = paneOf(touched[0]);
  const column = all.filter((tr) => paneOf(tr) === pane);
  const last = touched.filter((tr) => paneOf(tr) === pane).pop();
  return rangeOfRows(column.slice(column.indexOf(touched[0]), column.indexOf(last) + 1));
}

// The rows from `anchorTr` to `focusTr` (a click or a drag), clamped to the anchor's column: same shape as
// diffRangeFromSelection plus last = rowNumbers(lastRow), the old / new numbers of the bottom row ({kind, old, new}).
// A focus in the other column maps to its mate row; a focus on a non-code row (hunk header, bubble, empty placeholder)
// ends the span at the nearest code row on the anchor's side of it. Null when the anchor is not a code row.
export function diffRangeFromRows(container, anchorTr, focusTr) {
  if (!anchorTr || !focusTr) return null;
  const pane = paneOf(anchorTr);
  const column = [...container.querySelectorAll('tbody tr')].filter((tr) => isCodeRow(tr) && paneOf(tr) === pane);
  const a = column.indexOf(anchorTr);
  if (a < 0) return null;
  const own = paneOf(focusTr);
  const mate = pane && own && own !== pane && own.parentElement === pane.parentElement ? pane.querySelector('tbody').rows[focusTr.sectionRowIndex] : null;
  const ref = mate || focusTr;
  let f = column.indexOf(ref);
  if (f < 0) {
    if (follows(anchorTr, ref)) f = column.findLastIndex((tr) => follows(tr, ref));
    else f = column.findIndex((tr) => follows(ref, tr));
    if (f < 0) f = a;
  }
  const range = rangeOfRows(column.slice(Math.min(a, f), Math.max(a, f) + 1));
  return range && { ...range, last: rowNumbers(range.lastRow) };
}
