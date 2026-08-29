# Guarded 单版本使用说明

本交付包只保留一个运行入口：

```txt
01_运行\run_roadshow_guarded_portable.bat
```

文件名和参数已经统一为路演 guarded 强震版。它是规则阈值版，不使用自训模型。

## 实现了什么

核心脚本：

```txt
01_运行\cosmetics_remind.py
```

它实现的是一条实时闭环：

```txt
唯理腕带 EMG/IMU 数据
  -> 3 秒静息标定
  -> EMG 捏压力度规则判断
  -> IMU 打粉冲击规则判断
  -> 负向动作门控
  -> Nano 马达强震提醒
```

当前路演硬件弱/中档体感不明显，所以交付版采用：

```txt
EMG 内部弱档：只记录，不震
EMG 内部中/强：统一输出强震
tap 轻/中：只记录，不震
tap 重拍/快拍：统一输出强震
```

## 默认端口

```txt
腕带 EMG+IMU: 自动识别
Nano 震动:    自动识别
```

如果端口不同，或自动识别失败：

```bat
01_运行\run_roadshow_guarded_portable.bat --emg-port COM7 --nano-port COM9
```

直接双击时，脚本会先自动识别腕带和 Nano 分别是哪一个 COM 口；识别不唯一才会询问。也可以用根目录 `查看串口.bat` 单独查看端口，或者让 AI 运行 `detect_ports.py --json` 获取机器可读结果。

## Guarded 参数

```txt
EMG: score=max, lo=1.22 mid=1.45 hi=1.80
min_uv=20
smooth_ms=140
confirm_ms=100
release_ms=160
min_hold_ms=250
hyst=0.90
emg_output_source=raw
emg_min_output_level=2
emg_output_mode=pulse
emg_output_on=1.22
emg_output_off=1.10
emg_pulse_ms=220
emg_rearm_ms=100

tap: lo=7.0 mid=9.5 hi=11.0
tap_min_output_level=3
rate_n=5

motor_min_level=3
haptic_style=legacy

negative guard:
emg_gate_ms=350
emg_motion_gate=5.0
emg_motion_hold_ms=300
posture_gate_deg=75
posture_hold_ms=250
posture_gate_motion_only=1
posture_gyro_gate=3.5
tap_max_width_ms=320
emg_reset_on_tap=0
```

## 关键术语

```txt
EMG = Electromyography，肌电信号，腕带 8 通道肌肉电信号
IMU = Inertial Measurement Unit，惯性测量单元，主要用加速度判断拍粉冲击和姿态变化
RMS = Root Mean Square，均方根，用来描述一段 EMG 窗口的整体能量
EMA = Exponential Moving Average，指数滑动平均，用来平滑 EMG ratio
raw = 未平滑的 EMG ratio，用来让重捏更快触发
negative guard = 负向动作门控，用来压住屈腕、摆手、放下粉扑后的误触发
```

## 每次启动需要做什么

每次启动只需要按提示放松手腕静坐 3 秒，脚本会采 EMG 静息基线和 IMU 重力/姿态基准。

负向动作避免规则已经写进交付版参数里，不需要每次重新做屈腕、摆手、放下粉扑等负向动作采集。

## 日志怎么看

每次运行会生成：

```txt
data\vib_log\cosmetic_时间.csv
data\vib_log\cosmetic_时间_events.csv
data\vib_log\cosmetic_时间_baseline.txt
```

主 CSV：

```txt
ratio        平滑后的 EMG 力度分数，主要用于内部稳定判断
ratio_raw    当前窗口原始 EMG 力度分数，交付版用它决定 EMG 是否输出强震
emg_level    EMG 内部档位，不一定等于最终震动
posture_deg  当前姿态相对标定姿态的角度差
tap_width_ms IMU 冲击持续宽度，过宽会被视为负向动作
out_level    最终马达档位；交付版实际只输出 0/3 = 关/强
```

events CSV：

```txt
source=tap             原始 IMU 冲击事件
source=tap_veto        过宽冲击，被判定为非打粉提醒
source=emg_gate_block  EMG 升档被负向动作门控拦截
source=emg_state       EMG 内部档位变化
source=motor           实际发给 Nano 的马达命令
```

## 排查工具

```txt
01_运行\run_emg_diag_portable.bat       检查腕带 EMG 信号
01_运行\verify_nano_portable.bat        检查 Nano 串口输出
```

