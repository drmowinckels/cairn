#!/usr/bin/env python3
"""Throwaway spike listener: a stand-in for Cairn's IPC socket.

Binds an AF_UNIX stream socket at argv[1], accepts connections in a loop,
and appends every received line to argv[2]. Runs until SIGTERM/SIGINT.

This lets the unsandboxed control run prove the probe + path + socket all
work end-to-end, so the only variable left in the sandboxed run is the
App Sandbox entitlement itself.
"""
import os
import signal
import socket
import sys


def main() -> int:
    if len(sys.argv) != 3:
        sys.stderr.write("usage: listener.py <socket-path> <log-path>\n")
        return 2
    sock_path, log_path = sys.argv[1], sys.argv[2]

    try:
        os.unlink(sock_path)
    except FileNotFoundError:
        pass
    os.makedirs(os.path.dirname(sock_path), exist_ok=True)

    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    srv.bind(sock_path)
    srv.listen(8)

    running = True

    def stop(_signum, _frame):
        nonlocal running
        running = False
        srv.close()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    # Signal readiness by touching the log file so the harness can wait.
    open(log_path, "a").close()

    with open(log_path, "a", buffering=1) as log:
        while running:
            try:
                conn, _ = srv.accept()
            except OSError:
                break
            with conn:
                data = conn.recv(65536)
                if data:
                    log.write(f"RECV {data!r}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
