// claude-deck — renderer/file-drop: what a file drop needs, shared by the chat composer and the new-session
// home. A leaf: no import. The disk path of a dropped File comes from the preload (`webUtils`: File.path is gone).
'use strict';

// File tokens for the composer (paperclip, drop, « @ » picker): `@rel` inside the session folder, else
// `@abs`. A path with whitespace goes in as quoted plain text, no `@`: a mention would stop at the space.
export function fileToken(p, roots) {
  let q = p;
  for (const r of roots) {
    const base = r.endsWith('/') ? r : `${r}/`;
    if (p.length > base.length && p.startsWith(base)) { q = p.slice(base.length); break; }
  }
  return /\s/.test(q) ? `"${q}"` : `@${q}`;
}

// The text a drop or a picker puts in the input: the tokens space-joined, a space before them when the
// character left of the caret (`prev`, '' at the start) is not whitespace, and a trailing space.
export const tokensText = (paths, roots, prev) =>
  `${prev && !/\s/.test(prev) ? ' ' : ''}${paths.map((p) => fileToken(p, roots)).join(' ')} `;

export const dragHasFiles = (e) => !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');

// Disk paths of the dropped files ('' = not a disk file, skipped).
export const droppedPaths = (e) => (e.dataTransfer
  ? Array.from(e.dataTransfer.files || [], (f) => window.api.pathForFile(f)).filter(Boolean) : []);
