#!/usr/bin/env python3
"""Tiny PTY bridge for Warpish Terminal.

The Node server keeps HTTP/WebSocket handling. This helper owns the real macOS
pseudo-terminal using Python's stdlib pty module. It can either launch a raw
login shell or attach to a tmux session. The tmux path is what gives the web UI
Warp-like resumable sessions.
"""

import argparse
import base64
import binascii
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


DEFAULT_MAX_PENDING_INPUT_BYTES = 1024 * 1024


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
    parser.add_argument("--max-pending-input-bytes", type=int, default=DEFAULT_MAX_PENDING_INPUT_BYTES)
    args = parser.parse_args()
    max_pending_input_bytes = max(1, min(args.max_pending_input_bytes, 64 * 1024 * 1024))

    env = dict(os.environ)
    env["TERM"] = os.environ.get("TERM", "xterm-256color")
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
    fcntl.fcntl(stdin_fd, fcntl.F_SETFL, fcntl.fcntl(stdin_fd, fcntl.F_GETFL) | os.O_NONBLOCK)
    pending_input = bytearray()
    control_input = bytearray()
    max_control_input_bytes = max(256 * 1024, min(max_pending_input_bytes * 2, 64 * 1024 * 1024))

    def handle_control_line(line):
        try:
            message = json.loads(line.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            emit({
                "type": "error",
                "code": "invalid-control-message",
                "message": "PTY worker received an invalid control message.",
            })
            return
        if not isinstance(message, dict):
            return

        msg_type = message.get("type")
        if msg_type == "input":
            try:
                payload = base64.b64decode(message.get("data", ""), validate=True)
            except (TypeError, ValueError, binascii.Error):
                emit({
                    "type": "error",
                    "code": "invalid-input-base64",
                    "message": "PTY worker input was not valid base64.",
                })
                return
            if payload:
                if len(payload) > max_pending_input_bytes - len(pending_input):
                    emit({
                        "type": "error",
                        "code": "input-backpressure",
                        "message": "PTY input queue is full; wait for the terminal to catch up and try again.",
                        "pendingBytes": len(pending_input),
                        "limitBytes": max_pending_input_bytes,
                    })
                    return
                pending_input.extend(payload)
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

    while True:
        exit_msg = child_exit_status(pid)
        if exit_msg:
            emit(exit_msg)
            return

        try:
            readable, writable, _ = select.select(
                [master_fd, stdin_fd],
                [master_fd] if pending_input else [],
                [],
                0.1,
            )
        except InterruptedError:
            continue

        if master_fd in writable and pending_input:
            try:
                written = os.write(master_fd, pending_input)
                if written > 0:
                    del pending_input[:written]
            except (BlockingIOError, InterruptedError):
                pass
            except OSError as error:
                pending_input.clear()
                emit({
                    "type": "error",
                    "code": "input-write-failed",
                    "message": "PTY rejected queued input: {}".format(error),
                })

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
            stdin_closed = False
            while True:
                try:
                    chunk = os.read(stdin_fd, 65536)
                except (BlockingIOError, InterruptedError):
                    break
                if not chunk:
                    stdin_closed = True
                    break
                if len(control_input) + len(chunk) > max_control_input_bytes:
                    control_input.clear()
                    emit({
                        "type": "error",
                        "code": "control-input-backpressure",
                        "message": "PTY worker control input exceeded its bounded buffer.",
                    })
                    continue
                control_input.extend(chunk)

            while True:
                newline = control_input.find(b"\n")
                if newline < 0:
                    break
                line = bytes(control_input[:newline]).rstrip(b"\r")
                del control_input[:newline + 1]
                if line:
                    handle_control_line(line)

            if stdin_closed:
                try:
                    os.kill(pid, signal.SIGHUP)
                except ProcessLookupError:
                    pass
                return


if __name__ == "__main__":
    main()
