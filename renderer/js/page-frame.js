// claude-deck — renderer/page-frame: shows an untrusted HTML page that holds script in a CLOSED frame. Main serves
// the bytes under deckpage:// with their own CSP; sandbox="allow-scripts" without allow-same-origin gives the page an
// opaque origin, so it reaches neither the Deck document nor window.api. No import: any viewer can use it.
'use strict';

const SELECT_TYPE = 'deck-page-select';
const POINTERDOWN_TYPE = 'deck-page-pointerdown';
const SELECT_MAX_BYTES = 20 * 1024; // same cap as code-ask's MAX_BYTES, on the UTF-8 length
const SELECT_MIN_GAP_MS = 100; // the served relay debounces at 120 ms: a faster sender is not the relay

// A script page: a `script` element, or an inline event handler (any on* attribute) on any element.
export function pageHasScript(doc) {
  if (doc.querySelector('script')) return true;
  for (const node of doc.querySelectorAll('*')) {
    for (const attr of node.attributes) if (/^on/i.test(attr.name)) return true;
  }
  return false;
}

// `text` cut to `max` UTF-8 bytes on a character boundary. A string of max UTF-16 units already weighs at least max bytes.
function capUtf8(text, max) {
  const bytes = new TextEncoder().encode(text.length > max ? text.slice(0, max) : text);
  if (text.length <= max && bytes.length <= max) return text;
  let cut = Math.min(max, bytes.length);
  while (cut > 0 && cut < bytes.length && (bytes[cut] & 0xC0) === 0x80) cut--;
  return new TextDecoder().decode(bytes.subarray(0, cut));
}

// The page's rect (frame-viewport coords) clamped into the frame box, then moved to Deck viewport coords; null if malformed.
function deckRect(r, frame) {
  if (!r || typeof r !== 'object') return null;
  const { left, top, width, height } = r;
  if (![left, top, width, height].every((n) => Number.isFinite(n)) || width < 0 || height < 0) return null;
  const f = frame.getBoundingClientRect();
  const fit = (v, max) => Math.min(Math.max(v, 0), max);
  const x0 = fit(left, f.width);
  const x1 = fit(left + width, f.width);
  const y0 = fit(top, f.height);
  const y1 = fit(top + height, f.height);
  return { left: f.left + x0, top: f.top + y0, width: x1 - x0, height: y1 - y0 };
}

// One window listener per mount. The only identity check is e.source: the frame's origin is opaque, so e.origin is "null".
// A press carries no payload: it reaches onPointerDown at once, outside the selection rate limit.
function listenToFrame(frame, isCurrent, onSelect, onPointerDown) {
  let last = 0;
  let timer = 0;
  let pending = null;
  const stop = () => { clearTimeout(timer); window.removeEventListener('message', onMessage); };
  const deliver = () => {
    const m = pending;
    pending = null;
    timer = 0;
    if (!m) return;
    if (!frame.isConnected) { stop(); return; }
    last = Date.now();
    onSelect(m);
  };
  function onMessage(e) {
    if (!frame.isConnected) { stop(); return; }
    if (!e.source || e.source !== frame.contentWindow || !isCurrent()) return;
    const d = e.data;
    if (!d || typeof d !== 'object') return;
    if (d.type === POINTERDOWN_TYPE) { if (onPointerDown) onPointerDown(); return; }
    if (!onSelect || d.type !== SELECT_TYPE || typeof d.text !== 'string') return;
    const text = capUtf8(d.text, SELECT_MAX_BYTES);
    pending = { text, rect: text ? deckRect(d.rect, frame) : null };
    if (timer) return; // a delivery is already queued: the latest message replaces its payload
    const wait = SELECT_MIN_GAP_MS - (Date.now() - last);
    if (wait <= 0) deliver();
    else timer = setTimeout(deliver, wait);
  }
  window.addEventListener('message', onMessage);
}

// Serves `html` in `slot` and mounts the closed frame in `container`. Resolves null when `isCurrent()` is false once
// main has answered (the view moved on: nothing is mounted), false when main refuses or the call fails, true once mounted.
// `onSelect({text, rect})`, when a function, receives the selection the page's own script reports (rect in Deck viewport
// coords, null when absent or malformed; empty text = selection gone).
// `onPointerDown()`, when a function, is called at once for each press the page reports inside the frame.
// `onFrame(frame)`, when a function, runs once the frame is built and before it is attached (a caller prepares its reveal there).
export async function mountClosedFrame(container, html, slot, { title, isCurrent, onSelect, onPointerDown, onFrame }) {
  let res = null;
  try { res = await window.api.pageServe(slot, html); } catch { /* a rejected call is a refusal */ }
  if (!isCurrent()) return null;
  if (!res || !res.ok || !res.url) return false;
  const frame = document.createElement('iframe');
  frame.className = 'fp-frame';
  frame.setAttribute('sandbox', 'allow-scripts'); // never allow-same-origin: the page would reach the Deck
  frame.title = title;
  frame.src = res.url;
  if (typeof onFrame === 'function') onFrame(frame);
  container.replaceChildren(frame);
  const select = typeof onSelect === 'function' ? onSelect : null;
  const press = typeof onPointerDown === 'function' ? onPointerDown : null;
  if (select || press) listenToFrame(frame, isCurrent, select, press);
  return true;
}
