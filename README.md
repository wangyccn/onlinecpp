# Online C++ Studio (在线 C++ 工作台)

🚀 **Online C++ Studio** 是一个纯客户端、原生级别的现代在线 C++ 集成开发环境（IDE），基于 WebAssembly 全套工具链构建，无需安装本地编译器或后端服务器，打开浏览器即可秒级编写、构建、调试和运行 C++ 程序。

---

## ✨ 核心特性 (Features)

- **纯浏览器端编译 (Pure Client-side Toolchain)**:
  - 基于 **Emception (LLVM Clang & wasm-ld)**，在浏览器 Web Worker 中直接编译 C/C++ 源码为独立的 WebAssembly 二进制模块。
  - 支持 **C++11 / C++14 / C++17 / C++20 / C++23** 标准。
  - 内置竞技编程万能头文件 `<bits/stdc++.h>` 完整标准库支持。
- **即时实时 I/O 运行环境 (Real-time WASI Runner)**:
  - 编译、程序执行、磁盘 IO 分别在 Worker 中运行，阻塞式 C/C++ 调用不阻塞页面。
  - 标准输出使用 256KiB 有界共享环形缓冲，页面按批消费；程序死循环也不妨碍已打印内容显示，持续刷屏不会无限堆积消息。
  - 支持交互式标准输入输出（`cin` / `cout` / `scanf` / `printf`）、多行粘贴和 Ctrl+D EOF。
  - 拥有「**Build & Run (F5)**」与「**Run Only (Ctrl+F5)**」两种模式，支持直接复用运行缓存的 WebAssembly 模块。
- **原生文件系统对接 (Native File System Access API)**:
  - 支持直接打开并授权访问本地文件夹（Open Folder），直接读写磁盘文件，告别上传下载。
  - 停止编辑 800ms 后按文件合并保存；旧保存完成不会清除新修改的未保存标记，失败后保留编辑内容以供重试。
  - C/C++ 文件流与编辑器共享授权文件夹，构建、运行产物不再持久化到内置 VFS。
- **智能化代码编辑 (Monaco Editor & Clangd WASM)**:
  - 深度集成 VS Code 核心编辑器 Monaco Editor（专属精简优化，仅打包 C/C++ 渲染核心，剔除 80+ 冗余语言包）。
  - 集成 `@algoproclub/clangd-wasm`，提供代码补全、悬浮文档、错误即时诊断（Diagnostics & Problem Panel）。
- **Linux 风格命令行 (Interactive Virtual Shell)**:
  - 支持 `wget`, `curl`, `sed`, `rm -rf`, `cp`, `mv`, `ln`, `file`, `cat`, `wc`, `md5sum`, `find`, `grep`。
  - 支持标准 Unix 管道 `|` 与重定向 `>` / `>>`。
  - 编译时终端归前台任务占用，不会把输入当作新的 shell 命令；终端 Ctrl+C 或顶部 Stop 可终止正在执行的编译/程序 Worker。

---

## ⌨️ 快捷键 (Keyboard Shortcuts)

| 快捷键 | 功能说明 |
| :--- | :--- |
| **`F5`** | **Build & Run**（自动保存、编译并运行当前文件） |
| **`Ctrl+F5`** / **`Shift+F5`** | **Run Only**（不编译，直接执行已缓存的 WebAssembly 模块） |
| **`Ctrl+B`** | **Compile**（仅编译并输出详细的构建日志与错误标记） |
| **`Ctrl+S`** | **Save**（保存当前活动文件） |
| **终端 `Ctrl+C` / Stop 按钮** | 中断前台编译或运行 |
| **程序运行时 `Ctrl+D`** | 发送标准输入 EOF |

## 保存、构建缓存与本地 C/C++ IO

1. 默认通过 **Open Folder** 选择并授权本地目录。源码、最终 WASM、程序生成的文件最终同步到此目录；默认生成的 WASM 与对应源码同目录。也可在设置的 **文件存储模式** 中选择 **无需存储磁盘（仅 IndexedDB）**：这是独立浏览器工作区，不会自动复制或迁移本地目录。
2. 自动保存按文件防抖，停止编辑 800ms 后合并保存。编辑器、编译器挂载与 C/C++ 运行时的项目文件 IO 统一经过 `src/services/bufferedFileSystem.ts`：先提交 IndexedDB 事务，再用 3 路池、650ms 写回窗口异步合并外部 IO。读、目录、stat、源码快照均先看到待提交的新版本；短命临时文件可以在落盘前直接取消。Ctrl+S、关闭标签及构建等待的是 IndexedDB 提交，不再逐次等待外部写盘；只有对应模型版本未变化才移除 dirty。
3. 外部 `.onlinecpp/cache/` 保存目标文件及依赖/链接元数据，空闲时可以删除以强制重建。按源码、编译选项、实际依赖内容及头文件存在性探测（包括 `__has_include`）校验缓存，未修改的翻译单元跳过 clang；目标文件字节及输出仍匹配时跳过链接。缓存元数据可跨编译器重启/页面重新挂载复用。默认 `-O0` 优先缩短开发构建，`-O1/-O2/-O3` 可按运行速度需求选择。
4. 本地模式的 IndexedDB 是待写日志，不是长期重复产物库：成功落盘后仅清理对应版本，不能让旧写入完成时误删较新版本。失败保留缓存并在状态栏告警；点击底部磁盘状态立即同步或重试。重新打开同一授权目录会恢复待写日志，目录身份用 `isSameEntry` 匹配而非目录名；同一工作区避免多标签同时写回。关闭前请确认 **Disk synced**。页面警告不是备份，尚未进入 IndexedDB 的编辑仍可能丢失。
5. 仅 IndexedDB 模式不调用外部磁盘后端、不在保存后清理文件，重新打开页面可继续使用；读写、编译输出、C/C++ 运行文件都在此工作区。**清除站点数据、浏览器存储回收或存储配额不足会影响文件与未同步缓存，重要数据请备份。** 模式切换不隐式迁移数据，本地模式切走前需要完成同步。升级不会擅自清除旧版本站点数据。
6. 程序默认工作目录为当前工作区根；shell 的 `run file.wasm arg1` 或 `./file.wasm arg1` 使用 shell 当前目录并传递 argv。`/workspace`、`/home/user` 映射到当前工作区，不能访问目录外的任意 Windows/Linux 绝对路径。

支持 `ifstream/ofstream/fstream`、`fopen/fread/fwrite`、二进制文件、append、seek、truncate、基本 stat/mkdir/remove。文件修改在关闭、同步、正常退出时合并提交；中断时尽力提交已进入 IO Worker 的数据。程序本身尚未 `fflush/flush` 的 libc/C++ 缓冲不能保证保留。程序持有写句柄时，编辑器保存同一路径会失败并保留 dirty，避免静默互相覆盖。

这不是完整 Linux/POSIX：浏览器权限、符号链接、任意主机路径、进程、网络及部分系统调用不等同于原生系统；不支持的操作明确报错，而不是假装写入成功。文件仍采用运行期内存缓冲，超大文件受浏览器内存限制。

### 浏览器要求

使用支持目录选择和 File System Access API 的 Chromium 浏览器；需要 HTTPS 或 localhost 安全上下文，以及 COOP/COEP 跨源隔离（`crossOriginIsolated === true`）。同步 C++ IO 通过 SharedArrayBuffer/Atomics 仅暂停执行 Worker，实际磁盘读写使用独立 IO Worker 内的异步文件流。不能将 OPFS 专用同步句柄直接用于用户授权的本地目录。clangd 还需要当前浏览器支持 WebAssembly JSPI，否则使用已有降级提示。

首次工具链下载、解压与 WASM 初始化仍有冷启动成本；缓存命中的毫秒级构建不代表所有源码都能在同样时间内完成。

---

## 🛠️ 本地开发与构建 (Getting Started)

### 环境要求
- Node.js >= 20.19（或受当前 Vite 支持的更新版本）
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

### 回归测试

```bash
npm test
npm run build
npm run test:browser
```

浏览器打开 `http://localhost:5174/tests/browser.html`，点击 **Run regressions**。测试页用独立 OPFS 子目录验证相同的目录句柄接口，不修改用户本地项目；覆盖真实 IndexedDB、异步写回、纯浏览器工作区、真实 clang/wasm-ld、增量缓存、保存竞态、终端前台、C/C++ 读写和中断。也可用 `?group=io` / `?group=browser`（纯 IndexedDB 编译运行）/ `?group=compiler` / `?group=runtime` / `?group=clangd` 分组定位。手工验收真实磁盘授权、权限撤销和外部编辑器互操作时，仍需在应用中选择一个专用测试目录。

集成测试服务器关闭 HMR/文件监听，修改实现后应重启该服务器，确保测试的是新代码。

写回层回归同时覆盖：旧版本完成/较新版本覆盖、落盘失败与重放、删除再创建、存储配额失败、池并发上限，以及注释屏蔽、未限定 std 补全和正常 LSP 取消。浏览器性能数字受工具链冷启动、机器负载、浏览器与真实磁盘影响；OPFS/模拟慢盘测试不代表用户授权的本地磁盘延迟，不承诺所有项目都能加速到同一耗时。

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
