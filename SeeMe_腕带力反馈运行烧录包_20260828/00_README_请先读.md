# SeeMe 腕带力反馈运行烧录包

这是给新电脑/对方团队使用的独立交付文件夹。里面的文件都是从当前工作目录复制出来的，原工作目录没有被移动。

## 先看结论

常规使用顺序：

```txt
1. 安装腕带串口驱动
2. 烧录 Nano 闭环固件
3. 安装 Python 运行依赖
4. 运行路演 guarded 版力反馈
```

对应文件：

```txt
查看串口.bat
03_驱动和说明\cp2102驱动.rar
02_烧录\烧录_Nano_闭环固件.bat
01_运行\setup_runtime.bat
01_运行\run_roadshow_guarded_portable.bat
```

## 新增：摄像头检测手离开化妆区域 → 腕带震动

配合化妆引导 Web 应用（shenicest-main）使用，浏览器检测到手离开当前
动作的化妆区域时，通过本地桥让腕带震动提醒。

```txt
浏览器(HandLandmarker 手部检测) ──WebSocket ws://127.0.0.1:8787──> nano_bridge.py ──> Nano 马达
```

使用顺序：

```txt
1. 先启动桥：双击 01_运行\run_nano_bridge.bat   （自动识别 Nano 端口）
2. 再打开化妆引导网页（pnpm dev / 部署版）
3. 页面右上角出现「腕带桥已连接」即就绪
4. 开启摄像头化妆：手离开当前化妆区域超过 0.25s → 强震；回到区域 → 停震
```

桥接参数（可追加到 bat 后面）：

```bat
run_nano_bridge.bat --nano-port COM9   手动指定 Nano 端口
run_nano_bridge.bat --dummy           无硬件自测（只打印命令）
run_nano_bridge.bat --port 8788       改 WebSocket 端口
```

自测工具：`01_运行\test_nano_bridge.py`（模拟浏览器客户端，验证握手+命令）。

### 先体验效果（无需真腕带）

根目录双击 `体验-手部范围检测测试.bat`，一键启动：

```txt
1. 桥接（dummy 模式，命令打印在桥窗口）
2. 开发服务器
3. 浏览器打开 hand-region-test.html 测试页
```

测试页功能：

```txt
- 摄像头 + MediaPipe 手部 21 点/边界框实时可视化
- 黄色「指定范围」框可拖动、可调整大小
- 手离开范围 0.3s → 桥终端打印 '3'（强震）；回到范围 → '0'（停震）
- 右侧面板实时显示手部状态、范围判定、震动输出、事件日志
- 判定模式可切：手部边界框相交 / 指尖点进入
```

所有模型/wasm 均已本地化（public/vendor、public/models），离线可用。

安全：Nano 固件自带 3 秒无命令自动关断，浏览器/桥异常退出后马达会自动停。

## 文件夹结构

```txt
01_运行
  cosmetics_remind.py                    核心规则阈值脚本
  detect_ports.py                        运行脚本使用的自动端口识别工具
  run_roadshow_guarded_portable.bat     推荐运行入口，路演 guarded 强震版
  setup_runtime.bat                      安装 Python 依赖
  requirements_runtime.txt               numpy / pyserial
  emg_diag.py                            诊断腕带 EMG 信号
  verify_firmware.py                     检查 Nano 串口输出

02_烧录
  firmware_closed_loop.hex               推荐烧录的 Nano 闭环固件
  firmware_closed_loop.c                 闭环固件源码
  烧录_Nano_闭环固件.bat                 便携烧录脚本
  tools\avrdude                          烧录工具

03_驱动和说明
  cp2102驱动.rar                         腕带串口驱动
  唯理-EMG腕带-纯硬件版说明书.pdf
  Guarded_单版本使用说明.md           路演 guarded 强震版说明
  换电脑使用清单.md
```

根目录还有：

```txt
查看串口.bat       给人看的串口列表，也会输出 AI/脚本可读的识别结果
detect_ports.py    给 AI/脚本用的自动端口识别工具
```

## 01_运行里哪些必须

真正启动力反馈必须有这 4 个：

```txt
cosmetics_remind.py
detect_ports.py
run_roadshow_guarded_portable.bat
requirements_runtime.txt
```

第一次换电脑还需要运行一次：

```txt
setup_runtime.bat
```

排查时才用，不是日常必点：

```txt
emg_diag.py
run_emg_diag_portable.bat
verify_firmware.py
verify_nano_portable.bat
```

为什么有 `.py` 又有 `.bat`：

```txt
.py  = 真正干活的 Python 程序
.bat = Windows 双击入口，负责找到 Python、设置参数、启动 .py
```

所以日常用户只需要双击 `.bat`；工程人员要看逻辑时才打开 `.py`。

## 02_烧录里哪些必须

烧录 Nano 必须有这 4 个：

```txt
firmware_closed_loop.hex
烧录_Nano_闭环固件.bat
tools\avrdude\avrdude.exe
tools\avrdude\avrdude.conf
```

可留档但烧录时不直接用：

```txt
firmware_closed_loop.c
烧录说明.md
```

为什么有 `.hex` 又有 `.c`：

```txt
.c   = 固件源码，给工程人员看/改
.hex = 已编译好的烧录文件，真正写进 Nano 的是它
```

日常烧录只需要双击 `烧录_Nano_闭环固件.bat`；它会调用 `avrdude.exe`，把 `firmware_closed_loop.hex` 写进 Nano。

## 端口

默认端口：

```txt
腕带 EMG+IMU: 自动识别
Nano 震动:    自动识别
```

如果新电脑端口不同，或自动识别失败，运行时手动传入：

```bat
run_roadshow_guarded_portable.bat --emg-port COM7 --nano-port COM9
```

也可以直接双击 `run_roadshow_guarded_portable.bat`，它会先自动识别腕带和 Nano 端口；只有识别不唯一时才会让你手动输入。

烧录 Nano 时也可以指定端口：

```bat
烧录_Nano_闭环固件.bat COM9
```

也可以直接双击 `烧录_Nano_闭环固件.bat`，它会先自动识别 Nano 端口；只有识别不唯一时才会让你手动输入。腕带不用烧录。

## 这是不是自训模型

不是。`run_roadshow_guarded_portable.bat` 是规则阈值版，核心脚本是 `cosmetics_remind.py`。

它做的是：读取腕带 EMG/IMU -> 静息标定 -> 规则阈值判断 -> 负向动作门控 -> 发 Nano 马达命令。

当前交付版按路演体感配置：弱/中档只作为内部判断，真正提醒统一输出强震。重捏主要看 EMG `ratio_raw`，重拍/快拍主要看 IMU 冲击。

