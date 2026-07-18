#!/usr/bin/env python3
"""Persist a Warpish shell marker in SQLite without using sidecar event files."""

import argparse
import sqlite3


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--database", required=True)
    parser.add_argument("--session-id", required=True)
    parser.add_argument("--payload", required=True)
    args = parser.parse_args()

    with sqlite3.connect(args.database, timeout=5.0) as connection:
        connection.execute("PRAGMA busy_timeout = 5000")
        connection.execute(
            "INSERT INTO shell_events (session_id, payload) VALUES (?, ?)",
            (args.session_id, args.payload),
        )


if __name__ == "__main__":
    main()
