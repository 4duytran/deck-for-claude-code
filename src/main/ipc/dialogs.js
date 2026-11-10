// claude-deck — ipc/dialogs: new-session folder picker (v13) — native dialog
// + defensive dir validation.
'use strict';

const { ipcMain, dialog, nativeImage } = require('electron');
const fsp = require('fs/promises');
const path = require('path');
const { DEFAULT_NEW_SESSION_DIR } = require('../config');
const { getWin } = require('../window');
const { sessionRoot } = require('./files-panel');

const THUMB_MAX_BYTES = 20 * 1024 * 1024;
const THUMB_EDGE = 96;
const THUMB_DECODED = new Set(['.png', '.jpg', '.jpeg']);
// nativeImage decodes PNG and JPEG only: gif / webp go through as their own bytes.
const THUMB_RAW_MIME = { '.gif': 'image/gif', '.webp': 'image/webp' };

// data: miniature of an image file for a composer chip, or null (never throws).
async function thumbOf(p) {
  if (typeof p !== 'string' || !path.isAbsolute(p)) return null;
  const ext = path.extname(p).toLowerCase();
  const rawMime = THUMB_RAW_MIME[ext];
  if (!rawMime && !THUMB_DECODED.has(ext)) return null;
  const st = await fsp.stat(p);
  if (!st.isFile() || st.size > THUMB_MAX_BYTES) return null;
  if (rawMime) return `data:${rawMime};base64,${(await fsp.readFile(p)).toString('base64')}`;
  let img = nativeImage.createFromPath(p);
  if (img.isEmpty()) return null;
  const { width, height } = img.getSize();
  if (Math.max(width, height) > THUMB_EDGE) {
    img = img.resize(width >= height ? { width: THUMB_EDGE } : { height: THUMB_EDGE });
  }
  return img.toDataURL();
}

// Session folder as the composer sees it: realpath first, then its lexical form
// (a dropped file may carry either); [] when the pane/session has no folder.
async function rootsOf(target) {
  const ctx = await sessionRoot(target && typeof target === 'object' ? target : {});
  return ctx ? [...new Set([ctx.root, ctx.lexical])] : [];
}

function registerDialogsIpc() {
  // "Choisir un autre dossier…" — native Electron directory picker.
  // Returns the chosen absolute path, or null on cancel/error (never throws).
  ipcMain.handle('dialog-pick-folder', async () => {
    try {
      const res = await dialog.showOpenDialog(getWin(), {
        properties: ['openDirectory'],
        defaultPath: DEFAULT_NEW_SESSION_DIR,
      });
      if (res.canceled || !Array.isArray(res.filePaths) || !res.filePaths.length) return null;
      return res.filePaths[0];
    } catch (_) {
      return null;
    }
  });

  // Composer paperclip: native multi-file picker opened in the session folder.
  // { paths: absolute paths ([] on cancel/error), roots } — never throws.
  ipcMain.handle('dialog-pick-files', async (_e, target) => {
    try {
      const roots = await rootsOf(target);
      const res = await dialog.showOpenDialog(getWin(), {
        properties: ['openFile', 'multiSelections'],
        ...(roots.length ? { defaultPath: roots[0] } : {}),
      });
      const paths = res.canceled || !Array.isArray(res.filePaths)
        ? [] : res.filePaths.filter((p) => typeof p === 'string' && p);
      return { paths, roots };
    } catch (_) {
      return { paths: [], roots: [] };
    }
  });

  // Roots only, for files dropped on the composer (paths come from the preload).
  ipcMain.handle('attach-roots', async (_e, target) => {
    try {
      return await rootsOf(target);
    } catch (_) {
      return [];
    }
  });

  // Chip miniature of a dropped / picked image: a data: URL, or null (the renderer CSP blocks file:).
  ipcMain.handle('attach-thumb', async (_e, p) => {
    try {
      return await thumbOf(p);
    } catch (_) {
      return null;
    }
  });

  // Pre-spawn guard: a known-project dir may have vanished since the last scan.
  // The renderer shows a message instead of spawning into a dead cwd.
  ipcMain.handle('dir-exists', async (_e, p) => {
    if (typeof p !== 'string' || !p) return false;
    try {
      return (await fsp.stat(p)).isDirectory();
    } catch (_) {
      return false;
    }
  });

  ipcMain.handle('default-session-dir', () => DEFAULT_NEW_SESSION_DIR);
}

module.exports = { registerDialogsIpc };
