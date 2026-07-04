# Warpish Terminal

Local-only Chrome web terminal for this Mac, with Warp-like resumable terminal sessions.

What it does:
- Opens a modern Chrome UI with a left sidebar.
- Sidebar shows terminal session history with live/stopped state and recent preview.
- Click a live session to continue it; create a new terminal with `+ New terminal`.
- Uses real macOS PTYs and `tmux`, so browser reloads/switches do not kill the shell.
- Adds Warp-style command blocks for new sessions: command, output, status, exit code, duration, copy, search, and rerun.
- Adds a Persian/English Bidi reader and bidi-safe command composer so mixed RTL/LTR text stays readable.
- Binds to `127.0.0.1` and requires a random token stored in `.auth-token`.

Requirements already present on this Mac:
- Node.js
- `/usr/bin/python3`
- `tmux` (`/opt/homebrew/bin/tmux`)
- Google Chrome

Run:

```bash
cd ~/Documents/warpish-terminal
./start.sh
```

Stop the web server:

```bash
cd ~/Documents/warpish-terminal
./stop.sh
```

Note: stopping the web server does not necessarily kill live `tmux` sessions. Use the UI's `Kill session` button to stop a specific terminal session.

Dev/manual:

```bash
cd ~/Documents/warpish-terminal
npm start
# open the printed URL in Chrome
```

Smoke test:

```bash
cd ~/Documents/warpish-terminal
npm run smoke
```

Security notes:
- This is equivalent to Terminal.app access. Commands can modify or delete files.
- Default host is `127.0.0.1`; do not bind to `0.0.0.0` unless you add stronger auth/TLS/network allowlisting.
- If you want phone/remote access later, put it behind Tailscale/Funnel or a proper authenticated gateway, not raw public HTTP.
