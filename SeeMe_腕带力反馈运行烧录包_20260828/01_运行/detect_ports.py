#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Detect serial ports for the SeeMe wristband haptic feedback scripts."""
from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import asdict, dataclass

import serial.tools.list_ports


AUTO_VALUES = {"", "AUTO"}


@dataclass
class PortInfo:
    device: str
    description: str
    manufacturer: str
    hwid: str
    vid: str
    pid: str
    emg_score: int
    nano_score: int


class PortDetectionError(RuntimeError):
    pass


def is_auto(value: str | None) -> bool:
    return (value or "").strip().upper() in AUTO_VALUES


def text_of(port) -> str:
    parts = [
        port.device or "",
        port.description or "",
        port.manufacturer or "",
        port.hwid or "",
    ]
    return " ".join(parts).lower()


def score(text: str, role: str) -> int:
    s = 0
    if "bluetooth" in text:
        s -= 20
    if "intel" in text or "active management" in text:
        s -= 20
    if role == "nano":
        if re.search(r"\b(ch340|ch341)\b", text):
            s += 12
        if "arduino" in text:
            s += 10
        if "nano" in text:
            s += 8
        if "usb-serial" in text or "usb serial" in text:
            s += 3
        if "cp210" in text or "silicon labs" in text:
            s += 1
    else:
        if "cp210" in text or "silicon labs" in text:
            s += 12
        if "weili" in text or "emg" in text or "wrist" in text:
            s += 10
        if "usb-serial" in text or "usb serial" in text:
            s += 3
        if "ch340" in text or "ch341" in text or "arduino" in text or "nano" in text:
            s -= 4
    return s


def collect() -> list[PortInfo]:
    out: list[PortInfo] = []
    for p in serial.tools.list_ports.comports():
        text = text_of(p)
        vid = f"{p.vid:04X}" if p.vid is not None else ""
        pid = f"{p.pid:04X}" if p.pid is not None else ""
        out.append(PortInfo(
            device=p.device,
            description=p.description or "",
            manufacturer=p.manufacturer or "",
            hwid=p.hwid or "",
            vid=vid,
            pid=pid,
            emg_score=score(text, "emg"),
            nano_score=score(text, "nano"),
        ))
    return out


def choose_role(ports: list[PortInfo], role: str, exclude: set[str]) -> tuple[str | None, str]:
    field = "nano_score" if role == "nano" else "emg_score"
    candidates = [p for p in ports if p.device.upper() not in exclude]
    if not candidates:
        return None, "no serial ports available"
    ranked = sorted(candidates, key=lambda p: getattr(p, field), reverse=True)
    best = ranked[0]
    best_score = getattr(best, field)
    second_score = getattr(ranked[1], field) if len(ranked) > 1 else -999
    if best_score < 3:
        return None, f"no confident {role} match"
    if len(ranked) > 1 and best_score - second_score < 3:
        return None, f"ambiguous {role} match"
    return best.device, "ok"


def print_table(ports: list[PortInfo] | None = None) -> None:
    ports = collect() if ports is None else ports
    if not ports:
        print("No serial ports found.")
        return
    print("Detected serial ports:")
    for p in ports:
        print(f"  {p.device:>6}  nano={p.nano_score:>2}  emg={p.emg_score:>2}  "
              f"{p.description}  {p.manufacturer}  {p.hwid}")


def _requested_port(value: str | None, ports: list[PortInfo], role: str) -> str | None:
    if is_auto(value):
        return None
    requested = (value or "").strip().upper()
    for p in ports:
        if p.device.upper() == requested:
            return p.device
    print(f"[串口] 指定的 {role} 端口 {value} 不存在，尝试自动识别。")
    return None


def _error(role: str, reason: str, ports: list[PortInfo]) -> PortDetectionError:
    lines = [
        f"[串口] 无法自动识别 {role}: {reason}",
        "当前可见串口如下：",
    ]
    if ports:
        for p in ports:
            lines.append(f"  {p.device:>6}  nano={p.nano_score:>2}  emg={p.emg_score:>2}  "
                         f"{p.description}  {p.hwid}")
    else:
        lines.append("  (none)")
    lines.append("请重新插拔设备，或手动追加参数：--emg-port COMx --nano-port COMy")
    return PortDetectionError("\n".join(lines))


def resolve_emg_port(value: str | None = "auto", exclude: set[str] | None = None) -> str:
    ports = collect()
    exclude = {p.upper() for p in (exclude or set())}
    explicit = _requested_port(value, ports, "EMG")
    if explicit:
        return explicit
    emg, reason = choose_role(ports, "emg", exclude)
    if not emg:
        raise _error("腕带 EMG+IMU", reason, ports)
    print(f"[串口] 自动识别腕带 EMG+IMU: {emg}")
    return emg


def resolve_nano_port(value: str | None = "auto", exclude: set[str] | None = None) -> str:
    ports = collect()
    exclude = {p.upper() for p in (exclude or set())}
    explicit = _requested_port(value, ports, "Nano")
    if explicit:
        if explicit.upper() in exclude:
            raise _error("Nano 震动", f"{explicit} is already used by EMG", ports)
        return explicit
    nano, reason = choose_role(ports, "nano", exclude)
    if not nano:
        raise _error("Nano 震动", reason, ports)
    print(f"[串口] 自动识别 Nano 震动: {nano}")
    return nano


def resolve_pair(emg_value: str | None = "auto", nano_value: str | None = "auto") -> tuple[str, str]:
    ports = collect()
    emg = _requested_port(emg_value, ports, "EMG")
    nano = _requested_port(nano_value, ports, "Nano")
    if emg and nano:
        if emg.upper() == nano.upper():
            raise _error("串口配对", f"EMG and Nano both use {emg}", ports)
        return emg, nano
    if nano and not emg:
        emg, reason = choose_role(ports, "emg", {nano.upper()})
        if not emg:
            raise _error("腕带 EMG+IMU", reason, ports)
        print(f"[串口] 自动识别腕带 EMG+IMU: {emg}")
    elif emg and not nano:
        nano, reason = choose_role(ports, "nano", {emg.upper()})
        if not nano:
            raise _error("Nano 震动", reason, ports)
        print(f"[串口] 自动识别 Nano 震动: {nano}")
    else:
        nano, nano_reason = choose_role(ports, "nano", set())
        emg_exclude = {nano.upper()} if nano else set()
        emg, emg_reason = choose_role(ports, "emg", emg_exclude)
        if not nano or not emg:
            raise _error("串口配对", f"nano={nano_reason}, emg={emg_reason}", ports)
        print(f"[串口] 自动识别腕带 EMG+IMU: {emg}")
        print(f"[串口] 自动识别 Nano 震动: {nano}")
    return emg, nano


def main() -> int:
    ap = argparse.ArgumentParser(description="Detect SeeMe wristband/Nano serial ports")
    ap.add_argument("--role", choices=["emg", "nano"], help="detect one role and print its COM port")
    ap.add_argument("--pair", action="store_true", help="detect both roles and print command-line args")
    ap.add_argument("--json", action="store_true", help="print machine-readable port information")
    ap.add_argument("--list", action="store_true", help="print a readable port list")
    ap.add_argument("--quiet", action="store_true", help="only print the detected COM port or args")
    ap.add_argument("--exclude", action="append", default=[], help="COM port to exclude while detecting")
    args = ap.parse_args()

    ports = collect()
    exclude = {p.upper() for p in args.exclude}

    if args.json:
        nano, nano_reason = choose_role(ports, "nano", set())
        emg_exclude = {nano.upper()} if nano else set()
        emg, emg_reason = choose_role(ports, "emg", emg_exclude)
        print(json.dumps({
            "ports": [asdict(p) for p in ports],
            "detected": {
                "emg_port": emg,
                "emg_reason": emg_reason,
                "nano_port": nano,
                "nano_reason": nano_reason,
            },
        }, ensure_ascii=False, indent=2))
        return 0

    if args.list or (not args.role and not args.pair):
        print_table(ports)
        return 0

    if args.role:
        port, reason = choose_role(ports, args.role, exclude)
        if port:
            print(port)
            return 0
        if not args.quiet:
            print_table(ports)
        print(f"[detect_ports] {reason}; please specify the COM port manually.", file=sys.stderr)
        return 2

    nano, nano_reason = choose_role(ports, "nano", set())
    emg_exclude = {nano.upper()} if nano else set()
    emg, emg_reason = choose_role(ports, "emg", emg_exclude)
    if nano and emg:
        print(f"--emg-port {emg} --nano-port {nano}")
        return 0
    if not args.quiet:
        print_table(ports)
    print(f"[detect_ports] nano={nano_reason}, emg={emg_reason}; please specify ports manually.", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
