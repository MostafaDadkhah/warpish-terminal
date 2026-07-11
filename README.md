# Warpish Terminal

Local-only Chrome web terminal for macOS, with Warp-like resumable terminal sessions.

![Warpish Terminal screenshot](docs/screenshots/warpish-terminal.png)

What it does:
- Opens a modern Chrome UI with a left sidebar.
- Sidebar shows terminal session history with live/stopped state and recent preview.
- Click a live session to continue it; create a new terminal with `+ New terminal`.
- Clear stopped history from the sidebar without killing any live `tmux` sessions.
- Uses real macOS PTYs and `tmux`, so browser reloads/switches do not kill the shell.
- Adds Warp-style command blocks for new sessions; the block panel is hidden by default and opens only when you ask for it.
- Uses a terminal-native layout: normal xterm input goes to the real shell, while input echo and output are shown through a default readable terminal mask. When an LTR shell prompt is followed by Persian/Arabic input, the prompt stays LTR and the typed suffix becomes a compact Word-style RTL segment; English commands, paths, flags, and code stay isolated LTR islands. The readable surface keeps typing focus across old-session reattaches, sends readable-mode keystrokes directly to the backing tmux pane when xterm attach input is stale, handles wheel scrolling through tmux-captured history instead of shell history, turns visible `http(s)`/`www` links into safe new-tab anchors, preserves live xterm and tmux-captured ANSI/truecolor styles, dims inline suggestions after the cursor, keeps tmux-captured full-screen/alternate-screen apps such as Hermes visible instead of showing an empty waiting overlay, and throttles redraws to avoid streaming flicker. You can toggle back to raw xterm with `Readable: off` for edge-case TUIs, or use `Mouse: raw` to keep the readable mask visible while passing mouse events through to xterm/TUI apps.
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
./start.sh
```

Stop the web server:

```bash
cd warpish-terminal
./stop.sh
```

Note: stopping the web server does not necessarily kill live `tmux` sessions. Use the UI's `Kill session` button to stop a specific terminal session.

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

`npm run smoke` checks backend/tmux/session behavior on a dynamic free local port. `npm run regression` starts an isolated server plus headless Chrome and guards the readable-terminal/security regressions that caused previous bugs: Hermes palette ANSI styles, safe readable links, hostile session-metadata XSS, API plain-text error handling, mobile toolbar/blocks layout, reader/raw mouse modes, empty-reader blanking, long Hermes scrollback readability, and stale-capture flicker while typing. `npm run check` runs guardrail lint plus syntax checks.

Security notes:
- This is equivalent to Terminal.app access. Commands can modify or delete files.
- Default host is `127.0.0.1`; the server refuses non-loopback binds unless `WARPISH_ALLOW_REMOTE=1` is explicitly set. Do not use that flag unless you add stronger auth/TLS/network allowlisting.
- Bootstrap URLs include a token, but the browser switches to a same-site HttpOnly cookie for normal API/WebSocket use. If you want phone/remote access later, put it behind Tailscale/Funnel or a proper authenticated gateway, not raw public HTTP.
