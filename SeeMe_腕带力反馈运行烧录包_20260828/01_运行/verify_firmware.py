#!/usr/bin/env python3
"""verify_firmware.py — 验证 FSR 固件 v2：采样率 + 通道信号
用法: python verify_firmware.py [--port COM5] [--seconds 5]
"""
import argparse
import time
import serial


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", default="COM5")
    ap.add_argument("--seconds", type=float, default=5.0)
    args = ap.parse_args()

    ser = serial.Serial(args.port, 250000, timeout=0.2)
    time.sleep(0.5)
    ser.reset_input_buffer()

    rows = []
    t0 = time.time()
    print(f"读取 {args.seconds}s @ {args.port} (250000 baud)...")
    while time.time() - t0 < args.seconds:
        line = ser.readline().decode(errors="ignore").strip()
        if not line:
            continue
        if line.startswith("#"):
            if not rows:
                print(f"  固件标识: {line}")
            continue
        parts = line.split(",")
        if len(parts) != 9:
            continue
        try:
            vals = [float(p) for p in parts]
        except ValueError:
            continue
        rows.append((time.time() - t0, vals))

    ser.close()
    n = len(rows)
    dur = rows[-1][0] - rows[0][0] if n > 2 else 0
    hz = (n - 1) / dur if dur > 0 else 0

    print(f"\n=== 结果 ===")
    print(f"总行数: {n}   实测采样率: {hz:.1f} Hz" + ("  ✅ 稳定100Hz" if 95 <= hz <= 105 else "  ⚠️ 偏离100Hz"))

    if n == 0:
        print("❌ 无数据！检查串口/固件")
        return

    # 固件 t_ms 间隔统计（精确 10ms 判定）
    if n > 2:
        import numpy as np
        ft = [r[1][0] for r in rows]
        fd = np.array([ft[i] - ft[i - 1] for i in range(1, len(ft))])
        print(f"固件t_ms间隔: 中位数 {np.median(fd):.1f}ms  均值 {np.mean(fd):.1f}ms  "
              f"异常(≠10±1)占比 {(np.abs(fd-10)>1).mean()*100:.1f}%")

    # 通道统计（A0-A7）
    import numpy as np
    arr = np.array([r[1][1:] for r in rows])  # (n, 8)
    print(f"\n通道统计 (A0-A7):  min   max    mean")
    names = ["A0", "A1", "A2", "A3", "A4", "A5", "A6", "A7"]
    for i in range(8):
        print(f"  {names[i]}: {arr[:, i].min():6.0f}  {arr[:, i].max():6.0f}  {arr[:, i].mean():6.1f}")

    # 伪影检查：A5-A7 是否跟随 A0-A4 变动（静止时波动应小）
    noise = arr[:, 5:8].std(axis=0)
    print(f"\nA5-A7 静止噪声(std): {noise.round(1)}" + ("  ✅ 无伪影" if noise.max() < 5 else "  ⚠️ 仍有波动"))

    print("\n请在下一轮自由按压 A0-A4 对应传感器验证信号...")


if __name__ == "__main__":
    main()
