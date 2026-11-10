'use strict';
// Privileged `deckpage:` scheme: main serves a page the renderer handed over under its OWN CSP,
// because a srcdoc / data: / blob: frame inherits the Deck's policy (no inline script runs there).
// Three slots (the three viewers that can show a page at once: Files, Plans, a plugin report), a fresh token per serve: the
// replaced token answers 404 and its bytes are released. Requires electron + node:crypto only.
// The `files` and `plans` slots are served with a small selection relay injected (see withSelectRelay).
// The `plugin` slot is served with its meta tags made inert, a constant dark theme attribute on <html> and a no-script CSP header.

const crypto = require('node:crypto');
const { app, protocol, session } = require('electron');

const SCHEME = 'deckpage';
const PAGE_URL_PREFIX = `${SCHEME}://`;
const PAGE_HOST = 'page';
const SLOTS = ['files', 'plans', 'plugin'];
const RELAY_SLOTS = ['files', 'plans'];
const PLUGIN_SLOT = 'plugin';
const MAX_BYTES = 1024 * 1024; // the readers' own cap
const SELECT_CAP_BYTES = 20 * 1024; // code-ask's MAX_BYTES, on the UTF-8 length
const PAGE_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data:; base-uri 'none'; form-action 'none'";

// A plugin report never runs script in the Deck: its own CSP meta is gone, this header replaces it.
const PLUGIN_PAGE_CSP = PAGE_CSP.replace("script-src 'unsafe-inline'", "script-src 'none'");

const store = new Map(); // slot -> { token, html }

// Runs INSIDE the served page (serialised with toString): posts the page selection and every press to the
// parent, whose origin is opaque to the frame, hence the '*' target. No comments in the body: they ship.
function selectRelay(cap) {
  var parent = window.parent;
  if (!parent || parent === window) return;
  var post = parent.postMessage.bind(parent);
  var encoder = new TextEncoder();
  var last = JSON.stringify({ type: 'deck-page-select', text: '', rect: null });
  var timer = 0;
  function size(s) { return encoder.encode(s).length; }
  function clip(s) {
    if (s.length > cap) s = s.slice(0, cap);
    if (size(s) <= cap) return s;
    var lo = 0, hi = s.length;
    while (lo < hi) {
      var mid = (lo + hi + 1) >> 1;
      if (size(s.slice(0, mid)) <= cap) lo = mid; else hi = mid - 1;
    }
    var c = s.charCodeAt(lo - 1);
    return s.slice(0, c >= 0xD800 && c <= 0xDBFF ? lo - 1 : lo);
  }
  function snapshot() {
    var sel = window.getSelection();
    var text = sel && !sel.isCollapsed ? sel.toString() : '';
    if (!text.trim()) return { type: 'deck-page-select', text: '', rect: null };
    var r = sel.getRangeAt(0).getBoundingClientRect();
    return { type: 'deck-page-select', text: clip(text), rect: { left: r.left, top: r.top, width: r.width, height: r.height } };
  }
  function flush() {
    timer = 0;
    var msg = snapshot();
    var key = JSON.stringify(msg);
    if (key === last) return;
    last = key;
    post(msg, '*');
  }
  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, 120);
  }
  document.addEventListener('selectionchange', schedule);
  window.addEventListener('scroll', schedule, true);
  window.addEventListener('pointerdown', function () { post({ type: 'deck-page-pointerdown' }, '*'); }, true);
}

const RELAY_SCRIPT = `<script>(${selectRelay.toString()})(${SELECT_CAP_BYTES})</script>`;
// Every scan on this path is linear (untrusted 1 MiB page, synchronous in main): sticky regexes, one attempt per start,
// no nested quantifier, fixed-width lookaheads. Before a doctype the parser skips whitespace, comments (`<!-->`,
// `<!--->`, `--!>` closes) and bogus comments up to the first `>`: `<?…>`, `<!` + not `--` / doctype, `</` + not a
// letter. Every alternative consumes at least one character, so the loop below always advances.
const PROLOG_ITEM_RE = /\s+|<!---?>|<!--[\s\S]*?--!?>|<\?[^>]*>|<!(?!--)(?![dD][oO][cC][tT][yY][pP][eE])[^>]*>|<\/(?![A-Za-z])[^>]*>/y;
const DOCTYPE_AT_RE = /<!doctype[^>]*>/iy;
// Whitespace, an optional <html…> start tag with its trailing whitespace, then a <head…> start tag, all at `lastIndex`.
const HEAD_AT_RE = /\s*(?:<html(?:\s[^>]*)?>\s*)?<head(?:\s[^>]*)?>/iy;

// Pure. End of a doctype that starts the document (only whitespace, comments and bogus comments before it), else 0.
function doctypeEnd(html) {
  let i = 0;
  for (;;) {
    PROLOG_ITEM_RE.lastIndex = i;
    if (!PROLOG_ITEM_RE.exec(html)) break;
    i = PROLOG_ITEM_RE.lastIndex;
  }
  DOCTYPE_AT_RE.lastIndex = i;
  return DOCTYPE_AT_RE.exec(html) ? DOCTYPE_AT_RE.lastIndex : 0;
}

// Pure. One inline script after the doctype at the document start (else at 0), moved after the <head…> start tag only
// when nothing but whitespace and an <html…> start tag sit between (one sticky match at `from`, no search): a "<head>"
// text further on (title, style, textarea, an attribute, a script) is not a tag. Never before a doctype (quirks mode),
// always ahead of page scripts.
function withSelectRelay(html) {
  const from = doctypeEnd(html);
  HEAD_AT_RE.lastIndex = from;
  const at = HEAD_AT_RE.exec(html) ? HEAD_AT_RE.lastIndex : from;
  return html.slice(0, at) + RELAY_SCRIPT + html.slice(at);
}

// Electron refuses to privilege a scheme once the app is ready: the app loads main.js before ready;
// a harness that loads it later gets no privileged scheme (and one log line) instead of a crash.
function registerPageScheme() {
  if (app.isReady()) {
    console.warn(`[page-scheme] loaded after app ready: ${SCHEME}: not privileged`);
    return;
  }
  protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true } }]);
}

const META_OPEN_RE = /<meta(?=[\s/>])/gi;
const HTML_OPEN_RE = /<html(?=[\s/>])/i;

// Pure. Every `<meta` opener becomes the void `<link data-deck-meta`: the rewrite targets the tag name
// (never entity-decoded), so no spelling of http-equiv=refresh survives whatever the attributes hold.
function neutralizeMeta(html) {
  return html.replace(META_OPEN_RE, '<link data-deck-meta');
}

// Pure. The theme goes on the first <html …> after the doctype that starts the document (doctypeEnd), else a new
// <html> opens after that doctype (at 0 without one). Only the two known themes reach the attribute.
function withTheme(html, theme) {
  const attr = ` data-deck-theme="${theme === 'dark' ? 'dark' : 'light'}"`;
  const from = doctypeEnd(html);
  const tag = HTML_OPEN_RE.exec(html.slice(from));
  if (tag) {
    const at = from + tag.index + tag[0].length;
    return html.slice(0, at) + attr + html.slice(at);
  }
  return `${html.slice(0, from)}<html${attr}>${html.slice(from)}`;
}

function putPage(slot, html) {
  if (!SLOTS.includes(slot)) return { ok: false, error: 'badSlot' };
  if (typeof html !== 'string') return { ok: false, error: 'badHtml' };
  if (Buffer.byteLength(html, 'utf8') > MAX_BYTES) return { ok: false, error: 'tooLarge' };
  const token = crypto.randomUUID();
  store.set(slot, { token, html });
  return { ok: true, url: `${PAGE_URL_PREFIX}${PAGE_HOST}/${token}` };
}

function getPage(token) {
  for (const [slot, entry] of store) if (entry.token === token) return { slot, html: entry.html };
  return null;
}

// The stored page behind a deckpage: URL, or null (other scheme or host, malformed, replaced or unknown token).
function pageOfUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === `${SCHEME}:` && u.host === PAGE_HOST ? getPage(u.pathname.slice(1)) : null;
  } catch (_) { return null; }
}

function slotOfUrl(url) {
  const page = pageOfUrl(url);
  return page === null ? null : page.slot;
}

// After app ready (protocol.handle), before the window loads.
function startPageProtocol() {
  // Closed frame: sub-frame checks and frame-less checks (fileSystem, workers) are denied; checks carrying the Deck main frame keep Electron's default (a sub-frame request is denied too).
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => callback(details.isMainFrame !== false));
  session.defaultSession.setPermissionCheckHandler((wc, permission, origin, details) => details.isMainFrame !== false);
  protocol.handle(SCHEME, (request) => {
    const page = pageOfUrl(request.url);
    if (page === null) return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    const plugin = page.slot === PLUGIN_SLOT;
    let body = page.html;
    // Always dark, a constant: reports already stored under <userData>/plugin-data/<id>/reports (kept up to 30 days)
    // and an installed copy not yet re-imported may still carry light styles keyed on the attribute; a dark-only
    // report ignores it.
    if (plugin) body = withTheme(neutralizeMeta(body), 'dark');
    else if (RELAY_SLOTS.includes(page.slot)) body = withSelectRelay(body);
    return new Response(body, {
      headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': plugin ? PLUGIN_PAGE_CSP : PAGE_CSP },
    });
  });
}

module.exports = { registerPageScheme, startPageProtocol, putPage, slotOfUrl, withSelectRelay, neutralizeMeta, withTheme, PAGE_URL_PREFIX };
