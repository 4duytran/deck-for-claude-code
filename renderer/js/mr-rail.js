// claude-deck — renderer/mr-rail: the « Discussion » rail of the MR view (spec U7, U8; board D). A head with the thread and draft
// counts, folding sections (description, one item per thread, Claude's answers, the user's review drafts) and a dock with the
// MR-level box and « Envoyer la revue (N) ». No IO: the caller feeds it data (setDescription / setThreads / setDrafts / setSubmit /
// placeClaude) and receives the user's intent through callbacks. setFolded(on) swaps the content for the 52 px strip; the rail
// never folds itself. A thread item offers « Répondre » / « Demander à Claude » (onThreadReply / onThreadAsk) and a slot
// (threadSlot) for the caller's thread box and answer bubbles. GitLab text reaches the DOM through textContent; note bodies
// through markdown-it html:false.
import { collapse, expand } from './motion.js';
import { createBox } from './mr-box.js';
import { ago, initials } from './mr-list.js';
import { skeleton } from './loading.js';

const GENERAL = 'Sur toute la MR';
const SECTIONS = [['desc', 'Description'], ['threads', 'Fils'], ['claude', 'Claude sur la MR'], ['review', 'Ma revue']];
const EMPTY = {
  threads: 'Aucun fil de discussion',
  claude: 'Les réponses de Claude sur la MR apparaissent ici',
  review: 'Aucun brouillon',
};

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function button(label, cls, onClick) {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

function label(node, text) {
  node.title = text;
  node.setAttribute('aria-label', text);
}

// A count in the strip: a leaf span holding the digits (never a button). No svg here: the rail carries none (notes_safe).
function stat(cls) {
  const s = el('span', `mr-strip-stat ${cls}`, '0');
  s.setAttribute('role', 'img');
  return s;
}

const plural = (n, noun) => `${n} ${noun}${n > 1 ? 's' : ''}`;
const isObject = (v) => v !== null && typeof v === 'object';
const list = (v) => (Array.isArray(v) ? v.filter(isObject) : []);
const str = (v) => (typeof v === 'string' ? v : '');

let md; // undefined = not looked up yet, null = vendor script missing
function markdown() {
  if (md === undefined) md = typeof markdownit !== 'undefined' ? markdownit({ html: false, linkify: true }) : null;
  return md;
}

// The template is inert: links and images are neutralised before any node enters the document.
function renderBody(host, text) {
  const m = markdown();
  if (!m) { host.textContent = str(text); return; }
  const tpl = document.createElement('template');
  tpl.innerHTML = m.render(str(text)); // markdown-it, html:false
  for (const a of tpl.content.querySelectorAll('a')) a.removeAttribute('href');
  for (const img of tpl.content.querySelectorAll('img')) img.replaceWith(document.createTextNode(img.getAttribute('alt') || ''));
  host.replaceChildren(tpl.content);
}

function fmtDate(s) {
  const t = Date.parse(s);
  return Number.isNaN(t) ? str(s) : new Date(t).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
}

const pathOf = (p) => str(p.newPath) || str(p.oldPath);
const lineOf = (p) => p.newLine ?? p.oldLine;
const where = (p) => (lineOf(p) != null ? `${pathOf(p)}:${lineOf(p)}` : pathOf(p));
const firstLine = (s) => str(s).split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';
const isResolved = (t) => { const n = list(t.notes); return n.length > 0 && n.every((x) => x.resolved === true); };

const isReply = (d) => d.kind === 'reply';
const isGeneral = (d) => d.kind === 'general' || !isObject(d.path);
const draftPosition = (d) => ({ oldPath: d.path.old ?? null, newPath: d.path.new ?? null, oldLine: d.oldLine ?? null, newLine: d.newLine ?? null });

const newChip = () => el('span', 'mr-note-new', 'Nouveau');

function noteItem(n, isNew) {
  const box = el('div', 'mr-note-item');
  const meta = el('div', 'mr-note-meta');
  meta.append(el('span', 'mr-note-author', str(n.author)), el('span', 'mr-note-date', fmtDate(n.createdAt)));
  if (n.resolved === true) meta.append(el('span', 'mr-note-resolved', 'résolu'));
  if (isNew(n)) meta.append(newChip());
  const text = el('div', 'mr-note-body');
  renderBody(text, n.body);
  box.append(meta, text);
  return box;
}

let uid = 0;

// « 3 messages · <last author>, il y a 2 h »: the date part is left out when the last note has none.
function metaLine(notes) {
  const last = notes[notes.length - 1];
  const who = [str(last.author), ago(str(last.createdAt))].filter(Boolean).join(', ');
  return el('div', 'mr-rail-thread-meta', who ? `${plural(notes.length, 'message')} · ${who}` : plural(notes.length, 'message'));
}

// One item per thread (board D, A5): `div.mr-rail-thread-item` = the compact row (a button), for a general thread its full notes
// (a sibling block, the row toggles it), the meta line, « Répondre » / « Demander à Claude » and the slot. `jump` is null for a
// thread with no position (a general one). `open` = the notes start unfolded (kept across a refresh). `isNew(note)` flags a note a
// refresh brought: the row carries a « Nouveau » chip when any of its notes is flagged. A thread with no id offers no action:
// nothing could address it. `actsOf(t)` = { slot, onReply, onAsk }.
function threadItem(t, jump, open, onToggle, isNew, actsOf) {
  const notes = list(t.notes);
  const first = notes[0] || {};
  const author = str(first.author);
  const item = el('div', 'mr-rail-thread-item');
  const row = el('button', jump ? 'mr-rail-thread' : 'mr-rail-thread general');
  row.type = 'button';
  if (t.id != null) { row.dataset.id = String(t.id); item.dataset.id = String(t.id); }
  const avatar = el('span', 'mr-avatar', initials(author));
  if (author) { avatar.setAttribute('role', 'img'); label(avatar, author); }
  row.append(avatar, el('span', 'mr-rail-thread-pos mr-thread-pos', jump ? where(t.position) : 'Général'),
    el('span', 'mr-rail-thread-text', firstLine(first.body)));
  if (notes.some((n) => isNew(n))) row.append(newChip());
  if (isResolved(t)) row.append(el('span', 'mr-note-resolved', 'résolu'));
  item.append(row);
  if (jump) {
    row.title = 'Aller à la ligne';
    row.addEventListener('click', () => jump(t.position));
  } else {
    const detail = el('div', 'mr-rail-thread-notes');
    detail.id = `mr-rail-notes-${++uid}`;
    detail.append(...notes.map((n) => noteItem(n, isNew)));
    detail.style.display = open ? '' : 'none';
    row.setAttribute('aria-expanded', String(open));
    row.setAttribute('aria-controls', detail.id);
    row.addEventListener('click', () => {
      const next = row.getAttribute('aria-expanded') !== 'true';
      row.setAttribute('aria-expanded', String(next));
      onToggle(next);
      if (next) expand(detail);
      else collapse(detail);
    });
    item.append(detail);
  }
  if (notes.length) item.append(metaLine(notes));
  if (t.id != null) {
    const acts = actsOf(t);
    const actions = el('div', 'mr-rail-thread-actions');
    actions.append(button('Répondre', 'mr-rail-reply', acts.onReply), button('Demander à Claude', 'mr-rail-ask', acts.onAsk));
    item.append(actions, acts.slot);
  }
  return item;
}

export function mountMrRail(host, { onJump, onEditDraft, onDeleteDraft, onAsk, onComment, onSubmit, onFoldChange, onThreadReply, onThreadAsk } = {}) {
  const call = (fn, ...args) => (typeof fn === 'function' ? fn(...args) : null);
  const root = el('div', 'mr-rail');
  const heads = {};
  const bodies = {};
  const empties = {};

  // ---- folded strip (board D): unfold chevron, thread count, draft count, send; first child of the root ----
  const strip = el('div', 'mr-rail-strip');
  const unfold = button('‹', 'mr-strip-btn mr-strip-unfold', () => call(onFoldChange, false));
  label(unfold, 'Déplier la discussion');
  const threadStat = stat('mr-strip-threads');
  const draftStat = stat('mr-strip-drafts');
  const stripSend = button('0', 'mr-strip-btn mr-strip-send', () => call(onSubmit, stripSend));
  stripSend.disabled = true;
  label(stripSend, 'Envoyer la revue (0)');
  strip.append(unfold, threadStat, draftStat, stripSend);

  // ---- head (board D): title and « 3 fils · 2 brouillons »; the fold control stays in the MR head ----
  const railHead = el('div', 'mr-rail-head');
  const counts = el('span', 'mr-rail-counts');
  // Freshness marker (A6): a dot and the age of the last successful read, hidden until the caller gives a first age.
  const fresh = el('span', 'mr-rail-fresh');
  const freshText = el('span', 'mr-rail-fresh-text');
  fresh.hidden = true;
  fresh.append(el('span', 'mr-rail-fresh-dot'), freshText);
  railHead.append(el('span', 'mr-rail-title', 'Discussion'), counts, fresh);
  root.append(strip, railHead);

  // `sec` = whole seconds since that read; null (or any value that is not a finite number >= 0) hides the marker again.
  function setFresh(sec) {
    const ok = typeof sec === 'number' && Number.isFinite(sec) && sec >= 0;
    fresh.hidden = !ok;
    if (ok) freshText.textContent = `à jour · il y a ${Math.floor(sec)} s`;
  }

  let threadN = 0;
  let draftN = 0;
  function setCount(s, n, noun) {
    s.textContent = String(n);
    label(s, plural(n, noun));
    if (s === threadStat) threadN = n;
    else draftN = n;
    counts.textContent = `${plural(threadN, 'fil')} · ${plural(draftN, 'brouillon')}`;
  }
  setCount(threadStat, 0, 'fil');
  setCount(draftStat, 0, 'brouillon');

  // End state only: the view's fold function owns the motion; inline display wins over any stylesheet rule.
  let folded = false;
  const foldChild = (c) => { if (c !== strip) c.style.display = folded ? 'none' : ''; };
  function setFolded(on) {
    folded = Boolean(on);
    strip.hidden = !folded;
    strip.style.display = folded ? '' : 'none';
    for (const c of root.children) foldChild(c);
  }

  const secs = {};
  for (const [key, title] of SECTIONS) {
    const section = el('div', 'mr-rail-sec');
    section.dataset.sec = key;
    const head = el('button', 'mr-rail-sec-head', title);
    head.type = 'button';
    head.setAttribute('aria-expanded', 'true');
    const body = el('div', 'mr-rail-sec-body');
    body.id = `mr-rail-${key}-${Math.random().toString(36).slice(2, 8)}`;
    head.setAttribute('aria-controls', body.id);
    section.append(head, body);
    if (EMPTY[key]) {
      const empty = el('div', 'mr-rail-empty', EMPTY[key]);
      body.append(empty);
      empties[key] = empty;
    }
    head.addEventListener('click', () => setOpen(key, head.getAttribute('aria-expanded') !== 'true'));
    if (key !== 'desc') root.append(section); // the description section joins the rail only while it holds text
    secs[key] = section;
    heads[key] = head;
    bodies[key] = body;
  }
  secs.claude.hidden = true; // until placeClaude gives it an answer

  function setOpen(key, open) {
    if ((heads[key].getAttribute('aria-expanded') === 'true') === open) return;
    heads[key].setAttribute('aria-expanded', String(open));
    if (open) expand(bodies[key]);
    else collapse(bodies[key]);
  }

  // ---- description ----
  function setDescription(text) {
    const t = str(text).trim();
    if (!t) { secs.desc.remove(); bodies.desc.replaceChildren(); return; }
    renderBody(bodies.desc, t);
    if (!secs.desc.isConnected) { root.insertBefore(secs.desc, secs.threads); foldChild(secs.desc); }
  }

  // ---- threads ----
  const openNotes = new Set(); // ids of the general threads whose notes are unfolded
  let slots = new Map(); // thread id -> the slot element of its item: the same element across repaints, so what the caller put there stays
  let threadIndex = new Map(); // thread id -> thread, from the last setThreads (labels of the reply drafts)

  // The label of a reply draft: its thread's first author and place; « Réponse à un fil » when the thread is not listed.
  function replyLabel(d) {
    const t = threadIndex.get(str(d.discussionId));
    if (!t) return 'Réponse à un fil';
    const author = str((list(t.notes)[0] || {}).author);
    return `${author ? `Réponse à ${author}` : 'Réponse à un fil'} · ${isObject(t.position) ? where(t.position) : 'Général'}`;
  }
  const replyLabels = () => drafts.filter(isReply).map(replyLabel).join('\n');

  // opts.isNew(note) (optional) flags the notes a refresh brought (A7): their rail item gets a « Nouveau » chip.
  function setThreads(res, opts) {
    const diff = isObject(res) ? list(res.diffThreads).filter((t) => isObject(t.position)) : [];
    const general = isObject(res) ? list(res.general) : [];
    const isNew = isObject(opts) && typeof opts.isNew === 'function' ? (n) => Boolean(opts.isNew(n)) : () => false;
    const toggler = (t) => (open) => { if (open) openNotes.add(String(t.id)); else openNotes.delete(String(t.id)); };
    const kept = (t) => t.id != null && openNotes.has(String(t.id));
    const before = replyLabels();
    threadIndex = new Map([...diff, ...general].filter((t) => t.id != null).map((t) => [String(t.id), t]));
    const nextSlots = new Map();
    const actsOf = (t) => {
      const id = String(t.id);
      let slot = nextSlots.has(id) ? null : slots.get(id); // a repeated id gets a fresh slot, never the same node twice
      if (!slot) slot = el('div', 'mr-rail-thread-slot');
      if (!nextSlots.has(id)) nextSlots.set(id, slot);
      return { slot, onReply: () => call(onThreadReply, t), onAsk: () => call(onThreadAsk, t) };
    };
    const items = [
      ...diff.map((t) => threadItem(t, (pos) => call(onJump, pos), false, null, isNew, actsOf)),
      ...general.map((t) => threadItem(t, null, kept(t), toggler(t), isNew, actsOf)),
    ];
    slots = nextSlots;
    const n = diff.length + general.length;
    empties.threads.hidden = n > 0;
    bodies.threads.replaceChildren(empties.threads, ...items);
    setCount(threadStat, n, 'fil');
    if (replyLabels() !== before) renderDrafts(); // the threads arrived (or changed) after the drafts
  }

  // The slot of the item of thread `id` (diff or general), null when that thread is not listed.
  const threadSlot = (id) => (id == null ? null : slots.get(String(id)) || null);

  // ---- drafts ----
  let drafts = [];
  let editing = null; // { id, value } of the draft being edited, kept across a refresh
  const seen = new Set();
  let primed = false; // the first list is not announced draft by draft

  function editor(d) {
    const ta = el('textarea', 'mr-draft-edit');
    ta.rows = 3;
    ta.value = editing.value;
    ta.setAttribute('aria-label', 'Modifier le brouillon');
    const note = el('div', 'mr-draft-note');
    note.hidden = true;
    const save = button('Enregistrer', 'mr-draft-save', async () => {
      const text = ta.value.trim();
      if (!text) { note.textContent = 'Brouillon vide'; note.hidden = false; return; }
      save.disabled = true;
      let res = null;
      try { res = await call(onEditDraft, d, text); } catch { res = { ok: false }; }
      if (res && res.ok === false) {
        save.disabled = false;
        note.textContent = str(res.notice) || 'Enregistrement impossible';
        note.hidden = false;
        return;
      }
      editing = null;
      renderDrafts();
    });
    const cancel = button('Annuler', 'mr-draft-cancel', () => { editing = null; renderDrafts(); });
    const stop = () => { editing = null; renderDrafts(); };
    ta.addEventListener('input', () => { editing.value = ta.value; note.hidden = true; });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); stop(); }
      else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save.click(); }
    });
    const actions = el('div', 'mr-draft-actions');
    actions.append(save, cancel);
    return [ta, note, actions];
  }

  function draftItem(d, fresh) {
    const reply = isReply(d);
    const general = !reply && isGeneral(d);
    const box = el('div', reply ? 'mr-rail-draft reply' : general ? 'mr-rail-draft general' : 'mr-rail-draft');
    if (d.id != null) box.dataset.id = String(d.id);
    if (fresh) box.classList.add('mr-enter');
    const head = el('div', 'mr-draft-head');
    if (reply) {
      const ico = el('span', 'mr-draft-ico', '↩');
      ico.setAttribute('aria-hidden', 'true');
      head.append(ico, el('span', 'mr-draft-pos', replyLabel(d)));
    } else {
      const pos = general ? null : draftPosition(d);
      if (pos && lineOf(pos) != null) head.append(el('span', 'mr-rail-draft-line', `L${lineOf(pos)}`));
      head.append(el('span', 'mr-draft-pos', general ? GENERAL : pathOf(pos)));
    }
    if (typeof d.error === 'string' && d.error) head.append(el('span', d.uncertain ? 'mr-draft-error mr-draft-uncertain' : 'mr-draft-error', d.error));
    box.append(head);
    if (editing && editing.id === d.id) { box.append(...editor(d)); return box; }
    const actions = el('div', 'mr-draft-actions');
    actions.append(
      button('Modifier', 'mr-draft-edit-btn', () => { editing = { id: d.id, value: str(d.body) }; renderDrafts(); }),
      button('Supprimer', 'mr-draft-del', () => call(onDeleteDraft, d)),
    );
    if (!general && !reply) actions.append(button('Aller à la ligne', 'mr-draft-jump', () => call(onJump, draftPosition(d))));
    box.append(el('div', 'mr-draft-body', str(d.body)), actions);
    return box;
  }

  function renderDrafts() {
    if (editing && !drafts.some((d) => d.id === editing.id)) editing = null; // its draft left: no orphan editor
    const items = drafts.map((d) => draftItem(d, primed && d.id != null && !seen.has(d.id)));
    for (const d of drafts) if (d.id != null) seen.add(d.id);
    primed = true;
    empties.review.hidden = items.length > 0;
    bodies.review.replaceChildren(empties.review, ...items);
  }

  function setDrafts(next) {
    drafts = list(next);
    renderDrafts();
    setCount(draftStat, drafts.length, 'brouillon');
  }

  // ---- dock ----
  const dock = el('div', 'mr-dock');
  const box = createBox({
    popup: false,
    mode: 'ask',
    onSubmit: (mode, text) => (mode === 'comment' ? call(onComment, text) : call(onAsk, text)),
    onCancel: () => {},
  });
  const send = button('Envoyer la revue (0)', 'mr-send-btn', () => call(onSubmit, send));
  send.disabled = true;
  dock.append(el('div', 'mr-dock-title', GENERAL), box.el, send);
  root.append(dock);

  function setSubmit(n, enabled) {
    const count = Number.isInteger(n) && n > 0 ? n : 0;
    send.textContent = `Envoyer la revue (${count})`;
    send.disabled = !enabled;
    stripSend.textContent = String(count);
    label(stripSend, send.textContent);
    stripSend.disabled = !enabled;
  }

  function placeClaude(bubble) {
    if (!(bubble instanceof Element)) return;
    empties.claude.hidden = true;
    secs.claude.hidden = false;
    bubble.classList.add('mr-enter');
    bodies.claude.append(bubble);
    setOpen('claude', true);
    try { bubble.scrollIntoView({ block: 'nearest' }); } catch { /* detached host: nothing to scroll */ }
  }

  // Sections whose data is still on its way show a skeleton instead of the empty text; their setter replaces it.
  function setLoading(keys) {
    for (const key of Array.isArray(keys) ? keys : []) {
      if (key !== 'threads' && key !== 'review') continue;
      empties[key].hidden = true;
      bodies[key].replaceChildren(empties[key], skeleton(3));
    }
  }

  setFolded(false); // the strip starts hidden
  host.replaceChildren(root); // each section starts with its empty message
  return { setDescription, setThreads, setDrafts, setSubmit, placeClaude, setFolded, setLoading, setFresh, threadSlot };
}
