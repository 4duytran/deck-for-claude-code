// claude-deck — renderer/ask-drawer: the question drawer (AskUserQuestion on
// the hook channel). Per-pane queue over ask-model.js; one drawer per mounted
// host (chat face / terminal face), both rendered from the same pane state.
// Never imports chat-view.js or panes.js: they reach it through the calls
// below (askComposerInput / askComposerSubmit / onAskHostChange / mountAskHost).
// External data reaches the DOM through textContent only.
'use strict';

import { createAskModel } from './ask-model.js';
import { exitThen } from './motion.js';
import { inlineBar } from './loading.js';

export const ASK_ADVANCE_MS = 200; // single-select auto-advance (cancellable)
export const ASK_TYPING_IDLE_MS = 1200; // a new request waits while the composer is this fresh

const SVG_NS = 'http://www.w3.org/2000/svg';
const ERR_SEND = 'Envoi impossible, réessayez.';

const recs = new Map(); // paneId -> { queue, held, open, lastKeyAt, holdTimer, hosts, subs, lastEmit }
let activePaneId = null; // pane of the last pointer / focus interaction (digits never reach a background pane)
let listening = false;

// ---- pure helpers (exported for the asserts) ----

// 1-9 from a keydown, else null. Modifiers, repeats and IME input are ignored.
// Digit* codes count on AZERTY (unshifted top row types « & é " »); Numpad* only with NumLock on.
export function askDigit(e) {
  if (!e || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || e.repeat || e.isComposing) return null;
  const code = typeof e.code === 'string' ? e.code : '';
  const key = typeof e.key === 'string' ? e.key : '';
  const np = /^Numpad([1-9])$/.exec(code);
  if (np) return /^[1-9]$/.test(key) ? Number(np[1]) : null;
  const dg = /^Digit([1-9])$/.exec(code);
  if (dg) return Number(dg[1]);
  return /^[1-9]$/.test(key) ? Number(key) : null;
}

// Inputs, textareas (the xterm helper textarea included), selects, contenteditable (chat composer).
export function isTypingTarget(el) {
  if (!el || el.nodeType !== 1) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!el.isContentEditable;
}

// Milliseconds a new request must still wait: 0 once the last keystroke is >= idleMs old.
export function typingHoldMs(lastKeyAt, nowMs, idleMs = ASK_TYPING_IDLE_MS) {
  if (!lastKeyAt) return 0;
  return Math.max(0, lastKeyAt + idleMs - nowMs);
}

export function askPlaceholder(pending, open) {
  if (!pending) return '';
  return open ? 'Autre réponse… (ou choisissez une option)' : 'Question en attente : dépliez le panneau pour répondre';
}

// ---- pane records ----

function recFor(paneId) {
  let r = recs.get(paneId);
  if (!r) {
    r = { paneId, queue: [], held: [], open: true, lastKeyAt: 0, holdTimer: 0, hosts: new Map(), subs: new Set(), lastEmit: '' };
    recs.set(paneId, r);
  }
  return r;
}

function gc(rec) {
  if (!rec.queue.length && !rec.held.length && !rec.hosts.size && !rec.subs.size) {
    clearTimeout(rec.holdTimer);
    recs.delete(rec.paneId);
  }
}

// qKey = `<request id>:<question index>`; custom = that question's « Autre » text (the chat composer follows both).
function hostSnap(rec) {
  const pending = rec.queue.length > 0;
  const open = pending && rec.open;
  let qKey = '';
  let custom = '';
  if (pending) {
    const cur = rec.queue[0];
    const s = cur.model.state();
    qKey = cur.id + ':' + s.index;
    custom = s.questions[s.index].custom;
  }
  return { pending, open, placeholder: askPlaceholder(pending, open), qKey, custom };
}

function emit(rec) {
  const snap = hostSnap(rec);
  const { custom, ...shown } = snap; // typing alone does not re-emit: the composer already holds that text
  const key = JSON.stringify(shown) + rec.queue.map((e) => e.id).join(); // ids: every arrival / leave fires
  if (key === rec.lastEmit) return;
  rec.lastEmit = key;
  for (const cb of [...rec.subs]) {
    try { cb({ ...snap }); } catch (err) { console.error('ask-drawer: host callback failed', err); }
  }
}

function render(rec) {
  syncHosts(rec);
  emit(rec);
}

function clearTimer(entry) {
  clearTimeout(entry.timer);
  entry.timer = 0;
}

function cancelAdvance(entry) {
  clearTimer(entry);
  entry.model.cancelAdvance();
}

function makeEntry(req) {
  return { id: req.id, req, model: createAskModel(req.input && req.input.questions), timer: 0, sending: false, error: '' };
}

function handBack(id) {
  try {
    Promise.resolve(window.api.askAnswer(id, { kind: 'terminal' })).catch(() => {});
  } catch { /* no bridge: the hook's own deadline falls back to the TUI */ }
}

// ---- actions ----

function selectOption(rec, n) {
  const cur = rec.queue[0];
  if (!cur || cur.sending) return false;
  clearTimer(cur);
  const r = cur.model.pick(n);
  if (!r.ok) return false;
  cur.error = '';
  if (r.advanceDue) cur.timer = setTimeout(() => advanceNow(rec, cur), ASK_ADVANCE_MS);
  render(rec);
  return true;
}

function advanceNow(rec, cur) {
  cur.timer = 0;
  if (rec.queue[0] !== cur || cur.sending) return;
  const r = cur.model.advance(); // null when cancelled meanwhile
  if (r === 'submit') submit(rec, cur);
  else if (r === 'next') render(rec);
}

function submit(rec, cur) {
  if (cur.sending) return;
  const answers = cur.model.submit();
  if (answers) deliver(rec, cur, { kind: 'answers', answers });
}

async function deliver(rec, cur, answer) {
  cur.sending = true;
  cur.error = '';
  render(rec);
  let ok = false;
  try {
    const res = await window.api.askAnswer(cur.id, answer);
    ok = !!(res && res.ok);
  } catch { ok = false; }
  cur.sending = false;
  if (!rec.queue.includes(cur)) return; // closed while in flight
  if (ok) {
    cur.model.submitDone();
    drop(rec, cur);
  } else {
    cur.model.submitFailed();
    cur.error = ERR_SEND; // the drawer stays for a retry
    render(rec);
  }
}

function toTerminal(rec) {
  const cur = rec.queue[0];
  if (!cur || cur.sending || cur.model.state().submitting) return;
  cancelAdvance(cur);
  deliver(rec, cur, { kind: 'terminal' });
}

// Enter / the primary nav button: « Question suivante », « Valider » or « Envoyer ».
function primary(rec) {
  const cur = rec.queue[0];
  if (!cur || cur.sending) return;
  cancelAdvance(cur); // an explicit action wins over the pending auto-advance
  const s = cur.model.state();
  if (s.submitting) return;
  if (s.isLast) submit(rec, cur);
  else if (cur.model.next()) render(rec);
}

function back(rec) {
  const cur = rec.queue[0];
  if (!cur || cur.sending) return;
  clearTimer(cur);
  if (cur.model.prev()) render(rec);
}

function toggle(rec) {
  if (!rec.queue.length) return;
  rec.open = !rec.open;
  render(rec);
}

function drop(rec, entry) {
  const i = rec.queue.indexOf(entry);
  if (i < 0) return;
  clearTimer(entry);
  rec.queue.splice(i, 1);
  if (i === 0 && rec.queue.length && typingHoldMs(rec.lastKeyAt, Date.now()) > 0) { // the next request waits like a new arrival
    rec.held.unshift(...rec.queue.splice(0));
    scheduleRelease(rec);
  }
  render(rec);
  gc(rec);
}

// ---- DOM ----

function h(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}

function icon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'ask-ico');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', '#lc-' + name);
  svg.appendChild(use);
  return svg;
}

function setIcon(svg, name) {
  svg.firstChild.setAttribute('href', '#lc-' + name);
}

function navButton(cls, label, ico) {
  const b = h('button', 'ask-btn ' + cls);
  b.type = 'button';
  if (ico && ico.left) b.appendChild(ico.left);
  const text = h('span', 'ask-btn-label', label);
  b.appendChild(text);
  if (ico && ico.right) b.appendChild(ico.right);
  b.label = text;
  return b;
}

function buildRoot(rec, host) {
  const v = { root: h('div', 'ask-drawer'), key: '', opts: [], other: null };
  const root = v.root;
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', 'Question de Claude');
  root.dataset.face = host.face;

  v.head = h('button', 'ask-head');
  v.head.type = 'button';
  v.chip = h('span', 'ask-chip');
  v.chip.appendChild(icon('circle-help'));
  v.chipText = h('span', 'ask-chip-text');
  v.chip.appendChild(v.chipText);
  v.headQ = h('span', 'ask-head-q');
  v.queue = h('span', 'ask-queue');
  v.count = h('span', 'ask-count');
  v.chev = icon('chevron-down');
  v.head.append(v.chip, v.headQ, v.queue, v.count, v.chev);
  v.head.addEventListener('click', () => toggle(rec));

  v.body = h('div', 'ask-body');
  const inner = h('div', 'ask-body-inner');
  v.q = h('div', 'ask-q');
  v.hint = h('div', 'ask-hint', 'Plusieurs choix possibles');
  v.optsEl = h('div', 'ask-opts');
  v.status = h('div', 'ask-status');
  v.status.setAttribute('role', 'status');

  v.nav = h('div', 'ask-nav');
  v.prev = navButton('ask-prev', 'Précédent', { left: icon('chevron-left') });
  v.term = navButton('ask-term', 'Répondre dans le terminal', { left: icon('terminal') });
  v.main = navButton('ask-primary', 'Question suivante', { right: icon('chevron-right') });
  v.mainIco = v.main.lastChild;
  v.prev.addEventListener('click', () => back(rec));
  v.term.addEventListener('click', () => toTerminal(rec));
  v.main.addEventListener('click', () => primary(rec));
  v.nav.append(v.prev, v.term, v.main);

  inner.append(v.q, v.hint, v.optsEl, v.status, v.nav);
  v.body.appendChild(inner);
  root.append(v.head, v.body);
  return v;
}

function buildOptions(rec, host, v, q) {
  v.optsEl.textContent = '';
  v.optsEl.setAttribute('role', q.multiSelect ? 'group' : 'radiogroup');
  v.opts = q.options.map((o, k) => {
    const n = k + 1;
    const b = h('button', 'ask-opt');
    b.type = 'button';
    b.setAttribute('role', q.multiSelect ? 'checkbox' : 'radio');
    const mark = h('span', 'ask-mark');
    const text = h('span', 'ask-opt-text');
    text.appendChild(h('span', 'ask-opt-label', o.label));
    if (o.description) text.appendChild(h('span', 'ask-opt-desc', o.description));
    b.append(mark, text);
    if (n <= 9) b.appendChild(h('kbd', 'ask-kbd', String(n)));
    b.addEventListener('click', () => selectOption(rec, n));
    v.optsEl.appendChild(b);
    return { b, mark, check: null };
  });
  // « Autre »: chat face mirrors the composer (no input of its own); terminal face owns an input.
  const chat = host.face === 'chat';
  const row = h(chat ? 'div' : 'label', 'ask-opt ask-other');
  row.appendChild(icon('message-square'));
  const label = h('span', 'ask-opt-label', 'Autre');
  row.appendChild(label);
  v.other = { row, input: null, text: null };
  if (chat) {
    v.other.text = h('span', 'ask-other-text');
    row.appendChild(v.other.text);
  } else {
    const input = h('input', 'ask-other-input');
    input.type = 'text';
    input.placeholder = 'Autre réponse…';
    input.setAttribute('aria-label', 'Autre réponse');
    input.addEventListener('input', () => {
      const cur = rec.queue[0];
      if (!cur || !cur.model.setCustom(input.value)) return;
      clearTimer(cur);
      cur.error = '';
      render(rec);
    });
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key !== 'Enter' || e.isComposing) return;
      e.preventDefault();
      primary(rec);
    });
    v.other.input = input;
    row.appendChild(input);
  }
  v.optsEl.appendChild(row);
}

function update(rec, host, cur) {
  const v = host.v;
  const s = cur.model.state();
  const q = s.questions[s.index];
  const key = cur.id + ':' + s.index;
  const busy = cur.sending || s.submitting;

  v.root.dataset.open = String(rec.open);
  v.root.dataset.state = busy ? 'sending' : 'idle';
  v.head.setAttribute('aria-expanded', String(rec.open));
  setIcon(v.chev, rec.open ? 'chevron-down' : 'chevron-up');
  v.body.inert = !rec.open;
  v.chipText.textContent = q.header || 'Question';
  v.headQ.textContent = q.question;
  v.queue.textContent = rec.queue.length > 1 ? `Demande 1/${rec.queue.length}` : '';
  v.queue.hidden = rec.queue.length < 2;
  v.count.textContent = s.count > 1 ? `${s.index + 1}/${s.count}` : '';
  v.count.hidden = s.count < 2;
  v.q.textContent = q.question;
  v.hint.hidden = !q.multiSelect;

  if (v.key !== key) {
    v.key = key;
    buildOptions(rec, host, v, q);
  }
  q.options.forEach((o, k) => {
    const item = v.opts[k];
    const on = q.selected.includes(k);
    item.b.classList.toggle('is-selected', on);
    item.b.setAttribute('aria-checked', String(on));
    item.b.disabled = busy;
    if (on && !item.check) {
      item.check = icon('check');
      item.mark.appendChild(item.check);
    } else if (!on && item.check) {
      item.check.remove();
      item.check = null;
    }
  });
  const custom = q.custom;
  v.other.row.classList.toggle('is-selected', custom.trim() !== '');
  if (v.other.text) v.other.text.textContent = custom || 'Saisissez votre réponse dans la zone de texte';
  if (v.other.input) {
    if (v.other.input.value !== custom) v.other.input.value = custom;
    v.other.input.disabled = busy;
  }

  v.status.textContent = cur.error;
  v.prev.disabled = busy || !s.canPrev;
  v.term.disabled = busy;
  if (busy) {
    v.main.label.textContent = 'Envoi…';
    v.mainIco.toggleAttribute('hidden', true);
    v.main.disabled = true;
  } else if (s.isLast) {
    v.main.label.textContent = 'Envoyer';
    v.mainIco.toggleAttribute('hidden', true);
    v.main.disabled = !s.canSubmit;
  } else {
    v.main.label.textContent = q.multiSelect ? 'Valider' : 'Question suivante';
    v.mainIco.toggleAttribute('hidden', false);
    v.main.disabled = !s.canNext;
  }
  const sendBar = v.main.querySelector('.ld-inline'); // the bar lives while the label reads « Envoi… »
  if (busy && !sendBar) v.main.appendChild(inlineBar());
  else if (!busy && sendBar) sendBar.remove();
}

function leave(host) {
  const root = host.root;
  if (!root) return;
  host.root = null;
  host.v = null;
  host.leaving = root;
  exitThen(root).then(() => {
    // interrupted ops resolve like finished ones: only remove what is still ours
    if (host.leaving === root) host.leaving = null;
    root.remove();
  });
}

function syncHosts(rec) {
  const cur = rec.queue[0];
  for (const host of rec.hosts.values()) {
    if (!cur) { leave(host); continue; }
    if (host.leaving) { host.leaving.remove(); host.leaving = null; }
    if (!host.root) {
      host.v = buildRoot(rec, host);
      host.root = host.v.root;
    }
    if (host.root.parentNode !== host.el) host.el.appendChild(host.root);
    update(rec, host, cur);
  }
}

function dropHostNodes(host) {
  if (host.root) host.root.remove();
  if (host.leaving) host.leaving.remove();
  host.root = null;
  host.v = null;
  host.leaving = null;
}

// ---- keyboard / active pane ----

function scopeOf(host) {
  return host.el.closest('.pane') || host.el;
}

function trackActive(e) {
  const t = e.target;
  activePaneId = null;
  if (!(t instanceof Node)) return;
  for (const rec of recs.values()) {
    for (const host of rec.hosts.values()) {
      if (scopeOf(host).contains(t)) { activePaneId = rec.paneId; return; }
    }
  }
}

function onKey(e) {
  const n = askDigit(e);
  if (n === null || e.defaultPrevented) return;
  if (isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return;
  const rec = activePaneId === null ? null : recs.get(activePaneId);
  if (!rec || !rec.queue.length || !rec.open) return; // background pane / nothing pending / collapsed
  if (selectOption(rec, n)) e.preventDefault();
}

function ensureListeners() {
  if (listening || typeof document === 'undefined') return;
  listening = true;
  document.addEventListener('pointerdown', trackActive, true);
  document.addEventListener('focusin', trackActive, true);
  document.addEventListener('keydown', onKey);
}

// ---- exports ----

function enqueue(rec, entries) {
  if (!rec.queue.length) rec.open = true;
  rec.queue.push(...entries);
  render(rec);
}

function scheduleRelease(rec) {
  clearTimeout(rec.holdTimer);
  rec.holdTimer = setTimeout(() => {
    rec.holdTimer = 0;
    if (!rec.held.length) return;
    if (typingHoldMs(rec.lastKeyAt, Date.now()) > 0) { scheduleRelease(rec); return; }
    enqueue(rec, rec.held.splice(0));
  }, typingHoldMs(rec.lastKeyAt, Date.now()));
}

// 'ask-request' push {id, kind, paneId, tool, input, cwd, ts}.
export function notifyAskRequest(req) {
  if (!req || typeof req !== 'object' || req.kind !== 'ask' || typeof req.id !== 'string' || !req.id || req.paneId == null) return;
  ensureListeners();
  const rec = recFor(req.paneId);
  if (rec.queue.some((e) => e.id === req.id) || rec.held.some((e) => e.id === req.id)) return;
  const entry = makeEntry(req);
  if (!entry.model.state().count) { handBack(req.id); gc(rec); return; } // nothing to render: the TUI takes it
  const typing = typingHoldMs(rec.lastKeyAt, Date.now()) > 0;
  if (!rec.queue.length && (rec.held.length || typing)) {
    rec.held.push(entry);
    scheduleRelease(rec);
    return;
  }
  enqueue(rec, [entry]);
}

// 'ask-closed' push {id}; a bare id string is accepted too. Unknown / already closed ids are a no-op.
export function notifyAskClosed(payload) {
  const id = typeof payload === 'string' ? payload : payload && payload.id;
  if (typeof id !== 'string') return;
  for (const rec of [...recs.values()]) {
    const hi = rec.held.findIndex((e) => e.id === id);
    if (hi >= 0) {
      rec.held.splice(hi, 1);
      if (!rec.held.length) { clearTimeout(rec.holdTimer); rec.holdTimer = 0; }
      gc(rec);
    }
    const qe = rec.queue.find((e) => e.id === id);
    if (qe) drop(rec, qe);
  }
}

// Mounts the drawer slot of one face ('chat' | 'terminal') of a pane; returns the unmount function.
export function mountAskHost(paneId, face, el) {
  const f = face === 'chat' ? 'chat' : 'terminal';
  ensureListeners();
  const rec = recFor(paneId);
  const old = rec.hosts.get(f);
  if (old) dropHostNodes(old);
  const host = { face: f, el, root: null, v: null, leaving: null };
  rec.hosts.set(f, host);
  syncHosts(rec);
  return function unmountAskHost() {
    if (rec.hosts.get(f) !== host) return;
    dropHostNodes(host);
    rec.hosts.delete(f);
    gc(rec);
  };
}

// The chat view calls this on every composer `input`: typing-guard clock + the « Autre » text.
export function askComposerInput(paneId, text) {
  const rec = recFor(paneId);
  rec.lastKeyAt = Date.now();
  const cur = rec.queue[0];
  if (!cur || !cur.model.setCustom(typeof text === 'string' ? text : '')) return;
  clearTimer(cur);
  render(rec);
}

// true while a request is pending: Enter then acts as the drawer's primary action, no PTY write.
export function askComposerSubmit(paneId) {
  const rec = recs.get(paneId);
  if (!rec || !rec.queue.length) return false;
  primary(rec);
  return true;
}

// cb({pending, open, placeholder, qKey, custom}) on every change (a question change included); a subscriber that joins while pending is told at once.
export function onAskHostChange(paneId, cb) {
  const rec = recFor(paneId);
  rec.subs.add(cb);
  const snap = hostSnap(rec);
  if (snap.pending) {
    try { cb({ ...snap }); } catch (err) { console.error('ask-drawer: host callback failed', err); }
  }
  return function unsubscribe() {
    rec.subs.delete(cb);
    gc(rec);
  };
}

// Detached read-only snapshot: askState(paneId) -> one pane (null if unknown), askState() -> all.
export function askState(paneId) {
  const snap = (rec) => ({
    paneId: rec.paneId,
    pending: rec.queue.length > 0,
    open: rec.open,
    lastKeyAt: rec.lastKeyAt,
    hosts: [...rec.hosts.keys()],
    held: rec.held.map((e) => e.id),
    requests: rec.queue.map((e) => ({ id: e.id, sending: e.sending, error: e.error, state: e.model.state() })),
  });
  if (paneId !== undefined) {
    const rec = recs.get(paneId);
    return rec ? snap(rec) : null;
  }
  return { activePaneId, panes: Object.fromEntries([...recs].map(([k, r]) => [k, snap(r)])) };
}
