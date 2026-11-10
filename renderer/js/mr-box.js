// claude-deck — renderer/mr-box: the two-mode box (« Demander à Claude » / « Commenter ») used under a selected
// diff range (popup), in the MR dock and under a thread. One textarea serves both modes, so the typed text survives a switch.
// No IO: the caller's onSubmit does the work. Open = `.mr-pop` (CSS), close = exitThen (opacity / transform only).
import { exitThen } from './motion.js';

const MODES = ['ask', 'comment'];
const TEXTS = {
  ask: { mode: 'Demander à Claude', hint: 'Pose ta question à Claude…', label: 'Question pour Claude', send: 'Envoyer' },
  comment: { mode: 'Commenter', hint: 'Écris ton commentaire…', label: 'Commentaire', send: 'Ajouter à ma revue' },
};
const GROUP = 'Demander à Claude ou commenter';
const POP_OUT = [
  { opacity: 1, transform: 'scale(1)' },
  { opacity: 0, transform: 'scale(0.96)' },
];

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

const token = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// The pop leaves with its own tokens; a missing token falls back to exitThen's defaults.
function popOut(box) {
  const opts = {};
  const m = /^(\d*\.?\d+)(ms|s)$/.exec(token('--dur-pop'));
  if (m) opts.duration = parseFloat(m[1]) * (m[2] === 's' ? 1000 : 1);
  const easing = token('--ease-pop');
  if (easing) opts.easing = easing;
  return exitThen(box, POP_OUT, opts);
}

// onSubmit(mode, text) -> { ok, notice } | Promise of it. ok closes a popup and clears the text; a refusal shows its notice and
// keeps the text. onCancel(): Esc / « Annuler » (a popup also closes itself; the dock box is emptied).
// Thread variant, both optional: labels = { group, ask: {mode, hint, label, send}, comment: {...} } replaces the listed strings,
// heads = { ask, comment } adds a `.mr-box-head` line after the modes that follows the mode. Neither = the box as it always was.
export function createBox({ popup = false, mode = 'ask', onSubmit, onCancel, labels, heads } = {}) {
  let cur = mode === 'comment' ? 'comment' : 'ask';
  let busy = false;
  let closed = false;
  const txt = (m, k) => { const v = labels?.[m]?.[k]; return typeof v === 'string' && v ? v : TEXTS[m][k]; };
  const headOf = (m) => { const v = heads?.[m]; return typeof v === 'string' ? v : ''; };

  const root = el('div', popup ? 'mr-box mr-pop' : 'mr-box');
  if (popup) root.setAttribute('data-sp-popup', ''); // side-panel.js: an open popup owns the next Escape
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', typeof labels?.group === 'string' && labels.group ? labels.group : GROUP);

  const modes = el('div', 'mr-box-modes');
  const buttons = MODES.map((m) => {
    const b = el('button', 'mr-box-mode', txt(m, 'mode'));
    b.type = 'button';
    b.dataset.mode = m;
    b.addEventListener('click', () => { setMode(m); input.focus({ preventScroll: true }); });
    return b;
  });
  modes.append(...buttons);

  const input = el('textarea', 'mr-box-input');
  input.rows = 3;
  const notice = el('div', 'mr-box-notice');
  notice.setAttribute('role', 'alert');
  notice.hidden = true;
  const sendBtn = el('button', 'mr-box-send');
  sendBtn.type = 'button';
  const cancelBtn = el('button', 'mr-box-cancel', 'Annuler');
  cancelBtn.type = 'button';
  const actions = el('div', 'mr-box-actions');
  actions.append(cancelBtn, sendBtn);
  root.append(modes, input, notice, actions);
  const head = MODES.some(headOf) ? el('div', 'mr-box-head') : null;
  if (head) modes.after(head);

  function setMode(m) {
    cur = m;
    for (const b of buttons) {
      const on = b.dataset.mode === m;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    }
    input.placeholder = txt(m, 'hint');
    input.setAttribute('aria-label', txt(m, 'label'));
    sendBtn.textContent = txt(m, 'send');
    if (head) {
      head.textContent = headOf(m);
      head.hidden = !head.textContent;
    }
    notice.hidden = true; // a refusal belongs to the mode it came from; the text stays
  }

  function close() {
    if (closed) return Promise.resolve();
    closed = true;
    return popOut(root).then(() => { if (popup) root.remove(); });
  }

  function cancel() {
    if (closed) return;
    if (typeof onCancel === 'function') onCancel();
    if (popup) close();
    else { input.value = ''; notice.hidden = true; }
  }

  async function send() {
    const text = input.value.trim();
    if (!text || busy || closed) return;
    const sentMode = cur;
    busy = true;
    sendBtn.disabled = true;
    root.setAttribute('aria-busy', 'true');
    let res = null;
    try { res = typeof onSubmit === 'function' ? await onSubmit(sentMode, text) : null; } catch { res = null; }
    busy = false;
    sendBtn.disabled = false;
    root.removeAttribute('aria-busy');
    if (closed) return;
    if (res && res.ok) {
      if (input.value.trim() === text) input.value = '';
      notice.hidden = true;
      if (popup) close();
      return;
    }
    notice.textContent = (res && res.notice) || 'Envoi impossible';
    notice.hidden = false;
    input.focus({ preventScroll: true });
  }

  input.addEventListener('input', () => { notice.hidden = true; });
  sendBtn.addEventListener('click', send);
  cancelBtn.addEventListener('click', cancel);
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation(); // the side panel would otherwise close with the box
      cancel();
    } else if (e.key === 'Enter' && e.target === input && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });

  setMode(cur);
  const focus = () => input.focus({ preventScroll: true });
  if (popup) queueMicrotask(() => { if (root.isConnected) focus(); }); // the caller appends in the same tick
  return { el: root, focus, close };
}
