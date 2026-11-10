// Shared loaders (deck-loading-states): the Git / MR animated loader as pure factories.
// Leaf module: no import, no state. DOM built with createElement only, every element aria-hidden;
// the caller inserts the node when a wait starts and removes it on its own settle paths.
// Looks come from CSS: .gp-skeleton and .mr-progress (existing rules), .ld-inline and .ld-shimmer.

function node(tag, cls) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  el.setAttribute('aria-hidden', 'true');
  return el;
}

// Placeholder rows for a first load with nothing to show yet.
export function skeleton(rows = 4) {
  const s = node('div', 'gp-skeleton');
  for (let n = 0; n < rows; n++) s.append(node('i', ''));
  return s;
}

// Sliding strip on top of a host that already holds content (user-started refresh).
export function progressBar() {
  return node('div', 'mr-progress');
}

// Short track placed inline after a wait text or inside a button.
export function inlineBar() {
  return node('span', 'mr-progress ld-inline');
}

// Block placeholder of any shape with the skeleton sweep; `cls` carries the size and shape.
export function shimmer(cls) {
  return node('div', cls ? `ld-shimmer ${cls}` : 'ld-shimmer');
}
