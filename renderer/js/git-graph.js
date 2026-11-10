// git-graph.js: the log column of the git view (contract 4.5). A stateless leaf: no import, no IO, DOM built with
// createElement + textContent only. Lane 0 is the trunk (a straight line), lane 1 the shown branch, which leaves the
// trunk at the merge-base, the first shared row. The caller hands rows in git order; this module only groups them.
const WIP_KEY = 'wip';
const RANK = { 'trunk-only': 0, incoming: 0, branch: 1, shared: 2 };
const LEGEND_ORDER = ['branch', 'trunk-only', 'incoming', 'shared'];
const CHIP_KINDS = new Set(['branch', 'origin', 'develop', 'origin-develop']);
const SHA_CHARS = 7;
const DAY_MS = 86400000;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/; // git's %aI

const str = (v) => (typeof v === 'string' ? v : '');
const pad2 = (n) => String(n).padStart(2, '0');
const norm = (t) => (typeof t === 'string' ? t.trim().toLowerCase() : '');
// hidden alone loses against an author display rule, so the inline style backs it
const show = (el, on) => { el.hidden = !on; el.style.display = on ? '' : 'none'; };
const isShown = (el) => !el.hidden && el.style.display !== 'none';

function node(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

// ISO date -> the mockup's short form ("auj. 08:12", "hier 18:11", "29/10 19:02"); anything else shows nothing
function whenOf(iso, now) {
  const none = { text: '', full: '' };
  if (typeof iso !== 'string' || !ISO_RE.test(iso)) return none;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return none;
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const midnight = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const ago = Math.round((midnight(now) - midnight(d)) / DAY_MS);
  const dm = `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}`;
  let text;
  if (ago === 0) text = `auj. ${hm}`;
  else if (ago === 1) text = `hier ${hm}`;
  else if (d.getFullYear() === now.getFullYear()) text = `${dm} ${hm}`;
  else text = `${dm}/${d.getFullYear()}`;
  return { text, full: d.toLocaleString('fr-FR') };
}

function cleanRows(list) {
  const out = [];
  for (const r of Array.isArray(list) ? list : []) {
    if (!r || typeof r !== 'object' || typeof r.sha !== 'string' || r.sha === '') continue;
    out.push({ sha: r.sha, author: str(r.author), date: str(r.date), subject: str(r.subject),
      seg: Object.hasOwn(RANK, r.seg) ? r.seg : 'shared' });
  }
  return out;
}

const sortRows = (rows) => rows.slice().sort((a, b) => RANK[a.seg] - RANK[b.seg]); // stable: git order kept per segment

function cleanWip(w) {
  if (!w || typeof w !== 'object') return null;
  return { lotsOnly: w.lotsOnly === true, files: Number.isInteger(w.files) && w.files > 0 ? w.files : 0 };
}

export function mountGitGraph(host, opts) {
  const { onSelect, onMore } = opts || {};
  let rows = [];
  let wip = null;
  let chips = {};
  let view = 'branch';
  let labels = {};
  let more = false;
  let capped = false;
  let filter = '';
  let selKey = null;
  let items = []; // [{key, btn, hay}] in displayed order

  const root = node('div', 'glog-view');
  const count = node('span', 'glog-count');
  const legend = node('span', 'glog-legend');
  const filterEl = node('input', 'glog-filter');
  filterEl.type = 'search';
  filterEl.placeholder = 'Filtrer les commits';
  filterEl.setAttribute('aria-label', 'Filtrer les commits');
  const head = node('div', 'glog-head');
  head.append(node('span', 'glog-title', 'Historique'), count, legend, filterEl);
  const list = node('div', 'glog-list');
  const empty = node('p', 'glog-empty', 'Aucun commit ne correspond');
  const moreBtn = node('button', 'glog-more', 'Charger 50 commits de plus');
  moreBtn.type = 'button';
  const note = node('p', 'glog-more-note', "Limite de chargement de l'historique atteinte");
  const foot = node('div', 'glog-foot');
  foot.append(moreBtn, note);
  root.append(head, list);
  host.append(root);

  const chipsOf = (sha) => {
    const l = Object.hasOwn(chips, sha) ? chips[sha] : null;
    if (!Array.isArray(l)) return [];
    return l.filter((c) => c && typeof c.text === 'string' && c.text !== '')
      .map((c) => ({ kind: CHIP_KINDS.has(c.kind) ? c.kind : 'other', text: c.text }));
  };

  // displayed entries: rows grouped by segment, the wip row first inside the branch segment (first of all elsewhere)
  function entries() {
    const out = rows.map((row) => ({ key: row.sha, seg: row.seg, tone: row.seg, row }));
    if (wip) {
      const at = view === 'branch' ? out.findIndex((e) => RANK[e.seg] >= 1) : 0;
      out.splice(at < 0 ? out.length : at, 0, { key: WIP_KEY, seg: WIP_KEY, tone: 'wip', row: null });
    }
    // a branch that contains the trunk (no trunk-only row) stays on one straight lane; main sends trunk-only rows on page 0
    const linear = view === 'branch' && !out.some((e) => e.seg === 'trunk-only');
    for (const e of out) e.lane = view === 'branch' && !linear && (e.seg === 'branch' || e.seg === WIP_KEY) ? 1 : 0;
    return out;
  }

  function laneSpan(lane, half, tone) {
    const s = node('span', 'glog-lane');
    s.dataset.lane = String(lane);
    s.dataset.half = half;
    s.dataset.kind = tone;
    return s;
  }

  // tones = [lane 0, lane 1]: the colour a lane carries below the last row that sat on it
  function buildGraph(e, i, geo, tones, tip) {
    const g = node('span', 'glog-graph');
    const down = i < geo.n - 1 || more; // the last loaded row only trails off while more history exists
    if (geo.f0 >= 0 && i >= geo.f0) {
      if (i > geo.f0) g.append(laneSpan(0, 'up', tones[0]));
      if (e.lane === 0) tones[0] = e.tone;
      if (down) g.append(laneSpan(0, 'down', tones[0]));
    }
    if (geo.f1 >= 0 && i >= geo.f1 && i < geo.end1) {
      if (i > geo.f1) g.append(laneSpan(1, 'up', tones[1]));
      if (e.lane === 1) tones[1] = e.tone;
      if (down) g.append(laneSpan(1, 'down', tones[1]));
    }
    if (i === geo.join) g.append(node('span', 'glog-join'));
    const dot = node('span', 'glog-dot');
    dot.dataset.lane = String(e.lane);
    dot.dataset.kind = e.tone;
    if (tip) dot.dataset.trunk = 'true';
    if (e.seg === 'incoming') dot.classList.add('glog-dot-dashed');
    g.append(dot);
    return g;
  }

  function buildRow(e, i, geo, tones, now) {
    const btn = node('button', 'glog-row');
    btn.type = 'button';
    btn.dataset.key = e.key;
    btn.dataset.seg = e.seg;
    btn.dataset.lane = String(e.lane);
    const main = node('span', 'glog-main');
    const subject = node('span', 'glog-subject');
    const author = node('span', 'glog-author');
    const date = node('span', 'glog-date');
    const sha = node('span', 'glog-sha');
    let hay;
    let tip = false; // the trunk's own tip gets a ringed dot
    if (e.row) {
      const r = e.row;
      const when = whenOf(r.date, now);
      subject.textContent = r.subject;
      subject.title = r.subject;
      author.textContent = r.author;
      date.textContent = when.text;
      date.title = when.full;
      sha.textContent = r.sha.slice(0, SHA_CHARS);
      sha.title = r.sha;
      main.append(subject);
      const cl = chipsOf(r.sha);
      for (const c of cl) {
        const chip = node('span', 'glog-chip', c.text);
        chip.dataset.kind = c.kind;
        main.append(chip);
      }
      // only a shared row rings (mockup-v12: `shared` + the local trunk chip); incoming / trunk-only dots keep their style
      tip = e.seg === 'shared' && cl.some((c) => c.kind === 'develop');
      hay = [r.subject, r.author, r.sha].join('\n').toLowerCase();
    } else {
      subject.textContent = wip.lotsOnly ? 'En cours dans les lots' : 'Modifications non commitées';
      main.append(subject);
      if (!wip.lotsOnly && wip.files > 0) {
        const chip = node('span', 'glog-chip', wip.files === 1 ? '1 fichier' : `${wip.files} fichiers`);
        chip.dataset.kind = 'wip';
        main.append(chip);
      }
      author.textContent = '—';
      date.textContent = 'maintenant';
      hay = subject.textContent.toLowerCase();
    }
    btn.append(buildGraph(e, i, geo, tones, tip), main, author, date, sha);
    return { key: e.key, btn, hay };
  }

  function renderLegend() {
    const present = new Set(rows.map((r) => r.seg));
    const local = str(labels.local) || 'develop';
    const target = str(labels.target) || local;
    // a trunk view shows the local trunk (labels.branch = its name) or the origin one (« origin/<x> »): only the first is « ton … local »
    const shared = view !== 'trunk' ? 'historique commun' : str(labels.branch) === local ? `ton ${local} local` : '';
    const text = {
      branch: 'ta branche',
      'trunk-only': `${target}, pas dans ta branche`,
      incoming: `sur GitLab, pas encore dans ton ${local}`,
      shared,
    };
    legend.replaceChildren(...LEGEND_ORDER.filter((k) => present.has(k) && text[k] !== '').map((k) => {
      const item = node('span', 'glog-legend-item');
      item.dataset.laneKind = k;
      const dot = node('span', 'glog-legend-dot');
      dot.dataset.kind = k;
      dot.setAttribute('aria-hidden', 'true');
      item.append(dot, node('span', 'glog-legend-text', text[k]));
      return item;
    }));
  }

  function applyFilter() {
    let shown = 0;
    for (const it of items) {
      const on = filter === '' || it.hay.includes(filter);
      show(it.btn, on);
      if (on) shown++;
    }
    show(empty, filter !== '' && items.length > 0 && shown === 0);
  }

  function applySelection() {
    if (selKey !== null && !items.some((it) => it.key === selKey)) selKey = null;
    for (const it of items) {
      const on = it.key === selKey;
      it.btn.classList.toggle('sel', on);
      if (on) it.btn.setAttribute('aria-current', 'true');
      else it.btn.removeAttribute('aria-current');
    }
  }

  function render() {
    const ordered = entries();
    const n = ordered.length;
    const f1 = ordered.findIndex((e) => e.lane === 1);
    const firstShared = view === 'branch' && f1 >= 0 ? ordered.findIndex((e) => e.seg === 'shared') : -1;
    const join = firstShared > f1 ? firstShared : -1; // the lane-1 curve joins the trunk on the merge-base row
    const geo = { n, f0: ordered.findIndex((e) => e.lane === 0), f1, join, end1: join >= 0 ? join : n };
    const tones = ['shared', 'branch'];
    const now = new Date();
    const top = list.scrollTop;
    const a = document.activeElement;
    const refocus = a && a.classList && a.classList.contains('glog-row') && list.contains(a) ? a.dataset.key : null;
    items = ordered.map((e, i) => buildRow(e, i, geo, tones, now));
    list.replaceChildren(...items.map((it) => it.btn), empty, foot);
    list.scrollTop = top;
    if (refocus !== null) items.find((it) => it.key === refocus)?.btn.focus({ preventScroll: true });
    count.textContent = `${rows.length} ${rows.length > 1 ? 'commits' : 'commit'}`;
    renderLegend();
    show(moreBtn, more && !capped);
    show(note, capped);
    applySelection();
    applyFilter();
  }

  function select(key) {
    if (typeof key !== 'string' || key === selKey) return;
    const it = items.find((x) => x.key === key);
    if (!it) return;
    if (!isShown(it.btn)) { filterEl.value = ''; filter = ''; applyFilter(); } // a hidden selection would be invisible
    selKey = key;
    applySelection();
    if (typeof onSelect === 'function') onSelect(key);
  }

  list.addEventListener('click', (ev) => {
    const btn = ev.target instanceof Element ? ev.target.closest('.glog-row') : null;
    if (btn && list.contains(btn)) select(btn.dataset.key);
  });
  moreBtn.addEventListener('click', () => { if (typeof onMore === 'function') onMore(); });
  filterEl.addEventListener('input', () => { filter = norm(filterEl.value); applyFilter(); });

  render();

  return {
    setData(d) {
      const x = d && typeof d === 'object' ? d : {};
      rows = sortRows(cleanRows(x.rows));
      wip = cleanWip(x.wip);
      chips = x.chips && typeof x.chips === 'object' ? x.chips : {};
      view = x.view === 'trunk' || x.view === 'single' ? x.view : 'branch';
      labels = x.labels && typeof x.labels === 'object' ? x.labels : {};
      more = x.more === true;
      capped = x.capped === true;
      render();
    },
    append(newRows, hasMore, isCapped) {
      if (Array.isArray(newRows)) rows = sortRows(rows.concat(cleanRows(newRows)));
      more = hasMore === true;
      capped = isCapped === true;
      render();
    },
    setFilter(text) {
      filterEl.value = typeof text === 'string' ? text : '';
      filter = norm(filterEl.value);
      applyFilter();
    },
    select,
    selected: () => selKey,
  };
}
