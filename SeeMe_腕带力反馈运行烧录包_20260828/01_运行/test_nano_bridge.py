#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""nano_bridge.py 自测：模拟浏览器 WebSocket 客户端，验证握手 + 命令解析。"""
import base64
import hashlib
import os
import socket
import subprocess
import sys
import time

BRIDGE = os.path.join(os.path.dirname(__file__), "nano_bridge.py")
WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


def ws_connect(port=8790):
    sock = socket.create_connection(("127.0.0.1", port), timeout=3)
    key = base64.b64encode(os.urandom(16)).decode()
    req = (
        "GET / HTTP/1.1\r\n"
        f"Host: 127.0.0.1:{port}\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\n"
        "Sec-WebSocket-Version: 13\r\n"
        "\r\n"
    )
    sock.sendall(req.encode())
    buf = b""
    while b"\r\n\r\n" not in buf:
        buf += sock.recv(4096)
    header, rest = buf.split(b"\r\n\r\n", 1)
    expect = base64.b64encode(hashlib.sha1((key + WS_MAGIC).encode()).digest())
    if b"101" not in header.split(b"\r\n")[0] or expect not in header:
        raise AssertionError(f"handshake failed: {header!r}")
    return sock, rest


def ws_send_masked(sock, text):
    payload = text.encode()
    mask = b"\x11\x22\x33\x44"
    masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    sock.sendall(bytes([0x81, 0x80 | len(payload)]) + mask + masked)


def ws_recv(sock, timeout=3.0):
    sock.settimeout(timeout)
    buf = b""
    while True:
        if len(buf) >= 2:
            ln = buf[1] & 0x7F
            total = 2 + ln
            while len(buf) < total:
                buf += sock.recv(4096)
            return buf[2:total].decode("utf-8", "replace")
        buf += sock.recv(4096)


def main():
    proc = subprocess.Popen(
        [sys.executable, BRIDGE, "--dummy", "--port", "8790"],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    try:
        time.sleep(1.2)
        print("[test] connecting...")
        sock, rest = ws_connect(8790)
        ready = ws_recv(sock)
        print("[test] ready msg:", ready)
        assert '"type": "ready"' in ready, ready

        cases = [
            ("3", "3"),
            ("1", "1"),
            ("2", "2"),
            ("0", "0"),
            ("off", "0"),
            ("strong", "3"),
            ("vibrate", "3"),
            ('{"level": 3}', "3"),
            ('{"level": 2}', "2"),
            ('{"cmd": "0"}', "0"),
            ('{"vibrate": true}', "3"),
            ('{"vibrate": false}', "0"),
            ("garbage", "error"),
        ]
        for raw, expect in cases:
            ws_send_masked(sock, raw)
            resp = ws_recv(sock)
            ok = (expect == "error" and '"type": "error"' in resp) or (
                expect in resp
            )
            print(f"[test] send={raw!r:26} -> {resp}  {'OK' if ok else 'FAIL'}")
            if not ok:
                raise AssertionError(f"case failed: {raw} -> {resp}")

        # ping → pong
        sock.sendall(bytes([0x89, 1, 0x01]))
        sock.settimeout(2)
        b = sock.recv(4096)
        assert b and b[0] == 0x8A, f"pong expected, got {b!r}"
        print("[test] ping->pong OK")

        ws_send_masked(sock, "3")
        ws_recv(sock)
        sock.close()
        print("[test] ALL PASS")
    finally:
        proc.terminate()
        try:
            out, _ = proc.communicate(timeout=3)
            print("---- bridge output ----")
            print(out[-2000:])
        except Exception:
            proc.kill()


if __name__ == "__main__":
    main()
