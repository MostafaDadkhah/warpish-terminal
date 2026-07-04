# Codex guide: Warpish Terminal

## Mission

Maintain a local-only, Warp-inspired Chrome terminal that talks to the real host shell safely. Prioritize working behavior over visual polish: resumable sessions, reliable terminal I/O, block history, and explicit security boundaries matter most.

## First steps for any agent

Run from the project root:

```bash
git status --short --branch
git log --oneline --decorate --max-count=3
```

Then inspect the relevant files before editing. Do not assume runtime state from a previous session is current.

Use relative paths in durable docs. Do not write machine-specific absolute paths, private hostnames, transient ports, tokens, or user-specific runtime labels into `context.md` or this file.

## Do not commit these

Never add these to git:

- `.auth-token`
- `.server.pid`
- `.warpish/`
- terminal history files
- `*.log`
- `node_modules/`
- generated screenshots/tmp/browser artifacts

If you touch `.gitignore`, verify ignored files with:

```bash
git check-ignore -v .auth-token .server.pid .warpish/sessions.json node_modules/.package-lock.json
```

## Core commands

Install dependencies:

```bash
npm install
```

Run locally:

```bash
./start.sh
```

Stop server:

```bash
./stop.sh
```

Manual server:

```bash
npm start
```

Smoke test:

```bash
npm run smoke
```

Syntax checks:

```bash
node --check server.js
node --check public/app.js
node --check scripts/smoke.js
zsh -n scripts/warpish-shell-integration.zsh
```

## Architecture map

- `server.js`
  - Express app and static file serving.
  - Token auth middleware.
  - Session CRUD APIs.
  - WebSocket attach endpoint.
  - tmux session creation/attach/resize/kill/capture.
  - Command block event parsing/storage.

- `scripts/pty-worker.py`
  - Owns the PTY.
  - Runs `tmux attach-session`.
  - Sends base64 PTY output lines to Node.
  - Receives input/resize/control messages from Node.

- `scripts/warpish-shell-integration.zsh`
  - Uses zsh `preexec`/`precmd` hooks.
  - Emits command start/end events.
  - Must remain scoped to Warpish sessions only; do not modify the user's global zsh files directly.

- `public/app.js`
  - Browser app state.
  - WebSocket connection management.
  - xterm.js rendering.
  - Sidebar/session UI.
  - Command composer.
  - Command-block search/copy/rerun UI.

- `public/index.html` and `public/styles.css`
  - Layout and visual design.

- `scripts/smoke.js`
  - End-to-end regression test.
  - Must keep proving session resume and command-block capture.

## Critical behavior to preserve

### Sessions

- A browser reload or WebSocket close must detach only the current attach process.
- It must not kill the tmux session.
- The UI `Kill session` action is the intentional destructive path.
- Sidebar previews should come from actual tmux pane content, not fabricated state.

### Command blocks

- New sessions should launch with scoped shell integration enabled.
- Blocks should record command, output preview, status, exit code, start/end times, and duration.
- Rerun must send the recorded command back into the same selected session.
- Search/copy actions are browser-only conveniences and must not mutate session state.
- Do not rely only on OSC markers. tmux can filter or replay control sequences.
- Do not blindly append every WebSocket output chunk to the active block; tmux redraw/replay can pollute block output.
- If output extraction changes, update `npm run smoke` to catch regressions.

### Security

- Default bind should stay local (`127.0.0.1`).
- The token must stay secret and untracked.
- Treat this app as equivalent to Terminal.app access.
- Do not add public binding, remote tunneling, or phone access without stronger auth/TLS/network controls and explicit approval.

## Verification checklist before committing code changes

For backend/terminal/session changes:

```bash
node --check server.js
node --check scripts/smoke.js
zsh -n scripts/warpish-shell-integration.zsh
npm run smoke
```

For frontend changes:

```bash
node --check public/app.js
npm run smoke
```

Then open the app in Chrome and verify at least:

- sidebar renders sessions,
- `+ New terminal` creates a session,
- composer command runs in the terminal,
- reload/reattach preserves terminal output,
- command blocks render and rerun works,
- browser console has no JavaScript errors.

For docs-only changes, at minimum verify:

```bash
git diff --check
git status --short --branch
```

## Git workflow

- Keep commits focused.
- Inspect staged files before commit:

```bash
git diff --cached --name-only
git diff --cached --stat
```

- Do not include runtime files or secrets.
- If adding a GitHub/GitLab remote later, scan tracked files first and keep the repo private unless explicitly told otherwise.

## Known pitfalls

- A pretty xterm.js pane is not enough; Warp-like behavior requires session continuity and block affordances.
- Spawning a raw shell per WebSocket breaks resume.
- Confusing detach with kill will destroy user work.
- Shell integration must not modify global user startup files.
- tmux capture/output boundaries are tricky; full-screen/TUI apps may not produce useful command block previews.
- Browser screenshot tooling may fail in constrained local environments; use DOM/console/API evidence as fallback.
