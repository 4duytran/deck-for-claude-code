// claude-deck — renderer/theme: visual constants shared across modules.
'use strict';

// GitHub-dark ANSI palette on the app ground — keep in sync with tokens.css
// (--ground, --c-accent). v13 contrast pass (visual only): lighter black/yellow/white
// so dim text stays readable on #0B0E13; the translucent teal selection (the
// --c-accent hue) leaves the text legible underneath.
export const XTERM_THEME = {
  background: '#0B0E13',
  foreground: '#e6edf3',
  cursor: '#5EEAD4',
  cursorAccent: '#0B0E13',
  selectionBackground: 'rgba(94, 234, 212, 0.28)',
  black: '#545d68', red: '#ff7b72', green: '#3fb950', yellow: '#deb13e',
  blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39c5cf', white: '#c9d1d9',
  brightBlack: '#768390', brightRed: '#ffa198', brightGreen: '#56d364',
  brightYellow: '#e3b341', brightBlue: '#79c0ff', brightMagenta: '#d2a8ff',
  brightCyan: '#56d4dd', brightWhite: '#f0f6fc',
};

export const MONO_FONT =
  '"JetBrainsMono Nerd Font", "JetBrains Mono", "Fira Code", "Cascadia Code", monospace';

// Live session status, fed by Claude Code hooks via ~/.claude/deck-status/.
// Labels are the French words of the sidebar subtitle; the dot is drawn by CSS.
export const STATUS_META = {
  active:  { label: 'ouverte' },
  working: { label: 'en cours' },
  running: { label: 'agents en cours' },
  idle:    { label: 'au repos' },
  waiting: { label: 'attend ta réponse' },
  compacting: { label: 'compaction' }, // v58: native (Claude-decided) compaction — was falling back to the 'closed' (dead) badge
  closed:  { label: 'fermée' },
};
