# Codex guide: Warpish Terminal

## Mission

Maintain a local-only Chrome terminal that talks to the real host shell safely. Prioritize resumable sessions, reliable raw terminal I/O, safe paste handling, mobile terminal keys, and explicit security boundaries.

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
git check-ignore -v .auth-token .server.pid .warpish/warpish.sqlite3 node_modules/.package-lock.json scripts/__pycache__/x.pyc
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

Smoke and browser regression tests:

```bash
npm run smoke
npm run regression
# or run both:
npm test
```

Syntax checks:

```bash
node --check server.js
node --check public/app.js
node --check scripts/smoke.js
node --check scripts/browser-regressions.js
python3 -m py_compile scripts/pty-worker.py
zsh -n scripts/warpish-shell-integration.zsh
bash -n start.sh stop.sh
```

## Architecture map

- `server.js`
  - Express app and static file serving.
  - Token auth middleware.
  - Session CRUD APIs.
  - WebSocket attach endpoint.
  - tmux session creation/attach/resize/kill/capture.
  - Command block event parsing/storage.

- `storage.js`
  - Owns the standalone SQLite schema and transactional session/block/event persistence.

- `scripts/record-shell-event.py`
  - Journals zsh command start/end markers directly into SQLite.

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
  - Raw xterm.js rendering and input.
  - Sidebar/session UI.
  - One-click default session creation.
  - Multiline-paste safety and mobile terminal keys.

- `public/terminal-key-data.js`
  - Pure state-aware terminal key mapping for application cursor mode, modifiers, function/navigation keys, Alt, Ctrl, and IME/Meta guards.

- `public/terminal-input.js`
  - Pure 64 KiB byte-aware UTF-8/binary chunking used by the ordered, bounded browser reconnect/backpressure queue.

- `public/index.html` and `public/styles.css`
  - Minimal terminal/sidebar layout, dialogs, and mobile-key presentation.

- `scripts/smoke.js`
  - End-to-end backend/tmux regression test.
  - Runs against a temporary `WARPISH_DATA_DIR`, token file, and session prefix so smoke sessions do not pollute the real sidebar.
  - Must keep proving reconnect and real Node-server restart resume, SQLite shell-event/block persistence, runtime snapshots, stopped-history cleanup, and legacy-private fail-closed behavior.

- `scripts/browser-regressions.js`
  - Headless Chrome/CDP regression test.
  - Runs against a temporary `WARPISH_DATA_DIR`, token file, session prefix, and Chrome profile.
  - Must keep proving one-click Home/default/normal creation, raw xterm input, reconnect/controller transfer, safe multiline paste, stopped-history read-only behavior, mobile keys/layout, session-metadata XSS resistance, API plain-text error handling, and the absence of removed controls and creation forms.

## Critical behavior to preserve

### Raw terminal surface

- xterm is the only browser terminal display and the only live typing path. Input must flow through the selected session's WebSocket/PTY path and output must render directly in xterm.
- Do not add a readable mirror, HTML terminal mask, command composer, command-block panel, or terminal action toolbar. The terminal grid remains the source of truth for prompt, output, selection, and scrollback.
- Preserve native xterm behavior for ANSI styling, alternate-screen programs, mouse protocols, selection, scrollback, IME, and full-screen terminal applications. Do not infer or switch presentation modes from tmux capture metadata.
- Clicking the terminal surface or selecting a live session must leave xterm focusable; mobile terminal keys must feed the same raw input path.
- Do not reconstruct Persian/English output into separate HTML lines or directional islands. Any bidi behavior is the native terminal renderer's behavior, not a second browser surface.

### Sessions

- A browser reload or WebSocket close must detach only the current attach process.
- It must not kill the tmux session.
- The UI `Clear stopped` action may purge stopped-session rows and their related block/event rows, but it must not kill active `tmux` sessions.
- Sidebar previews should come from actual tmux pane content, not fabricated state.
- Stopped session cards must remain selectable as read-only retained history; they must never attempt a WebSocket attach.
- `+ New terminal` must create immediately with an empty API request: Home directory, automatic `Terminal N` title, `default` profile, and normal non-private history. It must not open a dialog, options panel, or custom title/CWD/profile/private form.
- The browser must not expose Rename, Detach, Kill, Split, Next-pane, or custom-session controls. Their dedicated API routes are removed as well.
- Existing and recovered private sessions must not persist command markers, blocks, output, previews, capture/export text, or tmux scrollback. The browser does not create new private sessions.
- Set tmux `history-limit` before creating the real shell pane; changing it on an existing pane does not alter that pane's limit. Recovered unknown tmux sessions must never default to non-private, and a private pane whose effective limit is nonzero must stay quarantined from attach/input/capture.

### Terminal protocol and lifecycle

- Preserve `term.onBinary` and ordered text/binary reconnect queues; do not coerce binary terminal replies through UTF-8 text.
- Keep browser chunks within the server's 64 KiB byte limit without splitting Unicode code points, and measure pending capacity in bytes rather than JavaScript characters.
- Keyboard fallback must use terminal mode state and the pure mapper rather than a fixed arrow-key table.
- Keep WebSocket payload/buffer limits, ping/pong heartbeat, bounded Node/Python input queues, tmux timeouts, and idle attach-runtime teardown. Backpressure errors must be visible to the client, while tmux remains alive.
- CWD comes from a bounded base64 shell marker, is validated as an absolute existing directory, and is broadcast as `session-meta`.
- Multiline paste requires an explicit safe single-line/preserve/cancel choice outside bracketed-paste mode; trailing line breaks must never become an implicit submit.

### Legacy command-marker compatibility

- New sessions launch through the project-selected zsh-compatible shell (`WARPISH_SHELL` or `/bin/zsh`) as an explicit interactive login zsh (`-l -i`) with `WARPISH_BLOCK_INTEGRATION=0`.
- New shells emit CWD metadata only. They must not register command Start/End hooks or create new command blocks.
- Keep bounded OSC stripping and legacy SQLite/private-session recovery until tmux sessions created by older releases have been retired. That compatibility path must never reappear as a browser Blocks view, search, copy, rerun, export, or second terminal surface.
- Do not drop legacy block/event tables in place while a user's existing database may still reference them; use an explicit future migration after compatibility retirement.

### Security

- Default bind should stay local (`127.0.0.1`); code must refuse non-loopback binds unless an explicit unsafe/remote opt-in flag is set.
- The token must stay secret and untracked. Bootstrap query tokens may be used only to set an authenticated same-site cookie; frontend code should not keep relying on readable cookies or WebSocket query tokens.
- Treat this app as equivalent to Terminal.app access.
- Do not add public binding, remote tunneling, or phone access without stronger auth/TLS/network controls and explicit approval.
- Never insert runtime/user/terminal metadata with `innerHTML` or HTML template strings. Session title, cwd, preview, command text, output, and status must be rendered via DOM nodes and `textContent`/safe link builders only.
- Every security-sensitive UI fix needs a browser regression: hostile cwd/title must render literally, create no HTML nodes, and leave `window.__warpishXss` unset.

## Verification checklist before committing code changes

For backend/terminal/session changes:

```bash
node --check server.js
node --check scripts/smoke.js
node --check scripts/browser-regressions.js
python3 -m py_compile scripts/pty-worker.py
zsh -n scripts/warpish-shell-integration.zsh
bash -n start.sh stop.sh
npm test
```

For frontend changes:

```bash
node --check public/app.js
npm test
```

Then open the app in Chrome and verify at least:

- sidebar renders sessions,
- `+ New terminal` creates exactly one Home-directory, automatic-title, `default`-profile, normal-history session without opening a dialog,
- no custom creation form or terminal toolbar appears, and Blocks, Find, Rename, Copy, Export, Readable, Mouse, TUI, Split, Next, Settings, Detach, and Kill controls are absent,
- direct terminal input runs in the real shell,
- reload/reattach preserves terminal output,
- terminal output, selection, scrollback, mouse handling, and full-screen applications remain on the raw xterm path,
- multiline paste requires an explicit safe choice when bracketed-paste mode is unavailable,
- mobile terminal keys send the expected terminal sequences,
- clearing stopped session history removes stopped sidebar entries and keeps live sessions alive,
- stopped sessions remain selectable as read-only history and never attach a WebSocket,
- legacy private sessions remain fail-closed and unsafe recovered panes remain quarantined,
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
- The repo has a GitHub `origin`; scan tracked files before pushing and keep the repo private unless explicitly told otherwise.

## Preventing repeat bugs

These are hard rules for future development:

1. Runtime metadata is hostile input. Do not use `innerHTML`, `insertAdjacentHTML`, or template-generated HTML for session/title/cwd/preview/block/terminal data. Prefer `replaceChildren()`, `document.createElement()`, `textContent`, and the existing safe linkifier.
2. Any bug that lets same-origin JavaScript run is a shell-execution bug. Prove hostile metadata cannot execute before claiming a browser-terminal security fix is done.
3. Auth changes must keep tokens out of long-lived frontend-readable storage. API/WS should work via same-origin cookies after bootstrap, with Origin checks and localhost bind guards preserved.
4. Test servers must use isolated `WARPISH_DATA_DIR`, token files, session prefixes, and dynamic ports. Never let smoke/regression tests pollute the user's real `.warpish` sidebar or tmux sessions.
5. Do not reintroduce the removed terminal toolbar, block panel, reader/mode controls, pane actions, settings, or custom-session creation form without an explicit product decision.
6. Raw xterm must remain the sole terminal surface; input, selection, scrollback, mouse protocols, and full-screen applications must not be intercepted by an HTML mirror.
7. API clients must handle non-JSON errors and preserve HTTP status in the displayed message.
8. Start/stop scripts must validate process identity; do not kill arbitrary listeners just because they occupy the configured port.
9. Durable docs must not contain private resume IDs, tokens, transient ports, or stale runtime claims. Use reproducible fixtures or placeholders.
10. Before handoff, run `npm test` plus the syntax/check commands, then verify final `git status --short`.
11. One click on `+ New terminal` must issue one default creation request and must not open or inherit state from a hidden options form.
12. Legacy/private safety is fail-closed: unknown recovered sessions never default to normal history, and unsafe private panes stay quarantined.


## Known pitfalls

- The browser surface is intentionally small; reliability comes from session continuity, raw terminal semantics, paste safety, and clear failure states.
- Spawning a raw shell per WebSocket breaks resume.
- Confusing attach-process teardown with backing-session termination will destroy user work.
- Shell integration must not modify global user startup files.
- tmux capture/output boundaries are tricky; persisted backend block previews are compatibility data, not the browser terminal surface.
- Browser screenshot tooling may fail in constrained local environments; use DOM/console/API evidence as fallback.
- Keep direct xterm typing and raw xterm output as the only terminal path. Do not add an input mask, readable overlay, command-block workspace, or presentation-mode switcher.
