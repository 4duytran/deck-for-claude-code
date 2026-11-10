// claude-deck — renderer/files-panel (P1-10): the « Fichiers » tab of the docked
// side panel. A search field, a lazy tree of the session's folder and a file
// viewer. No IO here: every listing / read / search is a main-process IPC
// payload (filesList / filesRead / filesSearch). File names and contents reach
// the DOM through textContent only; the one exception is Markdown, rendered by a
// local markdown-it instance with html:false (same rule as plans-panel's ppMd).
// Imports side-panel.js only (no cycle); chat file links (P1-16) call
// openFileInPanel().
'use strict';

import { registerSideTab, showSideTab, openSidePanel, closeSidePanel, ownPopupOpen } from './side-panel.js';
import { openAsk, closeAsk, composeCodeMessage, placeBubbles, fileScope } from './code-ask.js';
import { pageHasScript, mountClosedFrame } from './page-frame.js';
import { frameAskSelect, frameAskPointerDown, frameAskReset } from './frame-ask.js';
import { progressBar, inlineBar } from './loading.js';
import { spinWhile, revealFrame } from './motion.js';

const SEARCH_DEBOUNCE_MS = 150;
const EXPAND_LEVEL_MAX = 40; // folders loaded by one « Tout déplier »
const SVG_NS = 'http://www.w3.org/2000/svg';
const MD_RE = /\.(md|markdown)$/i;
const HTML_RE = /\.html?$/i;
const ROOTED_RE = /^(?:\/|~\/|\.\.\/)/;
const linkCollator = new Intl.Collator('en', { numeric: true });

// One shared renderer instance. html:false escapes raw HTML, markdown-it's own
// validateLink kills javascript: / data: hrefs, and links are made inert below.
const fpMd = (typeof markdownit !== 'undefined')
  ? markdownit({ html: false, linkify: true }) : null;

// open: the tab is the active one. target: { paneId, sessionId }. mode: 'tree' |
// 'results' | 'viewer'. view: { rel, line } while a file is shown. The tree model
// (root) survives a tab switch for the same session and is refreshed on return.
export const filesState = {
  open: false,
  target: null,
  mode: 'tree',
  query: '',
  view: null,
  cur: '', // rel of the tree row holding the roving tabindex
  root: null,
  forTarget: null, // the target the model above belongs to
};
let searchSeq = 0;
let searchTimer = 0;
let treeScroll = 0;
let resultsScroll = 0;
// { list, truncated } | { err } | null (search pending). From a chat file link that matched
// several files: + { link, line, query } (the link text, its line, the query it shows under).
let results = null;
const rowNode = new WeakMap(); // tree row element -> model node
const rowResult = new WeakMap(); // result row element -> { rel, dir }

const $ = (id) => document.getElementById(id);

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function icon(name, size = 14) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#lc-${name}`);
  svg.appendChild(use);
  return svg;
}

function sameTarget(a, b) {
  if (!a || !b) return false;
  if (a.paneId && b.paneId) return a.paneId === b.paneId;
  return !!a.sessionId && a.sessionId === b.sessionId;
}

function mkNode(name, rel, dir) {
  return { name, rel, dir, open: false, loaded: false, pending: null, err: null, truncated: false, kids: [] };
}

function fmtSize(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} Ko`;
  return `${(n / (1024 * 1024)).toFixed(1)} Mo`;
}

function applyMode() {
  const mode = filesState.view ? 'viewer' : (filesState.query ? 'results' : 'tree');
  filesState.mode = mode;
  $('fp-head').hidden = mode === 'viewer';
  $('fp-tree').hidden = mode !== 'tree';
  $('fp-results').hidden = mode !== 'results';
  $('fp-viewer').hidden = mode !== 'viewer';
}

// ---------------------------------------------------------------------------
// Tree
// ---------------------------------------------------------------------------

// Loads (or, with force, reloads) the entries of a folder node. One request per
// node at a time; an answer for a model that was replaced meanwhile is dropped.
function loadDir(node, force) {
  if (node.pending) return node.pending;
  if (node.loaded && !force) return Promise.resolve();
  const root = filesState.root;
  const target = filesState.target;
  if (!root || !target) return Promise.resolve();
  const p = (async () => {
    node.err = null;
    if (!node.loaded) renderTree();
    const res = await window.api.filesList(target, node.rel).catch(() => null);
    node.pending = null;
    if (filesState.root !== root) return;
    if (!res || !res.ok) {
      node.err = (res && res.reason) || 'lecture impossible';
    } else {
      const old = new Map(node.kids.map((k) => [k.name, k]));
      node.kids = res.entries.map((e) => {
        const prev = old.get(e.name);
        return prev && prev.dir === e.dir
          ? prev : mkNode(e.name, node.rel ? `${node.rel}/${e.name}` : e.name, e.dir);
      });
      node.loaded = true;
      node.truncated = !!res.truncated;
    }
    renderTree();
  })();
  node.pending = p;
  return p;
}

function treeRow(node, depth) {
  const row = el('div', 'fp-row');
  row.setAttribute('role', 'treeitem');
  row.setAttribute('aria-level', String(depth + 1));
  row.style.paddingLeft = `${8 + depth * 14}px`;
  row.title = node.rel;
  row.tabIndex = node.rel === filesState.cur ? 0 : -1;
  const chev = el('span', 'fp-chev');
  if (node.dir) {
    row.classList.add('fp-dir');
    row.setAttribute('aria-expanded', String(node.open));
    chev.appendChild(icon(node.open ? 'chevron-down' : 'chevron-right', 12));
  }
  row.append(chev, icon(node.dir ? (node.open ? 'folder-open' : 'folder') : 'file'), el('span', 'fp-name', node.name));
  rowNode.set(row, node);
  return row;
}

// loading: a wait note, the bar is an empty child so the text stays exact.
function note(text, depth, cls, { loading = false } = {}) {
  const n = el('div', cls ? `fp-note ${cls}` : 'fp-note', text);
  if (loading) n.append(inlineBar());
  n.style.paddingLeft = `${8 + depth * 14 + 18}px`;
  return n;
}

function anyOpen(node) {
  return node.kids.some((k) => k.dir && (k.open || anyOpen(k)));
}

function renderTree() {
  const tree = $('fp-tree');
  const hadFocus = tree.contains(document.activeElement);
  const scroll = tree.scrollTop;
  const out = [];
  const fill = (node, depth) => {
    if (!node.loaded) {
      if (node.err) out.push(note(`⚠ ${node.err}`, depth, 'fp-err'));
      else out.push(note('Chargement…', depth, '', { loading: true }));
      return;
    }
    for (const k of node.kids) {
      out.push(treeRow(k, depth));
      if (k.dir && k.open) fill(k, depth + 1);
    }
    if (node.truncated) out.push(note(`Liste tronquée (${node.kids.length} premiers éléments)`, depth));
    else if (!node.kids.length) out.push(note('Dossier vide', depth));
    if (node.err) out.push(note(`⚠ ${node.err}`, depth, 'fp-err'));
  };
  if (!filesState.target) out.push(note('Aucune session sélectionnée', 0));
  else if (filesState.root) fill(filesState.root, 0);
  tree.replaceChildren(...out);
  const rows = out.filter((n) => n.classList.contains('fp-row'));
  if (rows.length && !rows.some((r) => r.tabIndex === 0)) rows[0].tabIndex = 0;
  tree.scrollTop = scroll;
  if (hadFocus && filesState.open) {
    const cur = rows.find((r) => r.tabIndex === 0);
    if (cur) cur.focus({ preventScroll: true });
  }
  const all = $('fp-all');
  const collapse = !!filesState.root && anyOpen(filesState.root);
  all.title = collapse ? 'Tout replier' : 'Tout déplier';
  all.setAttribute('aria-label', all.title);
  all.replaceChildren(icon(collapse ? 'chevron-up' : 'chevron-down'));
}

function toggleNode(node) {
  node.open = !node.open;
  if (node.open && !node.loaded) loadDir(node);
  renderTree();
}

function toggleAll() {
  const root = filesState.root;
  if (!root) return;
  if (anyOpen(root)) {
    const close = (n) => n.kids.forEach((k) => { if (k.dir) { k.open = false; close(k); } });
    close(root);
  } else {
    root.kids.filter((k) => k.dir).slice(0, EXPAND_LEVEL_MAX).forEach((k) => {
      k.open = true;
      if (!k.loaded) loadDir(k);
    });
  }
  renderTree();
}

// Opens every ancestor of `rel` (loading what is not loaded) and focuses it.
async function revealInTree(rel, isDir) {
  const root = filesState.root;
  const parts = rel.split('/');
  const upto = isDir ? parts.length : parts.length - 1;
  let node = root;
  for (let i = 0; i < upto; i++) {
    await loadDir(node);
    if (filesState.root !== root) return;
    const next = node.kids.find((k) => k.name === parts[i]);
    if (!next || !next.dir) break;
    next.open = true;
    node = next;
  }
  await loadDir(node);
  if (filesState.root !== root) return;
  filesState.cur = rel;
  renderTree();
  const row = [...$('fp-tree').querySelectorAll('.fp-row')].find((r) => rowNode.get(r).rel === rel);
  if (row) { row.tabIndex = 0; row.focus({ preventScroll: true }); row.scrollIntoView({ block: 'nearest' }); }
}

function activateRow(row) {
  const node = rowNode.get(row);
  if (!node) return;
  filesState.cur = node.rel;
  if (node.dir) toggleNode(node); else openViewer(node.rel);
}

function focusRow(row) {
  if (!row) return;
  $('fp-tree').querySelectorAll('.fp-row[tabindex="0"]').forEach((r) => { r.tabIndex = -1; });
  row.tabIndex = 0;
  row.focus({ preventScroll: true });
  row.scrollIntoView({ block: 'nearest' });
}

function onTreeKey(e) {
  const row = e.target.closest ? e.target.closest('.fp-row') : null;
  if (!row) return;
  const rows = [...$('fp-tree').querySelectorAll('.fp-row')];
  const at = rows.indexOf(row);
  const node = rowNode.get(row);
  const level = (r) => Number(r.getAttribute('aria-level'));
  let handled = true;
  if (e.key === 'ArrowDown') focusRow(rows[Math.min(rows.length - 1, at + 1)]);
  else if (e.key === 'ArrowUp') focusRow(rows[Math.max(0, at - 1)]);
  else if (e.key === 'Home') focusRow(rows[0]);
  else if (e.key === 'End') focusRow(rows[rows.length - 1]);
  else if (e.key === 'ArrowRight') {
    if (node.dir && !node.open) toggleNode(node);
    else if (node.dir && rows[at + 1] && level(rows[at + 1]) > level(row)) focusRow(rows[at + 1]);
  } else if (e.key === 'ArrowLeft') {
    if (node.dir && node.open) toggleNode(node);
    else focusRow(rows.slice(0, at).reverse().find((r) => level(r) < level(row)));
  } else if (e.key === 'Enter' || e.key === ' ') activateRow(row);
  else handled = false;
  if (handled) e.preventDefault();
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

function renderResults() {
  const box = $('fp-results');
  const scroll = box.scrollTop;
  const out = [];
  if (!results) out.push(note('Recherche…', 0, '', { loading: true }));
  else if (results.err) out.push(note(`⚠ ${results.err}`, 0, 'fp-err'));
  else {
    if (results.link) {
      const n = results.list.length;
      out.push(note(`${n === 1 ? '1 fichier correspond' : `${n} fichiers correspondent`} à « ${results.link} »`
        + (results.truncated ? ' — résultats peut-être incomplets' : ''), 0));
    }
    if (!results.list.length) out.push(note('Aucun fichier trouvé', 0));
    for (const r of results.list) {
      const slash = r.rel.lastIndexOf('/');
      const row = el('div', 'fp-row fp-res');
      row.setAttribute('role', 'option');
      row.tabIndex = -1;
      row.title = r.rel;
      row.append(
        icon(r.dir ? 'folder' : 'file'),
        el('span', 'fp-name', r.rel.slice(slash + 1)),
        el('span', 'fp-dirpath', slash > 0 ? r.rel.slice(0, slash) : ''),
      );
      rowResult.set(row, r);
      out.push(row);
    }
    if (results.truncated && !results.link) out.push(note('Résultats limités aux premiers trouvés', 0));
  }
  box.replaceChildren(...out);
  box.scrollTop = scroll;
}

async function runSearch() {
  const q = filesState.query;
  const target = filesState.target;
  if (!q) return;
  if (!target) {
    results = { err: 'Aucune session sélectionnée' };
    renderResults();
    return;
  }
  const root = filesState.root;
  const seq = ++searchSeq;
  const res = await window.api.filesSearch(target, q).catch(() => null);
  // No cancel between searches: only the answer to the latest query is shown.
  if (seq !== searchSeq || q !== filesState.query || filesState.root !== root) return;
  // A refresh while the list shows a chat link's matches keeps it that link's list.
  const lk = results && results.link && results.query === q ? results : null;
  if (!res || !res.ok) results = { err: (res && res.reason) || 'recherche impossible' };
  else if (lk) results = { ...lk, list: linkMatches(res.results, lk.link), truncated: !!res.truncated };
  else results = { list: res.results, truncated: !!res.truncated };
  renderResults();
}

function onSearchInput() {
  const q = $('fp-search').value.trim();
  if (q === filesState.query) return;
  clearTimeout(searchTimer);
  filesState.query = q;
  searchSeq++;
  if (!q) {
    results = null;
    applyMode();
    return;
  }
  if (filesState.mode === 'tree' || (results && results.link)) results = null;
  applyMode();
  renderResults();
  searchTimer = setTimeout(runSearch, SEARCH_DEBOUNCE_MS);
}

function clearSearch() {
  $('fp-search').value = '';
  onSearchInput();
  $('fp-search').focus({ preventScroll: true });
}

function openResult(r) {
  if (!r) return;
  if (r.dir) {
    clearSearch();
    revealInTree(r.rel, true);
  } else {
    resultsScroll = $('fp-results').scrollTop;
    openViewer(r.rel, results && results.link ? results.line : undefined);
  }
}

function onResultsKey(e) {
  const row = e.target.closest ? e.target.closest('.fp-res') : null;
  if (!row) return;
  const rows = [...$('fp-results').querySelectorAll('.fp-res')];
  const at = rows.indexOf(row);
  if (e.key === 'ArrowDown') rows[Math.min(rows.length - 1, at + 1)].focus({ preventScroll: true });
  else if (e.key === 'ArrowUp') (at > 0 ? rows[at - 1] : $('fp-search')).focus({ preventScroll: true });
  else if (e.key === 'Enter') openResult(rowResult.get(row));
  else return;
  e.preventDefault();
}

function onSearchKey(e) {
  if (e.key === 'ArrowDown') {
    const first = $('fp-results').querySelector('.fp-res');
    if (first) { first.focus({ preventScroll: true }); e.preventDefault(); }
  } else if (e.key === 'Enter') {
    const first = $('fp-results').querySelector('.fp-res');
    if (first) { openResult(rowResult.get(first)); e.preventDefault(); }
  }
}

// ---------------------------------------------------------------------------
// Viewer
// ---------------------------------------------------------------------------

function setCrumb(path) {
  const crumb = $('fp-crumb');
  crumb.title = path;
  const parts = path.split('/').filter(Boolean);
  const out = [];
  if (path.startsWith('/')) out.push(el('span', 'fp-sep', '/'));
  parts.forEach((seg, i) => {
    if (i > 0) out.push(el('span', 'fp-sep', '/'));
    out.push(el('span', i === parts.length - 1 ? 'fp-seg fp-last' : 'fp-seg', seg));
  });
  crumb.replaceChildren(...out);
}

// loading: a wait message, the bar is an empty child so the text stays exact; errors never get one.
function viewMessage(text, cls, { loading = false } = {}) {
  const msg = el('div', cls ? `fp-msg ${cls}` : 'fp-msg', text);
  if (loading) msg.append(inlineBar());
  $('fp-vbody').replaceChildren(msg);
}

function renderText(res, line) {
  const body = $('fp-vbody');
  if (!res.text) { viewMessage('Fichier vide'); return; }
  if (fpMd && MD_RE.test(res.rel) && !line) {
    // A line number refers to the source: with a line the Markdown shows as text.
    const doc = el('div', 'fp-md');
    doc.innerHTML = fpMd.render(res.text); // markdown-it, html:false
    body.replaceChildren(doc);
    placeBubbles(fileScope(filesState.target, res.fileKey), fpPlaceFrameBubble); // no selection here: the file's threads go to the dock
    return;
  }
  const parts = res.text.split('\n');
  const n = Math.max(1, parts.length - (res.text.endsWith('\n') ? 1 : 0));
  const wrap = el('div', 'fp-code-wrap');
  const t = filesState.target;
  codeCtx = { text: res.text, parts, n, wrap, rel: res.rel, placed: new Map(), hl: null, hlLine: 0,
    scope: fileScope(t, res.fileKey) };
  layoutCode(codeCtx);
  body.replaceChildren(wrap);
  if (line && line <= n) {
    codeCtx.hl = el('div', 'fp-hl');
    codeCtx.hlLine = line;
    wrap.prepend(codeCtx.hl);
  }
  placeBubbles(codeCtx.scope, placeFileBubble);
  positionHl(codeCtx);
  if (codeCtx.hl) body.scrollTop = Math.max(0, codeCtx.hl.offsetTop - body.clientHeight / 3);
}

// R2 / R3 on the numbered source view. codeCtx = the open file's view; its code is one gutter / code pair, or, once
// bubbles sit under some lines, one pair per segment (`.fp-seg`, `data-first` = its first line) with the bubbles between.
let codeCtx = null;

function codePair(ctx, from, to) {
  const gutter = el('pre', 'fp-gutter');
  gutter.setAttribute('aria-hidden', 'true');
  gutter.textContent = Array.from({ length: to - from + 1 }, (_, i) => from + i).join('\n');
  const tail = to === ctx.n && ctx.text.endsWith('\n') ? '\n' : '';
  const code = el('pre', 'fp-code', ctx.parts.slice(from - 1, to).join('\n') + tail);
  code.dataset.first = String(from);
  return [gutter, code];
}

function layoutCode(ctx) {
  const lineOf = (l) => Math.min(Math.max(1, l), ctx.n);
  const at = [...new Set([...ctx.placed.values()].map(lineOf))].sort((a, b) => a - b);
  const out = ctx.hl ? [ctx.hl] : [];
  ctx.wrap.classList.toggle('fp-split', at.length > 0);
  if (!at.length) out.push(...codePair(ctx, 1, ctx.n));
  let from = 1;
  for (const line of at) {
    const seg = el('div', 'fp-seg');
    seg.append(...codePair(ctx, from, line));
    const slot = el('div', 'ca-slot');
    for (const [b, l] of ctx.placed) if (lineOf(l) === line) slot.appendChild(b);
    out.push(seg, slot);
    from = line + 1;
  }
  if (at.length && from <= ctx.n) {
    const seg = el('div', 'fp-seg');
    seg.append(...codePair(ctx, from, ctx.n));
    out.push(seg);
  }
  ctx.wrap.replaceChildren(...out);
}

function positionHl(ctx) {
  if (!ctx.hl) return;
  const code = [...ctx.wrap.querySelectorAll('.fp-code')].filter((c) => Number(c.dataset.first) <= ctx.hlLine).pop();
  if (!code) return;
  const lh = parseFloat(getComputedStyle(code).lineHeight) || 18;
  ctx.hl.style.top = `${code.getBoundingClientRect().top - ctx.wrap.getBoundingClientRect().top
    + (ctx.hlLine - Number(code.dataset.first)) * lh}px`;
  ctx.hl.style.height = `${lh}px`;
}

// The Files `placeBubble`: the bubble goes under `line` (the code is split after it). The file's threads are one list, so an
// anchor that is not a line (a text range of the rich view, none for a frame) cannot be mapped here: the dock takes it.
function placeFileBubble(bubble, line) {
  const ctx = codeCtx;
  if (!ctx || !ctx.wrap.isConnected) return;
  if (typeof line !== 'number') { fpPlaceFrameBubble(bubble); return; }
  ctx.placed.set(bubble, line);
  layoutCode(ctx);
  positionHl(ctx);
}

// First and last selected line (D17: `\n` counted per `.fp-code` segment from its `data-first`); an end at a line start
// does not select that line. null when no source text is selected.
function selectedLines(range, ctx) {
  const nl = (r) => (r.toString().match(/\n/g) || []).length;
  let start = 0;
  let end = 0;
  for (const code of ctx.wrap.querySelectorAll('.fp-code')) {
    if (!range.intersectsNode(code)) continue;
    const full = document.createRange();
    full.selectNodeContents(code);
    const sub = range.cloneRange();
    if (sub.compareBoundaryPoints(Range.START_TO_START, full) < 0) sub.setStart(full.startContainer, full.startOffset);
    if (sub.compareBoundaryPoints(Range.END_TO_END, full) > 0) sub.setEnd(full.endContainer, full.endOffset);
    if (sub.collapsed) continue;
    const first = Number(code.dataset.first);
    const head = full.cloneRange();
    head.setEnd(sub.startContainer, sub.startOffset);
    const s = first + nl(head);
    head.setEnd(sub.endContainer, sub.endOffset);
    if (!start) start = s;
    end = Math.max(s, first + nl(head) - (head.toString().endsWith('\n') ? 1 : 0));
  }
  return start ? [start, Math.min(Math.max(end, start), ctx.n)] : null;
}

function onCodeSelect() {
  const ctx = codeCtx;
  const sel = window.getSelection();
  if (!ctx || !ctx.wrap.isConnected || !filesState.open || !sel || !sel.rangeCount || sel.isCollapsed) return;
  const range = sel.getRangeAt(0);
  const inside = (n) => !!(n && (n.nodeType === 1 ? n : n.parentElement).closest('.ca-bubble, .ca-popup'));
  if (inside(range.startContainer) || inside(range.endContainer)) return;
  const span = selectedLines(range, ctx);
  if (!span) return;
  const ref = `${ctx.rel}:L${span[0]}-L${span[1]}`;
  const lines = ctx.parts.slice(span[0] - 1, span[1]);
  openAsk({
    anchorEl: range.getBoundingClientRect(),
    anchor: span[1],
    threadRef: ref,
    scope: ctx.scope,
    compose: (question) => composeCodeMessage(ref, lines, question),
    placeBubble: placeFileBubble,
  });
}

// A chat link that is not rooted names a file relative to some folder of the session,
// not necessarily its root: { link, base } to look for by name, else null.
function linkQuery(path) {
  const link = path.replace(/^(?:\.\/)+/, '');
  if (!link || ROOTED_RE.test(link) || link.split('/').some((s) => !s || s === '.' || s === '..')) return null;
  return { link, base: link.slice(link.lastIndexOf('/') + 1) };
}

// Files whose path equals the link or ends with `/` + link (whole segments), shallow first.
function linkMatches(list, link) {
  const norm = (p) => p.split('\\').join('/');
  const depth = (p) => norm(p).split('/').length;
  return list
    .filter((r) => !r.dir && (norm(r.rel) === link || norm(r.rel).endsWith(`/${link}`)))
    .sort((a, b) => depth(a.rel) - depth(b.rel) || linkCollator.compare(norm(a.rel), norm(b.rel)));
}

// { hits, partial } for `q`, or null when this open was replaced / the panel closed meanwhile.
async function findLinked(view, q) {
  viewMessage('Recherche…', undefined, { loading: true });
  const found = await window.api.filesSearch(filesState.target, q.base).catch(() => null);
  if (filesState.view !== view || !filesState.target) return null;
  const ok = !!(found && found.ok);
  return { hits: ok ? linkMatches(found.results, q.link) : [], partial: ok && !!found.truncated };
}

// Several candidates: the Fichiers results, under the base name; a pick opens at the link's line.
function showLinkMatches(q, f, line, focus) {
  clearTimeout(searchTimer);
  searchSeq++;
  filesState.view = null;
  filesState.query = q.base;
  $('fp-search').value = q.base;
  results = { list: f.hits, truncated: f.partial, link: q.link, line, query: q.base };
  applyMode();
  renderResults();
  $('fp-results').scrollTop = 0;
  if (focus && filesState.open) $('fp-search').focus({ preventScroll: true });
}

// path: relative to the session folder, or absolute (main refuses what lies
// outside it). line: 1-based, optional. keep: a refresh of the open file (no
// placeholder, scroll kept). direct: no name search when the file is missing.
// A not-found, not-rooted path is looked up by name below the session folder.
async function openViewer(path, line, keep, focus = true, direct = false) {
  if (typeof path !== 'string' || !path || !filesState.target) return;
  fpFrameAskReset();
  const ln = Number.isFinite(Number(line)) && Number(line) >= 1 ? Math.floor(Number(line)) : null;
  if (filesState.mode === 'tree') treeScroll = $('fp-tree').scrollTop;
  const view = { rel: path, line: ln, text: !!(keep && filesState.view && filesState.view.text) }; // text: HTML shown as source
  filesState.view = view;
  const body = $('fp-vbody');
  const scroll = keep ? body.scrollTop : 0;
  applyMode();
  setCrumb(path);
  if (!keep) { setModeToggle(null); viewMessage('Chargement…', undefined, { loading: true }); }
  let res = await window.api.filesRead(filesState.target, path).catch(() => null);
  if (filesState.view !== view) return; // closed / replaced meanwhile (a session change resets the view)
  if (!keep && !direct && res && !res.ok && res.code === 'not-found') {
    const q = linkQuery(path);
    const f = q ? await findLinked(view, q) : { hits: [], partial: false };
    if (!f) return;
    if (f.hits.length === 1 && !f.partial) { openViewer(f.hits[0].rel, ln, false, focus, true); return; }
    if (f.hits.length) { showLinkMatches(q, f, ln, focus); return; }
    if (f.partial) res = { ...res, reason: `${res.reason} — recherche incomplète` };
  }
  if (!res || !res.ok) { setModeToggle(null); viewMessage(`⚠ ${(res && res.reason) || 'lecture impossible'}`, 'fp-err'); }
  else {
    view.rel = res.rel;
    setCrumb(res.rel);
    if (res.binary) { setModeToggle(null); viewMessage(`Fichier binaire (${fmtSize(res.size)})`); }
    else if (res.tooLarge) { setModeToggle(null); viewMessage(`Fichier trop volumineux (${fmtSize(res.size)})`); }
    else renderFile(res, ln, view);
  }
  if (keep) body.scrollTop = scroll;
  if (focus && filesState.open) body.focus({ preventScroll: true });
}

// R9: an .html / .htm file opens as a static rich page (« Format riche », default) or as its source (« Texte »);
// the pick lives on the open view (`view.text`) and is kept by a refresh of the same file, never stored.
let htmlRes = null; // the read of the HTML file shown, so a toggle re-renders without another IPC

function setModeToggle(view) {
  let box = $('fp-mode');
  if (!box && !view) return;
  if (!box) {
    box = el('div', 'fp-mode');
    box.id = 'fp-mode';
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', 'Affichage du fichier HTML');
    for (const [key, label] of [['rich', 'Format riche'], ['text', 'Texte']]) {
      const b = el('button', 'fp-mode-btn', label);
      b.type = 'button';
      b.dataset.mode = key;
      b.addEventListener('click', () => {
        const v = filesState.view;
        if (!v || !htmlRes || htmlRes.rel !== v.rel || v.text === (key === 'text')) return;
        v.text = key === 'text';
        closeAsk(); // no popup outlives the view it was opened on
        renderFile(htmlRes, v.line, v);
      });
      box.appendChild(b);
    }
    $('fp-vhead').insertBefore(box, $('fp-vrefresh'));
  }
  box.hidden = !view;
  if (view) for (const b of box.children) b.setAttribute('aria-pressed', String((b.dataset.mode === 'text') === view.text));
}

function renderFile(res, line, view) {
  fpFrameAskReset();
  if (!HTML_RE.test(res.rel) || !res.text) { setModeToggle(null); renderText(res, line); return; }
  htmlRes = res;
  setModeToggle(view);
  if (view.text) renderText(res, line); else renderRich(res);
}

// The page is untrusted: no script runs (sandbox without allow-scripts), nothing cross-origin is fetched (the app
// CSP default-src 'self' is inherited by about:srcdoc; same-origin file: subresources may load, inert without script)
// and nothing navigates. DOMParser is inert; its meta refresh, base and link are dropped.
function renderRich(res) {
  const doc = new DOMParser().parseFromString(res.text, 'text/html');
  if (pageHasScript(doc)) { renderScriptPage(res); return; }
  doc.querySelectorAll('meta[http-equiv], base, link').forEach((n) => n.remove());
  const frame = el('iframe', 'fp-frame');
  frame.setAttribute('sandbox', 'allow-same-origin'); // same-origin only so the parent can read it; no code runs there
  frame.title = 'Aperçu de la page HTML';
  frame.addEventListener('load', () => lockFrame(frame)); // the first load is about:blank
  frame.srcdoc = doc.documentElement.outerHTML;
  // The frame element is white until its page paints: held at opacity 0 until the srcdoc document itself has loaded.
  revealFrame(frame, { ready: (f) => !!f.contentDocument && f.contentDocument.URL === 'about:srcdoc' });
  const overlay = el('div', 'fp-overlay'); // the code-ask bubbles sit here (R2 / R3)
  overlay.style.overflow = 'hidden'; // a bubble scrolled out of the page is clipped, it never grows #fp-vbody
  const wrap = el('div', 'fp-rich');
  wrap.append(frame, overlay);
  if (richCtx) richCtx.ro.disconnect();
  const t = filesState.target;
  const ctx = { frame, wrap, overlay, rel: res.rel, doc: null, placed: new Map(),
    scope: fileScope(t, res.fileKey) };
  ctx.ro = new ResizeObserver(() => { layoutRich(ctx); requestAnimationFrame(() => layoutRich(ctx)); });
  ctx.ro.observe($('fp-vbody'));
  richCtx = ctx;
  $('fp-vbody').replaceChildren(wrap);
}

// A page that holds script runs in a closed frame (page-frame.js) fed the RAW text, so its fonts <link> survives. The
// frame is a cross-origin document: no lockFrame; its relay reports the selection and the presses to frame-ask.js (chip,
// popup), the answers sit in #fp-asks. richCtx is cleared so no stale ctx acts.
let scriptSeq = 0; // the latest script-page render: a mount that finishes late drops itself

function fpFrameAskReset() {
  frameAskReset();
  const dock = $('fp-asks');
  if (dock) { dock.replaceChildren(); dock.hidden = true; }
}

function fpPlaceFrameBubble(bubble) {
  const dock = $('fp-asks');
  if (!dock) return;
  dock.appendChild(bubble);
  dock.hidden = false;
}

async function renderScriptPage(res) {
  if (richCtx) { richCtx.ro.disconnect(); richCtx = null; }
  closeAsk();
  const view = filesState.view;
  const seq = ++scriptSeq;
  const t = filesState.target;
  const scope = fileScope(t, res.fileKey);
  const isCurrent = () => seq === scriptSeq && !!view && filesState.view === view && !view.text;
  const host = {
    label: res.rel,
    scope,
    isLive: () => isCurrent() && filesState.open,
    fallbackRect: () => { const v = $('fp-vbody').getBoundingClientRect(); return { left: v.left + 12, top: v.top, width: 0, height: 8 }; },
    placeBubble: fpPlaceFrameBubble,
  };
  const r = await mountClosedFrame($('fp-vbody'), res.text, 'files', {
    title: 'Aperçu de la page HTML',
    isCurrent,
    onFrame: (f) => revealFrame(f), // the closed frame paints white before its page: held at opacity 0 until `load`
    onSelect: (sel) => frameAskSelect(sel, host),
    onPointerDown: () => { if (host.isLive()) frameAskPointerDown(); }, // a hidden Files frame stays mounted: its press is not this tab's
  });
  if (r === false) viewMessage('⚠ lecture impossible', 'fp-err'); // null: the view moved on, show nothing
  else if (r) placeBubbles(scope, fpPlaceFrameBubble);
}

function lockFrame(frame) {
  const d = frame.contentDocument;
  if (!d || d.URL !== 'about:srcdoc') return;
  const noLink = (e) => { if (e.target && e.target.closest && e.target.closest('a, area')) e.preventDefault(); };
  d.addEventListener('click', noLink, true);
  d.addEventListener('auxclick', noLink, true);
  d.addEventListener('submit', (e) => e.preventDefault(), true);
  d.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') noLink(e);
    else if (e.key === 'Escape') {
      // The frame is a separate document: an open ask popup takes the Escape, else hand it to the parent (maximize, viewer).
      e.preventDefault();
      if (document.querySelector('[data-sp-popup]')) closeAsk();
      else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    }
  }, true);
  const ctx = richCtx;
  if (!ctx || ctx.frame !== frame) return;
  ctx.doc = d;
  d.addEventListener('mousedown', () => closeAsk(), true); // the parent's outside-click close does not see this document
  d.addEventListener('mouseup', onRichSelect);
  d.addEventListener('keyup', (e) => { if (e.shiftKey || e.key === 'Shift') onRichSelect(); });
  d.addEventListener('scroll', () => layoutRich(ctx), true);
  placeBubbles(ctx.scope, placeRichBubble); // a reopened page gets its stored bubbles back from their text offsets
}

// R9 / R2 / R3 on the rich view (D23). richCtx = the open page's frame; its bubbles sit in the overlay layer, placed beside
// their text range. An anchor is { start, end, text }: offsets in document order over the body's text nodes, plus the text itself.
let richCtx = null;

function textOffsets(body, range) {
  const pre = body.ownerDocument.createRange();
  pre.selectNodeContents(body);
  pre.setEnd(range.startContainer, range.startOffset);
  const start = pre.toString().length;
  return { start, end: start + range.toString().length };
}

// The range of `anchor` in the body: at its stored offsets while the text there is still the anchored text, else at the
// nearest occurrence of that text (the page was edited before it); null when the passage is gone.
function rangeOf(doc, anchor) {
  if (!doc.body) return null;
  const nodes = [];
  let full = '';
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) { nodes.push([n, full.length]); full += n.data; }
  const len = anchor.text.length;
  let start = full.startsWith(anchor.text, anchor.start) ? anchor.start : -1;
  if (start < 0) {
    const before = full.lastIndexOf(anchor.text, anchor.start);
    const after = full.indexOf(anchor.text, anchor.start);
    if (before < 0 || after < 0) start = Math.max(before, after);
    else start = anchor.start - before <= after - anchor.start ? before : after;
  }
  if (start < 0 || !len) return null;
  const from = nodes.find(([n, base]) => start < base + n.data.length);
  const to = nodes.find(([n, base]) => start + len <= base + n.data.length);
  if (!from || !to) return null;
  const range = doc.createRange();
  range.setStart(from[0], start - from[1]);
  range.setEnd(to[0], start + len - to[1]);
  return range;
}

function onRichSelect() {
  const ctx = richCtx;
  if (!ctx || !ctx.doc || !ctx.wrap.isConnected || !filesState.open) return;
  const d = ctx.doc;
  const sel = d.getSelection();
  if (!sel || !sel.rangeCount || sel.isCollapsed) return;
  const range = sel.getRangeAt(0);
  const text = sel.toString().trim();
  if (!text || !d.body || !d.body.contains(range.startContainer) || !d.body.contains(range.endContainer)) return;
  const anchor = { ...textOffsets(d.body, range), text: range.toString() };
  const words = text.split(/\s+/).slice(0, 8).join(' ');
  const ref = `${ctx.rel} — « ${words.length > 60 ? `${words.slice(0, 59).trimEnd()}…` : words} »`;
  // The popup opens beside the selection: openAsk reads, at once, the rect of a transparent element laid over the range.
  const r = range.getBoundingClientRect();
  const o = ctx.overlay.getBoundingClientRect();
  const f = ctx.frame.getBoundingClientRect();
  const at = ctx.anchorEl || (ctx.anchorEl = el('div', 'fp-sel'));
  Object.assign(at.style, { position: 'absolute', pointerEvents: 'none', left: `${r.left + f.left - o.left}px`,
    top: `${r.top + f.top - o.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  ctx.overlay.appendChild(at);
  openAsk({
    anchorEl: at,
    selectionDoc: d,
    anchor,
    threadRef: ref,
    scope: ctx.scope,
    compose: (question) => composeCodeMessage(ref, text, question),
    placeBubble: placeRichBubble,
  });
  at.remove();
}

// Every bubble of the page: beside its range (below it, or above when there is no room, fixed at the first placement),
// frame offset included; an anchor that no longer fits stacks the bubble at the top of the overlay.
function layoutRich(ctx) {
  if (!ctx || !ctx.doc || !ctx.wrap.isConnected) return;
  const o = ctx.overlay.getBoundingClientRect();
  const f = ctx.frame.getBoundingClientRect();
  let lostTop = 8;
  for (const [bubble, slot] of ctx.placed) {
    const range = rangeOf(ctx.doc, slot.anchor);
    let note = bubble.querySelector('.fp-lost');
    bubble.style.width = `${Math.max(0, Math.min(360, o.width - 16))}px`;
    if (!range) {
      if (!note) {
        note = el('div', 'ca-note fp-lost', 'passage introuvable');
        note.dataset.viewNote = ''; // dropped by placeBubbles when the thread moves to another view
        bubble.querySelector('.ca-head').after(note);
      }
      bubble.style.left = '8px';
      bubble.style.top = `${lostTop}px`;
      bubble.style.bottom = 'auto';
      lostTop += bubble.offsetHeight + 6;
      continue;
    }
    if (note) note.remove();
    const r = range.getBoundingClientRect();
    const top = r.top + f.top - o.top;
    const bottom = r.bottom + f.top - o.top;
    const h = bubble.offsetHeight;
    if (!slot.side) slot.side = bottom + 4 + h > o.height && top - 4 - h >= 0 ? 'above' : 'below';
    bubble.style.top = slot.side === 'below' ? `${bottom + 4}px` : 'auto';
    bubble.style.bottom = slot.side === 'below' ? 'auto' : `${o.height - (top - 4)}px`; // 'above' grows upward
    bubble.style.left = `${Math.max(8, Math.min(r.left + f.left - o.left, o.width - bubble.offsetWidth - 8))}px`;
  }
}

// The Files-rich `placeBubble`: the overlay layer has pointer-events none, so the bubble opts back in.
function placeRichBubble(bubble, anchor) {
  const ctx = richCtx;
  if (!ctx || !ctx.wrap.isConnected) return;
  if (!anchor || typeof anchor.start !== 'number') { fpPlaceFrameBubble(bubble); return; } // not a range of this page: the dock
  Object.assign(bubble.style, { position: 'absolute', pointerEvents: 'auto', margin: '0', boxSizing: 'border-box' });
  ctx.placed.set(bubble, { anchor, side: null });
  ctx.overlay.appendChild(bubble);
  layoutRich(ctx);
}

function closeViewer() {
  if (!filesState.view) return;
  fpFrameAskReset();
  filesState.view = null;
  applyMode();
  $('fp-tree').scrollTop = treeScroll;
  $('fp-results').scrollTop = resultsScroll;
  if (filesState.mode === 'tree') {
    const cur = $('fp-tree').querySelector('.fp-row[tabindex="0"]');
    if (cur) cur.focus({ preventScroll: true });
  } else $('fp-search').focus({ preventScroll: true });
}

// ---------------------------------------------------------------------------
// Tab lifecycle
// ---------------------------------------------------------------------------

async function reloadOpen(node) {
  await loadDir(node, true);
  await Promise.all(node.kids.filter((k) => k.dir && k.open).map(reloadOpen));
}

let refreshBar = null; // the wait of the latest user-started refresh

// by: 'tree' | 'view', the button that started it; only then a bar shows until the reloads settle.
function refresh(skipView, by) {
  if (!filesState.open || !filesState.target || !filesState.root) return;
  const jobs = [reloadOpen(filesState.root)];
  if (filesState.query) jobs.push(runSearch());
  const read = filesState.view && !skipView
    ? openViewer(filesState.view.rel, filesState.view.line, true, false) : null;
  if (!by) return;
  const bar = by === 'view' ? inlineBar() : progressBar();
  if (refreshBar) refreshBar.remove();
  refreshBar = bar;
  if (by === 'view') $('fp-vhead').insertBefore(bar, $('fp-vrefresh'));
  else $('fp-head').after(bar);
  return Promise.allSettled(by === 'view' && read ? [read] : read ? [...jobs, read] : jobs).then(() => bar.remove());
}

function resetModel(target) {
  fpFrameAskReset();
  searchSeq++;
  clearTimeout(searchTimer);
  results = null;
  treeScroll = 0;
  resultsScroll = 0;
  Object.assign(filesState, { query: '', view: null, cur: '', forTarget: target, root: null });
  filesState.root = target ? mkNode('', '', true) : null;
  $('fp-search').value = '';
  $('fp-tree').replaceChildren();
  $('fp-results').replaceChildren();
  $('fp-vbody').replaceChildren();
}

// opts: { keepFocus } from the panel, { path, line } from openFileInPanel.
function fpOpen(target, opts) {
  const o = opts || {};
  const t = target ? { paneId: target.paneId, sessionId: target.sessionId } : null;
  const wasOpen = filesState.open;
  const sameModel = !!t && sameTarget(filesState.forTarget, t);
  if (!sameModel) resetModel(t);
  filesState.open = true;
  filesState.target = t;
  showSideTab('files', t);
  applyMode();
  if (!t) { renderTree(); return; }
  if (sameModel && !wasOpen) refresh(!!o.path);
  else if (!filesState.root.loaded) { loadDir(filesState.root); renderTree(); }
  if (o.path) openViewer(o.path, o.line, false, !o.keepFocus);
  else if (!o.keepFocus) {
    // preventScroll (rule 8): same as the git and plans panels.
    if (filesState.mode === 'viewer') $('fp-vbody').focus({ preventScroll: true });
    else $('fp-search').focus({ preventScroll: true });
  }
}

// The tab's own reset — side-panel.js calls it when the panel closes or another
// tab is shown; it never calls back into the panel. The tree model is kept for
// the same session and refreshed when the tab comes back.
function fpClose() {
  filesState.open = false;
  filesState.target = null;
  clearTimeout(searchTimer);
}

// Public entry (consumer: chat file links, P1-16): opens the side panel on
// « Fichiers » and shows `path` in the viewer. `target` = { paneId, sessionId }
// (default: the panel's current target, else the selected pane). `path` is
// relative to the session folder or absolute; one outside the folder is refused
// with a message. A relative `path` missing at the folder's root is looked up by
// name below it: one match opens, several are listed. `line` (1-based, optional) scrolls to and marks that line; a
// Markdown file opened with a line shows as text so the line stays meaningful.
export function openFileInPanel(target, path, line) {
  openSidePanel('files', target, { path, line });
}

// Builds the markup-bound listeners — called once from boot.js, after initSidePanel().
export function initFilesPanel() {
  $('fp-search').addEventListener('input', onSearchInput);
  $('fp-search').addEventListener('keydown', onSearchKey);
  $('fp-results').addEventListener('keydown', onResultsKey);
  $('fp-results').addEventListener('click', (e) => {
    const row = e.target.closest ? e.target.closest('.fp-res') : null;
    if (row) openResult(rowResult.get(row));
  });
  const tree = $('fp-tree');
  tree.addEventListener('keydown', onTreeKey);
  tree.addEventListener('click', (e) => {
    const row = e.target.closest ? e.target.closest('.fp-row') : null;
    if (row) activateRow(row);
  });
  tree.addEventListener('focusin', (e) => {
    const row = e.target.closest ? e.target.closest('.fp-row') : null;
    const node = row && rowNode.get(row);
    if (node) filesState.cur = node.rel;
  });
  $('fp-all').addEventListener('click', toggleAll);
  $('fp-refresh').addEventListener('click', (e) => spinWhile(e.currentTarget, refresh(false, 'tree')));
  $('fp-vrefresh').addEventListener('click', (e) => spinWhile(e.currentTarget, refresh(false, 'view')));
  $('fp-back').addEventListener('click', closeViewer);
  // A rendered Markdown file can carry links: this panel is a READER, never navigate.
  $('fp-vbody').addEventListener('click', (e) => {
    const a = e.target && e.target.closest ? e.target.closest('a') : null;
    if (a) e.preventDefault();
  });

  // Escape: viewer -> tree, search -> cleared, else the panel closes. Never from a
  // focused terminal (rule 8), nor while a popup / menu / dialog is up (its owner closes it first).
  document.addEventListener('keydown', (e) => {
    if (!filesState.open || e.key !== 'Escape') return;
    if (e.target && e.target.closest && e.target.closest('.pane-term')) return;
    if (ownPopupOpen()) return;
    if (filesState.mode === 'viewer') closeViewer();
    else if (filesState.query) clearSearch();
    else closeSidePanel();
    e.preventDefault();
  });

  $('fp-vbody').addEventListener('mouseup', onCodeSelect);
  $('fp-vbody').addEventListener('keyup', (e) => { if (e.shiftKey || e.key === 'Shift') onCodeSelect(); });

  registerSideTab('files', {
    open: fpOpen,
    close: () => { closeAsk(); fpFrameAskReset(); fpClose(); },
    ownEscape: true,
  });
}
