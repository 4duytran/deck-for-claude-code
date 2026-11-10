// claude-deck — renderer/ask-model: the pure state machine behind the
// question drawer (AskUserQuestion). No DOM, no deck imports — the drawer
// renders state() and forwards clicks/keys here, probes assert it directly.
// Answer shape = the hook's updatedInput.answers: keyed by question text,
// a multi-select value is "l1, l2", « Other » is the user's own text.
'use strict';

const str = (v) => (typeof v === 'string' ? v : '');

function normalizeQuestion(q) {
  const options = Array.isArray(q.options) ? q.options : [];
  return {
    header: str(q.header),
    question: str(q.question),
    multiSelect: !!q.multiSelect,
    options: options
      .filter((o) => o && typeof o.label === 'string')
      .map((o) => ({ label: o.label, description: str(o.description) })),
  };
}

export function createAskModel(rawQuestions) {
  const qs = (Array.isArray(rawQuestions) ? rawQuestions : [])
    .filter((q) => q && typeof q === 'object')
    .map(normalizeQuestion);
  // Per-question draft; `selected` holds 0-based option indexes. Selection and
  // custom text are mutually exclusive (T3: the composer IS the Other field).
  const drafts = qs.map(() => ({ selected: new Set(), custom: '' }));
  let index = 0;
  let advanceDue = false; // a single-select pick asked the drawer to auto-advance
  let submitting = false;
  let submitted = false;

  const answered = (i) => drafts[i].selected.size > 0 || drafts[i].custom.trim() !== '';
  const locked = () => submitting || submitted;
  const canNext = () => index < qs.length - 1 && answered(index);
  const canSubmit = () => qs.length > 0 && !locked() && drafts.every((_, i) => answered(i));

  function valueOf(i) {
    const custom = drafts[i].custom.trim();
    if (custom) return custom;
    return [...drafts[i].selected]
      .sort((a, b) => a - b)
      .map((k) => qs[i].options[k].label)
      .join(', ');
  }

  // Unanswered questions are omitted. Null prototype: a question text such as
  // "__proto__" stays a plain own key.
  function answers() {
    const out = Object.create(null);
    qs.forEach((q, i) => {
      if (answered(i)) out[q.question] = valueOf(i);
    });
    return out;
  }

  // `n` = the 1-based option number (the digit shown on the option, 1-9).
  // Single: replaces the selection and raises advanceDue. Multi: toggles.
  // `displaced` = the custom text the pick removed, for the drawer to hand
  // back to the normal composer draft.
  function pick(n) {
    const q = qs[index];
    if (!q || locked() || !Number.isInteger(n) || n < 1 || n > q.options.length) {
      return { ok: false, advanceDue: false, displaced: '' };
    }
    const d = drafts[index];
    const displaced = d.custom;
    d.custom = '';
    const k = n - 1;
    if (q.multiSelect) {
      if (d.selected.has(k)) d.selected.delete(k);
      else d.selected.add(k);
      advanceDue = false;
    } else {
      d.selected.clear();
      d.selected.add(k);
      advanceDue = true;
    }
    return { ok: true, advanceDue, displaced };
  }

  // Non-blank text clears the selection; blank text only updates the draft.
  function setCustom(text) {
    if (!qs[index] || locked()) return false;
    const d = drafts[index];
    d.custom = str(text);
    if (d.custom.trim()) {
      d.selected.clear();
      advanceDue = false;
    }
    return true;
  }

  // The drawer's 200 ms auto-advance timer is cancellable (T3).
  function cancelAdvance() {
    advanceDue = false;
  }

  // Consumes the flag: 'next' (moved on), 'submit' (the last question was
  // picked — the drawer calls submit()), or null (nothing due).
  function advance() {
    if (!advanceDue) return null;
    advanceDue = false;
    if (index >= qs.length - 1) return 'submit';
    index += 1;
    return 'next';
  }

  function next() {
    if (!canNext()) return false;
    index += 1;
    advanceDue = false;
    return true;
  }

  function prev() {
    if (index <= 0) return false;
    index -= 1;
    advanceDue = false;
    return true;
  }

  // Returns the answers to send and marks the request in flight; null when
  // incomplete, already in flight or already delivered (dedupe).
  function submit() {
    if (!canSubmit()) return null;
    submitting = true;
    advanceDue = false;
    return answers();
  }

  function submitDone() {
    if (!submitting) return;
    submitting = false;
    submitted = true;
  }

  // A failed send keeps the card and re-arms submit (T3 submit hygiene).
  function submitFailed() {
    submitting = false;
  }

  // Detached snapshot — safe to hand to a renderer or a probe seam.
  function state() {
    return {
      index,
      count: qs.length,
      advanceDue,
      submitting,
      submitted,
      canPrev: index > 0,
      canNext: canNext(),
      canSubmit: canSubmit(),
      isLast: qs.length > 0 && index === qs.length - 1,
      questions: qs.map((q, i) => ({
        header: q.header,
        question: q.question,
        multiSelect: q.multiSelect,
        options: q.options.map((o) => ({ ...o })),
        selected: [...drafts[i].selected].sort((a, b) => a - b),
        custom: drafts[i].custom,
        answered: answered(i),
      })),
    };
  }

  return {
    state, pick, setCustom, cancelAdvance, advance, next, prev,
    answers, canSubmit, submit, submitDone, submitFailed,
  };
}
