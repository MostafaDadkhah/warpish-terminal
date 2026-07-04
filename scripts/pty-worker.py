#!/usr/bin/env python3
"""Tiny PTY bridge for Warpish Terminal.

The Node server keeps HTTP/WebSocket handling. This helper owns the real macOS
pseudo-terminal using Python's stdlib pty module. It can either launch a raw
login shell or attach to a tmux session. The tmux path is what gives the web UI
Warp-like resumable sessions.
"""

import argparse
import base64
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import time


def emit(message):
    sys.stdout.buffer.write(json.dumps(message, separators=(",", ":")).encode("utf-8") + b"\n")
    sys.stdout.buffer.flush()


def set_winsize(fd, cols, rows):
    cols = max(20, min(int(cols), 300))
    rows = max(5, min(int(rows), 120))
    packed = struct.pack("HHHH", rows, cols, 0, 0)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, packed)


def child_exit_status(pid):
    try:
        waited_pid, status = os.waitpid(pid, os.WNOHANG)
    except ChildProcessError:
        return {"type": "exit", "exitCode": None, "signal": None}
    if waited_pid == 0:
        return None
    if os.WIFEXITED(status):
        return {"type": "exit", "exitCode": os.WEXITSTATUS(status), "signal": None}
    if os.WIFSIGNALED(status):
        return {"type": "exit", "exitCode": None, "signal": os.WTERMSIG(status)}
    return {"type": "exit", "exitCode": None, "signal": None}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--shell", required=True)
    parser.add_argument("--cwd", required=True)
    parser.add_argument("--cols", type=int, default=120)
    parser.add_argument("--rows", type=int, default=36)
    parser.add_argument("--tmux-bin", default="tmux")
    parser.add_argument("--tmux-session")
    args = parser.parse_args()

    env = dict(os.environ)
    env["TERM"] = "xterm-256color"
    env["COLORTERM"] = "truecolor"
    env["WARPISH_TERMINAL"] = "1"
    # The web PTY is not itself inside the user's terminal, so never inherit
    # a parent TMUX marker from the launcher.
    env.pop("TMUX", None)

    pid, master_fd = pty.fork()
    if pid == 0:
        try:
            os.chdir(args.cwd)
        except Exception:
            os.chdir(os.path.expanduser("~"))

        if args.tmux_session:
            os.execvpe(args.tmux_bin, [args.tmux_bin, "attach-session", "-t", args.tmux_session], env)
        else:
            os.execvpe(args.shell, [args.shell, "-l"], env)

    set_winsize(master_fd, args.cols, args.rows)
    os.kill(pid, signal.SIGWINCH)
    fcntl.fcntl(master_fd, fcntl.F_SETFL, fcntl.fcntl(master_fd, fcntl.F_GETFL) | os.O_NONBLOCK)
    emit({"type": "ready", "pid": pid})

    stdin_fd = sys.stdin.fileno()

    while True:
        exit_msg = child_exit_status(pid)
        if exit_msg:
            emit(exit_msg)
            return

        try:
            readable, _, _ = select.select([master_fd, stdin_fd], [], [], 0.1)
        except InterruptedError:
            continue

        if master_fd in readable:
            try:
                data = os.read(master_fd, 8192)
            except BlockingIOError:
                data = b""
            except OSError:
                data = b""
            if data:
                emit({"type": "output", "data": base64.b64encode(data).decode("ascii")})
            else:
                time.sleep(0.03)

        if stdin_fd in readable:
            line = sys.stdin.buffer.readline()
            if not line:
                try:
                    os.kill(pid, signal.SIGHUP)
                except ProcessLookupError:
                    pass
                return
            try:
                message = json.loads(line.decode("utf-8"))
            except json.JSONDecodeError:
                continue

            msg_type = message.get("type")
            if msg_type == "input":
                payload = base64.b64decode(message.get("data", ""))
                if payload:
                    os.write(master_fd, payload)
            elif msg_type == "resize":
                set_winsize(master_fd, message.get("cols", args.cols), message.get("rows", args.rows))
                try:
                    os.kill(pid, signal.SIGWINCH)
                except ProcessLookupError:
                    pass
            elif msg_type == "kill":
                try:
                    os.kill(pid, signal.SIGHUP)
                except ProcessLookupError:
                    pass


if __name__ == "__main__":
    main()
