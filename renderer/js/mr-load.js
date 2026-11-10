// mr-load.js: the four reads of an MR view (version, diffs, discussions, drafts) fired at once, each answer handed to
// its handler on arrival. A failed part reports through onError and never stops the others. cancel() drops every
// later answer of a superseded load (its calls still end in main; only the delivery is silenced).
// Handler arguments: onVersion(version), onFiles(files, truncated), onDiscussions({diffThreads, general, truncated}),
// onDrafts(drafts), onError(part, message) with part = 'version' | 'diffs' | 'discussions' | 'drafts'.

const INVALID = 'Réponse invalide';
const isList = (x) => Array.isArray(x);

const PARTS = [
  { part: 'version', handler: 'onVersion', valid: (r) => !!r.version && typeof r.version === 'object', pick: (r) => [r.version] },
  { part: 'diffs', handler: 'onFiles', valid: (r) => isList(r.files), pick: (r) => [r.files, r.truncated === true] },
  {
    part: 'discussions',
    handler: 'onDiscussions',
    valid: (r) => isList(r.diffThreads) && isList(r.general),
    pick: (r) => [{ diffThreads: r.diffThreads, general: r.general, truncated: r.truncated === true }],
  },
  { part: 'drafts', handler: 'onDrafts', valid: (r) => isList(r.drafts), pick: (r) => [r.drafts] },
];

// `only` (optional): the part names to read, e.g. ['discussions'] for the view's refresh; absent = the four parts. Same validation.
export function loadMrParts(target, iid, handlers = {}, only = null) {
  let live = true;
  const specs = isList(only) ? PARTS.filter((s) => only.includes(s.part)) : PARTS;
  const deliver = (fn, ...args) => {
    if (!live || typeof fn !== 'function') return;
    try { fn(...args); } catch (err) { console.error('mr-load handler', err); }
  };
  const ask = (part) => (part === 'drafts' ? window.api.gitlabDrafts(target, iid) : window.api.gitlabMr(target, iid, part));

  for (const spec of specs) {
    let call;
    try { call = Promise.resolve(ask(spec.part)); } catch (err) { call = Promise.reject(err); }
    call.then(
      (res) => {
        if (res && res.ok === true && spec.valid(res)) deliver(handlers[spec.handler], ...spec.pick(res));
        else deliver(handlers.onError, spec.part, (res && typeof res.message === 'string' && res.message) || INVALID);
      },
      (err) => deliver(handlers.onError, spec.part, (err && err.message) || INVALID),
    );
  }
  return { cancel() { live = false; } };
}
