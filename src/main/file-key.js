// claude-deck — file-key: the opaque identity of ONE file for the renderer's « Demander à Claude » threads.
// A short sha256 of the file's realpath, so the Plans and Files tabs name the same file the same way while the absolute path
// never crosses IPC. A leaf: node:crypto only. Callers pass a realpath (never a path that may still hold a symlink).
'use strict';

const crypto = require('node:crypto');

const KEY_LEN = 16; // hex chars: 64 bits, far past any collision in one session's files

function fileKeyOf(realPath) {
  return crypto.createHash('sha256').update(String(realPath)).digest('hex').slice(0, KEY_LEN);
}

module.exports = { fileKeyOf };
