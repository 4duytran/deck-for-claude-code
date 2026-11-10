// git-refs: the branch column of the git view. A view over the `git-panel-refs` answer (names and the
// HEAD flag only): no IO, DOM through createElement + textContent. Picking a ref only reports it to
// onPick; the column never changes what the repository has checked out.

const SVG_NS = 'http://www.w3.org/2000/svg';

const ICONS = {
  search: [['circle', { cx: 11, cy: 11, r: 8 }], ['path', { d: 'm21 21-4.3-4.3' }]],
  chevron: [['path', { d: 'm6 9 6 6 6-6' }]],
  branch: [['line', { x1: 6, y1: 3, x2: 6, y2: 15 }], ['circle', { cx: 18, cy: 6, r: 3 }], ['circle', { cx: 6, cy: 18, r: 3 }],
    ['path', { d: 'M18 9a9 9 0 0 1-9 9' }]],
  cloud: [['path', { d: 'M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z' }]],
  tag: [['path', { d: 'M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z' }],
    ['circle', { cx: 7.5, cy: 7.5, r: 0.5, fill: 'currentColor' }]],
};

const SECTIONS = [
  { kind: 'local', field: 'locals', title: 'Locales', icon: 'branch', foldable: false },
  { kind: 'remote', field: 'remotes', title: 'Distantes', icon: 'cloud', foldable: true },
  { kind: 'tag', field: 'tags', title: 'Tags', icon: 'tag', foldable: true },
];

const el = (tag, cls) => {
  const node = document.createElement(tag);
  node.className = cls;
  return node;
};

function icon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  const attrs = { width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2,
    'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false', class: 'glog-ref-ico' };
  for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, String(v));
  for (const [tag, props] of ICONS[name]) {
    const shape = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(props)) shape.setAttribute(k, String(v));
    svg.append(shape);
  }
  return svg;
}

export function mountGitRefs(host, handlers) {
  const { onPick } = handlers || {};
  let query = '';
  let shown = null; // { kind, name } of the ref on show, driven by setShown only

  const search = el('input', 'glog-ref-search');
  search.type = 'search';
  search.placeholder = 'Branche ou tag';
  search.autocomplete = 'off';
  search.spellcheck = false;
  search.setAttribute('aria-label', 'Chercher une branche ou un tag');
  const searchIcon = el('span', 'glog-ref-search-ico');
  searchIcon.append(icon('search'));
  const searchBox = el('label', 'glog-ref-searchbox');
  searchBox.append(searchIcon, search);

  // open = items shown; auto = a search opened it, so clearing the search folds it back
  const parts = SECTIONS.map((def) => {
    const root = el('div', 'glog-ref-section');
    root.dataset.section = def.kind;
    root.hidden = true;
    const title = el('span', 'glog-ref-title');
    title.textContent = def.title;
    const items = el('div', 'glog-ref-items');
    const part = { def, root, items, fold: null, rows: [], open: !def.foldable, auto: false };
    if (def.foldable) {
      part.fold = el('button', 'glog-ref-fold');
      part.fold.type = 'button';
      part.fold.append(icon('chevron'), title);
      part.fold.addEventListener('click', () => {
        part.open = !part.open;
        part.auto = false;
        paint();
      });
      root.append(part.fold, items);
    } else {
      const head = el('div', 'glog-ref-head');
      head.append(title);
      root.append(head, items);
    }
    return part;
  });

  const empty = el('p', 'glog-ref-empty');
  empty.textContent = 'Aucune branche ou tag ne correspond';
  empty.hidden = true;
  const note = el('p', 'glog-ro-note');
  note.textContent = 'Lecture seule : choisir une branche ne fait aucun checkout.';
  host.replaceChildren(searchBox, ...parts.map((p) => p.root), empty, note);

  const matches = (row) => !query || row.lower.includes(query);

  function paint() {
    let hits = 0;
    for (const part of parts) {
      let n = 0;
      for (const row of part.rows) {
        const ok = matches(row);
        row.node.hidden = !ok;
        if (ok) n++;
        if (shown && shown.kind === part.def.kind && shown.name === row.name) row.node.setAttribute('aria-current', 'true');
        else row.node.removeAttribute('aria-current');
      }
      part.root.hidden = n === 0;
      part.items.hidden = !part.open;
      if (part.fold) part.fold.setAttribute('aria-expanded', String(part.open));
      hits += n;
    }
    empty.hidden = !query || hits > 0;
  }

  function buildRow(def, entry) {
    const node = el('button', 'glog-ref');
    node.type = 'button';
    node.dataset.kind = def.kind;
    node.dataset.name = entry.name;
    node.title = entry.name;
    const label = el('span', 'glog-ref-name');
    label.textContent = entry.name;
    node.append(icon(def.icon), label);
    if (def.kind === 'local' && entry.head === true) {
      const badge = el('span', 'glog-head-badge');
      badge.textContent = 'HEAD';
      node.append(badge);
    }
    node.addEventListener('click', () => {
      if (typeof onPick === 'function') onPick({ kind: def.kind, name: entry.name });
    });
    return { node, name: entry.name, lower: entry.name.toLowerCase() };
  }

  search.addEventListener('input', () => {
    query = search.value.trim().toLowerCase();
    for (const part of parts) {
      if (!part.def.foldable) continue;
      if (!query) {
        if (part.auto && !(shown && shown.kind === part.def.kind)) part.open = false;
        part.auto = false;
      } else if (!part.open && part.rows.some(matches)) {
        part.open = true;
        part.auto = true;
      }
    }
    paint();
  });

  return {
    setData(answer) {
      const data = answer && typeof answer === 'object' ? answer : {};
      for (const part of parts) {
        const list = Array.isArray(data[part.def.field]) ? data[part.def.field] : [];
        part.rows = list
          .filter((entry) => entry && typeof entry.name === 'string' && entry.name !== '')
          .map((entry) => buildRow(part.def, entry));
        part.items.replaceChildren(...part.rows.map((r) => r.node));
      }
      paint();
    },
    setShown(ref) {
      shown = ref && typeof ref.name === 'string' ? { kind: ref.kind, name: ref.name } : null;
      paint();
    },
  };
}
