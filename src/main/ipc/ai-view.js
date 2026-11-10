// claude-deck — ipc/ai-view (v19): Claude AI mode — ONE lazy WebContentsView
// over the workspace area. Created on first entry, NEVER reloaded after that:
// mode switches only toggle native visibility + bounds. A native view ignores
// DOM display rules (it always draws above the page), so ai-hide must be
// explicit. partition 'persist:claudeai' keeps the login session across app
// restarts.
'use strict';

const { ipcMain, WebContentsView } = require('electron');
const { getWin } = require('../window');

// Overridable for probes (local test page) — same seam as CLAUDE_DECK_BIN.
const AI_URL = process.env.CLAUDE_DECK_AI_URL || 'https://claude.ai';
let aiView = null;
let aiLoads = 0; // observability: loadURL calls (the probe asserts exactly 1)

// Renderer-measured rect -> integer DIP bounds; reject anything degenerate.
// The renderer measures #ai-frame with getBoundingClientRect(), which returns
// CSS px in the main webContents' ZOOMED coordinate space. WebContentsView
// bounds are window DIP (zoom-independent — the native view is composited at the
// window level, NOT inside the zoomed page). So at zoom z a full-width frame
// measures contentWidth/z CSS px; multiply by z to restore DIP. Without this the
// native AI view is mis-sized/offset at any zoom != 1 (and the real app runs at
// the 1.2 default). At z == 1 this is a no-op.
// Shared with media-view.js: `seam` names the probe global that receives the
// last accepted rect (each view keeps its own).
function sanitizeBounds(b, seam = '__deckAiBounds') {
  if (!b || typeof b !== 'object') return null;
  const w = getWin();
  const z = w && !w.isDestroyed() ? w.webContents.getZoomFactor() : 1;
  const r = {
    x: Math.round(Number(b.x) * z),
    y: Math.round(Number(b.y) * z),
    width: Math.round(Number(b.width) * z),
    height: Math.round(Number(b.height) * z),
  };
  if (![r.x, r.y, r.width, r.height].every(Number.isFinite)) return null;
  if (r.width <= 0 || r.height <= 0) return null;
  global[seam] = r; // probe seam: assert the DIP conversion at zoom != 1
  return r;
}

// NOTE: the claude.ai panel CONTENT is deliberately kept at its NATIVE size,
// NOT the deck's zoom — claude.ai already renders at a good default, and
// stacking the deck zoom (1.2) on top reads too big. It is ACTIVELY pinned to
// factor 1.0 on dom-ready (see ensureAiView) — not merely left unset — because
// Chromium persists per-host zoom in the partition, so a factor an earlier
// build wrote there survives restarts until something overwrites it. Here only
// its BOUNDS are DIP-corrected so the native view fills the right area.

// Deck-skin (v21, re-verified 2026-07-10 recon): re-tint claude.ai's dark
// theme to the deck palette. The 2026-07 redesign added a NEW frame layer
// (« dframe ») that paints the page/sidebar/cards from --df-* tokens — the
// legacy --bg-000..500 scale still exists (now on [data-theme="claude"]
// [data-mode="dark"]) but no longer drives the outer surfaces, which is why
// the old skin went inert. Both generations are overridden below; all values
// are BARE HSL triplets exactly as claude.ai consumes them (hsl(var(--x)) /
// hsl(var(--x) / a)). Depth scales are preserved, only re-tinted to the deck
// blue-black ramp. NOT contractual: fail-soft by construction — renamed vars
// make the overrides inert and the native theme renders (nothing breaks).
const AI_SKIN_CSS = `
  /* Legacy token scale (inner content: chat area, cards, composer). */
  html[data-mode="dark"] {
    --bg-000: 219 18% 15% !important; /* deck surface-2 #1f242d */
    --bg-100: 215 21% 11% !important; /* deck surface   #161b22 */
    --bg-200: 216 25% 9%  !important;
    --bg-300: 216 28% 7%  !important; /* deck bg        #0d1117 */
    --bg-400: 214 28% 5%  !important;
    --bg-500: 214 28% 5%  !important;
  }
  /* dframe token scale (2026-07 frame: page bg, sidebar, cards, hovers).
     Captured live: --df-z0..z6 grays (3.9..65.1% lightness), --df-bg-page-hsl
     hardcoded 60 2% 10% on the web variant, --df-web-sidebar-bg derived via
     color-mix(page 91%, black). Same lightness ladder, deck-blue hue; the
     sidebar keeps deriving from the re-tinted page value. */
  html[data-mode="dark"] .dframe-root {
    --df-z0: 214 28% 5%  !important;
    --df-z1: 215 21% 11% !important; /* deck surface  #161b22 */
    --df-z2: 219 18% 15% !important; /* deck surface-2 #1f242d */
    --df-z3: 218 17% 20% !important;
    --df-z4: 218 15% 24% !important;
    --df-z5: 217 13% 32% !important;
    --df-z6: 215 15% 65% !important;
    --df-bg-page-hsl: 216 28% 7% !important; /* deck bg #0d1117 */
    --df-sidebar-bg: hsl(216 25% 9% / .92) !important;
  }
  /* Primitive warm-gray ramp (captured live 2026-07-10): hue 40-60, the source
     of EVERY remaining warm tint (inner cards, composer, borders, hovers — the
     dframe page tokens above derive from it too). Re-tinted per step: same
     lightness ladder, hue 216, deck-blue saturation curve. Components keep
     their relative depth; only the temperature changes. */
  :root {
    --_gray-10: 216 10% 99% !important; --_gray-20: 216 10% 97% !important;
    --_gray-30: 216 8% 96%  !important; --_gray-40: 216 8% 95%  !important;
    --_gray-50: 216 9% 93%  !important; --_gray-60: 216 9% 92%  !important;
    --_gray-70: 216 9% 91%  !important; --_gray-80: 216 8% 89%  !important;
    --_gray-90: 216 8% 88%  !important; --_gray-100: 216 9% 87% !important;
    --_gray-150: 216 8% 80% !important; --_gray-200: 216 7% 74% !important;
    --_gray-250: 216 6% 68% !important; --_gray-300: 216 5% 63% !important;
    --_gray-350: 216 4% 57% !important; --_gray-400: 216 3% 52% !important;
    --_gray-450: 216 3% 47% !important; --_gray-500: 216 3% 42% !important;
    --_gray-550: 216 4% 36% !important; --_gray-600: 216 5% 31% !important;
    --_gray-650: 217 8% 26% !important; --_gray-700: 218 12% 21% !important;
    --_gray-750: 219 16% 17% !important; --_gray-800: 215 21% 12% !important;
    --_gray-810: 215 21% 12% !important; --_gray-820: 215 21% 11% !important;
    --_gray-830: 216 24% 10% !important; --_gray-840: 216 25% 9% !important;
    --_gray-850: 216 27% 8% !important; --_gray-860: 216 28% 7% !important;
    --_gray-870: 216 28% 7% !important; --_gray-880: 215 28% 6% !important;
    --_gray-890: 214 28% 5% !important; --_gray-900: 214 28% 4% !important;
  }
  /* Safety net for surfaces not driven by either scale (e.g. login page). */
  html[data-mode="dark"], html[data-mode="dark"] body {
    background-color: #0d1117 !important;
  }
`;

// Sidebar hide (v72): claude.ai's v2 sidebar renders nav entries as <button>s
// keyed by TEXT, not routes (verified in the live recon: only /new stays an
// <a href>, everything else is a bare <button>), so the old CSS href selectors
// reach nothing. Match the visible label (deck locale + English) and hide via
// injected JS, re-applied on SPA re-renders by a debounced observer. Edit HIDE
// to change which entries disappear — the intent is the user's "chats only"
// view (keep Home/New/Recents/Pinned + conversations, drop the rest).
const AI_SIDEBAR_JS = `(() => {
  if (window.__deckSidebarHook) return; window.__deckSidebarHook = 1;
  window.__deckHiddenCount = 0; // recon-readable: proves the hide actually applied
  const HIDE = new Set(['projets', 'projects', 'artéfacts', 'artefacts', 'artifacts',
    'personnaliser', 'customize', 'code', 'design']);
  const HIDE_ARIA = ['obtenir des applications', 'get apps and extensions'];
  window.__deckHideSet = Array.from(HIDE); // recon-readable: drives the hide report
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
  const apply = () => {
    document.querySelectorAll('nav, aside, [class*="sidebar" i], [data-testid*="sidebar" i]').forEach((c) => {
      c.querySelectorAll('button, a').forEach((el) => {
        if (el.dataset.deckHidden) return;
        const label = norm(el.textContent);
        const aria = norm(el.getAttribute('aria-label'));
        if (HIDE.has(label) || HIDE.has(aria) || HIDE_ARIA.some((a) => aria.indexOf(a) !== -1)) {
          el.style.setProperty('display', 'none', 'important');
          el.dataset.deckHidden = '1';
          window.__deckHiddenCount += 1;
        }
      });
    });
  };
  apply();
  let t = 0;
  const obs = new MutationObserver(() => { clearTimeout(t); t = setTimeout(apply, 150); });
  try { obs.observe(document.body, { childList: true, subtree: true }); } catch (_) {}
  [300, 900, 2000, 5000].forEach((ms) => setTimeout(apply, ms)); // cover slow SPA hydration
})()`;

// Recon probe REMOVED (2026-07-10) — it served its purpose: the skin above was
// re-derived from a live DOM capture after the 2026-07 claude.ai redesign. If a
// future redesign breaks the skin again, resurrect the probe from git history
// (this file, v72): a dom-ready executeJavaScript that dumps html attrs + the
// CSS custom-property table (descend @layer via rule.cssRules recursion) +
// computed surface colors + a per-static-label hide report to os.tmpdir(),
// re-dumped every 20s. PRIVACY if resurrected: never capture sidebar item
// lists — conversation titles live there as hrefless <button>s.

function applyAiSidebarHook(wc) {
  wc.executeJavaScript(AI_SIDEBAR_JS, true).catch(() => { /* hide is a nicety — never break the view */ });
}

// v22 flash fix: the FIRST document paints its native warm theme before
// dom-ready + insertCSS land — so the first reveal is gated: ai-show before
// readiness only records the intent, and the first skin pass reveals the
// view already re-tinted. Later switches reveal instantly (aiReady stays
// true; the document persists).
let aiReady = false;       // first document skinned -> reveal is flash-free
let aiShowPending = false; // ai-show arrived before first-skin readiness

function ensureAiView() {
  if (aiView) return aiView;
  aiView = new WebContentsView({
    webPreferences: {
      partition: 'persist:claudeai', // durable cookies/storage -> stays logged in
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true, // remote content, no preload: full Chromium sandbox
    },
  });
  aiView.setBackgroundColor('#0d1117'); // deck bg, no white flash during load
  // A fresh View is VISIBLE by default — park it hidden so the first reveal
  // is gated by the skin pass below (otherwise the native theme flashes).
  aiView.setVisible(false);
  // insertCSS is per-document — dom-ready refires on every top-level
  // navigation (login flow -> app), re-applying the skin each time. SPA-
  // internal route changes keep the same document, so one shot covers them.
  const revealIfPending = () => {
    if (aiReady) return;
    aiReady = true;
    if (aiShowPending) { aiShowPending = false; aiView.setVisible(true); }
  };
  aiView.webContents.on('dom-ready', () => {
    // Pin claude.ai to its native 1.0 on EVERY document. The persist:claudeai
    // partition keeps per-host zoom across restarts, so a factor a previous
    // build matched onto this panel sticks even after that code is gone —
    // re-asserting native here overwrites and re-persists it (self-healing),
    // instead of inheriting the stale value. The in-session HostZoomMap updates
    // instantly (live fix this run); the on-disk prefs flush is lazy, but since
    // this runs on every load a half-flushed leftover self-corrects next launch.
    // Independent of the deck's zoom (separate webContents / origin).
    aiView.webContents.setZoomFactor(1);
    global.__deckAiZoom = aiView.webContents.getZoomFactor(); // probe seam
    aiView.webContents.insertCSS(AI_SKIN_CSS)
      .then(() => { global.__deckAiSkinInjects = (global.__deckAiSkinInjects || 0) + 1; })
      .catch(() => { /* skin is a nicety — never break the view over it */ })
      .finally(revealIfPending); // covers insertCSS failure too
    applyAiSidebarHook(aiView.webContents); // restore the chats-only sidebar (text-keyed buttons)
  });
  // Reveal fallback (review finding): a first load that never reaches
  // dom-ready (network error, abort) must NOT strand the view invisible —
  // reveal whatever rendered (Chromium error page) so the user sees WHY.
  aiView.webContents.on('did-fail-load', (_e, _code, _desc, _url, isMainFrame) => {
    if (isMainFrame) revealIfPending();
  });
  getWin().contentView.addChildView(aiView);
  aiLoads += 1;
  global.__deckAiLoads = aiLoads;
  global.__deckAiWC = aiView.webContents; // probe seam: assert native-zoom reset
  aiView.webContents.loadURL(AI_URL); // THE one load — never called again
  return aiView;
}

function registerAiViewIpc() {
  ipcMain.on('ai-show', (_e, bounds) => {
    const win = getWin();
    if (!win || win.isDestroyed()) return;
    const view = ensureAiView();
    const b = sanitizeBounds(bounds);
    if (b) view.setBounds(b);
    if (aiReady) view.setVisible(true);
    else aiShowPending = true; // revealed by the first dom-ready skin pass
  });

  ipcMain.on('ai-hide', () => {
    aiShowPending = false; // user left AI mode before the first paint
    if (aiView) aiView.setVisible(false);
  });

  // v22 escape hatch: claude.ai pages without the sidebar (e.g. /design) have
  // no way back inside the wrapper — the header back button routes here.
  ipcMain.on('ai-back', () => {
    if (aiView && aiView.webContents.navigationHistory.canGoBack()) {
      aiView.webContents.navigationHistory.goBack();
    }
  });

  // Bounds re-sync (window resize / workspace reflow while in AI mode).
  ipcMain.on('ai-bounds', (_e, bounds) => {
    const b = aiView ? sanitizeBounds(bounds) : null;
    if (b) aiView.setBounds(b);
  });
}

module.exports = { registerAiViewIpc, sanitizeBounds };
