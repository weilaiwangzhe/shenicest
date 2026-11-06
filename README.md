# WebGL AR 化妆动作引导 Demo

一个纯前端演示：在浏览器摄像头画面上追踪人脸、生成带视频纹理的 3D 人脸网格，并使用 Three.js/WebGL 将 3D 化妆工具或逐帧手部动画贴合到面部。

完整的部署、私有化、素材维护和上线验收说明见 [`HANDOFF.md`](./HANDOFF.md)。

线上演示：<https://seu-link.fit/makeup/>

`pnpm dev` 在域名根路径运行；`pnpm build` 会自动以 `/makeup/` 为
生产资源基路径。简要发布步骤见 [`DEPLOYMENT.md`](./DEPLOYMENT.md)。

## 启动

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

打开终端显示的本地地址，点击“开启摄像头”并授权。摄像头必须运行在 `localhost` 或 HTTPS 环境。

## 当前功能

- 无摄像头时显示由用户参考照生成的 478 点 UV 3D 人脸
- 参考照只提取脸部像素；头发、衣服和背景不会进入脸部 UV
- 3D 曲面使用 MediaPipe 标准人脸拓扑，照片五官通过定位点逐三角形烘焙到 2048×2048 UV 图集
- 摄像头模式生成带实时视频纹理的 3D 人脸曲面
- 摄像头模式显示全部 478 个面部定位点
- 每个视频帧持续更新定位，左右转头、抬头和倾斜时工具沿人脸三维法线同步旋转
- 摄像头和实时人脸纹理保持原始颜色，不添加磨皮、调色或妆后滤镜
- 接入 App 官方兼容清单中的 61 种动作，可按遮瑕、眉毛、眼影、眼线、粉底、腮红、面部/鼻部修容、高光、定妆和唇妆选择
- 59 个动作直接读取各自 JSON 中的真实笔触帧和源 478 点；2 个无笔触的单帧源文件使用对应部位的 478 点语义路径
- ZIP 中的手部与化妆工具逐帧转换为带原始纹理、前后表面、实体厚度和侧壁的挤出 3D 网格
- 共生成 111 个逐帧 3D 模型：眉毛 33、眼影 7、粉底 17、修容 16、定妆 38
- 五组立体工具外观由动作语义自动匹配，实际落点和橙色轨迹来自当前所选官方动作
- 直接加载原 App SDK 的 97 个 478 点区域定义，并按每个动作 JSON 的 `regionSlots` 显示对应化妆区域填充与边界
- 原始透明 PNG 既提供逐帧外观，也提供每帧立体轮廓、接触点、位移和尺度
- 每轮动作自动镜像，交替示范左右脸
- 动作序列的位置、缩放和旋转跟随面部

可运行 `pnpm test:actions` 检查 61 个动作 ID、JSON 文件、稳定语义 ID 和源人脸关键点是否完整。

人脸图像只在浏览器本地处理，不上传到业务服务器。

## 动作序列来源

逐帧动画来自本地文件：

- `序列帧/眉毛/眉中右`
- `序列帧/眼影/眼影细节右`
- `序列帧/粉底/粉底上脸右`
- `序列帧/修容/修容颧骨右`
- `序列帧/定妆/定妆面中右`

原始 ZIP 未被修改；项目只提取了上述五组演示需要的帧。

`scripts/extract_sequence_motion.py` 会重新分析这些 PNG，并生成
`public/sequences/motion.json`。WebGL 在播放时按原帧率采样这些数据，
同时在相邻关键帧间插值，使 3D 工具复现序列帧中的移动、转角和远近变化。

`scripts/build_sequence_volumes.py` 会裁切每一帧的透明主体，提取并简化轮廓，
生成 `public/volumes/volume-models.json` 与对应纹理。浏览器使用
`THREE.ExtrudeGeometry` 将每帧轮廓挤出成立体网格并按原帧率切换。

## 照片 UV 人脸

参考照片：`public/models/reference-portrait.png`。

生成文件：

- `public/models/reference-face-uv.png` — 2048×2048 脸部 UV 图集
- `public/models/reference-face-478.json` — 参考照片的 478 个定位点
- `public/models/canonical-face-model.obj` — MediaPipe 标准人脸拓扑

照片本身的肤色与五官外观会被保留；WebGL 没有再叠加磨皮、腮红、眼线或口红后期效果。
