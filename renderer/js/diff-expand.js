// Pure text layer of the diff context expansion: no DOM, no IO, no import. Input is a ONE-file unified diff text.
// Hidden lines are identical on both sides, so the new-side file text is enough to show them as context.
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
const NO_EOL = '\\ No newline at end of file';

// A hunk header counts a side as « line before » when that side has 0 lines; oldPos / newPos are normalized to the first line
// the hunk covers, or the position right after the lines it skips.
function parse(text) {
  if (typeof text !== 'string') return null;
  const lines = text.split('\n');
  const trailingNl = lines[lines.length - 1] === '';
  if (trailingNl) lines.pop();
  const head = [];
  let i = 0;
  let gitHeaders = 0;
  while (i < lines.length && !HUNK.test(lines[i])) {
    if (lines[i].startsWith('diff --git ')) gitHeaders += 1;
    head.push(lines[i]);
    i += 1;
  }
  if (gitHeaders > 1 || i >= lines.length) return null;
  const hunks = [];
  while (i < lines.length) {
    const m = HUNK.exec(lines[i]);
    if (!m) return null;
    const oldCount = m[2] === undefined ? 1 : Number(m[2]);
    const newCount = m[4] === undefined ? 1 : Number(m[4]);
    const h = {
      raw: lines[i],
      fn: m[5],
      oldPos: Number(m[1]) + (oldCount === 0 ? 1 : 0),
      newPos: Number(m[3]) + (newCount === 0 ? 1 : 0),
      oldCount,
      newCount,
      body: [],
      dirty: false,
    };
    i += 1;
    let o = oldCount;
    let n = newCount;
    while (o > 0 || n > 0) {
      const l = lines[i];
      if (l === undefined) return null;
      const c = l[0];
      if (c === ' ') { o -= 1; n -= 1; } else if (c === '-') o -= 1; else if (c === '+') n -= 1; else if (c !== '\\') return null;
      if (o < 0 || n < 0) return null;
      h.body.push(l);
      i += 1;
    }
    while (i < lines.length && lines[i][0] === '\\') { h.body.push(lines[i]); i += 1; }
    const prev = hunks[hunks.length - 1];
    if (h.newPos < (prev ? prev.newPos + prev.newCount : 1)) return null;
    hunks.push(h);
  }
  return { head, hunks, trailingNl };
}

const gapAbove = (hunks, k) => hunks[k].newPos - (k === 0 ? 1 : hunks[k - 1].newPos + hunks[k - 1].newCount);

function splitFile(text) {
  if (text === '') return { lines: [], eol: true };
  const eol = text.endsWith('\n');
  const lines = text.split('\n');
  if (eol) lines.pop();
  return { lines, eol };
}

const span = (pos, count) => (count === 1 ? String(pos) : count === 0 ? `${pos - 1},0` : `${pos},${count}`);

// Merges the neighbours whose gap reached 0 (when one of them changed), rewrites the headers of the changed hunks, then prints.
function build(p) {
  const hunks = [];
  for (const h of p.hunks) {
    const prev = hunks[hunks.length - 1];
    if (prev && h.newPos === prev.newPos + prev.newCount && (h.dirty || prev.dirty)) {
      prev.body = prev.body.concat(h.body);
      prev.newCount += h.newCount;
      prev.oldCount += h.oldCount;
      prev.dirty = true;
    } else hunks.push(h);
  }
  const out = p.head.slice();
  let delta = 0; // cumulative (+d) - (-b) of the hunks above: old number = new number - delta
  for (const h of hunks) {
    if (h.dirty) h.raw = `@@ -${span(h.newPos - delta, h.oldCount)} +${span(h.newPos, h.newCount)} @@${h.fn}`;
    delta += h.newCount - h.oldCount;
    out.push(h.raw);
    for (const l of h.body) out.push(l);
  }
  return out.join('\n') + (p.trailingNl ? '\n' : '');
}

export function gaps(diffText, lineCount) {
  const p = parse(diffText);
  if (!p) return null;
  const above = p.hunks.map((_, k) => gapAbove(p.hunks, k));
  const last = p.hunks[p.hunks.length - 1];
  const below = Number.isInteger(lineCount) && lineCount >= 0 ? Math.max(0, lineCount - (last.newPos + last.newCount - 1)) : null;
  return { above, below };
}

export function expand(diffText, fileText, opts) {
  const p = parse(diffText);
  if (!p || typeof fileText !== 'string' || !opts) return null;
  const { hunk: k, dir, n } = opts;
  const hs = p.hunks;
  if (!Number.isInteger(k) || k < 0 || k >= hs.length) return null;
  if (dir !== 'up' && dir !== 'down' && dir !== 'all') return null;
  if (dir !== 'all' && !(typeof n === 'number' && n > 0)) return null;
  const file = splitFile(fileText);
  const h = hs[k];
  const ctx = (from, to) => {
    const rows = [];
    for (let x = from; x <= to; x += 1) rows.push(' ' + file.lines[x - 1]);
    return rows;
  };
  if (dir === 'down') {
    const end = h.newPos + h.newCount; // first line below the hunk
    const room = (k + 1 < hs.length ? hs[k + 1].newPos : file.lines.length + 1) - end;
    if (room < 0) return null;
    const m = Math.min(n, room);
    if (m === 0) return diffText;
    if (end + m - 1 > file.lines.length) return null;
    const last = h.body[h.body.length - 1];
    if (last && last[0] === '\\') return null;
    h.body = h.body.concat(ctx(end, end + m - 1));
    if (end + m - 1 === file.lines.length && !file.eol) h.body.push(NO_EOL);
    h.newCount += m;
    h.oldCount += m;
  } else {
    const room = gapAbove(hs, k);
    if (h.newPos - 1 > file.lines.length) return null;
    const m = dir === 'all' ? room : Math.min(n, room);
    if (m === 0) return diffText;
    h.body = ctx(h.newPos - m, h.newPos - 1).concat(h.body);
    h.newPos -= m;
    h.newCount += m;
    h.oldCount += m;
  }
  h.dirty = true;
  return build(p);
}

export function matches(diffText, fileText) {
  const p = parse(diffText);
  if (!p || typeof fileText !== 'string') return false;
  const file = splitFile(fileText).lines;
  for (const h of p.hunks) {
    let num = h.newPos;
    for (const l of h.body) {
      if (l[0] !== ' ' && l[0] !== '+') continue;
      if (file[num - 1] !== l.slice(1)) return false;
      num += 1;
    }
  }
  return true;
}

export function newSideLines(diffText) {
  const set = new Set();
  const p = parse(diffText);
  if (!p) return set;
  for (const h of p.hunks) {
    let num = h.newPos;
    for (const l of h.body) {
      if (l[0] !== ' ' && l[0] !== '+') continue;
      set.add(num);
      num += 1;
    }
  }
  return set;
}
