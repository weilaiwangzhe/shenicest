#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
EMG 逐通道诊断（带动作引导）：告诉你「现在做什么动作」，并汇总每个动作的通道峰值。

用法：
    python emg_diag.py                          # 引导模式：依次做 5 个动作
    python emg_diag.py --free                   # 自由模式：自己随意动，无提示
    python emg_diag.py --emg-port COM6 --hold-s 3

引导模式流程（每个动作循环，直到 Ctrl+C 退出）：
    握拳 → 张手 → 伸腕 → 屈腕 → 外展手指
    每个动作：先 1.5s 准备（喊动作名）→ 执行 hold_s 秒（实时显示）→ 打印该动作汇总
    汇总里看「最活跃通道 + 峰值(μV) + peak_ratio」= 哪个动作能起信号、起多少。

判读：
    - 所有动作 ratio 都 < 2、峰值 < 100μV → 佩戴/电极问题（贴紧、湿润、换位置）
    - 某动作某通道 peak_ratio > 5、峰值 > 200μV → 信号正常，用它定闭环阈值
"""
from __future__ import annotations

import argparse
import sys
import time
from collections import deque
from pathlib import Path

import numpy as np
import serial

PORT_HELPER_DIR = Path(__file__).resolve().parent.parent
if str(PORT_HELPER_DIR) not in sys.path:
    sys.path.insert(0, str(PORT_HELPER_DIR))

from detect_ports import PortDetectionError, print_table, resolve_emg_port

FRAME_HEADER = b"\xD2\xD2\xD2"
EMG_MARKER = b"\xAA"
IMU_MARKER = b"\xBB"
EMG_FRAME_LEN = 29
IMU_FRAME_LEN = 29
EMG_SCALE = 0.001

# 引导动作序列：名称 + 执行提示
ACTIONS = [
    ("握拳",     "✊ 用力攥紧全手"),
    ("张手",     "🖐 用力张开五指"),
    ("伸腕",     "↗ 手背向上用力抬"),
    ("屈腕",     "↙ 手心向上用力抬"),
    ("外展手指", "🤚 手指用力向两边分开"),
]
PREPARE_S = 1.5   # 每个动作前的准备/提示时长


def parse_emg_frame(data: bytes) -> list[float]:
    vals = []
    for ch in range(8):
        raw = int.from_bytes(data[5 + ch * 3: 8 + ch * 3], "big", signed=True)
        vals.append(raw * EMG_SCALE)
    return vals


def read_emg_frames(ser, buf: bytearray):
    chunk = ser.read(ser.in_waiting or 1)
    if chunk:
        buf.extend(chunk)
    out = []
    while True:
        idx = buf.find(FRAME_HEADER)
        if idx < 0:
            if len(buf) > 3:
                del buf[:len(buf) - 3]
            break
        if idx > 0:
            del buf[:idx]
        if len(buf) < 4:
            break
        marker = buf[3:4]
        if marker not in (EMG_MARKER, IMU_MARKER):
            del buf[:1]
            continue
        flen = EMG_FRAME_LEN if marker == EMG_MARKER else IMU_FRAME_LEN
        if len(buf) < flen:
            break
        frame = bytes(buf[:flen])
        del buf[:flen]
        if marker == EMG_MARKER:
            out.append(parse_emg_frame(frame))
    return out


def main():
    ap = argparse.ArgumentParser(description="EMG 逐通道诊断（带动作引导）")
    ap.add_argument("--emg-port", default="auto", help="唯理腕带串口，默认 auto")
    ap.add_argument("--baseline-s", type=float, default=3.0, help="静息基线标定时长(秒)")
    ap.add_argument("--hold-s", type=float, default=3.0, help="每个动作保持时长(秒)")
    ap.add_argument("--free", action="store_true", help="自由模式：不引导，自己随意动")
    ap.add_argument("--list-ports", action="store_true", help="列出当前串口后退出")
    args = ap.parse_args()

    if args.list_ports:
        print_table()
        return 0
    try:
        args.emg_port = resolve_emg_port(args.emg_port)
    except PortDetectionError as exc:
        print(exc)
        return 2

    ser = serial.Serial(args.emg_port, 921600, timeout=0.1)
    ser.reset_input_buffer()

    # ── 基线标定 ──
    print(f"\n[标定] 放松手腕、别用力，静坐 {args.baseline_s:.0f}s ...")
    buf = bytearray()
    frames: list[list[float]] = []
    t0 = time.time()
    while time.time() - t0 < args.baseline_s:
        frames.extend(read_emg_frames(ser, buf))
        time.sleep(0.005)
    if len(frames) < 20:
        print("[错误] EMG 帧太少，检查腕带/串口")
        return
    arr = np.array(frames)
    base_rms = np.sqrt(np.mean(arr ** 2, axis=0))
    base_peak = np.max(np.abs(arr), axis=0)

    print(f"[标定] {len(frames)} 帧")
    print("  通道   基线RMS(μV)  基线峰值(μV)")
    for ch in range(8):
        print(f"   ch{ch}    {base_rms[ch]:9.2f}    {base_peak[ch]:9.2f}")

    # 打印列名（一次）
    print("\n  通道 |   RMS(μV)  ratio | 峰值(μV)  peak_ratio")
    print("  " + "-" * 52)

    def live_row(rms, ratio, peak, peak_ratio, active, prefix=""):
        for ch in range(8):
            star = "★" if ch == active else " "
            print(f"{prefix}  {star}ch{ch} | {rms[ch]:7.2f}  {ratio[ch]:5.1f} | "
                  f"{peak[ch]:7.2f}  {peak_ratio[ch]:6.1f}")

    # 自由模式：无引导，持续滚动显示（RMS 窗口 + 峰值保持）
    if args.free:
        print("\n自由模式：自己随意动，观察 ★ 活跃通道。Ctrl+C 退出。\n")
        win: deque = deque(maxlen=25)
        peak_hold = np.zeros(8)
        last = time.time()
        try:
            while True:
                for f in read_emg_frames(ser, buf):
                    win.append(f)
                    peak_hold = np.maximum(peak_hold, np.abs(f))
                if len(win) < 10 or time.time() - last < 0.25:
                    continue
                last = time.time()
                w = np.array(win)
                rms = np.sqrt(np.mean(w ** 2, axis=0))
                ratio = rms / (base_rms + 1e-3)
                peak = peak_hold
                peak_ratio = peak / (base_peak + 1e-3)
                active = int(np.argmax(peak_ratio))
                live_row(rms, ratio, peak, peak_ratio, active)
                peak_hold = np.zeros(8)
                print()
        except KeyboardInterrupt:
            pass
        finally:
            ser.close()
            print("已退出")
        return

    # ── 引导模式 ──
    print(f"\n[引导] 依次做动作，每个 {args.hold_s:.0f}s。做完自动汇总。Ctrl+C 退出。\n")
    summary: dict[str, tuple[int, float, float]] = {}   # 动作 -> (最活跃ch, 峰值μV, peak_ratio)

    try:
        while True:
            for name, hint in ACTIONS:
                # 准备阶段
                print(f"\n  === 准备：{name}（{hint}）===")
                t_prep = time.time()
                while time.time() - t_prep < PREPARE_S:
                    read_emg_frames(ser, buf)
                    time.sleep(0.005)

                # 执行阶段：实时显示 + 记录峰值保持
                print(f"  >>> 现在做【{name}】，保持 {args.hold_s:.0f}s ...")
                peak_hold = np.zeros(8)
                rms_hold = np.zeros(8)
                t_act = time.time()
                last = time.time()
                while time.time() - t_act < args.hold_s:
                    for f in read_emg_frames(ser, buf):
                        a = np.abs(f)
                        peak_hold = np.maximum(peak_hold, a)
                        rms_hold = np.maximum(rms_hold, a)   # 瞬时 |x| 上包络，近似实时强度
                    if time.time() - last >= 0.25:
                        last = time.time()
                        ratio = rms_hold / (base_rms + 1e-3)
                        peak_ratio = peak_hold / (base_peak + 1e-3)
                        active = int(np.argmax(peak_hold))
                        live_row(rms_hold, ratio, peak_hold, peak_ratio, active,
                                 prefix=f"     [{name}]")
                        print()

                # 该动作汇总
                peak_ratio = peak_hold / (base_peak + 1e-3)
                active = int(np.argmax(peak_hold))
                summary[name] = (active, float(peak_hold[active]), float(peak_ratio[active]))
                print(f"  ★【{name}】汇总：最活跃 ch{active}，峰值 {peak_hold[active]:.0f}μV，"
                      f"peak_ratio {peak_ratio[active]:.1f}")
    except KeyboardInterrupt:
        pass
    finally:
        ser.close()

    # 完整汇总
    if summary:
        print("\n" + "=" * 52)
        print("  动作汇总（peak_ratio = 用力峰值 / 静息峰值）")
        print("=" * 52)
        best = None
        for name, (ch, pk, pr) in summary.items():
            flag = ""
            if pr > 5 and pk > 200:
                flag = "  ← 信号正常，可用！"
            print(f"  {name:<6}  最活跃ch{ch}  峰值{pk:6.0f}μV  peak_ratio {pr:5.1f}{flag}")
            if best is None or pr > best[1]:
                best = (name, pr, ch, pk)
        print("-" * 52)
        if best and best[1] > 5 and best[3] > 200:
            print(f"  推荐：用【{best[0]}】+ ch{best[2]} 定闭环阈值（峰值 {best[3]:.0f}μV）")
        else:
            print("  所有动作信号都偏弱 → 先解决佩戴/电极（贴紧、湿润、换前臂内侧位置）")
        print("=" * 52)
    print("\n已退出")


if __name__ == "__main__":
    raise SystemExit(main())
