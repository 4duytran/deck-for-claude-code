// claude-deck — renderer/mr-list (deck-mr-ui U9): the open-MR list of the git panel's MR sub-view.
// A view over the data the caller hands in (no IO): search, « Toutes » / « Les miennes », author menu with counts,
// rows, empty / busy / error states. Every GitLab string reaches the DOM through textContent only.
import { exitThen } from './motion.js';
import { progressBar } from './loading.js';

const CAP_NOTE = 'Liste coupée : 500 premières MR ouvertes affichées';
const NO_USER = 'Utilisateur GitLab inconnu';
const ALL_AUTHORS = 'Tous les auteurs';
const POP_OUT = [
  { opacity: 1, transform: 'scale(1)' },
  { opacity: 0, transform: 'scale(0.98)' },
];

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

const str = (v) => (v == null ? '' : String(v));
const isAlnum = (c) => /[\p{L}\p{N}]/u.test(c);

export function initials(name, username) {
  const words = (str(name).trim() || str(username).trim()).split(/\s+/).filter(Boolean);
  const chars = (w) => Array.from(w).filter(isAlnum);
  let out = '';
  if (words.length > 1) out = (chars(words[0])[0] || '') + (chars(words[1])[0] || '');
  else if (words.length) out = chars(words[0]).slice(0, 2).join('');
  return out ? out.toLocaleUpperCase('fr') : '?';
}

export function ago(iso) {
  const t = Date.parse(iso);
  if (!iso || Number.isNaN(t)) return '';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return 'à l’instant';
  const m = Math.floor(s / 60);
  if (m < 60) return `il y a ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `il y a ${h} h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `il y a ${d} j`;
  if (d < 365) return `il y a ${Math.floor(d / 30)} mois`;
  const y = Math.floor(d / 365);
  return `il y a ${y} ${y > 1 ? 'ans' : 'an'}`;
}

const DRAFT_PREFIX = /^draft:\s*/i;

function norm(raw) {
  if (!raw || typeof raw !== 'object' || !Number.isFinite(Number(raw.iid))) return null;
  const full = str(raw.title);
  const bare = full.replace(DRAFT_PREFIX, '');
  return {
    raw,
    iid: Number(raw.iid),
    title: bare || full,
    author: str(raw.author),
    username: str(raw.username),
    updatedAt: str(raw.updatedAt),
    notes: Number.isInteger(raw.notes) ? raw.notes : null,
    source: str(raw.source),
    target: str(raw.target),
    draft: raw.draft === true || bare !== full,
  };
}

const authorKey = (m) => m.username || m.author;

// Token durations / easings for the menu exit; undefined tokens leave exitThen's own fallbacks.
function popTiming() {
  const cs = getComputedStyle(document.documentElement);
  const ms = /^(\d*\.?\d+)(ms|s)$/.exec(cs.getPropertyValue('--dur-pop').trim());
  const out = {};
  if (ms) out.duration = ms[2] === 's' ? parseFloat(ms[1]) * 1000 : parseFloat(ms[1]);
  const ease = cs.getPropertyValue('--ease-pop').trim();
  if (ease) out.easing = ease;
  return out;
}

export function mountMrList(host, { onOpen, onRetry } = {}) {
  const st = {
    mrs: [], truncated: false, me: null, query: '', chip: 'all',
    author: null, authorName: '', active: null, ready: false, error: null,
  };
  const rowsByIid = new Map(); // iid (string) -> { el, sig, mr }: rows are updated in place, never rebuilt per answer
  let menu = null;
  let progress = null;
  let failEl = null;
  let noteEl = null;

  host.textContent = '';
  host.setAttribute('aria-busy', 'false');

  const bar = el('div', 'mr-list-bar');
  const search = el('input', 'mr-search');
  search.type = 'search';
  search.placeholder = 'Rechercher (titre, !numéro, branche)';
  search.setAttribute('aria-label', 'Rechercher une merge request');
  search.autocomplete = 'off';
  search.spellcheck = false;
  const chip = (which, label) => {
    const b = el('button', 'mr-chip', label);
    b._label = label;
    b._count = el('span', 'mr-chip-count');
    b.type = 'button';
    b.dataset.filter = which;
    b.addEventListener('click', () => {
      if (b.disabled) return;
      st.chip = which;
      renderAll();
    });
    return b;
  };
  const chipAll = chip('all', 'Toutes');
  const chipMine = chip('mine', 'Les miennes');
  const authorBtn = el('button', 'mr-author-btn');
  authorBtn.type = 'button';
  authorBtn.setAttribute('aria-haspopup', 'menu');
  authorBtn.setAttribute('aria-expanded', 'false');
  bar.append(search, chipAll, chipMine, authorBtn);
  const heading = el('div', 'mr-list-heading');
  heading.hidden = true;
  const body = el('div', 'mr-rows');
  host.append(heading, bar, body);

  function openMr(m) {
    st.active = String(m.iid);
    syncActive();
    if (typeof onOpen === 'function') onOpen(m.raw);
  }

  function syncActive() {
    for (const r of body.children) {
      const on = r.dataset.iid === st.active;
      r.classList.toggle('active', on);
      if (on) r.setAttribute('aria-current', 'true'); else r.removeAttribute('aria-current');
    }
  }

  function visible() {
    const q = st.query.trim().toLowerCase();
    return st.mrs.filter((m) => {
      if (st.chip === 'mine' && m.username !== st.me) return false;
      if (st.author !== null && authorKey(m) !== st.author) return false;
      if (!q) return true;
      return m.title.toLowerCase().includes(q) || `!${m.iid}`.includes(q) || m.source.toLowerCase().includes(q);
    });
  }

  function fillRow(row, m, updated) {
    const avatar = el('span', 'mr-avatar', initials(m.author, m.username));
    const title = el('span', 'mr-title', m.title);
    title.title = m.title;
    const line = el('div', 'mr-line');
    line.append(el('span', 'mr-iid', `!${m.iid}`), title);
    if (m.draft) line.append(el('span', 'mr-draft-badge', 'Brouillon'));
    const meta = el('div', 'mr-line mr-meta');
    meta.append(
      el('span', 'mr-author', m.author),
      el('span', 'mr-branches mr-branch-pill', `${m.source} → ${m.target}`),
    );
    if (updated) {
      const up = el('span', 'mr-updated', updated);
      up.title = new Date(m.updatedAt).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });
      meta.append(up);
    }
    const main = el('div', 'mr-main');
    main.append(line, meta);
    const side = el('div', 'mr-side');
    if (m.notes !== null) { // 0 shows too; an unknown count (null) shows nothing
      const c = el('span', 'mr-comments', String(m.notes));
      const label = `${m.notes} commentaire${m.notes > 1 ? 's' : ''}`;
      c.title = label;
      c.setAttribute('aria-label', label);
      side.append(c);
    }
    row.replaceChildren(avatar, main, side);
  }

  function rowFor(m) {
    const key = String(m.iid);
    const updated = ago(m.updatedAt);
    const sig = [m.title, m.author, m.username, updated, m.notes, m.source, m.target, m.draft].join('\u0001');
    let r = rowsByIid.get(key);
    if (!r) {
      const e = el('div', 'mr-row mr-enter');
      e.dataset.iid = key;
      e.tabIndex = 0;
      e.setAttribute('role', 'button');
      e.addEventListener('animationend', () => e.classList.remove('mr-enter'), { once: true });
      r = { el: e, sig: '', mr: m };
      rowsByIid.set(key, r);
      e.addEventListener('click', () => openMr(r.mr));
    }
    r.mr = m;
    if (r.sig !== sig) { r.sig = sig; fillRow(r.el, m, updated); }
    return r.el;
  }

  function clearFilters() {
    st.query = '';
    search.value = '';
    st.chip = 'all';
    st.author = null;
    st.authorName = '';
    renderAll();
    search.focus({ preventScroll: true });
  }

  function emptyNode() {
    if (!st.mrs.length) return el('div', 'mr-empty', 'Aucune merge request ouverte');
    const box = el('div', 'mr-empty', 'Aucune merge request ne correspond.');
    const b = el('button', 'mr-clear', 'Effacer les filtres');
    b.type = 'button';
    b.addEventListener('click', clearFilters);
    box.append(b);
    return box;
  }

  function renderRows() {
    if (!st.ready) return;
    const list = visible();
    const keep = new Set(list.map((m) => String(m.iid)));
    for (const c of [...body.children]) if (!keep.has(c.dataset.iid)) c.remove(); // stale rows and the empty node
    if (!list.length) { body.append(emptyNode()); return; }
    list.forEach((m, i) => {
      const e = rowFor(m);
      if (body.children[i] !== e) body.insertBefore(e, body.children[i] || null);
    });
    syncActive();
  }

  // The count span of a chip: a number of the loaded list, or nothing while it is unknown (no data yet, no signed-in user).
  function setChipCount(b, n) {
    const c = b._count;
    if (n === null) { c.remove(); b.firstChild.data = b._label; return; }
    c.textContent = String(n);
    b.firstChild.data = `${b._label} `;
    if (!c.isConnected) b.append(c);
  }

  function syncControls() {
    const noUser = !st.me;
    setChipCount(chipAll, st.ready ? st.mrs.length : null);
    setChipCount(chipMine, st.ready && st.me ? st.mrs.filter((m) => m.username === st.me).length : null);
    chipMine.disabled = noUser;
    if (noUser) chipMine.title = NO_USER; else chipMine.removeAttribute('title');
    for (const c of [chipAll, chipMine]) {
      const on = st.chip === c.dataset.filter;
      c.classList.toggle('on', on);
      c.setAttribute('aria-pressed', String(on));
    }
    heading.hidden = !st.ready;
    heading.textContent = `Merge requests · ${st.mrs.length} ouverte${st.mrs.length > 1 ? 's' : ''}`;
    authorBtn.textContent = st.author === null ? 'Auteur ▾' : `Auteur : ${st.authorName} ▾`;
    authorBtn.classList.toggle('on', st.author !== null);
    if (st.truncated && !noteEl) {
      noteEl = el('div', 'mr-note', CAP_NOTE);
      (failEl || bar).after(noteEl);
    } else if (!st.truncated && noteEl) {
      noteEl.remove();
      noteEl = null;
    }
  }

  function renderAll() {
    syncControls();
    renderRows();
  }

  // ---- author menu (model: the git panel's base menu) ----

  function authorEntries() {
    const byKey = new Map();
    for (const m of st.mrs) {
      const k = authorKey(m);
      const e = byKey.get(k);
      if (e) e.count += 1; else byKey.set(k, { key: k, name: m.author || m.username, count: 1 });
    }
    const list = [...byKey.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'fr'));
    return [{ key: null, name: ALL_AUTHORS, count: st.mrs.length }, ...list];
  }

  function fillMenu(m, focusKey) {
    m.textContent = '';
    for (const en of authorEntries()) {
      const b = el('button', 'mr-author-item');
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.tabIndex = -1; // roving focus
      b._en = en;
      if (en.key !== null) b.append(el('span', 'mr-avatar', initials(en.name, en.key)));
      b.append(el('span', 'mr-author-name', en.name), el('span', 'mr-count', String(en.count)));
      b.title = en.name;
      if (en.key === st.author) { b.classList.add('on'); b.setAttribute('aria-current', 'true'); }
      b.addEventListener('click', (ev) => { ev.stopPropagation(); pickAuthor(en); });
      m.append(b);
    }
    const items = [...m.children];
    const want = focusKey === undefined ? items.find((b) => b.classList.contains('on')) : items.find((b) => b._en.key === focusKey);
    (want || items[0]).focus({ preventScroll: true });
  }

  function away(e) {
    if (menu && !menu.contains(e.target) && !authorBtn.contains(e.target)) closeMenu(false);
  }

  function openMenu() {
    closeMenu(false, false);
    const m = el('div', 'mr-author-menu mr-pop');
    m.setAttribute('role', 'menu');
    m.setAttribute('aria-label', 'Filtrer par auteur');
    m.addEventListener('keydown', menuKeys);
    authorBtn.after(m);
    menu = m;
    authorBtn.setAttribute('aria-expanded', 'true');
    document.addEventListener('click', away, true);
    fillMenu(m);
  }

  // The exiting menu loses its role (the side panel yields Esc to a visible menu) and its focus.
  function closeMenu(refocus, animate = true) {
    const m = menu;
    if (!m) return;
    menu = null;
    document.removeEventListener('click', away, true);
    authorBtn.setAttribute('aria-expanded', 'false');
    m.removeAttribute('role');
    m.inert = true;
    if (animate) exitThen(m, POP_OUT, popTiming()).then(() => m.remove()); else m.remove();
    if (refocus) authorBtn.focus({ preventScroll: true });
  }

  function pickAuthor(en) {
    closeMenu(true);
    st.author = en.key;
    st.authorName = en.key === null ? '' : en.name;
    renderAll();
  }

  // Keys the menu handles stop here, so the panel's own arrows / Enter / Esc never also act.
  function menuKeys(e) {
    const m = e.currentTarget;
    if (m !== menu) return;
    const items = [...m.children];
    const i = items.indexOf(document.activeElement);
    const stop = () => { e.preventDefault(); e.stopPropagation(); };
    const go = (n) => { stop(); items[(n + items.length) % items.length].focus(); };
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i < 0 ? 0 : i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(items.length - 1);
    else if (e.key === 'Enter' && i >= 0) { stop(); items[i].click(); }
    else if (e.key === 'Escape') { stop(); closeMenu(true); }
    else if (e.key === 'Tab') closeMenu(false);
  }

  authorBtn.addEventListener('click', () => { if (menu) closeMenu(false); else openMenu(); });

  // ---- search and keyboard ----

  search.addEventListener('input', () => {
    st.query = search.value;
    st.active = null;
    renderRows();
  });

  function step(delta, from) {
    const rows = [...body.querySelectorAll(':scope > .mr-row')];
    if (!rows.length) return;
    let i;
    if (from) {
      i = rows.indexOf(from) + delta;
      if (i < 0) { search.focus({ preventScroll: true }); return; }
    } else { // from the search field: land on the active row, else the first
      i = Math.max(0, rows.findIndex((r) => r.dataset.iid === st.active));
    }
    const r = rows[Math.min(rows.length - 1, i)];
    st.active = r.dataset.iid;
    syncActive();
    r.focus({ preventScroll: true });
    r.scrollIntoView({ block: 'nearest' });
  }

  host.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const t = e.target;
    const stop = () => { e.preventDefault(); e.stopPropagation(); };
    if (t === authorBtn && e.key === 'ArrowDown') { stop(); if (!menu) openMenu(); return; }
    if (t === search) {
      if (e.key === 'ArrowDown') { stop(); step(1, null); }
      else if (e.key === 'Enter') {
        const r = body.querySelector(':scope > .mr-row.active') || body.querySelector(':scope > .mr-row');
        if (r) { stop(); openMr(rowsByIid.get(r.dataset.iid).mr); }
      } else if (e.key === 'Escape' && search.value) {
        stop();
        search.value = '';
        st.query = '';
        renderRows();
      }
    } else if (t.classList && t.classList.contains('mr-row') && t.parentNode === body) {
      if (e.key === 'ArrowDown') { stop(); step(1, t); }
      else if (e.key === 'ArrowUp') { stop(); step(-1, t); }
      else if (e.key === 'Enter' || e.key === ' ') { stop(); openMr(rowsByIid.get(t.dataset.iid).mr); }
    }
  });

  // « / » focuses the search from anywhere in the shown panel, never while typing in a field.
  function onSlash(e) {
    if (!host.isConnected) { document.removeEventListener('keydown', onSlash, true); return; }
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
    if (host.getClientRects().length === 0) return;
    const t = e.target;
    if (t && (t.isContentEditable || (t.closest && t.closest('input, textarea, select')))) return;
    if (document.querySelector('[role="dialog"]')) return;
    e.preventDefault();
    e.stopPropagation();
    search.focus({ preventScroll: true });
    search.select();
  }
  document.addEventListener('keydown', onSlash, true);

  // ---- caller API ----

  function setData(data) {
    const d = data || {};
    const seen = new Set();
    st.mrs = (Array.isArray(d.mrs) ? d.mrs : []).map(norm).filter((m) => m && !seen.has(m.iid) && seen.add(m.iid));
    st.truncated = d.truncated === true;
    st.me = typeof d.me === 'string' && d.me ? d.me : null;
    if (!st.me && st.chip === 'mine') st.chip = 'all';
    st.ready = true;
    for (const [k, r] of rowsByIid) if (!seen.has(Number(k))) { r.el.remove(); rowsByIid.delete(k); }
    renderAll();
    if (menu) {
      const cur = document.activeElement && document.activeElement._en;
      fillMenu(menu, cur ? cur.key : st.author);
    }
  }

  function setBusy(on) {
    host.setAttribute('aria-busy', String(!!on));
    if (on && !progress) {
      progress = progressBar();
      host.prepend(progress);
    } else if (!on && progress) {
      progress.remove();
      progress = null;
    }
  }

  function setError(msg) {
    if (msg == null) {
      st.error = null;
      if (failEl) { failEl.remove(); failEl = null; }
      return;
    }
    st.error = str(msg) || 'erreur inconnue';
    if (!failEl) {
      failEl = el('div', 'mr-fail');
      failEl.setAttribute('role', 'alert');
      failEl.append(el('span', 'mr-fail-text'));
      const retry = el('button', 'mr-retry', 'Réessayer');
      retry.type = 'button';
      retry.addEventListener('click', () => { if (typeof onRetry === 'function') onRetry(); });
      failEl.append(retry);
      bar.after(failEl);
    }
    failEl.querySelector('.mr-fail-text').textContent = `Impossible de rafraîchir la liste : ${st.error}`;
  }

  syncControls();
  return { setData, setBusy, setError };
}
