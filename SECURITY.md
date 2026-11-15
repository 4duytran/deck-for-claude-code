# Security policy

## Reporting a vulnerability

Do not open a public issue for a security problem. Use the repository's Security
tab, then "Report a vulnerability", or go straight to
<https://github.com/4duytran/deck-for-claude-code/security/advisories/new>.

Please include:

- the commit you tested (`git rev-parse HEAD`),
- your operating system and version,
- the steps that reproduce the problem,
- the impact you see (what an attacker gains, and what they need first).

## Supported versions

Only the latest commit of `main` is supported. There are no release branches.

## Scope

claude-deck is a local desktop app. It starts the `claude` CLI and reads local
Claude Code transcripts and git repositories on your machine.

In scope: the Electron main process, the preload script, the renderer, `bin/`
and `mods/`.

Out of scope: issues in Claude Code, Electron or a dependency. Report those to
the project concerned.
