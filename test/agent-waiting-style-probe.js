// test/agent-waiting-style-probe.js — K7 (agent lifecycle, lot L7): the « en attente » visual.
// A sub-agent whose run ended its turn with background work of its own still open is WAITING: it must
// stay animated (the user reads session state from live motion) but read distinctly from RUNNING, and a
// finished row stays static. One fixture element per K7 class is injected into the REAL app document
// (real renderer/style.css), then computed styles are read back:
//   .agent-row[data-state="waiting"]  (the real DOM of sidebar.js: .session-agents > ul > li > button.agent-row[data-state])
//   .ctk-row.ctk-waiting
//   .ct-waiting (on the .chat-tool card)
//   w0  instrument: the running baselines are animated by the shipped rules (status-pulse 1.6s, ct-pulse 1.1s)
//   w1  sidebar dot, real DOM: animated, infinite, duration differs from running, static look differs (ring vs fill)
//   w2  sidebar dot, a second row built as sidebar.js builds it (toggle + ul + li + button.agent-row[data-state]): same
//       animated ring look as w1, and no `.session-agents li[data-state=…]` selector is left in style.css (data-state is on the button)
//   w3  roster name: animated, infinite, duration differs from running, colour differs
//   w4  card icon: animated, infinite, duration differs from running
//   w5  live: every waiting node owns a running Web Animation with infinite iterations
//   w6  a finished row stays static (roster name, sidebar dot)
//   w7  every keyframe the waiting nodes use animates opacity / transform only (compositor, style.css source)
//   w8  prefers-reduced-motion (CDP emulation): animated before, no animation at all under reduce
//   w9  no left accent bar (symmetric borders, no shadow on roster row / card) and the ground is untouched
//       (waiting background === running background)
// Run (xvfb, never a visible window), from the worktree root:
//   env -u WAYLAND_DISPLAY XDG_SESSION_TYPE=x11 GDK_BACKEND=x11 CLAUDE_DECK_PRICES_URL=http://127.0.0.1:1 \
//     CLAUDE_DECK_COMMANDS_URL=http://127.0.0.1:1 CLAUDE_DECK_PLUGINS_DIR=$(mktemp -d) CLAUDE_DECK_ASK_DIR=$(mktemp -d) \
//     CLAUDE_DECK_STATUS_DIR=$(mktemp -d) xvfb-run -a timeout 180 node_modules/.bin/electron test/agent-waiting-style-probe.js
// Env: WAITING_REPO=<tree> boots and reads another tree (mutant runs).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const mk = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const FAKE_HOME = mk('deck-waiting-style-home-');
process.env.HOME = FAKE_HOME;
const PROJECTS = path.join(FAKE_HOME, '.claude', 'projects');
fs.mkdirSync(path.join(FAKE_HOME, 'Documents', 'workspace'), { recursive: true });
fs.mkdirSync(PROJECTS, { recursive: true });
fs.mkdirSync(path.join(FAKE_HOME, '.claude', 'deck-status'), { recursive: true });

// Containment seams (the CENV prefix sets them; defaults keep a bare run isolated too).
const seam = (k, v) => { if (!process.env[k]) process.env[k] = v; };
seam('CLAUDE_DECK_PRICES_URL', 'http://127.0.0.1:1');
seam('CLAUDE_DECK_COMMANDS_URL', 'http://127.0.0.1:1');
seam('CLAUDE_DECK_PLUGINS_DIR', mk('deck-waiting-style-plugins-'));
seam('CLAUDE_DECK_ASK_DIR', mk('deck-waiting-style-ask-'));
seam('CLAUDE_DECK_STATUS_DIR', mk('deck-waiting-style-status-'));
process.env.CLAUDE_DECK_PROJECTS_DIR = PROJECTS;
process.env.CLAUDE_DECK_BIN = '/bin/bash';
process.env.CLAUDE_DECK_AI_URL = 'about:blank';
process.env.CLAUDE_DECK_NO_OPEN = '1';

const REPO = process.env.WAITING_REPO ? path.resolve(process.env.WAITING_REPO) : path.join(__dirname, '..');
require(path.join(REPO, 'main.js'));
const { app, BrowserWindow } = require('electron');
app.setPath('userData', mk('deck-waiting-style-ud-'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
let failed = 0;
function gate(id, ok, detail) {
  results.push(`${ok ? 'PASS' : 'FAIL'} ${id} — ${detail}`);
  if (!ok) failed++;
}

// Names of the properties a @keyframes rule animates, read from the style.css source.
function keyframeProps(css, name) {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const m = new RegExp('@keyframes\\s+' + name + '\\s*\\{').exec(src);
  if (!m) return null;
  let depth = 1;
  let i = m.index + m[0].length;
  const start = i;
  while (i < src.length && depth > 0) {
    const ch = src[i++];
    if (ch === '{') depth++; else if (ch === '}') depth--;
  }
  const props = new Set();
  for (const blk of src.slice(start, i - 1).matchAll(/\{([^}]*)\}/g)) {
    for (const d of blk[1].split(';')) { const p = d.split(':')[0].trim(); if (p) props.add(p); }
  }
  return [...props];
}

const FIXTURE = `
<div id="w-fixture" style="position:fixed;top:0;left:0;width:300px;z-index:99999">
  <div class="session-agents">
    <ul class="agents-list">
      <li><button type="button" class="agent-row" data-state="running" id="sa-run"><span class="agent-dot"></span><span class="sa-type">run</span></button></li>
      <li><button type="button" class="agent-row" data-state="waiting" id="sa-wait"><span class="agent-dot"></span><span class="sa-type">wait</span></button></li>
      <li><button type="button" class="agent-row" data-state="done" id="sa-done"><span class="agent-dot"></span><span class="sa-type">done</span></button></li>
    </ul>
  </div>
  <div class="session-agents" id="sa-real2">
    <button type="button" class="agents-toggle" aria-expanded="true"><span class="sa-header-text">1 agent en attente</span></button>
    <ul class="agents-list">
      <li><button type="button" class="agent-row" data-state="waiting" data-tool-use-id="toolu_w2" id="sa-wait2"><span class="agent-dot" aria-hidden="true"></span><span class="sa-type">wait-real</span><span class="sa-status">en attente</span></button></li>
    </ul>
  </div>
  <div class="ctk-row" id="ck-run"><span class="ctk-name">run</span><span class="ctk-state">working</span></div>
  <div class="ctk-row ctk-waiting" id="ck-wait"><span class="ctk-name">wait</span><span class="ctk-state">en attente</span></div>
  <div class="ctk-row ctk-done" id="ck-done"><span class="ctk-name">done</span><span class="ctk-state">terminé</span></div>
  <div class="chat-tool" data-status="running" id="ct-run"><div class="chat-tool-head"><span class="ct-ico">x</span><span class="ct-name">run</span></div></div>
  <div class="chat-tool ct-waiting" data-status="running" id="ct-wait"><div class="chat-tool-head"><span class="ct-ico">x</span><span class="ct-name">wait</span></div></div>
</div>`;

const SEL = {
  saRunDot: '#sa-run .agent-dot', saWaitDot: '#sa-wait .agent-dot', saWait2Dot: '#sa-wait2 .agent-dot',
  saDoneDot: '#sa-done .agent-dot', saRunRow: '#sa-run', saWaitRow: '#sa-wait',
  ckRunName: '#ck-run .ctk-name', ckWaitName: '#ck-wait .ctk-name', ckDoneName: '#ck-done .ctk-name',
  ckRunRow: '#ck-run', ckWaitRow: '#ck-wait',
  ctRunIco: '#ct-run .ct-ico', ctWaitIco: '#ct-wait .ct-ico', ctRunCard: '#ct-run', ctWaitCard: '#ct-wait',
};
const READ = `(() => {
  const out = {};
  for (const [k, sel] of Object.entries(${JSON.stringify(SEL)})) {
    const el = document.querySelector(sel);
    if (!el) { out[k] = null; continue; }
    const c = getComputedStyle(el);
    const pb = getComputedStyle(el, '::before');
    const pa = getComputedStyle(el, '::after');
    // The animated node is the element itself, else its Halo pseudo-element (glow breathing on ::before, ripple ring on ::after).
    const lead = c.animationName !== 'none' ? c : (pb.animationName !== 'none' ? pb : pa);
    out[k] = { name: lead.animationName, dur: lead.animationDuration, iter: lead.animationIterationCount,
      bg: c.backgroundColor, shadow: c.boxShadow, sh: [c.boxShadow, pa.boxShadow, pa.backgroundColor].join('|'), color: c.color, bl: c.borderLeftWidth, br: c.borderRightWidth,
      anims: el.getAnimations({ subtree: true }).map((a) => ({ state: a.playState, iter: String(a.effect.getComputedTiming().iterations) })) };
  }
  return out;
})()`;

const animated = (x) => !!x && x.name !== 'none' && x.iter === 'infinite';
const WAIT_NODES = ['saWaitDot', 'saWait2Dot', 'ckWaitName', 'ctWaitIco'];

async function run() {
  let win = null;
  for (let i = 0; i < 100 && !win; i++) { win = BrowserWindow.getAllWindows()[0]; if (!win) await sleep(100); }
  if (!win) throw new Error('no app window');
  const wc = win.webContents;
  if (wc.isLoading()) await new Promise((r) => wc.once('did-finish-load', r));
  await sleep(1200);
  const js = (code) => wc.executeJavaScript(code, true);
  await js(`document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(FIXTURE)})`);
  await sleep(400);
  const s = await js(READ);
  const missing = Object.keys(SEL).filter((k) => !s[k]);
  gate('w0 instrument: fixture rendered, running baselines animated by the shipped rules',
    !missing.length && s.saRunDot.name === 'breathe' && s.saRunDot.dur === '1.6s'
      && s.ckRunName.name === 'ct-pulse' && s.ckRunName.dur === '1.1s'
      && s.ctRunIco.name === 'ct-pulse' && s.ctRunIco.dur === '1.1s',
    missing.length ? 'missing ' + missing.join(',')
      : `dot ${s.saRunDot.name}/${s.saRunDot.dur} roster ${s.ckRunName.name}/${s.ckRunName.dur} card ${s.ctRunIco.name}/${s.ctRunIco.dur}`);

  gate('w1 sidebar waiting dot (button.agent-row): animated, slower than running, ring not fill',
    animated(s.saWaitDot) && s.saWaitDot.name === 'ripple-s' && s.saWaitDot.dur === '2s' && s.saWaitDot.dur !== s.saRunDot.dur
      && (s.saWaitDot.bg !== s.saRunDot.bg || s.saWaitDot.sh !== s.saRunDot.sh),
    `run ${s.saRunDot.name}/${s.saRunDot.dur}/${s.saRunDot.bg}/${s.saRunDot.sh} | wait ${s.saWaitDot.name}/${s.saWaitDot.dur}/${s.saWaitDot.iter}/${s.saWaitDot.bg}/${s.saWaitDot.sh}`);
  const cssSrc = fs.readFileSync(path.join(REPO, 'renderer', 'style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const deadLiSel = /\.session-agents\s+li\[data-state/.test(cssSrc);
  gate('w2 sidebar waiting dot (sidebar.js shape, second row): same animated ring look as w1; no dead li[data-state] selector',
    animated(s.saWait2Dot) && s.saWait2Dot.dur === s.saWaitDot.dur && s.saWait2Dot.dur !== s.saRunDot.dur
      && s.saWait2Dot.bg === s.saWaitDot.bg && s.saWait2Dot.sh === s.saWaitDot.sh && s.saWait2Dot.sh !== s.saRunDot.sh && !deadLiSel,
    `row2 ${s.saWait2Dot.name}/${s.saWait2Dot.dur}/${s.saWait2Dot.iter}/${s.saWait2Dot.bg}/${s.saWait2Dot.sh} vs row1 ${s.saWaitDot.dur}/${s.saWaitDot.bg}/${s.saWaitDot.sh}; deadLiSelector=${deadLiSel}`);
  gate('w3 roster waiting name: animated, slower than running, colour differs',
    animated(s.ckWaitName) && s.ckWaitName.dur !== s.ckRunName.dur && s.ckWaitName.color !== s.ckRunName.color,
    `run ${s.ckRunName.name}/${s.ckRunName.dur}/${s.ckRunName.color} | wait ${s.ckWaitName.name}/${s.ckWaitName.dur}/${s.ckWaitName.iter}/${s.ckWaitName.color}`);
  gate('w4 card waiting icon: animated, slower than running',
    animated(s.ctWaitIco) && s.ctWaitIco.dur !== s.ctRunIco.dur,
    `run ${s.ctRunIco.name}/${s.ctRunIco.dur} | wait ${s.ctWaitIco.name}/${s.ctWaitIco.dur}/${s.ctWaitIco.iter}`);
  gate('w5 live: every waiting node owns a running infinite Web Animation',
    WAIT_NODES.every((k) => s[k].anims.some((a) => a.state === 'running' && a.iter === 'Infinity')),
    WAIT_NODES.map((k) => `${k}:${s[k].anims.map((a) => a.state + '/' + a.iter).join('+') || 'none'}`).join(' '));
  gate('w6 a finished row stays static (roster name, sidebar dot)',
    s.ckDoneName.name === 'none' && s.saDoneDot.name === 'none',
    `roster ${s.ckDoneName.name} dot ${s.saDoneDot.name}`);

  const css = fs.readFileSync(path.join(REPO, 'renderer', 'style.css'), 'utf8');
  const names = [...new Set(WAIT_NODES.map((k) => s[k].name).filter((n) => n && n !== 'none'))];
  const kf = names.map((n) => ({ n, props: keyframeProps(css, n) }));
  gate('w7 waiting keyframes animate opacity / transform only (compositor-safe)',
    kf.length > 0 && kf.every((k) => k.props && k.props.length && k.props.every((p) => p === 'opacity' || p === 'transform')),
    kf.map((k) => `${k.n}:[${k.props}]`).join(' ') || 'no waiting animation');

  wc.debugger.attach('1.3');
  await wc.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await sleep(300);
  const r = await js(READ);
  await wc.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  wc.debugger.detach();
  gate('w8 prefers-reduced-motion: waiting animated normally, none under reduce',
    WAIT_NODES.every((k) => animated(s[k]) && r[k] && r[k].name === 'none'),
    WAIT_NODES.map((k) => `${k}:${s[k].name}->${r[k] && r[k].name}`).join(' '));

  gate('w9 no left accent bar, ground untouched (waiting bg === running bg)',
    s.saWaitRow.bl === s.saWaitRow.br && s.ckWaitRow.bl === s.ckWaitRow.br && s.ctWaitCard.bl === s.ctWaitCard.br
      && s.ckWaitRow.shadow === 'none' && s.ctWaitCard.shadow === 'none'
      && s.saWaitRow.bg === s.saRunRow.bg && s.ckWaitRow.bg === s.ckRunRow.bg && s.ctWaitCard.bg === s.ctRunCard.bg,
    `borders L/R agent ${s.saWaitRow.bl}/${s.saWaitRow.br} roster ${s.ckWaitRow.bl}/${s.ckWaitRow.br} card ${s.ctWaitCard.bl}/${s.ctWaitCard.br}; `
      + `shadow roster ${s.ckWaitRow.sh} card ${s.ctWaitCard.sh}; bg agent ${s.saWaitRow.bg}/${s.saRunRow.bg} roster ${s.ckWaitRow.bg}/${s.ckRunRow.bg} card ${s.ctWaitCard.bg}/${s.ctRunCard.bg}`);
}

function finish(code) {
  const n = results.length;
  for (const line of results) console.log(line);
  console.log(failed === 0 && code === 0 ? `VERDICT: ALL GREEN (${n}/${n})` : `VERDICT: FAIL (${n - failed}/${n})`);
  process.exit(failed === 0 && code === 0 ? 0 : 1);
}

setTimeout(() => { gate('timeout', false, 'probe exceeded 120s'); finish(1); }, 120000).unref();
app.whenReady().then(run).then(() => finish(0)).catch((e) => { gate('crash', false, String(e && e.stack || e)); finish(1); });
