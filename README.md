# Online C++ Studio (在线 C++ 工作台)

🚀 **Online C++ Studio** 是一个纯客户端、原生级别的现代在线 C++ 集成开发环境（IDE），基于 WebAssembly 全套工具链构建，无需安装本地编译器或后端服务器，打开浏览器即可秒级编写、构建、调试和运行 C++ 程序。

---

## ✨ 核心特性 (Features)

- **纯浏览器端编译 (Pure Client-side Toolchain)**:
  - 基于 **Emception (LLVM Clang & wasm-ld)**，在浏览器 Web Worker 中直接编译 C/C++ 源码为独立的 WebAssembly 二进制模块。
  - 支持 **C++11 / C++14 / C++17 / C++20 / C++23** 标准。
  - 内置竞技编程万能头文件 `<bits/stdc++.h>` 完整标准库支持。
- **即时实时 I/O 运行环境 (Real-time WASI Runner)**:
  - 真正实现非阻塞、即时刷盘的交互式标准输入输出（`cin` / `cout` / `scanf` / `printf`）。
  - 支持多行测试用例直接粘贴、剪切、单步交互。
  - 拥有「**Build & Run (F5)**」与「**Run Only (Ctrl+F5)**」两种模式，支持直接复用运行缓存的 WebAssembly 模块。
- **原生文件系统对接 (Native File System Access API)**:
  - 支持直接打开并授权访问本地文件夹（Open Folder），直接读写磁盘文件，告别上传下载。
- **智能化代码编辑 (Monaco Editor & Clangd WASM)**:
  - 深度集成 VS Code 核心编辑器 Monaco Editor（专属精简优化，仅打包 C/C++ 渲染核心，剔除 80+ 冗余语言包）。
  - 集成 `@algoproclub/clangd-wasm`，提供代码补全、悬浮文档、错误即时诊断（Diagnostics & Problem Panel）。
- **内置完整 Linux 仿真命令行 (Interactive Virtual Shell)**:
  - 支持 `wget`, `curl`, `sed`, `rm -rf`, `cp`, `mv`, `ln`, `file`, `cat`, `wc`, `md5sum`, `find`, `grep`。
  - 支持标准 Unix 管道 `|` 与重定向 `>` / `>>`。

---

## ⌨️ 快捷键 (Keyboard Shortcuts)

| 快捷键 | 功能说明 |
| :--- | :--- |
| **`F5`** | **Build & Run**（自动保存、编译并运行当前文件） |
| **`Ctrl+F5`** / **`Shift+F5`** | **Run Only**（不编译，直接执行已缓存的 WebAssembly 模块） |
| **`Ctrl+B`** | **Compile**（仅编译并输出详细的构建日志与错误标记） |
| **`Ctrl+S`** | **Save**（保存当前活动文件） |

---

## 🛠️ 本地开发与构建 (Getting Started)

### 环境要求
- Node.js >= 18
- pnpm (推荐) 或 npm / yarn

### 启动开发服务器
```bash
# 1. 安装依赖
pnpm install

# 2. 启动本地开发服务 (自带 COOP/COEP 隔离头)
pnpm run dev
```

### 生产打包
```bash
# 执行类型检查与 Vite 极速打包
pnpm run build
```
打包生成物将输出到 `dist/` 目录，并已自动包含跨域隔离配置文件 [`dist/_headers`](public/_headers)。

---

## 🌐 部署 (Deployment)

本项目构建产物为纯静态资源，可直接部署在任意支持自定义响应头的静态托管平台上：

### Cloudflare Pages
项目已预置 `_headers` 文件，只需在命令行执行：
```bash
pnpm run deploy
```
或者在 Cloudflare Pages 控制台中关联该 GitHub 仓库即可自动持续集成部署。

### Vercel / Netlify
直接推送至 GitHub 后在控制台一键导入仓库部署。

---

## 📄 开源许可证 (License)

本项目采用 [MIT License](LICENSE) 许可协议开源。
