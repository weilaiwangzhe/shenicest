#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
nano_bridge.py — 摄像头 → 腕带震动 本地桥接

软件端（shenicest-main Web 应用）检测到「手离开指定化妆区域」后，
通过 WebSocket 向本桥发送震动命令；本桥把命令转发给 Nano 震动串口。

链路：
    浏览器摄像头(HandLandmarker 手部检测)
        → 手离开化妆区域
        → WebSocket ws://127.0.0.1:8787  命令 '0'~'3'
        → nano_bridge.py
        → Nano 串口 (250000 baud)  → 马达震动

命令协议（文本，宽松解析）：
    '0' / 'off' / 'stop'            → 关
    '1' / '2' / '3'                 → 弱 / 中 / 强
    'on' / 'vibrate'                → 强（等价 '3'）
    '{"level": 3}' / '{"cmd":"3"}' / '{"vibrate":true}' → JSON 形式

安全：
    - 默认只监听 127.0.0.1（本机），--host 可放开局域网
    - Nano 固件自带 3 秒无命令自动关断：即使浏览器/桥异常退出，马达也会自动停

用法：
    python nano_bridge.py                    # 自动识别 Nano 端口
    python nano_bridge.py --nano-port COM9   # 手动指定端口
    python nano_bridge.py --dummy            # 不连串口，只打印命令（无硬件自测）
    python nano_bridge.py --port 8788        # 改 WebSocket 端口
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import socket
import threading
import time

try:
    import serial
    from detect_ports import PortDetectionError, resolve_nano_port
except Exception as exc:  # pragma: no cover - 只在缺依赖时报错
    serial = None
    resolve_nano_port = None
    PortDetectionError = RuntimeError
    _IMPORT_ERROR = exc
else:
    _IMPORT_ERROR = None

WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
DEFAULT_WS_HOST = "127.0.0.1"
DEFAULT_WS_PORT = 8787
NANO_BAUD = 250000


# ───────────────────────── WebSocket 极简服务端 ─────────────────────────

def _sha1_accept(key: str) -> str:
    digest = hashlib.sha1((key.strip() + WS_MAGIC).encode("ascii")).digest()
    return base64.b64encode(digest).decode("ascii")


def _recv_exact(conn: socket.socket, n: int) -> bytes:
    chunks = []
    remaining = n
    while remaining > 0:
        chunk = conn.recv(remaining)
        if not chunk:
            raise ConnectionError("client closed during receive")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def _read_http_headers(conn: socket.socket, buf: bytearray) -> str:
    """读到 \r\n\r\n，返回请求头文本。"""
    while b"\r\n\r\n" not in buf:
        chunk = conn.recv(4096)
        if not chunk:
            raise ConnectionError("client closed during handshake")
        buf.extend(chunk)
        if len(buf) > 64 * 1024:
            raise ValueError("handshake header too large")
    idx = buf.index(b"\r\n\r\n")
    header = bytes(buf[:idx]).decode("latin-1")
    del buf[: idx + 4]
    return header


def _ws_accept_header(header: str) -> str:
    key = None
    for line in header.split("\r\n"):
        if line.lower().startswith("sec-websocket-key:"):
            key = line.split(":", 1)[1].strip()
            break
    if not key:
        raise ValueError("missing Sec-WebSocket-Key")
    accept = _sha1_accept(key)
    return (
        "HTTP/1.1 101 Switching Protocols\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Accept: {accept}\r\n"
        "\r\n"
    )


def _parse_ws_frame(buf: bytes):
    """解析一个服务端收到的帧（客户端帧必带掩码）。

    返回 (opcode, payload, consumed)；数据不足返回 (None, None, 0)。
    """
    if len(buf) < 2:
        return None, None, 0
    b0, b1 = buf[0], buf[1]
    opcode = b0 & 0x0F
    masked = bool(b1 & 0x80)
    length = b1 & 0x7F
    offset = 2
    if length == 126:
        if len(buf) < 4:
            return None, None, 0
        length = int.from_bytes(buf[2:4], "big")
        offset = 4
    elif length == 127:
        if len(buf) < 10:
            return None, None, 0
        length = int.from_bytes(buf[2:10], "big")
        offset = 10
    if masked:
        if len(buf) < offset + 4:
            return None, None, 0
        mask = buf[offset:offset + 4]
        offset += 4
    if len(buf) < offset + length:
        return None, None, 0
    payload = buf[offset:offset + length]
    if masked:
        payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    return opcode, payload, offset + length


def _ws_send_text(conn: socket.socket, text: str) -> None:
    payload = text.encode("utf-8")
    if len(payload) < 126:
        header = bytes([0x81, len(payload)])
    elif len(payload) < 65536:
        header = bytes([0x81, 126]) + len(payload).to_bytes(2, "big")
    else:
        header = bytes([0x81, 127]) + len(payload).to_bytes(8, "big")
    conn.sendall(header + payload)


# ───────────────────────── 命令解析 ─────────────────────────

def normalize_command(text: str):
    """把任意合法输入归一成 '0'~'3' 之一；非法返回 None。"""
    t = text.strip()
    if t in ("0", "1", "2", "3"):
        return t
    low = t.lower()
    if low in ("off", "stop", "halt", "quiet"):
        return "0"
    if low in ("on", "strong", "vibrate", "buzz", "alert"):
        return "3"
    if low in ("weak", "low", "soft"):
        return "1"
    if low in ("mid", "medium", "normal"):
        return "2"
    try:
        data = json.loads(t)
    except Exception:
        return None
    if isinstance(data, dict):
        if "level" in data:
            try:
                level = int(data["level"])
                return str(min(3, max(0, level)))
            except (TypeError, ValueError):
                return None
        if "cmd" in data:
            return normalize_command(str(data["cmd"]))
        if "vibrate" in data:
            return "3" if bool(data["vibrate"]) else "0"
    return None


# ───────────────────────── Nano 串口 ─────────────────────────

class NanoSerial:
    """Nano 震动串口封装：写命令 + 后台线程排空读数。"""

    def __init__(self, port: str, dummy: bool = False):
        self.port = port
        self.dummy = dummy
        self.ser = None
        self.lock = threading.Lock()
        self._drain_thread = None
        self._open()

    def _open(self):
        if self.dummy:
            print(f"[桥] dummy 模式：不打开串口，命令只打印")
            return
        print(f"[桥] 打开 Nano 震动串口: {self.port} @{NANO_BAUD}")
        self.ser = serial.Serial(self.port, NANO_BAUD, timeout=0.05)
        self.ser.reset_input_buffer()
        self._drain_thread = threading.Thread(target=self._drain, daemon=True)
        self._drain_thread.start()

    def _drain(self):
        """Nano 固件会持续输出 FSR 数据流，必须排空否则串口缓冲会被填满。"""
        while self.ser and self.ser.is_open:
            try:
                self.ser.read(4096)
            except Exception:
                return

    def send(self, cmd: str):
        if self.dummy:
            print(f"[桥] 命令 → {cmd}   (dummy)")
            return
        with self.lock:
            if self.ser is None or not self.ser.is_open:
                raise ConnectionError("Nano serial not open")
            self.ser.write(cmd.encode("ascii"))
            self.ser.flush()

    def close(self):
        if self.dummy:
            return
        if self.ser and self.ser.is_open:
            try:
                self.ser.close()
            except Exception:
                pass


# ───────────────────────── 连接处理 ─────────────────────────

def handle_connection(conn: socket.socket, addr, nano: NanoSerial, stats: dict):
    print(f"[桥] 新连接: {addr[0]}:{addr[1]}")
    buf = bytearray()
    try:
        header = _read_http_headers(conn, buf)
        conn.sendall(_ws_accept_header(header).encode("ascii"))
        # 握手成功后先告诉浏览器桥已就绪
        _ws_send_text(conn, json.dumps({"type": "ready", "nano_port": nano.port}))
        stats["clients"] += 1
        while True:
            opcode, payload, consumed = _parse_ws_frame(bytes(buf))
            if opcode is None:
                chunk = conn.recv(4096)
                if not chunk:
                    break
                buf.extend(chunk)
                if len(buf) > 256 * 1024:
                    print("[桥] 缓冲超限，丢弃")
                    buf.clear()
                continue
            del buf[:consumed]
            if opcode == 0x8:  # close
                try:
                    _ws_send_text(conn, "")  # 简单回一个空文本帧即可让对端正常关闭
                except Exception:
                    pass
                break
            if opcode == 0x9:  # ping → pong
                pong = bytes([0x8A, len(payload)]) + payload
                conn.sendall(pong)
                continue
            if opcode != 0x1:  # 非文本帧忽略
                continue
            try:
                text = payload.decode("utf-8", errors="replace").strip()
            except Exception:
                continue
            if not text:
                continue
            cmd = normalize_command(text)
            if cmd is None:
                _ws_send_text(conn, json.dumps({"type": "error", "reason": f"unknown command: {text}"}))
                continue
            try:
                nano.send(cmd)
                stats["commands"] += 1
                print(f"[桥] {time.strftime('%H:%M:%S')} 命令 → '{cmd}' (来自 {addr[0]})")
                _ws_send_text(conn, json.dumps({"type": "ack", "cmd": cmd}))
            except Exception as exc:
                print(f"[桥] 发送失败: {exc}")
                _ws_send_text(conn, json.dumps({"type": "error", "reason": str(exc)}))
    except (ConnectionError, OSError, ValueError) as exc:
        print(f"[桥] 连接结束: {addr[0]}: {exc}")
    finally:
        stats["clients"] = max(0, stats["clients"] - 1)
        try:
            conn.close()
        except Exception:
            pass


def main() -> int:
    ap = argparse.ArgumentParser(description="摄像头→腕带震动 本地桥（WebSocket→Nano 串口）")
    ap.add_argument("--nano-port", default="auto", help="Nano(震动)串口，默认 auto")
    ap.add_argument("--host", default=DEFAULT_WS_HOST, help=f"监听地址，默认 {DEFAULT_WS_HOST}")
    ap.add_argument("--port", type=int, default=DEFAULT_WS_PORT, help=f"WebSocket 端口，默认 {DEFAULT_WS_PORT}")
    ap.add_argument("--dummy", action="store_true", help="不打开串口，只打印命令（无硬件自测）")
    args = ap.parse_args()

    if _IMPORT_ERROR is not None:
        print(f"[桥] 缺少依赖（pyserial），请先运行 setup_runtime.bat")
        print(f"     {_IMPORT_ERROR}")
        return 1

    if args.dummy:
        nano_port = "dummy"
    elif args.nano_port and args.nano_port.upper() not in ("AUTO", ""):
        nano_port = args.nano_port
    else:
        try:
            nano_port = resolve_nano_port()
        except PortDetectionError as exc:
            print(exc)
            print("可手动指定：--nano-port COMx")
            return 2

    nano = NanoSerial(nano_port, dummy=args.dummy)
    stats = {"clients": 0, "commands": 0}

    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind((args.host, args.port))
    server.listen(4)
    server.settimeout(1.0)
    print("=" * 60)
    print("SeeMe 摄像头→腕带震动 桥接")
    print(f"  监听: ws://{args.host}:{args.port}")
    print(f"  Nano: {nano.port}")
    print("  浏览器打开化妆引导页后即可自动连接。Ctrl+C 退出。")
    print("=" * 60)

    try:
        while True:
            try:
                conn, addr = server.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            threading.Thread(
                target=handle_connection,
                args=(conn, addr, nano, stats),
                daemon=True,
            ).start()
    except KeyboardInterrupt:
        print("\n[桥] 退出")
    finally:
        nano.close()
        server.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
