# WebGL AR 化妆动作播放器——部署与维护交接文档

> 项目目录：`D:\CodeX\webgl-makeup-guide-demo`
> 当前版本：`0.1.0`
> 文档更新：2026-08-25
> 当前开发地址：`http://127.0.0.1:5174/`（开发端口可能因占用而变化）

## 1. 项目交付范围

这是一个无需业务后端的纯前端 WebGL Demo。页面使用 Three.js 渲染照片直接投影的三维面部曲面、真实 GLB 化妆工具和动作轨迹；启用摄像头后，使用 MediaPipe Face Landmarker 在浏览器内持续跟踪单张人脸的 478 个定位点。

当前交付状态：

- 已接入 61 种 App 化妆动作。
- 59 种动作直接读取原动作 JSON 的笔触帧和源人脸定位数据。
- `修容上庭长.json`、`嘴唇1.json` 原文件没有有效笔触，使用对应部位的 478 点语义路径回退。
- 已接入原 App SDK 的 97 个区域定义，并读取每个动作的 `regionSlots`。
- `closed` 闭合区域显示半透明橙色填充及边界；`openCurve` 只显示橙色引导线，不生成矩形填充。
- 11 类动作按语义使用 5 个真实闭合 GLB 工具；旧版 111 帧 PNG 轮廓挤出不再参与运行时渲染。
- 摄像头模式逐视频帧刷新人脸和工具姿态，左右转头时工具、轨迹与化妆区域跟随面部。
- 预览模式支持鼠标/触控拖拽旋转视角，双击恢复正面；摄像头模式由真实头部姿态控制，不接受鼠标旋转。
- 不渲染妆后效果，不添加腮红、口红、磨皮、滤镜、星星、爱心或科技感装饰。
- 预览只显示可旋转的三维面部曲面，不在其后叠加完整二维肖像，因此侧转不会出现“双脸”。

动作分类数量：

| 分类 | 数量 |
| --- | ---: |
| 遮瑕 | 10 |
| 眉毛 | 2 |
| 眼影 | 14 |
| 眼线 | 4 |
| 粉底 | 5 |
| 腮红 | 9 |
| 面部修容 | 9 |
| 鼻修容 | 4 |
| 高光 | 2 |
| 定妆 | 1 |
| 唇妆 | 1 |
| 合计 | 61 |

## 2. 技术架构

```text
参考照片 / 摄像头视频
        │
        ├── 预览模式：参考照 + 478 点数据 + canonical face topology
        │                    └── 生成照片纹理 3D 人脸
        │
        └── 摄像头模式：MediaPipe Face Landmarker
                             └── 每帧输出 478 点并更新视频纹理 3D 人脸
                                           │
动作 JSON ── 898 面片重心坐标绑定 ───────────┤
区域库 ──── regionSlots 映射到 478 点区域 ──┤
GLB 工具 ── 语义选择 + 刷头锚点 + 局部法线 ─┤
序列帧 ──── 仅提供角度、节奏和尺度参考 ─────┤
                                           ▼
                                Three.js / WebGL 合成渲染
```

主要依赖：

| 依赖 | 版本 | 用途 |
| --- | --- | --- |
| `three` | `0.185.1` | WebGL 场景、3D 人脸、工具、轨迹和区域渲染 |
| `@mediapipe/tasks-vision` | `1.0.1` | 摄像头人脸 478 点检测与跟踪 |
| `vite` | `8.2.2` | 开发服务器和生产构建 |

本次验证环境为 Node.js `22.17.1`、pnpm `11.24.0`。建议部署构建机使用 Node.js 22 LTS；应使用仓库内的 `pnpm-lock.yaml` 锁定依赖。

## 3. 目录说明

```text
webgl-makeup-guide-demo/
├─ index.html                    页面结构和入口
├─ package.json                  依赖与 npm 命令
├─ pnpm-lock.yaml                锁定依赖版本，部署时必须保留
├─ src/
│  ├─ main.js                    WebGL、摄像头、478 点、动作和播放器主逻辑
│  ├─ official-actions.js        61 个运行时文件与稳定语义 ID 的映射
│  └─ style.css                  页面布局与视觉样式
├─ public/
│  ├─ actions/                   61 个 App 动作 JSON
│  ├─ regions/all.json           97 个官方 478 点化妆区域
│  ├─ models/                    sRGB投影纹理、478 点、标准拓扑及模型许可
│  ├─ sequences/                 原透明序列帧和 motion.json
│  ├─ vendor/                    MediaPipe WASM 与离线运行时
│  └─ reference-face.png         原始参考照片副本
├─ scripts/
│  ├─ validate-official-actions.mjs  动作/区域完整性校验
│  ├─ extract_sequence_motion.py     从 PNG 重新提取运动数据
│  └─ build_reference_projection.py  P3→sRGB、边缘延展、gutter与alpha生成
├─ dist/                         `pnpm build` 生成的生产静态文件
├─ README.md                     项目简介
└─ HANDOFF.md                    本交接文档
```

运行时不依赖以下原始外部目录，部署时无需复制：

- `D:\CodeX\seeme-edge-v2-action-alignment\...`
- `D:\CodeX\seeme-cloud-api\...`
- 微信目录中的原始 `序列帧.zip`

需要的数据已经复制并转换到本项目的 `public/` 中。不要只复制 `src/`，否则动作、区域、照片和 3D 工具会全部丢失。

## 4. 本地开发启动

在 PowerShell 中执行：

```powershell
Set-Location -LiteralPath "D:\CodeX\webgl-makeup-guide-demo"
corepack enable
pnpm install --frozen-lockfile
pnpm test:actions
pnpm dev -- --port 5174
```

浏览器打开：

```text
http://127.0.0.1:5174/
```

说明：

- `pnpm install --frozen-lockfile` 严格按 `pnpm-lock.yaml` 安装，适合交接和 CI；修改依赖时才使用 `pnpm install`。
- `pnpm dev` 默认使用 5173；端口被占用时 Vite 会自动改用其他端口。
- 指定 `--port 5174` 可与当前演示地址保持一致。
- `localhost` 和 `127.0.0.1` 属于浏览器安全上下文例外，可以在 HTTP 下请求摄像头。
- 使用局域网 IP（如 `http://192.168.x.x:5174`）访问时，大多数浏览器不会授权摄像头，必须配置 HTTPS。

## 5. 生产构建

```powershell
Set-Location -LiteralPath "D:\CodeX\webgl-makeup-guide-demo"
corepack enable
pnpm install --frozen-lockfile
pnpm test:actions
pnpm build
```

构建产物位于：

```text
D:\CodeX\webgl-makeup-guide-demo\dist
```

当前构建后的 `dist/` 约 29 MB，包含网页代码和 `public/` 的全部运行时素材。上传服务器时只需发布 `dist/`，不要发布 `node_modules/`、源码 QA 截图或原始 ZIP。

发布前可本地模拟生产静态服务器：

```powershell
pnpm preview -- --host 0.0.0.0 --port 4173
```

然后访问 `http://127.0.0.1:4173/`。`vite preview` 只用于验收，不建议作为正式生产服务器。

## 6. 部署方式

### 6.1 推荐：Nginx + HTTPS

将 `dist/` 的内容上传到服务器，例如 `/var/www/makeup-guide/`，然后配置：

```nginx
server {
    listen 80;
    server_name makeup.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name makeup.example.com;

    ssl_certificate     /etc/letsencrypt/live/makeup.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/makeup.example.com/privkey.pem;

    root /var/www/makeup-guide;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    # Vite 生成的带 hash 文件可以长期缓存。
    location /assets/ {
        try_files $uri =404;
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # actions、regions、models、sequences 的文件名较稳定，
    # 不要 immutable，以免更新动作后用户仍拿到旧缓存。
    location ~ ^/(actions|regions|models|sequences)/ {
        try_files $uri =404;
        expires 1h;
        add_header Cache-Control "public, max-age=3600";
    }

    gzip on;
    gzip_types text/css application/javascript application/json image/svg+xml;
}
```

部署后执行：

```bash
sudo nginx -t
sudo systemctl reload nginx
```

### 6.2 对象存储或静态托管

Cloudflare Pages、Netlify、Vercel、OSS/COS 静态网站等均可使用：

- 安装命令：`pnpm install --frozen-lockfile`
- 构建命令：`pnpm test:actions && pnpm build`
- 发布目录：`dist`
- Node.js：22
- 必须绑定 HTTPS 域名后再测试摄像头。

如果平台允许配置响应头，确保 `.wasm` 返回 `application/wasm`。当前联网版本的 WASM 来自外部 CDN，但离线化后该 MIME 类型是必需的。

### 6.3 `/makeup/` 子路径部署

当前生产地址为：

```text
https://seu-link.fit/makeup/
```

源码已统一通过 `import.meta.env.BASE_URL` 解析 actions、models、regions、
sequences 和 vendor 等运行时资源。`vite.config.js` 在生产构建时将 base
设置为 `/makeup/`，本地开发仍使用 `/`。部署时必须完整替换 `dist/`，不能
只复制 `assets/`。

## 7. 摄像头与网络要求

摄像头工作的必要条件：

1. 正式环境通过 HTTPS 提供页面。
2. 用户点击“开启摄像头”并授权，页面不会自动获取权限。
3. 浏览器可访问 MediaPipe 的 WASM 和模型地址。
4. 页面没有被上层 iframe 的 Permissions Policy 禁止摄像头。
5. 设备支持 WebGL，并有可用前置摄像头。

当前外部运行时资源：

```text
https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm
https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task
```

如公司防火墙、CSP 或内网策略阻止上述域名，照片预览仍可显示，但点击摄像头会失败并回退到 3D 预览。

若页面嵌入 iframe，上层页面需要至少允许：

```html
<iframe src="https://makeup.example.com/" allow="camera"></iframe>
```

服务端也可设置：

```text
Permissions-Policy: camera=(self)
```

如果配置 Content Security Policy，至少需要允许自身资源、摄像头所需脚本/WASM和上述两个外部源。上线初期建议先观察浏览器控制台，再逐步收紧 CSP。

## 8. 完全离线/私有化部署

普通生产部署仍依赖 MediaPipe 外网资源。完全离线时需做两步：

1. 把 `node_modules/@mediapipe/tasks-vision/wasm/` 复制到 `public/mediapipe/wasm/`。
2. 下载 `face_landmarker.task` 到 `public/mediapipe/models/face_landmarker.task`。

然后修改 `src/main.js`：

```js
return FilesetResolver.forVisionTasks("/mediapipe/wasm");
```

以及：

```js
modelAssetPath: "/mediapipe/models/face_landmarker.task",
```

修改后重新执行 `pnpm test:actions` 和 `pnpm build`。私有服务器必须正确返回：

- `.wasm`：`application/wasm`
- `.task`：`application/octet-stream`
- `.json`：`application/json`

注意：本地化 WASM 和模型会显著增大 `dist/`。应核对 MediaPipe 版本和文件版本保持一致，不能只替换其中一项。

## 9. 动作与区域数据维护

### 9.1 61 个动作的入口

`src/official-actions.js` 是播放器动作清单。每条记录包含：

- `runtimeId`：`public/actions/` 中的真实 JSON 文件名。
- `canonicalId`：稳定的业务语义 ID。
- `category` / `categoryLabel`：动作分类。
- `side`：左、右或中性。
- `toolMode`：映射到 brow、eyeshadow、foundation、contour、powder 五类立体工具。
- 展示名称和动作说明。

新增动作的标准步骤：

1. 将 JSON 放入 `public/actions/`。
2. 在 `src/official-actions.js` 添加唯一映射。
3. 确认 JSON 内含 `faceMesh.frames[].landmarks`、`strokeSegments` 和 `regionSlots`。
4. 若新增 `regionId`，同步更新 `public/regions/all.json`。
5. 执行 `pnpm test:actions`。
6. 在预览和摄像头模式分别人工确认落点、方向、穿模和左右镜像。

不要仅根据中文文件名推断左右脸；以 `official-actions.js` 的稳定映射和实际动作数据为准。

### 9.2 区域渲染规则

播放器从 `public/regions/all.json` 读取官方 478 点区域：

- `geomType: "closed"`：可以形成真实化妆区域，显示半透明橙色填充和轮廓。
- `geomType: "openCurve"`：属于开放边界或引导线，只显示线，不应扩成带状填充。

这条规则用于避免眼影、眉毛附近出现无意义的绿色/橙色矩形。后续维护时不要恢复 `openCurve` 的 ribbon 填充逻辑。

### 9.3 轨迹绑定方式

动作 JSON 中的二维笔触点不会直接按屏幕坐标播放。代码会在 canonical face 的 898 个三角面中寻找可见且连续的表面层，面内点保存三角重心坐标；真正越界或跨层的点钳到安全边界并标记为 `reposition`，播放时平滑抬笔、隐藏接触圈后再落笔。当前契约为 11,209 点中 11,000 点面内精确重建、297 点显式重定位（其中 209 点真正位于脸外）。

## 10. 动作参考序列与真实 3D 工具维护

五组序列帧：

| 工具模式 | 帧数 | 默认采样帧率 |
| --- | ---: | ---: |
| 眉毛 `brow` | 33 | 12 fps |
| 眼影 `eyeshadow` | 7 | 6 fps |
| 粉底 `foundation` | 17 | 9 fps |
| 修容 `contour` | 16 | 8 fps |
| 定妆 `powder` | 38 | 12 fps |
| 合计 | 111 | — |

动作分析脚本：

- `scripts/extract_sequence_motion.py`：从透明 PNG 分析位移、尺度、角度和接触位置，生成 `public/sequences/motion.json`。

`extract_sequence_motion.py` 的输出供网页参考角度、节奏和尺度。旧版 2.5D 轮廓挤出脚本与数据（`build_sequence_volumes.py`、`public/volumes/`）已于 2026-08 清理，运行时从未加载。更换工具时应优先提供真实闭合 GLB，并逐动作检查：

- 工具是否贴近正确化妆部位。
- 正面、左右转头时是否穿入人脸。
- GLB 刷头锚点是否落在接触圈，长柄是否朝脸外。
- 模型自身和脸部之间是否有正确深度遮挡。
- 接触点是否与橙色轨迹一致。

`src/main.js` 的 `TOOL_SPECS` 控制 11 类语义工具的 GLB、尺度、刷头端点、倾角和柔软接触端面。运行时先对齐真实接触面质心，再动态选择朝外倾角，并对硬质三角与 898 个脸面做精确相交检测；海绵/刷毛端面可由深度缓冲表现受控按压，金属和杆身必须保持零相交。当前素材不含真实 3D 手模型；不要重新把手部 PNG 挤出并称为真 3D。

## 11. 隐私与素材许可

- 摄像头视频和 478 点检测在浏览器本地处理，项目没有上传接口，也没有业务后端。
- 浏览器仍会向 jsDelivr 和 Google 请求 MediaPipe 程序/模型；请求方可看到普通网络请求信息，但不会收到摄像头视频。
- 若隐私策略不允许外部依赖，应采用第 8 节的完全离线方案。
- `public/models/LICENSE.md` 记录了第三方 3D 工具与标准人脸拓扑来源。
- 化妆工具 GLB 来源为 Poly Pizza Makeup Assets，CC0 1.0。
- `canonical-face-model.obj` 来源于 Google MediaPipe，Apache License 2.0。
- 参考人脸照片、生成投影纹理和动作 JSON 属于业务素材；正式上线前需由素材提供方确认肖像权、数据使用范围和再分发权限。

## 12. 测试与上线验收

### 12.1 自动校验

```powershell
pnpm test:actions
pnpm build
```

当前预期校验结果：

```json
{
  "actions": 61,
  "realStrokeActions": 59,
  "semanticFallbackActions": 2,
  "officialRegions": 97,
  "actionRegionSlots": 122,
  "allHaveSourceFace": true
}
```

Vite 可能提示主 JS chunk 超过 500 kB，这是体积优化警告，不是构建失败。当前 Demo 可正常发布；如需提升弱网首屏，可后续把 MediaPipe 追踪模块拆成点击摄像头后再加载的独立 chunk。

### 12.2 人工验收清单

- [ ] HTTPS 页面可以打开，无 404、白屏或控制台报错。
- [ ] 首屏显示单一照片投影三维面部曲面；侧转时不得出现第二张背景脸、单侧色块、暗边或照片卡片。
- [ ] 下拉框存在 61 个动作，分类和编号正确。
- [ ] 动作轨迹、接触圈和化妆区域均为橙色系。
- [ ] 眼影/眉毛开放区域没有矩形填充。
- [ ] 鼠标拖拽预览人脸时，工具和轨迹同步旋转；双击恢复正面。
- [ ] 点击开启摄像头后能弹出浏览器权限请求。
- [ ] 授权后持续显示 478 点，左右转头时人脸、工具、轨迹和区域同步。
- [ ] 关闭摄像头后回到照片 3D 预览，摄像头指示灯熄灭。
- [ ] 真实 GLB 工具显示完整；柔软端面可呈现按压，硬质杆身/金属零穿模，正常接触距离不超过脸宽的 0.004。
- [ ] 移动端页面无横向滚动，动作选择和摄像头按钮可操作。
- [ ] 拒绝摄像头权限时页面仍能使用照片预览，不应崩溃。

建议至少人工抽查以下动作：黑眼圈遮瑕、眉毛、眼影打底、眼影提亮、默认眼线、全脸粉底、菱形腮红、方脸修容、鼻修容、高光、全脸定妆、嘴唇。

## 13. 常见故障

### 页面能开，但摄像头按钮失败

依次检查：

1. 当前 URL 是否为 HTTPS 或本机 `localhost/127.0.0.1`。
2. 地址栏中的摄像头权限是否被永久拒绝。
3. 控制台是否显示 jsDelivr、Google 模型或 CSP 拦截错误。
4. 是否在 iframe 内且没有 `allow="camera"`。
5. 是否有其他程序独占摄像头。

### 人脸出现但工具不跟随转头

- 确认状态文案为“478 点动态跟踪”，而不是照片预览。
- 查看控制台是否持续出现 `Face tracking frame skipped`。
- 保证脸部完整、光线均匀，避免大角度完全遮挡一侧脸。
- 不要在摄像头模式测试鼠标拖拽；该模式只使用实时人脸姿态。

### 动作或区域出现 404

- 确认部署的是整个 `dist/`，不是只有 `dist/assets/`。
- 检查 URL 中文文件名是否被服务器或 CDN 错误改写。
- 检查 Nginx 是否允许 `.json` 和 `.png` 并正确返回大小写敏感路径。
- 重新运行 `pnpm test:actions`，确认文件名与清单一致。

### 更新后用户仍看到旧轨迹或旧区域

- 清理 CDN 缓存中的 `/actions/`、`/regions/`。
- 不要给这些稳定文件名设置 `immutable`。
- 重新构建并完整替换 `dist/`，避免新旧文件混合。

### 性能较低或手机发热

- 关闭其他使用摄像头/GPU 的标签页。
- 优先使用新版 Chrome 或 Edge。
- 降低摄像头理想分辨率、渲染像素比或定位检测频率时，要同步做视觉回归。
- 当前 renderer 像素比上限为 2；弱端设备可进一步降至 1.5，但会损失清晰度。

## 14. 交接结论

本项目在运行阶段是静态网站，不需要数据库、API 服务或账号系统。最短发布链路是：

```text
pnpm install --frozen-lockfile → pnpm test:actions → pnpm build → 上传 dist/ → 配置 HTTPS → 真机验收摄像头
```

生产发布最容易遗漏的三点是：完整上传 `dist/` 中的素材目录、使用 HTTPS、保证 MediaPipe 外部资源可访问。若用于封闭网络，应在上线前完成 MediaPipe WASM 与模型的本地化。
