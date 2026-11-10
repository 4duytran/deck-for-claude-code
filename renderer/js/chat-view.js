// claude-deck — renderer/chat-view (v42, composer v43, TUI interaction v46):
// the per-pane CONVERSATION VIEW — the session transcript rendered as chat
// cards grouped in role TURNS (avatar + label header per speaker change:
// clear user ↔ Claude separation), plus a composer pinned at the bottom.
// SENDING goes through the PTY exactly like typing: xterm bracketed paste +
// CR — the TUI receives it as keyboard input. The sent message shows
// instantly as a dimmed optimistic echo, confirmed (de-dimmed) when the
// transcript tail returns it. v46: claude's blocking prompts (permissions,
// AskUserQuestion, plan approval — all numbered TUI menus) are mirrored as
// clickable buttons (see tui-prompt.js); Shift+Tab mode cycling and Esc
// ride the same PTY path. v46.9.8: slash-commands are BLOCKED in chat (a
// warning — they're TUI dialogs the transcript view can't render); the one
// that matters, /compact, has a dedicated button (deck-managed).
// Data feed: window.api.transcriptSubscribe (bounded initial read) + global
// 'transcript-append' pushes routed here by boot.js (single-listener rule).
// Perf rules: animations ONLY on live appends (never the initial batch),
// content-visibility on cards, all main-side IO async (see ipc/transcript).
'use strict';

import { panes, overlayState } from './state.js';
import { scheduleResync } from './layout.js';
import { ringColor } from './usage.js'; // v47: shared green->red fill ramp
import { readTui, readComposerBox } from './tui-prompt.js';
import { openAgentJournal } from './agent-journal.js';
import { mountAskHost, askComposerInput, askComposerSubmit, onAskHostChange } from './ask-drawer.js';
import { openFileInPanel } from './files-panel.js';
import { humanizeModel } from './model-label.js'; // v66 id -> label, shared with the sidebar agent rows
import { collapse, expand, fadeIn, exitThen } from './motion.js';
import { inlineBar, skeleton } from './loading.js';
import { fileToken, tokensText, dragHasFiles, droppedPaths } from './file-drop.js'; // shared with the new-session home

// Same guard as ppMd (plans panel): markdownit is a UMD global from
// index.html; html:false = rendered markdown can never inject markup.
const chatMd = (typeof markdownit !== 'undefined')
  ? markdownit({ html: false, linkify: true })
  : null;

// Tool name -> glyph (emoji — same visual language as the sidebar icons).
const TOOL_ICONS = [
  [/^(Read|NotebookRead)$/, '\u{1F4C4}'], // 📄
  [/^(Glob|Grep|.*Search.*|LS)$/i, '\u{1F50D}'], // 🔍
  [/^(Edit|Write|MultiEdit|NotebookEdit)$/, '✏️'], // ✏️
  [/^Bash/, '⚡'], // ⚡
  [/^(Task|Agent|SendMessage|Workflow|Skill)$/, '\u{1F916}'], // 🤖
  [/^Web/, '\u{1F310}'], // 🌐
  [/^(TodoWrite|TaskCreate|TaskUpdate|TaskList|TaskGet)$/, '✅'], // ✅
  [/^mcp__/, '\u{1F50C}'], // 🔌
];
function toolIcon(name) {
  for (const [re, ico] of TOOL_ICONS) {
    if (re.test(name)) return ico;
  }
  return '\u{1F527}'; // 🔧
}

// An Edit tool_use input as diff lines [gutter, text]: the lines both strings share at the top and bottom are context, the rest is -/+.
// The input holds no file line numbers, so no « @@ » header is invented. Null when the detail is not the whole input (capped JSON).
function editDiffLines(detail) {
  let inp;
  try { inp = JSON.parse(detail); } catch (_) { return null; }
  if (!inp || typeof inp.old_string !== 'string' || typeof inp.new_string !== 'string') return null;
  const a = inp.old_string.split('\n');
  const b = inp.new_string.split('\n');
  let top = 0;
  while (top < a.length && top < b.length && a[top] === b[top]) top++;
  let bottom = 0;
  while (bottom < a.length - top && bottom < b.length - top && a[a.length - 1 - bottom] === b[b.length - 1 - bottom]) bottom++;
  return [
    ...a.slice(0, top).map((t) => [' ', t]),
    ...a.slice(top, a.length - bottom).map((t) => ['-', t]),
    ...b.slice(top, b.length - bottom).map((t) => ['+', t]),
    ...a.slice(a.length - bottom).map((t) => [' ', t]),
  ];
}

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleTimeString('fr-FR', { hour12: false });
}

function renderMdInto(el, text) {
  if (chatMd) el.innerHTML = chatMd.render(text);
  else el.textContent = text; // markdownit missing: degrade, never break
}

// File links (B3). Candidate: no whitespace / glob / placeholder char, no URL scheme, and `/…`, `~/…`,
// `./…`, `../…`, a relative path holding `/`, or a bare `name.ext` / `.dotfile`; optional `:line[:col]`.
// The renderer never reads the file: main decides containment when the viewer asks for it.
const FILE_LINK_BAD = /[\s\x00-\x1f"<>|*?#\\{}$]/;
const FILE_LINK_LINE = /^(.+?):(\d{1,7})(?::\d{1,7})?$/;
const FILE_LINK_NAME = /^(?:\.?[^./][^/]*\.[A-Za-z][A-Za-z0-9]{0,9}|\.[A-Za-z][\w-]{1,30})$/;
function fileLinkParts(raw) {
  let s = String(raw || '').trim();
  if (!s || s.length > 400 || FILE_LINK_BAD.test(s)) return null;
  let line;
  const m = FILE_LINK_LINE.exec(s);
  if (m) { s = m[1]; line = Number(m[2]) || undefined; }
  if (s.includes(':') || /^(?:\/\/|-|@)/.test(s) || s.endsWith('/')) return null;
  const rooted = /^(?:\/|~\/|\.\.?\/)./.test(s);
  if (!rooted && !s.includes('/') && !FILE_LINK_NAME.test(s)) return null;
  return { path: s, line };
}

// Post-pass for assistant markdown: inline `code` (not in a `pre`) and `a` holding a path become chips.
// DOM APIs only (dataset / classList / createElementNS): message text never reaches innerHTML.
function linkFilePaths(root) {
  const mark = (el, parts) => {
    el.classList.add('cv-file-link');
    el.setAttribute('role', 'link');
    el.tabIndex = 0;
    el.dataset.path = parts.path;
    if (parts.line) el.dataset.line = String(parts.line);
    el.prepend(lucideIcon('lc-file'));
  };
  for (const a of root.querySelectorAll('a[href]')) {
    let href = a.getAttribute('href');
    try { href = decodeURIComponent(href); } catch (_) { /* keep the raw href */ }
    const parts = fileLinkParts(href);
    if (parts) mark(a, parts);
  }
  for (const code of root.querySelectorAll('code')) {
    if (code.closest('pre, a')) continue;
    const full = code.textContent.trim();
    const parts = fileLinkParts(full);
    if (!parts) continue;
    // Chip shows the file name (+ :line); the full path stays in dataset.path and the tooltip.
    code.textContent = parts.path.slice(parts.path.lastIndexOf('/') + 1) + (parts.line ? `:${parts.line}` : '');
    code.title = full;
    mark(code, parts);
  }
}

function openFileLink(pane, el) {
  const line = Number(el.dataset.line);
  openFileInPanel(fileTarget(pane), el.dataset.path, line > 0 ? line : undefined);
}

// v59: user bubbles render CODE BLOCKS ONLY — fenced ``` blocks + inline `code`,
// nothing else (no headings/lists/emphasis), so a casual message is never
// reflowed by stray markdown. HTML is always escaped (never inject markup).
// Shares the .chat-md pre/code look + the 20-line clamp via .cm-codeonly.
// A stray C0 control byte can ride the PTY round-trip into what the TUI writes
// back to the transcript (observed 2026-06-12: the box-clear Ctrl-U `\x15`
// leaking into the bracketed-paste window -> the confirmed line is "msg\x15"
// while the optimistic echo holds the clean "msg"). Invisible, but it breaks
// exact-match (echo stranded in « ⋯ envoi » + a DUPLICATE confirmed bubble =
// the « double envoi » bug) and litters a reloaded bubble. Strip the non-
// whitespace C0 controls (+ DEL); keep \t \n \r (whitespace handles those).
const CTRL_STRIP_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

function escHtml(s) {
  return s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
}
function renderCodeOnly(el, text) {
  el.classList.add('cm-codeonly');
  text = String(text).replace(CTRL_STRIP_RE, ''); // drop invisible C0 junk (PTY round-trip) so the bubble is clean
  // line-based fenced scan: a fence opens on a line of ``` (+ optional info
  // string) and closes on a line of ```. Text outside keeps its literal
  // newlines (the bubble is white-space:pre-wrap) and gets inline `code` spans.
  const lines = String(text).split('\n');
  const inlineCode = (s) => escHtml(s).replace(/`([^`\n]+)`/g, '<code>$1</code>');
  let html = '';
  let buf = [];
  const flushText = () => { if (buf.length) { html += inlineCode(buf.join('\n')); buf = []; } };
  let i = 0;
  while (i < lines.length) {
    if (/^```(.*)$/.test(lines[i])) {
      flushText();                       // drop the newline that would precede the box
      i++;
      const code = [];
      while (i < lines.length && !/^```\s*$/.test(lines[i])) { code.push(lines[i]); i++; }
      i++;                               // skip the closing fence (or step past EOF)
      html += '<pre><code>' + escHtml(code.join('\n')) + '</code></pre>';
      continue;                          // an unclosed fence at EOF still boxes — it's a sent message
    }
    buf.push(lines[i]);
    i++;
  }
  flushText();
  el.innerHTML = html;
}

// ---------------------------------------------------------------------------
// v59: rich composer (contenteditable) — the input box renders a COMPLETE
// fenced ``` block inline as a styled box (fences hidden) while you type.
// The send chain is untouched: a .value/.disabled/.placeholder shim
// (installRichInput) makes the div behave like the old textarea for every
// caller. Logical value = plain string (``` fences are the source of truth);
// the DOM is re-derived only when the BLOCK STRUCTURE changes (signature), so
// typing inside a box or in plain text never re-renders (caret stays native).
// ---------------------------------------------------------------------------

// Split a logical string into text / code segments. A code segment needs BOTH
// an opening ``` line and a closing ``` line — an incomplete fence stays text
// (it boxes only once you type the close), so the user is never trapped.
function parseSegments(v) {
  const lines = String(v).split('\n');
  const segs = [];
  let buf = [];
  const flush = () => { if (buf.length) { segs.push({ type: 'text', text: buf.join('\n') }); buf = []; } };
  let i = 0;
  while (i < lines.length) {
    const open = /^```(.*)$/.exec(lines[i]);
    if (open) {
      let j = i + 1;
      while (j < lines.length && !/^```\s*$/.test(lines[j])) j++;
      if (j < lines.length) {                    // closing fence found -> a real block
        flush();
        segs.push({ type: 'code', lang: open[1].trim(), text: lines.slice(i + 1, j).join('\n') });
        i = j + 1;
        continue;
      }
    }
    buf.push(lines[i]);
    i++;
  }
  flush();
  return segs;
}

// Structural fingerprint — re-render the editor only when this changes.
function sigOf(v) {
  return parseSegments(v).map((s) => (s.type === 'code' ? 'C' + (s.lang || '') : 'T')).join('|');
}

// DOM -> logical string. Text nodes carry literal \n (the editor is
// white-space:pre-wrap); a .ci-code box re-emits its hidden fences.
function domToValue(root) {
  let out = '';
  root.childNodes.forEach((n) => {
    if (n.nodeType === 3) { out += n.nodeValue; return; }
    if (n.nodeType === 1 && n.classList && n.classList.contains('ci-code')) {
      out += '```' + (n.dataset.lang || '') + '\n' + (n.textContent || '') + '\n```';
      return;
    }
    if (n.nodeType === 1 && n.tagName === 'BR') { return; } // v59: drop the empty-state <br> filler (never a real newline here)
    if (n.nodeType === 1) { out += n.textContent || ''; }
  });
  return out;
}

// logical string -> DOM. Segments are joined by literal '\n' text nodes (the
// line separators), so domToValue is its exact inverse. A trailing box gets a
// '\n' + empty escape node so typing below it can't dissolve the closing fence.
function renderEditorDom(root, v) {
  const segs = parseSegments(v);
  root.textContent = '';
  segs.forEach((s, i) => {
    if (i > 0) root.appendChild(document.createTextNode('\n'));
    if (s.type === 'text') {
      root.appendChild(document.createTextNode(s.text));
    } else {
      const box = document.createElement('div');
      box.className = 'ci-code';
      if (s.lang) box.dataset.lang = s.lang;
      box.appendChild(document.createTextNode(s.text));
      root.appendChild(box);
    }
  });
  if (segs.length && segs[segs.length - 1].type === 'code') {
    root.appendChild(document.createTextNode('\n'));
    root.appendChild(document.createTextNode(''));
  }
}

function placeCaretEnd(root) {
  const sel = window.getSelection();
  if (!sel) return;
  const r = document.createRange();
  r.selectNodeContents(root);
  r.collapse(false);
  sel.removeAllRanges();
  sel.addRange(r);
}

// Last character before a collapsed caret, skipping the empty text nodes the
// editor DOM keeps as line sentinels ('' after a trailing '\n').
function charBeforeCaret(r) {
  const n = r.startContainer;
  if (n.nodeType === 3) return r.startOffset > 0 ? n.data[r.startOffset - 1] : '';
  for (let i = r.startOffset; i > 0; i--) {
    const t = n.childNodes[i - 1].textContent || '';
    if (t) return t[t.length - 1];
  }
  return '';
}

// v72: keep the caret inside the composer's visible window. The box is a
// contenteditable div capped by CSS (max-height + overflow-y:auto) and EVERY
// caret move here is programmatic (Selection.addRange) — Chromium only
// auto-reveals the caret after a NATIVE editing command, so past the cap the
// written line sat below the window with scrollTop stuck at 0 (user repro).
// Never scrollIntoView: that would scroll the pane and the stream too.
function revealCaret(el) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  if (el.scrollHeight <= el.clientHeight) return; // no cap in play, nothing to reveal
  const r = sel.getRangeAt(0);
  if (!el.contains(r.startContainer)) return; // caret lives somewhere else
  const max = el.scrollHeight - el.clientHeight;
  let rect = r.getBoundingClientRect();
  if (!rect || !rect.height) {
    // A collapsed range has NO rect of its own in Chromium when it sits
    // BETWEEN nodes, which is exactly what both caret writers leave behind:
    // insertTextAtCaret setStartAfter()s the inserted node (startContainer =
    // the div) and placeCaretEnd collapses to the content end. Locate it.
    const end = document.createRange();
    end.selectNodeContents(el);
    end.collapse(false);
    if (r.compareBoundaryPoints(Range.END_TO_END, end) >= 0) {
      // Bottom-growth fallback ONLY — right because the caret IS at the very
      // end of the content, not a universal caret locator.
      el.scrollTop = max;
      return;
    }
    // Last laid-out line up to the caret; when the caret just crossed a
    // newline the fresh line has no box yet, so step one line down.
    const head = document.createRange();
    head.selectNodeContents(el);
    head.setEnd(r.startContainer, r.startOffset);
    const rects = head.getClientRects();
    const last = rects.length ? rects[rects.length - 1] : null;
    if (!last || !last.height) return; // nothing laid out: stay put rather than guess
    rect = charBeforeCaret(r) === '\n'
      ? { top: last.bottom, bottom: last.bottom + last.height }
      : last;
  }
  const box = el.getBoundingClientRect();
  const M = 4; // breathing margin, matches the composer's vertical padding
  let top = el.scrollTop;
  if (rect.bottom > box.bottom - M) top += rect.bottom - (box.bottom - M);
  else if (rect.top < box.top + M) top -= (box.top + M) - rect.top;
  el.scrollTop = Math.max(0, Math.min(max, top));
}

function caretInCodeBox() {
  const sel = window.getSelection();
  if (!sel || !sel.anchorNode) return false;
  let n = sel.anchorNode;
  while (n) {
    if (n.nodeType === 1 && n.classList && n.classList.contains('ci-code')) return true;
    n = n.parentNode;
  }
  return false;
}

function insertTextAtCaret(text) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  const r = sel.getRangeAt(0);
  r.deleteContents();
  const node = document.createTextNode(text);
  r.insertNode(node);
  r.setStartAfter(node);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
}

// What main needs to find the session folder (pane cwd, else the session's own .jsonl).
const fileTarget = (pane) => ({ paneId: pane.paneId, sessionId: pane.sessionId || undefined });

function insertFileTokens(el, paths, roots) {
  if (el.disabled || !paths.length) return;
  el.focus({ preventScroll: true });
  const sel = window.getSelection();
  if (!sel.rangeCount || !el.contains(sel.anchorNode)) placeCaretEnd(el);
  const prev = charBeforeCaret(sel.getRangeAt(0));
  insertTextAtCaret(tokensText(paths, roots, prev));
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

// Attachment tray (paperclip, drop on the input): one chip per distinct path, its token fixed when the file is
// added. Every label reaches the DOM through textContent / attributes only.
const THUMB_EXT_RE = /\.(png|jpe?g|gif|webp)$/i;
const TEXT_EXT_RE = /\.(txt|md|json|js|mjs|cjs|ts|tsx|jsx|py|sh|css|html|yml|yaml|toml|csv|log|xml|kt|java|go|rs|sql)$/i;
const CHIP_EL = new WeakMap(); // attachment -> its chip, so a re-render keeps the resolved thumbnails

function addAttachments(chat, paths, roots) {
  if (chat.inputEl.disabled || !paths.length) return;
  for (const p of paths) {
    if (!chat.attachments.some((a) => a.path === p)) chat.attachments.push({ path: p, token: fileToken(p, roots) });
  }
  renderTray(chat);
  chat.inputEl.focus({ preventScroll: true });
}

function renderTray(chat) {
  for (const a of chat.attachments) if (!CHIP_EL.has(a)) CHIP_EL.set(a, chipFor(chat, a));
  chat.trayEl.replaceChildren(...chat.attachments.map((a) => CHIP_EL.get(a)));
  chat.trayEl.hidden = chat.attachments.length === 0;
}

function clearAttachments(chat) {
  chat.attachments.length = 0;
  renderTray(chat);
}

function chipFor(chat, att) {
  const chip = document.createElement('div');
  chip.className = 'cc-chip';
  chip.setAttribute('role', 'listitem');
  chip.dataset.path = att.path;
  chip.title = att.path;
  const thumb = document.createElement('span');
  thumb.className = 'cc-chip-thumb';
  const ico = lucideIcon(TEXT_EXT_RE.test(att.path) ? 'lc-file-text' : 'lc-file');
  ico.classList.add('cc-chip-ico');
  thumb.appendChild(ico);
  const name = document.createElement('span');
  name.className = 'cc-chip-name';
  name.textContent = att.path.slice(att.path.lastIndexOf('/') + 1) || att.path;
  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'cc-chip-x';
  x.setAttribute('aria-label', 'Retirer');
  x.title = 'Retirer';
  x.appendChild(lucideIcon('lc-x'));
  x.addEventListener('click', () => {
    const i = chat.attachments.indexOf(att);
    if (i < 0) return;
    chat.attachments.splice(i, 1);
    CHIP_EL.delete(att);
    renderTray(chat);
    chat.inputEl.focus({ preventScroll: true });
  });
  chip.append(thumb, name, x);
  // The miniature comes from main; no handler, a null, a rejection or a broken image keep the icon.
  if (THUMB_EXT_RE.test(att.path)) {
    Promise.resolve().then(() => window.api.attachThumb(att.path)).then((url) => {
      if (typeof url !== 'string' || !url.startsWith('data:image/') || !chat.attachments.includes(att)) return;
      const img = document.createElement('img');
      img.className = 'cc-chip-img';
      img.alt = '';
      img.addEventListener('error', () => img.replaceWith(ico));
      img.src = url;
      ico.replaceWith(img);
    }).catch(() => {});
  }
  return chip;
}

const MENTION_DEBOUNCE_MS = 120;
const MENTION_MAX_SHOWN = 20;
const MENTION_QUERY_MAX = 200; // main refuses a longer query

// The « @query » being typed at the caret, or null: a collapsed caret in a text node whose head ends
// with `@` + non-space characters, the `@` starting a word.
function mentionAtCaret(el) {
  const sel = window.getSelection();
  if (!sel || !sel.isCollapsed || !sel.anchorNode || sel.anchorNode.nodeType !== 3
    || !el.contains(sel.anchorNode) || caretInCodeBox()) return null;
  const node = sel.anchorNode;
  const end = sel.anchorOffset;
  const m = new RegExp(`(^|\\s)@([^\\s@]{0,${MENTION_QUERY_MAX}})$`).exec(node.data.slice(0, end));
  if (!m) return null;
  const start = end - m[2].length - 1;
  if (start === 0 && node.previousSibling && /\S$/.test(node.previousSibling.textContent || '')) return null;
  return { node, start, end, query: m[2] };
}

// Shared shell of the composer pickers (« @ » files, « / » commands). A picker gives the token at the caret
// (`tokenAt`), the items of a query (`load`), a row builder and the insertion (`apply`); the shell owns the
// list box, the active row, the stale-answer guard and the keyboard. It returns the handlers buildShell wires,
// in an order that matters (onKeydown before the Enter/Esc handlers, refresh after richOnInput). While the list
// is shown ↑ ↓ move, Enter / Tab insert (never send), Esc closes it before it can interrupt Claude.
function createPickerShell(chat, box, { rowClass, debounceMs, tokenAt, load, buildRow, apply, onClose }) {
  const inputEl = chat.inputEl;
  let items = [];
  let idx = 0;
  let seq = 0; // bumped on every query change and close: older answers are dropped
  let timer = 0;
  let lastQuery = null;
  let loaded = false; // the first answer of this opening has arrived: no placeholder rows after it
  let dismissed = null; // the token closed with Esc stays closed until the caret leaves it

  const setActive = (i) => {
    idx = i;
    box.querySelectorAll(`.${rowClass}`).forEach((row, k) => {
      row.classList.toggle('active', k === i);
      row.setAttribute('aria-selected', k === i ? 'true' : 'false');
      if (k !== i) return;
      const top = row.offsetTop - 4; // the box padding
      const bottom = row.offsetTop + row.offsetHeight + 4;
      if (top < box.scrollTop) box.scrollTop = top;
      else if (bottom > box.scrollTop + box.clientHeight) box.scrollTop = bottom - box.clientHeight;
    });
  };

  const render = () => {
    box.textContent = '';
    items.forEach((it, i) => {
      const row = document.createElement('div');
      row.className = rowClass;
      row.setAttribute('role', 'option');
      row.dataset.i = String(i);
      buildRow(row, it);
      box.appendChild(row);
    });
    box.hidden = items.length === 0;
    if (items.length) setActive(0);
  };

  const close = () => {
    clearTimeout(timer);
    seq++;
    lastQuery = null;
    loaded = false;
    items = [];
    box.hidden = true;
    box.textContent = '';
    if (onClose) onClose();
  };

  const search = async (query) => {
    const my = seq;
    let list = [];
    if (!loaded) { // first load of this opening: placeholder rows until the answer (render() or close() clears them)
      box.textContent = '';
      box.appendChild(skeleton(3));
      box.hidden = false;
    }
    try {
      list = await load(query);
    } catch (_) { /* no list: the picker stays closed */ }
    if (my !== seq) return;
    loaded = true;
    items = list;
    render();
  };

  const refresh = () => {
    const t = !inputEl.disabled && !chat.askPending ? tokenAt() : null;
    if (!t || (dismissed && t.node === dismissed.node && t.start === dismissed.start)) {
      if (!t) dismissed = null;
      close();
      return;
    }
    dismissed = null;
    if (t.query === lastQuery) return;
    lastQuery = t.query;
    seq++;
    clearTimeout(timer);
    timer = setTimeout(() => search(t.query), debounceMs);
  };

  const pick = (i) => {
    const it = items[i];
    const t = tokenAt();
    close();
    if (!it || !t) return;
    apply(it, t);
  };

  const onKeydown = (e) => {
    if (box.hidden || !items.length || e.isComposing || e.keyCode === 229) return;
    const plain = !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((idx + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length);
    } else if (plain && (e.key === 'Enter' || e.key === 'Tab')) {
      e.preventDefault();
      e.stopImmediatePropagation(); // the send handler registered after this one never sees it
      pick(idx);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation(); // the chat-wide Esc = interrupt Claude never sees it
      const t = tokenAt();
      dismissed = t && { node: t.node, start: t.start };
      close();
    }
  };

  // A caret move without typing (arrows, click) re-reads the token; ↑ ↓ keep the open list as it is.
  const onKeyup = (e) => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) refresh();
  };

  // mousedown is cancelled so the click keeps the focus and the caret in the composer.
  box.addEventListener('mousedown', (e) => e.preventDefault());
  box.addEventListener('click', (e) => {
    const row = e.target.closest(`.${rowClass}`);
    if (row) pick(Number(row.dataset.i));
  });
  return { onKeydown, onKeyup, refresh, close };
}

// « @ » picker: the session's files under the composer.
function createMention(pane, chat) {
  const inputEl = chat.inputEl;
  return createPickerShell(chat, chat.chatEl.querySelector('.cc-mention'), {
    rowClass: 'cm-item',
    debounceMs: MENTION_DEBOUNCE_MS,
    tokenAt: () => mentionAtCaret(inputEl),
    load: async (query) => { // [{ rel, dir }]
      let list = [];
      if (query) {
        const res = await window.api.filesSearch(fileTarget(pane), query);
        if (res && res.ok) list = res.results;
      } else {
        const res = await window.api.filesList(fileTarget(pane), '');
        if (res && res.ok) list = res.entries.map((e) => ({ rel: e.name, dir: e.dir }));
      }
      if (query) {
        const q = query.toLowerCase();
        const rank = (it) => {
          const b = it.rel.slice(it.rel.lastIndexOf('/') + 1).toLowerCase();
          return b.startsWith(q) ? 0 : b.includes(q) ? 1 : 2;
        };
        list = list.slice().sort((a, b) => rank(a) - rank(b)); // stable: the search order breaks ties
      }
      return list.slice(0, MENTION_MAX_SHOWN);
    },
    buildRow: (row, it) => {
      const cut = it.rel.lastIndexOf('/');
      const base = document.createElement('span');
      base.className = 'cm-base';
      base.textContent = it.rel.slice(cut + 1) + (it.dir ? '/' : '');
      const dir = document.createElement('span');
      dir.className = 'cm-dir';
      dir.textContent = cut > 0 ? it.rel.slice(0, cut) : '';
      row.append(lucideIcon(it.dir ? 'lc-folder' : 'lc-file'), base, dir);
    },
    apply: (it, t) => {
      const r = document.createRange();
      r.setStart(t.node, t.start);
      r.setEnd(t.node, t.end);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r); // the typed « @query » is replaced by the inserted token
      insertFileTokens(inputEl, [it.dir ? `${it.rel}/` : it.rel], []);
    },
  });
}

const SLASH_TOKEN_MAX = 80;

// The « /token » being typed: a collapsed caret in the composer's FIRST text, whose head reads `/` + non-space
// characters, with nothing before it (no text, file token or line break): a « / » elsewhere opens nothing.
function slashAtCaret(el) {
  const sel = window.getSelection();
  if (!sel || !sel.isCollapsed || !sel.anchorNode || sel.anchorNode.nodeType !== 3
    || !el.contains(sel.anchorNode) || caretInCodeBox()) return null;
  const node = sel.anchorNode;
  const end = sel.anchorOffset;
  const m = new RegExp(`^/(\\S{0,${SLASH_TOKEN_MAX}})$`).exec(node.data.slice(0, end));
  if (!m) return null;
  for (let n = node; n !== el; n = n.parentNode) {
    for (let s = n.previousSibling; s; s = s.previousSibling) {
      if (s.nodeType === 1 || (s.nodeType === 3 && s.data)) return null;
    }
  }
  return { node, start: 0, end, query: m[1] };
}

// « / » picker: the commands the session accepts (`commandsList`), filtered by name prefix while typed.
function createSlashPicker(pane, chat) {
  const inputEl = chat.inputEl;
  let all = null; // the IPC answer, read once per opening
  return createPickerShell(chat, chat.chatEl.querySelector('.slash-pop'), {
    rowClass: 'sp-item',
    debounceMs: 0,
    tokenAt: () => slashAtCaret(inputEl),
    onClose: () => { all = null; },
    load: async (query) => {
      all = all || window.api.commandsList(pane.paneId).then((l) => (Array.isArray(l) ? l : []), () => []);
      const q = `/${query}`.toLowerCase();
      return (await all).filter((c) => c.name.toLowerCase().startsWith(q));
    },
    buildRow: (row, c) => {
      for (const [cls, text] of [['sp-name', c.name], ['sp-args', c.args], ['sp-desc', c.desc]]) {
        const span = document.createElement('span');
        span.className = cls;
        span.textContent = text || '';
        row.appendChild(span);
      }
    },
    apply: (c, t) => { // the typed token becomes `/name `, the caret after it; nothing is sent
      t.node.replaceData(t.start, t.end - t.start, `${c.name} `);
      window.getSelection().collapse(t.node, t.start + c.name.length + 1);
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    },
  });
}

// The caret write focuses a contenteditable, so a composer that must not take the focus is written without it.
function setRichValueQuiet(el, v) {
  renderEditorDom(el, v);
  el._sig = sigOf(v);
  el.classList.toggle('is-empty', v.length === 0);
}

function setRichValue(el, v) {
  setRichValueQuiet(el, v);
  placeCaretEnd(el);
  revealCaret(el);
}

// Live boxing: recompute the value, toggle the placeholder, and ONLY re-render
// (caret -> end) when a block formed or dissolved. Typing inside text or a box
// keeps the same signature -> no re-render -> the native caret is preserved.
function richOnInput(el) {
  const v = domToValue(el);
  el.classList.toggle('is-empty', v.length === 0);
  const sig = sigOf(v);
  if (sig !== el._sig) {
    el._sig = sig;
    renderEditorDom(el, v);
    placeCaretEnd(el);
  }
  // every programmatic insert (Shift+Enter, paste, drop) re-fires 'input'
  // right after insertTextAtCaret, so this one call covers all of them.
  revealCaret(el);
}

// Make the contenteditable div quack like the old textarea for the send chain.
function installRichInput(el) {
  el._disabled = false;
  el._sig = '';
  el.classList.add('is-empty');
  Object.defineProperty(el, 'value', {
    configurable: true,
    get() { return domToValue(this); },
    set(v) { setRichValue(this, v == null ? '' : String(v)); },
  });
  Object.defineProperty(el, 'disabled', {
    configurable: true,
    get() { return this._disabled; },
    set(d) {
      this._disabled = !!d;
      this.setAttribute('contenteditable', d ? 'false' : 'true');
      this.classList.toggle('is-disabled', !!d);
    },
  });
  Object.defineProperty(el, 'placeholder', {
    configurable: true,
    get() { return this.dataset.placeholder || ''; },
    set(v) { this.dataset.placeholder = v == null ? '' : String(v); },
  });
}

// ---------------------------------------------------------------------------
// Review block prettifier — the user's Stop hook appends a review block as
// HTML comments; markdownit (html:false) escapes them into raw text soup.
// PURE PRESENTATION: lift the block out of the markdown and render a compact
// chip card instead (the hook and the transcript stay untouched).
// ---------------------------------------------------------------------------

const REVIEW_RE = /<!--\s*review-final\s*-->([\s\S]*?)<!--\s*\/review-final\s*-->/;

// B9: per-response copy button. Payloads reach the reader cap
// (TEXT_CAP=20000 per block, transcript.js) so they live in a WeakMap keyed by
// the button — never in a DOM attribute.
const COPY_SOURCES = new WeakMap();
const COPY_TIMERS = new WeakMap();
const COPY_LABEL = 'Copier la réponse';
// Blocks arrive already capped upstream; a capped turn must say so in the
// copied text rather than hand over a silently amputated answer.
const COPY_TRUNCATED = '\n\n[réponse tronquée]';
// Static markup only (no transcript data) -> innerHTML is safe here, same
// contract as sidebar.js SICON_SVG.
const COPY_ICON_SVG = '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5"/></svg>';

// Lift the review block (Stop hook format) out of the prose. ONE source of
// truth for both the rendered markdown and the copy payload — the button must
// hand over exactly what the reader sees.
function stripReview(raw) {
  let text = raw;
  let reviewInner = null;
  const rv = REVIEW_RE.exec(text);
  if (rv) {
    reviewInner = rv[1];
    text = text.replace(REVIEW_RE, '').trimEnd();
  } else {
    // v46.2: a tail truncated by the reader cap can cut the closing marker
    // — the raw comment soup must still never reach the markdown (live
    // screenshot repro). Lift everything from the opening marker on.
    const open = text.indexOf('<!-- review-final -->');
    if (open !== -1) {
      reviewInner = text.slice(open + '<!-- review-final -->'.length);
      text = text.slice(0, open).trimEnd();
    }
  }
  return { text, reviewInner };
}

function renderReviewCard(inner) {
  const el = document.createElement('div');
  el.className = 'chat-review';
  const head = document.createElement('div');
  head.className = 'chat-review-head';
  const mk = (cls, label) => {
    const s = document.createElement('span');
    s.className = 'cr-chip ' + cls;
    s.textContent = label;
    return s;
  };
  const tier = inner.match(/Tier\s*(\d+)\s*\|\s*Scope:\s*(\w+)\s*\|\s*Severity:\s*(\w+)/);
  if (tier) {
    head.appendChild(mk('cr-tier', `Tier ${tier[1]}`));
    head.appendChild(mk(tier[2] === 'HIGH' ? 'cr-high' : 'cr-low', `Scope ${tier[2]}`));
    head.appendChild(mk(tier[3] === 'HIGH' ? 'cr-high' : 'cr-low', `Severity ${tier[3]}`));
  } else {
    head.appendChild(mk('cr-tier', 'Review'));
  }
  el.appendChild(head);
  const cl = inner.match(/<!--\s*checklist\s*-->([\s\S]*?)<!--\s*\/checklist\s*-->/);
  if (cl) {
    const items = cl[1].split(/[|\n]/).map((s) => s.trim()).filter((s) => s.includes('='));
    const yes = items.filter((s) => s.endsWith('=yes')).length;
    const det = document.createElement('details');
    det.className = 'chat-review-detail';
    const sum = document.createElement('summary');
    sum.textContent = yes ? `Checklist — ${yes} à yes` : 'Checklist — tout à no';
    det.appendChild(sum);
    const grid = document.createElement('div');
    grid.className = 'chat-review-grid';
    for (const it of items) {
      const eq = it.lastIndexOf('=');
      const isYes = it.slice(eq + 1) === 'yes';
      const chip = document.createElement('span');
      chip.className = 'cr-item' + (isYes ? ' cr-item-yes' : '');
      chip.textContent = it.slice(0, eq).replace(/^(scope|sev):/, '') + (isYes ? ' ✓' : '');
      grid.appendChild(chip);
    }
    det.appendChild(grid);
    el.appendChild(det);
  }
  return el;
}

// ---------------------------------------------------------------------------
// Shell + per-pane chat state (pane.chat — created on first toggle, dropped
// by teardownChatView on closePane).
// ---------------------------------------------------------------------------

// The context meter lives in the session header's .ph-ctx host, outside .pane-chat: one node per
// pane (an existing one is reused, never duplicated), removed by teardownChatView.
function mountCtxMeter(pane) {
  const host = pane.el.querySelector('.ph-ctx');
  if (!host) return null;
  let el = host.querySelector('.chat-ctx');
  if (el) { el.hidden = true; return el; } // no data yet for this chat view (rule #7)
  el = document.createElement('div');
  el.className = 'chat-ctx';
  el.hidden = true;
  el.innerHTML = `
    <span class="cc-ctx-label">Contexte</span>
    <span class="cc-ctx-pct"></span>
    <span class="cc-ctx-bar" aria-hidden="true"><i class="cc-ctx-fill"></i></span>
    <span class="cc-ctx-sep" hidden>&middot;</span>
    <span class="cc-ctx-nums" hidden></span>`;
  host.appendChild(el);
  return el;
}

function buildShell(pane) {
  const chatEl = pane.el.querySelector('.pane-chat');
  chatEl.innerHTML = `
    <div class="chat-body">
      <div class="chat-scroll" tabindex="0"><div class="chat-fold-row" style="display:none"><button type="button" class="chat-fold-all">Tout plier</button></div><div class="chat-stream"></div></div>
      <button class="chat-jump" title="Aller au dernier message" hidden>&#8595;</button>
    </div>
    <div class="chat-activity" hidden>
      <span class="ca-ico"></span><span class="ca-label"></span>
      <span class="ca-detail"></span>
      <span class="ca-dots"><i></i><i></i><i></i></span>
      <span class="ca-timer"></span>
    </div>
    <div class="chat-tasks" hidden>
      <span class="ctk-head">T&acirc;ches <span class="ctk-caret" hidden></span></span>
      <div class="ctk-list" hidden></div>
    </div>
    <div class="chat-queue" hidden>
      <div class="chat-queue-head"></div>
      <div class="chat-queue-list"></div>
    </div>
    <div class="chat-goal-footer" hidden>
      <span class="cgf-ico">&#9678;</span>
      <span class="cgf-label">Goal actif</span>
      <span class="cgf-text"></span>
      <span class="cgf-timer"></span>
      <button class="cgf-close" title="Terminer le goal (envoie /goal clear)">&#10005;</button>
    </div>
    <div class="chat-ask" hidden>
      <div class="chat-ask-head">
        <span class="cak-ico"></span><span class="cak-label"></span>
        <span class="cak-q"></span>
      </div>
      <div class="chat-ask-overview" hidden>
        <div class="cov-title"></div>
        <div class="cov-list"></div>
      </div>
      <div class="chat-ask-opts"></div>
      <div class="chat-ask-preview" hidden>
        <div class="cap-head"></div>
        <div class="cap-body"></div>
      </div>
      <div class="chat-ask-keys">
        <button class="cak-esc" title="&Eacute;chap — refuser / fermer le menu">Esc</button>
        <button class="cak-enter" title="Envoyer Entr&eacute;e au terminal (valider une saisie ou un multi-choix)">&#9166; Valider</button>
      </div>
    </div>
    <div class="ask-slot"></div>
    <div class="chat-composer">
      <div class="chat-slash-warn" hidden></div>
      <div class="chat-input-wrap">
        <div class="cc-tray" role="list" aria-label="Pi&egrave;ces jointes" hidden></div>
        <div class="cc-drop" hidden>D&eacute;poser pour joindre</div>
        <div class="chat-input" contenteditable="true" role="textbox" aria-multiline="true"
          data-placeholder="&Eacute;cris &agrave; Claude&hellip; @ fichiers, / commandes"></div>
        <div class="chat-input-bar">
          <div class="cc-mode-dd">
            <button class="cc-mode-btn"
              title="Mode de permissions — d&eacute;tection best-effort du libell&eacute; TUI (Shift+Tab dans le terminal)">
              <span class="cc-mode-label" data-mode="normal">normal</span><span class="dd-chev">&#9662;</span>
            </button>
            <div class="cc-mode-menu" hidden>
              <button class="cc-mode-item" data-mode="normal">normal</button>
              <button class="cc-mode-item" data-mode="accept-edits">auto-accept</button>
              <button class="cc-mode-item" data-mode="plan">plan</button>
              <button class="cc-mode-item" data-mode="auto"
                title="Z&eacute;ro prompt de permission &mdash; un classifieur de s&eacute;curit&eacute; v&eacute;rifie chaque action en arri&egrave;re-plan (opt-in &agrave; la premi&egrave;re activation)">auto</button>
            </div>
          </div>
          <div class="cc-model-dd" hidden>
            <button class="cc-model-btn" type="button"
              title="Mod&egrave;le de la session &mdash; cliquer pour changer. Lance /model &lt;alias&gt; dans cette session ; Claude Code peut l'enregistrer comme mod&egrave;le par d&eacute;faut global.">
              <span class="cc-model-label" hidden></span><span class="dd-chev">&#9662;</span>
            </button>
            <div class="cc-model-menu" hidden>
              ${MODEL_CHOICES.map((c) => `<button class="cc-model-item" type="button" data-model="${c.id}">${c.label}</button>`).join('\n              ')}
            </div>
          </div>
          <div class="cc-effort-dd" hidden>
            <button class="cc-effort-btn" type="button"
              title="Effort de la session &mdash; cliquer pour changer. Lance /effort &lt;niveau&gt; dans cette session. Claude Code garde ce niveau comme d&eacute;faut du mod&egrave;le, sauf max (session seule).">
              <span class="cc-effort-label"></span><span class="dd-chev">&#9662;</span>
            </button>
            <div class="cc-effort-menu" hidden>
              ${EFFORT_CHOICES.map((l) => `<button class="cc-effort-item" type="button" data-effort="${l}">${l}</button>`).join('\n              ')}
            </div>
          </div>
          <span class="cc-spacer"></span>
          <button class="cc-attach" type="button" title="Joindre des fichiers" aria-label="Joindre des fichiers"></button>
          <button class="cc-more" type="button" aria-haspopup="menu" aria-expanded="false" aria-label="Plus d'actions"
            title="Plus d'actions &mdash; Goal, Compacter, Clear, Room lead"></button>
          <button class="chat-send"
            title="Envoyer (Entr&eacute;e). La saisie passe par le PTY, comme au clavier. Les /commandes passent aussi.">
            <svg class="ic-stop" width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
              <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" fill="currentColor"/>
            </svg>
          </button>
          <div class="cc-menu" role="menu" aria-label="Plus d'actions" hidden>
            <button class="cc-goal" role="menuitem" aria-pressed="false" title="Mode goal &mdash; quand allum&eacute;, ton prochain message part comme /goal &lt;objectif&gt;. Re-clic pour annuler.">
              <span>Goal</span><small>/goal</small>
            </button>
            <button class="cc-compact" role="menuitem" title="Compacter la conversation — r&eacute;sume l'historique et lib&egrave;re du contexte">
              <span>Compacter</span><small>/compact</small>
            </button>
            <button class="cc-clear" role="menuitem" title="Effacer la conversation &mdash; envoie /clear pour repartir d'un contexte vierge (l'historique de la session est vid&eacute;).">
              <span>Clear</span><small>/clear</small>
            </button>
            <hr>
            <button class="cc-roomlead" role="menuitem" title="Charger le skill room-lead &mdash; instructions pour orchestrer les sessions worker via la Room (envoie /room-lead).">
              <span>Room lead</span><small>/room-lead</small>
            </button>
          </div>
        </div>
        <div class="cc-mention" role="listbox" aria-label="Fichiers de la session" hidden></div>
        <div class="slash-pop" role="listbox" aria-label="Commandes" hidden></div>
      </div>
    </div>`;
  // Toolbar icons: one sprite node before each chip label, the arrow first in the send button.
  const CHIP_ICONS = {
    '.cc-mode-btn': 'lc-gauge', '.cc-model-btn': 'lc-cpu', '.cc-effort-btn': 'lc-brain', '.cc-goal': 'lc-target',
    '.cc-compact': 'lc-layers', '.cc-clear': 'lc-eraser', '.cc-roomlead': 'lc-message-square',
    '.cc-attach': 'lc-paperclip', '.cc-more': 'lc-ellipsis',
  };
  for (const [sel, id] of Object.entries(CHIP_ICONS)) {
    const btn = chatEl.querySelector(sel);
    const ico = lucideIcon(id);
    ico.classList.add('cc-ico');
    btn.insertBefore(ico, btn.firstChild);
  }
  const sendIco = lucideIcon('lc-arrow-up');
  sendIco.classList.add('ic-send');
  chatEl.querySelector('.chat-send').insertBefore(sendIco, chatEl.querySelector('.ic-stop'));
  const scrollEl = chatEl.querySelector('.chat-scroll');
  const streamEl = chatEl.querySelector('.chat-stream');
  const jumpEl = chatEl.querySelector('.chat-jump');
  const foldAllEl = chatEl.querySelector('.chat-fold-all');
  const inputEl = chatEl.querySelector('.chat-input');
  installRichInput(inputEl);
  const sendEl = chatEl.querySelector('.chat-send');
  const chat = {
    chatEl, scrollEl, streamEl, jumpEl, inputEl, sendEl, foldAllEl,
    attachBtn: chatEl.querySelector('.cc-attach'),
    trayEl: chatEl.querySelector('.cc-tray'),
    attachments: [], // [{ path, token }] — the composer's file chips; the tokens are appended to the next message
    activityEl: chatEl.querySelector('.chat-activity'),
    tasksEl: chatEl.querySelector('.chat-tasks'), // v69: persistent bg-agent roster mount
    bgAgents: new Map(), // v69: toolUseId -> { agentType, summary, done } — PERSISTENT background/async roster for the pinned « Tâches » section; survives the per-turn turnAgents wipe + the idle strip-hide, reaped on real completion (agentDone) then on the next user message
    bgShells: new Map(), // toolUseId -> { summary, taskId } — background Bash shells known to run (live clean result); shown in the activity strip, ended by agentDone / a matching TaskStop, kept across a chat reset, cleared at closed
    agentSeq: new Map(), // L5: toolUseId -> last agentState seq applied (a row-less event is ordered too); cleared by the reset rebuild
    resumeOf: new Map(), // L5: SendMessage resume call id -> the dispatch id of the agent it resumed (learned on live and replayed results)
    bgShellCalls: new Map(), // toolUseId -> summary — background Bash launches whose result has not arrived yet
    agentInfoById: new Map(), // v80: agentId -> { agentType, summary } learned from each async-launch ACK (replay included), so a SendMessage resume of that agent is labelled with its type; rebuilt with the view
    tasksTreeCollapsed: null, // v70: the « Tâches » roster folds by DEFAULT (mirror the activity working-tree). null = auto-folded; true/false = an explicit header click, held across turns (the roster itself persists across turns).
    queueEl: chatEl.querySelector('.chat-queue'),
    askEl: chatEl.querySelector('.chat-ask'), // v46: TUI menu mirror panel
    compactBtn: chatEl.querySelector('.cc-compact'), // v46.9.8: /compact trigger
    clearBtn: chatEl.querySelector('.cc-clear'), // /clear trigger (rest-only, mirrors compact)
    slashWarnEl: chatEl.querySelector('.chat-slash-warn'), // the slash-command notice banner (showSlashNotice)
    goalBtn: chatEl.querySelector('.cc-goal'), // v49: /goal trigger (rest-only, like compact)
    moreBtn: chatEl.querySelector('.cc-more'), // « ⋯ » trigger of the secondary actions (data-goal="on" while goal is armed)
    menuEl: chatEl.querySelector('.cc-menu'), // the menu holding Goal, Compacter, Clear, Room lead
    moreOpen: false,
    goalArmed: false, // v49: when true, the NEXT composer send goes out as « /goal <msg> »
    goalFooterEl: chatEl.querySelector('.chat-goal-footer'), // v50: « Goal actif » strip
    goalActive: false, // v50: a /goal Stop hook is in force for this session
    goalText: '', // v50: the active goal's condition text
    goalSince: 0, // v50: ms epoch the goal was set (elapsed base)
    goalTicking: false, // v50: the goal footer's elapsed text rides the shared 1s ticker (tickStart/tickStop)
    ctxEl: mountCtxMeter(pane), // v47: context-window meter, hosted by the session header
    modeBadgeEl: chatEl.querySelector('.cc-mode-label'),
    modelEl: chatEl.querySelector('.cc-model-label'), // v66: session model (v72: inside the picker button)
    modelDdEl: chatEl.querySelector('.cc-model-dd'), // v72: picker wrapper — hidden with the label
    modelMenuEl: chatEl.querySelector('.cc-model-menu'), // v72: model dropdown items
    effortDdEl: chatEl.querySelector('.cc-effort-dd'), // effort picker wrapper — hidden while the level is unknown
    effortEl: chatEl.querySelector('.cc-effort-label'), // session effort, the level the statusline pushed
    effortMenuEl: chatEl.querySelector('.cc-effort-menu'),
    effortLevel: null, // last pushed level (null = unknown)
    effortPendingTimer: null, // EFFORT_PENDING_MS expiry of an armed pick (null = nothing armed)
    modelPendingFromId: null, // v72: model seen when « /model » was fired (null = no pick in flight)
    modelPendingTimer: null, // v72: MODEL_PENDING_MS fallback that drops the hint
    modeMenuEl: chatEl.querySelector('.cc-mode-menu'), // v46.1: dropdown items
    modeCycling: false, // v46.1: cycleToMode in flight (re-entrance guard)
    modeUnreachable: new Set(), // v46.2: targets a full lap never found (e.g. auto not eligible)
    phantomSince: null, // v46.3: first scan where status said busy but the TUI sat idle
    phantomBgSince: null, // start of the current continuous background-only phantom stretch (reconcilePhantomBusy, PHANTOM_BG_CONFIRM_MS clock)
    stopRequested: 0, // v46.9.3: ms epoch of the user's own Esc/stop (chat face) — optimistic UI + reconcile fast-track + rage-press swallow
    stopEpoch: 0, // R9 (T2 review F1, 2026-09-24): monotonic counter bumped on every interrupt — unlike stopRequested/dirtyAfterStop it is never reset/consumed by a later sendNow or idle push, so a retry check can still prove a stop happened for ITS send
    reclaimId: null, // v53: deferred « reclaim a stranded send » timer (interrupt path)
    sendChain: Promise.resolve(), // v55: serializes the pty paste+CR of rapid sends (anti-interleave)
    dirtyAfterStop: false, // v57: the TUI may hold Claude Code's restored prompt after an interrupt -> the next send must hard-clear (Ctrl+C) before pasting
    toolIndex: new Map(), // tool_use id -> card element
    reportCards: new Map(), // v81: tool_use id -> { kind:'agent'|'send', waiting, done } — the cards entitled to a sub-agent's final report
    agentReports: new Map(), // v81: agentId -> { queue, seen, waiting } — unconsumed final reports and the cards still owed one
    turn: null, // { role, body } — current speaker group
    pendingSends: [], // [{ text, el }] — optimistic echoes awaiting the tail (UNCONFIRMED only)
    turnCommitted: false, // v62: did THIS turn already promote an echo on Claude output? (re-armed at idle) — one confirm per turn, oldest first
    queue: [], // [{ text }] — v44: messages waiting for claude to finish
    lastStatus: null, // last live status push for this session (null = unknown)
    // v45 activity: the transcript names WHAT runs (open tool_use without a
    // result yet), the status pushes only say WHETHER claude runs.
    openTools: new Map(), // tool_use id -> { name, agentType, summary }
    workSince: null, // ms epoch — start of the current turn (live timer base)
    stripTicking: false, // the strip's elapsed text rides the shared 1s ticker, only while the strip shows
    tasksReapId: null, // v71: low-freq interval, alive only while the bg roster is non-empty (idle backstop)
    settleId: null, // settle fallback timeout (final text + no open tool)
    settled: false, // settle fired: hide the strip despite a stale busy status
    drainRecheckId: null, // deferred drain when an idle push looked suspect
    idleRecheckId: null, // v46.4: idle push refused on a busy screen — replay later
    idleArbitrated: false, // v46.4: replay verdict reached — skip the arbiter once
    lastBusyScreen: 0, // v46.4: last scan that SAW the live spinner (blink memory)
    lastPtyData: 0, // v46.4: last raw PTY output — a running turn never goes silent
    hadOpenToolsAtQuiet: false, // ledger state captured at the quiet push
    askSig: null, // v46: signature of the mirrored menu (skip identical re-renders)
    askOverviewKey: null, // v79: (tool id, askQuestions.length, current idx|'recap'|'none') — skip identical overview rebuilds
    askCurrentQIndex: -1, // v79: current question's index into askQuestions, or -1 (none/recap) — A4 preview scoping reads this
    askPolling: false, // v46: registered on the shared TUI poll — true only while the chat face shows
    ptySeq: 0, // bumped on every raw PTY chunk (cvNotifyPtyData) — the poll scans only when it moved
    scanSeq: 0, // ptySeq as of the last scanAsk
    lastScanAt: 0, // ms epoch of the last scanAsk (slow-fallback base)
    dataScanId: null, // v46: debounced scan on raw PTY output (menu just drew)
    compacting: false, // v46.9.8: deck-driven /compact in flight — owns busy until compact_boundary/cancel
    compactTimeoutId: null, // safety net: never strand the optimistic busy state
    slashWarnId: null, // auto-hide timer for the slash-command notice banner
    slashSending: false, // sendSlash is reading the command list: a second Enter meanwhile is ignored
    context: null, // v47: last session-context { used_percentage, used_tokens, window }
    askPending: false, // question drawer owns the composer (its « Autre » field) while a request is pending
    askDraft: '', // composer text parked while askPending
    askPlaceholder: '', // composer placeholder parked while askPending
    askPlaceholderSet: '', // last placeholder the drawer set (restore only if nothing else replaced it)
    askQKey: '', // question whose « Autre » text the composer shows (drawer snapshot qKey)
    askUnmount: null, // mountAskHost's unmount, released by teardownChatView
    askUnsub: null, // onAskHostChange's unsubscribe, released by teardownChatView
    atBottom: true,
    scrollRO: null, // ResizeObserver of the scroller: re-pins while atBottom, disconnected by teardownChatView
  };
  chat.askUnmount = mountAskHost(pane.paneId, 'chat', chatEl.querySelector('.ask-slot'));
  chat.askUnsub = onAskHostChange(pane.paneId, (snap) => applyAskHost(chat, snap));
  // Stick-to-bottom: follow the live tail unless the user scrolled away;
  // the jump pill brings them back (same reflex as every chat UI).
  scrollEl.addEventListener('scroll', () => {
    chat.atBottom = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 48;
    jumpEl.hidden = chat.atBottom;
  }, { passive: true });
  jumpEl.addEventListener('click', () => scrollBottom(chat));
  // The strips under the stream (activity row, tasks, queue) take height from the scroller when they
  // appear: scrollTop stays, so no scroll event fires and the tail (the user's band, its bottom padding)
  // is left cut. A pinned reader is re-pinned on the size change itself; a reader scrolled away is not.
  chat.scrollRO = new ResizeObserver(() => { if (chat.atBottom) scrollBottom(chat); });
  chat.scrollRO.observe(scrollEl);
  // Rendered markdown links: same policy as the plans panel — never navigate
  // (main also blocks will-navigate/window.open; this kills the visual jump).
  streamEl.addEventListener('click', (e) => {
    const a = e.target.closest('a');
    if (a) e.preventDefault();
    const fileLink = e.target.closest('.cv-file-link');
    if (fileLink) {
      e.preventDefault();
      openFileLink(pane, fileLink);
      return;
    }
    const head = e.target.closest('.chat-tool-head');
    if (head) { toggleToolCard(chat, head); return; }
    const turnHead = e.target.closest('.t-assistant > .chat-turn-head');
    if (turnHead) toggleTurn(chat, turnHead);
  });
  foldAllEl.addEventListener('click', () => foldAll(chat));
  // The head is a button (role + tabindex): Enter / Space fold it too. Only the head itself,
  // never a control nested in it (the agent chip has its own handler).
  streamEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    if (e.target.classList.contains('cv-file-link')) {
      e.preventDefault(); // also stops the native Enter -> click on an <a>
      openFileLink(pane, e.target);
      return;
    }
    if (e.target.classList.contains('chat-tool-head')) {
      e.preventDefault();
      toggleToolCard(chat, e.target);
    } else if (e.target.matches('.t-assistant > .chat-turn-head')) {
      e.preventDefault();
      toggleTurn(chat, e.target);
    }
  });
  // Composer: Enter sends; Shift/Ctrl/Alt+Enter insert the newline
  // OURSELVES (user repro: the native Shift+Enter keypress→insertLineBreak
  // mapping can be swallowed upstream on Linux layouts/IMEs — the keydown
  // always arrives, the default insertion doesn't; Ctrl/Alt+Enter are the
  // TUI reflexes and had no default at all). execCommand keeps the undo
  // stack; the manual fallback (deprecated-API insurance) re-fires 'input'
  // for the autosize but does NOT join the native undo stack — accepted.
  // « @ » picker: its keydown is registered FIRST, so Enter / Tab / Esc reach it before the send handler below.
  const mention = createMention(pane, chat);
  inputEl.addEventListener('keydown', mention.onKeydown);
  const slash = createSlashPicker(pane, chat); // « / » picker: same place, never open together with the « @ » one
  inputEl.addEventListener('keydown', slash.onKeydown);
  // v59: Enter sends; Shift/Ctrl/Alt+Enter OR Enter inside a code box inserts a
  // newline (so multi-line blocks stay editable). IME guard keeps CJK/dead-key
  // composition intact (Enter there COMMITS the candidate).
  inputEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    if (e.shiftKey || e.ctrlKey || e.altKey || caretInCodeBox()) {
      insertTextAtCaret('\n');
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      sendMessage(pane);
    }
  });
  // v59: paste as PLAIN text only — keeps the contenteditable DOM clean (no
  // foreign spans/divs) so domToValue stays deterministic. A pasted ``` block
  // boxes on the next input tick.
  inputEl.addEventListener('paste', (e) => {
    e.preventDefault();
    const cd = e.clipboardData || window.clipboardData;
    const text = cd ? cd.getData('text/plain') : '';
    insertTextAtCaret(text);
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
  });
  // Files: the whole composer is the drop surface (one owner); the input keeps only the text branch.
  const composerEl = chatEl.querySelector('.chat-composer');
  const dropEl = composerEl.querySelector('.cc-drop');
  const dropHint = (on) => { dropEl.hidden = !on; composerEl.classList.toggle('is-drop-target', on); };
  const onDragFiles = (e) => {
    if (!dragHasFiles(e) || inputEl.disabled) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    dropHint(true);
  };
  composerEl.addEventListener('dragenter', onDragFiles);
  composerEl.addEventListener('dragover', onDragFiles);
  composerEl.addEventListener('dragleave', (e) => { if (!composerEl.contains(e.relatedTarget)) dropHint(false); });
  composerEl.addEventListener('drop', (e) => {
    dropHint(false);
    if (inputEl.disabled) return;
    const paths = droppedPaths(e);
    if (!paths.length) return;
    e.preventDefault();
    window.api.attachRoots(fileTarget(pane))
      .catch(() => [])
      .then((roots) => addAttachments(chat, paths, roots));
  });
  inputEl.addEventListener('dragover', (e) => { e.preventDefault(); });
  inputEl.addEventListener('drop', (e) => {
    e.preventDefault();
    if (inputEl.disabled) return; // v59: drop-disabled parity with paste (a disabled composer must not take input)
    if (droppedPaths(e).length) return; // files: the composer handler owns them
    const text = e.dataTransfer ? e.dataTransfer.getData('text/plain') : '';
    const at =document.caretRangeFromPoint ? document.caretRangeFromPoint(e.clientX, e.clientY) : null;
    if (at) { const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(at); }
    insertTextAtCaret(text);
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
  });
  inputEl.addEventListener('input', () => richOnInput(inputEl));
  inputEl.addEventListener('input', () => askComposerInput(pane.paneId, inputEl.value));
  inputEl.addEventListener('input', mention.refresh); // after richOnInput: the DOM is final when the caret is read
  inputEl.addEventListener('keyup', mention.onKeyup);
  inputEl.addEventListener('mouseup', mention.refresh);
  inputEl.addEventListener('focusout', mention.close);
  inputEl.addEventListener('input', slash.refresh);
  inputEl.addEventListener('keyup', slash.onKeyup);
  inputEl.addEventListener('mouseup', slash.refresh);
  inputEl.addEventListener('focusout', slash.close);
  // Paperclip: native picker opened in the session folder; cancel or failure attaches nothing.
  chat.attachBtn.addEventListener('click', async () => {
    if (inputEl.disabled) return;
    try {
      const { paths, roots } = await window.api.pickFiles(fileTarget(pane));
      addAttachments(chat, paths, roots);
    } catch (_) { /* dialog failed: nothing to attach */ }
  });
  // v46.1 (claude.ai-style): one button, two states — send when quiet, STOP
  // (Esc to the TUI) while claude works. Enter still queues during busy.
  sendEl.addEventListener('click', () => {
    if (sendEl.classList.contains('is-stop')) interruptClaude(pane);
    else sendMessage(pane);
  });
  // v46.9.8: the compact button drives a deck-managed /compact (busy state,
  // queue, stop — all reuse the normal turn machinery; cancel = Esc/stop).
  const compactBtn = chatEl.querySelector('.cc-compact');
  if (compactBtn) compactBtn.addEventListener('click', () => startCompact(pane));
  // /clear — a sibling fire-button to /compact: injects « /clear » into THIS
  // pane's PTY (rest-only, double-click guarded). No optimistic UI reset — the
  // transcript reader stays the source of truth for the cleared view.
  const clearBtn = chatEl.querySelector('.cc-clear');
  if (clearBtn) clearBtn.addEventListener('click', () => startClear(pane));
  // v64: /room-lead — a dedicated fire-button (like /compact) that loads the
  // lead-orchestration skill. Typed in the composer it goes through sendSlash
  // like any listed command; the button skips the command-list lookup.
  const roomLeadBtn = chatEl.querySelector('.cc-roomlead');
  if (roomLeadBtn) roomLeadBtn.addEventListener('click', () => sendRoomLead(pane));
  // v49: /goal — the 🎯 button ARMS goal mode: the next composer send is
  // prefixed « /goal » (no separate field; the normal input is reused).
  const goalBtn = chatEl.querySelector('.cc-goal');
  if (goalBtn) goalBtn.addEventListener('click', () => toggleGoalArm(pane));
  // « ⋯ » menu: the trigger toggles it; a click on an item runs the item's own handler (bound above, it fires
  // first), then this listener closes the menu and hands the focus to the composer if it was left on the item.
  if (chat.moreBtn && chat.menuEl) {
    chat.moreBtn.addEventListener('click', () => (chat.moreOpen ? closeComposerMenu(chat, true) : openComposerMenu(chat)));
    chat.menuEl.addEventListener('click', (e) => {
      if (!e.target.closest('[role="menuitem"]')) return;
      const left = chat.menuEl.contains(document.activeElement);
      closeComposerMenu(chat, false);
      if (left && !chat.inputEl.disabled) chat.inputEl.focus({ preventScroll: true });
    });
    bindComposerMenuGlobals();
  }
  const goalClose = chatEl.querySelector('.cgf-close'); // v50: ✕ ends the active goal
  if (goalClose) goalClose.addEventListener('click', () => endGoal(pane));
  // v51: the footer goal text ellipsises to one line — clicking it toggles the
  // full multi-line view. Bound on .cgf-text (not the strip) so the ✕ keeps its
  // own click; toggles .expanded on the footer element.
  const goalTextEl = chatEl.querySelector('.cgf-text');
  if (goalTextEl) {
    goalTextEl.title = 'Cliquer pour afficher / replier le goal complet';
    goalTextEl.addEventListener('click', () => {
      if (!window.getSelection().isCollapsed) return; // v51: keep text selection/copy intact
      chat.goalFooterEl.classList.toggle('expanded');
    });
  }
  // v70: « Tâches » roster folds by default, same interaction as the activity
  // working-tree above — a header click toggles, clicks INSIDE the list keep a
  // row inspectable. The default (null) resolves to folded in refreshTasks.
  chat.tasksEl.addEventListener('click', (e) => {
    if (e.target.closest('.ctk-list')) return;
    if (!chat.bgAgents.size) return;
    const effective = chat.tasksTreeCollapsed === null
      ? true
      : chat.tasksTreeCollapsed;
    chat.tasksTreeCollapsed = !effective;
    refreshTasks(chat);
  });
  // v46: TUI interaction — ask-panel keys ride the SAME pty path as typing;
  // the deferred re-scan shows the consequence without waiting for the poll.
  chatEl.querySelector('.cak-enter').addEventListener('click', () => sendKey(pane, '\r'));
  chatEl.querySelector('.cak-esc').addEventListener('click', () => sendKey(pane, '\x1b'));
  // v46.1: mode DROPDOWN (the TUI only cycles via Shift+Tab — picking a mode
  // cycles until the footer reads it, see cycleToMode).
  const modeBtn = chatEl.querySelector('.cc-mode-btn');
  const modeMenu = chat.modeMenuEl;
  modeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    modeMenu.hidden = !modeMenu.hidden;
  });
  modeMenu.addEventListener('click', (e) => {
    const item = e.target.closest('.cc-mode-item');
    if (!item) return;
    // Review attack #2: the unreachable memory must be LOGIC, not just CSS
    // pointer-events — keyboard/programmatic activation bypasses the latter.
    if (chat.modeUnreachable.has(item.dataset.mode)) return;
    modeMenu.hidden = true;
    cycleToMode(pane, item.dataset.mode);
  });
  // v72: model DROPDOWN — same shape as the mode one, but a pick is a slash
  // command: it rides the PTY exactly like « Compacter » (sendModel). No shared
  // state with the mode cycle (no Shift+Tab lap here — the TUI takes /model).
  const modelBtn = chatEl.querySelector('.cc-model-btn');
  const modelMenu = chat.modelMenuEl;
  modelBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    modelMenu.hidden = !modelMenu.hidden;
  });
  modelMenu.addEventListener('click', (e) => {
    const item = e.target.closest('.cc-model-item');
    if (!item) return;
    modelMenu.hidden = true;
    sendModel(pane, item.dataset.model);
  });
  // Effort DROPDOWN — the model dropdown's twin: a pick is the slash command
  // « /effort <level> » (sendEffort); the label only ever shows the statusline's level.
  const effortBtn = chatEl.querySelector('.cc-effort-btn');
  const effortMenu = chat.effortMenuEl;
  effortBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    effortMenu.hidden = !effortMenu.hidden;
  });
  effortMenu.addEventListener('click', (e) => {
    const item = e.target.closest('.cc-effort-item');
    if (!item) return;
    effortMenu.hidden = true;
    sendEffort(pane, item.dataset.effort);
  });
  chatEl.addEventListener('click', (e) => {
    if (!e.target.closest('.cc-mode-dd')) modeMenu.hidden = true;
    if (!e.target.closest('.cc-model-dd')) modelMenu.hidden = true; // v72
    if (!e.target.closest('.cc-effort-dd')) effortMenu.hidden = true;
    // B9: per-response copy button — delegated, no per-button listener.
    const copyBtn = e.target.closest('.cv-copy');
    if (copyBtn) {
      copyResponse(copyBtn);
      return;
    }
    // Review attack #1: the Esc listener below needs focus INSIDE the chat
    // subtree — a click on a non-interactive spot (card body, empty stream)
    // hands focus back to the input, claude.ai-style. Text selection wins.
    if (e.target.closest('button, a, .chat-input, summary, .chat-tool-head, .cv-file-link')) return;
    if (String(window.getSelection())) return;
    if (!inputEl.disabled) inputEl.focus();
  });
  // v46.1: the KEYBOARD Esc is the interrupt — anywhere in the chat face
  // (user feedback: a clickable « Esc » pill is not how a terminal feels).
  chatEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!effortMenu.hidden) {
      effortMenu.hidden = true; // same as the model menu — close, don't interrupt
      return;
    }
    if (!modelMenu.hidden) {
      modelMenu.hidden = true; // v72: same as the mode menu — close, don't interrupt
      return;
    }
    if (!modeMenu.hidden) {
      modeMenu.hidden = true; // close the dropdown first, don't interrupt
      return;
    }
    e.preventDefault();
    // A visible TUI menu makes Esc a REFUSAL (dismiss the menu), not a stop
    // — ride the direct path; the interrupt bookkeeping must not engage.
    if (chat.askEl && !chat.askEl.hidden) {
      sendKey(pane, '\x1b');
      return;
    }
    interruptClaude(pane);
  });
  return chat;
}

// Composer auto-grow, claude.ai-style: follow the content; the CSS
// max-height (single source of truth — min(10 lines, 40cqh of the pane))
// clamps the rendered box and flips the themed scrollbar on. border-box:
// scrollHeight already includes the vertical padding.
function autosize(ta) {
  if (ta.tagName !== 'TEXTAREA') return; // v59: the rich composer div grows via CSS, not inline height
  ta.style.height = 'auto';
  ta.style.height = ta.scrollHeight + 'px';
}

function scrollBottom(chat) {
  if (!chat) return;
  chat.scrollEl.scrollTop = chat.scrollEl.scrollHeight;
  chat.atBottom = true;
  chat.jumpEl.hidden = true;
}

// `loading` marks a wait text: the bar sits after it, and the next text written here drops it.
function setEmpty(chat, text, { loading = false } = {}) {
  let el = chat.streamEl.querySelector('.chat-empty');
  if (!text) {
    if (el) el.remove();
    return;
  }
  if (!el) {
    el = document.createElement('div');
    el.className = 'chat-empty';
    chat.streamEl.appendChild(el);
  }
  el.textContent = text;
  if (loading) el.appendChild(inlineBar());
}

function setComposerDisabled(chat, disabled, placeholder) {
  chat.inputEl.disabled = disabled;
  chat.sendEl.disabled = disabled;
  chat.attachBtn.disabled = disabled;
  if (placeholder) chat.inputEl.placeholder = placeholder;
}

// Question drawer ↔ composer: while a request is pending the composer is the drawer's « Autre » field,
// and it follows the current question (snap.qKey / snap.custom). The user's draft is parked meanwhile and
// put back (over any leftover « Autre » text) when the request leaves.
// Only the focused composer may take the caret: a background pane is written quietly, focus untouched.
function setComposerText(el, v) {
  if (el.value === v) return;
  if (document.activeElement === el) el.value = v;
  else setRichValueQuiet(el, v);
}

function applyAskHost(chat, snap) {
  const el = chat.inputEl;
  chat.chatEl.querySelector('.chat-composer').classList.toggle('ask-docked', !!snap.pending); // square top edge under the drawer
  if (snap.pending) {
    if (!chat.askPending) {
      chat.askPending = true;
      chat.askDraft = el.value;
      chat.askPlaceholder = el.placeholder;
      chat.askQKey = '';
    }
    el.placeholder = chat.askPlaceholderSet = snap.placeholder;
    if (snap.qKey !== chat.askQKey) {
      chat.askQKey = snap.qKey;
      setComposerText(el, snap.custom);
    }
  } else if (chat.askPending) {
    chat.askPending = false;
    chat.askQKey = '';
    setComposerText(el, chat.askDraft);
    chat.askDraft = '';
    if (el.placeholder === chat.askPlaceholderSet) el.placeholder = chat.askPlaceholder;
  }
}

// ---------------------------------------------------------------------------
// Turn grouping — one .chat-turn per speaker change, with an avatar + label
// header. THE user ↔ Claude separation: user turns ride the right lane
// (accent), Claude turns the left lane (rail + spark avatar).
// ---------------------------------------------------------------------------

function turnFor(chat, role, ts, animate, sink) {
  if (chat.turn && chat.turn.role === role) return chat.turn.body;
  const el = document.createElement('section');
  el.className = `chat-turn t-${role}` + (animate ? ' anim' : '');
  const head = document.createElement('div');
  head.className = 'chat-turn-head';
  const fold = role === 'assistant';
  if (fold) { // the Claude answer folds from its head: a button whose `aria-expanded` is the state
    head.setAttribute('role', 'button');
    head.tabIndex = 0;
    head.setAttribute('aria-expanded', 'true');
    const chev = document.createElement('span');
    chev.className = 'ct-turn-chev';
    chev.appendChild(lucideIcon('lc-chevron-right'));
    head.appendChild(chev);
  }
  const av = document.createElement('span');
  av.className = 'chat-avatar';
  av.textContent = role === 'user' ? 'U' : '✦';
  const who = document.createElement('span');
  who.className = 'chat-who';
  who.textContent = role === 'user' ? 'Toi' : 'Claude';
  head.appendChild(av);
  head.appendChild(who);
  const time = fmtTime(ts);
  if (time) {
    const t = document.createElement('time');
    t.textContent = time;
    head.appendChild(t);
  }
  let sumEl = null;
  let cntEl = null;
  if (fold) {
    sumEl = document.createElement('span');
    sumEl.className = 'ct-turn-sum'; // first line of the first prose response; empty for a tool-only turn (rule 7)
    cntEl = document.createElement('span');
    cntEl.className = 'ct-turn-cnt';
    head.appendChild(sumEl);
    head.appendChild(cntEl);
  }
  el.appendChild(head);
  const body = document.createElement('div');
  body.className = 'chat-turn-body';
  el.appendChild(body);
  sink.appendChild(el);
  chat.turn = { role, body, head, sumEl, cntEl, tools: 0, t0: null, t1: null };
  return body;
}

const TURN_SUM_MAX = 160;

// First non-empty line of a rendered prose response, as text.
function firstLineOf(card) {
  const md = card.querySelector('.chat-md');
  if (!md) return '';
  for (const node of md.children) {
    const line = (node.textContent || '').split('\n').map((s) => s.trim()).find(Boolean);
    if (line) return line.length > TURN_SUM_MAX ? `${line.slice(0, TURN_SUM_MAX)}…` : line;
  }
  return '';
}

// Keep the folded head current as events land in the open Claude turn: tool count + span in `.ct-turn-cnt`, the summary
// from the first prose response that has any text. Never touches the fold state.
function noteTurnEvent(chat, ev, card) {
  const t = chat.turn;
  if (!t || t.role !== 'assistant' || !t.cntEl) return;
  if (ev.kind === 'tool') t.tools += 1;
  const ms = ev.ts ? Date.parse(ev.ts) : NaN;
  if (Number.isFinite(ms)) {
    if (t.t0 === null || ms < t.t0) t.t0 = ms;
    if (t.t1 === null || ms > t.t1) t.t1 = ms;
  }
  if (ev.kind === 'text' && !t.sumEl.textContent) t.sumEl.textContent = firstLineOf(card);
  const span = t.t0 !== null && t.t1 > t.t0 ? fmtSpan(t.t1 - t.t0) : '';
  const parts = [];
  if (t.tools) parts.push(`${t.tools} outil${t.tools > 1 ? 's' : ''}`);
  if (span) parts.push(span);
  const cnt = parts.join(', ');
  if (t.cntEl.textContent !== cnt) t.cntEl.textContent = cnt;
}

// B9: ONE copy button per assistant RESPONSE (one `text` event = one content
// block, its paragraphs included), in the footer row (`.chat-meta`) of that response. A
// response left empty by stripReview gets none (rule 7: no false affordance);
// tool cards, thinking, meta lines and review chips are never copied.
function noteCopyable(card, ev) {
  const text = stripReview(ev.text).text;
  if (!text.trim()) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'cv-copy';
  btn.title = COPY_LABEL;
  btn.setAttribute('aria-label', COPY_LABEL);
  btn.innerHTML = COPY_ICON_SVG;
  COPY_SOURCES.set(btn, { text, truncated: !!ev.truncated });
  // B18: « HH:MM · copier » — the button joins the time in the response's own footer row, so it reads as
  // belonging to the text above. A response with no time gets a footer row holding only the button.
  let meta = card.querySelector(':scope > .chat-meta');
  if (!meta) {
    meta = document.createElement('div');
    meta.className = 'chat-meta';
    card.appendChild(meta);
  }
  meta.appendChild(btn);
}

// One response's payload: its prose without the review block, plus the
// truncation marker when the reader capped it.
export function cvCopyPayload(btn) {
  const src = COPY_SOURCES.get(btn);
  if (!src) return '';
  return src.text + (src.truncated ? COPY_TRUNCATED : '');
}

// System CLIPBOARD (Ctrl+V), never the X11 PRIMARY selection.
function copyResponse(btn) {
  const payload = cvCopyPayload(btn);
  if (!payload) return; // nothing to copy -> no « copié » lie
  try {
    window.api.clipboardWrite(payload);
  } catch (e) {
    console.error('cv copy:', e);
    return; // the feedback state only ever follows a real write
  }
  btn.classList.add('is-copied');
  clearTimeout(COPY_TIMERS.get(btn));
  COPY_TIMERS.set(btn, setTimeout(() => {
    btn.classList.remove('is-copied');
    COPY_TIMERS.delete(btn);
  }, 1200));
}

// ---------------------------------------------------------------------------
// Event -> card rendering.
// ---------------------------------------------------------------------------

function metaLine(ev) {
  const meta = document.createElement('div');
  meta.className = 'chat-meta';
  const time = fmtTime(ev.ts);
  if (time) {
    const t = document.createElement('time');
    t.textContent = time;
    meta.appendChild(t);
  }
  return meta.childNodes.length ? meta : null;
}

function renderEvent(chat, ev, pane) {
  if (ev.kind === 'goal') {
    // v50: « Goal défini » confirmation chip — the chat face otherwise drops
    // the <local-command-stdout> as noise, so a /goal looked like it vanished.
    const el = document.createElement('div');
    el.className = 'chat-goal-set';
    const ico = document.createElement('span');
    ico.className = 'cgs-ico';
    ico.textContent = '◎';
    const label = document.createElement('span');
    label.className = 'cgs-label';
    label.textContent = 'Goal défini';
    const txt = document.createElement('span');
    txt.className = 'cgs-text';
    txt.textContent = ev.text || '';
    el.append(ico, label, txt);
    // v51: the goal condition is usually multi-sentence — it ellipsises to one
    // line so the chip stays compact. Click toggles .expanded (wrap vs nowrap)
    // so the full text is reachable. Pure presentation, no transcript state.
    el.classList.add('is-collapsible');
    el.title = 'Cliquer pour afficher / replier le goal complet';
    el.addEventListener('click', () => {
      // v51: a drag-to-select that ends inside the chip also fires a click — don't
      // collapse the very text the user is copying. Only a plain click (collapsed
      // range) toggles.
      if (!window.getSelection().isCollapsed) return;
      el.classList.toggle('expanded');
    });
    return el;
  }
  if (ev.kind === 'user') {
    const el = document.createElement('div');
    el.className = 'chat-msg chat-user';
    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble';
    renderCodeOnly(bubble, ev.text + (ev.truncated ? ' …' : ''));
    el.appendChild(bubble);
    const meta = metaLine(ev);
    if (meta) el.appendChild(meta);
    return el;
  }
  if (ev.kind === 'text') {
    const el = document.createElement('div');
    el.className = 'chat-msg chat-assistant';
    const body = document.createElement('div');
    body.className = 'chat-md';
    // Review block (Stop hook format): lifted out of the markdown, rendered
    // as a chip card below the prose — parse failure falls back to raw text.
    const { text, reviewInner } = stripReview(ev.text);
    renderMdInto(body, text);
    linkFilePaths(body);
    el.appendChild(body);
    if (reviewInner !== null) el.appendChild(renderReviewCard(reviewInner));
    const meta = metaLine(ev);
    if (meta) el.appendChild(meta);
    return el;
  }
  if (ev.kind === 'thinking') {
    const el = document.createElement('details');
    el.className = 'chat-thinking';
    const sum = document.createElement('summary');
    sum.textContent = '✦ Réflexion';
    el.appendChild(sum);
    const body = document.createElement('div');
    body.className = 'chat-md';
    renderMdInto(body, ev.text);
    el.appendChild(body);
    return el;
  }
  if (ev.kind === 'tool') {
    const el = document.createElement('div');
    // v45: inputs folded by default (sidebar sections pattern) — the head
    // line carries the story; click unfolds. Errors stay folded (v46.9.7):
    // the red left-border signals them without expanding the card.
    el.className = 'chat-tool folded';
    el.dataset.status = 'pending';
    const t0 = ev.ts ? Date.parse(ev.ts) : NaN; // tool_use time: the duration starts here (fillResult)
    if (Number.isFinite(t0)) el.dataset.t0 = String(t0);
    const head = document.createElement('div');
    head.className = 'chat-tool-head';
    head.setAttribute('role', 'button');
    head.tabIndex = 0;
    head.setAttribute('aria-expanded', 'false'); // mirrors .folded, kept by toggleToolCard
    const ico = document.createElement('span');
    ico.className = 'ct-ico';
    ico.textContent = toolIcon(ev.name);
    const name = document.createElement('span');
    name.className = 'ct-name';
    name.textContent = ev.name;
    head.appendChild(ico);
    head.appendChild(name);
    // v44: sub-agent dispatches are NAMED — the user sees WHICH agent runs.
    // S6b: the chip is a button (not the head handler at :645's fold toggle,
    // stopped here) — it opens the read-only agent journal overlay (finding
    // 9: no paneId in the payload, main resolves it from sessionId/toolUseId).
    if (ev.agentType) {
      const ag = document.createElement('button');
      ag.type = 'button';
      ag.className = 'ct-agent';
      ag.textContent = ev.agentType;
      ag.title = `Sous-agent : ${ev.agentType}`;
      ag.setAttribute('aria-label', `Ouvrir le journal de l'agent ${ev.agentType}`);
      ag.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!pane) return;
        openAgentJournal({
          sessionId: pane.sessionId, toolUseId: ev.id,
          agentType: ev.agentType, description: ev.summary,
        });
      });
      head.appendChild(ag);
    }
    if (ev.summary) {
      const sm = document.createElement('code');
      sm.className = 'ct-summary';
      sm.textContent = ev.summary;
      sm.title = ev.summary;
      head.appendChild(sm);
    }
    const dur = document.createElement('span');
    dur.className = 'ct-dur'; // filled by fillResult, empty (and hidden) until then
    head.appendChild(dur);
    const status = document.createElement('span');
    status.className = 'ct-status'; // fixed slot, painted by setOutcome
    head.appendChild(status);
    // The clock sits in the head row, after the run text and before the chevron; no ts, no clock (rule 7).
    const time = fmtTime(ev.ts);
    if (time) {
      const t = document.createElement('time');
      t.className = 'ct-time';
      t.textContent = time;
      head.appendChild(t);
    }
    const chev = document.createElement('span');
    chev.className = 'ct-chevron';
    chev.appendChild(lucideIcon('lc-chevron-right'));
    head.appendChild(chev);
    el.appendChild(head);
    const body = document.createElement('div');
    body.className = 'chat-tool-body';
    if (ev.detail && ev.detail !== '{}') {
      const det = document.createElement('pre');
      det.className = 'ct-detail';
      const diff = ev.name === 'Edit' ? editDiffLines(ev.detail) : null;
      if (diff) {
        det.classList.add('ct-diff');
        diff.forEach(([gutter, text], i) => {
          const line = gutter + text + (i < diff.length - 1 ? '\n' : '');
          if (gutter === ' ') { det.appendChild(document.createTextNode(line)); return; }
          const row = document.createElement('span');
          row.className = gutter === '+' ? 'ct-dl-a' : 'ct-dl-d';
          row.textContent = line;
          det.appendChild(row);
        });
      } else {
        det.textContent = ev.detail;
      }
      body.appendChild(det);
    }
    const res = document.createElement('pre');
    res.className = 'ct-result';
    res.hidden = true;
    body.appendChild(res);
    el.appendChild(body);
    if (ev.id) chat.toolIndex.set(ev.id, el);
    return el;
  }
  return null; // unknown kind from a future main: ignore, never throw
}

// v46.6: live activity of a running sub-agent, terminal-face parity — each
// tool call tailed from the agent's own transcript lands as one line under
// the dispatch card's head (visible while folded). v46.7: the FULL call
// history stays in the DOM (the box itself scrolls, sticky-bottom) — the
// cap below is only a runaway-agent safety net, surfaced in the counter.
const LIVE_LINES_DOM_CAP = 200;
function appendAgentLive(chat, card, events) {
  let live = card.querySelector('.ct-live');
  if (!live) {
    live = document.createElement('div');
    live.className = 'ct-live';
    const lines = document.createElement('div');
    lines.className = 'ct-live-lines';
    const count = document.createElement('span');
    count.className = 'ct-live-count';
    live.append(lines, count);
    live.dataset.count = '0';
    card.insertBefore(live, card.querySelector('.chat-tool-body'));
  }
  const linesEl = live.querySelector('.ct-live-lines');
  // v46.7 sticky-bottom: keep following the tail unless the user scrolled
  // up to read back (then appends must not yank the viewport down).
  // clientHeight 0 = not laid out (offscreen content-visibility turn or
  // hidden face): geometry reads lie there — never touch the scroll state.
  const stick = linesEl.clientHeight > 0
    && linesEl.scrollTop + linesEl.clientHeight >= linesEl.scrollHeight - 4;
  for (const ev of events) {
    const row = document.createElement('div');
    row.className = 'ct-live-line';
    const name = document.createElement('span');
    name.className = 'ct-live-name';
    name.textContent = ev.name;
    row.appendChild(name);
    if (ev.summary) {
      const sum = document.createElement('code');
      sum.textContent = ev.summary;
      sum.title = ev.summary;
      row.appendChild(sum);
    }
    const clock = fmtTime(ev.ts);
    if (clock) {
      const t = document.createElement('time');
      t.className = 'ct-live-time';
      t.textContent = clock;
      row.appendChild(t);
    }
    linesEl.appendChild(row);
  }
  while (linesEl.children.length > LIVE_LINES_DOM_CAP) linesEl.removeChild(linesEl.firstChild);
  const total = Number(live.dataset.count || '0') + events.length;
  live.dataset.count = String(total);
  live.querySelector('.ct-live-count').textContent =
    total > LIVE_LINES_DOM_CAP
      ? `${total} outils — ${LIVE_LINES_DOM_CAP} derniers`
      : `${total} outil${total > 1 ? 's' : ''}`;
  if (stick) linesEl.scrollTop = linesEl.scrollHeight;
}

// v81 (deck-agent-final-report): a sub-agent's FINAL report. The harness no longer returns it as the
// Agent tool_result (that holds a meaningless hand-back placeholder); it rides either the result line
// itself (`ev.report`, the harness-written handbackReport — primary) or a queued `<agent-message>` the
// normalizer surfaces as { kind:'agentReport', agentId, text, truncated } (fallback, up to 3 identical
// copies, before OR after the result). Per chat: `reportCards` = toolUseId -> the cards entitled to a
// report (Agent dispatches and SendMessage calls ONLY — a tool output quoting the placeholder is not one),
// `agentReports` = agentId -> { queue: unconsumed reports in arrival order, seen: every distinct text
// already queued or shown (the copies + a report a card showed from `ev.report` are consumed there, never
// re-assigned), waiting: cards still owed a report, in order }. The report reaches the DOM through
// textContent in the card's existing result <pre> only (rule 2: no markup from transcript data).
const REPORT_TRUNCATED_MARK = '… (rapport tronqué)';

function noteReportCard(chat, ev) {
  const kind = ev.agentType ? 'agent' : (ev.name === 'SendMessage' ? 'send' : null);
  if (kind && ev.id) chat.reportCards.set(ev.id, { kind, waiting: false, done: false });
}

function reportBucket(chat, agentId) {
  let b = chat.agentReports.get(agentId);
  if (!b) {
    b = { queue: [], seen: new Set(), waiting: [] };
    chat.agentReports.set(agentId, b);
  }
  return b;
}

function showReport(card, text, truncated) {
  const res = card.querySelector('.ct-result');
  if (!res) return;
  res.textContent = truncated ? text + '\n' + REPORT_TRUNCATED_MARK : text;
  res.hidden = false;
  res.classList.remove('ct-result-empty');
}

function deliverReport(chat, toolUseId, rep) {
  const card = chat.toolIndex.get(toolUseId);
  const rc = chat.reportCards.get(toolUseId);
  if (!card || !rc) return false;
  showReport(card, rep.text, rep.truncated);
  rc.waiting = false;
  rc.done = true;
  return true;
}

// Is `text` another copy of the report `r`? Exactly it, or the form the harness queues for a report that
// tripped its scanners: a "[harness: subagent output matched …]" warning line, a blank line, then the report
// (measured: the carrier ends with the exact handbackReport.text). The prefix is required so a genuinely
// different report that merely ENDS with an earlier report's last line is never swallowed as a copy.
function isCopyOf(text, r) {
  return text === r || (text.startsWith('[harness: ') && text.endsWith('\n' + r));
}

// A resume only targets a FINISHED agent, so every card still waiting on it belongs to a run that is over (its
// report never came, e.g. a background launch whose hand-back was withheld): it stops waiting and keeps the text
// it has. Left in the line, it would take the NEXT run's report and shift every later card by one.
function releaseWaiting(chat, agentId) {
  const b = reportBucket(chat, agentId);
  for (const id of b.waiting) {
    const w = chat.reportCards.get(id);
    if (w) w.waiting = false;
  }
  b.waiting = [];
}

// A card owed a report joins its agent's waiting line (once).
function awaitReport(chat, toolUseId, rc, agentId) {
  if (rc.waiting) return;
  rc.waiting = true;
  reportBucket(chat, agentId).waiting.push(toolUseId);
}

// { kind:'agentReport' }: serve the first waiting card, else queue for the next card that asks.
function noteAgentReport(chat, ev) {
  const text = typeof ev.text === 'string' ? ev.text.trim() : '';
  if (!text || typeof ev.agentId !== 'string' || !ev.agentId) return;
  const b = reportBucket(chat, ev.agentId);
  for (const r of b.seen) if (isCopyOf(text, r)) return; // another copy of a report already queued / shown
  b.seen.add(text);
  const rep = { text, truncated: ev.truncated === true };
  while (b.waiting.length) {
    if (deliverReport(chat, b.waiting.shift(), rep)) return;
  }
  b.queue.push(rep);
}

// The text half of fillResult for a card entitled to a report. Returns true when the report logic
// owns the card's result text (the placeholder is never shown), false to keep the usual text path.
function fillReportResult(chat, ev, card, res, rc) {
  if (rc.done) return true; // a re-fill never overwrites the report already shown
  const report = typeof ev.report === 'string' ? ev.report.trim() : '';
  if (report) {
    showReport(card, report, ev.reportTruncated === true);
    rc.done = true;
    if (ev.agentId) { // consume the carrier copies of THIS report, queued already or yet to come
      const b = reportBucket(chat, ev.agentId);
      b.seen.add(report);
      b.queue = b.queue.filter((q) => !isCopyOf(q.text, report));
    }
    return true;
  }
  if (ev.handback === true) {
    res.textContent = '';
    res.hidden = true; // nothing guessed until the report arrives
    res.classList.remove('ct-result-empty');
    if (!ev.agentId) return true;
    const next = reportBucket(chat, ev.agentId).queue.shift();
    if (next) {
      showReport(card, next.text, next.truncated);
      rc.done = true;
    } else {
      awaitReport(chat, ev.toolUseId, rc, ev.agentId);
    }
    return true;
  }
  // async launch ACK of a background Agent / SendMessage that resumed a finished agent: the ACK text
  // stays (today's working/done logic is untouched), the NEXT report of that agent replaces it.
  const waitsFor = rc.kind === 'agent' ? (ev.ack === true ? ev.agentId : null) : ev.resumedAgentId;
  if (waitsFor && !rc.waiting) {
    if (rc.kind === 'send') releaseWaiting(chat, waitsFor); // a resume closes the earlier runs' wait
    awaitReport(chat, ev.toolUseId, rc, waitsFor);
  }
  return false;
}

// v46.8: the dispatch is over — the feed STAYS under the head (calmer
// ct-live-done style). v46.6 archived it into the folded body, which
// visually ERASED the history the user was reading (folded body =
// display:none) — user bug report 2026-06-07. v46.9.6: the done style no
// longer shrinks the box (same 10-line cap as live, user decision) — the
// re-pin below is NOT dead code: .ct-live-done currently only recolors the
// border (no height change), but a >10-line feed stays scrollable — kept
// as an idempotent tail-pin guard for any future ct-live-done height rule.
// v82: extracted from fillResult — also called when a background agent's card settles.
function markFeedDone(card) {
  const live = card.querySelector('.ct-live');
  if (!live) return;
  const lines = live.querySelector('.ct-live-lines');
  const stick = lines && lines.clientHeight > 0
    && lines.scrollTop + lines.clientHeight >= lines.scrollHeight - 4;
  live.classList.add('ct-live-done');
  if (stick) lines.scrollTop = lines.scrollHeight;
}

// v46.9.7 (user decision): errors AND hook-blocks stay COLLAPSED — no
// auto-unfold. To keep the failure DISCOVERABLE while folded (the body
// is display:none), the always-visible head carries a non-color cue:
// an x icon (shape, not just color — colorblind-safe) and
// an aria-label on the card for screen readers. The cause text stays one
// click away, like every folded card.
// v82: extracted from fillResult — also set when a notification ends a background agent with `failed`.
// Verre: the head's fixed `.ct-status` slot carries the outcome as a SHAPE (Lucide check / x, never color
// alone); the failure face keeps the `.ct-err` class. Any other state (pending, running, interrupted)
// leaves the slot empty (rule 7: no guess).
function setOutcome(card, status) {
  const slot = card.querySelector('.chat-tool-head .ct-status');
  const on = status === 'error';
  if (slot) {
    slot.replaceChildren(); // idempotent: a later re-fill repaints from scratch
    slot.classList.toggle('ct-err', on);
    slot.removeAttribute('role');
    slot.removeAttribute('aria-label');
    slot.removeAttribute('title');
    if (status === 'ok' || on) {
      slot.setAttribute('role', 'img');
      slot.setAttribute('aria-label', on ? 'Échec' : 'Réussi');
      if (on) slot.title = 'Échec — clique pour voir la cause';
      slot.appendChild(lucideIcon(on ? 'lc-x' : 'lc-check'));
    }
  }
  if (on) card.setAttribute('aria-label', `${card.querySelector('.ct-name')?.textContent || 'Outil'} — échec`);
  else card.removeAttribute('aria-label');
}

// One `<svg><use href="#lc-NAME"/></svg>` of the #lc-sprite (static ids, no data in the markup).
function lucideIcon(id) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  const use = document.createElementNS(NS, 'use');
  use.setAttribute('href', `#${id}`);
  svg.appendChild(use);
  return svg;
}

// Fold engine of the tool card and of the Claude answer. The head's `aria-expanded` flips at the click and is the single
// source of truth; `.folded` on the owner lands once the collapse has ended, and only if no unfold superseded it.
// Unfold: the body is hidden inline first, so `expand` measures the followers going from hidden to shown whatever hid it
// (the class of a card born folded, or the inline display of an earlier collapse).
const FOLD_SEQ = new WeakMap(); // owner -> its latest fold request

function applyFold(chat, owner, head, body, open, animated = true) {
  const seq = (FOLD_SEQ.get(owner) || 0) + 1;
  FOLD_SEQ.set(owner, seq);
  head.setAttribute('aria-expanded', String(open));
  const scope = { scope: chat.streamEl };
  if (open) {
    if (animated || body.getAnimations().length) {
      body.style.display = 'none';
      owner.classList.remove('folded');
      expand(body, scope);
    } else { // off screen: no glide, the class and the inline display go together
      owner.classList.remove('folded');
      body.style.removeProperty('display');
    }
    return;
  }
  if (!animated) {
    owner.classList.add('folded');
    return;
  }
  collapse(body, scope).then(() => {
    if (FOLD_SEQ.get(owner) === seq && head.getAttribute('aria-expanded') === 'false') owner.classList.add('folded');
  });
}

// Fold / unfold from a head: the direction is the opposite of its `aria-expanded`. An unfold at the tail keeps following it.
function toggleFold(chat, owner, head, body) {
  const open = head.getAttribute('aria-expanded') !== 'true';
  const stuck = open && chat.atBottom;
  applyFold(chat, owner, head, body, open);
  if (stuck) scrollBottom(chat);
  syncFoldAll(chat);
}

function toggleToolCard(chat, head) {
  const card = head.parentElement;
  const body = card.querySelector(':scope > .chat-tool-body');
  if (!body) return;
  if (!head.hasAttribute('aria-expanded')) head.setAttribute('aria-expanded', String(!card.classList.contains('folded')));
  toggleFold(chat, card, head, body);
}

function toggleTurn(chat, head) {
  const turn = head.parentElement;
  const body = turn.querySelector(':scope > .chat-turn-body');
  if (body) toggleFold(chat, turn, head, body);
}

const ASSISTANT_HEADS = ':scope > .chat-turn.t-assistant > .chat-turn-head';

// « Tout plier » while any answer is open, else « Tout déplier »; the control shows once there is an answer to fold.
function syncFoldAll(chat) {
  const heads = chat.streamEl.querySelectorAll(ASSISTANT_HEADS);
  chat.foldAllEl.parentElement.style.display = heads.length ? '' : 'none';
  let open = false;
  for (const h of heads) if (h.getAttribute('aria-expanded') === 'true') { open = true; break; }
  const label = open ? 'Tout plier' : 'Tout déplier';
  if (chat.foldAllEl.textContent !== label) chat.foldAllEl.textContent = label;
}

// Fold every open answer (or unfold every folded one when none is open). Every rect is read first; only the answers that
// intersect the feed viewport glide, the others snap with the class.
function foldAll(chat) {
  const heads = [...chat.streamEl.querySelectorAll(ASSISTANT_HEADS)];
  if (!heads.length) return;
  const fold = heads.some((h) => h.getAttribute('aria-expanded') === 'true');
  const targets = heads.filter((h) => (h.getAttribute('aria-expanded') === 'true') === fold);
  const vp = chat.scrollEl.getBoundingClientRect();
  const seen = targets.map((h) => {
    const r = h.parentElement.getBoundingClientRect();
    return r.bottom > vp.top && r.top < vp.bottom;
  });
  const stuck = !fold && chat.atBottom;
  const run = (h, animated) => {
    const turn = h.parentElement;
    const body = turn.querySelector(':scope > .chat-turn-body');
    if (body) applyFold(chat, turn, h, body, !fold, animated);
  };
  targets.forEach((h, i) => { if (!seen[i]) run(h, false); });
  targets.forEach((h, i) => { if (seen[i]) run(h, true); });
  if (stuck) scrollBottom(chat);
  syncFoldAll(chat);
}

// « 0,9 s » under 10 s (fr-FR, one decimal), whole seconds under 60 s, « N min S s » beyond;
// a missing or negative span gives '' (rule 7).
function fmtDuration(startMs, endTs) {
  const end = endTs ? Date.parse(endTs) : NaN;
  return fmtSpan(end - startMs);
}

function fmtSpan(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const sec = ms / 1000;
  if (sec < 10) return `${sec.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} s`;
  const whole = Math.round(sec);
  if (whole < 60) return `${whole} s`;
  return `${Math.floor(whole / 60)} min ${whole % 60} s`;
}

// v82: the terminal state of a background agent's card. Its tool_result is only the launch ACK, so the card
// stayed `running` (or is still `pending` when the notification beat the ACK). Two kinds of caller:
//  - `real` = the agent's own <task-notification> (agentDone, appendEvents): a VERDICT. It moves a `running`
//    or `pending` card, remembers the decision in `bgFinal` (a late ACK result never revives the card, the
//    3 copies of one notification find a decided card) and may also lift an `interrupted` card that no
//    verdict decided (the lost-signal settle of the next bullet): a completed agent never stays `interrupted`.
//  - not `real` = a LOST signal (idle backstop reapStaleTasks, pty death in cvNotifySessionStatus): it only
//    moves a `running` card and leaves `bgFinal` unset, so a live agentDone that still arrives wins.
// MONOTONIC for every real close signal: notification copies, errored result and late ACK change nothing
// once `bgFinal` holds.
function settleBgCard(card, status, real) {
  const cur = card.dataset.status;
  const open = cur === 'running' || (real && cur === 'pending')
    || (real && cur === 'interrupted' && !card.dataset.bgFinal);
  if (!open) return false;
  if (real) card.dataset.bgFinal = status;
  card.dataset.status = status;
  markFeedDone(card);
  setOutcome(card, status);
  return true;
}

// The run time of a background agent (or a resumed run): tool_use ts -> the ts of its own
// <task-notification>, both transcript timestamps. First notification copy wins; a lost-signal settle never calls it.
function stampBgRun(card, endTs) {
  const dur = card.querySelector('.ct-dur');
  if (!dur || dur.textContent || !card.dataset.t0) return;
  dur.textContent = fmtDuration(Number(card.dataset.t0), endTs);
}

function fillResult(chat, ev) {
  const card = ev.toolUseId ? chat.toolIndex.get(ev.toolUseId) : null;
  if (!card) return; // orphan at the truncation edge: drop silently
  // v82: a result is NOT always the end of the tool. A background Agent (or a SendMessage that resumed a
  // finished agent) answers with a launch ACK while the agent keeps working, and the roster says which:
  // appendEvents ran its rules for this very result just before this call, so a row that is still OPEN
  // (live-only, not done) means the agent runs on. Then the card stays `running` (same look as `pending`),
  // its feed stays live, and the terminal state comes later from settleBgCard. `bgFinal` = a state a
  // notification already decided before this late ACK: it wins, the ACK never revives the card. No row
  // (sync agent, any other tool, replay) = the rule of old; a missing row never means interrupted.
  const row = chat.bgAgents.get(ev.toolUseId);
  const status = card.dataset.bgFinal
    || (ev.isError ? 'error' : (row && !row.done && !ev.settledByResult ? 'running' : 'ok')); // L5: a result that ended its dispatch no longer closes the row, it still ends the card
  if (status !== 'running') markFeedDone(card);
  card.dataset.status = status;
  setOutcome(card, status);
  // The span is tool_use -> its own result. A launch ACK (background agent, resumed run) is not the end:
  // no duration yet, stampBgRun gives it one at the run's own notification. The ACK is told by the
  // normalizer (ev.ack / resumedAgentId), never by the live-only roster row, so replay agrees with live.
  const bgLaunch = !ev.isError && (ev.ack === true || !!ev.resumedAgentId);
  if (bgLaunch) card.dataset.bgLaunch = '1';
  const dur = card.querySelector('.ct-dur');
  if (dur && !bgLaunch) dur.textContent = card.dataset.t0 ? fmtDuration(Number(card.dataset.t0), ev.ts) : '';
  const res = card.querySelector('.ct-result');
  if (!res) return;
  // v81: Agent / SendMessage cards (identified by their tool_use id, never by what the output says)
  // show the sub-agent's final report instead of the hand-back placeholder.
  const rc = chat.reportCards.get(ev.toolUseId);
  if (rc && fillReportResult(chat, ev, card, res, rc)) return;
  const text = (ev.text || '').trim();
  if (text) {
    res.textContent = ev.truncated ? text + '\n… (tronqué)' : text;
    res.hidden = false;
  } else {
    res.textContent = '(sans sortie)';
    res.hidden = false;
    res.classList.add('ct-result-empty');
  }
}

// v45.5: a tool_use whose session died/finished without its result must not
// pulse forever (user repro: close the pane mid-agent, reopen — the old
// agent icon still blinks). When the turn is OVER, surviving pending cards
// flip to 'interrupted': no pulse, dimmed, a short note where the result
// would have landed. fillResult still upgrades them if a result ever shows.
function markPendingInterrupted(chat) {
  for (const [id, card] of chat.toolIndex.entries()) {
    if (card.dataset.status !== 'pending') continue;
    card.dataset.status = 'interrupted';
    card.dataset.orphan = '1'; // L5: no result ever came; the lifecycle's `running` does not re-open this card
    // A dispatch still pending when the turn ends never got its async ACK
    // (an ACK would have turned the card `running`, see fillResult) — it's
    // an orphan, not a running agent, so drop its band row too. v82: a
    // `running` card is skipped above on purpose, its agent outlives the turn.
    const bg = chat.bgAgents.get(id);
    if (bg) bg.done = true;
    const res = card.querySelector('.ct-result');
    if (res && res.hidden) {
      res.textContent = "(interrompu — la session s'est arrêtée avant la fin)";
      res.hidden = false;
      res.classList.add('ct-result-empty');
    }
  }
  refreshActivity(chat);
}

// v82: the pty died (status `closed`). A background agent dies with its parent CLI, so no close signal can
// ever reach its card and the `running` pulse would last until the 60 min backstop. Every `running` card of
// the pane is settled to `interrupted` (no `bgFinal`: not a verdict) and its roster row is closed, then the
// band is refreshed. Kept apart from markPendingInterrupted on purpose: that one stays pending-only, a
// `running` card must survive a turn end (its agent outlives the turn).
function settleRunningCardsOnClose(chat) {
  let changed = chat.bgShells.size > 0; // the process is gone: its shells are gone too
  chat.bgShells.clear();
  chat.bgShellCalls.clear();
  for (const [id, card] of chat.toolIndex.entries()) {
    if (!settleBgCard(card, 'interrupted', false)) continue;
    const bg = chat.bgAgents.get(id);
    if (bg) bg.done = true;
    changed = true;
  }
  if (changed) { refreshTasks(chat); refreshActivity(chat); }
}

// L5: the agent lifecycle (contract K1) on the roster row and the card, from the feed's
// `{kind:'agentState', toolUseId, state, seq, agentType, summary}`. One source of truth: main's agentStatesOf.
//  - seq guard per toolUseId (`chat.agentSeq`), a row-less event is ordered too;
//  - a row follows the state (`done` for the terminal ones, `lc` = the lifecycle owns it, so the idle backstop
//    leaves it alone); running/waiting with no row CREATES it (D-U1), nothing else does;
//  - a card: waiting = running look + `ct-waiting` + title; running after a terminal re-opens it; closed settles
//    `interrupted` (no verdict); unknown stops the pulse without settling (data-status `unknown` matches no
//    running rule); done/blocked leave the card to its result / notification, except a card this handler re-opened.
// The feed pushes both the dispatch id and the resume call id of a resumed agent (one state for the two): each event
// acts on its own row/card and on its partner's, the call id never creates a row, and the roster shows ONE row per
// agent: a call's row yields to the dispatch's row while that one exists (refreshTasks).
const AGENT_STATES = new Set(['running', 'waiting', 'done', 'blocked', 'closed', 'unknown']);
const AGENT_TERMINAL = new Set(['done', 'blocked', 'closed']);
const WAITING_TITLE = 'En attente de ses tâches de fond';

function applyAgentCard(card, state) {
  const waiting = state === 'waiting';
  card.classList.toggle('ct-waiting', waiting);
  if (waiting) card.title = WAITING_TITLE;
  else if (card.title === WAITING_TITLE) card.removeAttribute('title');
  let cur = card.dataset.status;
  if (state === 'unknown') {
    if (cur === 'running') card.dataset.status = 'unknown';
    return;
  }
  if (cur === 'unknown') { card.dataset.status = 'running'; cur = 'running'; } // the lifecycle speaks again
  if (state === 'running' || state === 'waiting') {
    if ((cur === 'ok' || cur === 'error' || cur === 'interrupted') && !card.dataset.orphan) {
      card.dataset.lcPrev = cur;
      card.dataset.lcOpen = '1';
      card.dataset.status = 'running';
      const live = card.querySelector('.ct-live');
      if (live) live.classList.remove('ct-live-done');
      const dur = card.querySelector('.ct-dur');
      if (dur) dur.textContent = ''; // the next notification stamps the new run
      setOutcome(card, 'running');
    }
    return;
  }
  if (state === 'closed') { settleBgCard(card, 'interrupted', false); return; }
  if (card.dataset.lcOpen) { // done / blocked: only a card this handler re-opened is settled here
    delete card.dataset.lcOpen;
    settleBgCard(card, state === 'done' ? 'ok' : (card.dataset.lcPrev === 'error' ? 'error' : 'interrupted'), false);
  }
}

function applyAgentState(chat, ev) {
  const id = ev.toolUseId;
  const state = ev.state;
  if (!id || !AGENT_STATES.has(state) || !Number.isFinite(ev.seq)) return; // malformed: never a row, never a guess
  const last = chat.agentSeq.get(id);
  if (last !== undefined && ev.seq <= last) return; // stale or repeated
  chat.agentSeq.set(id, ev.seq);
  const dispatchId = chat.resumeOf.get(id) || null; // set = `id` is a resume call
  // A dispatch resumed live: its state is the call's (the feed pushes one state for both ids), so a dispatch event
  // also reaches the rows/cards of its live calls, and a call event reaches the dispatch's.
  const liveCalls = dispatchId ? [] : [...chat.resumeOf].filter(([c, d]) => d === id && chat.bgAgents.has(c)).map(([c]) => c);
  const targets = dispatchId ? [id, dispatchId] : [id, ...liveCalls];
  for (const t of targets) {
    let row = chat.bgAgents.get(t);
    if (!row && t === id && !dispatchId && !liveCalls.length && (state === 'running' || state === 'waiting')) {
      const known = chat.toolIndex.get(id);
      if (!known || known.querySelector('.ct-agent')) { // out of this view's window, or an Agent dispatch card
        row = { agentType: ev.agentType || 'agent', summary: ev.summary || '', done: false, since: Date.now(), state, lc: true };
        chat.bgAgents.set(id, row);
      }
    }
    if (row) {
      row.state = state;
      row.lc = true;
      row.done = AGENT_TERMINAL.has(state);
    }
    const card = chat.toolIndex.get(t);
    if (card) applyAgentCard(card, state);
  }
}

// Optimistic echo confirmation: the tail returned a user event matching a
// pending send — promote the dimmed bubble instead of rendering a duplicate.
// Matching is whitespace-tolerant: the TUI may re-wrap or normalize what it
// writes to the transcript (CRLF, collapsed runs) — exact compare first,
// collapsed compare as the fallback.
// Tolerant normalize: drop invisible C0 controls (a leaked box-clear `\x15` etc.)
// THEN collapse whitespace, so an echo still matches a confirmation the PTY
// round-trip lightly corrupted — a stray control byte must never strand an
// echo into a « ⋯ envoi » duplicate (the « double envoi » bug, 2026-06-12).
const normText = (s) => String(s).replace(CTRL_STRIP_RE, '').replace(/\s+/g, ' ').trim();

function sameText(a, b) {
  if (a === b) return true;
  return normText(a) === normText(b);
}

// R3 reply sinks {update(fullTextSoFar), done(), cancelled()}: a panel ask carries one on its queue item and its
// pendingSends entry. Once the transcript (or the FIFO promotion below) confirms THAT message the sink is bound to
// the turn and fed every `text` event until the turn ends (idle: done, stop / dead pane: cancelled).
function callSink(sink, method, arg) {
  if (!sink) return;
  try { sink[method](arg); } catch (_) { /* a failing sink never breaks the chat feed */ }
}

function replyState(chat) {
  return chat.reply || (chat.reply = { sink: null, texts: [], bound: false });
}

function bindReply(chat, sink, keepTexts) {
  const r = replyState(chat);
  callSink(r.sink, 'done'); // the previous turn ends where the next confirmed message begins
  r.sink = sink || null;
  r.bound = true;
  if (!keepTexts) r.texts = [];
  else if (r.sink && r.texts.length) callSink(r.sink, 'update', r.texts.join('\n\n'));
}

function feedReply(chat, text) {
  const r = replyState(chat);
  if (!r.sink && !chat.pendingSends.some((p) => p.sink)) return; // nobody could ever bind this turn's text
  r.texts.push(text);
  callSink(r.sink, 'update', r.texts.join('\n\n'));
}

function endReply(chat, cancelled) {
  const r = replyState(chat);
  const sink = r.sink;
  r.sink = null;
  r.texts = [];
  r.bound = false;
  callSink(sink, cancelled ? 'cancelled' : 'done');
}

function resolvePending(chat, ev) {
  for (let i = 0; i < chat.pendingSends.length; i++) {
    const p = chat.pendingSends[i];
    if (sameText(p.text, ev.text)) {
      p.el.classList.remove('chat-pending');
      const t = p.el.querySelector('time');
      if (t) t.textContent = fmtTime(ev.ts) || '✓';
      chat.pendingSends.splice(i, 1);
      bindReply(chat, p.sink);
      return true;
    }
  }
  return false;
}

// v62 (user repro « message bloqué en envoi alors que le terminal l'a déjà
// envoyé »): the optimistic echo confirms ONLY when the transcript tail returns
// a matching `user` line (resolvePending). But Claude Code logs SOME prompts in
// a shape the reader drops on purpose — isMeta entries and the USER_NOISE_RE
// wrappers (see ipc/transcript.js) — and a resume-fork can land the line in a
// file we aren't tailing yet. No `user` event then ever reaches resolvePending,
// and the v53 reclaim / markPendingInterrupted nets only fire on stop/interrupt,
// so the echo strands in « ⋯ envoi » FOREVER (single bubble, no twin — the
// reader emitted nothing to render). The conflict-free proof of receipt is LIVE
// CLAUDE OUTPUT (text/thinking/tool): a turn past its first token has COMMITTED
// to the message it answers and can no longer be un-done by a stop (the
// stop/reclaim window precedes any token — unlike a bare busy-status push, which
// a stop-before-token legitimately reclaims).
//
// We confirm the OLDEST pending echo only, ONCE per turn (chat.turnCommitted,
// re-armed at idle = turn boundary). The first token proves the FIFO-front
// message was received; it says NOTHING about a SECOND rapid send still sitting
// in Claude Code's native queue, which a stop-before-pickup can still discard —
// confirming it too would falsely mark it « ✓ envoyé » (the symmetric inverse of
// the original strand bug). That second echo confirms on ITS OWN turn's first
// token. We removed the earlier "confirmed-echo ring": the transcript always
// writes the `user` line BEFORE the assistant reply, so if a still-pending echo
// reaches here its line was dropped/forked and will NEVER arrive late — the ring
// only guarded a case that cannot happen, while letting a stale entry swallow a
// later identical terminal-typed message. We NEVER confirm on a timer or status
// push alone: a failed or stopped-before-token send produces no Claude output,
// so its echo correctly stays « ⋯ envoi » / is reclaimed.
function confirmSentEchoes(chat) {
  if (chat.turnCommitted || !chat.pendingSends.length) return;
  // R3: a turn already bound to a message confirmed by its user line must not promote a queued panel ask early
  if (replyState(chat).bound && chat.pendingSends[0].sink) return;
  const p = chat.pendingSends.shift(); // FIFO: the oldest echo = the message this turn answers
  p.el.classList.remove('chat-pending');
  const t = p.el.querySelector('time');
  if (t) t.textContent = '✓ envoyé';
  chat.turnCommitted = true; // one promotion per turn; idle re-arms for the next
  if (!replyState(chat).bound) bindReply(chat, p.sink, true);
}

// animate=false for the initial batch and resets: animating 600 cards at
// once is jank, not wow — only LIVE appends slide in.
function appendEvents(pane, events, animate) {
  const chat = pane.chat;
  if (!chat) return;
  if (events.length) setEmpty(chat, null);
  const frag = document.createDocumentFragment();
  let sawFinalText = false; // assistant prose with no tool after it (so far)
  let sawClaudeOutput = false; // v62: any Claude-authored event this batch (text/thinking/tool) = a turn COMMITTED to a user message
  for (const ev of events) {
    if (ev.kind === 'text' || ev.kind === 'thinking' || ev.kind === 'tool') sawClaudeOutput = true;
    if (animate && ev.kind === 'text') feedReply(chat, ev.text);
    // v45: the open-tools ledger IS the "what runs now" source — a tool_use
    // opens an entry, its paired result closes it (initial batch included:
    // a chat opened mid-dispatch shows the running agent immediately).
    if (ev.kind === 'tool' && ev.id) {
      chat.openTools.set(ev.id, {
        name: ev.name, agentType: ev.agentType || null, summary: ev.summary || '',
        ask: ev.ask || null, // v61: AskUserQuestion per-option previews (ask-panel mirror)
        askQuestions: ev.askQuestions || null, // v79: per-question shape (header/question/options), read-only overview
      });
      noteReportCard(chat, ev); // v81: Agent / SendMessage cards may receive a final report
      if (ev.name === 'Bash' && ev.bg) chat.bgShellCalls.set(ev.id, ev.summary || '');
      if (ev.agentType) {
        // v69: every agent dispatch enters the persistent bg roster. In this
        // harness EVERY Agent() runs async (its real completion lands later as a
        // <task-notification>), so — like a run_in_background row — it stays
        // « working » until its agentDone, never closed by the immediate ACK result.
        // v70: LIVE-ONLY. A rebuild/reload replays the bounded transcript tail with
        // animate=false; reconstructing « working » rows from history is unreliable —
        // a dispatch can sit inside the 4MB/600-event window while its completion
        // <task-notification> fell OUTSIDE it (or was never emitted at all: kill /
        // crash / a main-process without the prefix parse-fix), leaving a row stuck
        // « working » forever with nothing running (user repro: stale rows after
        // every reload). The deck only knows an agent's FULL lifecycle (dispatch ->
        // completion -> reap) when it observes BOTH live, so only live dispatches
        // enter the roster; a reload starts empty and refills from live appends.
        if (animate) chat.bgAgents.set(ev.id, { agentType: ev.agentType, summary: ev.summary || '', done: false, since: Date.now() }); // v71: since = idle-backstop clock
      }
      sawFinalText = false;
    } else if (ev.kind === 'result') {
      if (ev.toolUseId) {
        // v80: the launch ACK names its agent; keep agentId -> type while the dispatch's tool entry is still open.
        const launched = chat.openTools.get(ev.toolUseId);
        if (ev.agentId && launched && launched.agentType) {
          chat.agentInfoById.set(ev.agentId, { agentType: launched.agentType, summary: launched.summary || '', toolUseId: ev.toolUseId });
        }
        // A background shell counts as running only on a LIVE clean result (a replay cannot know whether it still runs);
        // a successful TaskStop names the task it ended. An unknown id or a failed stop carries no stoppedTaskId.
        if (chat.bgShellCalls.has(ev.toolUseId)) {
          const shellSummary = chat.bgShellCalls.get(ev.toolUseId);
          chat.bgShellCalls.delete(ev.toolUseId);
          if (animate && !ev.isError) chat.bgShells.set(ev.toolUseId, { summary: shellSummary, taskId: ev.bgTaskId || null });
        }
        if (ev.stoppedTaskId) {
          for (const [shellId, sh] of chat.bgShells) {
            if (sh.taskId === ev.stoppedTaskId) chat.bgShells.delete(shellId);
          }
        }
        chat.openTools.delete(ev.toolUseId);
        // v69: the bg roster closes ONLY on a genuine terminal signal — an errored
        // result (blocked dispatch: no <task-notification> will ever come to reap it).
        // A CLEAN result is the async ACK, NOT completion: leave it « working » until
        // its agentDone (mirrors the run_in_background guard above, for every agent).
        // v71: a real (non-ACK) result IS the completion for a NON-background agent
        // (its final message returns AS this result — no <task-notification> ever
        // comes), so reap the roster row now. Only a genuine async-launch ACK
        // (ev.ack) keeps it « working » until its agentDone. Errors still reap too.
        // L5: a result that ends its own dispatch (error or non-ACK) still ends the CARD (fillResult reads the flag).
        const ended = chat.bgAgents.get(ev.toolUseId);
        if (ended && (ev.isError || ev.ack === false)) ev.settledByResult = true;
        // L5: a row the lifecycle owns (`lc`, set by applyAgentState) is closed by its pushed `agentState` only, never by
        // this result nor by a notification. A row the lifecycle has not spoken for yet (or never will: the feed pushes
        // an id only while it is live or already sent) keeps the pre-L5 close, then the pty-death settle and the backstop.
        const ba = chat.bgAgents.get(ev.toolUseId);
        if (ba && !ba.lc && (ev.isError || ev.ack === false)) ba.done = true;
        // v80: a SendMessage that RESUMED a finished sub-agent (its harness-written result carries
        // resumedAgentId) starts a new run of that agent: no Agent dispatch, no launch ACK, so it never
        // reached the roster and the background-agent rules (idle arbiter, phantom reconciler) ignored it.
        // The row is keyed by this SendMessage call's id (the lifecycle names the run by it too).
        // Same LIVE-ONLY rule as a dispatch row (v70); a message to a peer or a running agent has no
        // resumedAgentId and opens nothing.
        if (ev.resumedAgentId && !ev.isError) {
          const known = chat.agentInfoById.get(ev.resumedAgentId);
          // L5: the call -> dispatch link (replay included), so the feed's event for this call id never makes a row
          if (known && known.toolUseId) chat.resumeOf.set(ev.toolUseId, known.toolUseId);
          if (animate) {
            chat.bgAgents.set(ev.toolUseId, {
              agentType: known ? known.agentType : 'agent relancé', // type unknown = the launch was outside this view's history
              summary: known ? known.summary : '',
              done: false, since: Date.now(),
            });
          }
        }
      }
    } else if (ev.kind === 'agentDone') {
      // v68: an agent's REAL completion — its <task-notification> (surfaced by
      // transcript.js normalizeLine), NOT the immediate ACK. The genuinely stuck
      // rows are the run_in_background:true ones: their tool_result ACK is left
      // « working » by the guard above. Flip here regardless of bg — for a bg row
      // this is the signal it waited for (v65 kept it working, the idle clear was
      // its only reaper until now); for a foreground row already done it is an
      // idempotent no-op.
      chat.bgShellCalls.delete(ev.toolUseId); // a background shell's notification ends it, any status
      chat.bgShells.delete(ev.toolUseId);
      const ba = chat.bgAgents.get(ev.toolUseId); // v69
      if (ba && !ba.lc) ba.done = true; // L5: a row the lifecycle owns (`lc`) closes by its `agentState` instead
      // v82: the same signal ends the CARD of that agent (`running` since its launch ACK, or still `pending`
      // when the notification beat the ACK): completed -> ok, failed -> error, any other or missing status ->
      // interrupted. LIVE-ONLY like the roster (a replayed notification must not rewrite history) and
      // idempotent (the 3 copies of one notification find a settled card and change nothing).
      // The run time is stamped in replay too (same transcript timestamps, same text as live): a card that
      // was settled by this very signal, or that kept a launch ACK. A foreground card has neither.
      const doneCard = chat.toolIndex.get(ev.toolUseId);
      if (doneCard) {
        const settled = animate && settleBgCard(doneCard, ev.status === 'completed' ? 'ok' : (ev.status === 'failed' ? 'error' : 'interrupted'), true);
        if (settled || doneCard.dataset.bgLaunch) stampBgRun(doneCard, ev.ts);
      }
    } else if (ev.kind === 'text') {
      sawFinalText = true;
    } else if (ev.kind === 'user') {
      // v69: « terminé until your next message » — a finished bg task stays visible
      // through the idle gap (the strip is long gone), then this next user turn reaps it.
      for (const [id, ba] of chat.bgAgents) {
        if (ba.done) chat.bgAgents.delete(id);
      }
      if (animate) {
        // a confirmed live user message = the REAL start of the current turn
        const t = ev.ts ? Date.parse(ev.ts) : NaN;
        chat.workSince = Number.isNaN(t) ? Date.now() : t;
      }
    }
    if (ev.kind === 'compact') {
      // A LIVE append over a deck-driven compaction is our resolution marker.
      // A non-animated batch (initial read / re-anchor reset) must NOT resolve
      // a live compaction (attack #3: a replayed historical boundary). And a
      // boundary landing AFTER the timeout already finalized the card must not
      // stack a second identical divider (attack #2) — dedupe on the same
      // outcome when the stream already ends on a matching compaction card.
      if (chat.compacting && animate) { resolveCompaction(pane, ev.canceled, ev.noop, frag); continue; }
      // v58: a native (Claude-decided) compaction shows the strip via the 'compacting'
      // status (PreCompact hook). The boundary is its deterministic 'done' signal —
      // clear the strip here too, so it never strands if no status push follows.
      if (animate && chat.lastStatus === 'compacting') { chat.lastStatus = 'idle'; refreshActivity(chat); }
      // v55: a no-op /compact (« Not enough messages ») that wasn't deck-driven
      // means nothing actually happened — no boundary to mark in the history.
      if (ev.noop) continue;
      const lastNode = frag.lastChild || chat.streamEl.lastElementChild;
      const wantClass = ev.canceled ? 'cc-canceled' : 'cc-done';
      const isDup = !!(lastNode && lastNode.classList
        && lastNode.classList.contains('chat-compact')
        && lastNode.classList.contains(wantClass));
      if (!isDup) { chat.turn = null; frag.appendChild(compactDivider(ev.canceled)); }
      continue;
    }
    if (ev.kind === 'result') {
      fillResult(chat, ev);
      continue;
    }
    // v81: a sub-agent's final report (queued hand-back message) — state only, renders no card of its own.
    if (ev.kind === 'agentReport') { noteAgentReport(chat, ev); continue; }
    // L5: the agent lifecycle from the feed (state only, renders no card of its own).
    if (ev.kind === 'agentState') { applyAgentState(chat, ev); continue; }
    // a prompt typed while Claude was busy has no `user` line: its queued_command attachment is the receipt of the
    // matching pending send (state only, renders no card); unmatched (already promoted, or typed in the terminal) it
    // still starts a new message, like an unclaimed `user` line, so it ends the bound sink's turn
    if (ev.kind === 'queuedPrompt') {
      if (!resolvePending(chat, ev) && animate) endReply(chat);
      continue;
    }
    if (ev.kind === 'user') {
      if (resolvePending(chat, ev)) continue;
      if (animate) endReply(chat); // a user line nobody here sent (or already promoted) ends the bound sink's turn
    }
    // v50: /goal lifecycle — 'goalhook' is state-only (auto-clear arbiter); a
    // 'goal' set flips the footer on AND drops a confirmation chip, 'clear' is
    // footer-only. Everything else falls through to the normal renderer.
    if (ev.kind === 'goalhook') { applyGoalHook(pane, chat, ev); continue; }
    // v73: state-only, like goalhook — the « /model » confirmation drives the
    // badge through session-context, opens no turn and renders no card.
    if (ev.kind === 'modelSet') continue;
    if (ev.kind === 'goal') {
      applyGoalEvent(chat, ev);
      if (ev.action !== 'set') continue;
    }
    const card = renderEvent(chat, ev, pane);
    if (!card) continue;
    if (animate) card.classList.add('anim');
    const role = ev.kind === 'user' ? 'user' : 'assistant';
    // new turns land in the fragment; an open same-role turn (already in the
    // DOM or in the fragment) is returned by turnFor without touching sink
    turnFor(chat, role, ev.ts, animate, frag).appendChild(card);
    if (role === 'assistant') noteTurnEvent(chat, ev, card);
    // B9: each prose response carries its own copy button.
    if (ev.kind === 'text') noteCopyable(card, ev);
  }
  if (frag.childNodes.length) chat.streamEl.appendChild(frag);
  syncFoldAll(chat);
  // v62 (user repro « bloqué en envoi alors que le terminal l'a déjà envoyé »):
  // live Claude output is proof the turn COMMITTED to the user's message — a
  // turn past its first token can no longer be un-done by a stop (the
  // stop/reclaim window precedes any token). So an echo still stranded in
  // « ⋯ envoi » because its transcript `user` line was dropped by the reader
  // (isMeta / USER_NOISE_RE wrapper) is promoted to « ✓ envoyé » here. Gated on
  // `animate`: the initial batch / re-anchor rebuild must never confirm a
  // historical echo. Conflict-free with the stop machinery, unlike a bare
  // busy-status push (which a stop-before-token legitimately reclaims).
  if (animate && sawClaudeOutput) confirmSentEchoes(chat);
  if (chat.atBottom) scrollBottom(chat);
  if (animate && events.length) {
    scanAsk(pane); // v46: AskUserQuestion/ExitPlanMode may just have landed
    // live activity: any append proves claude moved — un-settle, re-label;
    // a batch ENDING on prose with zero open tools arms the settle fallback
    // (the turn is probably over even if the status file went stale).
    chat.settled = false;
    clearTimeout(chat.settleId);
    chat.settleId = null;
    if (sawFinalText && chat.openTools.size === 0) {
      chat.settleId = setTimeout(() => {
        chat.settleId = null;
        // v46.4: prose + no open tools is NOT conclusive — claude often
        // thinks long between a mid-turn answer and its next move (user
        // repro: the strip vanished on every inter-response think). Same
        // fused signals as the downgrade arbiter (review finding: the
        // streaming phase shows NO spinner — only the flow says running).
        if (!pane.el.classList.contains('exited')
            && (screenSaysBusy(pane, chat) || ptyFresh(chat))) return;
        if (chat.openTools.size === 0) {
          chat.settled = true;
          refreshActivity(chat);
        }
      }, SETTLE_MS);
    }
  }
  refreshActivity(chat);
  refreshTasks(chat); // v69: persistent bg-agent roster, independent of the busy-gated strip
}

// ---------------------------------------------------------------------------
// Activity indicator (v44, rebuilt v45) — two sources fused:
//   • status pushes (deck-status hook) say WHETHER claude runs (busy/idle —
//     and the queue still drains on real idle pushes only);
//   • the transcript's open-tools ledger says WHAT runs — named sub-agents
//     (« Agent kt-explore — Scan du module »), the running tool otherwise,
//     « Claude réfléchit » between tools (the hook has no PostToolUse
//     granularity on older installs — the ledger does).
// Plus a live elapsed timer (1s tick, only while the strip shows) and the
// settle fallback: final prose + zero open tools → hide after SETTLE_MS even
// if the status file went stale (hook died mid-session, missed write…).
// ---------------------------------------------------------------------------

const BUSY_STATUSES = new Set(['working', 'running', 'waiting', 'compacting']); // v58: a native (Claude-decided) compaction is a busy period too
const SETTLE_MS = 4000;
const ASK_POLL_MS = 1200; // v46: TUI screen scan cadence (chat face only)
const ASK_RESCAN_MS = 350; // v46: post-keystroke scan (show the consequence fast)
const DEFAULT_PLACEHOLDER = 'Écris à Claude… @ fichiers, / commandes';

function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

// What the strip says: waiting wins (the user is the blocker), then whether
// a tool is running, then the generic thinking line.
function activityLine(chat) {
  // v46.9.3: the user just asked for the interrupt — say so NOW, animation
  // off (a strip still pulsing « Claude réfléchit » after the stop click is
  // what drove the rage re-presses).
  if (stopPending(chat)) {
    return { ico: '⏹', label: 'Interruption demandée…', detail: '', dots: false };
  }
  if (chat.compacting || chat.lastStatus === 'compacting') { // v58: deck-button OR native (PreCompact-hook 'compacting' status)
    return { ico: '\u{1F5DC}', label: 'Compactage de la conversation…', detail: '', dots: true };
  }
  if (chat.lastStatus === 'waiting') {
    // v46: the ask panel now mirrors the menu — the terminal is a fallback
    return { ico: '⏳', label: 'Attend ta réponse — menu ci-dessous ou terminal', detail: '', dots: false };
  }
  const open = [...chat.openTools.values()];
  if (open.length) {
    // v53 (user): the strip no longer MIRRORS the running tool + its command
    // (« ⚡ Bash <cmd> ») — the chat stream already renders that as a tool card,
    // so repeating it in the status band is pure duplication. Just say claude is
    // working (state, not « what ») — the band keeps its at-a-glance value (live
    // timer + dots) without echoing the discussion.
    return { icon: 'hammer', label: 'Claude travaille…', detail: '', dots: true };
  }
  return { icon: 'brain', label: 'Claude réfléchit', detail: '', dots: true };
}

function updateSendButton(chat) {
  // v46.1: claude.ai reflex — the send button is a STOP while claude works
  // (waiting included: Esc dismisses the pending menu). Enter still queues.
  // v46.9.3: a pending stop flips it back to send IMMEDIATELY — the user's
  // action must register before the status file catches up.
  const busy = (chat.compacting || BUSY_STATUSES.has(chat.lastStatus)) && !stopPending(chat);
  chat.sendEl.classList.toggle('is-stop', busy);
  chat.sendEl.title = busy
    ? 'Interrompre Claude (Échap)'
    : 'Envoyer (Entrée). La saisie passe par le PTY, comme au clavier.';
}

function refreshActivity(chat) {
  if (!chat) return;
  updateSendButton(chat); // before any early-return: the button always tracks
  updateCompactBtn(chat); // v46.9.8: the compact button tracks busy too
  const busy = chat.compacting || BUSY_STATUSES.has(chat.lastStatus);
  // settle only mutes the stale-prone states — waiting stays visible (it
  // reports the USER as the blocker, prose can't conclude that turn).
  const turnVisible = chat.lastStatus === 'waiting' || (busy && !chat.settled);
  // Running background shells keep the strip up (alone at idle, under the turn line otherwise).
  const shellCount = chat.bgShells.size;
  const visible = turnVisible || shellCount > 0;
  if (!visible) {
    chat.activityEl.hidden = true;
    if (chat.stripTicking) {
      chat.stripTicking = false;
      tickStop(chat);
    }
    return;
  }
  const shellLabel = `${shellCount} shell${shellCount > 1 ? 's' : ''} en cours`;
  const shellTexts = [...chat.bgShells.values()].map((s) => s.summary).filter(Boolean).join(' · ');
  let line;
  if (!turnVisible) {
    line = { icon: 'terminal', label: shellLabel, detail: shellTexts, dots: false };
  } else {
    line = activityLine(chat);
    if (shellCount) line = { ...line, detail: shellTexts ? `${shellLabel} : ${shellTexts}` : shellLabel };
  }
  chat.activityEl.hidden = false;
  chat.activityEl.dataset.status = chat.lastStatus;
  // The strip refreshes on a timer: rebuild the icon only when it really changes.
  const icoEl = chat.activityEl.querySelector('.ca-ico');
  const icoKey = line.icon || line.ico;
  if (icoEl.dataset.key !== icoKey) {
    icoEl.dataset.key = icoKey;
    if (line.icon) {
      icoEl.dataset.icon = line.icon;
      icoEl.replaceChildren(lucideIcon(`lc-${line.icon}`));
    } else {
      delete icoEl.dataset.icon;
      icoEl.textContent = line.ico;
    }
  }
  chat.activityEl.querySelector('.ca-label').textContent = line.label;
  const det = chat.activityEl.querySelector('.ca-detail');
  det.textContent = line.detail;
  det.hidden = !line.detail;
  chat.activityEl.querySelector('.ca-dots').hidden = !line.dots;
  if (!turnVisible) { // shell-only line: no turn clock
    setTextIfChanged(chat.activityEl.querySelector('.ca-timer'), '');
    if (chat.stripTicking) {
      chat.stripTicking = false;
      tickStop(chat);
    }
    return;
  }
  tickTimer(chat);
  if (!chat.stripTicking) {
    chat.stripTicking = true;
    tickStart(chat);
  }
}

// Every DOM write on a periodic path goes through here: a textContent set
// replaces the text node even with an identical string, which invalidates
// layout and costs a frame — compare first, write only on a real change.
function setTextIfChanged(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

function tickTimer(chat) {
  setTextIfChanged(chat.activityEl.querySelector('.ca-timer'),
    chat.workSince ? fmtElapsed(Date.now() - chat.workSince) : '');
}

// ONE shared 1 s ticker for every chat's elapsed text (activity strip + goal
// footer). It used to be one setInterval per chat per timer: N chats at N
// different phases meant N style/layout/paint frames per second. Now a single
// callback walks the ticking chats, writes only the texts that actually
// changed (setTextIfChanged), and skips chats whose face is hidden — the
// terminal face is showing, the chat DOM is display:none (askPolling is the
// « chat face shows » flag). startAskPoll re-syncs the texts when the face
// comes back. The interval lives only while at least one chat needs it.
const TICKING_CHATS = new Set();
let tickHandle = null;
function tickAll() {
  for (const chat of TICKING_CHATS) {
    if (!chat.askPolling) continue;
    if (chat.stripTicking) tickTimer(chat);
    if (chat.goalTicking) tickGoalTimer(chat);
  }
}
function tickStart(chat) {
  TICKING_CHATS.add(chat);
  if (tickHandle === null) tickHandle = setInterval(tickAll, 1000);
}
// Called AFTER the chat's own flag (stripTicking / goalTicking) was cleared:
// the chat leaves the set only once it has no ticking text left.
function tickStop(chat) {
  if (chat.stripTicking || chat.goalTicking) return;
  TICKING_CHATS.delete(chat);
  if (TICKING_CHATS.size === 0 && tickHandle !== null) {
    clearInterval(tickHandle);
    tickHandle = null;
  }
}

// v69: the PERSISTENT « Tâches » roster — background/async agents that outlive
// their dispatching turn. Unlike refreshActivity (which HIDES the strip the moment
// the session goes idle), this section is gated ONLY on chat.bgAgents being
// non-empty, so a backgrounded agent (a proposal-review, an async fan-out) stays
// visible WHILE the main session sits idle — exactly when it is actually running.
// Rebuilt flat, same reasoning as the strip tree (a handful of rows, no diffing).
function refreshTasks(chat) {
  const el = chat.tasksEl;
  if (!el) return;
  // L5 K1: unknown is rendered nowhere. One row per agent: a resume call's row yields to its dispatch's row while that one exists.
  const agents = [...chat.bgAgents].filter(([id, a]) => a.state !== 'unknown' && !chat.bgAgents.has(chat.resumeOf.get(id))).map(([, a]) => a);
  // v70: a FRESH roster re-folds by default — reset here when it empties, so the
  // next batch of tasks starts folded again — « plié par défaut » holds per fresh
  // roster, not only until first expand.
  if (!agents.length) { chat.tasksTreeCollapsed = null; el.hidden = true; stopTasksReaper(chat); return; }
  el.hidden = false;
  startTasksReaper(chat); // v71: idle backstop while the roster shows rows
  const list = el.querySelector('.ctk-list');
  list.textContent = '';
  for (const a of agents) {
    const row = document.createElement('div');
    row.className = 'ctk-row' + (a.done ? ' ctk-done' : '') + (a.state === 'waiting' ? ' ctk-waiting' : '');
    const branch = document.createElement('span');
    branch.className = 'ctk-branch';
    branch.textContent = '⎿';
    const name = document.createElement('span');
    name.className = 'ctk-name';
    name.textContent = a.agentType;
    row.append(branch, name);
    if (a.summary) {
      const sum = document.createElement('span');
      sum.className = 'ctk-sum';
      sum.textContent = a.summary;
      row.appendChild(sum);
    }
    const state = document.createElement('span');
    state.className = 'ctk-state';
    state.textContent = a.state === 'closed' ? 'interrompu' : (a.done ? 'terminé' : (a.state === 'waiting' ? 'en attente' : 'working')); // K1
    row.appendChild(state);
    list.appendChild(row);
  }
  // v70: fold by default like the activity working-tree. null = auto-folded; an
  // explicit header click holds. ▸ N carries the WORKING count when folded (a
  // roster padded with « terminé » rows doesn't inflate it); ▾ when expanded.
  const collapsed = chat.tasksTreeCollapsed === null
    ? true
    : chat.tasksTreeCollapsed;
  list.hidden = collapsed;
  const caret = el.querySelector('.ctk-caret');
  caret.hidden = false;
  const workingCount = agents.reduce((n, a) => n + (a.done ? 0 : 1), 0);
  caret.textContent = collapsed ? `▸ ${workingCount}` : '▾';
  // v71: while >=1 task is still working, the always-visible header caret breathes
  // (ctk-live -> ct-pulse in the stylesheet) so a FOLDED roster still signals live
  // work at a glance; « ▸ 0 » / all-terminé clears the class and the caret stays static.
  el.querySelector('.ctk-head').classList.toggle('ctk-live', workingCount > 0);
}

// v71: idle backstop for the roster. The reap fix above closes a NON-background
// agent on its real tool_result; a run_in_background:true agent still reaps only
// on its <task-notification> (agentDone). If that signal is ever lost (kill,
// crash, resume-fork re-anchor, a notification that fell outside the tailed
// window) the row would hang « working » forever with nothing running. So while
// the roster is non-empty a low-frequency tick marks done any « working » row
// that has outlived IDLE_REAP_MS WHILE the session sits idle. A bg agent runs
// DURING idle, so the grace is deliberately generous to keep false reaps rare; a
// reload re-derives the truth anyway. Marks done (not delete) -> the normal
// « terminé until your next message » lifecycle reaps it on the next user turn.
const TASKS_REAP_TICK_MS = 30 * 1000;
// v72: 5 min reaped LIVE agents (measured n=411: p99 18.8 min, max 35.6 min —
// 189/411 dispatches ran past 5 min). 60 min covers the measured max with
// margin while staying stale-state cleanup, never completion detection.
const IDLE_REAP_MS = 60 * 60 * 1000;
function reapStaleTasks(chat) {
  if (BUSY_STATUSES.has(chat.lastStatus)) return; // session active: live signals still own the reap
  const now = Date.now();
  let changed = false;
  for (const [id, ba] of chat.bgAgents) {
    if (ba.lc) continue; // L5: the lifecycle owns this row (it ends with its own state, never with a clock guess)
    if (!ba.done && typeof ba.since === 'number' && now - ba.since > IDLE_REAP_MS) {
      ba.done = true;
      changed = true;
      // v82: the lost close signal also ends the row's card (`running` -> `interrupted`, no pulse): the
      // card mirrors its row. Only a `running` card moves; a settled one is left alone. No `bgFinal`: the
      // reap is a guess, not a verdict, so a live agentDone that still comes may lift the card (settleBgCard).
      const staleCard = chat.toolIndex.get(id);
      if (staleCard) settleBgCard(staleCard, 'interrupted', false);
    }
  }
  // v72: a reap can drop the LAST working row — the band (gated on the union,
  // see refreshActivity) must hide too, not just the roster.
  if (changed) { refreshTasks(chat); refreshActivity(chat); }
}
function startTasksReaper(chat) {
  if (!chat.tasksReapId) chat.tasksReapId = setInterval(() => reapStaleTasks(chat), TASKS_REAP_TICK_MS);
}
function stopTasksReaper(chat) {
  if (chat.tasksReapId) { clearInterval(chat.tasksReapId); chat.tasksReapId = null; }
}

// ---------------------------------------------------------------------------
// TUI interaction (v46) — the chat face answers claude's blocking prompts.
// Every claude code prompt (tool permission, AskUserQuestion, plan approval,
// trust dialog…) is a numbered menu rendered in the UNDERLYING terminal of
// the same pane; readTui() parses it from the xterm buffer and the panel
// above the composer mirrors it as buttons. A click types the option NUMBER
// into the PTY — exactly the keystroke the TUI expects. While a menu is up
// the composer is disabled: free text would be eaten by the menu as
// keyboard shortcuts. The poll only runs while the pane shows its chat face
// (terminal face = the user answers the real menu directly).
// ---------------------------------------------------------------------------

function sendKey(pane, data) {
  if (pane.el.classList.contains('exited')) return;
  window.api.writeInput(pane.paneId, data);
  setTimeout(() => scanAsk(pane), ASK_RESCAN_MS);
}

// Arrow-navigate an Ink select widget (AskUserQuestion) to `delta` rows away
// then commit with Enter. Synthetic keys to the REAL TUI need spacing — a
// single burst write risks Ink/React batching every key in one tick, so Enter
// could commit the PRE-move selection (attacker pre-mortem #3). cycleToMode
// already paces Shift+Tab at 320ms for the same reason; cursor moves are
// cheaper, so a lighter step suffices. Each writeInput is its own PTY data
// event, and the gap is designed to avoid coalescing (write-side; a blocked
// reader can still batch — real-Ink acceptance is the user live test). Fire-
// and-forget; the
// trailing scanAsk reconciles the panel once the menu closes.
const ARROW_STEP_MS = 70;
async function navigateAndSelect(pane, delta) {
  const step = delta > 0 ? '\x1b[B' : '\x1b[A'; // ↓ / ↑
  for (let i = 0; i < Math.abs(delta); i++) {
    if (pane.el.classList.contains('exited')) return;
    window.api.writeInput(pane.paneId, step);
    await new Promise((r) => setTimeout(r, ARROW_STEP_MS));
  }
  if (pane.el.classList.contains('exited')) return;
  window.api.writeInput(pane.paneId, '\r'); // Enter commits the highlighted row
  setTimeout(() => scanAsk(pane), ASK_RESCAN_MS);
}

// v46.9.3 — STOP feedback (user repro: Esc/stop in the gap between the user
// message and claude's first token left the UI lying 'working' for ~10s —
// no transcript trace, no Stop hook, only the slow phantom reconcile). The
// deck KNOWS the user asked for the interrupt — it sent the Esc itself:
// (1) react optimistically NOW (button + strip, zero wait), (2) fast-track
// the phantom reconcile (one quiet sighting, no grace/confirm, arbiter
// bypassed — the post-Esc redraw is not work), (3) SWALLOW rage re-presses
// during the window: a second Esc would reach the TUI as DOUBLE-Esc = the
// rewind picker, invisible from the chat face. Self-correcting: if claude
// actually keeps working, the next hook write re-busies the strip and the
// swallow window expires — a later Esc passes again.
const STOP_SWALLOW_MS = 4000; // optimistic UI + rage-press swallow
const STOP_HINT_MS = 10000; // reconcile fast-track (grace/confirm skip)
const STOP_FRESH_MS = 2500; // post-Esc redraw window: ptyFresh + arbiter bypass
function stopPending(chat) {
  return !!chat.stopRequested && Date.now() - chat.stopRequested < STOP_SWALLOW_MS;
}
function stopHinted(chat) {
  return !!chat.stopRequested && Date.now() - chat.stopRequested < STOP_HINT_MS;
}
// Review attack #4: ignoring ptyFresh for the whole 10s hint would
// reintroduce the spinner-less streaming false-idle (2.1.167 removes the
// spinner during streaming — the flow is the only busy signal). Only the
// brief post-Esc REDRAW window may override it: past 2.5s, a pumping pty
// means claude really kept going and the reconcile must hold.
function stopFresh(chat) {
  return !!chat.stopRequested && Date.now() - chat.stopRequested < STOP_FRESH_MS;
}
// v53: the interrupt's deferred reclaim polls until the screen is provably
// quiet rather than firing once. AFTER_STOP = the initial beat (TUI restore +
// pickup-push settle); POLL = re-check cadence while output still flows;
// MAX_WAIT = give up (claude genuinely kept going — its turn will confirm).
const RECLAIM_AFTER_STOP_MS = 650;
const RECLAIM_POLL_MS = 400;
const RECLAIM_MAX_WAIT_MS = 4000;
// v55: gap held AFTER a send's CR before the next chained send pastes, so the
// TUI has submitted+cleared its input box first. Rapid sends (composer fired
// faster than this) used to paste/CR on top of each other -> the TUI merged or
// dropped one -> its optimistic echo stranded in « … envoi » forever (user repro).
const SEND_GAP_MS = 200; // conservative margin for the real TUI to submit+clear its box (the fake-PTY probe proves write ORDER, not this latency — validate live)
const UNBRACKETED_CR_MS = 90; // when bracketed paste is OFF (or ignoreBracketedPasteMode is true), a CR bundled into the SAME unbracketed chunk as the pasted text lands as a literal newline inside Claude Code's input box, not a submit (code read, Claude Code 2.1.280). A lone CR written after a short settle DOES submit — parity with the PTY-side room delivery queue's own settle-then-CR shape (src/main/rooms.js:434-446, `ROOM_SUBMIT_DELAY_MS` = 90 at src/main/config.js:85). Must stay < SEND_GAP_MS (200) so sendNow's chained sends still serialize AFTER this CR, not concurrently with it.
// Re-open 2 (stuck-send safety net) [MEASURED on a real claude TUI]:
// 2 stucks on bracketed+cr / modeAtWrite:on carried ONE extra
// leading newline (Claude Code took the submit CR as "insert newline" before
// the pasted text landed) — ~2/83 mapped sends; a manual lone Enter released
// them. RETRY_CHECK_MS is the delay after the submitting write before the
// FIRST fail-closed read (R1-R8, spec § Amendment — Re-open 2) of the composer
// box; the read fires a single extra '\r' only if the box still shows the sent
// text/placeholder with no menu open.
// Re-open 3 (retry poll) [MEASURED docs/plans/claude-deck-send-retry-poll.spec.md]:
// the 4 live stuck sends of 2026-10-08 never got their retry from the single
// read at +1.2 s (a screen guard was false then), so the read now REPEATS every
// RETRY_POLL_MS until RETRY_DEADLINE_MS after the arm and fires at the first
// read where every guard passes (still at most ONE retry per send). Only a
// terminal state ends the poll early; a poll that reaches the deadline without
// firing traces ONE `retry-skip` row naming the last failing guard.
const RETRY_CHECK_MS = 1200;
const RETRY_POLL_MS = 500;
const RETRY_DEADLINE_MS = 6000; // measured from the arm (the submitting write), not from the first read
const CLEAR_PASTE_MS = 200; // v57: gap after a hard Ctrl+C clear so the TUI repaints its emptied (possibly multi-row) restored box before the paste lands. Parity with SEND_GAP_MS — a too-tight margin reintroduces the very concatenation this fixes (whole-buffer clear is heavier than a line kill, and the CPU is busy tearing down the just-interrupted turn).

// Submit shape depends on bracketed-paste mode. [MEASURED on a real claude TUI]
// ANY gap between the
// bracketed-paste write and the lone '\r' write left clean-box sends stuck
// (text + line break in the TUI box) 4/8; zero gap submitted 10/10. So the
// BRACKETED branch folds paste+CR into ONE write: it reproduces the exact
// bytes xterm's own paste() emits (prepareTextForTerminal's \r?\n -> \r, then
// the \x1b[200~...\x1b[201~ bracket — @xterm/xterm 5.5.0,
// node_modules/@xterm/xterm/lib/xterm.js module 3614), appends the submit
// '\r' to that SAME string, and fires it through term.input(data, true),
// which calls the identical coreService.triggerDataEvent(data, true) that
// paste() uses internally — one onData firing, one IPC write via
// panes.js:68's `term.onData((data) => window.api.writeInput(paneId, data))`.
//
// F3 (review USER DECISION F3 / spec § Amendment F3, user repro "corrige ca bug" 2026-09-23): Claude Code
// resets terminal mode 2004 on raw-mode exit, so bracketedPasteMode can be OFF
// at submit time (or the terminal is configured to ignore it via
// ignoreBracketedPasteMode). A code read of Claude Code 2.1.280 shows a CR
// bundled into the SAME unbracketed chunk as multi-char text is inserted as a
// literal newline, not treated as submit — exactly what the single-write
// shape above would send for this case, reproducing the user's stuck-send
// symptom. So the UNBRACKETED branch reverts to the pre-fix TWO-write shape:
// the prepared text alone, then the CR on its own after UNBRACKETED_CR_MS,
// past the TUI's paste-coalescing window.
// Re-open 2 retry check helpers -----------------------------------------
// stripRetryWs: drop invisible C0 controls THEN collapse ALL whitespace (not
// just runs, unlike the confirmation-path normText above) — the composer box
// can re-wrap the sent text over several rows, so comparing tails must ignore
// exactly where a wrap or a space landed, never just how many spaces there are.
const stripRetryWs = (s) => String(s).replace(CTRL_STRIP_RE, '').replace(/\s+/g, '');
const PASTE_PLACEHOLDER_RE = /\[Pasted text #\d+/;

// fireRetryCheck: ONE fail-closed (R7) read of the stuck-send guards, called
// once per tick of scheduleRetryCheck's poll. Every read (pane state, menu,
// composer box) happens in this same synchronous tick, right before the
// tagged write, so nothing observed here can go stale before the write fires.
// Returns:
//   RETRY_FIRED - every guard passed and the single tagged '\r' was written;
//   RETRY_END   - a TERMINAL state (pane exited, stop, echo already confirmed):
//                 the poll stops at once, with no trace row;
//   otherwise one RE-CHECK reason ('menu' | 'box-hidden' | 'box-empty' |
//   'no-match' | 'error'): the box may simply not be drawn yet, so the poll
//   reads again until its deadline. A thrown error (a read or the write
//   itself) is a re-check reason too — ambiguity never triggers the retry, and
//   a write that threw was never dispatched, so it cannot double the CR.
// `diag` receives lengths and geometry ONLY (never the text) for the
// `retry-skip` row.
const RETRY_FIRED = 'fired';
const RETRY_END = 'end';
function fireRetryCheck(pane, text, stillPending, epoch, diag) {
  try {
    diag.boxLen = 0;
    if (pane.el.classList.contains('exited')) return RETRY_END;
    const chat = pane.chat;
    if (!chat || chat.dirtyAfterStop || chat.stopRequested !== 0) return RETRY_END; // an interrupt restored the prompt into the box — firing would RE-SUBMIT it
    if (chat.stopEpoch !== epoch) return RETRY_END; // R9: a stop landed after THIS send was submitted (during the unbracketed CR delay or the send-chain wait) — stopRequested/dirtyAfterStop may already be cleared by a later sendNow/idle push, but stopEpoch never is
    if (stillPending && !stillPending()) return RETRY_END; // sendNow: its echo already confirmed — nothing to rescue
    diag.rows = pane.term.rows;
    diag.cols = pane.term.cols;
    if (readTui(pane.term).menu) return 'menu';
    const box = readComposerBox(pane.term);
    diag.boxLen = box.text.length;
    if (!box.visible) return 'box-hidden';
    if (!box.text.trim()) return 'box-empty';
    const normBox = stripRetryWs(box.text);
    const normSent = stripRetryWs(text);
    const tail = normSent.slice(Math.max(0, normSent.length - 40));
    const matchesTail = tail.length > 0 && normBox.includes(tail);
    const matchesPlaceholder = PASTE_PLACEHOLDER_RE.test(box.text);
    if (!matchesTail && !matchesPlaceholder) return 'no-match';
    window.api.writeInput(pane.paneId, '\r', 'retry-cr');
    return RETRY_FIRED;
  } catch (_) {
    return 'error'; // fail-closed — never a guess
  }
}

// scheduleRetryCheck: arms the retry poll at the submitting write (R1). The
// first read lands RETRY_CHECK_MS after the arm, then one every RETRY_POLL_MS
// with the last read pinned at RETRY_DEADLINE_MS; it fires the retry CR at the
// first read where fireRetryCheck's guards all pass, so at most ONE retry per
// send (the poll stops there). A terminal verdict (RETRY_END) ends it with no
// row; a poll that reaches the deadline appends ONE `retry-skip` trace row
// naming the last re-check reason (renderer -> main send-only channel, the
// diagnostic send trace). Returns a Promise<boolean> (never rejects) resolved
// when the poll ends, with whether it fired the retry CR.
function scheduleRetryCheck(pane, text, stillPending, epoch) {
  return new Promise((resolve) => {
    const armedAt = performance.now();
    const diag = { boxLen: 0, rows: 0, cols: 0 };
    const tick = () => {
      const verdict = fireRetryCheck(pane, text, stillPending, epoch, diag);
      if (verdict === RETRY_FIRED) { resolve(true); return; }
      if (verdict === RETRY_END) { resolve(false); return; }
      const elapsed = performance.now() - armedAt;
      if (elapsed >= RETRY_DEADLINE_MS) {
        try {
          window.api.traceRetrySkip({
            paneId: pane.paneId,
            guard: verdict,
            boxLen: diag.boxLen,
            rows: diag.rows,
            cols: diag.cols,
            elapsedMs: Math.round(elapsed),
          });
        } catch (_) { /* diagnostic only — never affects the send */ }
        resolve(false);
        return;
      }
      setTimeout(tick, Math.max(1, Math.min(RETRY_POLL_MS, RETRY_DEADLINE_MS - elapsed)));
    };
    setTimeout(tick, RETRY_CHECK_MS);
  });
}

// submitPasted(pane, text, stillPending?) -> Promise<boolean fired>. The
// first write(s) are byte- and timing-identical to the pre-Re-open-2 shape
// (R6); the only addition is the later R2-gated retry check armed right
// after the submitting write (bracketed: this single write; unbracketed: the
// delayed lone CR). `stillPending` is an optional predicate — sendNow passes
// one (its optimistic echo may confirm before the check runs); the 6
// slash-command sites pass none (R2 "stillPending absent or true").
function submitPasted(pane, text, stillPending) {
  const term = pane.term;
  // R9: captured BEFORE any write, so a stop landing during the unbracketed
  // 90ms CR delay (or a later sendNow's send-chain wait) is also caught —
  // fireRetryCheck compares this against chat.stopEpoch at fire time.
  const epoch = pane.chat ? pane.chat.stopEpoch : 0;
  const prepared = text.replace(/\r?\n/g, '\r'); // xterm's prepareTextForTerminal
  const bracketed = term.modes.bracketedPasteMode && term.options.ignoreBracketedPasteMode !== true;
  if (bracketed) {
    term.input('\x1b[200~' + prepared + '\x1b[201~' + '\r', true);
    return scheduleRetryCheck(pane, text, stillPending, epoch);
  }
  term.input(prepared, true);
  return new Promise((resolve) => {
    setTimeout(() => {
      if (pane.el.classList.contains('exited')) { resolve(false); return; } // pane closed during the settle — no write, no check
      try {
        window.api.writeInput(pane.paneId, '\r');
      } catch (_) {
        /* pty gone */
        resolve(false);
        return;
      }
      scheduleRetryCheck(pane, text, stillPending, epoch).then(resolve);
    }, UNBRACKETED_CR_MS);
  });
}

// v53: pull every UNCONFIRMED optimistic send back into the composer and clear
// the TUI's restored/stranded copy with ONE Ctrl+C, so the next send cannot
// CONCATENATE with an invisible leftover in claude's input box. Shared by the
// busy->idle reconcile (a stop the status file confirmed) and the interrupt's
// own deferred reclaim (robust when a late 'working' pickup push wiped
// stopRequested before the idle landed). Idempotent + guarded: a no-op when
// nothing is pending, when the user is mid-draft, or on a dead/exited pane.
function reclaimPendingSends(pane) {
  const chat = pane.chat;
  if (!chat || !chat.pendingSends.length) return;
  if (chat.inputEl.value) return; // never clobber a draft the user is typing
  if (pane.el.classList.contains('exited')) return;
  const texts = chat.pendingSends.map((p) => p.text);
  for (const p of chat.pendingSends) {
    callSink(p.sink, 'cancelled');
    const turn = p.el.closest('.chat-turn');
    p.el.remove();
    if (turn && !turn.querySelector('.chat-turn-body').childElementCount) {
      if (chat.turn && chat.turn.body === turn.querySelector('.chat-turn-body')) {
        chat.turn = null; // the open turn died — next card opens a fresh one
      }
      turn.remove();
    }
  }
  chat.pendingSends = [];
  chat.inputEl.value = texts.join('\n\n');
  autosize(chat.inputEl);
  chat.inputEl.focus();
  window.api.writeInput(pane.paneId, '\x03');
  chat.dirtyAfterStop = false; // v57: reclaim already hard-cleared the TUI box with this Ctrl+C — don't let the next send fire a 2nd Ctrl+C
}

function interruptClaude(pane) {
  const chat = pane.chat;
  if (!chat) return;
  if (stopPending(chat)) return; // one Esc is enough — swallow the re-press
  chat.stopRequested = Date.now();
  endReply(chat, true); // R3: the interrupted turn's sink ends cancelled
  chat.stopEpoch = (chat.stopEpoch || 0) + 1; // R9: proves to a later fireRetryCheck that a NEW stop landed for THIS send, even after stopRequested/dirtyAfterStop got cleared by an intervening sendNow or idle push
  // v57 (review attack #3): arm the hard-clear ONLY when a turn could actually be
  // interrupted-and-restored — Claude busy, or a send still pending. A reflex Esc on
  // an idle, EMPTY box would otherwise arm dirty with no reclaim/TTL to reset it, and
  // the next send's Ctrl+C would hit an empty box -> exit-confirm armed -> a later
  // Esc/Ctrl+C could quit Claude Code. Erring toward NOT arming = residual concat at
  // worst, never a lost session.
  if (chat.pendingSends.length || BUSY_STATUSES.has(chat.lastStatus)) {
    chat.dirtyAfterStop = true; // Esc restores the in-flight prompt into Claude Code's input box -> the next send must hard-clear it or it concatenates
  }
  sendKey(pane, '\x1b');
  updateSendButton(chat); // instant feedback — not the next 1.2s poll
  refreshActivity(chat);
  // v53 (user repro « stop trop tôt »): a stop with UNCONFIRMED sends means the
  // message may be stranded in claude's input box — pasted, but the turn was
  // interrupted before its first token, so claude restores the text there. The
  // busy->idle reconcile pulls it back, but a late 'working' PICKUP push can
  // wipe stopRequested before that idle lands (stop faster than the pickup) and
  // defeat it — then the leftover CONCATENATES with the next send. Belt-and-
  // braces: reclaim it DIRECTLY once the screen is provably quiet. We POLL (not
  // one fixed beat): a one-shot can land on a noisy instant — a spinner frame
  // still in ptyFresh's window, even from a just-ended PRIOR turn — and bail
  // forever. The poll waits that out, fires the moment output stops, and gives
  // up past RECLAIM_MAX_WAIT_MS (claude genuinely kept going — then the send is
  // its turn and confirms on its own). The live-flow signal is ptyFresh: a
  // running turn never stalls output for ≥PTY_QUIET_MS (capture-proven), so
  // !ptyFresh = the stop took (or the turn never started). A menu still blocks
  // (Ctrl+C there would dismiss it).
  if (chat.pendingSends.length) {
    clearTimeout(chat.reclaimId);
    const startedAt = Date.now();
    const tryReclaim = () => {
      chat.reclaimId = null;
      if (!pane.chat || !chat.pendingSends.length || chat.inputEl.value) return; // resolved / mid-draft
      if (Date.now() - startedAt > RECLAIM_MAX_WAIT_MS) return; // claude kept going
      if (ptyFresh(chat) || readTui(pane.term).menu) { // still busy / on a menu — re-check
        chat.reclaimId = setTimeout(tryReclaim, RECLAIM_POLL_MS);
        return;
      }
      reclaimPendingSends(pane);
    };
    chat.reclaimId = setTimeout(tryReclaim, RECLAIM_AFTER_STOP_MS);
  }
}

function menuSig(menu) {
  return menu.question + '||' +
    menu.options.map((o) => `${o.n}:${o.label}`).join('|');
}

// What KIND of prompt is on screen? The open-tools ledger knows — the
// tool_use hits the transcript BEFORE its menu shows. waiting + an open
// tool = a permission gate on that tool; no hint = some other TUI menu
// (trust dialog, theme picker, /command picker…).
function askKind(chat) {
  const open = [...chat.openTools.values()];
  if (open.some((t) => t.name === 'AskUserQuestion')) {
    return { ico: '❓', label: 'Question de Claude' };
  }
  if (open.some((t) => t.name === 'ExitPlanMode')) {
    return { ico: '\u{1F4CB}', label: 'Approbation du plan' };
  }
  if (chat.lastStatus === 'waiting' && open.length) {
    return { ico: '\u{1F510}', label: `Permission — ${open[open.length - 1].name}` };
  }
  return { ico: '☰', label: 'Menu du terminal' };
}

// The AskUserQuestion tool_use (transcript) carries each option's preview; the
// scraped menu does not. Find the open AskUserQuestion's ask[] (stored in the
// ledger) and index it by trimmed label so the panel can mirror the side
// preview the TUI shows for the highlighted option.
//
// v79 (T2 fold A4): a label DUPLICATED across questions with a DIFFERENT
// preview must resolve to the question the overview marks as current
// (chat.askCurrentQIndex, set by updateAskOverview right before this runs),
// not first-wins across the whole flattened ask[] — first-wins could show
// question 2's preview while question 1 is on screen. A label that is unique,
// or repeated with the SAME preview everywhere, keeps the harmless first-wins
// entry untouched.
function askEntriesByQuestion(t) {
  // ask[] (askOptions — flattened, no question boundaries) and askQuestions
  // (structured) are built from the SAME input.questions in the SAME order
  // with the SAME malformed-entry skip (see the header comment above
  // askQuestions() in transcript-normalize.js), so slicing ask[] by
  // cumulative askQuestions[j].options.length recovers which question each
  // flattened option came from.
  const out = [];
  let offset = 0;
  for (let j = 0; j < t.askQuestions.length; j++) {
    const opts = t.askQuestions[j].options;
    for (let k = 0; k < opts.length; k++) {
      const o = t.ask[offset + k];
      if (o) out.push({ o, qIndex: j });
    }
    offset += opts.length;
  }
  return out;
}
function askPreviewLookup(chat) {
  for (const t of chat.openTools.values()) {
    if (t.name !== 'AskUserQuestion' || !Array.isArray(t.ask) || !t.ask.length) continue;
    const m = new Map();
    // first-wins on cross-question duplicate labels (Map.set would overwrite =
    // last-wins); the scraped menu is one question, first match is the safer default.
    for (const o of t.ask) { const k = String(o.label).trim(); if (!m.has(k)) m.set(k, o); }
    if (Array.isArray(t.askQuestions) && t.askQuestions.length >= 2) {
      const byQ = askEntriesByQuestion(t);
      const byLabel = new Map(); // label -> Map(qIndex -> preview of the FIRST entry seen for that question)
      for (const { o, qIndex } of byQ) {
        const k = String(o.label).trim();
        let g = byLabel.get(k);
        if (!g) { g = new Map(); byLabel.set(k, g); }
        if (!g.has(qIndex)) g.set(qIndex, o.preview || '');
      }
      const qi = chat.askCurrentQIndex;
      for (const [label, byQIdx] of byLabel) {
        if (new Set(byQIdx.values()).size <= 1) continue; // same preview everywhere (or one question only) — first-wins is fine
        if (qi >= 0 && byQIdx.has(qi)) {
          const entry = byQ.find((e) => e.qIndex === qi && String(e.o.label).trim() === label);
          if (entry) { m.set(label, entry.o); continue; }
        }
        m.delete(label); // ambiguous label, no unique current-question match -> no preview for it
      }
    }
    return m;
  }
  return null;
}

// v79 (ask-all-questions, lot 2): the open AskUserQuestion's structured
// per-question shape (ledger field askQuestions, from src/main/
// transcript-normalize.js) — the source for the overview block. Distinct
// lookup from askPreviewLookup: that one needs ask[] (flattened, for
// previews), this needs the question boundaries.
function openAskQuestionsEntry(chat) {
  for (const [id, t] of chat.openTools) {
    if (t.name === 'AskUserQuestion' && Array.isArray(t.askQuestions) && t.askQuestions.length) {
      return { id, t };
    }
  }
  return null;
}

const ASK_WS_RE = /\s+/g;
function normAsk(s) {
  return String(s || '').replace(ASK_WS_RE, ' ').trim();
}

// Contract 5 — the Submit screen (claude's "review before sending every
// answer" step) is a distinct scraped shape, checked BEFORE the suffix match
// in rule 4 so it can never be mistaken for a genuine question sharing its
// wording: recap state, no question marked as current.
function isAskSubmitScreen(menu) {
  // endsWith, not ===: parseTuiMenu's scrape can join up to 3 content lines
  // (e.g. real capture "Review your answers ⚠ You have not answered all
  // questions Ready to submit your answers?" — the marker is the tail).
  const q = normAsk(menu.question);
  if (q.endsWith('Review your answers') || q.endsWith('Ready to submit your answers?')) return true;
  const labels = menu.options.map((o) => normAsk(o.label));
  return labels.includes('Submit answers') && labels.includes('Cancel');
}

// Contract 4 (T2 fold A1) — parseTuiMenu keeps the LAST <= 3 content lines
// above the option run and stops at a blank line (tui-prompt.js:131-143), so
// the scrape is always a SUFFIX of the real question (or of its last
// paragraph). Fail-closed (T2 reviewer decision, option B): a scrape that is
// a suffix of zero or >= 2 questions marks nothing rather than guess — no
// exact-first shortcut.
function matchCurrentQuestion(askQuestions, menu) {
  const scraped = normAsk(menu.question);
  if (!scraped) return -1;
  let hit = -1;
  let hits = 0;
  for (let i = 0; i < askQuestions.length; i++) {
    if (normAsk(askQuestions[i].question).endsWith(scraped)) { hit = i; hits++; }
  }
  return hits === 1 ? hit : -1;
}

// Contract 3 — textContent only, no listener on any overview item; the
// existing option buttons (built by renderAsk below) are the only answer path.
function renderAskOverview(ovEl, askQuestions, curIdx) {
  ovEl.querySelector('.cov-title').textContent = `Toutes les questions (${askQuestions.length})`;
  const listEl = ovEl.querySelector('.cov-list');
  listEl.textContent = '';
  askQuestions.forEach((q, i) => {
    const qEl = document.createElement('div');
    qEl.className = 'cov-q' + (i === curIdx ? ' cov-current' : '');
    if (q.header) {
      const h = document.createElement('div');
      h.className = 'cov-q-header';
      h.textContent = q.header;
      qEl.appendChild(h);
    }
    const t = document.createElement('div');
    t.className = 'cov-q-text';
    t.textContent = q.question;
    qEl.appendChild(t);
    const optsEl = document.createElement('div');
    optsEl.className = 'cov-q-opts';
    for (const o of q.options) {
      const oEl = document.createElement('div');
      oEl.className = 'cov-opt';
      const lab = document.createElement('span');
      lab.className = 'cov-opt-label';
      lab.textContent = o.label;
      oEl.appendChild(lab);
      if (o.description) {
        const d = document.createElement('span');
        d.className = 'cov-opt-desc';
        d.textContent = o.description;
        oEl.appendChild(d);
      }
      optsEl.appendChild(oEl);
    }
    qEl.appendChild(optsEl);
    listEl.appendChild(qEl);
  });
}

// Contract 6 (T2 fold A2) — computed on EVERY scanAsk, BEFORE the sig-based
// early return: startAskPoll can scan before transcriptSubscribe fills the
// ledger (:3142 races :2939), and the post-batch rescan (:2982) then hits the
// same-sig early return right when askQuestions just landed — this function
// runs unconditionally so the overview still appears on that rescan, with no
// tab change. Keyed on (tool id, askQuestions.length, current idx|'recap'|
// 'none'); rebuilds the DOM only when the key actually changes.
function updateAskOverview(chat, menu) {
  const found = openAskQuestionsEntry(chat);
  const ovEl = chat.askEl.querySelector('.chat-ask-overview');
  if (!found || found.t.askQuestions.length < 2) {
    // Contract 3: block absent for < 2 questions (incl. no open AskUserQuestion).
    if (!ovEl.hidden) ovEl.hidden = true;
    chat.askOverviewKey = null;
    chat.askCurrentQIndex = -1;
    return;
  }
  const { id, t } = found;
  const submit = isAskSubmitScreen(menu);
  const curIdx = submit ? -1 : matchCurrentQuestion(t.askQuestions, menu);
  chat.askCurrentQIndex = submit ? -1 : curIdx; // A4: askPreviewLookup reads this
  const curKey = submit ? 'recap' : (curIdx < 0 ? 'none' : String(curIdx));
  const key = id + '|' + t.askQuestions.length + '|' + curKey;
  if (key === chat.askOverviewKey) return;
  chat.askOverviewKey = key;
  renderAskOverview(ovEl, t.askQuestions, curIdx); // curIdx stays -1 (no match) on recap too — none marked
  ovEl.hidden = false;
}

// Show `label`'s preview in the ask-panel pane (Option 1), or hide it when the
// option has no preview / the data is unavailable (non-preview questions, or a
// menu that is not an AskUserQuestion). Plain textContent — never HTML — so a
// preview can hold arbitrary code/markup safely.
function updateAskPreview(chat, label) {
  const prevEl = chat.askEl.querySelector('.chat-ask-preview');
  if (!prevEl) return;
  const look = askPreviewLookup(chat);
  const entry = look && look.get(String(label || '').trim());
  const txt = entry ? (entry.preview || '') : '';
  if (txt) {
    prevEl.querySelector('.cap-head').textContent = entry.label;
    prevEl.querySelector('.cap-body').textContent = txt;
    prevEl.hidden = false;
    chat.askPreviewShown = String(label || '').trim(); // for the poll change-check
  } else {
    prevEl.hidden = true;
    chat.askPreviewShown = null;
  }
}

function renderAsk(pane, menu, nav) {
  const chat = pane.chat;
  const exited = pane.el.classList.contains('exited');
  if (!menu || exited) {
    if (!chat.askEl.hidden) {
      chat.askEl.hidden = true;
      chat.askSig = null;
      chat.askOverviewKey = null; // v79
      chat.askCurrentQIndex = -1; // v79
      chat.askHovering = false; // N1: menu closed — clear any stuck hover/focus flag
      if (!exited) setComposerDisabled(chat, false, DEFAULT_PLACEHOLDER);
    }
    return;
  }
  // The kind refreshes on EVERY scan: the first scan can run before the
  // subscribe primed lastStatus (startChat is async) — a same-sig early
  // return must not freeze « Menu du terminal » on what IS a permission.
  const kind = askKind(chat);
  chat.askEl.querySelector('.cak-ico').textContent = kind.ico;
  chat.askEl.querySelector('.cak-label').textContent = kind.label;
  // v79 (Contract 6): computed on EVERY scan, before the sig early return
  // below — see updateAskOverview's header comment for why.
  updateAskOverview(chat, menu);
  const sig = menuSig(menu);
  if (sig === chat.askSig && !chat.askEl.hidden) {
    // same menu, maybe a moved ❯ (arrow keys in the terminal): restyle only
    const btns = chat.askEl.querySelectorAll('.cao-btn');
    menu.options.forEach((o, i) => {
      if (btns[i]) btns[i].classList.toggle('cao-sel', o.selected);
    });
    // preview follows a ❯ moved via terminal arrows — but NOT while the user
    // hovers an option (would clobber what they read every 1.2s poll, #2), only
    // on an ACTUAL selection change, and only for the arrow-nav menu on screen
    // (a number/permission menu must never surface a stale ask preview, #3).
    const moved = menu.options.find((o) => o.selected);
    const movedLabel = moved ? String(moved.label).trim() : null;
    if (nav === 'arrows' && !chat.askHovering && movedLabel && movedLabel !== chat.askPreviewShown) {
      updateAskPreview(chat, moved.label);
    }
    return;
  }
  chat.askSig = sig;
  chat.askEl.classList.remove('answered');
  chat.askEl.querySelector('.cak-q').textContent = menu.question;
  const optsEl = chat.askEl.querySelector('.chat-ask-opts');
  optsEl.textContent = '';
  chat.askHovering = false; // N1: new menu — stale hover/focus state died with the old buttons
  // ≤9 options only: a two-digit pick would fire on its first digit.
  for (const o of menu.options.filter((x) => x.n <= 9)) {
    const btn = document.createElement('button');
    btn.className = 'cao-btn' + (o.selected ? ' cao-sel' : '');
    const num = document.createElement('span');
    num.className = 'cao-num';
    num.textContent = String(o.n);
    btn.appendChild(num);
    btn.appendChild(document.createTextNode(o.label));
    if (o.desc) btn.title = o.desc;
    btn.dataset.optLabel = o.label;
    const hover = () => { if (nav === 'arrows') { chat.askHovering = true; updateAskPreview(chat, o.label); } };
    btn.addEventListener('mouseenter', hover);
    btn.addEventListener('focus', hover);
    btn.addEventListener('blur', () => { chat.askHovering = false; }); // N1: symmetric to focus

    btn.addEventListener('click', () => {
      // Review attack #4: the screen may have moved since the last poll —
      // a bare digit typed into a DIFFERENT menu could approve something
      // the user never saw. Re-read NOW; on mismatch refresh, never type.
      const tui = readTui(pane.term);
      const now = tui.menu;
      if (!now || menuSig(now) !== chat.askSig) {
        scanAsk(pane);
        return;
      }
      chat.askEl.classList.add('answered'); // optimistic — the scan confirms
      if (tui.nav === 'arrows') {
        // AskUserQuestion (claude >= 2.x) is an arrow-navigated widget: the
        // digit is not bound, so typing the number no-op'd (user repro). Move
        // the ❯ from its CURRENT row (re-read, the user may have arrowed in the
        // terminal) to the target, then Enter. menuSig ignores ❯ position, so
        // these self-sent arrows never trip the guard above on the next poll.
        const cur = now.options.findIndex((x) => x.selected);
        const curIdx = cur < 0 ? 0 : cur;
        const targetIdx = now.options.findIndex((x) => x.n === o.n);
        if (targetIdx < 0) { scanAsk(pane); return; }
        navigateAndSelect(pane, targetIdx - curIdx);
      } else {
        sendKey(pane, String(o.n)); // permission/plan picker: digit selects
      }
    });
    optsEl.appendChild(btn);
  }
  // preview pane (Option 1): ONLY for the arrow-nav widget actually on screen
  // (nav==='arrows') — a number/permission menu must never surface a stale ask
  // preview even on a label collision (#3). Selected option's preview by
  // default; hover updates; revert to selected on leave.
  if (nav === 'arrows') {
    const selOpt = menu.options.find((o) => o.selected) || menu.options[0];
    updateAskPreview(chat, selOpt ? selOpt.label : '');
  } else {
    updateAskPreview(chat, null); // hides the pane
  }
  optsEl.onmouseleave = () => {
    chat.askHovering = false;
    const sel = optsEl.querySelector('.cao-btn.cao-sel') || optsEl.querySelector('.cao-btn');
    if (nav === 'arrows') updateAskPreview(chat, sel ? sel.dataset.optLabel : '');
  };
  chat.askEl.hidden = false;
  setComposerDisabled(chat, true, 'Un menu attend ta réponse — réponds ci-dessus');
}

function setModeBadge(chat, mode) {
  // v46.2: label matches the TUI footer wording (« auto-accept edits on »)
  // Runs on every TUI scan: an unchanged mode must cost zero DOM writes (a
  // same-string textContent set still replaces the node and invalidates layout).
  const label = mode === 'accept-edits' ? 'auto-accept' : (mode === 'bypass' ? 'bypass' : mode);
  setTextIfChanged(chat.modeBadgeEl, label == null ? '' : String(label));
  if (chat.modeBadgeEl.dataset.mode === String(mode)) return; // items already restyled for this mode
  chat.modeBadgeEl.dataset.mode = mode;
  for (const it of chat.modeMenuEl.querySelectorAll('.cc-mode-item')) {
    it.classList.toggle('active', it.dataset.mode === mode);
  }
}

// v46.1: the TUI has no "set mode" — only the Shift+Tab CYCLE. Picking a
// mode in the dropdown cycles step by step, re-reading the footer between
// keystrokes, until the footer matches; a full lap (back to the starting
// mode) means the target is unreachable here (e.g. auto not eligible) —
// stop honestly, the badge shows where the session actually landed.
// v46.3 (user repro): the badge used to REPLAY every hop (normal →
// auto-accept → plan read as a one-by-one switch) — it now shows the
// TARGET immediately, pending-styled, and the landing scan settles the
// truth. Cycling INTO auto can pop the one-time opt-in menu — that is an
// interjection, not a miss: stop cycling, mirror the menu, let the user
// answer it.
const MODE_CYCLE_STEP_MS = 320;
const MODE_CONFIRM_MS = 300; // second read before trusting a full-lap bail
async function cycleToMode(pane, target) {
  const chat = pane.chat;
  if (!chat || chat.modeCycling) return;
  if (pane.el.classList.contains('exited')) return;
  chat.modeCycling = true;
  // A second pick while a cycle is in flight would be swallowed by the
  // re-entrance guard — make the wait VISIBLE: items disabled, not lossy.
  chat.modeMenuEl.classList.add('cycling');
  setModeBadge(chat, target);
  chat.modeBadgeEl.classList.add('cc-mode-pending');
  let reached = false;
  let interjected = false; // a TUI menu popped mid-cycle (auto opt-in)
  try {
    const start = readTui(pane.term).mode;
    let cur = start;
    if (cur === target) { reached = true; return; }
    for (let i = 0; i < 6; i++) {
      window.api.writeInput(pane.paneId, '\x1b[Z');
      await new Promise((r) => setTimeout(r, MODE_CYCLE_STEP_MS));
      if (!pane.chat) return; // pane closed mid-cycle
      const seen = readTui(pane.term);
      if (seen.menu) { interjected = true; return; }
      cur = seen.mode;
      if (cur === target) { reached = true; return; }
      if (cur === start && i >= 1) {
        // Review attack #2: 'normal' is ALSO the parser's fallback while the
        // footer redraws — a transient read must not pass for a full lap.
        // Confirm on a second read before bailing.
        await new Promise((r) => setTimeout(r, MODE_CONFIRM_MS));
        if (!pane.chat) return;
        const again = readTui(pane.term);
        if (again.menu) { interjected = true; return; }
        cur = again.mode;
        if (cur === target) { reached = true; return; }
        if (cur === start) break; // confirmed full lap — target unreachable
      }
    }
  } finally {
    chat.modeCycling = false;
    chat.modeMenuEl.classList.remove('cycling');
    chat.modeBadgeEl.classList.remove('cc-mode-pending');
    if (pane.chat) {
      if (!reached && !interjected) {
        // Review attack #5: a silent revert reads as a broken toggle — flash
        // the badge so the user SEES where the cycle actually landed.
        chat.modeBadgeEl.classList.add('cc-mode-miss');
        setTimeout(() => chat.modeBadgeEl.classList.remove('cc-mode-miss'), 1500);
        // v46.2: remember it — a full lap proved this target is not in THIS
        // session's cycle. Grey the item out with the reason instead of
        // letting the pick fail again.
        chat.modeUnreachable.add(target);
        for (const it of chat.modeMenuEl.querySelectorAll('.cc-mode-item')) {
          if (it.dataset.mode !== target) continue;
          it.classList.add('unreachable');
          it.title = 'Inatteignable dans cette session — le cycle Shift+Tab complet ne propose pas ce mode'
            + (target === 'auto'
              ? ' (auto mode : compte/modèle non éligible, ou opt-in refusé « don’t ask again »)'
              : '');
        }
      }
      scanAsk(pane); // settles the badge on the REAL footer mode
    }
  }
}

// One scan: read the screen once, refresh the mode badge, sync the panel,
// reconcile a phantom-busy status. While a cycle is in flight the badge
// shows the pending TARGET — intermediate footer reads must not flicker
// through it (v46.3 user repro: « on dirait il switch un par un »).
function scanAsk(pane) {
  const chat = pane.chat;
  if (!chat || !chat.askEl) return;
  chat.scanSeq = chat.ptySeq; // the poll skips until the PTY writes again
  chat.lastScanAt = Date.now();
  if (pane.el.classList.contains('exited')) {
    renderAsk(pane, null);
    return;
  }
  const { menu, mode, busy, nav } = readTui(pane.term);
  if (busy) chat.lastBusyScreen = Date.now(); // blink memory for the arbiter
  if (!chat.modeCycling) setModeBadge(chat, mode);
  renderAsk(pane, menu, nav);
  reconcilePhantomBusy(pane, chat, menu, busy);
  reconcileWaitingGone(pane, chat.lastStatus); // A2(a): every scan of the chat face feeds the menu-gone check
}

// « Menu gone » reconciler (bug: the banner « Attend ta réponse » and the chat
// queue stayed stuck on a stale `waiting` after the user answered a menu).
// The status file says `waiting` (Notification hook) but nothing in it says the
// menu was ANSWERED; the terminal knows. Once the menu is off the screen and
// the composer box is back, tell main (statusMenuGone) — it restores the status
// held before the menu (markMenuGone) and the usual status push follows, so the
// banner, the sidebar badge and the room gate all clear together.
//  - "Gone" = NO menu read AND the composer box visible. "No menu read" alone
//    is NOT proof (a menu taller than the window parses as no menu), while a
//    blocking menu REPLACES the composer (tui-prompt.js header), so a visible
//    composer is positive proof that no blocking menu is up.
//  - Two "gone" reads MENU_GONE_CONFIRM_MS apart (one timeout, no interval)
//    before the report; seenAt = ms epoch of the FIRST gone read, which main
//    uses to refuse a `waiting` record written after it (another menu).
//    Any read that is not "gone" resets the state.
//  - Once reported, the pane stays quiet until the status leaves `waiting` or
//    a non-gone read resets it; a report main refused (status still `waiting`
//    while the screen stays "gone") is retried after MENU_GONE_REFIRE_MS.
// Needs only the pane (term, paneId, sessionId, el) and the status — NEVER the
// chat DOM — so any trigger can feed it: scanAsk today (also reached by every
// status push, see cvNotifySessionStatus), the pty-data path of panes whose
// chat face is hidden next. State lives in a WeakMap, not on pane.chat.
const MENU_GONE_CONFIRM_MS = 400;
const MENU_GONE_REFIRE_MS = 3000;
const menuGoneState = new WeakMap(); // pane -> { firstAt, timer, firedAt, status }

function paneExited(pane) {
  return !!(pane.el && pane.el.classList && pane.el.classList.contains('exited'));
}

function menuGoneRead(pane) {
  try {
    return !readTui(pane.term).menu && readComposerBox(pane.term).visible;
  } catch (_) {
    return false; // torn-down terminal: never a guess
  }
}

function dropMenuGone(pane) {
  const st = menuGoneState.get(pane);
  if (!st) return;
  clearTimeout(st.timer);
  menuGoneState.delete(pane);
}

function confirmMenuGone(pane, st) {
  st.timer = null;
  if (menuGoneState.get(pane) !== st) return; // reset while the timeout was pending
  // A pane with a chat owns the freshest status; a chat-less pane falls back
  // on the last status its caller passed in.
  const status = pane.chat ? pane.chat.lastStatus : st.status;
  if (status !== 'waiting' || !pane.term || paneExited(pane) || !menuGoneRead(pane)) {
    menuGoneState.delete(pane);
    return;
  }
  st.firedAt = Date.now();
  try {
    window.api.statusMenuGone({ paneId: pane.paneId, sessionId: pane.sessionId || null, seenAt: st.firstAt });
  } catch (e) { console.error('cv menu-gone:', e); }
}

export function reconcileWaitingGone(pane, status) {
  if (!pane) return;
  if (status !== 'waiting' || !pane.term || paneExited(pane) || !menuGoneRead(pane)) {
    dropMenuGone(pane); // not waiting / dead pane / menu (or unproven) on screen: reset
    return;
  }
  let st = menuGoneState.get(pane);
  if (!st) {
    st = { firstAt: 0, timer: null, firedAt: 0, status };
    menuGoneState.set(pane, st);
  }
  st.status = status;
  if (st.timer) return; // the confirm read is already scheduled
  const now = Date.now();
  if (st.firedAt && now - st.firedAt < MENU_GONE_REFIRE_MS) return; // reported: wait for the status push
  st.firstAt = now;
  st.timer = setTimeout(() => confirmMenuGone(pane, st), MENU_GONE_CONFIRM_MS);
}

// v46.4 — the downgrade arbiter's view of the screen. Instantaneous busy
// wins; otherwise a busy sighting under BUSY_BLINK_MS ago still counts:
// ink briefly CLEARS the spinner while committing scrolled prose to the
// scrollback (capture-replay finding — mid-stream blink frames), and an
// idle push landing exactly on such a blink must not slip through. A
// visible menu always reads quiet (claude legitimately paused).
const BUSY_BLINK_MS = 2500;
function screenSaysBusy(pane, chat) {
  const tui = readTui(pane.term);
  if (tui.menu) return false;
  if (tui.busy) {
    chat.lastBusyScreen = Date.now();
    return true;
  }
  return !!chat.lastBusyScreen && Date.now() - chat.lastBusyScreen < BUSY_BLINK_MS;
}

// v46.4 liveness: PTY output fresher than this = claude is doing SOMETHING.
// Capture-proven (timing log /tmp/tui-timing.txt): a turn never pauses its
// output for ≥1.5s (spinner animation + counters), and a session at rest
// emits strictly nothing — EXCEPT while a BACKGROUND sub-agent is live.
// Measured on the real deck 2026-09-30: with the status file at idle/Stop the
// pts mtime kept advancing at every sample (8 s granularity, one sampling gap);
// what the TUI redraws was not captured. With a live background agent
// PTY freshness is therefore NOT proof of MAIN activity: the idle arbiter
// (cvNotifySessionStatus) and the phantom-busy reconciler
// (reconcilePhantomBusy) both defer to the screen spinner / status file then
// (onlyBackgroundWorkLive). This signal needs no wording, no locale, no
// version knowledge — it covers the streaming phase where 2.1.167 removes
// the spinner line entirely (capture-replay finding: ~10s gaps).
const PTY_QUIET_MS = 2500;
function ptyFresh(chat) {
  return !!chat.lastPtyData && Date.now() - chat.lastPtyData < PTY_QUIET_MS;
}

// The main has NO tool of its own in flight and a sub-agent is still working in
// the background. chat.bgAgents holds EVERY agent dispatch, foreground ones
// included — a foreground row stays live until its non-ACK result — so a live
// row alone proves nothing: while the main waits on a FOREGROUND tool/agent its
// tool_use sits in chat.openTools (set on the tool_use, deleted on its result,
// rebuilt on a reset). A background dispatch has had its async ACK result by
// the time the turn ends, so openTools is empty there. Both conditions together
// = the only live work is a background agent. Live-only state — see the
// bgAgents notes at the dispatch branch (appendEvents) and the reset branch
// (notifyTranscriptAppend).
function onlyBackgroundWorkLive(chat) {
  if (chat.openTools.size > 0) return false;
  for (const ba of chat.bgAgents.values()) {
    if (!ba.done) return true;
  }
  return false;
}

// v46.3 — THE stop fix (user repro 2026-06-06): an interrupt BEFORE the
// first token leaves NO transcript trace — no '[Request interrupted…]'
// marker, no Stop hook — so the v46.2 marker detector has nothing to read
// and the status file lies 'working' until the 5min fossil guard (frozen
// stop button, dead queue). The TUI screen is the only living truth:
// claude renders '(esc to interrupt)' whenever it actually runs. Status
// busy + no hint + no menu (a menu pauses claude legitimately:
// AskUserQuestion, permission gate) held over a confirm window → ask main
// to flip the file to idle. Self-correcting by design: if claude actually
// works, its very next hook write re-busies the file — hooks always win.
// 'waiting' is excluded: it reports the USER as the blocker, and its menu
// may legitimately be scrolled out of the parse window.
const PHANTOM_GRACE_MS = 3000; // ignore the spinner's render lag at turn start
const PHANTOM_CONFIRM_MS = 1500; // ≥ one full poll cycle between sightings
// Confirm window for a phantom that stands ONLY through the background-only clause
// (pty fresh, no stop window, live bg row, no open tool of the main). Basis: the
// only measured spinner-less streaming gap is the ~10 s capture-replay finding
// cited at PTY_QUIET_MS; 20 s is twice that — a judgment value, NOT a measured bound.
const PHANTOM_BG_CONFIRM_MS = 20000;
function reconcilePhantomBusy(pane, chat, menu, busy) {
  // A live PTY flow is NEVER phantom — during response streaming 2.1.167
  // removes the spinner line entirely, but the output keeps flowing.
  // v46.9.3: a user-initiated stop (Esc sent by the deck itself) fast-tracks
  // everything — the post-Esc redraw IS the pty freshness, not work, and one
  // quiet sighting is proof enough; grace/confirm exist for AMBIENT lies,
  // not for an interrupt the user explicitly asked for.
  const hinted = stopHinted(chat);
  // Background-only exception (same discriminator as the idle arbiter in
  // cvNotifySessionStatus): while the ONLY live work is a background sub-agent
  // (a working roster row AND no open tool of the main) PTY freshness is not
  // proof of MAIN activity — the agent's row keeps the pty fresh — and the
  // status file cannot age either: the hook `touch`es it on every sub-agent
  // tool event, so max(ts, mtime) stays fresh. A main turn that ended WITHOUT a
  // Stop hook (traceless interrupt) would then keep the busy status for as long
  // as the agent runs. `!busy` (no spinner / live counter on screen) and `!menu`
  // stay REQUIRED: a main that visibly runs keeps the strip busy.
  // But this clause gives up the streaming protection above (a live pty flow is
  // never phantom): a main that streams prose with no spinner while a background
  // agent redraws looks exactly like a finished one, and the reconcile WRITES
  // idle/UserInterrupt to the status file (sidebar badge, room delivery,
  // notifications). A phantom that stands ONLY through this clause
  // therefore waits PHANTOM_BG_CONFIRM_MS (phantomBgSince = start of the current
  // continuous bg-only stretch: a stretch that starts on the quiet path never
  // shortens it). The stopFresh / quiet-pty paths keep the short window, and a
  // stretch that began bg-only and turns quiet/stopFresh may use it too — that
  // window is measured from phantomSince (the start of the WHOLE phantom stretch),
  // so the first quiet sighting fires once that stretch is PHANTOM_CONFIRM_MS old. A deck
  // STOP (hinted, 10 s) stays fast-tracked on every path: the user asked for it.
  const viaQuiet = stopFresh(chat) || !ptyFresh(chat);
  const viaBg = !viaQuiet && onlyBackgroundWorkLive(chat);
  const phantom = !busy && !menu && (viaQuiet || viaBg)
    && (chat.lastStatus === 'working' || chat.lastStatus === 'running');
  if (!phantom) {
    chat.phantomSince = null;
    chat.phantomBgSince = null;
    return;
  }
  const now = Date.now();
  if (!hinted && chat.workSince && now - chat.workSince < PHANTOM_GRACE_MS) {
    // A new prompt opened the grace window: a background-only stretch that straddles it must not resume its
    // old PHANTOM_BG_CONFIRM_MS clock afterwards (the stretch is re-timed from the first sighting past the grace).
    chat.phantomBgSince = null;
    return;
  }
  if (viaBg) { if (!chat.phantomBgSince) chat.phantomBgSince = now; } else chat.phantomBgSince = null;
  if (!chat.phantomSince) {
    chat.phantomSince = now;
    if (!hinted) return; // hinted: this very sighting is the confirmation
  }
  if (!hinted && now - (viaBg ? chat.phantomBgSince : chat.phantomSince)
      < (viaBg ? PHANTOM_BG_CONFIRM_MS : PHANTOM_CONFIRM_MS)) return;
  chat.phantomSince = null;
  chat.phantomBgSince = null;
  // The screen has been provably quiet for the whole confirm window — drop
  // the blink memory so the idle push this reconcile triggers is not
  // refused by the arbiter on a stale 'recent busy' sighting.
  chat.lastBusyScreen = 0;
  window.api.statusReconcileIdle({ paneId: pane.paneId, sessionId: pane.sessionId });
}

// ONE shared poll for every chat face (was one setInterval per chat). A tick
// only scans a chat when something can have changed since its last scan —
// the screen moves only when the PTY writes, so an idle chat costs an integer
// compare, not a buffer walk. Scan (a due chat) when:
//   - the PTY wrote since the last scan (ptySeq moved; also covers the debounce
//     starving under continuous spinner output), or
//   - a mirrored menu is up (its ledger/overview is fed by transcript events
//     that arrive without any PTY write — the « late ledger » case), or
//   - the status says working/running: the phantom-busy reconcile is driven by
//     elapsed time on a SILENT screen, so it needs ticks with no PTY data, or
//   - ASK_IDLE_FALLBACK_MS elapsed (resize reflow, anything screen-side that
//     wrote nothing).
const ASK_IDLE_FALLBACK_MS = 5000;
const ASK_POLL_PANES = new Set();
let askPollHandle = null;
function askPollDue(chat, now) {
  return chat.ptySeq !== chat.scanSeq
    || !chat.askEl.hidden
    || chat.lastStatus === 'working' || chat.lastStatus === 'running'
    || now - chat.lastScanAt >= ASK_IDLE_FALLBACK_MS;
}
function askPollTick() {
  const now = Date.now();
  for (const pane of ASK_POLL_PANES) {
    const chat = pane.chat;
    if (!chat || !chat.askPolling) { ASK_POLL_PANES.delete(pane); continue; }
    if (!askPollDue(chat, now)) continue;
    try { scanAsk(pane); } catch (e) { console.error('cv ask poll:', e); } // one pane never starves the others
  }
  if (ASK_POLL_PANES.size === 0 && askPollHandle !== null) {
    clearInterval(askPollHandle);
    askPollHandle = null;
  }
}

function startAskPoll(pane) {
  const chat = pane.chat;
  if (!chat || chat.askPolling) return;
  chat.askPolling = true;
  ASK_POLL_PANES.add(pane);
  if (askPollHandle === null) askPollHandle = setInterval(askPollTick, ASK_POLL_MS);
  // The shared 1s ticker skipped this chat while its face was hidden — bring
  // the elapsed texts current before the first paint of the face.
  if (chat.stripTicking) tickTimer(chat);
  if (chat.goalTicking) tickGoalTimer(chat);
  scanAsk(pane);
}

function stopAskPoll(pane) {
  const chat = pane && pane.chat;
  if (!chat) return;
  chat.askPolling = false;
  ASK_POLL_PANES.delete(pane);
  if (ASK_POLL_PANES.size === 0 && askPollHandle !== null) {
    clearInterval(askPollHandle);
    askPollHandle = null;
  }
  clearTimeout(chat.dataScanId); // a scheduled data-scan dies with the face
  chat.dataScanId = null;
}

// Routed by boot.js from the raw PTY output stream (review attack #3): a
// menu is a SCREEN redraw, not a transcript event — without this hook the
// panel waited for the next 1.2s poll. Debounced: output streams in bursts.
const DATA_SCAN_MS = 300;
export function cvNotifyPtyData(paneId) {
  const pane = panes.get(paneId);
  const chat = pane && pane.chat;
  if (!chat) return;
  // v46.4 liveness: claude's spinner ANIMATES — a running turn emits PTY
  // output continuously (timing capture: ≥700B/s every second of a turn,
  // strict zero at rest, statusline included). The timestamp feeds the
  // status arbiters; it is recorded even when the chat face is hidden —
  // status pushes arrive on the terminal face too.
  chat.lastPtyData = Date.now();
  chat.ptySeq++; // the shared poll scans only while this moves
  if (!chat.askPolling) return; // chat face hidden: the user sees the real TUI
  clearTimeout(chat.dataScanId);
  chat.dataScanId = setTimeout(() => {
    chat.dataScanId = null;
    scanAsk(pane);
  }, DATA_SCAN_MS);
}

// ---------------------------------------------------------------------------
// Message queue (v44) — sends issued while claude is busy are NOT thrown at
// the TUI input box: they wait in a visible, editable queue and leave IN
// ORDER, one per return-to-idle (claude finishes the previous message first).
// ---------------------------------------------------------------------------

function renderQueue(pane) {
  const chat = pane.chat;
  const q = chat.queue;
  chat.queueEl.hidden = q.length === 0;
  chat.queueEl.querySelector('.chat-queue-head').textContent =
    q.length ? `File d'attente — ${q.length} message${q.length > 1 ? 's' : ''}` : '';
  const list = chat.queueEl.querySelector('.chat-queue-list');
  list.textContent = '';
  q.forEach((item, i) => {
    const row = document.createElement('div');
    row.className = 'cq-item';
    const num = document.createElement('span');
    num.className = 'cq-num';
    num.textContent = String(i + 1);
    const txt = document.createElement('span');
    txt.className = 'cq-text';
    txt.textContent = item.text;
    txt.title = item.text;
    const edit = document.createElement('button');
    edit.className = 'cq-edit';
    edit.title = 'Éditer (recharge le message dans la zone de saisie)';
    edit.textContent = '✎';
    edit.addEventListener('click', () => {
      callSink(item.sink, 'cancelled'); // R3: a panel ask pulled out of the queue is never sent
      chat.queue.splice(i, 1);
      chat.inputEl.value = item.text;
      autosize(chat.inputEl);
      chat.inputEl.focus();
      renderQueue(pane);
    });
    const del = document.createElement('button');
    del.className = 'cq-del';
    del.title = 'Supprimer de la file';
    del.textContent = '✕';
    del.addEventListener('click', () => {
      callSink(item.sink, 'cancelled');
      chat.queue.splice(i, 1);
      renderQueue(pane);
    });
    row.appendChild(num);
    row.appendChild(txt);
    row.appendChild(edit);
    row.appendChild(del);
    list.appendChild(row);
  });
}

function drainQueue(pane) {
  const chat = pane.chat;
  if (!chat || !chat.queue.length) return;
  if (pane.el.classList.contains('exited')) return; // dead pty: keep the list visible
  // v46: NEVER drain into an open TUI menu — the input box is not there;
  // every character would act as a menu shortcut. Re-try shortly: a menu
  // answered (panel or terminal) frees the drain; a busy push kills it.
  if (!chat.askEl.hidden) {
    clearTimeout(chat.drainRecheckId);
    chat.drainRecheckId = setTimeout(() => {
      chat.drainRecheckId = null;
      drainQueue(pane);
    }, 3000);
    return;
  }
  const item = chat.queue.shift();
  renderQueue(pane);
  sendNow(pane, item.text, item.sink);
  // Optimistic busy flip: claude is about to work on this message — a
  // duplicate/late 'idle' push must not flush the next item early. The next
  // REAL status transition overwrites this.
  chat.lastStatus = 'working';
  chat.settled = false;
  chat.workSince = Date.now();
  refreshActivity(chat);
}

// ---------------------------------------------------------------------------
// Sending (v43) — the composer writes to the PTY through the SAME path as
// typing in the terminal: xterm paste() (bracketed paste, multi-line safe
// for the TUI input box) then CR to submit. No new IPC surface.
// v44: busy session → the message waits in the queue instead (ordered).
// ---------------------------------------------------------------------------

function sendMessage(pane) {
  if (askComposerSubmit(pane.paneId)) return; // a question is pending: Enter drives the drawer, nothing reaches the PTY
  const chat = pane.chat;
  if (!chat || chat.inputEl.disabled) return;
  // The text is what was typed plus the chip tokens (chips alone are a valid message); the tray empties
  // only where the input is emptied by an accepted message, never in sendSlash / sendAsGoal.
  const typed = chat.inputEl.value.replace(/\s+$/, '');
  const toks = chat.attachments.map((a) => a.token).join(' ');
  const text = typed && toks ? `${typed} ${toks}` : typed || toks;
  if (!text) return;
  // v49: goal-armed send — the 🎯 toggle turns the NEXT message into a /goal (tokens included; the goal wins).
  if (chat.goalArmed) {
    const ok = !goalBlocked(pane, chat);
    sendAsGoal(pane, text);
    if (ok) clearAttachments(chat);
    return;
  }
  // B24 K7: a message starting with « / » is a command. sendSlash sends the ones the session lists (the
  // terminal-screen commands are not listed: the chat face can neither render nor drive them) and puts a
  // banner on anything else, keeping the text. A command goes alone: the chips stay for the next message.
  if (typed.trimStart().startsWith('/')) { sendSlash(pane, typed); return; }
  chat.stopRequested = 0; // a fresh send opens a fresh stop window
  if (pane.el.classList.contains('exited')) {
    setComposerDisabled(chat, true, 'Session terminée — relance-la depuis la sidebar');
    return;
  }
  // Busy (or items already waiting — order is sacred): enqueue, don't send.
  if (chat.compacting || BUSY_STATUSES.has(chat.lastStatus) || chat.queue.length) {
    chat.queue.push({ text });
    chat.inputEl.value = '';
    autosize(chat.inputEl);
    clearAttachments(chat);
    renderQueue(pane);
    return;
  }
  chat.inputEl.value = '';
  autosize(chat.inputEl);
  clearAttachments(chat);
  sendNow(pane, text);
}

function sendNow(pane, text, sink) {
  const chat = pane.chat;
  // v46.9.3 review attack #2: ANY pty send opens a fresh era — the queue
  // drain rides this path with an OPTIMISTIC lastStatus='working' that
  // bypasses the hook-push reset; without this line a stop aimed at the
  // freshly-drained turn would be swallowed for up to 4s.
  chat.stopRequested = 0;
  // v53 (attacker #1): a fresh send CANCELS any deferred stop-reclaim poll
  // still armed from a PRIOR interrupt. Without this, that stale poll fires on
  // THIS send's optimistic echo (a different message) and yanks the just-sent
  // text back + Ctrl+C — silent loss of a legitimately-sent message. The poll
  // operates on the LIVE pendingSends array, so it must be invalidated the
  // instant a new send repopulates it.
  clearTimeout(chat.reclaimId);
  chat.reclaimId = null;
  // v57: capture-and-consume the post-interrupt dirty flag. Only the FIRST send
  // after an interrupt hard-clears Claude Code's restored prompt; later sends ride
  // a box this one already emptied.
  const dirty = !!chat.dirtyAfterStop;
  chat.dirtyAfterStop = false;
  // optimistic echo (dimmed until the transcript tail confirms it)
  const card = document.createElement('div');
  card.className = 'chat-msg chat-user chat-pending anim';
  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble';
  renderCodeOnly(bubble, text); // v59: live echo boxes fenced code too (not just the rebuild path)
  card.appendChild(bubble);
  const meta = document.createElement('div');
  meta.className = 'chat-meta';
  const t = document.createElement('time');
  t.textContent = '⋯ envoi';
  meta.appendChild(t);
  card.appendChild(meta);
  turnFor(chat, 'user', null, true, chat.streamEl).appendChild(card);
  const epochAtSend = chat.stopEpoch; // the Stop era this send belongs to, read where the echo is queued
  chat.pendingSends.push({ text, el: card, sink, sentAt: Date.now() });
  // PTY submit via submitPasted — bracketed: paste+CR as ONE write; unbracketed:
  // paste, then a lone CR after UNBRACKETED_CR_MS. v55: SERIALIZE the
  // write through chat.sendChain so rapid sends (composer fired faster than one
  // submit cycle) never interleave paste/CR — that interleave merged/dropped a
  // message and stranded its optimistic echo in « … envoi » (user repro
  // 2026-06-09). The echo above is immediate; only the pty write waits behind
  // the prior send's CR + SEND_GAP_MS. The executor never rejects (try/resolve),
  // so one bad send can't poison the chain for the rest.
  chat.sendChain = (chat.sendChain || Promise.resolve()).then(() => new Promise((resolve) => {
    try {
      if (!pane.chat || pane.el.classList.contains('exited')) return resolve();
      // A Stop landed while this send waited in the chain: reclaimPendingSends has put
      // (or will put) its text back in the composer, so writing it now would submit it
      // after the Stop AND let a resend double it. Never written. Every reclaim path runs
      // behind interruptClaude's stopEpoch bump, so the epoch alone is the witness (an
      // echo-still-pending test is no witness: echoes also leave pendingSends on confirm).
      if (chat.stopEpoch !== epochAtSend) return resolve();
      // v56/v57: clear any leftover in Claude Code's input box BEFORE pasting.
      // Esc "keeps the work done so far" -> the just-sent prompt is restored into
      // that box, and a send confirmed-THEN-interrupted leaves it there with NO
      // pending echo for the v53 reclaim to catch (pendingSends already emptied by
      // the transcript confirm) -> the next paste CONCATENATES.
      //   - clean box (common): Ctrl+U+Ctrl+K kill the cursor's line both sides —
      //     cheap, a harmless no-op on an empty box.
      //   - dirty box (post-interrupt): a LONG restored prompt WRAPS over several
      //     rows; the line-scoped Ctrl+U+Ctrl+K clears only the cursor's row, so the
      //     rows above survive and still concatenate (user live repro 2026-06-09:
      //     short '12' fixed by v56, long phrase still merged). Ctrl+C clears the
      //     ENTIRE multi-row buffer in one shot (same mechanism as the v53 reclaim)
      //     and is safe because the box is non-empty (the exit-confirm only arms on
      //     a 2nd Ctrl+C against an EMPTY box; the paste that follows cancels any
      //     transient arm). Small gap so the clear is processed before the paste.
      // R4: the chain only releases the NEXT chained send once submitPasted's
      // check has run (its promise settled) — SEND_GAP_MS is added on top only
      // when that check actually fired a retry CR (fresh write needs its own
      // settle margin before the next paste); a synchronous throw (pty gone)
      // keeps today's plain SEND_GAP_MS resolve.
      const paste = () => {
        let fired;
        try {
          fired = submitPasted(pane, text, () => chat.pendingSends.some((p) => p.el === card));
        } catch (_) {
          /* pty gone */
          setTimeout(resolve, SEND_GAP_MS);
          return;
        }
        fired.then((didFire) => {
          if (didFire) setTimeout(resolve, SEND_GAP_MS);
          else resolve();
        });
      };
      // v57 (review attack #5): never fire the hard Ctrl+C into an open TUI menu
      // (permission gate / AskUserQuestion / mode picker) — there Ctrl+C DISMISSES the
      // menu (a wrong auto-refusal), the exact hazard the reclaim poll already guards.
      // A menu also means no restored-prompt leftover to clear, so fall back to the
      // light line-kill.
      if (dirty && !readTui(pane.term).menu) {
        window.api.writeInput(pane.paneId, '\x03'); // hard whole-buffer clear (multi-row restored prompt)
        setTimeout(paste, CLEAR_PASTE_MS);
      } else {
        window.api.writeInput(pane.paneId, '\x15\x0b'); // light single-line kill, a no-op on empty
        paste();
      }
    } catch (_) { resolve(); }
  }));
  // NOTE: the composer is NOT cleared here — drainQueue() also calls this
  // while the user may be typing the next message; callers own the input.
  // v53: an EARLIER attempt flipped lastStatus='working' here optimistically
  // (so a 2nd quick send would queue instead of double-pasting). Reverted — it
  // made lastStatus sticky in the no-real-claude path and regressed the queue/
  // drain suite (chat-view-probe t16/t25/t27/t28/t41). The reported bug (« stop
  // trop tôt » → stranded message → the next send concatenates) is fixed by the
  // interrupt's deferred reclaim instead: it pulls the stranded text back to the
  // composer + clears the TUI box before a human-timed resend. The sub-650ms
  // programmatic double-send race is left uncovered (not the reported case).
  scrollBottom(chat);
}

// R2 / R3: a side-panel question takes the composer's send rules (exited: refused; busy or items waiting: the queue;
// else out at once), never touches the composer input or goalArmed. `sink` gets THIS message's answer only (bindReply).
function askFromPanel(paneId, text, sink) {
  const pane = panes.get(paneId);
  const chat = pane && pane.chat;
  if (!chat || pane.el.classList.contains('exited')) {
    return { ok: false, notice: 'Session terminée — relance-la depuis la sidebar' };
  }
  // a TUI menu is up: pasted text would act as menu shortcuts (sendMessage and drainQueue refuse the same way)
  if (chat.inputEl.disabled || (chat.askEl && !chat.askEl.hidden)) {
    return { ok: false, notice: 'Un menu attend ta réponse — réponds-y d’abord' };
  }
  const msg = typeof text === 'string' ? text.replace(/\s+$/, '') : '';
  if (!msg) return { ok: false, notice: 'Message vide' };
  if (chat.compacting || BUSY_STATUSES.has(chat.lastStatus) || chat.queue.length) {
    chat.queue.push({ text: msg, sink });
    renderQueue(pane);
    return { ok: true, queued: true };
  }
  sendNow(pane, msg, sink);
  return { ok: true, queued: false };
}
overlayState.askFromPanel = askFromPanel;

const SLASH_BAR_MS = 120; // a command list answered sooner shows no bar

// B24 K7: a composer message whose first token starts with « / ». A command the session lists (`commandsList`: the CLI
// list minus the terminal-screen ones, plus the user's skills) is sent from rest only, through the path its button uses;
// anything else gets a banner and the text stays. The list is read at send time; a second Enter meanwhile is ignored.
async function sendSlash(pane, text) {
  const chat = pane.chat;
  if (chat.slashSending) return;
  if (pane.el.classList.contains('exited')) {
    setComposerDisabled(chat, true, 'Session terminée — relance-la depuis la sidebar');
    return;
  }
  chat.slashSending = true;
  const bar = inlineBar();
  const barTimer = setTimeout(() => chat.chatEl.querySelector('.chat-input-bar').prepend(bar), SLASH_BAR_MS);
  let list = [];
  try { list = await window.api.commandsList(pane.paneId); } catch (_) { /* no list: nothing is listed */ }
  clearTimeout(barTimer);
  bar.remove();
  chat.slashSending = false;
  // the pane was rebuilt or the text edited while the list resolved: the next Enter decides again
  if (pane.chat !== chat || chat.inputEl.value.replace(/\s+$/, '') !== text) return;
  const body = text.trimStart();
  const cmd = body.split(/\s+/)[0];
  const arg = body.slice(cmd.length).trim();
  const shown = cmd.slice(0, 24);
  if (!Array.isArray(list) || !list.some((c) => c.name === cmd)) {
    showSlashNotice(pane, `${shown} n'est pas disponible en mode chat — passe en mode terminal pour l'utiliser.`);
    return;
  }
  if (goalBlocked(pane, chat)) { showSlashNotice(pane, `Attends la fin du tour pour lancer ${shown}.`); return; }
  if (cmd === '/model' && !arg) {
    showSlashNotice(pane, '/model : choisis le modèle dans le menu du composeur, ou tape /model <nom>.');
    return;
  }
  if (cmd === '/effort' && !arg) { // the bare command opens a slider the chat face cannot show
    showSlashNotice(pane, '/effort : choisis le niveau dans le menu du composeur, ou tape /effort <niveau>.');
    return;
  }
  chat.inputEl.value = '';
  autosize(chat.inputEl);
  if (cmd === '/compact') startCompact(pane, arg);
  else if (cmd === '/clear' && !arg) startClear(pane);
  else if (cmd === '/goal' && arg === 'clear') endGoal(pane);
  else if (cmd === '/goal' && arg) sendAsGoal(pane, arg);
  else if (cmd === '/model') sendModel(pane, arg);
  else submitPasted(pane, body);
}

// --- v64: /room-lead, skill loader (dedicated fire-button) ------------------
// /room-lead loads the lead-orchestration SKILL, which produces a NORMAL assistant turn, so the chat view renders it
// fine. No busy/card machinery (unlike /compact): submit through the PTY exactly like typing « /room-lead » + Enter.
function sendRoomLead(pane) {
  const chat = pane.chat;
  if (!chat || pane.el.classList.contains('exited')) return;
  if (BUSY_STATUSES.has(chat.lastStatus) || chat.queue.length) return; // only from rest, like /compact
  if (chat.askEl && !chat.askEl.hidden) return; // a TUI menu is open — not now
  submitPasted(pane, '/room-lead');
}

// --- v46.9.8: /compact, deck-managed ---------------------------------------
// The button and a typed « /compact [instructions] » (sendSlash) both land here: an OPTIMISTIC busy state
// (independent of the status file — a local command may not pulse the
// deck-status hook) reuses the turn machinery (queue, stop button, strip), and
// resolution rides the transcript's deterministic markers (compact_boundary =
// done, a local_command stderr = canceled), with a long timeout as the only
// safety net. Cancel reuses interruptClaude/Esc — so the double-press swallow
// guard (stopPending) covers double-stop / double-Esc for free.
const COMPACT_TIMEOUT_MS = 600000; // real compactions run ~90-130s; 10min headroom makes a premature resolve negligible (attack #2)
const CLEAR_GUARD_MS = 1000; // /clear double-click swallow window (the clear itself is near-instant; this only debounces a rapid second press)

function startCompact(pane, instr) {
  const chat = pane.chat;
  if (!chat || chat.compacting) return; // double-click swallow
  if (pane.el.classList.contains('exited')) return;
  if (BUSY_STATUSES.has(chat.lastStatus) || chat.queue.length) return; // only from rest
  if (chat.askEl && !chat.askEl.hidden) return; // a menu is open — not now
  chat.compacting = true;
  chat.stopRequested = 0;
  chat.lastStatus = 'working'; // optimistic: queue activates, send->stop, strip shows
  chat.settled = false;
  chat.workSince = Date.now();
  refreshActivity(chat);
  clearTimeout(chat.compactTimeoutId);
  chat.compactTimeoutId = setTimeout(() => {
    chat.compactTimeoutId = null;
    if (chat.compacting) resolveCompaction(pane, false); // never strand the UI
  }, COMPACT_TIMEOUT_MS);
  // PTY submit — same path as typing « /compact » + Enter, via submitPasted
  // (bracketed: paste+CR as one write; unbracketed: paste, then a lone CR).
  if (instr && typeof instr === 'string') submitPasted(pane, '/compact ' + instr);
  else submitPasted(pane, '/compact');
  scrollBottom(chat);
}

// /clear — fire « /clear » into THIS pane's PTY, mirroring startCompact's
// rest-only gate. Unlike /compact there is no deck-managed « turn »: /clear is
// near-instant and we do NOT optimistically blank this (or any) pane — the
// transcript reader remains the source of truth. A short in-flight flag
// (chat.clearing) debounces a double-click; it never touches another pane.
function startClear(pane) {
  const chat = pane.chat;
  if (!chat || chat.clearing) return; // double-click swallow
  if (pane.el.classList.contains('exited')) return;
  if (BUSY_STATUSES.has(chat.lastStatus) || chat.queue.length) return; // only from rest
  if (chat.askEl && !chat.askEl.hidden) return; // a menu is open — not now
  chat.clearing = true;
  clearTimeout(chat.clearGuardId);
  chat.clearGuardId = setTimeout(() => {
    chat.clearGuardId = null;
    chat.clearing = false;
  }, CLEAR_GUARD_MS);
  // Arm the pane-scoped one-shot re-anchor BEFORE the paste, so main snapshots
  // the project dir before the /clear fork's .jsonl can appear (positive
  // attribution of THIS pane's fresh session — the L1 detector refuses it).
  // Fire-and-forget IPC; failure just leaves the pre-fix behavior (no re-anchor).
  try { window.api.expectClear(pane.paneId); } catch (_) { /* older preload -> no re-anchor */ }
  // PTY submit — same path as typing « /clear » + Enter, via submitPasted
  // (bracketed: paste+CR as one write; unbracketed: paste, then a lone CR). Target ONLY this pane.
  submitPasted(pane, '/clear');
}

// `mount` = where the outcome marker goes: the batch fragment of the transcript handler (keeps the order
// inside one append), else the stream itself (the timeout).
function resolveCompaction(pane, canceled, noop, mount) {
  const chat = pane.chat;
  if (!chat || !chat.compacting) return;
  chat.compacting = false;
  clearTimeout(chat.compactTimeoutId);
  chat.compactTimeoutId = null;
  // v55: a no-op (« Not enough messages ») isn't a user cancel — there was
  // simply nothing to compact. Resolve with an honest label + neutral state.
  appendCompactOutcome(chat, !!canceled, !!noop, null, mount);
  chat.stopRequested = 0; // the compact « turn » is over
  chat.lastStatus = 'idle';
  chat.settled = false;
  refreshActivity(chat);
  setTimeout(() => drainQueue(pane), 0); // resume queued sends, off the event loop
}

// While a compaction runs, the inline activity line (activityLine) is the ONLY indicator: nothing is drawn
// in the stream. Its outcome lands in the history as one divider, once it is known.
function appendCompactOutcome(chat, canceled, noop, label, mount) {
  setEmpty(chat, null);
  chat.turn = null; // a separator ends any open speaker turn
  (mount || chat.streamEl).appendChild(compactDivider(canceled, noop, label));
}

// v55: three outcomes: noop (nothing to compact, neutral info glyph), canceled (user/system abort, warning
// glyph), done (success, check glyph). noop must NOT borrow the cancel error-chrome: « too few messages » is
// benign, not a failure.
function compactDivider(canceled, noop, label) {
  const el = document.createElement('div');
  el.className = 'chat-compact ' + (noop ? 'cc-noop' : (canceled ? 'cc-canceled' : 'cc-done'));
  const row = document.createElement('div');
  row.className = 'ccd-row';
  const ico = document.createElement('span');
  ico.className = 'ccd-ico';
  ico.textContent = noop ? 'ℹ' : canceled ? '\u26A0' : '\u2713';
  const lbl = document.createElement('span');
  lbl.className = 'ccd-label';
  lbl.textContent = label || (noop ? 'Trop peu de messages à compacter'
    : (canceled ? 'Compactage annulé' : 'Conversation compactée'));
  row.appendChild(ico);
  row.appendChild(lbl);
  el.appendChild(row);
  return el;
}

function updateCompactBtn(chat) {
  // v49: the compact, goal AND clear buttons are all rest-only (a /command pasted
  // into a busy/mid-turn TUI would interleave with the live screen).
  const busy = !!(chat.compacting
    || BUSY_STATUSES.has(chat.lastStatus)
    || chat.queue.length > 0
    || chat.inputEl.disabled);
  if (chat.compactBtn) chat.compactBtn.disabled = busy;
  if (chat.goalBtn) chat.goalBtn.disabled = busy;
  if (chat.clearBtn) chat.clearBtn.disabled = busy;
}

// v49: /goal arm-toggle. /goal needs an argument (the objective), so the 🎯
// button ARMS goal-mode (no separate field): the user types in the NORMAL
// composer and the next send is rewritten « /goal <message> », then the button
// disarms. Rest-only gate (mirror of startCompact): a /goal paste must never
// land in a busy/mid-turn TUI or an open ask-panel — it would interleave with
// the live screen or get eaten by a menu selection. The 🎯 button is also
// disabled via updateCompactBtn; this is the keyboard/programmatic backstop.
// Also the rest-only test of expireEffortPending (the effort pick's expiry notice).
function goalBlocked(pane, chat) {
  return pane.el.classList.contains('exited')
    || chat.compacting
    || BUSY_STATUSES.has(chat.lastStatus)
    || chat.queue.length > 0
    || (chat.askEl && !chat.askEl.hidden);
}

function toggleGoalArm(pane) {
  const chat = pane.chat;
  if (!chat || !chat.goalBtn) return;
  if (goalBlocked(pane, chat)) return; // rest-only, like the compact button
  chat.goalArmed = !chat.goalArmed;
  chat.goalBtn.classList.toggle('armed', chat.goalArmed);
  chat.goalBtn.setAttribute('aria-pressed', chat.goalArmed ? 'true' : 'false');
  markGoal(chat);
  if (chat.inputEl) chat.inputEl.focus(); // back to the composer to type/send
}

function disarmGoal(chat) {
  chat.goalArmed = false;
  if (chat.goalBtn) {
    chat.goalBtn.classList.remove('armed');
    chat.goalBtn.setAttribute('aria-pressed', 'false');
  }
  markGoal(chat);
}

// The armed state stays visible with the « ⋯ » menu closed: data-goal="on" on the trigger while goal is armed.
function markGoal(chat) {
  if (!chat.moreBtn) return;
  if (chat.goalArmed) chat.moreBtn.setAttribute('data-goal', 'on');
  else chat.moreBtn.removeAttribute('data-goal');
}

// ---------------------------------------------------------------------------
// Composer « ⋯ » menu (Goal, Compacter, Clear, Room lead). Open = fadeIn, close = exitThen on --dur-exit, the same
// keyframes as the header « ⋯ » menu. One menu is open at a time; the window / document listeners are bound once.
// ---------------------------------------------------------------------------
const MENU_OPEN_KF = [{ opacity: 0, transform: 'translateY(-4px) scale(0.98)' }, { opacity: 1, transform: 'none' }];
const MENU_CLOSE_KF = [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-4px) scale(0.98)' }];
let menuChat = null; // the chat whose « ⋯ » menu is open
let menuGlobalsBound = false;

function openComposerMenu(chat) {
  const { moreBtn, menuEl } = chat;
  if (!moreBtn || !menuEl || chat.moreOpen) return;
  if (menuChat && menuChat !== chat) closeComposerMenu(menuChat, false);
  chat.moreOpen = true;
  menuChat = chat;
  menuEl.style.removeProperty('display');
  menuEl.hidden = false;
  menuEl.setAttribute('data-sp-popup', ''); // side-panel.js: an open popup owns the next Escape
  fadeIn([menuEl], MENU_OPEN_KF);
  moreBtn.setAttribute('aria-expanded', 'true');
  menuEl.querySelector('[role="menuitem"]:not(:disabled)')?.focus({ preventScroll: true });
}

function closeComposerMenu(chat, refocus) {
  const { moreBtn, menuEl } = chat;
  if (!chat.moreOpen) return;
  chat.moreOpen = false;
  if (menuChat === chat) menuChat = null;
  menuEl.removeAttribute('data-sp-popup');
  moreBtn.setAttribute('aria-expanded', 'false');
  exitThen(menuEl, MENU_CLOSE_KF, { dur: '--dur-exit' }).then(() => {
    menuEl.style.removeProperty('display');
    if (chat.moreOpen) { fadeIn([menuEl], MENU_OPEN_KF); return; } // opened again while it was leaving
    menuEl.hidden = true;
  });
  if (refocus) moreBtn.focus({ preventScroll: true });
}

function onComposerMenuKey(e) {
  const chat = menuChat;
  if (!chat) return;
  const { moreBtn, menuEl } = chat;
  if (!menuEl.isConnected || !menuEl.getClientRects().length) { closeComposerMenu(chat, false); return; } // its pane left the screen
  if (e.key === 'Escape') {
    if (e.target && e.target.closest && e.target.closest('.pane-term')) return; // rule 8: the terminal keeps its keys
    e.preventDefault();
    e.stopPropagation(); // window capture: the side panel's document listeners never see this Escape
    closeComposerMenu(chat, true);
    return;
  }
  if (e.key === 'Tab') {
    if (menuEl.contains(document.activeElement)) moreBtn.focus({ preventScroll: true }); // Tab leaves from the trigger, not from an item
    closeComposerMenu(chat, false);
    return;
  }
  if (!menuEl.contains(document.activeElement) && document.activeElement !== moreBtn) return;
  const items = [...menuEl.querySelectorAll('[role="menuitem"]:not(:disabled)')];
  if (!items.length) return;
  const i = items.indexOf(document.activeElement);
  let n = -1;
  if (e.key === 'ArrowDown') n = (i + 1) % items.length;
  else if (e.key === 'ArrowUp') n = i < 0 ? items.length - 1 : (i - 1 + items.length) % items.length;
  else if (e.key === 'Home') n = 0;
  else if (e.key === 'End') n = items.length - 1;
  if (n >= 0) { e.preventDefault(); items[n].focus({ preventScroll: true }); }
}

function bindComposerMenuGlobals() {
  if (menuGlobalsBound) return;
  menuGlobalsBound = true;
  window.addEventListener('keydown', onComposerMenuKey, true);
  document.addEventListener('click', (e) => { // capture: a handler that stops the click cannot keep the menu open
    const c = menuChat;
    if (c && !c.menuEl.contains(e.target) && !c.moreBtn.contains(e.target)) closeComposerMenu(c, false);
  }, true);
}

// Armed composer send (and a typed « /goal <condition> », via sendSlash): the message is prefixed « /goal » and
// pasted straight to the PTY, then the 🎯 toggle disarms. Rest-only —
// refuse mid-turn, keeping the text + armed state so the user can retry at rest.
function sendAsGoal(pane, text) {
  const chat = pane.chat;
  if (goalBlocked(pane, chat)) return;
  disarmGoal(chat);
  chat.inputEl.value = '';
  autosize(chat.inputEl);
  submitPasted(pane, '/goal ' + text);
}

// ---------------------------------------------------------------------------
// v50: « Goal actif » footer (chat face only — user spec). A /goal installs a
// session Stop hook that force-continues the turn until the condition holds, so
// the activity strip reads BUSY the whole time (the real TUI shows « esc to
// interrupt » + the elapsed timer, which screenSaysBusy honours) — without a
// goal indicator that looks like a stuck « Claude réfléchit ». This footer names
// the goal + elapsed, auto-clears when the goal hook stops blocking, and the ✕
// ends it for real via « /goal clear ».
// ---------------------------------------------------------------------------
function renderGoalFooter(chat) {
  const el = chat.goalFooterEl;
  if (!el) return;
  el.hidden = !chat.goalActive;
  if (!chat.goalActive) { el.classList.remove('expanded'); return; } // v51: fresh goal starts collapsed
  el.querySelector('.cgf-text').textContent = chat.goalText;
  tickGoalTimer(chat);
}

function tickGoalTimer(chat) {
  if (!chat.goalActive || !chat.goalFooterEl) return;
  setTextIfChanged(chat.goalFooterEl.querySelector('.cgf-timer'),
    chat.goalSince ? fmtElapsed(Date.now() - chat.goalSince) : '');
}

function setGoalActive(chat, text, ts) {
  const next = text || '';
  // v51: a genuinely NEW goal (different condition) reopens collapsed even when one
  // was already active (set->set, no /goal clear between) — it must not inherit the
  // previous goal's expand. The SAME goal re-applied on a transcript re-read keeps
  // whatever the user expanded (guarded by the != check).
  if (next !== chat.goalText && chat.goalFooterEl) chat.goalFooterEl.classList.remove('expanded');
  chat.goalActive = true;
  chat.goalText = next;
  const t = ts ? Date.parse(ts) : NaN;
  chat.goalSince = Number.isNaN(t) ? Date.now() : t;
  renderGoalFooter(chat);
  if (!chat.goalTicking) {
    chat.goalTicking = true;
    tickStart(chat);
  }
}

function clearGoalActive(chat) {
  chat.goalActive = false;
  chat.goalText = '';
  chat.goalSince = 0;
  if (chat.goalTicking) { chat.goalTicking = false; tickStop(chat); }
  renderGoalFooter(chat);
}

function applyGoalEvent(chat, ev) {
  if (ev.action === 'set') setGoalActive(chat, ev.text, ev.ts);
  else if (ev.action === 'clear') clearGoalActive(chat);
}

// Auto-clear: the goal Stop hook is named after the goal text. When it runs and
// does NOT prevent continuation, the condition was met -> the goal cleared.
function applyGoalHook(pane, chat, ev) {
  if (!chat.goalActive) return;
  const g = (chat.goalText || '').trim();
  if (!g) return;
  // The goal Stop hook is NAMED after the goal text and is the only prompt-based
  // hook that runs while the goal is in force; `prompts` lists every prompt hook
  // of this stop. Full-prefix match (not a 40-char slice) tolerates truncation
  // without the prefix-collision false-positive (attack #4b).
  const present = (ev.prompts || []).some((p) => {
    const t = (p || '').trim();
    return t && (t === g || g.startsWith(t) || t.startsWith(g));
  });
  // Goal is over when EITHER the goal hook ran without blocking
  // (preventedContinuation=false) OR it is GONE from the roster (a later stop
  // after it auto-cleared). The absent-branch also covers the met tick where a
  // CO-INSTALLED blocking hook keeps the summary-level preventedContinuation=true
  // (attack #4a: `prevented` is not per-hook).
  if (present && ev.prevented) return; // goal hook still blocking -> not met yet
  clearGoalActive(chat);
  // Definitive end: release a busy strip the quiet heuristics might still be
  // vetoing (the « stuck réfléchit » the user hit) — a later real busy push
  // re-arms it (settled=false).
  chat.settled = true;
  refreshActivity(chat);
}

// ✕ on the footer: end the goal for real (not just hide the strip) by sending
// « /goal clear » through the PTY — same paste path as a goal send.
// DELIBERATELY NOT rest-only gated (unlike sendAsGoal/toggleGoalArm): the goal
// hook FORCE-CONTINUES the turn, so the footer is up precisely WHEN the TUI is
// busy — a rest gate would make the ✕ a no-op exactly when the user needs to
// escape a runaway goal. Safe because the rest-only invariant guards against
// dialog/content-interleaving /commands corrupting the chat-face render, and
// « /goal clear » raises no TUI dialog (the chat face is JSONL-backed; review
// attack #3). Mid-turn it queues and processes at the next stop — disclosed.
function endGoal(pane) {
  const chat = pane.chat;
  if (!chat) return;
  clearGoalActive(chat);
  if (pane.el.classList.contains('exited')) return;
  submitPasted(pane, '/goal clear');
}

// The one banner of the composer's slash path (`chat.slashWarnEl`): 6 s, text only.
function showSlashNotice(pane, message) {
  const chat = pane.chat;
  const el = chat.slashWarnEl;
  if (!el) return;
  el.textContent = `\u26A0 ${message}`;
  el.hidden = false;
  void el.offsetWidth; // reflow so .show transitions even on a re-trigger
  el.classList.add('show');
  clearTimeout(chat.slashWarnId);
  chat.slashWarnId = setTimeout(() => {
    chat.slashWarnId = null;
    el.classList.remove('show');
    el.hidden = true;
  }, 6000);
}

// Routed by boot.js from the single 'session-status' listener (v44): drives
// the activity strip and drains the queue when claude finishes (one message
// per return-to-idle — strict order).
export function cvNotifySessionStatus(sessionId, status) {
  // Drain AT MOST ONCE per push: should two live panes ever share a session
  // (the single-pane policy is a UI-path guard, not a hard invariant), one
  // status transition must never trigger two pty sends.
  let drained = false;
  for (const pane of panes.values()) {
    if (pane.sessionId !== sessionId || !pane.chat) continue;
    const chat = pane.chat;
    // v49: a closed pane can't goal-send — drop any armed state so a dead pane
    // never sits with the 🎯 lit (a resumed pane rebuilds chat with goalArmed=false).
    if (status === 'closed') { disarmGoal(chat); clearGoalActive(chat); }
    // v46.9.8: a deck-driven compaction owns the busy state until ITS own
    // transcript marker (compact_boundary / cancel) resolves it — a stray
    // status push must not clear it, drain the queue, or flip the button.
    // A pty death (closed) is the override: mark the outcome in the stream, fall through.
    if (chat.compacting) {
      if (status !== 'closed') { refreshActivity(chat); continue; }
      appendCompactOutcome(chat, true, false, 'Compactage interrompu (session fermée)');
      chat.compacting = false;
      clearTimeout(chat.compactTimeoutId); chat.compactTimeoutId = null;
    }
    // v46.4 (user repro: strip + stop button lost during LONG thinking): an
    // 'idle' push while the TUI screen visibly RUNS is a lie — the 5min
    // fossil guard downgrades a busy file mid-think (no hook fires between
    // PostToolUse and the next event, the file just ages), or a residual
    // reconciler false positive. The SCREEN outranks the file: refuse the
    // downgrade, keep the strip/stop/queue busy. 'closed' always passes
    // (pty death) and an exited pane's frozen screen is never trusted.
    // The refused push is REPLAYED once the spinner clears — the tick's
    // status dedup won't resend an identical status, and the Stop hook can
    // race the spinner teardown by a frame: without the replay a refused
    // idle could strand the UI busy forever.
    // Exception (user repro 2026-09-30, measured on the real deck): when the
    // ONLY live work is a background sub-agent (a working roster row AND no open
    // tool of the main) the TUI keeps writing at rest (the agent's row
    // animates), so screen/PTY activity proves nothing about the MAIN — the
    // arbiter would refuse every Stop/idle for as long as the agent runs (strip
    // stuck on « Claude réfléchit », every send queued). The status file is
    // authoritative then. Unchanged when no agent is live (v46.4 control) and
    // while the main waits on an open tool, a FOREGROUND agent included: a
    // fossil idle mid-wait must still be refused.
    if (status === 'idle' && !pane.el.classList.contains('exited')
        && !chat.idleArbitrated
        && !stopFresh(chat) // v46.9.3: the user JUST asked for this idle — let it through (redraw window only)
        && !onlyBackgroundWorkLive(chat)
        && (screenSaysBusy(pane, chat) || ptyFresh(chat))) {
      // Deferred arbitration. A LEGITIMATE idle (Stop hook) lands right
      // after the turn's final output — ptyFresh alone must not strand it.
      // The discriminator is whether output KEEPS arriving after the
      // refusal: a lying fossil push lands mid-stream (the flow continues),
      // a real end of turn goes silent. Verdict reached → replay the push
      // through the NORMAL path below (flag bypasses this arbiter once) so
      // drain dedup / suspect-idle / ledger hygiene all apply unchanged.
      clearTimeout(chat.idleRecheckId);
      const refusedAt = Date.now();
      const recheck = () => {
        chat.idleRecheckId = null;
        if (!pane.chat || pane.el.classList.contains('exited')) return;
        if (!BUSY_STATUSES.has(chat.lastStatus)) return; // already quiet
        if (screenSaysBusy(pane, chat) || chat.lastPtyData > refusedAt + 250) {
          cvNotifySessionStatus(sessionId, 'idle'); // still running — re-arbitrate
        } else {
          chat.idleArbitrated = true;
          try { cvNotifySessionStatus(sessionId, 'idle'); }
          finally { chat.idleArbitrated = false; }
        }
      };
      chat.idleRecheckId = setTimeout(recheck, 2000);
      continue;
    }
    const wasBusy = BUSY_STATUSES.has(chat.lastStatus);
    chat.lastStatus = status;
    if (BUSY_STATUSES.has(status)) {
      // v46.9.3/v54/v55: a working/running PUSH is NOT proof claude kept going —
      // the very prompt you interrupted emits its OWN delayed idle->working
      // PICKUP/fossil push a beat later. The LIVE SPINNER on screen is the proof.
      // v54 gated the wipe on a fixed window (stopFresh, 2.5s) but that was
      // SHORTER than the optimistic-UI promise (stopPending, 4s) and the reconcile
      // fast-track (stopHinted, 10s): a pickup landing in the 2.5-4s gap still
      // wiped stopRequested, killing the « Interruption demandee... » strip AND
      // stopHinted -> the fast-stop lie came back (user repro 2026-06-09, twice).
      // v55: inside the stop window (stopHinted) trust the SCREEN, like the
      // phantom reconcile and the idle-arbiter already do — wipe only when the
      // spinner is LIVE right now (genuine continuation). Use the INSTANTANEOUS
      // readTui().busy, NOT screenSaysBusy: the latter's 2.5s blink-memory still
      // carries the PRE-stop spinner and would false-wipe (same trap that sank
      // the deferred lastPtyData/screen re-check). A real/traceless stop reads
      // quiet -> the optimistic stop survives and the phantom fast-track settles
      // it to idle. Outside the window, wipe as before (hooks win).
      if ((status === 'working' || status === 'running')
          && (!stopHinted(chat) || readTui(pane.term).busy)) {
        chat.stopRequested = 0;
      }
      chat.settled = false; // a busy push always re-arms the strip
      clearTimeout(chat.settleId); // and kills a pending settle: the hook
      chat.settleId = null; //        outranks the prose heuristic
      clearTimeout(chat.drainRecheckId); // live again: deferred drain is moot
      chat.drainRecheckId = null;
      clearTimeout(chat.idleRecheckId); // a busy push outdates the deferred idle
      chat.idleRecheckId = null;
      if (!wasBusy || !chat.workSince) chat.workSince = Date.now();
    } else {
      chat.workSince = null; // turn over: stop and clear the timer
      chat.settled = false;
      chat.turnCommitted = false; // v62: turn boundary — re-arm one echo-confirm for the NEXT turn (a queued sibling confirms on its own first token)
      endReply(chat, status === 'closed'); // R3: the turn is over — its sink is done (cancelled when the pty died)
      // Ledger hygiene (review attack #1): a turn that ENDED closed every
      // tool — anything still open is an orphan (result fell over the read
      // cap, mid-tool crash, Esc) and must never haunt the next turn's label.
      chat.hadOpenToolsAtQuiet = chat.openTools.size > 0;
      chat.openTools.clear();
      markPendingInterrupted(chat); // v45.5: stop the orphan pulse too
      if (status === 'closed') settleRunningCardsOnClose(chat); // v82: pty death also ends the `running` bg-agent cards
      // v46.9.3 / v53 — a stop the status file confirmed (busy->idle) with
      // UNPROCESSED sends: the TUI handed the text back to ITS input box
      // (terminal behavior, user repro). reclaimPendingSends pulls the echoes
      // back into the composer + clears the TUI's copy with ONE Ctrl+C (it owns
      // the guards: nothing pending / mid-draft / exited). The interrupt path
      // also fires it on a timer, covering the case where a late 'working'
      // pickup push wiped stopRequested before this idle landed.
      if (chat.stopRequested && status === 'idle') reclaimPendingSends(pane);
      chat.stopRequested = 0; // the turn is over — the stop window dies with it
    }
    refreshActivity(chat);
    scanAsk(pane); // v46: a waiting push usually means a menu just rendered; also A2(c): feeds reconcileWaitingGone (chat.lastStatus is already `status`)
    if (!BUSY_STATUSES.has(status) && !drained && chat.queue.length) {
      if (chat.hadOpenToolsAtQuiet) {
        // SUSPECT idle (v45.2 attack #3): the transcript still showed a
        // running tool — a fossil-derived idle (stale busy file mid-long-
        // tool) must NOT fire the queue into the TUI while claude works.
        // Re-check shortly: a REAL idle is still idle then (drain); a live
        // session re-busies via PostToolUse first and cancels this timer.
        clearTimeout(chat.drainRecheckId);
        chat.drainRecheckId = setTimeout(() => {
          chat.drainRecheckId = null;
          if (!pane.chat) return; // pane closed meanwhile
          if (!BUSY_STATUSES.has(chat.lastStatus) && chat.queue.length) {
            drainQueue(pane);
          }
        }, 3000);
      } else {
        drainQueue(pane);
      }
      drained = true;
    }
  }
}

// ---------------------------------------------------------------------------
// Public surface — toggle (pane header button), push routing (boot.js),
// teardown (closePane).
// ---------------------------------------------------------------------------

async function startChat(pane) {
  const chat = buildShell(pane);
  pane.chat = chat;
  setEmpty(chat, 'Chargement du transcript…', { loading: true });
  let res = null;
  try {
    res = await window.api.transcriptSubscribe({
      paneId: pane.paneId, sessionId: pane.sessionId,
    });
  } catch (_) { /* fall through to the error state */ }
  if (!pane.chat) return; // pane closed during the await
  if (!res || !res.ok) {
    setEmpty(chat, 'Transcript indisponible');
    return;
  }
  // v44: status primed by main (cached read) — a chat opened on an already
  // busy session queues from the FIRST send; no unknown-status bypass window.
  chat.lastStatus = res.status || null;
  // v47: seed the context strip from the subscribe reply — the transcript
  // reader computed used_tokens from the latest assistant usage; live updates
  // then arrive via the 'session-context' push on each drain.
  if (res.context) { chat.context = res.context; renderCtx(chat); }
  // v45 timer base for a chat opened mid-turn: the last user message of the
  // initial batch is when this turn really started.
  if (BUSY_STATUSES.has(chat.lastStatus)) {
    const evs = res.events || [];
    for (let i = evs.length - 1; i >= 0; i--) {
      if (evs[i].kind === 'user' && evs[i].ts) {
        const t = Date.parse(evs[i].ts);
        if (!Number.isNaN(t)) chat.workSince = t;
        break;
      }
    }
    if (!chat.workSince) chat.workSince = Date.now();
  }
  refreshActivity(chat);
  if (res.pending) {
    setEmpty(chat, 'En attente du premier message…');
    return;
  }
  setEmpty(chat, null);
  appendEvents(pane, res.events || [], false); // initial batch: no animation
  // v45.5: a chat opened on a session AT REST renders orphan tool_use cards
  // (their result died with the closed session) — they must not pulse.
  if (!BUSY_STATUSES.has(chat.lastStatus)) markPendingInterrupted(chat);
  if (!(res.events || []).length) setEmpty(chat, 'Conversation vide');
  // v46: re-scan AFTER the batch filled the ledger — the panel kind needs
  // both the primed status and the open tools (« Permission — Bash »).
  scanAsk(pane);
  scrollBottom(chat);
}

// ---------------------------------------------------------------------------
// v47: per-session context-window strip (above the composer) — tells the user
// how full the context is, i.e. WHEN to hit « Compacter ». Pure render: fed by
// the 'session-context' push (boot.js) + the initial res.context on open.
// ---------------------------------------------------------------------------
function fmtCtxTokens(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

// v72: the picker's vocabulary — stable Claude Code « /model » aliases. Static
// on purpose: Claude Code exposes no way to list a session's models, so a
// hardcoded list is the only honest source (no env seam, no IPC — YAGNI).
const MODEL_CHOICES = [
  { id: 'fable', label: 'Fable' },
  { id: 'opus', label: 'Opus' },
  { id: 'opus[1m]', label: 'Opus 1M' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'sonnet[1m]', label: 'Sonnet 1M' },
  { id: 'haiku', label: 'Haiku' },
  { id: 'opusplan', label: 'Opus plan' },
  { id: 'default', label: 'Défaut du compte' },
];
// v72: how long the « command issued » hint survives with no transcript
// confirmation. Expiry drops the HINT only — it never relabels the badge.
const MODEL_PENDING_MS = 60000;

// Rule #7 + semantic invariant: main already canonicalized the model (null =
// nothing usable observed, a rewrite reset re-pushes null). The renderer never
// keeps a last value of its own — no model means hidden, never stale.
function renderModel(chat) {
  const el = chat.modelEl;
  if (!el) return;
  const id = chat.context && chat.context.model;
  const dd = chat.modelDdEl;
  // The session header chip mirrors the badge: same text, hidden while unknown.
  const chip = chat.chatEl.closest('.pane')?.querySelector('.ph-model');
  if (chip) {
    chip.textContent = typeof id === 'string' && id ? humanizeModel(id) : '';
    chip.hidden = !chip.textContent;
  }
  if (typeof id !== 'string' || !id) {
    el.textContent = '';
    el.hidden = true;
    if (dd) dd.hidden = true; // v72: no model = no picker either (rule #7)
    if (chat.modelMenuEl) chat.modelMenuEl.hidden = true; // never reopen on the next model
    clearModelPending(chat); // v73.1: no model = nothing left to confirm, drop the armed hint
    return;
  }
  // v72: pending means « /model issued, transcript still silent ». Only a model
  // DIFFERENT from the one observed at click time is a confirmation — an
  // unrelated push carrying the same model proves nothing.
  // v73: an explicit « /model » confirmation clears the hint even when it names
  // the SAME model — a re-pick is confirmed by an identical stdout line, and the
  // hint means « not yet confirmed », never « not yet changed ». The id-differs
  // test stays for the next-assistant-message path (no confirmation observed).
  // Tolerated duality: until that next assistant id lands, context.model holds
  // the DISPLAY LABEL from the confirmation (« Opus 5 (1M context) ») rather
  // than an id. v73.1: the two do NOT always render alike — when the next
  // assistant message lands, the badge RELABELS to the humanized id (« Opus 5 »).
  // Both texts are facts naming the same model, so the relabel is cosmetic.
  const confirmed = !!(chat.context && chat.context.model_confirmed === true);
  if (chat.modelPendingFromId !== null && (confirmed || id !== chat.modelPendingFromId)) clearModelPending(chat);
  el.textContent = humanizeModel(id);
  el.hidden = false;
  if (dd) dd.hidden = false;
}

// v72: a picked model rides the PTY exactly like « Compacter » — via submitPasted
// (bracketed: paste+CR as one write; unbracketed: paste, then a lone CR).
// Menu guard copied from startCompact (a paste into an open
// TUI menu would drive that menu); NOT the rest-only busy guard: « /model » is
// documented as issuable mid-turn, where the TUI's own confirmation prompt
// surfaces through the existing ask-panel mirror.
function sendModel(pane, id) {
  const chat = pane.chat;
  if (!chat || pane.el.classList.contains('exited')) return;
  if (chat.askEl && !chat.askEl.hidden) return; // a TUI menu is open — not now
  chat.modelPendingFromId = (chat.context && chat.context.model) || '';
  if (chat.modelEl) chat.modelEl.classList.add('cc-model-pending');
  clearTimeout(chat.modelPendingTimer);
  chat.modelPendingTimer = setTimeout(() => clearModelPending(chat), MODEL_PENDING_MS);
  submitPasted(pane, '/model ' + id);
}

function clearModelPending(chat) {
  chat.modelPendingFromId = null;
  clearTimeout(chat.modelPendingTimer);
  chat.modelPendingTimer = null;
  if (chat.modelEl) chat.modelEl.classList.remove('cc-model-pending');
}

// The effort picker's vocabulary: the terminal's own words for « /effort <level> »,
// untranslated like the mode names. `auto` clears the saved level; the statusline then
// reports the level it resolves to.
const EFFORT_CHOICES = ['low', 'medium', 'high', 'xhigh', 'max', 'auto'];
// How long a pick may wait for the pushed level to move before the control says it
// changed nothing (a statusline override, for one, keeps the shown level).
const EFFORT_PENDING_MS = 15000;
const EFFORT_INERT_NOTICE = 'Effort inchangé : passe en mode terminal pour voir la réponse de Claude Code.';

// The label is the level the statusline pushed (cvNotifySessionEffort), never the pick's and
// never read off the screen: the TUI footer erases itself after 10 s. An unknown level
// (null) hides the control (rule #7), and any move ends an armed pick.
function renderEffort(chat, level) {
  const dd = chat.effortDdEl;
  if (!dd) return;
  if (level === chat.effortLevel) return; // an unchanged level costs no DOM write
  chat.effortLevel = level;
  clearEffortPending(chat); // the level moved or the control is hidden: the pick has its answer, no notice
  if (level == null) {
    dd.hidden = true;
    chat.effortMenuEl.hidden = true; // never reopen on the next level
    setTextIfChanged(chat.effortEl, '');
    return;
  }
  setTextIfChanged(chat.effortEl, level);
  dd.hidden = false;
}

// A picked level rides the PTY like sendModel's: submitPasted, same guards (nothing
// on an exited pane or over an open TUI menu), allowed mid-turn.
function sendEffort(pane, level) {
  const chat = pane.chat;
  if (!chat || pane.el.classList.contains('exited')) return;
  if (chat.askEl && !chat.askEl.hidden) return; // a TUI menu is open — not now
  if (!EFFORT_CHOICES.includes(level)) return;
  // A new pick replaces an armed one. `auto` and the shown level may change nothing
  // visible, so they arm nothing. The pulse is not a confirmation: the label keeps
  // showing the pushed level until it moves.
  clearEffortPending(chat);
  if (level !== 'auto' && level !== chat.effortLevel) {
    chat.effortEl.classList.add('cc-effort-pending');
    chat.effortPendingTimer = setTimeout(() => expireEffortPending(pane, chat), EFFORT_PENDING_MS);
  }
  submitPasted(pane, '/effort ' + level);
}

function clearEffortPending(chat) {
  clearTimeout(chat.effortPendingTimer);
  chat.effortPendingTimer = null;
  if (chat.effortEl) chat.effortEl.classList.remove('cc-effort-pending');
}

// The pushed level never moved: drop the pulse, and say so unless goalBlocked holds (exited,
// compacting, a turn status, a queue, an open menu): then the pick may not have run yet.
// The screen is not read.
function expireEffortPending(pane, chat) {
  clearEffortPending(chat);
  if (goalBlocked(pane, chat)) return;
  showSlashNotice(pane, EFFORT_INERT_NOTICE);
}

// Routed by boot.js from the single 'session-effort' push ({sessionId, level|null}). A fork's
// id is already mapped to the display id main-side, so the pane match is a plain compare.
export function cvNotifySessionEffort(sessionId, level) {
  for (const pane of panes.values()) {
    if (pane.sessionId !== sessionId || !pane.chat) continue;
    renderEffort(pane.chat, level);
  }
}

const CTX_OK_COLOR = '#5EEAD4';

function renderCtx(chat) {
  // v66: the model badge rides the SAME 'session-context' payload as the usage,
  // so it renders on both paths (open seed :2884 and live push) at zero cost.
  renderModel(chat);
  const el = chat.ctxEl;
  if (!el) return;
  const c = chat.context;
  // Rule #7: no/indeterminate data renders as nothing, never a guessed 0%.
  if (!c || typeof c.used_percentage !== 'number') { el.hidden = true; return; }
  const pct = Math.min(100, Math.max(0, Math.round(c.used_percentage)));
  const color = ringColor(pct); // same green->red ramp as the header gauges
  const fillColor = pct >= 75 ? color : CTX_OK_COLOR; // ok level = the teal accent, warn / crit = the ramp
  const fill = el.querySelector('.cc-ctx-fill');
  const pctEl = el.querySelector('.cc-ctx-pct');
  const sepEl = el.querySelector('.cc-ctx-sep');
  const numsEl = el.querySelector('.cc-ctx-nums');
  if (fill) { fill.style.width = pct + '%'; fill.style.background = fillColor; }
  if (pctEl) { pctEl.textContent = pct + '%'; pctEl.style.color = pct >= 75 ? color : ''; }
  const hasNums = c.used_tokens != null && c.window != null;
  if (sepEl) sepEl.hidden = !hasNums;
  if (numsEl) {
    numsEl.hidden = !hasNums;
    if (hasNums) numsEl.textContent = `${fmtCtxTokens(c.used_tokens)} / ${fmtCtxTokens(c.window)}`;
  }
  el.dataset.level = pct >= 90 ? 'crit' : pct >= 75 ? 'warn' : 'ok'; // semantic (probes)
  el.title = hasNums
    ? `Contexte : ${fmtCtxTokens(c.used_tokens)} / ${fmtCtxTokens(c.window)} (${pct}%) — « Compacter » pour libérer du contexte`
    : `Contexte : ${pct}%`;
  el.hidden = false;
}

// Routed by boot.js from the single 'session-context' push. A fork's export is
// already mapped to the original display id main-side (statusAlias), so the
// pane match here is a plain sessionId compare — same contract as status.
export function cvNotifySessionContext(sessionId, context) {
  for (const pane of panes.values()) {
    if (pane.sessionId !== sessionId || !pane.chat) continue;
    pane.chat.context = context || null;
    renderCtx(pane.chat);
  }
}

export function toggleChatView(paneId) {
  const pane = panes.get(paneId);
  if (!pane) return;
  const on = !pane.el.classList.contains('chat-mode');
  if (on && !pane.sessionId) return; // new unnamed session: no identity yet
  pane.el.classList.toggle('chat-mode', on);
  const btn = pane.el.querySelector('.pane-view');
  if (btn) {
    btn.classList.toggle('active', on);
    // v46.9: the switch SAYS its state — no more cryptic bubble icon.
    const lbl = btn.querySelector('.pv-label');
    if (lbl) lbl.textContent = on ? 'Chat mode ON' : 'Terminal mode ON';
  }
  if (on) {
    if (!pane.chat) startChat(pane); // buildShell runs sync — pane.chat exists below
    else scrollBottom(pane.chat); // DOM kept warm while hidden — re-stick
    if (pane.chat) {
      startAskPoll(pane); // v46: mirror TUI menus while the chat face shows
      if (pane.el.classList.contains('exited')) {
        setComposerDisabled(pane.chat, true, 'Session terminée — relance-la depuis la sidebar');
      } else {
        pane.chat.inputEl.focus();
      }
    }
  } else {
    // Back to the terminal: the RO fired 0-size while .pane-term was hidden —
    // re-run the central fit pipeline, then hand focus back to the PTY.
    stopAskPoll(pane); // v46: terminal face = the user sees the real menu
    // v51: output streamed while the chat face hid the terminal (display:none)
    // left the native scrollbar parked mid-history — xterm never force-scrolls
    // a detached viewport, so viewportY tracks the bottom but the DOM scrollTop
    // goes stale, and fit() is a no-op when cols/rows are unchanged (the only
    // resync the swap triggers) so it never re-pins on its own. Ask the
    // upcoming resync to stick the scrollbar to the live bottom once the fit
    // settles. One-shot + chat-return-only so the shared resize path (window
    // resize, AI return) is never force-scrolled.
    if (pane.outputWhileTermHidden) {
      pane.outputWhileTermHidden = false;
      pane._stickBottomOnce = true;
      pane._stickBottomAt = Date.now(); // v53 (attacker #4): TTL stamp — a stale
    }                                   // flag must not snap an unrelated later resize
    scheduleResync(paneId);
    pane.term.focus();
  }
}

// v46.9: idempotent face selector — used by the chat-by-default policy
// (openPane + deferred identity) and by probes that must not depend on the
// current default to reach a known state.
export function setChatView(paneId, on) {
  const pane = panes.get(paneId);
  if (!pane) return;
  if (pane.el.classList.contains('chat-mode') === !!on) return;
  toggleChatView(paneId);
}

// v46.6: sub-agent live activity (routed by boot.js, paneId + toolUseId).
// Only a PENDING card gets a feed — a resolved/interrupted card is history,
// and the main process only tails open dispatches anyway (belt+suspenders).
export function notifySubagentAppend(payload) {
  const pane = panes.get(payload.paneId);
  if (!pane || !pane.chat) return;
  const chat = pane.chat;
  const card = payload.toolUseId ? chat.toolIndex.get(payload.toolUseId) : null;
  const events = Array.isArray(payload.events) ? payload.events : [];
  if (!card || !events.length) return;
  // v82: a `running` card (background agent past its launch ACK) is still live: it keeps its feed like `pending`.
  if (card.dataset.status !== 'pending' && card.dataset.status !== 'running') {
    // v46.8 archive replay: an anchor rebuilt this RESOLVED card without
    // its feed — restore it once from the pushed history. Never append to
    // an existing feed (a replay only fills a void, duplicates are noise).
    if (card.querySelector('.ct-live')) return;
    appendAgentLive(chat, card, events);
    const live = card.querySelector('.ct-live');
    if (live) {
      live.classList.add('ct-live-done');
      // A restore lands in the compact done box — pin the freshest calls.
      const lines = live.querySelector('.ct-live-lines');
      if (lines && lines.clientHeight > 0) lines.scrollTop = lines.scrollHeight;
    }
    if (chat.atBottom) scrollBottom(chat);
    return; // no activity-strip update for a resolved dispatch
  }
  appendAgentLive(chat, card, events);
  // (v46.9: the strip no longer mirrors the agent's current tool — the
  // card's live feed owns that detail.)
  refreshActivity(chat);
  if (chat.atBottom) scrollBottom(chat);
}

// A question asked again with the same text leaves an OLDER identical user line in the replayed history: a line
// stamped before the send cannot be the send's own. Same machine clock, ms precision: the margin only absorbs
// rounding and jitter, an earlier answered turn is minutes away. No sentAt / no parsable ts: text-only pairing.
const SEND_LINE_SKEW_MS = 5000;
function writtenBeforeSend(ev, sentAt) {
  if (typeof sentAt !== 'number') return false;
  const t = Date.parse(ev.ts);
  return Number.isFinite(t) && t < sentAt - SEND_LINE_SKEW_MS;
}

// A reset replays the transcript with animate=false, so no reply sink is ever fed. A held panel send whose user line
// is in the replay (index `at`) hands its sink the replayed text of ITS turn (up to the next user / queuedPrompt
// line): turn over (a later message, or the session not busy) -> done; last turn of a busy session -> bound as the
// current reply, so the live text and the idle endReply finish it. Never dropped: the session already answered.
function settleReplayed(chat, sink, evs, at) {
  const texts = [];
  let end = at + 1;
  for (; end < evs.length && evs[end].kind !== 'user' && evs[end].kind !== 'queuedPrompt'; end++) {
    if (evs[end].kind === 'text') texts.push(evs[end].text);
  }
  if (end >= evs.length && BUSY_STATUSES.has(chat.lastStatus)) {
    bindReply(chat, sink);
    replyState(chat).texts = texts;
    if (texts.length) callSink(sink, 'update', texts.join('\n\n'));
    return;
  }
  if (texts.length) callSink(sink, 'update', texts.join('\n\n'));
  callSink(sink, 'done');
}

// Routed by boot.js (single 'transcript-append' listener, by paneId).
// reset = the feed re-anchored (resume id drift, file rebuilt): rebuild the
// whole view from the fresh full read instead of appending across two files.
export function notifyTranscriptAppend(payload) {
  const pane = panes.get(payload.paneId);
  if (!pane || !pane.chat) return;
  if (payload.reset) {
    const chat = pane.chat;
    // A reset (resume fork / file rebuild) must NOT erase unconfirmed sends:
    // the bytes are already on the PTY — wiping the dimmed bubble would tell
    // the user "never happened" and invite a dangerous double-send. Hold the
    // echoes aside, rebuild from the fresh read (which renders any CONFIRMED
    // copy as a normal bubble), then re-hang the still-unconfirmed ones.
    const held = chat.pendingSends;
    chat.pendingSends = [];
    chat.streamEl.textContent = '';
    chat.toolIndex.clear();
    chat.reportCards.clear(); // v81: re-learned from the fresh batch (carriers + results are replayed together)
    chat.agentReports.clear();
    chat.openTools.clear(); // rebuilt from the fresh batch right below
    chat.bgShellCalls.clear(); // launches pending a result are re-learned from the replay
    // Running shells survive a reset: the pane's process keeps them, and a replay (animate=false) cannot add any.
    chat.agentInfoById.clear(); // v80: re-learned from the fresh batch below (ACKs are read on replay too)
    chat.agentSeq.clear(); // L5: the feed restarts its seq at every anchor (this is the renderer half of that reset)
    chat.resumeOf.clear(); // L5: re-learned from the replayed results, like agentInfoById
    chat.bgAgents.clear(); // v70: a full rebuild starts the bg roster EMPTY — appendEvents replays with animate=false, which no longer populates the roster (live-only, see the dispatch branch); only subsequent LIVE dispatches refill it
    // Review attack #2: the rebuild bypasses the live-append settle block
    // (animate=false) — a stale `settled` from before the reset would keep
    // the strip hidden through ACTIVE work on the resumed session.
    chat.settled = false;
    clearTimeout(chat.settleId);
    chat.settleId = null;
    chat.turn = null;
    // v50: a rebuild must not leave a STALE « Goal actif » footer (+ its 1s
    // interval) standing — the replay below re-establishes it from the in-window
    // events only (a long-completed goal whose clear fell out of the bounded tail
    // no longer strands a multi-hour timer; the ✕ dismisses any residual).
    clearGoalActive(chat);
    appendEvents(pane, payload.events || [], false);
    if (!BUSY_STATUSES.has(chat.lastStatus)) markPendingInterrupted(chat); // v45.5
    const replayed = payload.events || [];
    let from = 0; // FIFO: the held sends pair with their replayed user lines in order, never a loose match
    for (const p of held) {
      let at = -1;
      for (let i = from; i < replayed.length && at < 0; i++) {
        if (replayed[i].kind === 'user' && sameText(p.text, replayed[i].text) && !writtenBeforeSend(replayed[i], p.sentAt)) at = i;
      }
      if (at < 0) {
        turnFor(chat, 'user', null, false, chat.streamEl).appendChild(p.el);
        chat.pendingSends.push(p);
        continue;
      }
      from = at + 1;
      if (p.sink) settleReplayed(chat, p.sink, replayed, at); // confirmed by the replay: its answer must reach the sink
    }
    if (chat.atBottom) scrollBottom(chat);
    return;
  }
  appendEvents(pane, payload.events || [], true);
}

// closePane hygiene: kill the main-side watcher/poll with the pane.
export function teardownChatView(pane) {
  if (!pane || !pane.chat) return;
  if (pane.chat.askUnsub) pane.chat.askUnsub(); // question drawer: no callback into a dead composer
  if (pane.chat.askUnmount) pane.chat.askUnmount();
  endReply(pane.chat, true); // R3: a closed pane never answers — every waiting sink ends cancelled
  for (const p of pane.chat.pendingSends) callSink(p.sink, 'cancelled');
  for (const q of pane.chat.queue) callSink(q.sink, 'cancelled');
  if (pane.chat.scrollRO) pane.chat.scrollRO.disconnect();
  pane.chat.stripTicking = false; // v45: never tick a dead strip
  pane.chat.goalTicking = false; // v50: never tick the « Goal actif » timer on a dead pane (attack #1)
  if (menuChat === pane.chat) menuChat = null; // a dead composer owns no open menu
  tickStop(pane.chat);
  clearInterval(pane.chat.tasksReapId); // v71: kill the roster idle-backstop tick too
  stopAskPoll(pane); // v46: never scan a dead terminal (also drops the data-scan timeout)
  clearTimeout(pane.chat.settleId);
  clearTimeout(pane.chat.drainRecheckId);
  clearTimeout(pane.chat.idleRecheckId); // v46.4
  clearTimeout(pane.chat.reclaimId); // v53: deferred stop-reclaim never fires on a dead pane
  clearTimeout(pane.chat.compactTimeoutId); // v46.9.8: never fire on a torn-down/reopened pane (attack #1)
  clearTimeout(pane.chat.slashWarnId); // v46.9.8
  clearTimeout(pane.chat.modelPendingTimer); // v73.1: never fire on a torn-down pane
  clearTimeout(pane.chat.effortPendingTimer);
  pane.chat.compacting = false;
  if (pane.chat.ctxEl) pane.chat.ctxEl.remove(); // the meter lives in the header, outside .pane-chat
  window.api.transcriptUnsubscribe(pane.paneId);
  pane.chat = null;
}
