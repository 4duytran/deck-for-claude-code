// claude-deck — renderer/code-ask.js (deck-mr-review L6): « Demander à Claude » on a selection in a code view (R2) and the
// answer bubble under the lines (R3). The surfaces (Files source view, diffs, rich view) own selection, line numbers and
// bubble placement; this module owns the popup, the send, the live answer and the bubbles (threads, D25), which live in memory
// until the app quits. Sends go through overlayState.askFromPanel (chat-view.js registers it; never imported here).
// Answers: markdown-it html:false (same rule as files-panel.js); everything else through textContent.
'use strict';

import { overlayState } from './state.js';
import { sp } from './side-panel.js';
import { inlineBar } from './loading.js';

const MAX_LINES = 200;
const MAX_BYTES = 20 * 1024;
const POPUP_W = 340;
const POPUP_H = 96;

const md = (typeof markdownit !== 'undefined') ? markdownit({ html: false, linkify: true }) : null;

// scope (caller key: a file's `fileScope`, else target + path) -> [thread]; thread = { anchor, threadRef, scope, turns: [{ question, answer, state }], el, body, turnsEl, reply }
// turn.state: queued | live | done | cancelled
const threads = new Map();
let popup = null; // { el, off }

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// ref line, fenced selected lines (capped at 200 lines / 20 KB, every cut said), blank line, question.
export function composeCodeMessage(ref, lines, question) {
  const all = Array.isArray(lines) ? lines : String(lines).split('\n');
  const enc = new TextEncoder();
  const kept = [];
  let bytes = 0;
  for (const l of all) {
    const b = enc.encode(l).length + (kept.length ? 1 : 0);
    if (kept.length >= MAX_LINES || bytes + b > MAX_BYTES) break;
    kept.push(l);
    bytes += b;
  }
  const lineCut = !kept.length && all.length > 0; // the first line alone is over the byte cap
  if (lineCut) kept.push(new TextDecoder().decode(enc.encode(all[0]).slice(0, MAX_BYTES)));
  let fence = '```';
  while (kept.some((l) => l.includes(fence))) fence += '`';
  let msg = `${ref}\n\n${fence}\n${kept.join('\n')}\n${fence}\n`;
  if (kept.length < all.length) msg += `… coupé : ${all.length} lignes sélectionnées, ${kept.length} envoyées\n`;
  if (lineCut) msg += `… coupé : ligne tronquée à ${MAX_BYTES / 1024} Ko\n`;
  return `${msg}\n${question}`;
}

function actionButtons(box, actions, ctx) {
  for (const a of Array.isArray(actions) ? actions : []) {
    const b = el('button', 'ca-btn', a.label);
    b.type = 'button';
    if (a.title) b.title = a.title;
    b.addEventListener('click', () => a.run(ctx()));
    box.appendChild(b);
  }
}

export function closeAsk() {
  if (!popup) return;
  popup.off();
  popup.el.remove();
  popup = null;
}

// ---------------------------------------------------------------------------
// Bubble (a thread: turns in send order, a reply field under the last one once it is done or cancelled)
// ---------------------------------------------------------------------------

function renderAnswer(box, turn) {
  box.className = 'ca-a';
  if (!turn.answer) {
    box.classList.add('ca-pending');
    // only a live turn waits for text; done or cancelled with none shows nothing (rule 7)
    box.textContent = turn.state === 'queued' ? 'En file d’attente…' : (turn.state === 'live' ? 'Claude répond…' : '');
  } else if (md) box.innerHTML = md.render(turn.answer).trimEnd(); // markdown-it, html:false
  else box.textContent = turn.answer;
}

function renderThread(t) {
  const last = t.turns[t.turns.length - 1];
  t.el.dataset.state = last.state;
  t.reply.hidden = last.state !== 'done' && last.state !== 'cancelled';
  t.turnsEl.replaceChildren(...t.turns.map((turn, i) => {
    const box = el('div', 'ca-turn');
    const a = el('div');
    renderAnswer(a, turn);
    box.append(el('div', 'ca-q', turn.question));
    if (i === 0 && t.sentNote) box.appendChild(el('div', 'ca-sent', t.sentNote)); // what the session received, first question only
    box.appendChild(a);
    if (a.classList.contains('ca-pending') && a.textContent) box.appendChild(inlineBar()); // a wait text, never the empty cancelled one
    if (turn.state === 'cancelled') box.appendChild(el('div', 'ca-note', 'Réponse annulée'));
    return box;
  }));
}

// « Continuer le fil »: Enter sends the follow-up as a NEW turn, never the selection (D25).
function buildReply(t) {
  const row = el('div', 'ca-reply');
  const input = el('input', 'ca-input');
  input.type = 'text';
  input.autocomplete = 'off';
  input.placeholder = 'Continuer le fil';
  input.setAttribute('aria-label', 'Continuer le fil');
  const bar = el('div', 'ca-actions');
  bar.appendChild(input);
  const notice = el('div', 'ca-notice');
  notice.hidden = true;
  notice.setAttribute('role', 'alert');
  row.append(bar, notice);
  row.hidden = true;
  const refuse = (text) => { notice.textContent = text; notice.hidden = false; };
  input.addEventListener('input', () => { notice.hidden = true; });
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing || e.shiftKey) return;
    e.preventDefault();
    const question = input.value.trim();
    if (!question) return;
    const ask = overlayState.askFromPanel;
    if (typeof ask !== 'function') { refuse('Envoi impossible'); return; }
    const turn = { question, answer: '', state: 'live' };
    const res = ask(sp.target ? sp.target.paneId : undefined, `Suite du fil sur ${t.threadRef}\n\n${question}`, sinkFor(t, turn));
    if (!res || !res.ok) { refuse((res && res.notice) || 'Envoi impossible'); return; }
    if (res.queued && turn.state === 'live' && !turn.answer) turn.state = 'queued';
    t.turns.push(turn);
    input.value = '';
    renderThread(t);
  });
  return row;
}

function buildBubble(t, bubbleActions) {
  const root = el('div', 'ca-bubble');
  const head = el('div', 'ca-head');
  const toggle = el('button', 'ca-toggle', '▾');
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', 'true');
  toggle.setAttribute('aria-label', 'Replier');
  const ref = el('span', 'ca-ref', t.threadRef);
  ref.title = t.threadRef;
  head.append(toggle, ref);
  actionButtons(head, bubbleActions, () => ({ thread: t }));
  t.body = el('div', 'ca-body');
  t.turnsEl = el('div', 'ca-turns');
  t.reply = buildReply(t);
  t.body.append(t.turnsEl, t.reply);
  root.append(head, t.body);
  toggle.addEventListener('click', () => {
    const open = t.body.hidden;
    t.body.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'Replier' : 'Déplier');
    toggle.textContent = open ? '▾' : '▸';
    root.classList.toggle('is-collapsed', !open);
  });
  // A rendered answer can carry links: a reader never navigates.
  root.addEventListener('click', (e) => {
    const a = e.target && e.target.closest ? e.target.closest('a') : null;
    if (a) e.preventDefault();
  });
  t.el = root;
}

// The sink L3 binds to ONE message (one turn): update(fullTextSoFar), done(), cancelled().
function sinkFor(t, turn) {
  const redraw = () => renderThread(t);
  return {
    update(text) {
      turn.answer = String(text == null ? '' : text);
      if (turn.state === 'queued') turn.state = 'live';
      redraw();
    },
    done() {
      if (turn.state !== 'cancelled') turn.state = 'done';
      redraw();
    },
    cancelled() {
      turn.state = 'cancelled';
      redraw();
    },
  };
}

// The thread scope of ONE file in ONE session, whatever tab or view shows it: `fileKey` is the opaque key main hands out
// (plans-get, files-read), never a path. null (no session or no key) keeps no thread.
export function fileScope(target, fileKey) {
  const who = target && (target.sessionId || target.paneId);
  return who && typeof fileKey === 'string' && fileKey ? `file\u0000${who}\u0000${fileKey}` : null;
}

// Bubbles the surface must put back after it re-rendered its view: place(bubbleEl, anchor). A thread is one element that
// moves between views: the placement a previous host gave it (inline style, a view-only note) goes first, and `place`
// decides from the anchor (a shape only some views understand) whether it sits under it or in the view's dock.
export function placeBubbles(scope, place) {
  for (const t of threads.get(scope) || []) {
    t.el.removeAttribute('style');
    for (const n of t.el.querySelectorAll('[data-view-note]')) n.remove();
    place(t.el, t.anchor);
  }
}

// ---------------------------------------------------------------------------
// Send (the one path of the popup, the line box and the MR box; opens and closes no popup)
// ---------------------------------------------------------------------------

// Claude Code reads a prompt starting with « ! » as bash mode and « / » as a command: a message never starts with either
// (the text carries third-party GitLab notes). A letter line goes first; every other text stays byte-identical.
export function safeAskText(text) {
  return typeof text === 'string' && /^\s*[!/]/.test(text) ? `Question :\n${text}` : text;
}

// opts: question, compose(question) -> message text, anchor, threadRef, scope (threads are kept under it), placeBubble(bubbleEl, anchor),
// bubbleActions, sentNote (optional text shown under the thread's first question only). Returns { ok: true, queued } | { ok: false, notice }:
// a refusal places and keeps nothing.
export function sendAsk(opts) {
  const { question: raw, compose, anchor, threadRef, scope, placeBubble, bubbleActions, sentNote: rawNote } = opts;
  const question = String(raw == null ? '' : raw).trim();
  if (!question) return { ok: false, notice: 'Question vide' };
  const ask = overlayState.askFromPanel;
  if (typeof ask !== 'function') return { ok: false, notice: 'Envoi impossible' };
  const text = safeAskText(compose(question));
  const sentNote = typeof rawNote === 'string' ? rawNote.trim() : '';
  const t = { anchor, threadRef, scope, sentNote, turns: [{ question, answer: '', state: 'live' }], el: null, body: null, turnsEl: null, reply: null };
  buildBubble(t, bubbleActions);
  const res = ask(sp.target ? sp.target.paneId : undefined, text, sinkFor(t, t.turns[0]));
  if (!res || !res.ok) return { ok: false, notice: (res && res.notice) || 'Envoi impossible' };
  if (res.queued) t.turns[0].state = 'queued';
  renderThread(t);
  if (scope != null) {
    if (!threads.has(scope)) threads.set(scope, []);
    threads.get(scope).push(t);
  }
  if (typeof placeBubble === 'function') placeBubble(t.el, anchor);
  return { ok: true, queued: !!res.queued };
}

// ---------------------------------------------------------------------------
// Popup
// ---------------------------------------------------------------------------

// opts: anchorEl (element or rect: where the selection ends), anchor (opaque, kept per bubble), threadRef (short ref),
// compose(question) -> the message text, placeBubble(bubbleEl, anchor), scope (key the bubbles are kept under),
// popupActions / bubbleActions: [{ label, title?, run(ctx) }] (consumer: L9).
export function openAsk(opts) {
  const { anchorEl, anchor, threadRef, compose, placeBubble, scope, popupActions, bubbleActions } = opts;
  closeAsk();
  const box = el('div', 'ca-popup');
  box.setAttribute('data-sp-popup', '');
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', 'Demander à Claude');
  const input = el('input', 'ca-input');
  input.type = 'text';
  input.autocomplete = 'off';
  input.placeholder = 'Ta question…';
  input.setAttribute('aria-label', 'Question pour Claude');
  const notice = el('div', 'ca-notice');
  notice.hidden = true;
  notice.setAttribute('role', 'alert');
  const extra = el('div', 'ca-actions');
  box.append(el('div', 'ca-title', 'Demander à Claude'), input, notice, extra);
  actionButtons(extra, popupActions, () => ({ question: input.value.trim(), close: closeAsk }));
  if (!extra.children.length) extra.hidden = true;

  const rect = anchorEl && typeof anchorEl.getBoundingClientRect === 'function' ? anchorEl.getBoundingClientRect() : (anchorEl || {});
  const left = Math.max(8, Math.min(Number(rect.left) || 8, window.innerWidth - POPUP_W - 8));
  const below = (Number(rect.bottom) || 0) + 6;
  box.style.left = `${left}px`;
  box.style.top = `${Math.max(8, Math.min(below, window.innerHeight - POPUP_H - 8))}px`;
  document.body.appendChild(box);

  const onDown = (e) => { if (!box.contains(e.target)) closeAsk(); };
  document.addEventListener('mousedown', onDown, true);
  popup = { el: box, off: () => document.removeEventListener('mousedown', onDown, true) };

  const refuse = (text) => { notice.textContent = text; notice.hidden = false; };
  const send = () => {
    const question = input.value.trim();
    if (!question) return;
    // the popup closes just before the surface places the bubble, as it always did
    const res = sendAsk({ question, compose, anchor, threadRef, scope, bubbleActions, placeBubble: (bubbleEl, a) => { closeAsk(); if (typeof placeBubble === 'function') placeBubble(bubbleEl, a); } });
    if (!res.ok) refuse(res.notice);
  };
  // Copy kept: focusing the input collapses the page selection, so it is read first (opts.selectionDoc: the rich view's frame
  // document). Ctrl+C / Ctrl+Insert with nothing selected in the input writes it to the system CLIPBOARD; Esc puts the range back.
  const selDoc = opts.selectionDoc || document;
  const picked = selDoc.getSelection();
  const kept = picked && picked.rangeCount && !picked.isCollapsed ? { text: picked.toString(), range: picked.getRangeAt(0).cloneRange() } : null;
  const restoreSelection = () => {
    if (!kept || !kept.range.startContainer.isConnected || !kept.range.endContainer.isConnected) return;
    const s = selDoc.getSelection();
    s.removeAllRanges();
    s.addRange(kept.range);
    if (selDoc !== document && selDoc.defaultView) selDoc.defaultView.focus(); // the frame takes Ctrl+C back
  };
  const isCopy = (e) => !e.altKey && !e.shiftKey && (((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 'c') || (e.ctrlKey && e.key === 'Insert'));
  input.addEventListener('input', () => { notice.hidden = true; });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeAsk();
      restoreSelection();
      e.preventDefault();
      e.stopPropagation();
    } else if (isCopy(e) && kept && kept.text && input.selectionStart === input.selectionEnd && window.api && typeof window.api.clipboardWrite === 'function') {
      e.preventDefault();
      window.api.clipboardWrite(kept.text);
    } else if (e.key === 'Enter' && !e.isComposing && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  input.focus({ preventScroll: true });
}
