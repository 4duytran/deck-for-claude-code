// Run-journal parser of the Plugins panel: the text of a plugin run log becomes steps, display lines and a failure
// summary. Pure and self-contained (no DOM, no IO, no dependency); every returned string is meant for textContent.
// Line grammar written by the plugin: `::deck-step:: <step> <state> <epoch ms> [<text>]`, the text field being optional.
// Any other line, and any prefixed line that does not match the grammar, is a plain line.

const STEP_RE = /^::deck-step:: ([a-z][a-z0-9-]{0,31}) (wait|start|done|warn|fail) ([0-9]{13})(?: ([^\n]{1,200}))?$/;
const MAX_STEPS = 16;
const MAX_LAST = 8;
const MAX_PLAIN = 300;

const pad = (n) => String(n).padStart(2, '0');
const clock = (ms) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

// opts.live: the run is still going, so a trailing line without its newline may be half written and is left out.
// opts.exit: the exit code of an ended run; an integer other than 0 marks the run failed.
// -> { steps, lines, allLines, failed }
//   steps    [{ id, label, state, text, startMs }] in order of first appearance (label: text of the first `wait`
//            line, else the id; text: detail / count / error of the latest line, '' for `wait`; startMs: epoch ms of
//            the latest `start` line, else null)
//   lines    the last 8 display lines; allLines: every display line (full log view)
//   failed   null, or { step, text, code } for a run that exited non-zero (step: the failing step or null)
export function parseJournal(text, opts) {
  const live = !!(opts && opts.live);
  const exit = opts ? opts.exit : null;
  const parts = (typeof text === 'string' ? text : '').split('\n');
  const tail = parts.pop();
  if (!live && tail !== '') parts.push(tail);

  const steps = [];
  const byId = new Map();
  const labelled = new Set();
  const allLines = [];
  for (const part of parts) {
    const raw = part.endsWith('\r') ? part.slice(0, -1) : part;
    if (raw.trim() === '') continue;
    const m = STEP_RE.exec(raw);
    let step = m ? byId.get(m[1]) : null;
    if (m && !step && steps.length < MAX_STEPS) {
      step = { id: m[1], label: m[1], state: 'wait', text: '', startMs: null };
      byId.set(step.id, step);
      steps.push(step);
    }
    if (!step) {
      allLines.push(raw.slice(0, MAX_PLAIN));
      continue;
    }
    const state = m[2];
    const at = Number(m[3]);
    const body = m[4] || '';
    if (state === 'wait' && body && !labelled.has(step.id)) {
      step.label = body;
      labelled.add(step.id);
    }
    if (state === 'start') step.startMs = at;
    step.state = state;
    step.text = state === 'wait' ? '' : body;
    const shown = body === '' || (state === 'wait' && body === step.label) ? '' : ` · ${body}`;
    allLines.push(`${clock(at)}  ${step.label}${shown}`);
  }

  let failed = null;
  if (!live && Number.isInteger(exit) && exit !== 0) {
    const explicit = steps.filter((s) => s.state === 'fail');
    const left = steps.filter((s) => s.state === 'start');
    // A progress detail is not an error: a step cut short while running is failed with no text of its own.
    for (const s of left) { s.state = 'fail'; s.text = ''; }
    const culprit = explicit.length ? explicit[explicit.length - 1] : (left[left.length - 1] || null);
    failed = { step: culprit, text: (culprit && culprit.text) || `arrêt sans message (code ${exit})`, code: exit };
  }
  return { steps, lines: allLines.slice(-MAX_LAST), allLines, failed };
}
