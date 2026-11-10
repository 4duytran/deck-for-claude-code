'use strict';
// Page transport IPC: the renderer hands back the page bytes main already gave it and gets a
// `deckpage://` URL for a closed frame. `page-serve` { slot, html } -> { ok, url } | { ok:false, error }.

const { ipcMain } = require('electron');
const { putPage } = require('../page-scheme');

function registerPageIpc() {
  ipcMain.handle('page-serve', (_e, req) => {
    const { slot, html } = req && typeof req === 'object' ? req : {};
    return putPage(slot, html);
  });
}

module.exports = { registerPageIpc };
