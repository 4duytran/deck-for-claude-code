// claude-deck — renderer/new-session: the start screen shown in place of the empty state.
// A greeting, the deck composer (same look and classes as the chat composer), the folder chip with
// its popover (default dir, last dir, known projects, the native dialog), an optional session name.
// Enter / the send button spawns claude in the chosen dir; the typed text becomes its first message.
// All dir / name / project text reaches the DOM through textContent only.
'use strict';

import { newSessionState } from './state.js';
import { openPane } from './panes.js';
import { clearSelection } from './layout.js';
import { tokensText, dragHasFiles, droppedPaths } from './file-drop.js';

const $ = (id) => document.getElementById(id);
const dirLabel = (dir) => dir.split('/').filter(Boolean).pop() || dir;
const tildify = (dir) => dir.replace(/^\/(?:home|Users)\/[^/]+(?=\/|$)/, '~');
const DEFAULT_TAG = 'défaut';
const START_EVENT = 'deck:new-session-start'; // detail = the exact openPane argument (probe seam)

// Same vocabulary as the chat composer (chat-view.js, read-only here). val '' = no pick: the CLI default.
// permissionMode uses the CLI spelling; the composer's internal id for « auto-accept » is accept-edits.
const MODES = [
  { val: '', label: 'normal' }, { val: 'acceptEdits', label: 'auto-accept' },
  { val: 'plan', label: 'plan' }, { val: 'auto', label: 'auto' },
];
// Main drops any model other than opus | sonnet | haiku | fable (or claude-*): the composer's 1M and
// opusplan aliases are left out here so a pill never shows a pick that the spawn would ignore.
const MODELS = [
  { val: 'fable', label: 'Fable' }, { val: 'opus', label: 'Opus' }, { val: 'sonnet', label: 'Sonnet' },
  { val: 'haiku', label: 'Haiku' }, { val: '', label: 'Défaut du compte' },
];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'].map((v) => ({ val: v, label: v }))
  .concat([{ val: '', label: 'auto' }]);
const PILLS = [
  { key: 'mode', btn: 'ns-pill-mode', cls: 'cc-mode', unset: 'normal', choices: MODES },
  { key: 'model', btn: 'ns-pill-model', cls: 'cc-model', unset: 'Modèle', choices: MODELS },
  { key: 'effort', btn: 'ns-pill-effort', cls: 'cc-effort', unset: 'Effort', choices: EFFORTS },
];

const home = { dir: null, touched: false, starting: false, picks: { mode: '', model: '', effort: '' } };
let popEl = null; // the folder popover, when open

// Transient bottom toast (e.g. picked folder vanished) — informative, no crash.
function showToast(message) {
  const prev = document.getElementById('toast');
  if (prev) prev.remove();
  const t = document.createElement('div');
  t.id = 'toast';
  t.textContent = message;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

function lastDirOf() {
  try { return localStorage.getItem('deck-last-dir'); } catch (_) { return null; }
}
const initialDir = () => newSessionState.defaultDir || lastDirOf();

// Validate then spawn — the dir may have vanished since the scan/last pick. An optional name becomes the
// pane title AND rides down to the spawn (deck-chosen session id + native custom-title at close); the
// optional text is the first message; model / permissionMode / effort are the pills' picks (L1 validates).
async function startNewSession(dir, name, extra = {}) {
  let ok = false;
  try { ok = await window.api.dirExists(dir); } catch (_) { ok = false; }
  if (!ok) {
    showToast(`Dossier introuvable : ${dir}`);
    return false;
  }
  try { localStorage.setItem('deck-last-dir', dir); } catch (_) { /* quota — cosmetic */ }
  const args = {
    cwd: dir,
    title: name || `${dirLabel(dir)} (new)`,
    newName: name || undefined,
    initialPrompt: extra.text || undefined,
    model: extra.model || undefined,
    permissionMode: extra.permissionMode || undefined,
    effort: extra.effort || undefined,
  };
  document.dispatchEvent(new CustomEvent(START_EVENT, { detail: args }));
  openPane(args);
  return true;
}

// ---- view state -----------------------------------------------------------------------------
function renderChip() {
  const btn = $('ns-ws-btn');
  btn.querySelector('.ns-ws-nm').textContent = home.dir ? dirLabel(home.dir) : 'Choisir un dossier';
  btn.querySelector('.ns-ws-pt').textContent = home.dir ? tildify(home.dir) : '';
  btn.title = home.dir || 'Dossier de la session';
}

function renderPill(p) {
  const pick = home.picks[p.key];
  const choice = pick && p.choices.find((c) => c.val === pick);
  const btn = $(p.btn);
  btn.querySelector(`.${p.cls}-label`).textContent = choice ? choice.label : p.unset;
  btn.classList.toggle('is-unset', !choice);
}

function closePillMenus() {
  for (const p of PILLS) {
    const btn = $(p.btn);
    btn.parentElement.querySelector(`.${p.cls}-menu`).hidden = true;
    btn.setAttribute('aria-expanded', 'false');
  }
}
const openPill = () => PILLS.find((p) => $(p.btn).getAttribute('aria-expanded') === 'true') || null;

function resetHome() {
  closeFolderPop(false);
  closePillMenus();
  home.dir = initialDir();
  home.touched = false;
  home.picks = { mode: '', model: '', effort: '' };
  const ta = $('ns-input');
  ta.value = '';
  ta.style.height = '';
  $('ns-name').value = '';
  renderChip();
  PILLS.forEach(renderPill);
}

// Dropped files: their tokens replace the selection of the input (`@rel` inside the chosen folder, else `@abs`),
// the chat composer's tokens. The folder is the session's cwd, so it is the only root.
function insertFileTokens(ta, paths) {
  const { selectionStart: start, selectionEnd: end } = ta;
  ta.focus({ preventScroll: true });
  ta.setRangeText(tokensText(paths, home.dir ? [home.dir] : [], ta.value.charAt(start - 1)), start, end, 'end');
  ta.dispatchEvent(new Event('input', { bubbles: true })); // the autosize
}

// « + » of the sidebar: back to the home (the shown pane keeps running hidden), composer focused.
function showHome() {
  const already = !$('grid-empty').hidden; // a draft in progress survives a second « + »
  clearSelection();
  if (!already) resetHome();
  $('ns-input').focus({ preventScroll: true });
}

async function submit() {
  if (home.starting) return;
  if (!home.dir) { openFolderPop(); return; }
  home.starting = true;
  try {
    const started = await startNewSession(home.dir, $('ns-name').value.trim(), {
      text: $('ns-input').value.trim(),
      model: home.picks.model,
      permissionMode: home.picks.mode,
      effort: home.picks.effort,
    });
    if (started) resetHome();
  } finally {
    home.starting = false;
  }
}

// ---- pills ----------------------------------------------------------------------------------
function buildPills() {
  for (const p of PILLS) {
    const btn = $(p.btn);
    const menu = btn.parentElement.querySelector(`.${p.cls}-menu`);
    for (const c of p.choices) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = `${p.cls}-item`;
      item.setAttribute('role', 'menuitemradio');
      item.dataset.val = c.val;
      item.textContent = c.label;
      item.addEventListener('click', () => {
        home.picks[p.key] = c.val;
        renderPill(p);
        closePillMenus();
        $('ns-input').focus({ preventScroll: true });
      });
      menu.appendChild(item);
    }
    btn.addEventListener('click', () => {
      const wasOpen = !menu.hidden;
      closeFolderPop(false);
      closePillMenus();
      if (wasOpen) return;
      for (const item of menu.children) {
        const on = item.dataset.val === home.picks[p.key];
        item.classList.toggle('active', on);
        item.setAttribute('aria-checked', String(on));
      }
      menu.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
    });
    renderPill(p);
  }
}

// ---- folder popover -------------------------------------------------------------------------
function folderGroups() {
  const def = newSessionState.defaultDir;
  const last = lastDirOf();
  const groups = [];
  if (def) groups.push({ head: null, items: [{ name: dirLabel(def), path: def, tag: DEFAULT_TAG }] });
  if (last && last !== def) groups.push({ head: 'Récent', items: [{ name: dirLabel(last), path: last }] });
  const known = (newSessionState.knownProjects || [])
    .filter((p) => p && p.cwd && p.cwd !== def && p.cwd !== last)
    .map((p) => ({ name: p.project || dirLabel(p.cwd), path: p.cwd }));
  if (known.length) groups.push({ head: 'Projets connus', items: known });
  return groups;
}

function setDir(dir) {
  home.dir = dir;
  home.touched = true;
  try { localStorage.setItem('deck-last-dir', dir); } catch (_) { /* quota — cosmetic */ }
  renderChip();
}

function closeFolderPop(refocus) {
  if (!popEl) return;
  popEl.remove();
  popEl = null;
  const btn = $('ns-ws-btn');
  btn.setAttribute('aria-expanded', 'false');
  if (refocus) btn.focus();
}

async function pickOtherFolder() {
  closeFolderPop(false);
  let dir = null;
  try { dir = await window.api.pickFolder(); } catch (_) { dir = null; }
  if (dir) setDir(dir); // null = canceled — silent
  $('ns-ws-btn').focus();
}

function openFolderPop() {
  closePillMenus();
  const btn = $('ns-ws-btn');
  const pop = document.createElement('div');
  pop.className = 'ns-pop';
  pop.setAttribute('role', 'listbox');
  pop.setAttribute('aria-label', 'Choisir un dossier');
  pop.setAttribute('data-sp-popup', '');
  const search = document.createElement('input');
  search.type = 'text';
  search.placeholder = 'Chercher un dossier…';
  search.setAttribute('aria-label', 'Chercher un dossier');
  search.autocomplete = 'off';
  search.spellcheck = false;
  const list = document.createElement('div');
  pop.append(search, list);

  const groups = folderGroups();
  let opts = [];
  let cursor = 0;
  const paintCursor = (scroll) => {
    opts.forEach((o, i) => o.classList.toggle('cur', i === cursor));
    if (opts[cursor]) {
      search.setAttribute('aria-activedescendant', opts[cursor].id);
      if (scroll) opts[cursor].scrollIntoView({ block: 'nearest' });
    }
  };
  const addOpt = (onPick) => {
    const o = document.createElement('button');
    o.type = 'button';
    o.className = 'ns-opt';
    o.id = `ns-opt-${opts.length}`;
    o.setAttribute('role', 'option');
    const idx = opts.length;
    o.addEventListener('mouseenter', () => { cursor = idx; paintCursor(false); });
    o.addEventListener('click', onPick);
    opts.push(o);
    list.appendChild(o);
    return o;
  };
  const cell = (cls, text) => {
    const s = document.createElement('span');
    if (cls) s.className = cls;
    if (text) s.textContent = text;
    return s;
  };
  const renderList = () => {
    const q = search.value.trim().toLowerCase();
    list.replaceChildren();
    opts = [];
    for (const g of groups) {
      const items = g.items.filter((it) => !q || it.name.toLowerCase().includes(q) || it.path.toLowerCase().includes(q));
      if (!items.length) continue;
      if (g.head) {
        const h = document.createElement('div');
        h.className = 'ns-pop-head';
        h.textContent = g.head;
        list.appendChild(h);
      }
      for (const it of items) {
        const o = addOpt(() => { setDir(it.path); closeFolderPop(true); });
        o.setAttribute('aria-selected', String(it.path === home.dir));
        const mid = cell('ns-opt-mid');
        mid.append(cell('ns-opt-t', it.name), cell('ns-opt-p', tildify(it.path)));
        o.append(cell('ns-opt-ck', '✓'), mid, cell('ns-opt-tag', it.tag || ''));
      }
    }
    const sep = document.createElement('div');
    sep.className = 'ns-pop-sep';
    list.appendChild(sep);
    const other = addOpt(pickOtherFolder);
    other.setAttribute('aria-selected', 'false');
    other.append(cell('ns-opt-ck'), cell('ns-opt-t', 'Choisir un autre dossier…'), cell());
    cursor = Math.min(cursor, opts.length - 1);
    paintCursor(false);
  };
  search.addEventListener('input', () => { cursor = 0; renderList(); });
  pop.addEventListener('keydown', (e) => {
    e.stopPropagation(); // the popover owns its keys: no document-level Escape / shortcut also fires
    if (e.key === 'Escape') { e.preventDefault(); closeFolderPop(true); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      cursor = (cursor + (e.key === 'ArrowDown' ? 1 : -1) + opts.length) % opts.length;
      paintCursor(true);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (opts[cursor]) opts[cursor].click();
    } else if (e.key === 'Tab') closeFolderPop(false);
  });

  renderList();
  btn.parentElement.appendChild(pop);
  popEl = pop;
  btn.setAttribute('aria-expanded', 'true');
  // Below the chip by default; above it when the viewport has no room underneath.
  const r = pop.getBoundingClientRect();
  if (r.bottom > window.innerHeight - 8 && btn.getBoundingClientRect().top > r.height + 16) pop.classList.add('above');
  search.focus();
}

// ---- wiring ---------------------------------------------------------------------------------
// « + » button, the home's own controls, global closers and the default dir fetch — called once from boot.js.
export function initNewSession() {
  $('new-session').addEventListener('click', showHome);
  buildPills();
  home.dir = initialDir();
  renderChip();

  const ta = $('ns-input');
  const nameEl = $('ns-name');
  ta.addEventListener('input', () => {
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 232)}px`;
  });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
  });
  nameEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); submit(); }
  });
  // Files from the file manager: the whole composer is the drop surface. A file drag is always default-prevented
  // (else the window navigates to the file); a text drag keeps the textarea's native drop.
  const composerEl = ta.closest('.ns-composer');
  const onDragFiles = (e) => {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };
  composerEl.addEventListener('dragenter', onDragFiles);
  composerEl.addEventListener('dragover', onDragFiles);
  composerEl.addEventListener('drop', (e) => {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    const paths = droppedPaths(e);
    if (paths.length) insertFileTokens(ta, paths);
  });
  $('ns-send').addEventListener('click', submit);
  $('ns-ws-btn').addEventListener('click', () => { if (popEl) closeFolderPop(false); else openFolderPop(); });

  window.api.defaultSessionDir()
    .then((d) => {
      newSessionState.defaultDir = d;
      if (!home.touched) { home.dir = initialDir(); renderChip(); }
    })
    .catch(() => { newSessionState.defaultDir = null; });

  document.addEventListener('click', (e) => {
    const t = e.target;
    if (popEl && !popEl.contains(t) && !$('ns-ws-btn').contains(t)) closeFolderPop(false);
    if (openPill() && !(t.closest && t.closest('.cc-mode-dd, .cc-model-dd, .cc-effort-dd'))) closePillMenus();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (popEl) { closeFolderPop(true); return; }
    const p = openPill();
    if (p) { closePillMenus(); $(p.btn).focus(); }
  });
}
