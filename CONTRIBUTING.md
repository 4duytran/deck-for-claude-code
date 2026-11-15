# Contributing to claude-deck

Thanks for your interest in claude-deck. Bug reports, fixes and features are all
welcome. This page covers how to get the code running, how a change is verified,
and how to send it.

If you are unsure whether an idea fits, open an issue first. It is cheaper than
a rejected pull request.

## Set up

You need the tools listed in the [README requirements](README.md#requirements):
Linux with an X11 session (or macOS with the Xcode Command Line Tools), Node.js 22.12
or newer, the Claude Code CLI, `jq`, and a C/C++ toolchain (`npm install` rebuilds
`node-pty` against Electron's ABI).

```bash
git clone https://github.com/4duytran/deck-for-claude-code
cd deck-for-claude-code
npm install
```

To contribute, clone your own fork instead (see [Pull requests](#pull-requests)).

Since Electron 42, `npm install` does not download the Electron binary. Download
it, then check that it is there:

```bash
npx install-electron --no
ls -l node_modules/electron/dist/electron
```

The test runner needs the binary, and `npm start` downloads it on first run when
it is missing (about 100 MB, cached in `~/.cache/electron`).

On Ubuntu 24.04 and later (Linux only, not needed on macOS), Electron also needs
its `chrome-sandbox` helper to be `root:root 4755`, or it dies with
`FATAL setuid_sandbox_host` before any window opens. The fix and the fallback are in the
[README requirements](README.md#requirements). Run it after the binary is
installed, and redo it after every Electron reinstall.

## Run

```bash
npm start
```

## Test

The project has no unit-test framework. It is verified by end-to-end **probes**:
standalone Electron scripts in `test/` that boot the real app against throwaway
fixtures and assert on the real DOM, IPC and filesystem.

```bash
npm test
bash test/run.sh zoom-probe
TEST_VISIBLE=1 bash test/run.sh zoom-probe
```

- `npm test` runs every probe listed in `test/run.sh`. A green run ends with
  `===== SWEEP: N ok / 0 bad =====` (N is the number of probes in the list). The
  exit code is 1 when any probe is bad.
- `bash test/run.sh zoom-probe` runs one probe. Several names can follow,
  separated by spaces. `npm test -- zoom-probe` does the same.
- By default the runner re-executes itself under `xvfb-run`, so no window
  appears on your desktop. Install `xvfb` for that. Without it the probe windows
  open on your display, with a notice.
- macOS has no `xvfb-run`, so probe windows open on your display, and some probes
  are Linux-first (`/proc`, xdg): a green sweep is not promised on macOS.
- `TEST_VISIBLE=1` skips the private Xvfb and runs on your real display. Use it
  to watch a probe.
- Each probe writes its output to `test/<name>.out` (git-ignored). On a failure,
  read the `FAIL` lines there.

Run probes through `test/run.sh` rather than calling Electron by hand: the
runner keeps the run contained (loopback URLs for the price and command feeds, a
throwaway plugins folder, a pinned UI zoom).

## Definition of done

A change is done when all of these hold:

1. **Syntax gates pass.** `node --check main.js` and `node --check` on every
   file you touched under `src/main/`. The renderer files are ES modules, and
   `node --check` parses a bare `.js` as CommonJS, so check a `.mjs` copy:

   ```bash
   node --check main.js
   f=$(mktemp --suffix=.mjs) && cp renderer/js/boot.js "$f" && node --check "$f"
   ```

2. **A probe covers the change.** Write the feature probe in
   `test/<name>-probe.js` first and watch it fail (red). Then make the change and
   watch it pass (green). A bug fix needs a probe that reproduces the bug.
3. **No regression.** `npm test` ends with `0 bad`.
4. **The evidence is shown.** Paste the probe's verdict lines and the last line
   of `npm test` in the pull request, verbatim.

## Writing a probe

The pattern, the environment seams and the containment rules are written down in
[CLAUDE.md](CLAUDE.md), section "The probe harness". Read it before your first
probe. The short version:

- Copy a probe that is close to your feature and adapt it. Name it
  `test/<feature>-probe.js`.
- Build the fixtures in a throwaway directory (`fs.mkdtempSync`) before the app
  boots, and point the environment seams at them before
  `require('../main.js')`. A probe never touches your real sessions or settings.
- Drive the UI from the main process through `webContents.executeJavaScript`.
  The renderer exposes its state and functions on `window` for this (the probe
  seam, assigned in `renderer/js/boot.js`).
- Compute each verdict from the observed state. Never hardcode the expected
  result.
- Print one `PASS <gate>` or `FAIL <gate>` line per gate, then a final
  `VERDICT:` line, and exit 0 only when every gate passed. This is what
  `test/run.sh` reads.
- Add the probe name to the `PROBES` list in `test/run.sh`, or `npm test` will
  not run it.
- When you fix a class of bug (a race, an injection through a label, a stale
  cache), keep its gate in the probe for good.

## Code style

- No framework, no bundler, no new dependency. If you think a feature needs one,
  open an issue and make the case. Prefer the standard library or what is
  already in `package.json`.
- The main process is CommonJS under `main.js` and `src/main/`. The renderer is
  plain ES modules under `renderer/js/`.
- Follow the patterns of the module you are editing, and read the rules in
  [CLAUDE.md](CLAUDE.md) (non-negotiable rules, module architecture, code map)
  before touching code you do not know. For instance, text that comes from
  outside the app, such as plugin output, reaches the DOM through `textContent`.
- Code, comments, identifiers, commit messages and documentation are in English.
  Comment only where the code would surprise a reader.
- **The user interface is French.** Every string the user sees (labels, buttons,
  tooltips, dialogs, status text) stays in French, to match the rest of the app.
  Do not translate existing strings.

## Commit messages

One line, a type prefix, an imperative subject, 72 characters or fewer:

```text
fix: keep the scroll position when a pane regains focus
feat: add a zoom shortcut to the header
chore: bump the xterm addons
docs: explain the probe seams
```

The types are `fix:`, `feat:`, `chore:` and `docs:`. Keep one topic per commit.
Add a body after a blank line when the why is not obvious.

## Pull requests

1. Fork the repository on GitHub and clone your fork.
2. Create a branch from `main`, for example `fix/scroll-on-focus`.
3. Make the change, with its probe, and run the checks from the
   [definition of done](#definition-of-done).
4. Push the branch to your fork and open a pull request against `main`.
5. In the description, say what changed and why, and paste the verdict lines.
   Keep the pull request to one topic. A reviewer will answer there, and you can
   push more commits to the same branch.

```bash
git clone https://github.com/YOUR-USER/claude-deck
cd deck-for-claude-code
git switch -c fix/scroll-on-focus
git commit -m "fix: keep the scroll position when a pane regains focus"
git push -u origin fix/scroll-on-focus
```

## Working with Claude Code

claude-deck is built with Claude Code, and the repository is set up for it.
[CLAUDE.md](CLAUDE.md) is the project instructions file: Claude Code reads it at
the start of a session. It holds the rules, the module architecture, the code
map and the probe harness. It is also the best map of the code for a human.

If you use Claude Code to contribute, the same definition of done applies:
syntax gates, a probe written first, and `npm test` at `0 bad`. Review what it
wrote before you open the pull request.

## Licence

claude-deck is released under the [MIT licence](LICENSE). By sending a
contribution you agree that it is licensed under the same terms.
