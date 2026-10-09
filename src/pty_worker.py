"""A stdlib POSIX PTY bridge. stdin/stdout use NDJSON, never shell commands."""
import base64
import errno
import json
import os
import select
import signal
import subprocess
import sys
import tempfile


def emit(value):
    print(json.dumps(value), flush=True)


def main():
    if os.name != "posix":
        raise RuntimeError("This experimental driver requires macOS/Linux, Python 3 and OpenSSH")
    import fcntl
    import pty
    import struct
    import termios

    config = json.loads(sys.stdin.readline())
    state_dir = config["stateDir"]
    os.makedirs(state_dir, mode=0o700, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="hf-ssh-") as temporary:
        identity = os.path.join(temporary, "identity")
        subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C",
                        "magpie-hf-ssh-anonymous", "-f", identity], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=10)
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ,
                    struct.pack("HHHH", config["rows"], config["cols"], 0, 0))
        command = ["ssh", "-tt", "-F", "/dev/null", "-p", str(config.get("port", 22)),
                   "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
                   "-o", "ConnectionAttempts=1", "-o", "ServerAliveInterval=10",
                   "-o", "ServerAliveCountMax=2", "-o", "StrictHostKeyChecking=accept-new",
                   "-o", "UserKnownHostsFile=" + os.path.join(state_dir, "known_hosts"),
                   "-o", "GlobalKnownHostsFile=/dev/null", "-o", "IdentityAgent=none",
                   "-o", "IdentitiesOnly=yes", "-i", identity,
                   "-o", "ClearAllForwardings=yes", "-o", "ForwardAgent=no",
                   config.get("user", "guest") + "@" + config.get("host", "chat.hf.co")]
        process = subprocess.Popen(command, stdin=slave, stdout=slave, stderr=slave,
                                   env={**os.environ, "TERM": "xterm-256color"})
        os.close(slave)

        def stop(*_):
            raise KeyboardInterrupt()

        signal.signal(signal.SIGTERM, stop)
        pending = b""
        try:
            while True:
                readable, _, _ = select.select([master, sys.stdin.fileno()], [], [], 0.2)
                if master in readable:
                    try:
                        data = os.read(master, 65536)
                    except OSError as error:
                        if error.errno == errno.EIO:
                            break
                        raise
                    if not data:
                        break
                    emit({"data": base64.b64encode(data).decode()})
                if sys.stdin.fileno() in readable:
                    data = os.read(sys.stdin.fileno(), 65536)
                    if not data:
                        break
                    pending += data
                    while b"\n" in pending:
                        line, pending = pending.split(b"\n", 1)
                        message = json.loads(line)
                        if message.get("close"):
                            return
                        payload = base64.b64decode(message["data"])
                        while payload:
                            size = os.write(master, payload)
                            payload = payload[size:]
                if process.poll() is not None and not readable:
                    break
        except KeyboardInterrupt:
            pass
        finally:
            process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
            os.close(master)
            emit({"exit": process.returncode})


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        emit({"error": str(error)})
        sys.exit(1)
