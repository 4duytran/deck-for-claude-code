// claude-deck — renderer/git-commit: the commit detail column of the git panel (kicker, subject, author, date, sha with
// copy, full message, then the changed files grouped by folder with a status pill and +N / −N). Pure DOM, no IO and no
// import: the caller hands in the `git-panel-commit` answer, the log row and the labels, and wires onFile / onCopy.
// Every repo string (author, subject, message, path, label) reaches the page through textContent.

const MINUS = '−';
const ROOT_LABEL = '(racine)';
const STATUSES = new Set(['A', 'M', 'D', 'T']);
const COPIED_MS = 1400;
const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  copy: [['rect', { x: 9, y: 9, width: 13, height: 13, rx: 2 }], ['path', { d: 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1' }]],
  check: [['polyline', { points: '20 6 9 17 4 12' }]],
  folder: [['path', { d: 'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z' }]],
};

const str = (v) => (v == null ? '' : String(v));
const name = (v) => (typeof v === 'string' ? v : '');
const isAlnum = (c) => /[\p{L}\p{N}]/u.test(c);
const isCount = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const baseOf = (p) => p.slice(p.lastIndexOf('/') + 1);
const pad = (n) => String(n).padStart(2, '0');
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

function node(tag, cls, text) {
  const el = document.createElement(tag);
  el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

function setShown(el, on) {
  el.hidden = !on;
  el.style.display = on ? '' : 'none';
}

function icon(kind, size) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  const attrs = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2,
    'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' };
  for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, String(v));
  for (const [tag, props] of ICONS[kind]) {
    const part = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(props)) part.setAttribute(k, String(v));
    svg.append(part);
  }
  return svg;
}

// Two letters from the first two words, or the first two of a single word; « ? » when no letter or digit is usable.
export function initials(name) {
  const words = str(name).trim().split(/\s+/).filter(Boolean);
  const chars = (w) => Array.from(w).filter(isAlnum);
  let out = '';
  if (words.length > 1) out = (chars(words[0])[0] || '') + (chars(words[1])[0] || '');
  else if (words.length) out = chars(words[0]).slice(0, 2).join('');
  return out ? out.toLocaleUpperCase('fr') : '?';
}

// The one-line « where does this commit stand » text. `develop` / `origin/develop` are the labels' family names; no
// trunk name (a single view, or labels without one) means nothing to say, never a guess.
export function kickerFor(row, view, labels) {
  const local = name(labels && labels.local);
  const target = name(labels && labels.target);
  if (view === 'single' || !local || !row) return '';
  switch (row.seg) {
    case 'branch': return `à livrer dans ${local}`;
    case 'trunk-only':
      if (row.inLocal === true) return `dans ${local}, pas dans ta branche`;
      return target ? `sur ${target}, pas dans ta branche` : '';
    case 'incoming': return `sur GitLab, pas encore dans ton ${local} local`;
    case 'shared': return `déjà dans ${local}`;
    default: return '';
  }
}

function whenOf(iso) {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
  if (days === 0) return `auj. ${hm}`;
  if (days === 1) return `hier ${hm}`;
  const dm = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
  return d.getFullYear() === now.getFullYear() ? `${dm} ${hm}` : `${dm}/${d.getFullYear()} ${hm}`;
}

// null = counts unknown: a binary file, or a half-known pair; shown as « — » and kept out of the totals.
function countsOf(f) {
  if (f.binary === true || !isCount(f.add) || !isCount(f.del)) return null;
  return { add: Math.floor(f.add), del: Math.floor(f.del) };
}

function normalizeFiles(list) {
  const out = [];
  if (!Array.isArray(list)) return out;
  for (const f of list) {
    if (!f || typeof f.path !== 'string' || f.path === '') continue;
    out.push({ path: f.path, status: STATUSES.has(f.status) ? f.status : 'M', counts: countsOf(f) });
  }
  return out;
}

export function mountGitCommit(host, opts) {
  const { onFile, onCopy } = opts || {};
  let timer = null;

  const stopTimer = () => { if (timer !== null) { clearTimeout(timer); timer = null; } };

  function clear() {
    stopTimer();
    host.replaceChildren();
  }

  function copyButton(sha) {
    const btn = node('button', 'glog-copy');
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Copier le SHA');
    btn.title = 'Copier le SHA';
    btn.append(icon('copy', 12));
    btn.addEventListener('click', () => {
      if (typeof onCopy !== 'function' || onCopy(sha) === false) return;
      stopTimer();
      btn.dataset.copied = 'true';
      btn.replaceChildren(icon('check', 12));
      timer = setTimeout(() => {
        timer = null;
        delete btn.dataset.copied;
        btn.replaceChildren(icon('copy', 12));
      }, COPIED_MS);
    });
    return btn;
  }

  function fileButton(f) {
    const btn = node('button', 'glog-file');
    btn.type = 'button';
    btn.dataset.path = f.path;
    btn.title = f.path;
    const pill = node('span', 'dv-pill', f.status);
    pill.dataset.s = f.status;
    pill.dataset.st = f.status; // the shared pill palette of style.css reads data-st
    const stat = node('span', 'glog-file-stat');
    if (f.counts) stat.append(node('span', 'add', `+${f.counts.add}`), node('span', 'del', `${MINUS}${f.counts.del}`));
    else stat.textContent = '—';
    btn.append(pill, node('span', 'glog-file-name', baseOf(f.path)), stat);
    btn.addEventListener('click', () => {
      for (const b of host.querySelectorAll('button.glog-file[aria-current]')) b.removeAttribute('aria-current');
      btn.setAttribute('aria-current', 'true');
      if (typeof onFile === 'function') onFile(f.path);
    });
    return btn;
  }

  function filesBlock(files) {
    let add = 0;
    let del = 0;
    const groups = new Map();
    for (const f of files) {
      if (f.counts) { add += f.counts.add; del += f.counts.del; }
      const d = dirOf(f.path);
      if (!groups.has(d)) groups.set(d, []);
      groups.get(d).push(f);
    }
    const head = node('div', 'glog-files-head');
    head.append(node('span', 'glog-files-title', 'Fichiers modifiés'), node('span', 'glog-files-count', String(files.length)),
      node('span', 'glog-spacer'), node('span', 'glog-files-add', `+${add}`), node('span', 'glog-files-del', `${MINUS}${del}`));
    const out = [head];
    if (!groups.size) return out;
    const list = node('div', 'glog-files');
    for (const [dir, members] of groups) {
      const g = node('div', 'glog-dir');
      g.dataset.dir = dir;
      const gh = node('div', 'glog-dir-head');
      gh.append(icon('folder', 13), node('span', 'glog-dir-name', dir || ROOT_LABEL), node('span', 'glog-dir-count', String(members.length)));
      g.append(gh, ...members.map(fileButton));
      list.append(g);
    }
    out.push(list);
    return out;
  }

  function show(commit, row, labels) {
    clear();
    if (!commit || typeof commit !== 'object') return;
    const sha = str(commit.sha || (row && row.sha));
    if (!sha) return;
    const message = str(commit.message).trimEnd();
    const author = str(commit.author || (row && row.author));
    const date = str(commit.date || (row && row.date));
    const subject = str(row && row.subject) || message.split('\n')[0];

    const kicker = node('div', 'glog-kicker', kickerFor(row, labels && labels.view, labels));
    setShown(kicker, kicker.textContent !== '');
    const avatar = node('span', 'glog-avatar', initials(author));
    avatar.setAttribute('aria-hidden', 'true');
    const sep = node('span', 'glog-sep', '·');
    sep.setAttribute('aria-hidden', 'true');
    const when = node('span', 'glog-when', whenOf(date));
    when.title = date;
    setShown(when, when.textContent !== '');
    const shaFull = node('span', 'glog-sha-full', sha.slice(0, 7));
    shaFull.title = sha;
    const shaPill = node('span', 'glog-sha-pill');
    shaPill.append(shaFull, copyButton(sha));
    const meta = node('div', 'glog-meta');
    meta.append(avatar, node('span', 'glog-author-name', author), sep, when, node('span', 'glog-spacer'), shaPill);

    host.append(kicker, node('h2', 'glog-subject-full', subject), meta);
    if (message !== '') host.append(node('pre', 'glog-msg', message));
    host.append(...filesBlock(normalizeFiles(commit.files)));
  }

  return { show, clear };
}
