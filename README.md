# Warpish Terminal

Local-only Chrome web terminal for macOS, with Warp-like resumable terminal sessions.

What it does:
- Opens a modern Chrome UI with a left sidebar.
- Sidebar shows terminal session history with live/stopped state and recent preview.
- Click a live session to continue it, or open a stopped session as read-only history.
- Close and permanently remove an individual terminal with the `×` button on its sidebar card. Closing a live terminal asks for confirmation because its running processes will be terminated.
- `New terminal` starts immediately in Home with an automatic title, the `default` profile, and normal history. There is no creation form or custom title/directory/profile/private option in the browser UI.
- Clear stopped history from the sidebar without killing any live `tmux` sessions.
- Uses real macOS PTYs and `tmux`, so browser reloads/switches do not kill the shell.
- Keeps the main workspace deliberately minimal: one raw xterm surface with no terminal action toolbar.
- Mouse-wheel and trackpad scrolling move through tmux scrollback without recalling older shell commands.
- Includes mobile Esc/Tab/Ctrl/arrow keys.
- Multiline paste is intercepted: choose a safe single-line draft, preserve line breaks explicitly, or cancel. A trailing newline never silently submits a command.
- The browser no longer creates private sessions. Existing or recovered legacy private sessions remain fail-closed: Warpish suppresses retained content, clears recoverable history, and refuses attach/input/capture when a pane cannot satisfy the zero-history privacy boundary.
- Stores sessions, previews, and backend-only command/event compatibility records in the standalone `.warpish/warpish.sqlite3` database; runtime state is no longer persisted in JSON or per-session event files.
- Normal xterm input and output stay on the real PTY path. State-aware fallback keys cover application-cursor mode, modifiers, function keys, Alt/Ctrl, and binary input without introducing a separate composer or display layer.
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

Note: stopping the web server does not necessarily kill live `tmux` sessions. Manage those sessions directly with `tmux` when you intentionally want to stop them.

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

`npm run smoke` checks backend/tmux/session behavior on a dynamic free local port, performs a real Node-server restart, proves tmux/SQLite/snapshot resume, and verifies that legacy private panes remain fail-closed even after metadata recovery. `npm run regression` starts an isolated server plus headless Chrome and guards one-click Home/default/normal creation, raw xterm input, wheel-to-tmux scrollback without shell-history arrows, controller transfer, runtime snapshots, ordered large UTF-8 input, session-affine multiline paste, stopped-history read-only behavior, mobile keys/layout, and the absence of the removed toolbar and creation form. `npm run check` runs guardrail lint, syntax checks, storage migration tests, and pure keyboard/input/paste tests. CI retains the complete test log for 14 days even on failure.

Security notes:
- This is equivalent to Terminal.app access. Commands can modify or delete files.
- Default host is `127.0.0.1`; the server refuses non-loopback binds unless `WARPISH_ALLOW_REMOTE=1` is explicitly set. Do not use that flag unless you add stronger auth/TLS/network allowlisting.
- Bootstrap URLs include a token, but the browser switches to a same-site HttpOnly cookie for normal API/WebSocket use. The cookie lasts 30 days and is renewed while the app stays open, so long-running terminal tabs do not silently lose close/input access. If you want phone/remote access later, put it behind Tailscale/Funnel or a proper authenticated gateway, not raw public HTTP.
