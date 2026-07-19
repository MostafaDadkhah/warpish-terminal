# Warpish Terminal

Local-only Chrome web terminal for macOS, with Warp-like resumable terminal sessions.

![Warpish Terminal screenshot](docs/screenshots/warpish-terminal.png)

What it does:
- Opens a modern Chrome UI with a left sidebar.
- Sidebar shows terminal session history with live/stopped state and recent preview.
- Click a live session to continue it, or open a stopped session as read-only history. `New terminal` starts immediately in Home with an automatic title, the `default` profile, and normal history; `Options…` exposes the optional title, starting directory, profile label, and private mode.
- Clear stopped history from the sidebar without killing any live `tmux` sessions.
- Uses real macOS PTYs and `tmux`, so browser reloads/switches do not kill the shell.
- Adds Warp-style command blocks for new sessions; the block panel is hidden by default and opens only when you ask for it.
- Includes find-in-terminal, text export, rename/copy, configurable theme/font/line-height/scrollback, terminal-bell notifications, mobile Esc/Tab/Ctrl/arrow keys, and tmux pane split/next controls.
- Multiline paste is intercepted: choose a safe single-line draft, preserve line breaks explicitly, or cancel. A trailing newline never silently submits a command.
- Private sessions keep their live PTY/tmux behavior but retain no command blocks, previews, terminal capture, or scrollback (every pane is created with an effective `tmux history-limit=0`). Missing SQLite metadata is recovered conservatively from the tmux environment without exposing a preview. A recovered legacy pane whose immutable history capacity is nonzero is visibly quarantined: Warpish clears existing history and refuses attach/input/capture instead of pretending it is private-safe.
- Stores sessions, command blocks, previews, and the durable shell-event journal in the standalone `.warpish/warpish.sqlite3` database; runtime state is no longer persisted in JSON or per-session event files.
- Uses a terminal-native layout: normal xterm input goes to the real shell, while input echo and output are shown through a default readable terminal mask. When an LTR shell prompt is followed by Persian/Arabic input, the prompt stays LTR and the typed suffix becomes a compact Word-style RTL segment; English commands, paths, flags, and code stay isolated LTR islands. The readable surface keeps typing focus across old-session reattaches, handles wheel scrolling through tmux-captured history, renders safe links and ANSI/truecolor styles, and throttles redraws. State-aware fallback keys cover application-cursor mode, modifiers, F-keys, Alt/Ctrl, and binary input. Generic full-screen TUI detection temporarily switches to native display/raw mouse; `TUI: manual`, `Readable`, and `Mouse` remain explicit overrides.
- WebSocket heartbeat, byte-bounded UTF-8/binary chunking and browser/Node/Python input queues, payload limits, tmux command timeouts, and idle attach-PTY teardown keep stalled clients from growing memory while the tmux shell remains resumable. The current CWD is updated live after each prompt.
- Binds to `127.0.0.1` and requires a random token stored in `.auth-token`.

Requirements:
- macOS
- Node.js 20.12+ and npm 10+
- Python 3
- `tmux`
- zsh at `/bin/zsh` by default. Set `WARPISH_SHELL=/path/to/zsh` only if you need a different zsh-compatible shell.
- Google Chrome. Regression tests use `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` by default; set `CHROME_BIN=/path/to/chrome` for a nonstandard install.

Run:

```bash
git clone https://github.com/MostafaDadkhah/warpish-terminal.git
cd warpish-terminal
npm install
npm run service:install
./start.sh # opens the already-running service in Chrome
```

`service:install` creates a per-user macOS LaunchAgent named `com.warpish.terminal`. It starts Warpish Terminal automatically whenever you log in and restarts the Node process if it exits unexpectedly. The service stays local at `127.0.0.1:8765`; its logs are stored in `~/Library/Logs/Warpish Terminal/`.

For a one-off/manual run without installing the LaunchAgent, omit `npm run service:install` and use `./start.sh` directly.

Stop the web server:

```bash
cd warpish-terminal
./stop.sh
```

When the LaunchAgent is installed, `stop.sh` stops it for the current login session. Run `./start.sh` to load it again. To remove automatic startup permanently:

```bash
npm run service:uninstall
```

Note: stopping the web server does not necessarily kill live `tmux` sessions. Use the UI's `Kill session` button to stop a specific terminal session.

On the first start after upgrading from the file-based storage version, Warpish imports `sessions.json` and legacy event files into SQLite, then moves the originals into a timestamped `.warpish/legacy-storage-*` recovery directory. All subsequent reads and writes use SQLite.

Dev/manual:

```bash
cd warpish-terminal
npm start
# open the printed URL in Chrome
```

Tests:

```bash
cd warpish-terminal
npm test
```

`npm run smoke` checks backend/tmux/session behavior on a dynamic free local port, performs a real Node-server restart, proves tmux/SQLite/snapshot resume, and verifies private panes have zero history and no durable content even after metadata recovery. `npm run regression` starts an isolated server plus headless Chrome and guards one-click Home-directory creation, the separate Options flow, Hermes/RTL styling, controller transfer, runtime snapshots, 140KB ordered UTF-8 input, session-affine multiline paste, stopped-history read-only behavior, mobile layout, mouse/TUI modes, long scrollback, and typing flicker. `npm run check` runs guardrail lint, syntax checks, storage migration tests, and pure keyboard/input/preferences/paste tests. CI retains the complete test log for 14 days even on failure.

Security notes:
- This is equivalent to Terminal.app access. Commands can modify or delete files.
- Default host is `127.0.0.1`; the server refuses non-loopback binds unless `WARPISH_ALLOW_REMOTE=1` is explicitly set. Do not use that flag unless you add stronger auth/TLS/network allowlisting.
- Bootstrap URLs include a token, but the browser switches to a same-site HttpOnly cookie for normal API/WebSocket use. If you want phone/remote access later, put it behind Tailscale/Funnel or a proper authenticated gateway, not raw public HTTP.
