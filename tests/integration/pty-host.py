#!/usr/bin/env python3
"""Host one Pi process in a pseudo-terminal for the integration driver.

Usage: pty-host.py CONFIG_JSON

CONFIG_JSON names: argv, env, cwd, control (file the probe appends key requests to), transcript
(file receiving raw terminal output), timeoutSeconds, rows, cols.

The probe inside Pi drives the scenario. To press keys it appends lines `{"send": "<base64>"}` to the
control file; this host writes those bytes to the terminal, exactly as a user's keystrokes arrive.
Prints one JSON line with the exit status (or timeout) when Pi exits.
"""

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


def main() -> int:
    config = json.loads(open(sys.argv[1], encoding="utf-8").read())
    control_path = config["control"]
    open(control_path, "a").close()

    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(config["cwd"])
        os.execve(config["argv"][0], config["argv"], config["env"])

    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", config.get("rows", 40), config.get("cols", 120), 0, 0))
    deadline = time.monotonic() + config.get("timeoutSeconds", 60)
    offset = 0
    pending = b""
    status = None
    timed_out = False
    with open(config["transcript"], "wb") as transcript, open(control_path, "rb") as control:
        while True:
            if time.monotonic() > deadline:
                timed_out = True
                os.kill(pid, signal.SIGKILL)
                break

            control.seek(offset)
            chunk = control.read()
            if chunk:
                offset += len(chunk)
                pending += chunk
                *lines, pending = pending.split(b"\n")
                for line in lines:
                    if line.strip():
                        os.write(fd, base64.b64decode(json.loads(line)["send"]))

            readable, _, _ = select.select([fd], [], [], 0.01)
            if readable:
                try:
                    data = os.read(fd, 65536)
                except OSError:
                    data = b""
                if not data:
                    break
                transcript.write(data)
                transcript.flush()

            done, raw_status = os.waitpid(pid, os.WNOHANG)
            if done:
                status = raw_status
                break

    if status is None:
        try:
            _, status = os.waitpid(pid, 0)
        except ChildProcessError:
            pass
    try:
        os.close(fd)
    except OSError:
        pass

    exit_code = os.waitstatus_to_exitcode(status) if status is not None else None
    print(json.dumps({"exitCode": exit_code, "timedOut": timed_out}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
