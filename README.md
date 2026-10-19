# Solace Mobile

[![test](https://github.com/wisemen-dev/Solace-Mobile/actions/workflows/test.yml/badge.svg)](https://github.com/wisemen-dev/Solace-Mobile/actions/workflows/test.yml)
[![Release](https://img.shields.io/github/v/release/wisemen-dev/Solace-Mobile)](https://github.com/wisemen-dev/Solace-Mobile/releases)

本地 PDF 私人图书馆 **Solace** 的平板端（Android / Capacitor 移植版）。
桌面端仓库：[wisemen-dev/Solace](https://github.com/wisemen-dev/Solace)。

与桌面端（Electron 版）共用同一套资料库数据格式——`library.json`、
`files/<id>.pdf`、`covers/<id>.jpg`、`textindex/` 分片、`notes/<id>/*.md`
完全互通，整个 `SolaceLibrary/` 目录可以在桌面与平板之间整库搬运，
进度、分类、标签、收藏夹、笔记全部保留。

## 截图

| 封面墙 | 书架视图 |
|---|---|
| ![封面墙](docs/screenshots/cover-wall.jpg) | ![书架视图](docs/screenshots/shelf.jpg) |
| **图书简介卡** | **阅读工具簇（标注 / 链接 / 笔记）** |
| ![图书简介卡](docs/screenshots/doc-info.jpg) | ![阅读工具簇](docs/screenshots/tools.jpg) |

<details>
<summary>更多截图</summary>

| 书脊视图 | 阅读预览 | 设置 |
|---|---|---|
| ![书脊视图](docs/screenshots/spine.jpg) | ![阅读预览](docs/screenshots/preview.jpg) | ![设置](docs/screenshots/settings.jpg) |

</details>

## 安装

从 [Releases](https://github.com/wisemen-dev/Solace-Mobile/releases) 下载 APK 安装。
应用不联网，资料库保存在应用专属外部目录；卸载应用会删除该目录，重要资料请保留桌面端母本。

## 功能与桌面端的对应

| 桌面端 | 平板端 |
|---|---|
| 拖拽 / 对话框导入 PDF | 「导入 PDF」按钮 → 系统文件选择器（支持多选） |
| 封面墙 / 书脊 / 书架三视图 | 同款三视图（横屏平板为双栏布局） |
| 内置 pdf.js 预览 + 外部阅读器 | 同款内置预览（滑动翻页 / 边缘点按翻页 / 目录 / 页码跳转） |
| Typora 打开笔记 | 内置 Markdown 编辑器（文件仍是普通 .md） |
| Ctrl+K 命令面板 | 顶栏 ⌘K 按钮（同一面板） |
| 悬停浮现操作按钮 | 触屏常显（无悬停设备自动切换） |
| 拖拽归档到分类 | 编辑对话框 / 批量管理里的「归档到分类」 |
| 监视文件夹自动入库（fs.watch） | **SAF 授权目录 + 启动/回前台补扫**（见下） |
| 命令面板拉起外部工具（Olib） | **同款**：拉起平板上的 Olib 应用（自动检测包名） |
| 资料库位置迁移 | 不适用（固定在应用专属外部目录） |

## Olib：从下载到上架

1. **在 Olib 里把保存目录设为公共目录**，如 `Download/olib-books`
   （应用私有目录 Solace 无权读取）
2. **Solace → 设置 → 资料库 → 监视文件夹 → 「浏览…」**，系统选择器里
   选中该目录授权（持久化，重启免重授权）；可设「自动入库归入分类」
3. 用法与桌面端一致：命令面板 ⌘K →「🚀 打开外部工具」拉起 Olib 搜书，
   下载完切回 Solace 即自动入库（内容去重，重复静默跳过）

首次使用若「打开外部工具」提示未检测到：设置 → 资料库 → 下载工具 →
「检测…」选定 Olib（包名 `com.open_library.app`）。

## 开发

- Node.js ≥ 20，JDK 21，Android SDK
- `npm install`：安装依赖
- `npm test`：数据层与界面回归测试（纯 Node）
- `npm run apk`：构建 debug APK

渲染层同步、补丁清单与移植细节见 [docs/PORTING.md](docs/PORTING.md)。

## 项目结构

| 目录 | 作用 |
|---|---|
| `bridge/` | `window.solace` 桥接层与数据层 |
| `mobile-web/` | 触屏适配、手写标注、摘录链接、简介卡 |
| `www/` | Capacitor webDir（桌面渲染层 + 补丁 + vendor） |
| `android/` | Capacitor Android 工程与原生插件 |
| `test/` | 数据层与界面回归测试 |
| `scripts/` | 同步、构建、测试辅助 |
| `docs/` | 移植文档、设计书与截图 |

## 数据存放在哪里

应用专属外部目录（免权限，卸载应用时随之删除）：

```
/storage/emulated/0/Android/data/com.molly.solacemobile/files/SolaceLibrary/
├── library.json   # 全部元数据（与桌面端同格式）
├── files/         # PDF 副本（UUID 命名，与桌面端同规则）
├── covers/        # 封面缩略图缓存
├── textindex/     # 全文索引分片（可删，自动重建）
├── annotations/   # 手写标注（移动端专有，桌面端静默忽略）
├── links/         # 摘录链接锚点（移动端专有，桌面端静默忽略）
└── notes/         # 每本书的 Markdown 笔记
```

## Contributors

- [Molly](https://github.com/wisemen-dev) — 设计、开发与真机验收
- DeepSeek — AI 编程助手（协助移植、测试与文档；无 GitHub 账号）

## 许可证

MIT。霞鹜文楷 Lite（OFL）、pdf.js（Apache-2.0）遵循其各自协议，
许可文件随 `www/vendor/` 一起分发。
