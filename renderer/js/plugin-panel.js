// claude-deck — renderer/plugin-panel: the « Plugins » panel, a #workspace overlay with the Room shell, opened by the header button (daily-brief plugin host).
// A view over the plugins-* IPC payloads: the renderer does no IO, every string from a plugin (label, description,
// error line) reaches the DOM through textContent. The panel always exists; with no plugin it shows an empty state.
// One report view (#plg-view) shows the latest report of the current row in a closed frame (sandbox allow-scripts).
// boot.js owns the plugins-changed listener and calls notifyPluginsChanged(); this module subscribes to nothing.
// One card (#plg-card, above the list) serves the import (pick -> manifest -> confirm), its refusal and the delete confirmation.
// Two pages (K5, #plugin-panel[data-page]): the list of plugins, then the detail of the one picked. The detail holds a head (#plg-dhead), the tabs
// (#plg-detail: Rapport | Journal | Historique | Paramètres), the report / journal (#plg-view), #plg-hist and #plg-settings, all following the picked row.
// Access: the import card and the « Accès · Modifier » screen (same card) list one row per declared slot; the user maps NAMES only.
// The « Modifier » screen also shows one segmented control per option the manifest declares (« Appels Claude »), stored by the host.
'use strict';

import { overlayState } from './state.js';
import { setMode } from './mode.js';
import { parseJournal } from './plugin-journal.js';
import { swapIn, revealFrame } from './motion.js';

const NOT_CONFIGURED = 'À configurer'; // the `status` of a row whose required access is missing
const TOO_LARGE = 'tooLarge'; // plugins-open-report: the report is over the 1 MiB page cap
const TRIGGER_LABELS = { daily: 'Quotidien', manual: 'Manuel' };
const SCOPE_LINE = 'Ce plugin recevra uniquement les accès listés ci-dessous.';

// open: the panel is open · loaded: a first answer arrived · rows: the last plugins-list · shown: the row the user picked
// (null = the default row) · busy: ids with a call in flight · notes: id -> refusal line of the last action
// viewKey: what #plg-view holds (so an unrelated refresh never reloads the frame) · refocus: control to focus after a repaint
// card: null | { kind: 'import' | 'refused' | 'delete', busy, error, ... } shown in #plg-card · pickBusy: the folder dialog is open
// History of the shown plugin (#plg-detail, #plg-hist): tab 'report' | 'history' · range '1' | '7' | '30' | 'date' · date 'YYYY-MM-DD'
// pick { id, entry }: the history row opened in the report view (null = the latest) · hist { id, all, rows }: every entry / the filtered ones
export const plg = { open: false, loaded: false, rows: [], shown: null, busy: new Set(), notes: new Map(), viewKey: null, refocus: null, card: null, pickBusy: false,
  tab: 'report', range: '7', date: '', pick: null, hist: { id: null, all: [], rows: [] }, full: null, page: 'list', set: null,
  stopping: new Set() }; // stopping: ids whose « Arrêter » was clicked and not answered yet (the button reads « Arrêt… »)
let loadSeq = 0; // a stale plugins-list answer paints nothing
let viewSeq = 0; // same for a report load or a journal read
// plg.full: { id, stem } while « Journal complet » (the row action) shows every line of that entry's log; null = the default view
let cardSeq = 0; // same for a pick / import / delete answer: closing the card or the panel moves it on
let histSeq = 0; // same for a history load
let setSeq = 0; // same for the access read of the Paramètres tab (plg.set: the access state of the shown plugin)
let builtSet = null; // what #plg-settings was built for: { set, key }

const $ = (id) => document.getElementById(id);

// ---- motion (K6): a view change is a page swap, never a cut. Page / tab / entry state, hidden flags, showLine views and the Historique / Paramètres clear change in one task;
// a report or journal view replaces the old content in the task where its IPC answer arrives (the old one stays until then). Only what ARRIVES is animated (swapIn);
// a report frame is held at opacity 0 until its `load` (revealFrame), over #plg-view's dark surface: nothing white.
let swapDir = 'forward'; // the side the next arrival is read from: 'forward' = deeper / to the right, 'back' = the other way

// Boxes already in their end state arrive with the page-swap slide + fade; a hidden or undisplayed one is left alone.
function arrive(ids, dir = swapDir) {
  for (const id of ids) {
    const n = $(id);
    if (n && !n.hidden && getComputedStyle(n).display !== 'none') swapIn(n, { dir });
  }
}

// #plg-view takes `node` at once (when `seq` is still the current view): a report frame is revealed on its `load`, any other node arrives with swapIn.
// `then` runs once `node` is in the view.
function putView(seq, node, then) {
  if (seq !== viewSeq || !plg.open) return;
  const frame = node.tagName === 'IFRAME';
  if (frame) revealFrame(node);
  $('plg-view').replaceChildren(node);
  if (then) then();
  if (!frame) swapIn(node, { dir: swapDir });
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = text;
  return n;
}

const pad = (n) => String(n).padStart(2, '0');
function when(ms) {
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const labelOf = (row) => (typeof row.label === 'string' && row.label ? row.label : row.id);
const text = (v) => (typeof v === 'string' ? v : '');
// A run the user stopped (K2): `stopped` on the entry; a stop that still ended with exit 0 is a success, not a stop.
const wasStopped = (e) => !!e && e.stopped === true && e.exit !== 0;
// run and stop swap in place on a row, so a focus held on one lands on the other after the repaint
const slotOf = (act) => (act === 'run' || act === 'stop' ? '[data-act="run"], [data-act="stop"]' : `[data-act="${act}"]`);

// Absolute day / time of an entry (the host's clock may differ from this one: no « Aujourd'hui », no « Hier »).
const DAYS = ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'];
const MONTHS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
const TRIGGERS = { auto: 'Automatique', manual: 'Manuel' };
const TABS = [['report', 'Rapport'], ['journal', 'Journal'], ['history', 'Historique'], ['settings', 'Paramètres']];
const RANGES = [['1', '1 j'], ['7', '7 j'], ['30', '30 j'], ['date', 'Date…']];
function dayLabel(ms) {
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  return `${DAYS[d.getDay()].replace(/^./, (c) => c.toUpperCase())} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}
const hhmm = (ms) => (Number.isFinite(ms) ? `${pad(new Date(ms).getHours())}:${pad(new Date(ms).getMinutes())}` : '');
const dayKey = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const entriesOf = (v) => (Array.isArray(v) ? v.filter((e) => e && typeof e === 'object' && typeof e.stem === 'string' && Number.isFinite(e.start)) : []);

// The row the detail page shows: the picked one; none on the list page (nothing is loaded for a page nobody sees).
function shownRow() {
  return plg.page === 'detail' ? plg.rows.find((r) => r.id === plg.shown) || null : null;
}

// { text, tone } of the status line. `ready` null (shell never read) says nothing about access: no guess.
function statusOf(row) {
  if (row.status === NOT_CONFIGURED) return { text: NOT_CONFIGURED, tone: 'warn' };
  if (row.running === true) return { text: 'En cours…', tone: 'run' };
  const l = row.latest;
  if (!l || typeof l !== 'object') return { text: 'Pas encore exécuté', tone: '' };
  const at = when(l.start);
  if (wasStopped(l)) return { text: `Arrêté · ${at}`, tone: '' };
  if (l.exit === 0) return { text: l.hasReport ? `Dernier rapport : ${at}` : `Dernière exécution : ${at}, sans rapport`, tone: '' };
  if (Number.isInteger(l.exit)) return { text: `Échec (code ${l.exit}) · ${at}`, tone: 'bad' };
  return { text: `Interrompu · ${at}`, tone: 'bad' };
}

// The refusal line under a row: the last action's answer, else the static reason a known-unready plugin cannot run.
function noteOf(row) {
  const said = plg.notes.get(row.id);
  if (said) return said;
  if (row.ready !== false) return '';
  if (typeof row.error === 'string' && row.error) return row.error;
  const missing = Array.isArray(row.missing) ? row.missing.filter((m) => typeof m === 'string' && m) : [];
  return missing.length ? `Accès requis manquant : ${missing.join(', ')}` : '';
}

// « Lancer » while idle, « Arrêter » while the plugin runs (« Arrêt… » once clicked, until main answers).
function runButton(row, cls, label) {
  const going = row.running === true;
  const run = el('button', cls, going ? (plg.stopping.has(row.id) ? 'Arrêt…' : 'Arrêter') : label);
  run.type = 'button';
  run.dataset.act = going ? 'stop' : 'run';
  run.disabled = plg.busy.has(row.id) || (!going && row.status === NOT_CONFIGURED);
  return run;
}

// { text, title } of the call-mode badge of a list row: the label of the chosen choice of its CLAUDE_MODE option (the one option the list names).
// null for anything else: no such option, a value matching no choice, a label-less choice or a malformed row; the raw value is never shown.
function modeOf(row) {
  const o = Array.isArray(row.options) ? row.options.find((x) => x && typeof x === 'object' && x.name === 'CLAUDE_MODE') : null;
  const ch = o && Array.isArray(o.choices) ? o.choices.find((c) => c && typeof c === 'object' && typeof c.value === 'string' && c.value === o.value) : null;
  const label = ch ? text(ch.label) : '';
  return label ? { text: label, title: `${text(o.label) || o.name} : ${label}` } : null;
}

// A list row: the pick (label), the enabled badge, the call-mode badge, the status line, the refusal line and ONE quick action. Everything else lives on the detail page.
function buildRow(row) {
  const item = el('div', 'plg-row');
  item.dataset.id = row.id;
  item.setAttribute('role', 'listitem');
  item.classList.toggle('off', row.enabled !== true);
  const head = el('div', 'plg-line');
  const pick = el('button', 'plg-pick');
  pick.type = 'button';
  pick.dataset.act = 'pick';
  pick.appendChild(el('span', 'plg-label', labelOf(row)));
  const state = el('span', `plg-badge plg-state${row.enabled === true ? ' ok' : ''}`, row.enabled === true ? 'Activé' : 'Désactivé'); // the Paramètres switch, never the run state
  const mode = modeOf(row);
  const modeBadge = mode ? el('span', 'plg-badge plg-mode', mode.text) : null;
  if (modeBadge) modeBadge.title = mode.title;
  head.append(...[pick, state, modeBadge, runButton(row, 'plg-run', 'Lancer')].filter(Boolean));
  const desc = el('p', 'plg-desc', text(row.description));
  desc.hidden = !desc.textContent;
  const st = statusOf(row);
  const status = el('div', `plg-status${st.tone ? ` ${st.tone}` : ''}`, st.text);
  const noteText = noteOf(row);
  const note = el('p', 'plg-note', noteText);
  note.hidden = !noteText;
  note.setAttribute('role', 'status');
  item.append(head, desc, status, note);
  return item;
}

// The head of the detail page: title, status, description and refusal line, then run / delete. The control that held the focus keeps it.
function renderHead() {
  const host = $('plg-dhead');
  const row = shownRow();
  const a = document.activeElement;
  const held = (a && host.contains(a) && a.dataset ? a.dataset.act : null) || (row && plg.refocus && plg.refocus.id === row.id ? plg.refocus.act : null);
  if (!row) { host.replaceChildren(); return; }
  const busy = plg.busy.has(row.id);
  const info = el('div', 'plg-dinfo');
  const st = statusOf(row);
  const desc = el('p', 'plg-desc', text(row.description));
  desc.hidden = !desc.textContent;
  const noteText = noteOf(row);
  const note = el('p', 'plg-note', noteText);
  note.hidden = !noteText;
  note.setAttribute('role', 'status');
  info.append(el('h2', null, labelOf(row)), el('div', `plg-status${st.tone ? ` ${st.tone}` : ''}`, st.text), desc, note);
  const del = el('button', 'plg-del', 'Supprimer');
  del.type = 'button';
  del.dataset.act = 'delete';
  del.disabled = busy;
  host.replaceChildren(info, runButton(row, 'plg-run', 'Lancer maintenant'), del);
  const next = held ? host.querySelector(slotOf(held)) : null;
  if (next && !next.disabled) next.focus({ preventScroll: true });
}

// « N variables associées » / « N accès requis manquants » from the host's list row; nothing while the host has said nothing.
function accessLine(row) {
  const left = row.ready === false && Array.isArray(row.missing) ? row.missing.length : 0;
  if (left) return plural(left, 'accès requis manquant', 'accès requis manquants');
  const set = row.envMap && typeof row.envMap === 'object' ? Object.keys(row.envMap).length : 0;
  return set ? plural(set, 'variable associée', 'variables associées') : '';
}

// The control holding the focus inside the list, as { id, act }: a repaint rebuilds the nodes and would drop it.
function focusedControl() {
  const a = document.activeElement;
  const row = a && a.closest ? a.closest('#plg-list .plg-row') : null;
  return row && a.dataset && a.dataset.act ? { id: row.dataset.id, act: a.dataset.act } : null;
}

function renderList() {
  const list = $('plg-list');
  const held = focusedControl() || plg.refocus;
  const show = plg.loaded;
  $('plg-empty').hidden = !(show && plg.rows.length === 0);
  list.hidden = !(show && plg.rows.length > 0);
  $('plg-count').textContent = show && plg.rows.length ? String(plg.rows.length) : '';
  list.replaceChildren(...plg.rows.map(buildRow));
  if (!held || held.act !== 'access') plg.refocus = null; // « Modifier » is in Paramètres: renderSettings gives that focus back
  if (!held) return;
  const next = list.querySelector(`.plg-row[data-id="${CSS.escape(held.id)}"]`)?.querySelector(slotOf(held.act));
  if (!next) return;
  if (next.disabled) plg.refocus = held; // a call is in flight: try again at the next repaint
  else next.focus({ preventScroll: true });
}

function showLine(line, seq = viewSeq) {
  const p = el('p', 'plg-view-note', line);
  p.setAttribute('role', 'status');
  putView(seq, p);
}

function refusalOf(res) {
  if (res && res.error === TOO_LARGE) return 'Rapport trop volumineux (plus de 1 Mo) : non affiché';
  return res && typeof res.error === 'string' && res.error ? res.error : 'Rapport non affichable';
}

async function loadReport(row, stem, seq) {
  let res = null;
  try { res = await window.api.pluginsOpenReport(row.id, stem); } catch (_) { /* a rejected call is a refusal */ }
  if (seq !== viewSeq || !plg.open) return; // the view moved on
  if (res && res.ok === true && typeof res.url === 'string' && res.url.startsWith('deckpage://')) {
    const frame = document.createElement('iframe');
    frame.className = 'fp-frame';
    frame.setAttribute('sandbox', 'allow-scripts'); // never allow-same-origin: the report would reach the Deck
    frame.title = `Rapport — ${labelOf(row)}`;
    frame.src = res.url;
    putView(seq, frame);
  } else {
    showLine(refusalOf(res), seq);
  }
}

// The entry of a run still going: the row is running and the entry is its newest, with no exit yet (histRow marks it the same way).
const isLive = (row, e) => row.running === true && !Number.isInteger(e.exit) && !!row.latest && typeof row.latest === 'object' && row.latest.stem === e.stem;

// ---- run journal: the steps, the failure and the log of ONE run; live (1 s poll of plugins-read-log) while that run goes -----------
// The plugin writes the step lines and their durations; the Deck parses them (plugin-journal.js) and shows every string as text.

const STATE_WORDS = { wait: 'en attente', start: 'en cours', done: 'terminé', warn: 'avertissement', fail: 'échec' };
const mmss = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${pad(s % 60)}`; };
let liveView = null; // the journal on screen while its run goes: { seq, id, entry, full, p, busy }
let pollT = 0;
let followed = null; // the run seen going on the Journal tab: { id, stem }; its successful end moves the view to the Rapport tab

// The entry a card shows: the history pick when it belongs to that plugin, else its latest run.
function entryOfRow(row) {
  const pick = plg.pick && plg.pick.id === row.id ? plg.pick.entry : null;
  const l = row.latest && typeof row.latest === 'object' && typeof row.latest.stem === 'string' ? row.latest : null;
  return pick || l;
}
const isFull = (row, e) => !!e && !!plg.full && plg.full.id === row.id && plg.full.stem === e.stem;
// A journal can be read once its log is listed, or while its run goes (the host may not list the log yet).
const hasJournal = (row, e) => !!e && (e.hasLog === true || isLive(row, e));
const isFullShown = (row, e) => hasJournal(row, e) && isFull(row, e);

async function readLog(id, stem) {
  let res = null;
  try { res = await window.api.pluginsReadLog(id, stem); } catch (_) { /* a rejected call is a refusal */ }
  return res && res.ok === true && typeof res.text === 'string' ? { text: res.text, truncated: res.truncated === true } : { error: lineOf(res, 'Journal illisible') };
}

function buildJournal() {
  const p = { box: el('div', 'plg-journal plg-fail'), title: el('p', 'plg-fail-title'), steps: el('ol', 'plg-steps'), fail: el('div', 'plg-fail-box'),
    logTitle: el('p', 'plg-log-title'), pre: el('pre', 'plg-log'), note: el('p', 'plg-log-note', 'journal tronqué'), full: el('button', 'plg-jfull', 'Journal complet') };
  p.full.type = 'button';
  p.full.dataset.act = 'journal';
  p.box.append(p.title, p.full, p.steps, p.fail, p.logTitle, p.pre, p.note);
  return p;
}

function stepNode(id) {
  const li = el('li', 'plg-step');
  li.dataset.id = id;
  const ico = el('span', 'plg-step-ico');
  ico.setAttribute('aria-hidden', 'true');
  const body = el('span', 'plg-step-body');
  body.append(el('span', 'plg-step-label'), el('span', 'plg-step-detail'));
  li.append(ico, body, el('span', 'plg-step-state'));
  return li;
}

// Fills the journal parts from d = { entry, live, full, log } in place: a step keeps its node while its id holds, so a state change can transition.
function paintJournal(p, d) {
  const e = d.entry;
  const exit = Number.isInteger(e.exit) ? e.exit : null;
  const raw = d.log && typeof d.log.text === 'string' ? d.log.text : '';
  const j = parseJournal(raw, { live: d.live, exit });
  const ended = !d.live && exit !== 0; // a step cut short by a run that did not succeed reads failed
  const head = d.live ? 'En cours…' : exit === 0 ? 'Terminé' : wasStopped(e) ? 'Arrêté' : exit === null ? 'Interrompu' : `Échec (code ${exit})`;
  p.box.dataset.tone = d.live ? 'run' : exit === 0 ? 'ok' : 'bad';
  p.title.textContent = `${head} · ${dayLabel(e.start)} à ${hhmm(e.start)}`;

  const now = Date.now();
  while (p.steps.children.length > j.steps.length) p.steps.lastChild.remove();
  j.steps.forEach((s, i) => {
    let li = p.steps.children[i];
    if (!li || li.dataset.id !== s.id) {
      const fresh = stepNode(s.id);
      if (li) li.replaceWith(fresh); else p.steps.append(fresh);
      li = fresh;
    }
    const state = ended && s.state === 'start' ? 'fail' : s.state;
    li.dataset.state = state;
    li.querySelector('.plg-step-label').textContent = s.label;
    li.querySelector('.plg-step-detail').textContent = s.text;
    const elapsed = state === 'start' && Number.isFinite(s.startMs) ? ` · ${mmss(now - s.startMs)}` : '';
    li.querySelector('.plg-step-state').textContent = STATE_WORDS[state] + elapsed;
  });
  p.steps.hidden = j.steps.length === 0;

  const notes = [];
  const add = (t, cls) => notes.push(el('p', cls ? `plg-fail-text ${cls}` : 'plg-fail-text', t));
  if (ended) {
    const at = j.failed ? j.failed.step : j.steps.filter((s) => s.state === 'start').pop();
    add(`Le plugin s’est arrêté${exit === null ? '' : ` (code ${exit})`}${at ? ` pendant ${at.label}` : ''}.`);
    if (j.failed && j.failed.step) add(j.failed.text, 'plg-fail-err');
  }
  if (!d.live && e.hasReport !== true) add('Cette exécution n’a pas écrit de rapport.');
  const miss = d.live ? '' : d.log === null ? 'Pas de journal pour cette exécution.' : d.log.error || (raw.trim() === '' ? 'Le journal est vide.' : '');
  if (miss) add(miss);
  p.fail.replaceChildren(...notes);
  p.fail.hidden = notes.length === 0;

  // A log with no step line (an older plugin) is shown as it was written; otherwise the last 8 lines, or every line on « Journal complet ».
  const plain = j.steps.length === 0;
  const text = plain ? (d.live ? raw.slice(0, raw.lastIndexOf('\n') + 1) : raw) : (d.full ? j.allLines : j.lines).join('\n');
  const none = text.trim() === '';
  p.full.setAttribute('aria-pressed', String(d.full === true));
  p.full.disabled = !(d.live || e.hasLog === true); // hasJournal: a log listed, or the run goes
  p.logTitle.textContent = d.full ? 'Journal complet' : plain ? 'Journal' : 'Journal · dernières lignes';
  p.pre.textContent = text;
  p.logTitle.hidden = none;
  p.pre.hidden = none;
  p.note.hidden = none || !(d.log && d.log.truncated === true);
  p.pre.scrollTop = p.pre.scrollHeight;
}

function stopPoll() {
  clearInterval(pollT);
  pollT = 0;
  liveView = null;
}

async function pollTick() {
  const v = liveView;
  if (!v || v.busy) return;
  if (!plg.open || v.seq !== viewSeq) { stopPoll(); return; }
  v.busy = true;
  const log = await readLog(v.id, v.entry.stem);
  v.busy = false;
  if (liveView !== v || v.seq !== viewSeq || !plg.open) return; // the view moved on while the read was in flight
  paintJournal(v.p, { entry: v.entry, live: true, full: v.full, log });
}

// The journal of one entry in #plg-view. A live one repaints every second until the view moves on; any other reads the log once.
async function showJournal(row, entry, seq, { live, full }) {
  const log = live || entry.hasLog === true ? await readLog(row.id, entry.stem) : null;
  if (seq !== viewSeq || !plg.open) return;
  const p = buildJournal();
  paintJournal(p, { entry, live, full, log });
  putView(seq, p.box, () => { p.pre.scrollTop = p.pre.scrollHeight; });
  if (!live) return;
  liveView = { seq, id: row.id, entry, full, p, busy: false };
  if (!pollT) pollT = setInterval(pollTick, 1000);
}

// Keeps #plg-view on what the tab asks for, for the entry of the detail page (a history row, else the latest run): Rapport = its report (a line when
// it wrote none), Journal = its journal (live while it goes, every line on « Journal complet »). The Historique and Paramètres tabs show nothing here (a hidden
// page would keep running its script), and no view but a live journal keeps the poll.
function syncView() {
  if (!plg.open) return;
  const row = shownRow();
  if (!row || plg.tab === 'history' || plg.tab === 'settings') { followed = null; stopPoll(); viewSeq++; plg.viewKey = null; $('plg-view').replaceChildren(); return; }
  const pick = plg.pick && plg.pick.id === row.id ? plg.pick.entry : null;
  const l = row.latest && typeof row.latest === 'object' && typeof row.latest.stem === 'string' ? row.latest : null;
  const e = pick || l;
  // v3: a run followed live on the Journal tab that ends with a report hands the view to the Rapport tab; a failed or report-less end, an entry that was
  // never seen going (an old entry from Historique, « Journal complet ») and any other tab stay as they are.
  if (plg.tab === 'journal' && e) {
    const was = followed && followed.id === row.id && followed.stem === e.stem;
    if (isLive(row, e)) followed = { id: row.id, stem: e.stem };
    else if (!was) followed = null;
    else if (Number.isInteger(e.exit)) {
      followed = null;
      if (e.exit === 0 && e.hasReport === true) { swapDir = 'forward'; plg.tab = 'report'; renderDetail(); }
    }
  } else followed = null;
  const journal = plg.tab === 'journal';
  const full = journal && isFullShown(row, e);
  const live = !!e && isLive(row, e);
  const report = !journal && !!e && e.exit === 0 && e.hasReport === true;
  const key = !e ? `${row.id}:none:${row.running === true ? 'run' : 'idle'}:${plg.tab}`
    : `${row.id}:${e.stem}:${pick ? 'pick' : 'latest'}:${live ? 'live' : `${e.exit}:${e.hasReport}${wasStopped(e) ? ':stopped' : ''}`}:${report ? 'report' : journal ? `journal:${full ? 'full' : 'brief'}` : 'noreport'}`;
  if (key === plg.viewKey) return;
  plg.viewKey = key;
  stopPoll();
  const seq = ++viewSeq;
  if (!e) showLine(row.running === true ? 'En cours…' : 'Aucune exécution pour l’instant', seq);
  else if (report) loadReport(row, e.stem, seq);
  else if (journal) showJournal(row, e, seq, { live, full });
  else showLine(live ? 'En cours… Le rapport s’affiche à la fin de l’exécution.' : 'Cette exécution n’a pas écrit de rapport', seq);
}

const readRows = async () => {
  try { return await window.api.pluginsList(); } catch (_) { return []; }
};

export async function plgLoadList() {
  const seq = ++loadSeq;
  const rows = await readRows();
  if (seq !== loadSeq || !plg.open) return; // stale, or the panel was closed meanwhile
  plg.rows = Array.isArray(rows) ? rows.filter((r) => r && typeof r === 'object' && typeof r.id === 'string') : [];
  plg.loaded = true;
  if (plg.page === 'detail' && !shownRow()) showList(null); // the shown plugin is gone (deleted)
  const ids = new Set(plg.rows.map((r) => r.id));
  for (const id of [...plg.notes.keys()]) if (!ids.has(id)) plg.notes.delete(id);
  const cur = shownRow();
  const newest = cur && cur.latest && typeof cur.latest === 'object' ? cur.latest : null;
  // the entry opened from Historique, when it is the newest one, takes the host's latest word (a run that just ended): no stale « Interrompu » flash
  if (newest && plg.pick && plg.pick.id === cur.id && plg.pick.entry.stem === newest.stem) plg.pick.entry = { ...plg.pick.entry, ...newest };
  const c = plg.card;
  if (c && (c.kind === 'delete' || c.kind === 'access') && !c.busy && !ids.has(c.id)) { plg.card = null; renderCard(); } // removed elsewhere
  renderHead();
  renderList();
  syncView();
  renderDetail();
  loadHistory();
}

// boot.js: plugins-changed (a run ended, an import, a delete). Nothing to do while the panel is closed.
export function notifyPluginsChanged() {
  if (plg.open) plgLoadList();
}

// One user action on a row: the controls of that row wait for the answer, a refusal line stays under the row.
async function act(id, call, ctl) {
  if (plg.busy.has(id)) return;
  plg.busy.add(id);
  plg.notes.delete(id);
  plg.refocus = ctl ? { id, act: ctl } : null;
  renderHead();
  renderList();
  let res = null;
  try { res = await call(); } catch (_) { /* a rejected call is a refusal */ }
  plg.busy.delete(id);
  if (!res || res.ok !== true) plg.notes.set(id, res && typeof res.error === 'string' && res.error ? res.error : 'Action impossible');
  await plgLoadList(); // the refusal line and the new state, with or without a push
}

// ---- navigation: list page <-> detail page ---------------------------------------------------------------------------------------

function setPage(page) {
  plg.page = page;
  const panel = $('plugin-panel');
  if (panel) panel.dataset.page = page;
}

// The detail of a plugin: the Rapport tab when its latest run wrote a report, else the Journal tab (running, failed, no report).
function openDetail(id) {
  const row = plg.rows.find((r) => r.id === id);
  if (!row) return;
  const l = row.latest && typeof row.latest === 'object' ? row.latest : null;
  plg.shown = id;
  plg.pick = null;
  plg.full = null;
  plg.viewKey = null;
  plg.tab = l && l.exit === 0 && l.hasReport === true ? 'report' : 'journal';
  plg.set = null;
  setSeq++;
  swapDir = 'forward';
  setPage('detail');
  renderHead();
  renderDetail();
  syncView();
  arrive(['plg-back', 'plg-dhead', 'plg-detail', 'plg-hist', 'plg-settings']);
  loadHistory();
}

// Back to the list; the page's own state goes with the leaving (no frame, no poll, no history kept for a page nobody sees).
function showList(focusId) {
  setPage('list');
  plg.shown = null;
  plg.pick = null;
  plg.full = null;
  plg.set = null;
  setSeq++;
  histSeq++;
  plg.hist = { id: null, all: [], rows: [] };
  swapDir = 'back';
  renderHead();
  renderDetail();
  syncView();
  arrive(['plg-page-list']);
  const b = focusId ? document.querySelector(`#plg-list .plg-row[data-id="${CSS.escape(focusId)}"] [data-act="pick"]`) : null;
  if (b) b.focus({ preventScroll: true });
}

const backToList = () => showList(plg.shown);

// « Journal complet » (Journal tab): the shown entry with every line of its log; a second click goes back.
function toggleFull(row) {
  const e = entryOfRow(row);
  if (!hasJournal(row, e)) return;
  plg.full = isFull(row, e) ? null : { id: row.id, stem: e.stem };
  renderDetail();
  syncView();
}

function runRow(row) {
  plg.pick = null;
  plg.full = null;
  if (plg.page === 'detail' && plg.shown === row.id) { swapDir = 'forward'; plg.tab = 'journal'; plg.viewKey = null; } // follow the run just launched
  act(row.id, () => window.api.pluginsRunNow(row.id), 'run');
}

// « Arrêter »: the controls of the row wait (« Arrêt… »); a refusal (« Arrêt impossible », « Aucune exécution en cours ») stays under the row / head.
function stopRow(row) {
  if (plg.busy.has(row.id)) return;
  plg.stopping.add(row.id);
  act(row.id, async () => {
    try { return await window.api.pluginsStop(row.id); } finally { plg.stopping.delete(row.id); }
  }, 'stop');
}

function onListClick(e) {
  const target = e.target;
  const rowEl = target && target.closest ? target.closest('.plg-row') : null;
  if (!rowEl) return;
  const id = rowEl.dataset.id;
  const btn = target.closest('button[data-act]');
  if (!btn) { openDetail(id); return; }
  if (btn.disabled) return;
  const row = plg.rows.find((r) => r.id === id);
  if (!row) return;
  if (btn.dataset.act === 'pick') openDetail(id);
  else if (btn.dataset.act === 'run') runRow(row);
  else if (btn.dataset.act === 'stop') stopRow(row);
}

function onHeadClick(e) {
  const btn = e.target && e.target.closest ? e.target.closest('button[data-act]') : null;
  const row = shownRow();
  if (!btn || btn.disabled || !row) return;
  if (btn.dataset.act === 'run') runRow(row);
  else if (btn.dataset.act === 'stop') stopRow(row);
  else if (btn.dataset.act === 'delete') startDelete(row);
}

function onViewClick(e) {
  const btn = e.target && e.target.closest ? e.target.closest('button[data-act="journal"]') : null;
  const row = shownRow();
  if (btn && row) toggleFull(row);
}

// ---- history: retention line, « Rapport | Historique · N » tabs, filter chips, one row per run -------------------------------

const ask = async (id, filter) => {
  try { return entriesOf(await window.api.pluginsHistory(id, filter)); } catch (_) { return []; }
};

// All the entries of the shown plugin (count, size) and the ones the filter keeps: the HOST filters, by local calendar days.
async function loadHistory() {
  const row = shownRow();
  const seq = ++histSeq;
  if (!plg.open || !row) { plg.hist = { id: null, all: [], rows: [] }; renderDetail(); return; }
  const filter = plg.range === 'date' ? (/^\d{4}-\d{2}-\d{2}$/.test(plg.date) ? { date: plg.date } : null) : { days: Number(plg.range) };
  const [all, rows] = await Promise.all([ask(row.id, undefined), filter ? ask(row.id, filter) : []]);
  if (seq !== histSeq || !plg.open) return;
  plg.hist = { id: row.id, all, rows };
  if (plg.pick && plg.pick.id === row.id) { // the opened entry as the host has it now; gone (pruned) -> back to the latest
    const fresh = all.find((e) => e.stem === plg.pick.entry.stem);
    if (fresh) plg.pick.entry = fresh;
    else { plg.pick = null; plg.viewKey = null; }
    syncView();
  }
  renderDetail();
}

function entryStatus(e, live) {
  if (e.exit === 0) return { text: 'OK', tone: 'ok' };
  if (wasStopped(e) && !live) return { text: 'Arrêté', tone: '' };
  if (Number.isInteger(e.exit)) return { text: `Échec (code ${e.exit})`, tone: 'bad' };
  return live ? { text: 'En cours…', tone: 'run' } : { text: 'Interrompu', tone: 'bad' };
}

function histRow(e, current, live) {
  const b = el('button', `plg-hrow${current ? ' sel' : ''}`);
  b.type = 'button';
  b.dataset.act = 'open';
  b.dataset.stem = e.stem;
  if (current) b.setAttribute('aria-current', 'true');
  const st = entryStatus(e, live);
  b.append(el('span', 'plg-h-day', dayLabel(e.start)), el('span', 'plg-h-time', hhmm(e.start)), el('span', 'plg-h-trig', TRIGGERS[e.trigger] || ''),
    el('span', `plg-h-status plg-badge ${st.tone}`, st.text), el('span', 'plg-h-size', e.hasReport && Number.isFinite(e.size) ? sizeOf(e.size) : '—'));
  return b;
}

function renderDetail() {
  const det = $('plg-detail');
  const row = shownRow();
  const show = plg.loaded && !!row;
  det.hidden = !show;
  const hist = $('plg-hist');
  hist.hidden = !(show && plg.tab === 'history');
  const inSettings = show && plg.tab === 'settings';
  $('plg-settings').hidden = !inSettings;
  if (!inSettings && plg.refocus && plg.refocus.act === 'access') plg.refocus = null; // « Modifier » is not on screen: no focus to give back
  if (!show) return;
  const h = plg.hist.id === row.id ? plg.hist : null;
  const inp = $('plg-retention');
  if (document.activeElement !== inp) inp.value = Number.isInteger(row.retentionDays) ? String(row.retentionDays) : '';
  inp.setAttribute('aria-label', `Nombre de jours de conservation des rapports de ${labelOf(row)}`);
  const sum = h ? h.all.reduce((a, e) => a + (Number.isFinite(e.size) ? e.size : 0), 0) : 0;
  $('plg-storage').textContent = h ? (h.all.length ? `${reportsOf(h.all.length)} · ${sizeOf(sum)}` : reportsOf(0)) : '';
  for (const b of det.querySelectorAll('[role="tab"]')) {
    const on = b.dataset.tab === plg.tab;
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
  }
  $('plg-tab-history').textContent = h ? `Historique · ${h.all.length}` : 'Historique';
  const pick = plg.pick && plg.pick.id === row.id ? plg.pick.entry : null;
  const shownEntry = pick || (row.latest && typeof row.latest === 'object' && Number.isFinite(row.latest.start) ? row.latest : null);
  if (plg.tab === 'history') $('plg-stamp').textContent = h && h.all.length ? sizeOf(sum) : '';
  else if (plg.tab === 'settings') { $('plg-stamp').textContent = ''; renderSettings(row); }
  else $('plg-stamp').textContent = shownEntry ? `${dayLabel(shownEntry.start)} · ${hhmm(shownEntry.start)}` : 'Aucun';
  if (plg.tab !== 'history') return;

  for (const b of hist.querySelectorAll('[data-act="range"]')) b.setAttribute('aria-pressed', String(b.dataset.range === plg.range));
  const date = $('plg-date');
  date.hidden = plg.range !== 'date';
  if (document.activeElement !== date) date.value = plg.date;
  const list = h ? h.rows : [];
  const curStem = pick ? pick.stem : (h && h.all[0] ? h.all[0].stem : '');
  const liveStem = row.running === true && h && h.all[0] ? h.all[0].stem : '';
  const host = $('plg-rows');
  const held = host.contains(document.activeElement) ? document.activeElement.dataset.stem : null;
  host.replaceChildren(...list.map((e) => histRow(e, e.stem === curStem, e.stem === liveStem)));
  const back = held ? host.querySelector(`[data-stem="${CSS.escape(held)}"]`) : null;
  if (back) back.focus({ preventScroll: true });
  $('plg-shown').textContent = h ? `${list.length} ${list.length > 1 ? 'affichés' : 'affiché'}` : '';
  $('plg-hempty').hidden = !(h && list.length === 0);
  const n = Number.isInteger(row.retentionDays) ? row.retentionDays : null;
  $('plg-hfoot').replaceChildren('Stockés dans ', el('span', 'plg-mono', `plugin-data/${row.id}/reports`), ', dans le dossier de données du Deck.'
    + (n ? ` Au démarrage et après chaque passage, le Deck efface ceux de plus de ${n} ${n > 1 ? 'jours' : 'jour'}.` : ''));
}

function setTab(tab, focus, dir) {
  if (!TABS.some((t) => t[0] === tab)) return;
  const was = plg.tab;
  swapDir = dir || (TABS.findIndex((t) => t[0] === tab) >= TABS.findIndex((t) => t[0] === was) ? 'forward' : 'back');
  plg.tab = tab;
  const row = shownRow();
  if (tab === 'settings' && row) loadSettings(row);
  renderDetail();
  syncView();
  if (tab !== was) arrive(['plg-hist', 'plg-settings']);
  if (focus) $(`plg-tab-${tab}`).focus({ preventScroll: true });
}

function setRange(range) {
  if (!RANGES.some((r) => r[0] === range)) return;
  plg.range = range;
  if (range === 'date' && !plg.date) plg.date = plg.hist.all[0] ? dayKey(plg.hist.all[0].start) : dayKey(Date.now());
  renderDetail();
  loadHistory();
}

function openEntry(stem) {
  const row = shownRow();
  const e = row && plg.hist.id === row.id ? plg.hist.rows.find((x) => x.stem === stem) : null;
  if (!e) return;
  plg.pick = { id: row.id, entry: e };
  plg.full = null;
  plg.viewKey = null;
  setTab(e.exit === 0 && e.hasReport === true ? 'report' : 'journal', true, 'forward');
}

function onDetailClick(e) {
  const btn = e.target && e.target.closest ? e.target.closest('button[data-act]') : null;
  if (!btn) return;
  if (btn.dataset.act === 'tab') setTab(btn.dataset.tab, false);
}

function onTabKey(e) {
  if (!e.target || !e.target.matches || !e.target.matches('[role="tab"]')) return;
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  e.preventDefault();
  const at = TABS.findIndex((t) => t[0] === plg.tab);
  setTab(TABS[(at + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length][0], true);
}

function onHistClick(e) {
  const btn = e.target && e.target.closest ? e.target.closest('button[data-act]') : null;
  if (!btn || btn.disabled) return;
  if (btn.dataset.act === 'range') setRange(btn.dataset.range);
  else if (btn.dataset.act === 'open') openEntry(btn.dataset.stem);
}

function onDateChange(e) {
  plg.date = e.target.value;
  loadHistory();
}

// « Garder les rapports N jours »: the host judges the value; its refusal line goes under the row and the field returns to the stored value.
async function onRetentionChange(e) {
  const row = shownRow();
  const inp = e.target;
  if (!row || !inp || inp.id !== 'plg-retention') return;
  const n = inp.value.trim() === '' ? NaN : Number(inp.value);
  if (Number.isFinite(n)) await act(row.id, () => window.api.pluginsSetRetention(row.id, n), null);
  const now = plg.rows.find((r) => r.id === row.id);
  if (now) inp.value = Number.isInteger(now.retentionDays) ? String(now.retentionDays) : '';
}

function tabButton(tab, label) {
  const b = el('button', 'plg-tab', label);
  b.type = 'button';
  b.id = `plg-tab-${tab}`;
  b.dataset.act = 'tab';
  b.dataset.tab = tab;
  b.setAttribute('role', 'tab');
  b.setAttribute('aria-selected', 'false');
  return b;
}

function buildDetail() {
  const det = el('section', 'plg-detail');
  det.id = 'plg-detail';
  det.hidden = true;
  det.setAttribute('aria-label', 'Vues du plugin');
  const tabs = el('div', 'plg-tabs');
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', 'Vues du plugin');
  tabs.append(...TABS.map(([tab, label]) => tabButton(tab, label)));
  const stamp = el('span', 'plg-stamp');
  stamp.id = 'plg-stamp';
  const bar = el('div', 'plg-tabsbar');
  bar.append(tabs, stamp);
  det.append(bar);
  det.addEventListener('click', onDetailClick);
  det.addEventListener('keydown', onTabKey);
  return det;
}

// ---- Paramètres tab: the access lines (read only; « Modifier » in the card head opens the access card), the call options, the switch, retention and storage -----------

// The access state of the shown plugin, read like the « Modifier » screen reads it; `plg.set` has the card's shape so its rows reuse the same words.
async function loadSettings(row) {
  const seq = ++setSeq;
  const s = { kind: 'access', id: row.id, ...blankAccess([]), loading: true, busy: false, error: '' };
  plg.set = s;
  renderSettings(row);
  let res = null;
  try { res = await window.api.pluginsAccess(row.id); } catch (_) { /* a rejected call is a refusal */ }
  if (seq !== setSeq || plg.set !== s || !plg.open) return;
  fillAccess(s, res);
  renderSettings(shownRow());
}

function accLine(s, slot) {
  const st = accStatus(s, slot);
  const line = el('div', 'plg-set-line');
  line.append(el('span', 'plg-set-label', slot.label), el('span', 'plg-mono', s.envMap[slot.name] || '—'), el('span', `plg-acc-status${st.tone ? ` ${st.tone}` : ''}`, st.text));
  return line;
}

// Rebuilds the access lines and the options only when the access state changed (a push must not drop the focus of an option button);
// « Modifier », the option picks, the switch, the retention field and the lock line follow `row.running` in place (every plugins-changed push reaches here
// through plgLoadList -> renderDetail), and the storage line is kept current too.
function renderSettings(row) {
  const host = $('plg-settings');
  if (!row || host.hidden) return;
  const s = plg.set && plg.set.id === row.id ? plg.set : null;
  const key = s ? `${s.loading}:${s.failed}` : 'none';
  if (!builtSet || builtSet.set !== s || builtSet.key !== key) {
    builtSet = { set: s, key };
    const rows = $('plg-set-acc');
    if (!s || s.loading) rows.replaceChildren(el('p', 'plg-acc-after', 'Lecture des accès…'));
    else if (s.failed) rows.replaceChildren(el('p', 'plg-note', s.error));
    else rows.replaceChildren(...(s.slots.length ? s.slots.map((sl) => accLine(s, sl)) : [el('p', 'plg-acc-after', 'Ce plugin ne demande aucun accès.')]));
    $('plg-set-opts').replaceChildren(...(s && !s.loading && !s.failed ? s.options.map((o) => optBlock(s, o)) : []));
  }
  $('plg-set-sum').textContent = accessLine(row);
  const running = row.running === true; // the host refuses the four edits while the plugin runs: the controls wait for the end of the run
  $('plg-set-lock').hidden = !running;
  for (const b of $('plg-set-opts').querySelectorAll('button[data-act="opt-pick"]')) b.disabled = running;
  $('plg-retention').disabled = running;
  const sw = $('plg-set-switch');
  sw.setAttribute('aria-checked', String(row.enabled === true));
  sw.setAttribute('aria-label', `Activer ${labelOf(row)}`);
  sw.disabled = running || plg.busy.has(row.id) || (row.enabled !== true && row.status === NOT_CONFIGURED);
  const edit = $('plg-set-edit');
  edit.setAttribute('aria-label', `Modifier les accès de ${labelOf(row)}`);
  edit.disabled = running || plg.busy.has(row.id);
  if (plg.refocus && plg.refocus.act === 'access' && plg.refocus.id === row.id && !edit.disabled) { // the card just closed: the focus comes back here
    plg.refocus = null;
    edit.focus({ preventScroll: true });
  }
}

function onSettingsClick(e) {
  const btn = e.target && e.target.closest ? e.target.closest('button[data-act]') : null;
  const row = shownRow();
  if (!btn || btn.disabled || !row) return;
  if (btn.dataset.act === 'toggle') { act(row.id, () => window.api.pluginsSetEnabled(row.id, row.enabled !== true), null); return; }
  if (btn.dataset.act === 'access') { startAccess(row); return; }
  const box = btn.dataset.act === 'opt-pick' ? btn.closest('.plg-opt') : null;
  const s = plg.set;
  if (box && s && s.id === row.id) pickOption(s, box.dataset.option, btn.dataset.value);
}

function buildSettings() {
  const host = $('plg-settings');
  host.hidden = true;
  const sum = el('span', 'plg-set-sum');
  sum.id = 'plg-set-sum';
  const edit = el('button', 'plg-access-edit', 'Modifier');
  edit.type = 'button';
  edit.id = 'plg-set-edit';
  edit.dataset.act = 'access';
  const accHead = el('div', 'plg-set-head');
  accHead.append(el('h2', null, 'Accès'), sum, edit);
  const rows = el('div', 'plg-set-acc');
  rows.id = 'plg-set-acc';
  const acc = el('section');
  acc.setAttribute('aria-label', 'Accès');
  acc.append(accHead, rows);

  const opts = el('div', 'plg-opts');
  opts.id = 'plg-set-opts';
  const sw = el('button', 'plg-switch');
  sw.type = 'button';
  sw.id = 'plg-set-switch';
  sw.dataset.act = 'toggle';
  sw.setAttribute('role', 'switch');
  sw.setAttribute('aria-checked', 'false');
  sw.appendChild(el('span', 'plg-knob'));
  const enabled = el('div', 'plg-set-row');
  enabled.append(el('span', null, 'Plugin activé'), sw);
  const inp = document.createElement('input');
  inp.id = 'plg-retention';
  inp.className = 'plg-num';
  inp.type = 'number';
  inp.min = '1';
  inp.max = '365';
  inp.step = '1';
  const keepLabel = el('label', 'plg-keep-label');
  keepLabel.append(el('span', null, 'Garder les rapports'), inp, el('span', null, 'jours'));
  const storage = el('span', 'plg-storage');
  storage.id = 'plg-storage';
  const keep = el('div', 'plg-keep');
  keep.append(keepLabel, storage);
  const set = el('section');
  set.setAttribute('aria-label', 'Réglages');
  set.append(el('h2', null, 'Réglages'), opts, enabled, keep);
  const lock = el('p', 'plg-acc-after', 'Arrête l’exécution pour modifier les réglages.'); // shown while the plugin runs (renderSettings)
  lock.id = 'plg-set-lock';
  lock.hidden = true;
  host.append(lock, acc, set);
  host.addEventListener('click', onSettingsClick);
  host.addEventListener('change', onRetentionChange);
}

function buildHist() {
  const hist = el('section', 'plg-hist');
  hist.id = 'plg-hist';
  hist.hidden = true;
  hist.setAttribute('aria-label', 'Historique des rapports');
  const chips = el('div', 'plg-chips');
  chips.setAttribute('role', 'group');
  chips.setAttribute('aria-label', 'Filtrer les rapports');
  for (const [range, label] of RANGES) {
    const b = el('button', 'plg-chip', label);
    b.type = 'button';
    b.dataset.act = 'range';
    b.dataset.range = range;
    b.setAttribute('aria-pressed', 'false');
    chips.appendChild(b);
  }
  const date = document.createElement('input');
  date.id = 'plg-date';
  date.className = 'plg-num plg-date';
  date.type = 'date';
  date.hidden = true;
  date.setAttribute('aria-label', 'Date des rapports');
  date.addEventListener('change', onDateChange);
  const shown = el('span', 'plg-shown');
  shown.id = 'plg-shown';
  chips.append(date, shown);
  const rows = el('div', 'plg-hrows');
  rows.id = 'plg-rows';
  rows.setAttribute('role', 'group');
  rows.setAttribute('aria-label', 'Exécutions');
  const empty = el('p', 'plg-hempty', 'Aucun rapport pour cette période.');
  empty.id = 'plg-hempty';
  empty.hidden = true;
  const foot = el('p', 'plg-hfoot');
  foot.id = 'plg-hfoot';
  hist.append(chips, rows, empty, foot);
  hist.addEventListener('click', onHistClick);
  return hist;
}

// ---- the card: import (pick -> manifest -> confirm), its refusal, delete confirmation --------------------------------------

function sizeOf(bytes) { // « 3,2 Ko »
  const n = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (n < 1024) return `${n} o`;
  const [v, unit] = n < 1048576 ? [n / 1024, 'Ko'] : [n / 1048576, 'Mo'];
  return `${v.toFixed(1).replace('.', ',')} ${unit}`;
}

const reportsOf = (n) => (n === 1 ? '1 rapport' : n > 1 ? `${n} rapports` : 'aucun rapport');
const lineOf = (res, fallback) => (res && typeof res.error === 'string' && res.error ? res.error : fallback);

function cardButton(act, label, cls) {
  const b = el('button', cls, label);
  b.type = 'button';
  b.dataset.act = act;
  return b;
}

// ---- access: one row per slot the plugin declares (import card and « Modifier » screen) ---------------------------------------
// Every status word comes from the host (pluginsAccess / pluginsDetect); this code only words it. A row whose NAME was edited since
// the host judged it shows no status (unknown renders as nothing). Only NAMES are typed, sent and shown: no value reaches this module.
const ACC_STATUS = new Map([
  ['présente', ['Présente dans ton shell · valeur jamais lue', 'ok']],
  ['absente', ['Absente de ton shell : exporte-la, puis Détecter', 'warn']],
  ['nom invalide', ['Nom invalide : lettres, chiffres et _ seulement', 'bad']],
]);
const ACC_NONE = { text: '', tone: '', host: '' };
const ACC_LOCK = "Le Deck ne lit jamais la valeur de tes variables : il ne manipule que leurs noms. Au lancement, ton shell passe au plugin seulement les variables associées ici, sous le nom qu'il attend. Rien d'autre ne passe.";
const ACC_IMPORT_NOTE = "Le plugin arrive activé, avec 30 jours de conservation des rapports. Il ne tourne qu'une fois les accès requis associés.";

const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;
const slotsOf = (list) => (Array.isArray(list)
  ? list.filter((s) => s && typeof s === 'object' && typeof s.name === 'string' && s.name).map((s) => ({ name: s.name, label: text(s.label) || s.name, required: s.required === true }))
  : []);
const hostRowOf = (r) => ({ mapped: typeof r.mapped === 'string' ? r.mapped : '', status: typeof r.status === 'string' ? r.status : '',
  candidates: Array.isArray(r.candidates) ? r.candidates.filter((n) => typeof n === 'string') : [] });
// The option rows the host answers ({ name, label, choices, value }); `err` is the refusal line of the last pick on that option.
const optionsOf = (list) => (Array.isArray(list)
  ? list.filter((o) => o && typeof o === 'object' && typeof o.name === 'string' && o.name && Array.isArray(o.choices)).map((o) => ({
    name: o.name, label: text(o.label) || o.name, value: text(o.value), err: '',
    choices: o.choices.filter((ch) => ch && typeof ch === 'object' && typeof ch.value === 'string' && ch.value).map((ch) => ({ value: ch.value, label: text(ch.label) || ch.value })),
  })).filter((o) => o.choices.length > 0)
  : []);
// envMap has no prototype, like the host's: a slot named `__proto__` or `constructor` is plain data here too.
const blankAccess = (slots) => ({ slots, options: [], envMap: Object.create(null), hostRows: new Map(), missing: null, note: '', detecting: false, loading: false, failed: false, optBusy: false });

// A replace keeps the installed names (the host merges them at the import): seed the empty slots the new manifest still declares.
function keepNames(c) {
  const row = plg.rows.find((r) => r.id === c.id);
  const kept = row && row.envMap && typeof row.envMap === 'object' ? row.envMap : null;
  if (!kept) return;
  for (const s of c.slots) {
    const v = Object.prototype.hasOwnProperty.call(kept, s.name) ? kept[s.name] : '';
    if (typeof v === 'string' && v && !c.envMap[s.name]) c.envMap[s.name] = v;
  }
}

// { text, tone, host } of one slot: `host` is the host's own word, kept on the node for whoever audits the rows.
function accStatus(c, s) {
  const v = c.envMap[s.name] || '';
  const h = c.hostRows.get(s.name);
  if (!h) return v ? ACC_NONE : { text: s.required ? 'À associer' : 'Facultatif', tone: 'muted', host: '' };
  if (h.mapped !== v) return ACC_NONE;
  const fixed = ACC_STATUS.get(h.status);
  if (fixed) return { text: fixed[0], tone: fixed[1], host: h.status };
  if (h.status === 'plusieurs trouvées') return { text: `${h.candidates.length} variables trouvées : choisis la bonne`, tone: 'warn', host: h.status };
  if (h.status !== 'introuvable') return ACC_NONE;
  return s.required
    ? { text: 'Introuvable : exporte-la dans ton shell, ou tape son nom', tone: 'warn', host: h.status }
    : { text: 'Facultatif : aucune variable trouvée', tone: 'muted', host: h.status };
}

function accSummary(c) {
  const left = c.slots.filter((s) => s.required && !c.envMap[s.name]).length;
  if (left) return { text: plural(left, 'accès requis manquant', 'accès requis manquants'), tone: 'warn' };
  return { text: plural(c.slots.filter((s) => c.envMap[s.name]).length, 'variable associée', 'variables associées'), tone: '' };
}

function setStatus(node, st) {
  node.textContent = st.text;
  node.className = `plg-acc-status${st.tone ? ` ${st.tone}` : ''}`;
  node.dataset.status = st.host;
}

// Statuses and summary follow the NAMES typed so far; the fields themselves are left alone (they keep the focus and the caret).
function paintAccess(c) {
  const root = $('plg-card-access');
  if (!root) return;
  for (const s of c.slots) {
    const node = root.querySelector(`.plg-acc-row[data-slot="${CSS.escape(s.name)}"] .plg-acc-status`);
    if (node) setStatus(node, accStatus(c, s));
  }
  const sum = root.querySelector('.plg-acc-sum');
  if (!sum) return;
  const st = accSummary(c);
  sum.textContent = st.text;
  sum.className = `plg-acc-sum${st.tone ? ` ${st.tone}` : ''}`;
}

function accRow(c, s) {
  const row = el('div', 'plg-acc-row');
  row.dataset.slot = s.name;
  row.dataset.required = String(s.required);
  const sub = el('span', 'plg-acc-sub');
  sub.append('Lue par le plugin sous ', el('span', 'plg-mono', s.name), s.required ? '' : ' · facultatif');
  const txt = el('div', 'plg-acc-text');
  txt.append(el('span', 'plg-acc-label', s.label), sub);
  const v = c.envMap[s.name] || '';
  const h = c.hostRows.get(s.name);
  const choose = !!h && h.status === 'plusieurs trouvées' && h.candidates.length > 1 && (v === '' || h.candidates.includes(v));
  let ctl;
  if (choose) {
    ctl = document.createElement('select');
    ctl.append(new Option('Choisis…', ''), ...h.candidates.map((n) => new Option(n, n)));
  } else {
    ctl = document.createElement('input');
    ctl.type = 'text';
    ctl.placeholder = 'NOM_DE_VARIABLE';
    ctl.spellcheck = false;
    ctl.autocomplete = 'off';
    ctl.setAttribute('aria-required', String(s.required));
  }
  ctl.className = 'plg-acc-in';
  ctl.value = v;
  ctl.disabled = c.busy === true || c.loading === true;
  ctl.setAttribute('aria-label', `Variable pour ${s.label}`);
  const top = el('div', 'plg-acc-top');
  top.append(txt, ctl);
  const status = el('span');
  setStatus(status, accStatus(c, s));
  row.append(top, status);
  return row;
}

// ---- call options: one segmented control per option the manifest declares, in the Paramètres tab only (the access card is env vars only) ----
// A pick goes to the host at once (it is stored there, « Enregistrer » is for the names); the pressed state follows the host's answer.
function paintOption(box, o) {
  for (const b of box.querySelectorAll('button[data-value]')) b.setAttribute('aria-pressed', String(b.dataset.value === o.value));
  const note = box.querySelector('.plg-opt-err');
  note.textContent = o.err;
  note.hidden = !o.err;
}

function optBlock(c, o) {
  const box = el('div', 'plg-opt');
  box.dataset.option = o.name;
  const txt = el('div', 'plg-opt-text');
  txt.append(el('span', 'plg-opt-label', o.label), el('span', 'plg-opt-hint', 'Appliqué dès le clic'));
  const seg = el('div', 'plg-opt-seg');
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', o.label);
  for (const ch of o.choices) {
    const b = cardButton('opt-pick', ch.label, 'plg-seg-btn');
    b.dataset.value = ch.value;
    b.disabled = c.busy === true;
    seg.append(b);
  }
  const top = el('div', 'plg-opt-top');
  top.append(txt, seg);
  const err = el('p', 'plg-opt-err');
  err.setAttribute('role', 'alert');
  box.append(top, err);
  paintOption(box, o);
  return box;
}

async function pickOption(c, name, value) {
  if (!c || c.busy || c.loading || c.failed || c.optBusy) return;
  const o = c.options.find((x) => x.name === name);
  if (!o || o.value === value || !o.choices.some((ch) => ch.value === value)) return;
  c.optBusy = true; // the buttons stay enabled (they keep the focus); a second pick waits for this answer
  o.err = '';
  let res = null;
  try { res = await window.api.pluginsSetOption(c.id, name, value); } catch (_) { /* a rejected call is a refusal */ }
  c.optBusy = false;
  if (plg.set !== c) return;
  if (res && res.ok === true && res.name === name && res.value === value) o.value = value;
  else o.err = lineOf(res, 'Réglage impossible');
  const box = document.querySelector(`#plg-settings .plg-opt[data-option="${CSS.escape(name)}"]`);
  if (box) paintOption(box, o);
}

function accessNodes(c) {
  if (!c.slots.length) return c.kind === 'access' && !c.loading && !c.failed ? [el('p', 'plg-acc-after', 'Ce plugin ne demande aucun accès.')] : [];
  const title = el('div', 'plg-acc-title-box');
  title.append(el('span', 'plg-acc-title', 'Accès demandés'), el('span', 'plg-acc-hint', "Tape le nom d'une variable de ton shell, jamais sa valeur."));
  const find = cardButton('acc-detect', 'Détecter', 'plg-detect');
  find.disabled = c.busy === true || c.detecting === true || c.loading === true;
  const head = el('div', 'plg-acc-head');
  head.append(title, find);
  const nodes = [head];
  const lacking = Array.isArray(c.missing) ? c.missing.filter((m) => typeof m === 'string' && m) : [];
  if (lacking.length) nodes.push(el('p', 'plg-acc-missing', `À configurer : ${lacking.join(', ')}`));
  const rows = el('div', 'plg-acc-rows');
  rows.setAttribute('role', 'group');
  rows.setAttribute('aria-label', 'Accès demandés');
  rows.append(...c.slots.map((s) => accRow(c, s)));
  nodes.push(rows);
  if (c.note) nodes.push(el('p', 'plg-acc-after', c.note));
  nodes.push(el('p', 'plg-acc-lock', ACC_LOCK));
  if (c.kind === 'import') nodes.push(el('p', 'plg-acc-after', ACC_IMPORT_NOTE));
  const sum = accSummary(c);
  nodes.push(el('p', `plg-acc-sum${sum.tone ? ` ${sum.tone}` : ''}`, sum.text));
  return nodes;
}

function accessBody(c) {
  const access = el('div', 'plg-card-access');
  access.id = 'plg-card-access';
  access.append(...accessNodes(c));
  return [el('p', 'plg-card-kicker', 'Accès'), el('h3', 'plg-card-title', `Accès de ${c.label}`),
    el('p', 'plg-card-desc', 'Associe chaque besoin du plugin à une variable de ton shell.'), access];
}

// The NAME fields feed `c.envMap`; nothing else is ever sent.
function onAccEdit(e) {
  const ctl = e.target && e.target.closest ? e.target.closest('.plg-acc-in') : null;
  const c = plg.card;
  if (!ctl || !c || !c.slots) return;
  const slot = ctl.closest('.plg-acc-row').dataset.slot;
  const name = ctl.value.trim();
  if (name) c.envMap[slot] = name;
  else delete c.envMap[slot];
  paintAccess(c);
}

// « Détecter »: single matches fill the EMPTY slots, several are offered, none says « introuvable ». A NAME already there is kept.
async function detect() {
  const c = plg.card;
  if (!c || !c.slots || c.busy || c.detecting || c.loading) return;
  const seq = cardSeq;
  c.detecting = true;
  c.error = '';
  const btn = $('plg-card').querySelector('[data-act="acc-detect"]');
  if (btn) btn.disabled = true;
  let res = null;
  try { res = await window.api.pluginsDetect(c.kind === 'import' ? { token: c.token } : { id: c.id }); } catch (_) { /* a rejected call is a refusal */ }
  if (seq !== cardSeq || plg.card !== c || !plg.open) return;
  c.detecting = false;
  if (res && res.ok === true && Array.isArray(res.rows)) {
    for (const r of res.rows) {
      if (!r || typeof r.name !== 'string' || c.envMap[r.name]) continue;
      const h = hostRowOf(r);
      c.hostRows.set(r.name, h);
      if (h.status === 'présente' && h.mapped) c.envMap[r.name] = h.mapped;
    }
    if (typeof res.note === 'string' && res.note) c.note = res.note;
  } else c.error = lineOf(res, 'Détection impossible');
  renderCard();
  const again = $('plg-card').querySelector('[data-act="acc-detect"]');
  if (again) again.focus({ preventScroll: true });
}

// The host's answer to plugins-access in an access state (the « Modifier » card, the Paramètres tab).
function fillAccess(c, res) {
  c.loading = false;
  if (res && res.ok === true && Array.isArray(res.rows)) {
    c.slots = slotsOf(res.rows);
    c.options = optionsOf(res.options);
    for (const r of res.rows) {
      if (!r || typeof r.name !== 'string') continue;
      c.hostRows.set(r.name, hostRowOf(r));
      if (typeof r.mapped === 'string' && r.mapped) c.envMap[r.name] = r.mapped;
    }
    c.missing = Array.isArray(res.missing) ? res.missing : [];
    c.note = typeof res.note === 'string' ? res.note : '';
  } else { // unknown access is not « no access »: saving would replace the stored map with nothing
    c.failed = true;
    c.error = lineOf(res, 'Accès illisibles');
  }
}

// « Modifier »: the screen of an installed plugin. The host reads the shell's NAMES now and judges the stored map.
async function startAccess(row) {
  if (plg.card && plg.card.busy) return;
  const seq = ++cardSeq;
  const c = { kind: 'access', id: row.id, label: labelOf(row), ...blankAccess([]), loading: true, busy: false, error: '' };
  plg.card = c;
  renderCard(true);
  let res = null;
  try { res = await window.api.pluginsAccess(row.id); } catch (_) { /* a rejected call is a refusal */ }
  if (seq !== cardSeq || plg.card !== c || !plg.open) return;
  fillAccess(c, res);
  renderCard();
}

// Manifest fields as text (the folder is third-party). `#plg-card-access` holds the access rows of the manifest's slots.
function importBody(c) {
  const m = c.manifest;
  const meta = el('dl', 'plg-card-meta');
  meta.append(
    el('dt', null, 'Déclencheur'), el('dd', 'plg-card-trigger', TRIGGER_LABELS[m.trigger] || text(m.trigger)),
    el('dt', null, 'Commande'), el('dd', 'plg-card-command', Array.isArray(m.argv) ? m.argv.filter((a) => typeof a === 'string').join(' ') : ''),
  );
  if (c.source) meta.append(el('dt', null, 'Source'), el('dd', 'plg-card-source plg-mono', c.source));
  if (c.dest) meta.append(el('dt', null, 'Copié dans'), el('dd', 'plg-card-dest plg-mono', c.dest));
  const nodes = [el('p', 'plg-card-kicker', c.exists ? 'Remplacer un plugin' : 'Importer un plugin'), el('h3', 'plg-card-title', text(m.label) || c.id)];
  if (text(m.description)) nodes.push(el('p', 'plg-card-desc', m.description));
  nodes.push(meta);
  if (c.exists) nodes.push(el('p', 'plg-card-replace', `Le plugin « ${c.id} » est déjà installé. Le remplacer par ce dossier ? Ses réglages (conservation, accès associés) sont gardés, et il sera activé.`));
  const access = el('div', 'plg-card-access');
  access.id = 'plg-card-access';
  access.append(...accessNodes(c));
  nodes.push(el('p', 'plg-card-scope', SCOPE_LINE), access);
  return nodes;
}

// The wording of the validated artboard: the copy the Deck removes, its data (reports and size), what stays. A folder line ends on
// « : » only when main gave the path to show under it.
function deleteBody(c) {
  const data = c.count === 0 ? 'et ses données (aucun rapport)'
    : `et ses données, dont ${c.count === 1 ? 'son rapport' : `ses ${reportsOf(c.count)}`} (${sizeOf(c.bytes)})`;
  const impact = el('div', 'plg-card-impact');
  if (plg.rows.some((r) => r.id === c.id && r.running === true)) impact.appendChild(el('p', 'plg-card-stop', 'L’exécution en cours sera arrêtée, puis le plugin supprimé.'));
  for (const [line, dir] of [['Le Deck efface sa copie', c.dir], [data, c.dataDir]]) {
    impact.appendChild(el('p', null, dir ? `${line} :` : line));
    if (dir) impact.appendChild(el('p', 'plg-card-path plg-mono', dir));
  }
  impact.appendChild(el('p', null, "Ses accès associés partent avec. Ton dossier source et tes variables d'environnement ne sont pas touchés."));
  return [el('p', 'plg-card-kicker', 'Supprimer un plugin'), el('h3', 'plg-card-title', c.label), impact];
}

function cardBody(c) {
  let nodes;
  let go = null;
  if (c.kind === 'refused') nodes = [el('p', 'plg-card-kicker', 'Importer un plugin')];
  else if (c.kind === 'delete') { nodes = deleteBody(c); go = cardButton('card-confirm', 'Supprimer', 'plg-card-go danger'); }
  else if (c.kind === 'access') { nodes = accessBody(c); go = cardButton('card-confirm', 'Enregistrer', 'plg-card-go'); }
  else { nodes = importBody(c); go = cardButton('card-confirm', c.exists ? 'Remplacer' : 'Importer', 'plg-card-go'); }
  if (c.error) {
    const p = el('p', 'plg-card-error', c.error);
    p.setAttribute('role', 'alert');
    nodes.push(p);
  }
  const actions = el('div', 'plg-card-actions');
  if (go) actions.appendChild(go);
  actions.appendChild(cardButton('card-cancel', c.kind === 'refused' ? 'Fermer' : 'Annuler'));
  for (const b of actions.children) b.disabled = c.busy === true || ((c.loading === true || c.failed === true) && b === go);
  nodes.push(actions);
  return nodes;
}

// Rebuilt whole on each change; `fresh` = just opened (the card takes the focus), else the focus stays in the card.
function renderCard(fresh) {
  const host = $('plg-card');
  const c = plg.card;
  const held = host.contains(document.activeElement);
  host.hidden = !c;
  host.dataset.kind = c ? c.kind : '';
  host.setAttribute('aria-label', c ? (c.kind === 'delete' ? 'Supprimer un plugin' : c.kind === 'access' ? 'Accès du plugin' : 'Importer un plugin') : '');
  host.replaceChildren(...(c ? cardBody(c) : []));
  $('plg-import').disabled = plg.pickBusy || !!(c && c.busy);
  if (!c || !(fresh || held)) return;
  const next = fresh ? host : host.querySelector('button:not(:disabled)') || host;
  next.focus({ preventScroll: true });
  if (fresh) host.scrollIntoView({ block: 'nearest' });
}

function closeCard() {
  const c = plg.card;
  cardSeq++;
  plg.card = null;
  renderCard();
  const back = c && c.kind === 'delete' ? document.querySelector('#plg-dhead [data-act="delete"]') : c && c.kind === 'access' ? $('plg-set-edit') : null;
  (back && !back.closest('[hidden]') ? back : $('plg-import')).focus({ preventScroll: true });
}

async function startImport() {
  if (plg.pickBusy || (plg.card && plg.card.busy)) return;
  const seq = ++cardSeq;
  plg.pickBusy = true;
  renderCard();
  let res = null;
  try { res = await window.api.pluginsPick(); } catch (_) { /* a rejected call is a refusal */ }
  plg.pickBusy = false;
  if (seq !== cardSeq || !plg.open) { renderCard(); return; }
  if (res && res.canceled === true) { renderCard(); return; } // an open card stays as it was
  const m = res && res.ok === true && typeof res.token === 'string' && res.manifest && typeof res.manifest === 'object' ? res.manifest : null;
  plg.card = m
    ? { kind: 'import', token: res.token, id: text(res.id) || text(m.id), manifest: m, exists: res.exists === true, source: text(res.source), dest: text(res.dest),
      ...blankAccess(slotsOf(m.env)), busy: false, error: '' }
    : { kind: 'refused', error: lineOf(res, 'Import impossible'), busy: false };
  if (plg.card.kind === 'import' && plg.card.exists) keepNames(plg.card);
  renderCard(true);
}

// The delete card: the host counts what the delete would remove (reports and bytes under plugin-data/<id>).
function startDelete(row) {
  if (plg.card && plg.card.busy) return;
  const seq = cardSeq;
  act(row.id, async () => {
    const res = await window.api.pluginsDeleteCard(row.id);
    if (res && res.ok === true && seq === cardSeq && plg.open) {
      plg.card = { kind: 'delete', id: row.id, label: labelOf(row), count: Number(res.count) || 0, bytes: Number(res.bytes) || 0,
        dir: text(res.dir), dataDir: text(res.dataDir), busy: false, error: '' };
      plg.refocus = null; // the card takes the focus, not the button the repaint would restore
      renderCard(true);
    }
    return res;
  }, 'delete');
}

async function confirmCard() {
  const c = plg.card;
  if (!c || c.busy || c.loading || c.failed || c.detecting || c.kind === 'refused') return;
  const seq = cardSeq;
  c.busy = true;
  c.error = '';
  renderCard();
  let res = null;
  try {
    if (c.kind === 'delete') res = await window.api.pluginsDelete(c.id);
    else if (c.kind === 'access') res = await window.api.pluginsSetEnvMap(c.id, { ...c.envMap });
    else res = await window.api.pluginsImport(c.token, { replace: c.exists, envMap: { ...c.envMap } });
  } catch (_) { /* a rejected call is a refusal */ }
  if (seq !== cardSeq || plg.card !== c) return; // closed meanwhile
  c.busy = false;
  if (res && res.ok === true) {
    plg.card = null;
    plg.notes.delete(c.id);
    if (c.kind === 'delete') { if (plg.shown === c.id) plg.shown = null; } else if (c.kind === 'import') plg.shown = c.id;
    renderCard();
    if (c.kind === 'access') {
      plg.refocus = { id: c.id, act: 'access' }; // the repaint of Paramètres gives the focus back to « Modifier »
      const shown = shownRow();
      if (plg.tab === 'settings' && shown && shown.id === c.id) loadSettings(shown); // the lines read the access on tab entry only: read it again
    } else $('plg-import').focus({ preventScroll: true });
    plgLoadList();
    return;
  }
  if (c.kind === 'import' && !c.exists && res && res.exists === true) { c.exists = true; keepNames(c); } // installed since the pick: ask to replace
  else c.error = lineOf(res, 'Action impossible');
  renderCard();
}

function onCardClick(e) {
  const btn = e.target && e.target.closest ? e.target.closest('button[data-act]') : null;
  if (!btn || btn.disabled || !plg.card) return;
  if (btn.dataset.act === 'card-cancel') closeCard();
  else if (btn.dataset.act === 'card-confirm') confirmCard();
  else if (btn.dataset.act === 'acc-detect') detect();
}

let animT = 0; // the entrance class rides a 900 ms timer (the keyframe lasts 850 ms), as room-panel.js
let hideT = 0; // `hidden` follows the 350 ms fade-out by 380 ms

// The Room shell (style.css): .open slides it in, the transient .rp-anim-in plays the entrance. One right-hand surface at a time.
function openPluginPanel() {
  const panel = $('plugin-panel');
  if (!panel || plg.open) return;
  overlayState.closeSidePanels?.();
  overlayState.closeRoomPanel?.();
  overlayState.closeAgentJournal?.();
  plg.open = true;
  clearTimeout(hideT);
  panel.hidden = false;
  panel.classList.add('open', 'rp-anim-in');
  clearTimeout(animT);
  animT = setTimeout(() => panel.classList.remove('rp-anim-in'), 320); // > panel-in on --dur-drawer (280 ms)
  panel.focus({ preventScroll: true });
  plgLoadList();
}

// The panel's own reset, run by closePluginPanel(). A hidden report page would keep running its script, so the frame goes
// away; the next opening serves it again.
function deactivate() {
  plg.open = false;
  plg.busy.clear();
  plg.stopping.clear();
  plg.refocus = null;
  plg.viewKey = null;
  viewSeq++;
  loadSeq++;
  cardSeq++;
  histSeq++;
  plg.card = null;
  plg.pickBusy = false;
  plg.tab = 'report';
  plg.pick = null;
  plg.full = null;
  plg.shown = null;
  plg.set = null;
  setSeq++;
  setPage('list');
  stopPoll();
  plg.hist = { id: null, all: [], rows: [] };
  renderCard();
  renderHead();
  renderDetail();
  $('plg-view').replaceChildren();
}

// A no-op when closed. A pending entrance is dropped first: its forwards fill would pin opacity and block the fade-out.
export function closePluginPanel() {
  const panel = $('plugin-panel');
  if (!panel || !plg.open) return;
  clearTimeout(animT);
  panel.classList.remove('rp-anim-in', 'open');
  deactivate();
  clearTimeout(hideT);
  hideT = setTimeout(() => { if (!plg.open) panel.hidden = true; }, 240); // > close transition on --dur-pop (200 ms)
}

// The native AI view draws above the DOM: a click in AI mode returns to Code mode first (the swap is synchronous).
function togglePluginPanel() {
  if (plg.open) { closePluginPanel(); return; }
  setMode('code');
  openPluginPanel();
}

// Called once from boot.js.
export function initPluginPanel() {
  const card = el('section', 'plg-card');
  card.id = 'plg-card';
  card.hidden = true;
  card.tabIndex = -1;
  card.setAttribute('role', 'group');
  card.addEventListener('click', onCardClick);
  card.addEventListener('input', onAccEdit);
  card.addEventListener('change', onAccEdit);
  $('plg-body').insertBefore(card, $('plg-body').firstChild);
  $('plg-body').insertBefore(buildDetail(), $('plg-view'));
  $('plg-body').insertBefore(buildHist(), $('plg-view').nextSibling);
  buildSettings();
  setPage('list');
  $('plg-back').addEventListener('click', backToList);
  $('plg-dhead').addEventListener('click', onHeadClick);
  $('plg-view').addEventListener('click', onViewClick);
  const imp = $('plg-import');
  imp.disabled = false;
  imp.addEventListener('click', startImport);
  $('plg-list').addEventListener('click', onListClick);
  $('plugin-toggle').addEventListener('click', togglePluginPanel);
  $('plg-close').addEventListener('click', closePluginPanel);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !plg.open) return;
    if (e.target && e.target.closest && e.target.closest('.pane-term')) return; // a terminal keeps its Escape (rule 8)
    e.preventDefault();
    if (plg.card) { if (!plg.card.busy) closeCard(); return; } // an open card closes first; a busy one holds both
    const panel = $('plugin-panel');
    if (panel.classList.contains('plg-fullscreen')) { panel.dispatchEvent(new Event('plg-full-exit')); return; } // then the full screen (plugin-full.js)
    if (plg.page === 'detail') { backToList(); return; } // then the detail page, then the list page: the panel
    closePluginPanel();
  });
}
