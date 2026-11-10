// claude-deck — renderer/tui-prompt (v46): read the INTERACTIVE STATE of the
// claude TUI straight from the xterm buffer. Every blocking prompt claude
// code shows (tool permission, AskUserQuestion, plan approval, trust dialog,
// theme picker…) is a NUMBERED MENU with a ❯ selector — one parser covers
// them all, no per-prompt protocol. The chat view polls this while it is the
// visible face of the pane and renders the menu as clickable buttons; a
// click types the option NUMBER into the PTY exactly like the keyboard.
// PURE functions over an array of screen lines — probe-testable without a
// terminal (the probe seam exposes them on window.tuiPrompt).
'use strict';

// One menu option line: optional box border, optional ❯ selector, `N.` or
// `N)` then the label. The ❯ requirement lives at the RUN level (at least
// one line of the group must carry it) — that is what separates a real
// interactive menu from a numbered list in rendered prose.
const OPT_RE = /^\s*(❯\s*)?(\d{1,2})[.)]\s+(.*)$/;

// Pure frame / separator lines (box-drawing, rules) — never content.
const FRAME_RE = /^[\s─━│╭╮╰╯┌┐└┘├┤=_-]+$/;

// A horizontal RULE specifically (a frame line that actually carries a rule
// glyph, not e.g. an all-blank line, which also matches FRAME_RE) — shared
// by the composer-exclusion check inside parseTuiMenu below and by
// readComposerBox's composer detection (same rule/'❯ …'/rule shape).
const isRule = (l) => FRAME_RE.test(l) && /[─━]/.test(l);

// The composer's TOP rule. A named or resumed session's label is drawn INSIDE
// it (claude 2.1.293-2.1.295, real captures): a run of rule glyphs, a space,
// the label, a space, then rule glyph(s) — '──── Refactor du module billing ─'
// (62 glyphs before the label at 91 cols, 156 at 185). The label holds any
// characters and may be cut short ('…'). A pure rule stays a top rule. Used
// ONLY where the row ABOVE a '❯' row is tested (parseTuiMenu's composer
// exclusion, readComposerBox); the closing rule is never labeled and keeps
// isRule, as does every other use.
const LABELED_RULE_RE = /^\s*[─━]{3,} \S(?:.*\S)? [─━]+\s*$/;
const isComposerTopRule = (l) => isRule(l) || LABELED_RULE_RE.test(l);

// Strip the vertical box borders claude draws around prompts so OPT_RE and
// the question extraction see the inner text only.
function stripBox(s) {
  return s.replace(/^\s*[│┃]\s?/, '').replace(/\s*[│┃]\s*$/, '');
}

// AskUserQuestion (claude >= 2.x, options with previews) draws a PREVIEW
// PANEL — a box to the RIGHT of the option list, on the SAME rows. The xterm
// buffer returns the whole row, so without help the preview chrome bleeds
// into option labels ('Chooser a chaque clic | AUTO PAR EXTENSION (map
// editable)') and the box top border reads as a wide empty box. Detect the
// panel by an INTERIOR box corner (a top/bottom-LEFT corner that has real
// content to its left — the outer menu box of a boxed prompt sits flush-left
// with nothing before it, so it is excluded), then crop every row at the
// gutter (>=2 spaces) that precedes the panel's left rail. A single space
// before a glyph is ordinary label text, never a column rule — that is why
// >=2 is required. Light, heavy and double box styles are all covered so a
// theme change does not silently bring the bleed back.
//
// Accepted limitations (buffer-scraping a shared screen — POC scope):
//  - tall panel: if BOTH corners scroll out of the visible window no corner
//    is seen and the crop is skipped (small AskUserQuestion panels fit).
//  - detection is scoped to OPTION rows carrying a box CORNER (not a bare
//    rail) to the RIGHT of the label. This (a) ignores box-drawing in
//    SCROLLBACK — git/build trees, spinner recaps, markdown tables sit on
//    non-option rows — and (b) does not let a lone '|' inside a label flip the
//    crop on. Assumes the panel's top/bottom-left corner shares a row with an
//    option (true for claude's layout + the t12b capture); if a future layout
//    drew the corner ABOVE the options, detection would miss and the bleed
//    return — same failure class as the tall-panel case.
//  - first-match crop: an option label/desc that itself contains '>=2 spaces
//    then a box glyph' would be truncated there. claude's short option labels
//    do not, so this is theoretical; a column-anchored crop would need
//    pixel-aligned rails and is not worth it here.
const PREVIEW_BOX_LEFT = /\s{2,}[│┃║╭╰┌└┏┗╔╚]/;
const CORNER_G = /[╭╰┌└┏┗╔╚]/g; // top/bottom-LEFT box corners (light/heavy/double)
function hasPreviewPanel(rawLines) {
  return rawLines.some((l) => {
    if (!OPT_RE.test(stripBox(l))) return false; // a side panel hangs off an OPTION row
    CORNER_G.lastIndex = 0;
    let m;
    while ((m = CORNER_G.exec(l))) {
      if (l.slice(0, m.index).trim() !== '') return true; // a corner to the RIGHT of label text
    }
    return false;
  });
}
function cropPreview(s) {
  const m = PREVIEW_BOX_LEFT.exec(s);
  return m ? s.slice(0, m.index) : s;
}

// parseTuiMenu(rawLines) -> { question, options: [{ n, label, desc,
// selected }] } | null. Scans for runs of CONSECUTIVE numbered options
// starting at 1; keeps the LAST qualifying run (lowest on screen = the live
// prompt); requires a ❯ somewhere in the run and ≥2 options. Indented
// non-option lines inside a run are option descriptions / wrapped labels.
// COMPOSER EXCLUSION (real claude 2.1.281 captures, .scratch/fixtures/
// tui-2.1.281/): the composer is a row starting with '❯' whose row DIRECTLY
// ABOVE is a horizontal rule (plain, or carrying a named session's label, see
// isComposerTopRule) — claude always draws it rule / '❯ …' / rule
// (c1_idle, c2_busy_300ms, c2_idle_reply, c4_composer_numbered,
// c4_after_clear). A BLOCKING menu (a real tool-permission prompt or
// AskUserQuestion) replaces the composer entirely — c3_permission_prompt
// and c5_askuserquestion have no '❯' row directly under a rule — so when
// the chosen run exists and such a composer row sits at or below the run's
// first row, the run is stale scrollback, an echoed prompt, or unsent
// composer text, not a live menu: return null instead.
export function parseTuiMenu(rawLines) {
  const preview = hasPreviewPanel(rawLines);
  const lines = rawLines.map((l) => stripBox(preview ? cropPreview(l) : l));
  let best = null;
  let cur = null;
  const close = () => {
    if (cur && cur.sawSel && cur.opts.length >= 2 && cur.opts[0].n === 1) best = cur;
    cur = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = OPT_RE.exec(line);
    if (m) {
      const n = parseInt(m[2], 10);
      if (cur && n !== cur.opts[cur.opts.length - 1].n + 1) close();
      if (!cur) {
        if (n !== 1) continue; // menus start at 1 — mid-list prose is noise
        cur = { opts: [], sawSel: false, firstIdx: i };
      }
      cur.opts.push({ n, label: m[3].trim(), desc: '', selected: !!m[1] });
      if (m[1]) cur.sawSel = true;
      continue;
    }
    if (!cur) continue;
    const t = line.trim();
    if (!t || FRAME_RE.test(line)) {
      close(); // a blank or frame line ends the option block
    } else if (/^\s{3,}/.test(line)) {
      // indented continuation: option description or a wrapped long label
      const o = cur.opts[cur.opts.length - 1];
      o.desc = (o.desc ? o.desc + ' ' : '') + t;
    } else {
      close();
    }
  }
  close();
  if (!best) return null;
  // A visible composer (rule / '❯ …' / rule, see header comment) at or
  // below the run's first row means claude is not waiting on this menu.
  for (let i = best.firstIdx; i < lines.length; i++) {
    if (i > 0 && lines[i].trim().startsWith('❯') && isComposerTopRule(lines[i - 1])) return null;
  }
  // The question: up to 3 content lines right above the run (skip trailing
  // blanks, stop at the first blank after content or at a frame line).
  const q = [];
  for (let i = best.firstIdx - 1; i >= 0 && q.length < 3; i--) {
    const t = lines[i].trim();
    if (!t) {
      if (q.length) break;
      continue;
    }
    if (FRAME_RE.test(lines[i])) break;
    q.unshift(t);
  }
  return { question: q.join(' '), options: best.opts };
}

// detectTuiMode(rawLines) -> 'normal' | 'plan' | 'accept-edits' | 'bypass'
// | 'auto'. The permission-mode indicator claude renders near its input box
// (cycled with Shift+Tab: default → acceptEdits → plan → [bypass] → auto).
// Bottom-up over the last lines only: the indicator lives under the input,
// prose higher up must never match. Best effort — an unrecognized wording
// just reads 'normal'.
const MODE_RES = [
  [/bypass permissions on/i, 'bypass'],
  [/auto mode on/i, 'auto'],
  [/accept edits on/i, 'accept-edits'],
  [/plan mode on/i, 'plan'],
];
// The last N CONTENT lines of the screen. Counting RAW lines under-reaches
// badly (capture-replay finding): the TUI separates every footer line with
// a blank row, so a tall statusline (model · context · drifts · effort…)
// alone can eat a raw window and push the spinner/mode footer out of it.
function tailContent(rawLines, n) {
  let end = rawLines.length;
  while (end > 0 && !rawLines[end - 1].trim()) end--;
  const out = [];
  for (let i = end - 1; i >= 0 && out.length < n; i--) {
    if (rawLines[i].trim()) out.unshift(rawLines[i]);
  }
  return out;
}

export function detectTuiMode(rawLines) {
  const tail = tailContent(rawLines, 12);
  for (let i = tail.length - 1; i >= 0; i--) {
    for (const [re, mode] of MODE_RES) {
      if (re.test(tail[i])) return mode;
    }
  }
  return 'normal';
}

// detectTuiBusy(rawLines) -> boolean. The spinner line claude renders for
// as long as it ACTUALLY runs is the one liveness signal that needs no
// hook and survives traceless interrupts (a stop before the first token
// writes NO transcript marker and fires NO Stop hook; the status file lies
// 'working' until the fossil guard). TWO wordings exist (v46.4, verified
// against a live pty capture of 2.1.167 — /tmp/tui-capture2.raw):
//   • older TUIs: '… (esc to interrupt)'
//   • 2.1.167:    '✳ <dynamic verb>… (6s · ↓ 237 tokens)' / '(3s ·
//     thinking with xhigh effort)' — no esc hint at all; the '(Ns ·'
//     LIVE COUNTER is the stable, locale-free part. The idle footer
//     ('◉ xhigh · /effort') has the · but never the '(Ns' prefix.
// Same bottom-anchored window as the mode detector.
// NOTE (capture-replay finding): the spinner GLYPH alone is NOT a busy
// signal — at rest 2.1.167 leaves a recap line '✻ Brewed for 8s' above the
// prompt, same glyph, no live counter. The '(Ns ·' parenthesized counter is
// what distinguishes RUNNING from done; never match on the glyph.
const BUSY_HINT_RES = [
  /esc to interrupt/i,
  /\((?:\d+h\s?)?(?:\d+m\s?)?\d+s\s?·/,
];
export function detectTuiBusy(rawLines) {
  const tail = tailContent(rawLines, 15);
  return tail.some((l) => BUSY_HINT_RES.some((re) => re.test(l)));
}

// detectMenuNav(rawLines) -> 'number' | 'arrows'. WHICH KEY selects an option
// in the on-screen menu. Number-shortcut menus (tool-permission gates, plan
// approval) accept the digit directly — typing '1' picks option 1, proven
// against a live permission capture (probe t5). AskUserQuestion (claude >= 2.x)
// is a DIFFERENT widget: navigated with ↑/↓ and committed with Enter; the
// digit is NOT bound. Its footer advertises exactly that — 'Enter to select ·
// ↑/↓ to navigate · n to add notes · Esc to cancel' (t12b live capture), no
// number. Typing the number there does nothing — the « clic ne fait rien » repro.
//
// We read the FOOTER REGION only (tailContent), NOT the whole buffer. Scanning
// every line would let incidental prose misroute a digit-only menu to 'arrows'
// — e.g. an Edit-permission gate showing a DIFF OF THIS FILE (which now holds
// the hint words 'to navigate' / 'enter to select') would match, and a bare
// Enter on a number-only gate commits its DEFAULT option (often « Yes »): a
// silent wrong approval. The footer sits flush at screen bottom; a permission
// gate's diff sits above its question/options, so the last few content lines
// never carry it. (Attacker FMEA #1.)
//
// multiSelect AskUserQuestion toggles with Space and SUBMITS with Enter, so an
// auto-Enter would commit an empty/wrong set — strictly worse than the old
// no-op. Those footers read 'space to (de)select' / 'enter to confirm'; route
// them to the safe digit path (harmless no-op), never arrow-commit. (Attacker #4.)
//
// Known limitation: the hint words are English — a localized footer would
// revert to the original no-op (not a wrong commit). Screen-truth over the
// open-tools ledger by choice: footer covers every arrow-widget, and a stale
// ledger entry would risk the dangerous number->arrows misroute above.
const ARROW_NAV_RE = /to navigate|enter to select|to add notes/i;
const MULTI_SELECT_RE = /space to|to toggle|enter to confirm/i;
export function detectMenuNav(rawLines) {
  const tail = tailContent(rawLines, 6); // footer region only — see note above
  if (tail.some((l) => MULTI_SELECT_RE.test(l))) return 'number'; // never auto-commit a multiSelect
  return tail.some((l) => ARROW_NAV_RE.test(l)) ? 'arrows' : 'number';
}

// bottomTerminalRows(term) -> string[]. The last `term.rows` CONTENT rows of
// the active xterm buffer, translated to plain text — the one screen window
// readTui and readComposerBox both scrape (composer + menu + busy/mode
// footer all live in it; never a second buffer walk).
function bottomTerminalRows(term) {
  const buf = term.buffer.active;
  const lines = [];
  const start = Math.max(0, buf.length - term.rows);
  for (let i = start; i < buf.length; i++) {
    const line = buf.getLine(i);
    lines.push(line ? line.translateToString(true) : '');
  }
  return lines;
}

// readTui(term) -> { menu, mode, busy } from the VISIBLE screen (the last
// rows of the active buffer — claude renders prompts at the cursor, bottom
// of the scroll). One buffer walk feeds all three detectors.
export function readTui(term) {
  const lines = bottomTerminalRows(term);
  return {
    menu: parseTuiMenu(lines), mode: detectTuiMode(lines),
    busy: detectTuiBusy(lines), nav: detectMenuNav(lines),
  };
}

// readComposerBox(term) -> { visible, text }. Read-only scrape of the
// composer input box for the stuck-send safety net (send-single-write spec,
// Amendment Re-open 2, R2): the BOTTOM-MOST row whose trimmed text starts
// with '❯' AND whose row directly above is a top rule (plain or labeled with
// the session name, isComposerTopRule) — same rule/'❯ …'/rule shape as the
// composer-exclusion check inside parseTuiMenu above and its header comment.
// The closing rule below stays a plain rule (isRule). Box text is that row
// (leading '❯' stripped) plus every following row up to (excluding) the next
// rule row, each trimmed and joined with '\n'. Fail-closed (R7): no such row,
// or no closing rule found below it before the bottom of the scraped window,
// returns { visible: false, text: '' } — never a guess.
//
// Idle placeholder: before the composer is ever used, claude renders a
// rotating hint INSIDE the box itself ('❯ Try "fix lint errors"' — real
// capture, .scratch/fixtures/tui-2.1.281/c1_idle) — text-identical to real
// typed content once scraped to a plain string (no styling survives
// term.buffer's translateToString). It is always a single line shaped
// exactly `Try "…"`; treating that shape as empty when it is the box's only
// line is a deliberate, accepted false negative (a real message that is
// itself exactly `Try "…"` reads as empty) — it never turns real content
// into a false positive, so it stays inside R7's fail-closed direction.
const IDLE_HINT_RE = /^Try ".+"$/;
export function readComposerBox(term) {
  const lines = bottomTerminalRows(term);
  let idx = -1;
  for (let i = lines.length - 1; i > 0; i--) {
    if (lines[i].trim().startsWith('❯') && isComposerTopRule(lines[i - 1])) { idx = i; break; }
  }
  if (idx === -1) return { visible: false, text: '' };
  let end = -1;
  for (let i = idx + 1; i < lines.length; i++) {
    if (isRule(lines[i])) { end = i; break; }
  }
  if (end === -1) return { visible: false, text: '' }; // no closing rule below — fail closed
  const first = lines[idx].trim().replace(/^❯\s?/, '');
  const rest = [];
  for (let i = idx + 1; i < end; i++) rest.push(lines[i].trim());
  if (rest.length === 0 && IDLE_HINT_RE.test(first)) return { visible: true, text: '' };
  return { visible: true, text: [first, ...rest].join('\n') };
}
