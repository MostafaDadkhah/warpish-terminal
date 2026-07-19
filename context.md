# Project context: Warpish Terminal

## Purpose

Warpish Terminal is a local-only Chrome web interface for a real macOS shell. Its product surface is intentionally small: resumable terminal sessions, sidebar history, and one raw xterm workspace.

This project gives the browser the same practical power as Terminal.app. Treat every change as security-sensitive.

## Current product state

Implemented capabilities:

- Chrome UI served by a local Node/Express backend.
- Real PTY-backed terminal I/O through a Python PTY worker.
- `tmux`-backed terminal sessions, so browser refresh/detach does not kill the shell.
- Sidebar session history with:
  - live/stopped state,
  - attached count,
  - recent output preview,
  - click-to-reattach behavior for live sessions and read-only preview for stopped sessions,
  - clear-stopped-history control that purges only stopped SQLite session/block/event rows and keeps live `tmux` sessions running.
- Raw xterm typing, input echo, output, selection, scrollback, mouse handling, and full-screen terminal applications stay on the native PTY path. There is no readable overlay, input-mask section, composer, or terminal action toolbar.
- One-click `New terminal` creation always uses Home, an automatic `Terminal N` title, the `default` profile, and normal history. The browser has no custom title, CWD, profile, or private-session creation form.
- Mobile Esc/Tab/Ctrl/arrow accessory keys and state-aware keyboard/binary-input forwarding for terminal protocols.
- Safe multiline paste with an explicit single-line/preserve/cancel choice and no implicit submit from trailing line breaks.
- Bounded input queues/payloads across browser, WebSocket, Node, and Python; WebSocket heartbeat; tmux timeouts; idle attach-PTY teardown; and live CWD metadata updates.
- No Blocks, Find, Rename, Copy, Export, Readable, Mouse, TUI, Split, Next, Settings, Detach, or Kill controls in the terminal workspace.
- Existing and recovered legacy private sessions remain fail-closed. A private pane with an unsafe immutable history capacity is quarantined from attach/input/capture rather than treated as safe.
- Local token auth, with token stored in `.auth-token` and sent by URL/cookie/header.
- Git repository initialized on `main` with runtime files ignored.

## Architecture

Main files:

- `server.js` — Express server, WebSocket endpoint, session API, tmux orchestration, legacy marker compatibility, auth, and static assets.
- `storage.js` — standalone SQLite schema and transactional persistence for sessions, command blocks, previews, and the shell-event journal.
- `scripts/record-shell-event.py` — retained SQLite event recorder for CWD updates and sessions created by older releases.
- `scripts/pty-worker.py` — Python worker that owns the attach PTY and bridges PTY I/O to the Node process.
- `scripts/warpish-shell-integration.zsh` — scoped zsh integration that emits live CWD updates; command start/end hooks are disabled for new sessions.
- `public/index.html` — app shell markup.
- `public/app.js` — browser state, WebSocket handling, raw xterm.js integration, session list, safe paste, and mobile key handling.
- `public/terminal-key-data.js` — pure state-aware terminal key-sequence mapping.
- `public/terminal-input.js` — pure byte-aware UTF-8/binary chunking shared by the bounded browser input queue.
- `public/styles.css` — visual design for the sidebar, raw terminal, dialogs, and mobile accessory keys.
- `scripts/smoke.js` — end-to-end smoke test for server health, isolated session creation, reconnect, real web-server restart/resume, backend persistence, legacy-private safety, and stopped-history cleanup.
- `scripts/browser-regressions.js` — isolated headless Chrome/CDP regression suite for one-click creation, raw terminal I/O, session switching, paste safety, mobile layout, hostile metadata, and browser error handling.
- `start.sh` / `stop.sh` — local lifecycle helpers.
- `README.md` — user-facing run/security notes.
- `.gitignore` — excludes runtime state, token, logs, and dependencies.

Runtime/local files intentionally ignored by git:

- `.auth-token`
- `.server.pid`
- `.warpish/`
- `*.log`
- `node_modules/`

## Important implementation decisions

### 1. Persistence boundary is tmux

A raw shell per WebSocket would die on browser reload. The backend creates stable `tmux` sessions and attaches browser clients to them through a PTY. Closing/reloading the browser detaches only the attach process; the shell session survives.

Important behavior:

- Create session: backend starts a detached `tmux` session.
- Attach session: backend starts `tmux attach-session` inside `scripts/pty-worker.py`.
- Browser close, reload, or WebSocket close stops only the attach process; there is no explicit Detach control.
- The browser UI has no Kill control. Intentional shell termination is handled outside the simplified terminal workspace, for example through `tmux` or the retained API.
- Clear stopped history: UI/API removes only stopped-session rows and their related block/event rows from SQLite; it does not kill active `tmux` sessions.
- Previews: backend uses `tmux capture-pane` for sidebar previews and smoke-test resume evidence.
- Attach PTYs are shared per session while clients are present, then torn down after an idle grace period; this never kills the backing tmux session.
- WebSocket controller/spectator leases, heartbeat, bounded queues, and runtime snapshots protect fidelity and memory during reconnects or slow clients.
- tmux pane history limits are applied before the real shell pane is created; every pane belonging to a private session must have zero history, and unknown recovered sessions default to private unless tmux explicitly marks them otherwise. Existing panes with nonzero immutable history capacity are quarantined and cannot be attached through Warpish.

### 2. Shell integration is limited to terminal metadata

The backend launches new sessions with an isolated `ZDOTDIR`, sources the user's normal zsh startup files, and then loads `scripts/warpish-shell-integration.zsh`. New sessions set `WARPISH_BLOCK_INTEGRATION=0`, so no command Start/End hooks or new command blocks are produced. The prompt hook emits only bounded CWD metadata.

The legacy parser, recorder, and SQLite block/event tables remain temporarily so already-running tmux shells from older releases can be drained without leaking OSC marker text or breaking private-session recovery. They are compatibility storage, not a product feature or browser surface.

### 3. Raw xterm is the only terminal surface

Normal typing, input echo, output, selection, scrollback, mouse protocols, alternate-screen applications, and terminal escape sequences all remain on xterm's native PTY path. The browser does not add a readable mirror, mouse/TUI mode switcher, command composer, or block panel over that surface.

The xterm helper textarea remains the focus/input target, state-aware key mapping remains available for browser-generated fallback input, and the resize observer continues to fit the terminal and report bounded dimensions to the active WebSocket session. Mobile accessory keys feed the same terminal input path.

### 4. Security defaults are intentionally local

The app binds to `127.0.0.1` by default and requires a random local token. Non-loopback binds are refused in code unless `WARPISH_ALLOW_REMOTE=1` is explicitly set; if remote/mobile access is added later, put it behind an authenticated private network or gateway with stronger auth/TLS/allowlisting.

Private mode remains a backend/legacy persistence boundary, not an authentication mode. The simplified browser does not create new private sessions, but existing or recovered private sessions still suppress markers, block/output/preview storage, capture/export content, and tmux history. Unsafe legacy panes are quarantined instead of attached.

### 5. Git hygiene

The repository tracks source, docs, scripts, and lockfiles only. It must not track local runtime state, terminal history, generated tokens, logs, or `node_modules`.

## Verification gates

The smoke suite runs with an isolated runtime directory, token, tmux namespace, and dynamic port. It covers health/readiness, real PTY input, reconnect, a full Node-server restart while tmux stays alive, SQLite persistence, live CWD updates, stopped-history cleanup, and fail-closed private-session recovery.

The browser suite uses an isolated Chrome profile and verifies:

- the sidebar and raw xterm surface load without console/runtime errors,
- `New terminal` creates exactly one Home/default/normal session with an automatic title and no dialog,
- the removed toolbar, Blocks panel, Settings dialog, and custom creation controls are absent,
- direct text and binary input remain ordered through WebSocket reconnect/control transitions,
- reload and session switching preserve the resumable tmux workflow,
- stopped history stays read-only,
- multiline paste never submits implicitly and is cancelled if the selected session changes,
- mobile accessory keys and narrow/short layouts remain usable,
- hostile session metadata renders as text rather than executable markup.

## Current limitations / future work

- This is not a full Warp clone; it implements the core local workflow primitives first.
- The browser intentionally exposes no terminal toolbar or Blocks/Find/Rename/Copy/Export/Readable/Mouse/TUI/Split/Next/Settings/Detach/Kill actions.
- Browser-created sessions always use Home, an automatic title, the `default` profile, and normal history.
- Legacy shell-event/block parsing remains only to retire already-running older tmux shells safely; new sessions do not record command blocks.
- Existing private sessions are supported only through fail-closed legacy/backend handling; the browser does not create new private sessions.
- Multi-user auth, TLS, public exposure, and remote/mobile access are intentionally not implemented yet.
- Git remote `origin` points at the project GitHub repository; keep the repo private unless explicitly told otherwise.
