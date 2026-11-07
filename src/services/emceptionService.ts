import { createEmception, BrowserEmceptionAPI, DEFAULT_MANIFEST_URL } from '@gameguild/emception-browser';
import { TerminalService } from './terminalService';
import { CompilerResult } from '../types';

// Standard Clang -cc1 and wasm-ld flags for Emception's in-browser C++ toolchain
const CC1_FRONTEND = [
  '-cc1',
  '-triple', 'wasm32-unknown-emscripten',
  '-emit-obj',
  '-disable-free',
  '-clear-ast-before-backend',
  '-disable-llvm-verifier',
  '-discard-value-names',
  '-mrelocation-model', 'static',
  '-mframe-pointer=none',
  '-ffp-contract=on',
  '-fno-rounding-math',
  '-mconstructor-aliases',
  '-target-cpu', 'generic',
  '-fvisibility=hidden',
];

const CC1_CPP_INCLUDES = [
  '-internal-isystem', '/usr/include/c++/v1',
  '-internal-isystem', '/usr/include/compat',
  '-internal-isystem', '/usr/lib/clang/23/include',
  '-resource-dir', '/usr/lib/clang/23',
  '-internal-isystem', '/usr/include',
  '-I', '/home/user',
  '-I', '/home/user/include',
  '-I', '/home/user/default',
  '-I', '/home/user/default/include',
  '-I', '/',
];

// Universal C++ Header <bits/stdc++.h> for competitive programming & standard C++ compatibility
const BITS_STDCPP_HEADER = `// C++ Universal Header <bits/stdc++.h> for WebAssembly Clang / Emception
#ifndef _BITS_STDCPP_H
#define _BITS_STDCPP_H

// C Includes
#include <cassert>
#include <cctype>
#include <cerrno>
#include <cfloat>
#include <ciso646>
#include <climits>
#include <clocale>
#include <cmath>
#include <csetjmp>
#include <csignal>
#include <cstdarg>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <cwchar>
#include <cwctype>

// C++ Standard Library
#include <algorithm>
#include <bitset>
#include <complex>
#include <deque>
#include <exception>
#include <fstream>
#include <functional>
#include <iomanip>
#include <ios>
#include <iosfwd>
#include <iostream>
#include <istream>
#include <iterator>
#include <limits>
#include <list>
#include <locale>
#include <map>
#include <memory>
#include <new>
#include <numeric>
#include <ostream>
#include <queue>
#include <set>
#include <sstream>
#include <stack>
#include <stdexcept>
#include <streambuf>
#include <string>
#include <typeinfo>
#include <utility>
#include <valarray>
#include <vector>

#if __cplusplus >= 201103L
#include <array>
#include <atomic>
#include <chrono>
#include <forward_list>
#include <initializer_list>
#include <random>
#include <ratio>
#include <regex>
#include <scoped_allocator>
#include <system_error>
#include <tuple>
#include <typeindex>
#include <type_traits>
#include <unordered_map>
#include <unordered_set>
#if !defined(_LIBCPP_HAS_NO_THREADS) && __has_include(<mutex>)
#include <condition_variable>
#include <future>
#include <mutex>
#include <thread>
#endif
#endif

#if __cplusplus >= 201402L
#if !defined(_LIBCPP_HAS_NO_THREADS) && __has_include(<shared_mutex>)
#include <shared_mutex>
#endif
#endif

#if __cplusplus >= 201703L
#include <any>
#if __has_include(<charconv>)
#include <charconv>
#endif
#if __has_include(<filesystem>)
#include <filesystem>
#endif
#include <optional>
#include <string_view>
#include <variant>
#endif

#if __cplusplus >= 202002L
#if __has_include(<bit>)
#include <bit>
#endif
#if __has_include(<compare>)
#include <compare>
#endif
#if __has_include(<concepts>)
#include <concepts>
#endif
#if __has_include(<numbers>)
#include <numbers>
#endif
#if __has_include(<ranges>)
#include <ranges>
#endif
#if __has_include(<span>)
#include <span>
#endif
#if __has_include(<version>)
#include <version>
#endif
#endif

#endif // _BITS_STDCPP_H
`;

const ONLINECPP_RUNTIME_HEADER = `// Online C++ Studio Auto-Flushing & Unbuffered Runtime Support
#pragma once
#ifndef __ONLINECPP_RUNTIME_H__
#define __ONLINECPP_RUNTIME_H__

#include <stdio.h>

#ifdef __cplusplus
#include <iostream>

struct __OnlineCppAutoFlusher {
  __OnlineCppAutoFlusher() {
    std::ios_base::sync_with_stdio(true);
    std::cout.setf(std::ios_base::unitbuf);
    std::cerr.setf(std::ios_base::unitbuf);
  }
  ~__OnlineCppAutoFlusher() {
    std::cout.flush();
    std::cerr.flush();
    fflush(NULL);
  }
};
static __OnlineCppAutoFlusher __onlinecpp_flusher_instance;
#endif

#ifdef __cplusplus
extern "C" {
#endif
static inline void __attribute__((constructor(101))) __onlinecpp_unbuffer_stdio(void) {
  setvbuf(stdout, NULL, _IONBF, 0);
  setvbuf(stderr, NULL, _IONBF, 0);
}

static inline void __attribute__((destructor(101))) __onlinecpp_flush_stdio(void) {
  fflush(NULL);
}
#ifdef __cplusplus
}
#endif

#endif // __ONLINECPP_RUNTIME_H__
`;

const CC1_TAIL = [
  '-fdeprecated-macro',
  '-ferror-limit', '19',
  '-fgnuc-version=4.2.1',
  '-Wno-register',
  '-Wno-deprecated-register',
  '-Wno-shift-op-parentheses',
  '-Wno-unused-result',
];
const CC1_CPP_EXC = ['-fcxx-exceptions', '-fexceptions'];

const WASM_LD_BASE = [
  '-L/usr/lib/emscripten/cache-lib/wasm32-emscripten',
  '--entry=main',
  '--import-undefined',
  '--allow-undefined',
  '--export-table',
  '--table-base=1',
  '--export=__wasm_call_ctors',
  '--export-if-defined=fflush',
  '--export-if-defined=exit',
  '--export-if-defined=__wasm_call_dtors',
];

const WASM_LD_CPP_LIBS = [
  '-lc++-noexcept',
  '-lc++abi-noexcept',
  '-lc',
  '-ldlmalloc',
  '-lcompiler_rt',
  '-lsockets',
];

export class EmceptionService {
  private em: BrowserEmceptionAPI | null = null;
  private isInitializing = false;
  private isReady = false;
  private terminalService: TerminalService;
  private lastCompiledWasm: Uint8Array | null = null;
  private initPromise: Promise<boolean> | null = null;
  private headersInstalled = false;
  private syncedFilesCache: Map<string, string> = new Map();

  constructor(terminalService: TerminalService) {
    this.terminalService = terminalService;
  }

  public isCompilerReady(): boolean {
    return this.isReady;
  }

  public getLastCompiledWasm(): Uint8Array | null {
    return this.lastCompiledWasm;
  }

  public setLastCompiledWasm(bytes: Uint8Array | null): void {
    this.lastCompiledWasm = bytes;
  }

  public async readVfsFile(vfsPath: string): Promise<Uint8Array | null> {
    if (!this.em) return null;
    try {
      const data = await this.em.workspace.readFile(vfsPath);
      return data || null;
    } catch {
      return null;
    }
  }

  public async init(): Promise<boolean> {
    if (this.isReady) return true;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      this.isInitializing = true;

      try {
        console.log('[EmceptionService] Initializing Emception headless compiler toolchain...');

        // In production (GitHub Pages / custom domain), directly use high-speed jsDelivr CDN manifest;
        // only probe local dev middleware when running on localhost.
        const isLocalDev = typeof window !== 'undefined' && (
          window.location.hostname === 'localhost' ||
          window.location.hostname === '127.0.0.1' ||
          window.location.hostname === '0.0.0.0'
        );

        let manifest = DEFAULT_MANIFEST_URL;
        if (isLocalDev) {
          try {
            const testRes = await fetch('/emception-cdn/manifest.json', { method: 'HEAD' });
            if (testRes.ok) {
              manifest = '/emception-cdn/manifest.json';
            }
          } catch {
            manifest = DEFAULT_MANIFEST_URL;
          }
        }

        console.log('[EmceptionService] Using toolchain manifest:', manifest);

        // Crucial: use tty: 'none' to avoid starting MiniShell or double-attaching to xterm
        this.em = await createEmception({
          tty: 'none',
          manifestUrl: manifest,
        });

        this.isReady = true;
        this.isInitializing = false;
        await this.ensureStandardHeaders();
        console.log('[EmceptionService] Emception toolchain ready!');
        return true;
      } catch (err: any) {
        console.warn('[EmceptionService] createEmception failed:', err);
        this.isInitializing = false;
        return false;
      }
    })();

    return this.initPromise;
  }

  private async ensureStandardHeaders(): Promise<void> {
    if (!this.em || this.headersInstalled) return;
    const headerTasks = [
      this.em.workspace.writeFile('/home/user/bits/stdc++.h', BITS_STDCPP_HEADER),
      this.em.workspace.writeFile('/home/user/include/bits/stdc++.h', BITS_STDCPP_HEADER),
      this.em.workspace.writeFile('/home/user/__onlinecpp_runtime.h', ONLINECPP_RUNTIME_HEADER),
      this.em.workspace.writeFile('/home/user/include/__onlinecpp_runtime.h', ONLINECPP_RUNTIME_HEADER),
    ];
    await Promise.allSettled(headerTasks);
    this.headersInstalled = true;
  }

  public async syncFiles(
    files: Record<string, string>,
    forceFile?: string,
    buildMode: 'single' | 'project' = 'single'
  ): Promise<void> {
    if (!this.em) return;

    await this.ensureStandardHeaders();

    const cleanForce = forceFile ? forceFile.replace(/^\/+/, '') : undefined;
    const writeTasks: Promise<void>[] = [];
    for (const [rawPath, content] of Object.entries(files)) {
      const cleanPath = rawPath.replace(/^\/+/, '');
      const isForced = cleanForce && cleanPath === cleanForce;

      // In single file mode, skip syncing unrelated .cpp/.c files
      if (buildMode === 'single' && !isForced) {
        const isCppSource = /\.(cpp|cc|cxx|c)$/i.test(cleanPath);
        if (isCppSource) {
          continue;
        }
      }

      if (!isForced && this.syncedFilesCache.get(cleanPath) === content) {
        // Skip writing unchanged files
        continue;
      }
      this.syncedFilesCache.set(cleanPath, content);

      writeTasks.push(
        (async () => {
          try {
            await this.em!.workspace.writeFile(`/home/user/${cleanPath}`, content);
          } catch (e) {
            console.warn(`[EmceptionService] Failed to sync ${cleanPath}:`, e);
          }
        })()
      );
    }

    if (writeTasks.length > 0) {
      await Promise.all(writeTasks);
    }
  }

  public async compile(
    mainFile: string,
    allFiles: Record<string, string>,
    options: {
      standard?: string;
      optimization?: string;
      buildMode?: 'single' | 'project';
    } = {}
  ): Promise<CompilerResult> {
    const t0 = performance.now();
    const std = options.standard || 'c++20';
    // Use -O1 for fast in-browser builds and compact object files
    const opt = (!options.optimization || options.optimization === '-O0') ? '-O1' : options.optimization;
    const buildMode = options.buildMode || 'single';

    const cleanMain = mainFile.replace(/^\/+/, '');
    const modeLabel = buildMode === 'single' ? 'Single File Mode' : 'Project Mode';
    this.terminalService.writeLine(`\r\n\x1b[33m[Compiler] Compiling ${cleanMain} (${std}, ${opt}, ${modeLabel})...\x1b[0m`);

    // Ensure toolchain is ready
    const ready = await this.init();

    if (!ready || !this.em) {
      const msg = `[Compiler Error] Emception toolchain could not be initialized.\nPlease ensure Cross-Origin Isolation headers are enabled.`;
      this.terminalService.writeLine(`\x1b[31m${msg}\x1b[0m`);
      return {
        exitCode: 1,
        stdout: '',
        stderr: msg,
        durationMs: performance.now() - t0,
      };
    }

    // 1. Sync workspace files to VFS (in single mode, skips unrelated .cpp sources)
    await this.syncFiles(allFiles, cleanMain, buildMode);

    // 2. Determine sources to compile
    let sourcesToCompile: string[];
    if (buildMode === 'single') {
      // In Single File Mode, compile ONLY the current file so each file can have its own main()!
      sourcesToCompile = [cleanMain];
    } else {
      // In Project Mode, compile all C++ sources in the workspace
      const cppSources = Object.keys(allFiles).filter((f) => {
        const clean = f.replace(/^\/+/, '');
        return clean.endsWith('.cpp') || clean.endsWith('.cc') || clean.endsWith('.cxx') || clean.endsWith('.c');
      });
      sourcesToCompile = cppSources.includes(cleanMain)
        ? [cleanMain, ...cppSources.filter((s) => s !== cleanMain)]
        : [cleanMain];
    }

    const objectPaths: string[] = [];
    let stdoutTotal = '';
    let stderrTotal = '';

    const runOptions = {
      cwd: '/home/user',
      stdout: (data: Uint8Array | string) => {
        const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
        stdoutTotal += text;
        this.terminalService.write(text);
      },
      stderr: (data: Uint8Array | string) => {
        const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
        stderrTotal += text;
        this.terminalService.write(text);
      },
      onStdout: (text: string) => {
        stdoutTotal += text;
        this.terminalService.write(text);
      },
      onStderr: (text: string) => {
        stderrTotal += text;
        this.terminalService.write(text);
      },
    };

    const stdFlag =
      std === 'c++11' ? '-std=c++11' :
      std === 'c++14' ? '-std=c++14' :
      std === 'c++17' ? '-std=c++17' :
      std === 'c++23' ? '-std=c++2c' :
      '-std=c++20';

    try {
      // Step A: Compile each C++ source into an object file (.o)
      for (const src of sourcesToCompile) {
        const sourcePath = `/home/user/${src}`;
        const objectPath = `/home/user/${src.replace(/[\/\\]/g, '_')}.o`;
        objectPaths.push(objectPath);

        const fileName = src.split('/').pop() || src;
        const isCpp = !src.endsWith('.c');
        const compileArgv = [
          'clang',
          ...CC1_FRONTEND,
          ...CC1_CPP_INCLUDES,
          stdFlag,
          opt,
          ...CC1_TAIL,
          ...CC1_CPP_EXC,
          '-include', '/home/user/__onlinecpp_runtime.h',
          '-main-file-name', fileName,
          '-o', objectPath,
          '-x', isCpp ? 'c++' : 'c',
          sourcePath,
        ];

        this.terminalService.writeLine(`\x1b[90m$ clang (cc1) -o ${fileName}.o ${fileName}\x1b[0m`);
        const compileRes = await this.em.run('clang', compileArgv, runOptions);

        if (compileRes.exitCode !== 0) {
          this.lastCompiledWasm = null;
          const durationMs = performance.now() - t0;
          this.terminalService.writeLine(`\x1b[31m[Compiler] Compilation failed for ${src} with exit code ${compileRes.exitCode}\x1b[0m`);
          return {
            exitCode: compileRes.exitCode,
            stdout: stdoutTotal,
            stderr: stderrTotal || compileRes.stderr || '',
            durationMs,
          };
        }
      }

      // Step B: Link all object files into program.wasm using wasm-ld
      const wasmPath = '/home/user/program.wasm';
      try {
        await this.em.workspace.deleteFile(wasmPath);
      } catch {
        // ignore delete if not exists
      }

      const linkArgv = [
        'wasm-ld',
        ...objectPaths,
        '-o', wasmPath,
        ...WASM_LD_BASE,
        ...WASM_LD_CPP_LIBS,
      ];

      this.terminalService.writeLine(`\x1b[90m$ wasm-ld -o program.wasm ${objectPaths.map((p) => p.split('/').pop()).join(' ')}\x1b[0m`);
      const linkRes = await this.em.run('wasm-ld', linkArgv, runOptions);

      const durationMs = performance.now() - t0;

      if (linkRes.exitCode !== 0) {
        this.lastCompiledWasm = null;
        this.terminalService.writeLine(`\x1b[31m[Compiler] Linking failed with exit code ${linkRes.exitCode}\x1b[0m`);
        return {
          exitCode: linkRes.exitCode,
          stdout: stdoutTotal,
          stderr: stderrTotal || linkRes.stderr || '',
          durationMs,
        };
      }

      // Step C: Read the resulting WASM binary
      let wasmBytes: Uint8Array | undefined;
      try {
        const raw = await this.em.workspace.readFile(wasmPath);
        if (raw) {
          wasmBytes = raw;
          this.lastCompiledWasm = raw;
        }
      } catch (e) {
        console.warn('[EmceptionService] Output binary could not be read from VFS:', e);
      }

      this.terminalService.writeLine(
        `\x1b[32m[Compiler] Build successful in ${durationMs.toFixed(1)}ms! Binary generated: program.wasm\x1b[0m`
      );

      return {
        exitCode: 0,
        stdout: stdoutTotal,
        stderr: stderrTotal,
        outputPath: 'program.wasm',
        wasmBytes,
        durationMs,
      };
    } catch (err: any) {
      const durationMs = performance.now() - t0;
      this.terminalService.writeLine(`\x1b[31m[Compiler Error] ${err.message || String(err)}\x1b[0m`);
      return {
        exitCode: 1,
        stdout: stdoutTotal,
        stderr: err.message || String(err),
        durationMs,
      };
    }
  }

  public async runWasmBinary(wasmName = 'program.wasm', wasmBytes?: Uint8Array): Promise<number> {
    const t0 = performance.now();
    const cleanWasmName = wasmName.split('/').pop()?.split('\\').pop() || 'program.wasm';
    const bytesToRun = wasmBytes || this.lastCompiledWasm;

    let lineBuffer = '';
    const stdinQueue: number[] = [];
    let pendingStdinResolver: ((byte: number | null) => void) | null = null;
    let isProgramActive = true;

    const pushByteToStdin = (byte: number) => {
      if (pendingStdinResolver) {
        const resolve = pendingStdinResolver;
        pendingStdinResolver = null;
        resolve(byte);
      } else {
        stdinQueue.push(byte);
      }
    };

    const flushLine = () => {
      const lineToFlush = lineBuffer + '\n';
      lineBuffer = '';
      const encoded = new TextEncoder().encode(lineToFlush);
      for (let i = 0; i < encoded.length; i++) {
        pushByteToStdin(encoded[i]);
      }
    };

    // Connect terminal stdin to interactive buffer with line buffering & editing
    this.terminalService.startProgramExecution(cleanWasmName, (input) => {
      if (!isProgramActive) return;

      // 1. Strip bracketed paste markers if present
      const cleanInput = input.replace(/\x1b\[20[01]~/g, '');
      if (!cleanInput) return;

      // 2. Normalize all newlines (\r\n, \r, \n) to single standard \n
      const normalized = cleanInput.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      const isMultiLine = normalized.includes('\n');

      for (let i = 0; i < normalized.length; i++) {
        const char = normalized[i];
        const code = normalized.charCodeAt(i);

        if (code === 3) {
          // Ctrl+C - interrupt
          if (pendingStdinResolver) {
            const resolve = pendingStdinResolver;
            pendingStdinResolver = null;
            resolve(-1);
          }
          return;
        }

        if (code === 4) {
          // Ctrl+D - EOF
          if (lineBuffer.length > 0) {
            flushLine();
          }
          pushByteToStdin(-1);
          return;
        }

        if (char === '\n') {
          flushLine();
        } else if (code === 127 || code === 8) {
          // Backspace
          if (lineBuffer.length > 0) {
            lineBuffer = lineBuffer.slice(0, -1);
          }
        } else if (code >= 32 || char === '\t') {
          lineBuffer += char;
        }
      }

      // If user pasted a multi-line test case and the last line didn't end with a newline,
      // auto-flush it so the competitive programming problem immediately receives all input!
      if (isMultiLine && lineBuffer.length > 0) {
        flushLine();
      }
    });

    const stdinFn = (): Promise<number | null> | number => {
      if (stdinQueue.length > 0) {
        return stdinQueue.shift()!;
      }
      return new Promise<number | null>((resolve) => {
        pendingStdinResolver = resolve;
      });
    };

    try {
      // 1. Primary execution via Emception Worker (supports real-time stdin via SharedArrayBuffer & Atomics.wait)
      const ready = await this.init();
      if (ready && this.em) {
        const vfsWasmPath = `/home/user/${cleanWasmName}`;
        if (bytesToRun) {
          try {
            await this.em.workspace.writeFile(vfsWasmPath, bytesToRun);
            if (cleanWasmName !== 'program.wasm') {
              await this.em.workspace.writeFile('/home/user/program.wasm', bytesToRun);
            }
          } catch (e) {
            console.warn('[EmceptionService] Write wasm to VFS warning:', e);
          }
        }

        const runOptions = {
          cwd: '/home/user',
          stdin: stdinFn,
          stdout: (data: Uint8Array | string) => {
            const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
            this.terminalService.write(text);
          },
          stderr: (data: Uint8Array | string) => {
            const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
            this.terminalService.write(text);
          },
          onStdout: (text: string) => {
            this.terminalService.write(text);
          },
          onStderr: (text: string) => {
            this.terminalService.write(text);
          },
        };

        try {
          const result = await this.em.run('wasi-run', ['wasi-run', vfsWasmPath], runOptions);
          const durationMs = performance.now() - t0;
          this.terminalService.endProgramExecution(result.exitCode, durationMs);
          return result.exitCode;
        } catch (workerErr: any) {
          console.warn('[EmceptionService] Worker wasi-run execution failed, falling back to browser WASI runtime:', workerErr);
          if (bytesToRun) {
            const exitCode = await this.runWithBrowserWasi(bytesToRun);
            this.terminalService.endProgramExecution(exitCode, performance.now() - t0);
            return exitCode;
          }
          throw workerErr;
        }
      }

      // 2. Fallback execution via Browser Main-Thread WASI
      if (bytesToRun) {
        const exitCode = await this.runWithBrowserWasi(bytesToRun);
        this.terminalService.endProgramExecution(exitCode, performance.now() - t0);
        return exitCode;
      }

      this.terminalService.writeLine('\x1b[31mNo compiled WebAssembly binary found to execute.\x1b[0m');
      this.terminalService.endProgramExecution(1, performance.now() - t0);
      return 1;
    } catch (e: any) {
      this.terminalService.writeLine(`\x1b[31mRuntime execution error: ${e.message || String(e)}\x1b[0m`);
      this.terminalService.endProgramExecution(1, performance.now() - t0);
      return 1;
    } finally {
      isProgramActive = false;
      if (pendingStdinResolver) {
        const resolve = pendingStdinResolver;
        pendingStdinResolver = null;
        resolve(null);
      }
    }
  }

  private pendingStdinBuffer: number[] = [];

  private feedStdin(data: string): void {
    for (let i = 0; i < data.length; i++) {
      this.pendingStdinBuffer.push(data.charCodeAt(i));
    }
  }

  /**
   * High performance, browser WASI runtime that executes the compiled WebAssembly
   * module with stdin/stdout mapped directly to xterm!
   */
  private async runWithBrowserWasi(wasmBytes: Uint8Array): Promise<number> {
    let exitCode = 0;
    const utf8Decoder = new TextDecoder('utf-8');
    const utf8Encoder = new TextEncoder();
    let memory: WebAssembly.Memory | undefined;

    const wasiSnapshotPreview1 = {
      proc_exit: (rval: number) => {
        exitCode = rval;
        throw new Error(`__WASI_EXIT_${rval}__`);
      },
      fd_write: (fd: number, iovs: number, iovsLen: number, nwritten: number) => {
        if (!memory) return 8; // EBADF
        const mem = new DataView(memory.buffer);
        let written = 0;
        let str = '';

        for (let i = 0; i < iovsLen; i++) {
          const ptr = mem.getUint32(iovs + i * 8, true);
          const len = mem.getUint32(iovs + i * 8 + 4, true);
          const buf = new Uint8Array(memory.buffer, ptr, len);
          str += utf8Decoder.decode(buf, { stream: true });
          written += len;
        }

        mem.setUint32(nwritten, written, true);

        if (fd === 1 || fd === 2) {
          this.terminalService.write(str);
        }
        return 0;
      },
      fd_read: (fd: number, iovs: number, iovsLen: number, nread: number) => {
        if (!memory) return 8;
        const mem = new DataView(memory.buffer);
        let totalRead = 0;

        if (fd !== 0) {
          mem.setUint32(nread, 0, true);
          return 8;
        }

        // If stdin buffer is empty in synchronous fallback, prompt user so std::cin does not immediately hit EOF
        if (this.pendingStdinBuffer.length === 0 && typeof window !== 'undefined' && window.prompt) {
          const input = window.prompt('[C++ cin] Program requested input:');
          if (input !== null) {
            this.feedStdin(input + '\n');
            this.terminalService.writeLine(input);
          }
        }

        for (let i = 0; i < iovsLen; i++) {
          const ptr = mem.getUint32(iovs + i * 8, true);
          const len = mem.getUint32(iovs + i * 8 + 4, true);
          const dest = new Uint8Array(memory.buffer, ptr, len);

          let bytesToCopy = Math.min(len, this.pendingStdinBuffer.length);
          for (let b = 0; b < bytesToCopy; b++) {
            dest[b] = this.pendingStdinBuffer.shift()!;
          }
          totalRead += bytesToCopy;
          if (bytesToCopy === 0) break;
        }

        mem.setUint32(nread, totalRead, true);
        return 0;
      },
      fd_close: () => 0,
      fd_seek: () => 8, // EBADF (streams not seekable)
      fd_fdstat_get: (fd: number, stat: number) => {
        if (!memory) return 8;
        const mem = new DataView(memory.buffer);
        mem.setUint8(stat, fd <= 2 ? 2 : 4); // character device vs regular file
        mem.setUint16(stat + 2, 0, true); // fs_flags
        let rights = BigInt(0);
        if (fd === 0) rights = BigInt(0x2); // FD_READ
        else if (fd === 1 || fd === 2) rights = BigInt(0x40); // FD_WRITE
        mem.setBigUint64(stat + 8, rights, true);
        mem.setBigUint64(stat + 16, BigInt(0), true);
        return 0;
      },
      fd_fdstat_set_flags: () => 0,
      fd_prestat_get: () => 8,
      fd_prestat_dir_name: () => 8,
      environ_sizes_get: (environCount: number, environBufSize: number) => {
        if (!memory) return 8;
        const mem = new DataView(memory.buffer);
        mem.setUint32(environCount, 0, true);
        mem.setUint32(environBufSize, 0, true);
        return 0;
      },
      environ_get: () => 0,
      args_sizes_get: (argc: number, argvBufSize: number) => {
        if (!memory) return 8;
        const mem = new DataView(memory.buffer);
        mem.setUint32(argc, 1, true);
        mem.setUint32(argvBufSize, 8, true); // "program\0"
        return 0;
      },
      args_get: (argv: number, argvBuf: number) => {
        if (!memory) return 8;
        const mem = new DataView(memory.buffer);
        mem.setUint32(argv, argvBuf, true);
        const nameBytes = utf8Encoder.encode('program\0');
        new Uint8Array(memory.buffer, argvBuf, nameBytes.length).set(nameBytes);
        return 0;
      },
      clock_time_get: (_id: number, _precision: bigint, timeOut: number) => {
        if (!memory) return 8;
        const mem = new DataView(memory.buffer);
        const nowNs = BigInt(Math.floor(performance.now() * 1_000_000));
        mem.setBigUint64(timeOut, nowNs, true);
        return 0;
      },
      random_get: (buf: number, bufLen: number) => {
        if (!memory) return 8;
        const bytes = new Uint8Array(memory.buffer, buf, bufLen);
        crypto.getRandomValues(bytes);
        return 0;
      },
      poll_oneoff: (inPtr: number, outPtr: number, nsubscriptions: number, neventsPtr: number) => {
        if (!memory) return 8;
        const mem = new DataView(memory.buffer);
        const SUB_SIZE = 48;
        const EVT_SIZE = 32;
        let nevents = 0;
        for (let i = 0; i < nsubscriptions; i++) {
          const subPtr = inPtr + i * SUB_SIZE;
          const evPtr = outPtr + nevents * EVT_SIZE;
          const userdata = mem.getBigUint64(subPtr, true);
          const eventType = mem.getUint8(subPtr + 8);
          mem.setBigUint64(evPtr, userdata, true);
          mem.setUint16(evPtr + 8, 0, true);
          mem.setUint8(evPtr + 10, eventType);
          mem.setBigUint64(evPtr + 16, BigInt(1), true);
          mem.setUint16(evPtr + 24, 0, true);
          nevents++;
        }
        mem.setUint32(neventsPtr, nevents, true);
        return 0;
      },
      sched_yield: () => 0,
      path_open: () => 44, // ENOENT
      path_filestat_get: () => 44,
    };

    try {
      const cleanBuffer = new ArrayBuffer(wasmBytes.byteLength);
      new Uint8Array(cleanBuffer).set(wasmBytes);
      const wasmModule = await WebAssembly.compile(cleanBuffer);

      // Dynamically fulfill imports required by the compiled binary
      const importDescs = WebAssembly.Module.imports(wasmModule);
      const importObject: Record<string, Record<string, any>> = {};

      for (const imp of importDescs) {
        if (!importObject[imp.module]) {
          importObject[imp.module] = {};
        }

        if (imp.module === 'wasi_snapshot_preview1' || imp.module === 'wasi_unstable') {
          importObject[imp.module][imp.name] = (wasiSnapshotPreview1 as any)[imp.name] || (() => 0);
        } else if (imp.kind === 'memory') {
          const mem = new WebAssembly.Memory({ initial: 256, maximum: 16384 });
          importObject[imp.module][imp.name] = mem;
          memory = mem;
        } else if (imp.kind === 'table') {
          importObject[imp.module][imp.name] = new WebAssembly.Table({
            initial: 0,
            element: 'anyfunc',
          });
        } else {
          importObject[imp.module][imp.name] = () => 0;
        }
      }

      const instance = await WebAssembly.instantiate(wasmModule, importObject);

      // If module exported memory, capture it
      if (!memory && (instance.exports.memory as any) instanceof WebAssembly.Memory) {
        memory = instance.exports.memory as WebAssembly.Memory;
      }

      // Call global constructors if present
      const initFn = instance.exports.__wasm_call_ctors as Function;
      if (typeof initFn === 'function') {
        try {
          initFn();
        } catch {
          // constructor init ignore
        }
      }

      // Execute entrypoint
      const start = (instance.exports._start || instance.exports.main) as Function;
      if (typeof start === 'function') {
        const result = start(0, 0);
        if (result && typeof result.then === 'function') {
          await result;
        } else if (typeof result === 'number') {
          exitCode = result;
        }
      }

      // Flush all standard streams and run destructors on program exit
      if (typeof (instance.exports.fflush as any) === 'function') {
        try {
          (instance.exports.fflush as any)(0);
        } catch {
          // ignore
        }
      }
      if (typeof (instance.exports.__wasm_call_dtors as any) === 'function') {
        try {
          (instance.exports.__wasm_call_dtors as any)();
        } catch {
          // ignore
        }
      }

      return exitCode;
    } catch (e: any) {
      if (e.message && e.message.startsWith('__WASI_EXIT_')) {
        return exitCode;
      }
      throw e;
    }
  }
}
