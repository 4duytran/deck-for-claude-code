// Model labels shared by the pane header chip, the chat model badge and the
// sidebar sub-agent rows. Imports nothing: sidebar.js and chat-view.js both
// depend on it, so it must stay a leaf (no import cycle).

// v66: « claude-fable-5-1 » -> « Fable 5.1 ». An id that does not match is
// rendered verbatim: an observed model is a fact, never reshaped into a guess.
const MODEL_ID_RE = /^claude-([a-z]+)-(\d+)(?:-(\d+))?(?:-\d{8,})?$/;
// A requested alias (« sonnet », « opus », « haiku », « fable »): one bare word.
const MODEL_ALIAS_RE = /^[a-z]+$/;

export function humanizeModel(id) {
  const m = MODEL_ID_RE.exec(id);
  if (!m) return id;
  const family = m[1].charAt(0).toUpperCase() + m[1].slice(1);
  return m[3] ? `${family} ${m[2]}.${m[3]}` : `${family} ${m[2]}`;
}

// Sub-agent row label: full id -> humanizeModel, bare alias -> capitalised
// family, anything else usable verbatim. null / empty / non-string -> '' so
// the caller renders nothing (rule 7).
export function agentModelLabel(model) {
  if (typeof model !== 'string') return '';
  const m = model.trim();
  if (!m) return '';
  if (MODEL_ALIAS_RE.test(m)) return m.charAt(0).toUpperCase() + m.slice(1);
  return humanizeModel(m);
}
