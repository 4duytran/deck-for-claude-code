// room-mirror: copies a model's SendMessage to a room member into the room feed
// as a feed-only record ({mirror:true}: the deck router archives and draws it,
// never delivers it). The send itself is never blocked, rewritten or failed.

const uuid = () => {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = Math.floor(Math.random() * 16);
    return (ch === 'x' ? r : (r % 4) + 8).toString(16);
  });
};

// The registry session `to` names (case-insensitive, as `room inbox`). A native
// SendMessage is delivered only to the name Claude Code gave a session
// (native_name) or the uds: address of its pid, so those win; the session id or
// label is the fallback, and never overrides a native name another session owns.
const memberOf = (registryText, to) => {
  const sessions = JSON.parse(registryText).sessions;
  if (!Array.isArray(sessions)) return null;
  const t = to.toLowerCase();
  const same = (v) => typeof v === 'string' && v.toLowerCase() === t;
  const rows = sessions.filter((s) => s && typeof s.session_id === 'string');
  const sock = /^uds:.*\/(\d+)\.sock$/.exec(to);
  const pid = sock ? Number(sock[1]) : null;
  return rows.find((s) => same(s.native_name) || (pid !== null && s.pty_pid === pid))
    || rows.find((s) => same(s.session_id) || same(s.label))
    || null;
};

// Same cap as the pane path (ROOM_MAX_TEXT in src/main/config.js, applied in
// src/main/ipc/room.js; a mod cannot require config.js).
const ROOM_MAX_TEXT = 4000;

export const register = (on) => {
  on('session.send', async ($, e, next) => {
    const result = await next(e);
    try {
      if (typeof e.to !== 'string' || (result && result.isDelivered === false)) return result;
      const self = await $.env.get('ROOM_SESSION_ID');
      if (!self) return result;
      const home = await $.env.get('HOME');
      const dir = (await $.env.get('CLAUDE_DECK_ROOMS_DIR')) || (home ? `${home}/.claude/rooms` : '');
      if (!dir) return result;
      const member = memberOf(await $.fs.read(`${dir}/registry.json`), e.to);
      if (!member) return result;
      const label = (await $.env.get('ROOM_LABEL')) || self.slice(0, 8);
      const record = {
        id: uuid(),
        ts: new Date().toISOString(),
        from: self,
        from_label: label,
        to: member.session_id,
        text: typeof e.text === 'string' ? e.text.slice(0, ROOM_MAX_TEXT) : e.text,
        mirror: true,
      };
      // tee -a appends each chunk it reads (8192 bytes) with its own O_APPEND
      // write, so a line within one chunk lands whole beside a concurrent `room send`
      // (bin/room, appendFileSync); a read-modify-write through $.fs.write would race
      // with it. The cap keeps an ordinary line under 8192 bytes; multibyte or
      // escape-heavy text can still exceed it and then spans several writes.
      await $.process.run(['tee', '-a', `${dir}/main.jsonl`], { stdin: `${JSON.stringify(record)}\n` });
    } catch (_) {
      // a mirror failure must never reach the send
    }
    return result;
  });
};
