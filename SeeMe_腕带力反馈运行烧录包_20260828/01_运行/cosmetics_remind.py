#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
化妆动作力度实时提醒【捏压 + 打粉 双逻辑合一版】

这个文件是“规则阈值版”实时提醒脚本，不加载训练好的模型。它做的事情是：
1) 从腕带串口读取 EMG + IMU；
2) 先做 3 秒静息标定；
3) 用 EMG ratio 判断捏压力度，用 IMU a_dyn 判断打粉冲击；
4) 把判断结果转换成 Nano 马达震动命令；交付入口默认只用关/强两档。

术语表：
  EMG = Electromyography，肌电信号。这里是腕带的 8 通道肌肉电信号。
  IMU = Inertial Measurement Unit，惯性测量单元。这里主要用三轴加速度判断拍粉冲击。
  RMS = Root Mean Square，均方根。用来描述一段 EMG 窗口的整体能量。
  EMA = Exponential Moving Average，指数滑动平均。用来平滑 ratio，减少单次尖峰误触。
  Haptic = 触觉反馈。这里就是马达震动的强弱、长短、单震/双震节奏。
  semantic haptic = 可选的语义化触觉反馈。不同原因用不同震动节奏表达，
                    例如重捏持续震、打粉过重单震、打粉过快双震。
  legacy haptic = 旧版触觉反馈。内部判断几档，马达就直接按几档输出。
  ratio_raw = 当前 EMG 窗口刚算出的原始力度分数，反应快但更抖。
  ratio = 对 ratio_raw 做 EMA 平滑后的力度分数，实际分档更主要看它。
  emg_score = 多通道 EMG 融合方式：max 取最高通道，top2/top3 取最高 2/3 个通道平均。

一个进程同时占用腕带串口(自动识别)，同时检测两类化妆动作，任一触发即震动提醒：

  ┌─ 捏压（拇指/食指/中指捏工具、持续手用力）── EMG 力度检测（持续震动）
  │     原理：腕带 EMG 8 通道 → 峰值包络 / 静息峰值 = ratio，
  │     按 ratio 分 弱/中/强 三档持续震动（越大震越强）。
  │     复用了 vib_closed_loop_test.py 的成熟逻辑：通道门控 + EMA 平滑 +
  │     升/降双阈值迟滞 + 最短保持 + 自动记录。
  │
  └─ 打粉（粉扑粘粉/拍打、力量过大或过快）── IMU 加速度冲击检测（短脉冲震动）
        原理：打粉时手腕快速拍击，IMU 加速度合成幅值会短促偏离重力 g0。
        a_dyn = |√(ax²+ay²+az²) − g0| 就是「冲击幅度」。
        ·「过大」：单次冲击峰值 peak 超 tap-mid/tap-hi → 中/强脉冲震一下
        ·「过快」：滑动窗口内冲击次数 ≥ rate-n → 强脉冲震一下（提示太快）

【为什么必须合一】腕带串口只能被一个进程打开，而 EMG(250Hz) 与 IMU(111Hz)
本来就混在同一串口流里。所以「捏压」和「打粉」必须在一个脚本里同时解析。

【IMU 帧解析（0xBB，29 字节，已修正）】
  byte0-2  D2D2D2 帧头 | byte3 marker=BB | byte4 SN | byte5-6 未标注字段
  byte7-8 gyro_x | 9-10 gyro_y | 11-12 gyro_z
  byte13-14 acc_x | 15-16 acc_y | 17-18 acc_z   （大端有符号 int16）
  ACC_SCALE = 0.0005978 → m/s²；静止时 acc 合成幅值 ≈ 9.72（实测，见 IMU 解析修正报告）

记录（每次运行生成三个文件，路径会打印）：
  data/vib_log/cosmetic_YYYYMMDD_HHMMSS.csv           时间序列(20Hz)：EMG ratio + IMU 冲击 + 触觉/马达输出
  data/vib_log/cosmetic_YYYYMMDD_HHMMSS_events.csv    事件：tap 原始冲击 / haptic_pattern 触觉节奏 / emg_state 内部档位 / motor 马达命令
  data/vib_log/cosmetic_YYYYMMDD_HHMMSS_baseline.txt  标定基线 + 全部阈值参数 + 日志字段说明
  运行结束打印稳定性报告 + 打粉冲击峰值分布（帮你定 tap 阈值）。

用法：
    python cosmetics_remind.py                          # 默认自动识别腕带 + Nano，双逻辑
    python cosmetics_remind.py --guided                 # ★引导标定：屏幕逐步提示动作+倒计时，跑完自动结束并出分段对照报告
    python cosmetics_remind.py --mode emg               # 只检测捏压(EMG)
    python cosmetics_remind.py --mode tap               # 只检测打粉(IMU)
    python cosmetics_remind.py --manual                 # 手动：键盘 0/1/2/3 直接发
"""
from __future__ import annotations

import argparse
import csv
import math
import time
from collections import deque
from datetime import datetime
from pathlib import Path

import numpy as np
import serial

from detect_ports import PortDetectionError, print_table, resolve_pair

FRAME_HEADER = b"\xD2\xD2\xD2"
EMG_MARKER = b"\xAA"
IMU_MARKER = b"\xBB"
EMG_FRAME_LEN = 29
IMU_FRAME_LEN = 29
EMG_SCALE = 0.001          # 24-bit raw → μV
GYRO_SCALE = 0.0012        # 16-bit raw → gyro unit used by Level 2 runtime
ACC_SCALE = 0.0005978      # 16-bit raw → m/s²


def parse_emg_frame(data: bytes) -> list[float]:
    vals = []
    for ch in range(8):
        raw = int.from_bytes(data[5 + ch * 3: 8 + ch * 3], "big", signed=True)
        vals.append(raw * EMG_SCALE)
    return vals


def parse_imu_frame(data: bytes) -> list[float]:
    """BB 帧 → [ax, ay, az, gx, gy, gz]。acc 从 byte13 起，gyro 从 byte7 起。"""
    gyro = []
    for ch in range(3):
        offset = 7 + ch * 2
        raw = int.from_bytes(data[offset: offset + 2], "big", signed=True)
        gyro.append(raw * GYRO_SCALE)
    acc = []
    for ch in range(3):
        offset = 13 + ch * 2
        raw = int.from_bytes(data[offset: offset + 2], "big", signed=True)
        acc.append(raw * ACC_SCALE)
    return acc + gyro


def vec_angle_deg(a, b) -> float:
    """Angle between two vectors; used as a posture-change guard around gravity."""
    aa = np.asarray(a, dtype=np.float64)
    bb = np.asarray(b, dtype=np.float64)
    na = float(np.linalg.norm(aa))
    nb = float(np.linalg.norm(bb))
    if na < 1e-6 or nb < 1e-6:
        return 0.0
    cos_v = float(np.dot(aa, bb) / (na * nb))
    cos_v = max(-1.0, min(1.0, cos_v))
    return math.degrees(math.acos(cos_v))


def read_frames(ser, buf: bytearray):
    """一次读串口，返回 (emg_frames, imu_frames)。
    emg 帧 = 8 通道 μV 列表；imu 帧 = [ax, ay, az, gx, gy, gz]。"""
    chunk = ser.read(ser.in_waiting or 1)
    if chunk:
        buf.extend(chunk)
    emg_out: list[list[float]] = []
    imu_out: list[list[float]] = []
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
            emg_out.append(parse_emg_frame(frame))
        else:
            imu_out.append(parse_imu_frame(frame))
    return emg_out, imu_out


def main():
    ap = argparse.ArgumentParser(description="化妆动作力度实时提醒：捏压(EMG) + 打粉(IMU冲击) 双逻辑")
    ap.add_argument("--emg-port", default="auto", help="唯理腕带(EMG+IMU 同串口)串口，默认 auto")
    ap.add_argument("--nano-port", default="auto", help="Nano(震动)串口，默认 auto")
    ap.add_argument("--mode", default="both", choices=["emg", "tap", "both"],
                    help="检测模式：emg=只捏压 / tap=只打粉 / both=两者，默认 both")
    ap.add_argument("--baseline-s", type=float, default=3.0, help="静息基线标定时长(秒)")
    # ── 捏压 EMG 参数（沿用闭环脚本口径）──
    ap.add_argument("--window-frames", type=int, default=12, help="EMG 峰值包络窗口帧数")
    ap.add_argument("--lo", type=float, default=1.8, help="EMG 弱档 ratio 阈值（须高于静息噪声地板~1.7）")
    ap.add_argument("--mid", type=float, default=2.2, help="EMG 中档 ratio 阈值")
    ap.add_argument("--hi", type=float, default=2.4, help="EMG 强档 ratio 阈值（捏压信号信噪比低，设略高于重捏峰值~2.4）")
    ap.add_argument("--emg-gate-ms", type=float, default=600.0,
                    help="EMG 门控：距上次打粉冲击 < 此值(ms)时静音 EMG 捏压判定"
                         "（解决『拍粉的手部运动伪造捏压提醒』的串扰）")
    ap.add_argument("--emg-motion-gate", type=float, default=0.0,
                    help="EMG 运动门控：IMU a_dyn 高于此值(m/s²)时静音 EMG 持续震；0=关闭")
    ap.add_argument("--hyst", type=float, default=0.8, help="EMG 迟滞系数：降档阈值=升档×hyst")
    ap.add_argument("--min-uv", type=float, default=25.0, help="EMG 绝对峰值下限(μV)，低于此不震")
    ap.add_argument("--emg-score", default="max", choices=["max", "top2", "top3"],
                    help="EMG 力度评分：max=任一通道触发；top2/top3=多通道平均，更适合路演防尖峰误触")
    ap.add_argument("--min-base-uv", type=float, default=12.0, help="有效通道基线峰值下限(μV)")
    ap.add_argument("--max-base-uv", type=float, default=60.0, help="有效通道基线峰值上限(μV)")
    ap.add_argument("--smooth-ms", type=float, default=150.0, help="EMG EMA 平滑时间常数(ms)")
    ap.add_argument("--confirm-ms", type=float, default=40.0, help="EMG 升档确认时长(ms)")
    ap.add_argument("--release-ms", type=float, default=250.0, help="EMG 降档确认时长(ms)")
    ap.add_argument("--min-hold-ms", type=float, default=300.0, help="EMG 每档最短保持时长(ms)")
    ap.add_argument("--emg-sustain-level", type=int, default=3, choices=[1, 2, 3],
                    help="语义触觉模式下，EMG 达到几档开始持续震动：1=弱档即持续，2=中档即持续，3=仅强档持续")
    ap.add_argument("--emg-sustain-output", type=int, default=2, choices=[2, 3],
                    help="语义触觉模式下，EMG 中档持续时输出几档震动：2=中震，3=强震")
    ap.add_argument("--emg-min-output-level", type=int, default=1, choices=[1, 2, 3],
                    help="legacy 模式下，EMG 至少达到几档才输出马达；低于此只记录不震")
    ap.add_argument("--emg-output-source", default="state", choices=["state", "raw"],
                    help="legacy 模式下 EMG 马达输出来源：state=平滑分档；raw=当前窗口快速判定，减少延迟和松手尾巴")
    ap.add_argument("--emg-output-mode", default="continuous", choices=["continuous", "pulse"],
                    help="legacy 模式下 EMG 输出方式：continuous=超过阈值持续震；pulse=过阈值只给短强震，避免松手尾巴")
    ap.add_argument("--emg-output-on", type=float, default=0.0,
                    help="pulse 模式下 EMG 快速触发阈值；0=按 emg-min-output-level 使用 lo/mid/hi")
    ap.add_argument("--emg-output-off", type=float, default=0.0,
                    help="pulse 模式下 EMG 重新待命阈值；0=触发阈值×hyst")
    ap.add_argument("--emg-pulse-ms", type=float, default=180.0,
                    help="pulse 模式下每次 EMG 强震脉冲时长(ms)")
    ap.add_argument("--emg-rearm-ms", type=float, default=120.0,
                    help="pulse 模式下 raw 低于 off 阈值多久后允许下一次触发(ms)")
    # ── 打粉 IMU 冲击参数 ──
    ap.add_argument("--tap-lo", type=float, default=7.0, help="打粉冲击幅度下限(m/s²)，a_dyn 超此值记为一次冲击(挡轻/中拍)")
    ap.add_argument("--tap-mid", type=float, default=9.5, help="打粉冲击中档峰值(m/s²)(真实拍击起点)")
    ap.add_argument("--tap-hi", type=float, default=11.0, help="打粉冲击强档峰值(m/s²)(力量过大)")
    ap.add_argument("--tap-release", type=float, default=0.5, help="冲击结束阈值=tap-lo×此系数，默认0.5")
    ap.add_argument("--light-pulse-ms", type=float, default=150.0, help="轻微提醒弱震时长(ms)")
    ap.add_argument("--pulse-ms", type=float, default=250.0, help="打粉过重强震单脉冲时长(ms)")
    ap.add_argument("--fast-pulse-ms", type=float, default=120.0, help="打粉过快双击中每次强震时长(ms)")
    ap.add_argument("--fast-gap-ms", type=float, default=80.0, help="打粉过快双击中间停顿时长(ms)")
    ap.add_argument("--system-ms", type=float, default=500.0, help="系统就绪/错误中震提示时长(ms)")
    ap.add_argument("--tap-cooldown-ms", type=float, default=0.0,
                    help="语义触觉模式下，两次打粉震动提示之间的最短间隔(ms)，避免一次动作重复触发")
    ap.add_argument("--tap-min-prompt-level", type=int, default=1, choices=[1, 2, 3],
                    help="语义触觉模式下，tap 达到几档才震动提示；低于此只用于 EMG 门控/记录")
    ap.add_argument("--tap-prompt-min-count", type=int, default=1,
                    help="语义触觉模式下，中档 tap 至少连续出现几次才提示；强档 tap 不受此限制")
    ap.add_argument("--tap-min-output-level", type=int, default=1, choices=[1, 2, 3],
                    help="legacy 模式下，tap 至少达到几档才输出马达；低于此只记录不震")
    ap.add_argument("--motor-min-level", type=int, default=0, choices=[0, 1, 2, 3],
                    help="最终马达输出下限：非零输出低于该档时抬到该档；3=只用强震表达提醒")
    ap.add_argument("--haptic-style", default="legacy", choices=["semantic", "legacy"],
                    help="震动风格：legacy=路演 guarded 推荐 / semantic=可选触觉语义节奏")
    ap.add_argument("--rate-window-s", type=float, default=2.0, help="过快检测窗口(秒)")
    ap.add_argument("--rate-n", type=int, default=5, help="窗口内真实冲击次数≥此值判为过快(升强档)")
    ap.add_argument("--emg-motion-hold-ms", type=float, default=0.0,
                    help="IMU 大运动后继续关闭 EMG 升档的时间(ms)，防止放下手后延迟震动")
    ap.add_argument("--posture-gate-deg", type=float, default=0.0,
                    help="负向动作门控：重力方向相对标定姿态变化超过此角度时关闭 EMG；0=关闭")
    ap.add_argument("--posture-hold-ms", type=float, default=0.0,
                    help="姿态门控触发后继续关闭 EMG 的时间(ms)，用于屈腕/抬腕/放下手后的尾巴")
    ap.add_argument("--posture-gate-motion-only", action="store_true",
                    help="姿态门控只在同时存在加速度/陀螺仪运动时触发，避免静态重捏被姿态角误拦")
    ap.add_argument("--posture-gyro-gate", type=float, default=0.0,
                    help="姿态运动门控用的陀螺仪幅度阈值；0=不用 gyro，只看 a_dyn")
    ap.add_argument("--tap-max-width-ms", type=float, default=0.0,
                    help="负向动作门控：tap 从超过阈值到释放的最长有效宽度(ms)；超出视作甩手/放下手，不触发 tap 震动；0=关闭")
    ap.add_argument("--emg-reset-on-tap", action="store_true",
                    help="每次检测到 tap 后清空 EMG 状态/窗口，防止打粉串扰延迟强震")
    ap.add_argument("--emg-reset-on-gate", action="store_true",
                    help="EMG 门控关闭时立即把 EMG 状态清零，路演防误触优先")
    ap.add_argument("--guided", action="store_true",
                    help="引导标定模式：屏幕逐步提示动作+倒计时+段间3s缓冲，跑完自动结束并输出分段对照报告")
    ap.add_argument("--manual", action="store_true", help="手动模式：键盘 0/1/2/3 直接发命令")
    ap.add_argument("--list-ports", action="store_true", help="列出当前串口后退出")
    args = ap.parse_args()

    emg_enabled = args.mode in ("emg", "both")
    tap_enabled = args.mode in ("tap", "both")
    imu_needed = tap_enabled or args.emg_motion_gate > 0 or args.posture_gate_deg > 0

    if args.list_ports:
        print_table()
        return 0
    try:
        args.emg_port, args.nano_port = resolve_pair(args.emg_port, args.nano_port)
    except PortDetectionError as exc:
        print(exc)
        return 2

    # ── 记录文件 ──
    out_dir = Path(__file__).resolve().parent / "data" / "vib_log"
    out_dir.mkdir(parents=True, exist_ok=True)
    tag = datetime.now().strftime("%Y%m%d_%H%M%S")
    csv_path = out_dir / f"cosmetic_{tag}.csv"
    evt_path = out_dir / f"cosmetic_{tag}_events.csv"
    base_path = out_dir / f"cosmetic_{tag}_baseline.txt"
    csv_file = open(csv_path, "w", newline="", encoding="utf-8")
    csv_w = csv.writer(csv_file)
    # CSV 字段说明：
    #   ratio       = EMA 平滑后的 EMG 力度分数，用于稳定分档。
    #   ratio_raw   = 当前窗口原始 EMG 力度分数，适合排查尖峰。
    #   emg_level   = EMG 内部判断档位，不一定等于最终马达输出。
    #   haptic_level= 当前触觉节奏(pattern)输出档位；它不是原始 tap 事件等级。
    #   out_level   = 最终发给 Nano 马达的档位，0/1/2/3 = 关/弱/中/强。
    csv_w.writerow(["t", "emg_peak_uv", "ratio", "ratio_raw", "emg_level",
                    "acc_mag", "a_dyn", "tap_peak", "haptic_level", "out_level", "haptic_name",
                    "ch0", "ch1", "ch2", "ch3", "ch4", "ch5", "ch6", "ch7"])
    csv_file.flush()
    evt_file = open(evt_path, "w", newline="", encoding="utf-8")
    evt_w = csv.writer(evt_file)
    # events.csv 的 source：
    #   tap            = 一次原始 IMU 冲击事件，level 是按 tap-lo/mid/hi 分出的冲击档位。
    #   haptic_pattern = 启动一段可选触觉节奏，level 是节奏名称。
    #   emg_state      = EMG 内部档位变化，level 是新的 EMG 档位。
    #   motor          = 实际发给 Nano 的马达命令，level 是 0/1/2/3。
    evt_w.writerow(["t", "source", "level", "detail"])
    evt_file.flush()
    print(f"[记录] 时间序列 → {csv_path}")
    print(f"[记录] 事件     → {evt_path}")

    t0 = time.perf_counter()

    # ── 打开两个串口 ──
    print(f"[串口] 腕带 EMG+IMU: {args.emg_port} @921600")
    ser_emg = serial.Serial(args.emg_port, 921600, timeout=0.005)
    ser_emg.reset_input_buffer()
    print(f"[串口] Nano 震动: {args.nano_port} @250000")
    ser_nano = serial.Serial(args.nano_port, 250000, timeout=0.1)
    time.sleep(0.2)

    def send(cmd: str):
        try:
            ser_nano.write(cmd.encode("ascii"))
            evt_w.writerow([f"{time.perf_counter() - t0:.4f}", "motor", cmd,
                            "sent_to_nano; 0/1/2/3=off/weak/mid/strong"])
            evt_file.flush()
        except Exception as e:
            print(f"[串口] 发命令失败: {e}")

    # ── 手动模式 ──
    if args.manual:
        print("\n手动模式：输入 0=关 1=弱 2=中 3=强，回车发送；q 退出")
        try:
            import msvcrt
        except ImportError:
            msvcrt = None
        while True:
            if msvcrt is not None:
                if msvcrt.kbhit():
                    c = msvcrt.getch().decode("ascii", "ignore").lower()
                    if c == "q":
                        break
                    if c in "0123":
                        send(c)
                        print(f"  -> 发送 '{c}'")
            else:
                c = input("> ").strip().lower()
                if c == "q":
                    break
                if c in "0123":
                    send(c)
        send("0")
        csv_file.close()
        evt_file.close()
        print("已退出，马达关闭")
        return

    # ── 基线标定（EMG baseline + IMU 重力 g0 同时采）──
    print(f"\n[标定] 请放松手腕、别用力，静坐 {args.baseline_s:.0f}s（同时采 EMG 基线 + IMU 重力基准）...")
    buf = bytearray()
    emg_frames: list[list[float]] = []
    imu_frames: list[list[float]] = []
    t_b = time.time()
    while time.time() - t_b < args.baseline_s:
        e, i = read_frames(ser_emg, buf)
        emg_frames.extend(e)
        imu_frames.extend(i)
        time.sleep(0.005)

    # EMG 基线 + 通道门控
    valid_ch = np.array([], dtype=int)
    base_rms = np.zeros(8)
    base_peak = np.zeros(8)
    if emg_enabled:
        if len(emg_frames) < 20:
            print("[错误] 标定期收到的 EMG 帧太少，请检查腕带是否连在 --emg-port 上")
            send("0")
            csv_file.close()
            evt_file.close()
            return
        arr = np.array(emg_frames)
        base_rms = np.sqrt(np.mean(arr ** 2, axis=0))
        base_peak = np.max(np.abs(arr), axis=0)
        valid_ch = np.where((base_peak >= args.min_base_uv) & (base_peak <= args.max_base_uv))[0]
        if len(valid_ch) < 1:
            print(f"[错误] 没有有效通道（基线峰值须在 {args.min_base_uv}~{args.max_base_uv}μV 之间）")
            print("       当前各通道基线峰值: " + " ".join(f"ch{i}={v:.1f}" for i, v in enumerate(base_peak)))
            print("       提示：悬空/没贴紧的电极基线会异常低或异常高，请检查佩戴后重跑")
            send("0")
            csv_file.close()
            evt_file.close()
            return
        print(f"[标定] EMG 收到 {len(emg_frames)} 帧")
        print(f"[标定] 静息 RMS(μV)  = " + " ".join(f"{v:.1f}" for v in base_rms))
        print(f"[标定] 静息峰值(μV)  = " + " ".join(f"{v:.1f}" for v in base_peak))
        print(f"[标定] 有效通道 = " + ", ".join(f"ch{i}" for i in valid_ch) + "（已排除悬空/漂移通道）")

    # IMU 重力基准 g0
    g0 = 9.81
    gvec0 = np.array([0.0, 0.0, g0], dtype=np.float64)
    if imu_needed:
        if imu_frames:
            ia = np.array([row[:3] for row in imu_frames], dtype=np.float64)
            acc_mag = np.sqrt((ia ** 2).sum(axis=1))
            g0 = float(np.median(acc_mag))
            gvec0 = np.median(ia, axis=0)
            print(f"[标定] IMU 收到 {len(imu_frames)} 帧，重力基准 g0 = {g0:.3f} m/s²（静止应≈9.8）")
            if args.posture_gate_deg > 0:
                gv = " ".join(f"{v:.3f}" for v in gvec0)
                print(f"[标定] 姿态基准 gvec0 = {gv}，姿态门控 > {args.posture_gate_deg:.0f}°")
        else:
            print("[警告] 标定期没收到 IMU 帧，g0 用默认 9.81，IMU 门控/打粉检测可能不准")

    # 写基线文件
    with open(base_path, "w", encoding="utf-8") as bf:
        bf.write(f"tag={tag}\n")
        bf.write(f"mode={args.mode}\n")
        bf.write(f"baseline_s={args.baseline_s}\n")
        bf.write(f"emg_frames={len(emg_frames)}\n")
        bf.write(f"base_rms_uv={' '.join(f'{v:.2f}' for v in base_rms)}\n")
        bf.write(f"base_peak_uv={' '.join(f'{v:.2f}' for v in base_peak)}\n")
        bf.write(f"valid_ch={' '.join(str(i) for i in valid_ch)}\n")
        bf.write(f"g0={g0:.4f}\n")
        bf.write(f"gvec0={' '.join(f'{v:.4f}' for v in gvec0)}\n")
        bf.write(f"lo={args.lo} mid={args.mid} hi={args.hi} hyst={args.hyst} min_uv={args.min_uv}\n")
        bf.write(f"emg_score={args.emg_score}\n")
        bf.write(f"window_frames={args.window_frames} smooth_ms={args.smooth_ms} "
                 f"confirm_ms={args.confirm_ms} release_ms={args.release_ms} "
                 f"min_hold_ms={args.min_hold_ms} emg_sustain_level={args.emg_sustain_level} "
                 f"emg_sustain_output={args.emg_sustain_output} "
                 f"emg_min_output_level={args.emg_min_output_level} "
                 f"emg_output_source={args.emg_output_source}\n")
        bf.write(f"emg_output_mode={args.emg_output_mode} emg_output_on={args.emg_output_on} "
                 f"emg_output_off={args.emg_output_off} emg_pulse_ms={args.emg_pulse_ms} "
                 f"emg_rearm_ms={args.emg_rearm_ms}\n")
        bf.write(f"emg_gate_ms={args.emg_gate_ms} emg_motion_gate={args.emg_motion_gate} "
                 f"emg_motion_hold_ms={args.emg_motion_hold_ms} "
                 f"emg_reset_on_tap={int(args.emg_reset_on_tap)} "
                 f"emg_reset_on_gate={int(args.emg_reset_on_gate)}\n")
        bf.write(f"tap_lo={args.tap_lo} tap_mid={args.tap_mid} tap_hi={args.tap_hi} "
                f"tap_release={args.tap_release} tap_min_prompt_level={args.tap_min_prompt_level} "
                f"tap_prompt_min_count={args.tap_prompt_min_count} "
                f"tap_min_output_level={args.tap_min_output_level} "
                f"pulse_ms={args.pulse_ms}\n")
        bf.write(f"light_pulse_ms={args.light_pulse_ms} fast_pulse_ms={args.fast_pulse_ms} "
                 f"fast_gap_ms={args.fast_gap_ms} system_ms={args.system_ms} "
                 f"tap_cooldown_ms={args.tap_cooldown_ms} motor_min_level={args.motor_min_level}\n")
        bf.write(f"haptic_style={args.haptic_style}\n")
        bf.write(f"rate_window_s={args.rate_window_s} rate_n={args.rate_n}\n")
        bf.write(f"posture_gate_deg={args.posture_gate_deg} posture_hold_ms={args.posture_hold_ms} "
                 f"posture_gate_motion_only={int(args.posture_gate_motion_only)} "
                 f"posture_gyro_gate={args.posture_gyro_gate} "
                 f"tap_max_width_ms={args.tap_max_width_ms}\n")
        bf.write("\n[log_schema]\n")
        bf.write("csv.ratio=EMA-smoothed EMG strength used for stable level decisions\n")
        bf.write("csv.ratio_raw=raw EMG strength from the current sliding window\n")
        bf.write("csv.emg_level=internal EMG level after smoothing/confirm/release\n")
        bf.write("csv.haptic_level=current haptic pattern output level, not the raw tap level\n")
        bf.write("csv.haptic_name=current haptic pattern name when optional haptics are active\n")
        bf.write("csv.out_level=final motor command level sent to Nano, 0/1/2/3=off/weak/mid/strong\n")
        bf.write("events.tap=raw IMU impact event; level is derived from tap-lo/mid/hi\n")
        bf.write("events.tap_veto=IMU impact rejected by negative-action gate\n")
        bf.write("events.haptic_pattern=optional vibration pattern start; level is the pattern name\n")
        bf.write("events.emg_pulse=fast EMG pulse trigger in legacy pulse mode\n")
        bf.write("events.emg_state=internal EMG level transition\n")
        bf.write("events.emg_gate_block=EMG attempted to rise while tap/motion gate was closed\n")
        bf.write("events.motor=actual Nano motor command\n")
    print(f"[记录] 标定基线 → {base_path}\n")

    # ── 引导模式：动作时间表（每段前 3s 缓冲切换） ──
    GUIDED_STEPS = [
        ("静止下垂",  15, "手放松自然下垂/平放，完全不用力"),
        ("晃手腕",    15, "像走路甩手那样随意晃"),
        ("轻捏工具",  15, "拿笔/工具轻轻捏（描眉那种轻力）"),
        ("中等力捏",  15, "中等力捏（挤口红那种力）"),
        ("重捏",      15, "用力捏（接近握拳力度）"),
        ("轻拍粉扑",  15, "粉扑轻拍（粘粉轻扑）"),
        ("中拍粉扑",  15, "正常打粉力度拍"),
        ("重拍粉扑",  15, "用力拍打（模拟力量过大）"),
        ("连续快拍",  15, "快速连续拍 5 次以上"),
        ("真实化妆",  30, "自由发挥，混合捏压+打粉"),
    ]
    GUIDED_GAP = 3.0
    guided_segs = []   # [(buf_start, act_start, act_end, idx)]
    if args.guided:
        t_acc = 0.0
        for i, (name, dur, tip) in enumerate(GUIDED_STEPS):
            buf_s = t_acc
            act_s = t_acc + GUIDED_GAP
            act_e = act_s + dur
            guided_segs.append((buf_s, act_s, act_e, i))
            t_acc = act_e
        guided_total = t_acc
        print(f"[引导] 标定结束后将进行 {len(GUIDED_STEPS)} 段动作，"
              f"共约 {guided_total:.0f}s。跟着屏幕提示做即可，每段间有 {GUIDED_GAP:.0f}s 切换缓冲。")

    # ── 实时闭环 ──
    # EMG 状态
    window: deque = deque(maxlen=args.window_frames)
    cur_level = 0
    pending = 0
    pending_since = time.perf_counter()
    last_change = time.perf_counter()
    last_sent = -1
    ema_strength = None
    raw_up_level = 0
    last_emg_gate_block_time = -1e9
    emg_gate_block_count = 0
    emg_pulse_until = -1e9
    emg_pulse_armed = True
    emg_pulse_below_since = None
    emg_pulse_count = 0
    # 打粉冲击状态
    tap_state = "idle"
    tap_peak = 0.0
    tap_rise_since = -1e9
    tap_gyro_peak = 0.0
    tap_posture_peak = 0.0
    tap_events: deque = deque()
    cur_tap_level = 0
    tap_pulse_until = 0.0
    last_tap_time = -1e9    # 上次打粉冲击时刻（用于 EMG 门控）
    # 触觉节奏状态：非阻塞执行短震/双击，不影响 EMG/IMU 实时解析
    pattern_name = ""
    pattern_segments: deque = deque()
    pattern_level = 0
    pattern_until = 0.0
    pattern_priority = 0
    pattern_counts: dict[str, int] = {}
    last_emg_pattern_level = 0
    last_tap_pattern_time = -1e9
    # 显示/记录用的最近 IMU 值
    last_acc_mag = g0
    last_a_dyn = 0.0
    last_gyro_mag = 0.0
    last_posture_angle = 0.0
    last_motion_gate_time = -1e9
    last_posture_gate_time = -1e9
    # 统计
    switch_count = 0
    dwell = {0: 0.0, 1: 0.0, 2: 0.0, 3: 0.0}
    level_since = time.perf_counter()
    tap_peaks: list[float] = []
    tap_veto_count = 0
    last_print = 0.0
    last_csv = 0.0
    last_loop = time.perf_counter()
    run_start = time.perf_counter()
    run_start_rel = run_start - t0
    guided_key = None       # 已宣告的段 ('buf',i) / ('act',i)
    mem_rows: list[tuple] = []   # (t, ratio, a_dyn, emg_peak, emg_level, tap_level, out_level)
    if args.guided:
        print("运行中：跟着屏幕提示做动作。全部完成后自动结束。\n")
    else:
        print("运行中：捏工具/打粉观察提醒。Ctrl+C 退出。\n")

    def apply(level: int):
        nonlocal last_sent
        if level != last_sent:
            send(str(level))
            last_sent = level

    def start_pattern(name: str, segments: list[tuple[int, float]], now: float, priority: int):
        """Start a non-blocking vibration pattern.

        segments are (level, duration_seconds). Higher priority patterns can replace
        lower priority ones; this keeps a weak cue from interrupting a strong warning.
        """
        nonlocal pattern_name, pattern_segments, pattern_level, pattern_until, pattern_priority
        if pattern_until > now and priority < pattern_priority:
            return
        active_segments = [(lv, dur) for lv, dur in segments if dur > 0]
        if not active_segments:
            return
        pattern_counts[name] = pattern_counts.get(name, 0) + 1
        pattern_name = name
        pattern_segments = deque(active_segments)
        pattern_priority = priority
        pattern_level = 0
        pattern_until = now
        evt_w.writerow([f"{now - t0:.4f}", "haptic_pattern", name,
                        " ".join(f"{lv}:{dur:.3f}" for lv, dur in active_segments)])
        evt_file.flush()

    def pattern_output(now: float) -> int:
        nonlocal pattern_name, pattern_segments, pattern_level, pattern_until, pattern_priority
        while pattern_until <= now:
            if not pattern_segments:
                pattern_name = ""
                pattern_level = 0
                pattern_priority = 0
                return 0
            pattern_level, dur = pattern_segments.popleft()
            pattern_until = now + dur
        return pattern_level

    def apply_emg_level(new_level: int, now: float):
        nonlocal cur_level, switch_count, level_since, last_change
        if new_level == cur_level:
            return
        dwell[cur_level] += now - level_since
        cur_level = new_level
        level_since = now
        last_change = now
        switch_count += 1
        evt_w.writerow([f"{now - t0:.4f}", "emg_state", str(new_level),
                        "internal EMG level after ratio/EMA/confirm/release"])
        evt_file.flush()

    def level_from(strength, lo, mid, hi):
        if strength >= hi:
            return 3
        if strength >= mid:
            return 2
        if strength >= lo:
            return 1
        return 0

    def threshold_for_level(level: int) -> float:
        if level >= 3:
            return args.hi
        if level == 2:
            return args.mid
        return args.lo

    def emg_gate_open(now: float) -> bool:
        if tap_enabled and tap_state != "idle":
            return False
        if (now - last_tap_time) <= (args.emg_gate_ms / 1000.0):
            return False
        if args.emg_motion_gate > 0:
            if last_a_dyn > args.emg_motion_gate:
                return False
            if (now - last_motion_gate_time) <= (args.emg_motion_hold_ms / 1000.0):
                return False
        if args.posture_gate_deg > 0:
            if not args.posture_gate_motion_only and last_posture_angle > args.posture_gate_deg:
                return False
            if (now - last_posture_gate_time) <= (args.posture_hold_ms / 1000.0):
                return False
        return True

    def on_tap(peak: float, now: float, width_ms: float, gyro_peak: float, posture_peak: float):
        nonlocal tap_events, last_tap_time, cur_tap_level, tap_pulse_until, last_tap_pattern_time
        nonlocal pending, pending_since, ema_strength, last_loop, tap_veto_count
        last_tap_time = now   # 记录冲击时刻，用于 EMG 门控（屏蔽随后的捏压误判）
        if args.emg_reset_on_tap:
            if cur_level != 0:
                apply_emg_level(0, now)
            pending = 0
            pending_since = now
            ema_strength = 0.0
            last_loop = now
            window.clear()
        if args.tap_max_width_ms > 0 and width_ms > args.tap_max_width_ms:
            tap_veto_count += 1
            evt_w.writerow([f"{now - t0:.4f}", "tap_veto", "width",
                            f"peak={peak:.2f} width_ms={width_ms:.0f} "
                            f"gyro_peak={gyro_peak:.2f} posture_peak={posture_peak:.1f}"])
            evt_file.flush()
            return
        # 只有「真实冲击」(peak≥中档)才计入过快频率统计；噪声晃动不计入，避免 rate 虚高误触「过快」
        if peak >= args.tap_mid:
            tap_events.append(now)
            while tap_events and now - tap_events[0] > args.rate_window_s:
                tap_events.popleft()
        rate = len(tap_events)
        lvl = level_from(peak, args.tap_lo, args.tap_mid, args.tap_hi)
        too_fast = rate >= args.rate_n and peak >= args.tap_mid
        prompt_ready = peak >= args.tap_hi or rate >= args.tap_prompt_min_count
        if too_fast:
            lvl = max(lvl, 3)  # 过快 → 强提醒
        tap_peaks.append(peak)
        if args.haptic_style == "legacy":
            if lvl >= args.tap_min_output_level:
                cur_tap_level = lvl
                tap_pulse_until = now + args.pulse_ms / 1000.0
        else:
            can_prompt = (now - last_tap_pattern_time) >= (args.tap_cooldown_ms / 1000.0)
            if can_prompt:
                if too_fast:
                    start_pattern("tap_fast_double", [
                        (3, args.fast_pulse_ms / 1000.0),
                        (0, args.fast_gap_ms / 1000.0),
                        (3, args.fast_pulse_ms / 1000.0),
                    ], now, priority=4)
                    last_tap_pattern_time = now
                elif peak >= args.tap_hi:
                    start_pattern("tap_heavy_single", [(3, args.pulse_ms / 1000.0)], now, priority=3)
                    last_tap_pattern_time = now
                elif lvl >= args.tap_min_prompt_level and prompt_ready:
                    # 低强度事件只做短促轻提醒，避免正常动作被持续打扰。
                    start_pattern("light_hint", [(1, args.light_pulse_ms / 1000.0)], now, priority=1)
                    last_tap_pattern_time = now
        evt_w.writerow([f"{now - t0:.4f}", "tap", str(lvl),
                        f"peak={peak:.2f} rate={rate} fast={int(too_fast)} "
                        f"prompt_ready={int(prompt_ready)} width_ms={width_ms:.0f} "
                        f"gyro_peak={gyro_peak:.2f} posture_peak={posture_peak:.1f}"])
        evt_file.flush()

    confirm_s = args.confirm_ms / 1000.0
    release_s = args.release_ms / 1000.0
    min_hold_s = args.min_hold_ms / 1000.0
    smooth_s = args.smooth_ms / 1000.0
    emg_output_on = args.emg_output_on if args.emg_output_on > 0 else threshold_for_level(args.emg_min_output_level)
    emg_output_off = args.emg_output_off if args.emg_output_off > 0 else emg_output_on * args.hyst
    emg_pulse_s = args.emg_pulse_ms / 1000.0
    emg_rearm_s = args.emg_rearm_ms / 1000.0
    tap_release_thr = args.tap_lo * args.tap_release
    rate_window_s = args.rate_window_s
    rate_n = args.rate_n
    if args.haptic_style == "semantic":
        start_pattern("system_ready", [(2, args.system_ms / 1000.0)], time.perf_counter(), priority=2)

    try:
        while True:
            # ── 引导段调度 ──
            if args.guided:
                rt = time.perf_counter() - run_start
                if rt >= guided_total:
                    print("\n\n[引导] 全部动作完成，自动结束")
                    break
                key = None
                for buf_s, act_s, act_e, i in guided_segs:
                    if buf_s <= rt < act_s:
                        key = ("buf", i)
                        break
                    if act_s <= rt < act_e:
                        key = ("act", i)
                        break
                if key != guided_key:
                    guided_key = key
                    if key[0] == "act":
                        _, i = key
                        name, dur, tip = GUIDED_STEPS[i]
                        print("\n" + "=" * 60)
                        print(f"  【第 {i + 1}/{len(GUIDED_STEPS)} 段】{name}（{dur} 秒）")
                        print(f"  动作：{tip}")
                        print("=" * 60)
                    else:
                        _, i = key
                        name, dur, tip = GUIDED_STEPS[i]
                        print(f"\n  → {GUIDED_GAP:.0f} 秒后：{name}（{tip}），请准备…")

            emg_now, imu_now = read_frames(ser_emg, buf)

            # ── IMU 打粉冲击处理 ──
            # 先处理 IMU，再更新 EMG 状态；这样同一批数据里的打粉运动会先关闭 EMG 升档门控。
            if imu_needed:
                for imu in imu_now:
                    ax, ay, az = imu[:3]
                    gx, gy, gz = imu[3:6]
                    acc_mag = math.sqrt(ax * ax + ay * ay + az * az)
                    gyro_mag = math.sqrt(gx * gx + gy * gy + gz * gz)
                    posture_angle = vec_angle_deg([ax, ay, az], gvec0)
                    a_dyn = abs(acc_mag - g0)
                    last_acc_mag = acc_mag
                    last_a_dyn = a_dyn
                    last_gyro_mag = gyro_mag
                    last_posture_angle = posture_angle
                    now = time.perf_counter()
                    if args.emg_motion_gate > 0 and a_dyn > args.emg_motion_gate:
                        last_motion_gate_time = now
                    posture_motion = (
                        (args.emg_motion_gate > 0 and a_dyn > args.emg_motion_gate)
                        or (args.posture_gyro_gate > 0 and gyro_mag > args.posture_gyro_gate)
                    )
                    if (args.posture_gate_deg > 0 and posture_angle > args.posture_gate_deg
                            and (not args.posture_gate_motion_only or posture_motion)):
                        last_posture_gate_time = now
                    if not tap_enabled:
                        continue
                    if tap_state == "idle":
                        if a_dyn >= args.tap_lo:
                            tap_state = "rise"
                            tap_peak = a_dyn
                            tap_rise_since = now
                            tap_gyro_peak = gyro_mag
                            tap_posture_peak = posture_angle
                    else:  # rise
                        if a_dyn > tap_peak:
                            tap_peak = a_dyn
                        if gyro_mag > tap_gyro_peak:
                            tap_gyro_peak = gyro_mag
                        if posture_angle > tap_posture_peak:
                            tap_posture_peak = posture_angle
                        if a_dyn < tap_release_thr:
                            tap_width_ms = (now - tap_rise_since) * 1000.0
                            tap_state = "idle"
                            on_tap(tap_peak, now, tap_width_ms, tap_gyro_peak, tap_posture_peak)

            # ── EMG 捏压处理 ──
            if emg_enabled:
                for f in emg_now:
                    window.append(f)
                if len(window) >= max(5, args.window_frames // 2):
                    w = np.array(window)
                    rms_all = np.sqrt(np.mean(w ** 2, axis=0))
                    peak_all = np.max(np.abs(w), axis=0)
                    rms = rms_all[valid_ch]
                    peak = peak_all[valid_ch]
                    ratio_rms = rms / (base_rms[valid_ch] + 1e-3)
                    ratio_peak = peak / (base_peak[valid_ch] + 1e-3)
                    ratio = np.maximum(ratio_rms, ratio_peak)
                    if args.emg_score == "max" or len(ratio) <= 1:
                        strength = float(np.max(ratio))
                    else:
                        k = 2 if args.emg_score == "top2" else 3
                        k = min(k, len(ratio))
                        strength = float(np.mean(np.partition(ratio, -k)[-k:]))
                    emg_peak = float(np.max(peak))

                    now = time.perf_counter()
                    dt = max(1e-4, now - last_loop)
                    last_loop = now
                    emg_state_gate = emg_gate_open(now)
                    raw_up_level = 0 if emg_peak < args.min_uv else level_from(strength, args.lo, args.mid, args.hi)
                    gated_strength = strength if emg_state_gate else 0.0

                    if ema_strength is None:
                        ema_strength = gated_strength
                    else:
                        alpha = dt / (dt + smooth_s)
                        ema_strength += alpha * (gated_strength - ema_strength)
                    s_smooth = float(ema_strength)

                    if not emg_state_gate and raw_up_level > cur_level:
                        if now - last_emg_gate_block_time >= 0.5:
                            emg_gate_block_count += 1
                            evt_w.writerow([f"{now - t0:.4f}", "emg_gate_block", str(raw_up_level),
                                            f"cur={cur_level} ratio={s_smooth:.2f} raw={strength:.2f} "
                                            f"a_dyn={last_a_dyn:.2f} tap_state={tap_state} "
                                            f"since_tap={now - last_tap_time:.2f} "
                                            f"posture={last_posture_angle:.1f} gyro={last_gyro_mag:.2f}"])
                            evt_file.flush()
                            last_emg_gate_block_time = now

                    if not emg_state_gate and args.emg_reset_on_gate:
                        if cur_level != 0:
                            apply_emg_level(0, now)
                        pending = 0
                        pending_since = now
                        desired = 0
                    elif emg_peak < args.min_uv:
                        desired = 0
                    else:
                        up = level_from(s_smooth, args.lo, args.mid, args.hi)
                        dn = level_from(s_smooth, args.lo * args.hyst,
                                        args.mid * args.hyst, args.hi * args.hyst)
                        if up > cur_level:
                            desired = up
                        elif dn < cur_level:
                            desired = dn
                        else:
                            desired = cur_level

                    if not emg_state_gate and desired > cur_level:
                        desired = cur_level

                    if desired == cur_level:
                        pending = desired
                        pending_since = now
                    else:
                        if desired != pending:
                            pending = desired
                            pending_since = now
                        need = confirm_s if pending > cur_level else release_s
                        if (now - pending_since) >= need and (now - last_change) >= min_hold_s:
                            apply_emg_level(pending, now)
                else:
                    strength = 0.0
                    raw_up_level = 0
                    emg_peak = 0.0
                    s_smooth = 0.0
                    peak_all = np.zeros(8)
            else:
                strength = 0.0
                raw_up_level = 0
                emg_peak = 0.0
                s_smooth = 0.0
                peak_all = np.zeros(8)

            # ── 输出合并：新版触觉语义 / 旧版强度持续 ──
            now = time.perf_counter()
            # EMG 门控：近期发生过打粉冲击 → 静音 EMG 捏压判定（屏蔽拍粉手部运动伪造的捏压）
            emg_gate = emg_gate_open(now)
            if args.haptic_style == "legacy":
                pattern_out = cur_tap_level if (tap_enabled and now < tap_pulse_until) else 0
                if emg_enabled and emg_gate:
                    if args.emg_output_mode == "pulse":
                        if strength <= emg_output_off:
                            if emg_pulse_below_since is None:
                                emg_pulse_below_since = now
                            elif now - emg_pulse_below_since >= emg_rearm_s:
                                emg_pulse_armed = True
                        else:
                            emg_pulse_below_since = None

                        if emg_pulse_armed and emg_peak >= args.min_uv and strength >= emg_output_on:
                            emg_pulse_until = now + emg_pulse_s
                            emg_pulse_armed = False
                            emg_pulse_count += 1
                            evt_w.writerow([f"{now - t0:.4f}", "emg_pulse", "3",
                                            f"raw={strength:.2f} on={emg_output_on:.2f} "
                                            f"off={emg_output_off:.2f} peak={emg_peak:.1f}"])
                            evt_file.flush()
                        emg_contrib = 3 if now < emg_pulse_until else 0
                    else:
                        source_level = raw_up_level if args.emg_output_source == "raw" else cur_level
                        emg_contrib = source_level if source_level >= args.emg_min_output_level else 0
                else:
                    if args.emg_output_mode == "pulse":
                        emg_pulse_until = -1e9
                    emg_contrib = 0
                out_level = max(emg_contrib, pattern_out)
            else:
                if emg_enabled and emg_gate and cur_level != last_emg_pattern_level:
                    if cur_level == 1:
                        start_pattern("emg_light_hint", [(1, args.light_pulse_ms / 1000.0)], now, priority=1)
                    elif cur_level == 2:
                        start_pattern("emg_mid_hint", [(2, args.light_pulse_ms / 1000.0)], now, priority=2)
                last_emg_pattern_level = cur_level

                pattern_out = pattern_output(now)
                if emg_enabled and emg_gate and cur_level >= args.emg_sustain_level:
                    emg_contrib = 3 if (cur_level >= 3 or args.emg_sustain_output == 3) else 2
                else:
                    emg_contrib = 0
                out_level = max(emg_contrib, pattern_out)
            if 0 < out_level < args.motor_min_level:
                out_level = args.motor_min_level
            apply(out_level)

            # ── 时间序列记录（20Hz）──
            if now - last_csv >= 0.05:
                last_csv = now
                csv_w.writerow([f"{now - t0:.4f}", f"{emg_peak:.2f}", f"{s_smooth:.3f}",
                                f"{strength:.3f}", cur_level,
                                f"{last_acc_mag:.2f}", f"{last_a_dyn:.2f}",
                                f"{tap_peak:.2f}", pattern_out, out_level, pattern_name]
                               + [f"{v:.1f}" for v in peak_all])
                csv_file.flush()
                mem_rows.append((now - t0, s_smooth, last_a_dyn, emg_peak,
                                 cur_level, pattern_out, out_level))

            if now - last_print >= 0.2:
                lvl_txt = {0: "关", 1: "弱", 2: "中", 3: "强"}[out_level]
                if emg_enabled:
                    raw_txt = f" raw={strength:4.2f}" if args.emg_output_source == "raw" else ""
                    emg_txt = f"峰值={emg_peak:6.1f}μV ratio={s_smooth:5.2f}{raw_txt}"
                else:
                    emg_txt = "EMG=关"
                tap_txt = f"a_dyn={last_a_dyn:5.1f} 冲击峰值={tap_peak:5.1f}" if tap_enabled else "打粉=关"
                guard_txt = ""
                if args.posture_gate_deg > 0:
                    guard_txt = f" 姿态={last_posture_angle:4.0f}°"
                seg_txt = ""
                if args.guided:
                    rt = now - run_start
                    for buf_s, act_s, act_e, i in guided_segs:
                        if act_s <= rt < act_e:
                            seg_txt = f"  [{GUIDED_STEPS[i][0]} 剩{act_e - rt:.0f}s]"
                            break
                        if buf_s <= rt < act_s:
                            seg_txt = f"  [准备:{GUIDED_STEPS[i][0]}]"
                            break
                print(f"\r{emg_txt}  {tap_txt}{guard_txt}  震动=[{lvl_txt}]{seg_txt}   ", end="", flush=True)
                last_print = now
    except KeyboardInterrupt:
        pass
    finally:
        send("0")
        now_end = time.perf_counter()
        dwell[cur_level] += now_end - level_since
        csv_file.close()
        evt_file.close()
        print("\n已退出，马达关闭")

        # ── 稳定性 + 打粉统计报告 ──
        total = now_end - t0
        print("\n===== 提醒报告 =====")
        print(f"运行时长：{total:.1f}s")
        if emg_enabled:
            print(f"EMG 档位切换次数：{switch_count} 次（{switch_count / max(total, 1e-3):.2f} 次/秒）")
            print(f"EMG 门控拦截升档记录：{emg_gate_block_count} 次")
            if args.emg_output_mode == "pulse":
                print(f"EMG 快速脉冲触发：{emg_pulse_count} 次")
            for lv, name in {0: "关", 1: "弱", 2: "中", 3: "强"}.items():
                pct = dwell[lv] / max(total, 1e-3) * 100
                print(f"  档{lv}({name})：累计 {dwell[lv]:.1f}s（{pct:.0f}%）")
        user_patterns = {k: v for k, v in pattern_counts.items() if k != "system_ready"}
        if user_patterns:
            detail = "，".join(f"{k}={v}" for k, v in sorted(user_patterns.items()))
            print(f"触觉提示次数（不含系统就绪）：{sum(user_patterns.values())} 次；{detail}")
        else:
            print("触觉提示次数（不含系统就绪）：0 次")
        if tap_veto_count:
            print(f"负向 tap 拦截：{tap_veto_count} 次（冲击持续太久，疑似甩手/放下手）")
        if tap_enabled:
            print(f"打粉冲击总次数：{len(tap_peaks)} 次")
            if tap_peaks:
                tp = np.array(tap_peaks)
                print(f"  冲击峰值分布(m/s²)：p50={np.percentile(tp,50):.1f} "
                      f"p90={np.percentile(tp,90):.1f} p99={np.percentile(tp,99):.1f} "
                      f"max={tp.max():.1f}")
                print(f"  提示：当前 tap 阈值 lo={args.tap_lo} mid={args.tap_mid} hi={args.tap_hi}，"
                      f"按上面分布调整（过大=峰值高、过快=次数密）")
        print(f"[记录] 已保存：{csv_path}")
        print(f"[记录] 已保存：{evt_path}")

        # ── 引导标定：分段对照报告 ──
        if args.guided and mem_rows:
            LVL_NAME = {0: "关", 1: "弱", 2: "中", 3: "强"}
            # 预期主档：按「仅在持续用力/过大/过快时提醒」的初衷设定
            #   捏压：轻捏不提醒、中捏弱、重捏强；打粉：轻/中拍正常不打扰、重拍(过大)/快拍(过快)强
            EXPECT = [0, 0, 0, 1, 3, 0, 0, 3, 3, None]
            print("\n===== 分段对照报告（引导标定）=====")
            print(f"{'段':>2} {'动作':<6} {'ratio p50/max':<14} {'a_dyn max':>8}  "
                  f"输出档分布 关/弱/中/强          主档  预期  判定")
            for buf_s, act_s, act_e, i in guided_segs:
                t_a, t_e = run_start_rel + act_s, run_start_rel + act_e
                seg = [r for r in mem_rows if t_a <= r[0] < t_e]
                name = GUIDED_STEPS[i][0]
                if not seg:
                    print(f"{i + 1:>2} {name:<6} （无数据，可能提前结束）")
                    continue
                ratios = [r[1] for r in seg]
                adyns = [r[2] for r in seg]
                outs = [r[6] for r in seg]
                n = len(seg)
                dist = "/".join(f"{outs.count(l) * 100 // n}%" for l in [0, 1, 2, 3])
                main_lv = max(outs)  # 该段达到过的最高档（打击/用力是瞬态事件，取峰值更准）
                exp = EXPECT[i]
                if exp is None:
                    verdict = "综合段"
                    exp_txt = "—"
                elif main_lv == exp:
                    verdict = "✓ 符合"
                    exp_txt = LVL_NAME[exp]
                elif main_lv < exp:
                    verdict = "✗ 偏钝（该触发没触发够）"
                    exp_txt = LVL_NAME[exp]
                else:
                    verdict = "✗ 偏灵敏（不该触发的触发了）"
                    exp_txt = LVL_NAME[exp]
                print(f"{i + 1:>2} {name:<6} {np.percentile(ratios, 50):.2f}/{max(ratios):.2f}   "
                      f"{max(adyns):>8.1f}  {dist:<26}  {LVL_NAME[main_lv]:<4}  {exp_txt:<4}  {verdict}")


if __name__ == "__main__":
    raise SystemExit(main())
