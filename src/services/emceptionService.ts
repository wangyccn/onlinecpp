import { DEFAULT_MANIFEST_URL } from '@gameguild/emception-browser';
import { TerminalService } from './terminalService';
import { FileSystemService } from './fileSystem';
import { CompilerResult } from '../types';
import { abortable } from './abort';
import { localDependencies } from './localPaths';
import { ProcessOutput } from './processOutput';

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
  '-I', '/tmp/onlinecpp-include',
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

// Line buffered like a terminal; do not force an IO syscall for every character.
const ONLINECPP_RUNTIME_HEADER = `#pragma once
#include <stdio.h>
static void __attribute__((constructor(101))) __onlinecpp_stdio(void) {
  setvbuf(stdout, NULL, _IOLBF, 0);
  setvbuf(stderr, NULL, _IONBF, 0);
}
`;

// One precompiled header for the whole session: parsing libc++ costs more than
// codegen for typical contest/assignment programs, and every TU pays it again.
const PCH_SOURCE = '/tmp/onlinecpp-pch.h';
const PCH_HEADER = `#include <bits/stdc++.h>
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
  '--no-entry',
  '--export-if-defined=main',
  '--export-if-defined=__main_argc_argv',
  '--import-undefined',
  '--allow-undefined',
  '--export-table',
  '--table-base=1',
  '--export=__wasm_call_ctors',
  '--export=fflush',
  '--export-if-defined=__funcs_on_exit',
  '--export=malloc',
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

// Precompiled-header frontend: identical to the object frontend except the action.
const PCH_FRONTEND = CC1_FRONTEND.map((arg) => (arg === '-emit-obj' ? '-emit-pch' : arg));

type ToolResponse = { exitCode: number; stdout: string; stderr: string; readFiles?: Record<string, Uint8Array>; probes?: Record<string, 'file' | 'dir' | null>; files?: Record<string, Uint8Array> };
type BuildRecord = { key: string; path: string; digest: string };
type ObjectRecord = { path: string; dependencies: Record<string, string>; probes: Record<string, 'file' | 'dir' | null>; digest: string };
const abortError = () => new DOMException('Task interrupted', 'AbortError');

export class EmceptionService {
  private worker: Worker | null = null;
  private runtime: Worker | null = null;
  private initPromise: Promise<boolean> | null = null;
  private bootAbort: AbortController | null = null;
  private ready = false;
  private requestId = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: any) => void }>();
  private runtimeReject: ((error: any) => void) | null = null;
  private objectCache = new Map<string, ObjectRecord>();
  private lastBuild: BuildRecord | null = null;
  private cacheDirReady = false;
  private pchDisabled = false;
  private pchPath: string | null = null;
  private pchKey = '';
  private pchPending: Promise<string | null> | null = null;
  private pchPendingKey = '';
  private lastModule: { path: string; module: WebAssembly.Module } | null = null;
  private generation = 0;
  private taskAbort: AbortController | null = null;
  private stdout = new TextDecoder();
  private stderr = new TextDecoder();

  constructor(private terminalService: TerminalService, private fileSystem: FileSystemService) {}
  public isCompilerReady(): boolean { return this.ready; }
  public isBusy(): boolean { return this.taskAbort !== null; }
  public resetWorkspace(): void {
    this.stop(); this.lastBuild = null; this.objectCache.clear();
    this.cacheDirReady = false; this.pchPath = null; this.pchKey = ''; this.pchDisabled = false; this.lastModule = null;
  }

  public stop(): void {
    this.taskAbort?.abort(abortError());
    this.bootAbort?.abort(); this.bootAbort = null;
    this.generation++;
    this.worker?.terminate(); this.worker = null;
    this.fileSystem.io.disconnectCompiler();
    this.runtime?.terminate(); this.runtime = null;
    this.ready = false; this.initPromise = null;
    this.cacheDirReady = false; this.pchPath = null; this.pchKey = ''; this.lastModule = null;
    this.pchPending = null; this.pchPendingKey = '';
    for (const request of this.pending.values()) request.reject(abortError());
    this.pending.clear();
    this.runtimeReject?.(abortError()); this.runtimeReject = null;
  }

  private check(signal?: AbortSignal): void { signal?.throwIfAborted(); }
  private rpc<T>(op: string, args: any = {}, transfer: Transferable[] = []): Promise<T> {
    if (!this.worker) return Promise.reject(abortError());
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker!.postMessage({ id, op, ...args }, transfer);
    });
  }

  public async init(): Promise<boolean> {
    if (this.ready) return true;
    // Delay compiler boot until a folder is mounted; never create a persistent virtual workspace.
    if (!this.fileSystem.hasOpenFolder()) return false;
    if (this.initPromise) return this.initPromise;
    const generation = this.generation;
    const bootAbort = this.bootAbort = new AbortController();
    this.initPromise = (async () => {
      try {
        let manifest = DEFAULT_MANIFEST_URL;
        if (['localhost', '127.0.0.1', '0.0.0.0'].includes(location.hostname)) {
          const probe = await fetch('/emception-cdn/manifest.json', { method: 'HEAD', signal: bootAbort.signal });
          if (probe.ok) manifest = new URL('/emception-cdn/manifest.json', location.href).href;
        }
        bootAbort.signal.throwIfAborted();
        const port = await this.fileSystem.io.connect();
        if (generation !== this.generation) { port.close(); throw abortError(); }
        const worker = this.worker = new Worker(new URL('../workers/toolchain.worker.ts', import.meta.url), { type: 'module' });
        worker.onmessage = ({ data }) => {
          if (generation !== this.generation) return;
          if (data.type === 'output') { this.terminalService.write(data.text); return; }
          const request = this.pending.get(data.id);
          if (!request) return;
          this.pending.delete(data.id);
          if (data.error) request.reject(Object.assign(new Error(data.error.message), { name: data.error.name }));
          else request.resolve(data.value);
        };
        worker.onerror = (event) => {
          for (const request of this.pending.values()) request.reject(new Error(event.message));
          this.pending.clear(); this.ready = false; this.initPromise = null;
          worker.terminate(); if (this.worker === worker) this.worker = null;
        };
        await this.rpc('boot', { manifestUrl: manifest, libraries: WASM_LD_CPP_LIBS, port }, [port]);
        await this.rpc('writeSupport', { files: {
          '/tmp/onlinecpp-include/bits/stdc++.h': BITS_STDCPP_HEADER,
          '/tmp/onlinecpp-runtime.h': ONLINECPP_RUNTIME_HEADER,
          [PCH_SOURCE]: PCH_HEADER,
        } });
        if (generation !== this.generation) throw abortError();
        this.ready = true; return true;
      } catch (error: any) {
        if (generation === this.generation) { this.ready = false; this.initPromise = null; }
        if (error.name === 'AbortError') throw error;
        console.error('[Compiler] Initialization failed', error); return false;
      }
    })();
    return this.initPromise;
  }

  private async digest(text: string | Uint8Array): Promise<string> {
    const bytes = await crypto.subtle.digest('SHA-256', (typeof text === 'string' ? new TextEncoder().encode(text) : text) as BufferSource);
    return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  private pchArgs(std: string, opt: string): string {
    return this.cacheKeyArgs(std, opt).flat().join('\u0000');
  }

  private cacheKeyArgs(std: string, opt: string): (string | string[])[] {
    return ['native-cache-v3', DEFAULT_MANIFEST_URL, std, opt, CC1_FRONTEND, CC1_CPP_INCLUDES, CC1_TAIL, CC1_CPP_EXC, ONLINECPP_RUNTIME_HEADER, BITS_STDCPP_HEADER];
  }

  /**
   * Build (once per toolchain/std/opt combination) a precompiled header for the
   * universal <bits/stdc++.h>. Parsing libc++ dominates compile time for small
   * programs, so this turns a multi-second header walk into one deserialisation.
   * Any failure silently falls back to plain header parsing.
   */
  private async ensurePch(std: string, opt: string): Promise<string | null> {
    if (this.pchDisabled) return null;
    const key = await this.digest(this.pchArgs(std, opt) + '\u0000pch-v1');
    if (this.pchKey === key && this.pchPath) return this.pchPath;
    // A warm-up may already be building this exact header; share that work.
    if (this.pchPending && this.pchPendingKey === key) return this.pchPending;
    const rel = `.onlinecpp/cache/pch-${key}.pch`;
    const abs = '/home/user/' + rel;
    const pending = (async (): Promise<string | null> => {
      try {
        if (!this.cacheDirReady) { await this.fileSystem.createDirectory('.onlinecpp/cache'); this.cacheDirReady = true; }
        if (await this.fileSystem.fileExists(rel)) { this.pchKey = key; this.pchPath = abs; return abs; }
        this.terminalService.writeLine('\x1b[90m[Cache] Precompiling <bits/stdc++.h> once — later builds reuse it\x1b[0m');
        const result = await this.rpc<ToolResponse>('run', { tool: 'clang', capture: [abs], argv: [
          'clang', ...PCH_FRONTEND, ...CC1_CPP_INCLUDES, `-std=${std}`, opt, ...CC1_TAIL, ...CC1_CPP_EXC,
          '-o', abs, '-x', 'c++-header', PCH_SOURCE,
        ] });
        if (result.exitCode !== 0) { this.pchDisabled = true; return null; }
        const bytes = result.files?.[abs];
        if (!bytes || bytes.length < 4096) { this.pchDisabled = true; return null; }
        await this.fileSystem.writeBinaryFile(rel, bytes);
        this.pchKey = key; this.pchPath = abs;
        return abs;
      } catch (error: any) {
        if (error.name === 'AbortError') throw error;
        this.pchDisabled = true; return null;
      }
    })();
    this.pchPending = pending; this.pchPendingKey = key;
    try { return await pending; }
    finally { if (this.pchPending === pending) { this.pchPending = null; this.pchPendingKey = ''; } }
  }

  /** Download + boot the toolchain and precompile headers before the first build. */
  public async prepare(standard: string, optimization: string): Promise<boolean> {
    const ready = await this.init();
    if (!ready) return false;
    try { await this.ensurePch(standard, optimization); } catch { /* PCH is optional. */ }
    return true;
  }

  public async compile(mainFile: string, allFiles: Record<string, string>, options: {
    standard?: string; optimization?: string; buildMode?: 'single' | 'project'; outputPath?: string; signal?: AbortSignal;
  } = {}): Promise<CompilerResult> {
    if (this.isBusy()) throw new Error('A compiler or program is already running');
    const controller = this.taskAbort = new AbortController();
    const t0 = performance.now(), signal = controller.signal;
    const wait = <T>(promise: Promise<T>) => abortable(promise, signal);
    const std = options.standard || 'c++20', opt = options.optimization || '-O0';
    const outputPath = options.outputPath || mainFile.replace(/\.[^/.]+$/, '') + '.wasm';
    const main = mainFile.replace(/^\/+/, '');
    const sources = options.buildMode === 'project' ? [main, ...Object.keys(allFiles).filter((path) => path !== main && /\.(c|cc|cpp|cxx)$/i.test(path))].sort() : [main];
    const onAbort = () => this.stop();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) controller.abort(abortError());
    let stdout = '', stderr = '';
    this.terminalService.writeLine(`\r\n\x1b[33m[Compiler] ${main} (${std}, ${opt}) — Ctrl+C to interrupt\x1b[0m`);
    try {
      this.check(signal);
      if (!await wait(this.init())) throw new Error('Compiler could not initialize. Check cross-origin isolation and toolchain downloads.');
      this.check(signal);
      if (!this.cacheDirReady) { await wait(this.fileSystem.createDirectory('.onlinecpp/cache')); this.cacheDirReady = true; }
      const commonKey = await wait(this.digest(JSON.stringify(this.cacheKeyArgs(std, opt))));
      // Resolve the PCH before touching the toolchain so a warm-up in flight finishes
      // first instead of racing this build inside the same worker.
      let pch = sources.some((source) => !source.endsWith('.c')) ? await wait(this.ensurePch(std, opt)) : null;
      this.check(signal);
      await wait(this.rpc('setInputs', { files: allFiles }));
      const paths: string[] = [], keys: string[] = [];
      const digests = new Map<string, Promise<string>>();
      const dependencyDigest = (path: string): Promise<string> => {
        if (!digests.has(path)) digests.set(path, (async () => this.digest(allFiles[path] ?? await wait(this.fileSystem.readBinaryFile(path))))());
        return wait(digests.get(path)!);
      };
      for (const source of sources) {
        this.check(signal);
        const key = await wait(this.digest(commonKey + source + await dependencyDigest(source)));
        const object = `.onlinecpp/cache/${key}.o`; paths.push('/home/user/' + object);
        let previous = this.objectCache.get(key);
        if (!previous) {
          try {
            const metadata = JSON.parse(await wait(this.fileSystem.readFile(object + '.json')));
            if (metadata.key === key && metadata.dependencies && metadata.probes && typeof metadata.digest === 'string' && Object.values(metadata.dependencies).every((value) => typeof value === 'string')) {
              previous = { path: object, dependencies: metadata.dependencies, probes: metadata.probes, digest: metadata.digest }; this.objectCache.set(key, previous);
            }
          } catch (error: any) { if (error.name === 'AbortError') throw error; /* Missing/corrupt metadata is a cache miss. */ }
        }
        let valid = !!previous && await wait(this.fileSystem.fileExists(object));
        if (valid) {
          const probes = Object.keys(previous!.probes).filter((path) => !(path in previous!.dependencies));
          const current = await wait(this.fileSystem.io.request<Record<string, string | null>>('statMany', '', probes));
          valid = probes.every((path) => current[path] === previous!.probes[path]);
        }
        if (valid) {
          for (const [path, digest] of Object.entries(previous!.dependencies)) {
            try { if (await dependencyDigest(path) !== digest) { valid = false; break; } }
            catch (error: any) { if (error.name === 'AbortError') throw error; valid = false; break; }
          }
        }
        if (valid) {
          keys.push(previous!.digest);
          this.terminalService.writeLine(`\x1b[90m[Cache] ${source} unchanged; skipping clang\x1b[0m`); continue;
        }
        // Unique process output avoids stale Emscripten mapping tails. Publish only successful objects.
        const scratch = `.onlinecpp/cache/${crypto.randomUUID()}`;
        const cpp = !source.endsWith('.c');
        const objectFile = `/home/user/${scratch}.o`, depFile = `/home/user/${scratch}.d`;
        const clangArgv = (precompiled: string | null) => [
          'clang', ...CC1_FRONTEND, ...CC1_CPP_INCLUDES,
          cpp ? `-std=${std}` : '-std=c17', opt, ...CC1_TAIL,
          ...(cpp ? CC1_CPP_EXC : []),
          ...(precompiled ? ['-include-pch', precompiled] : []), '-include', '/tmp/onlinecpp-runtime.h',
          '-dependency-file', depFile, '-MT', 'object',
          '-o', objectFile, '-x', cpp ? 'c++' : 'c', `/home/user/${source}`,
        ];
        const runClang = (precompiled: string | null) => wait(this.rpc<ToolResponse>('run', { tool: 'clang', capture: [objectFile, depFile], argv: clangArgv(precompiled) }));
        let result = await runClang(pch);
        if (result.exitCode !== 0 && cpp && pch) {
          // An unusual translation unit can reject the PCH (macro state before the first
          // include). Retry once without it and stop using PCH for the rest of the session.
          pch = null; this.pchDisabled = true;
          this.terminalService.writeLine('\x1b[90m[Cache] Precompiled header rejected; falling back to header parsing\x1b[0m');
          result = await runClang(null);
        }
        stdout += result.stdout || ''; stderr += result.stderr || '';
        this.check(signal);
        if (result.exitCode !== 0) return { ...result, stdout, stderr, durationMs: performance.now() - t0 };
        const dependencies: Record<string, string> = {};
        const depfile = result.files?.[depFile]
          ? new TextDecoder().decode(result.files[depFile])
          : await wait(this.fileSystem.readFile(scratch + '.d'));
        for (const path of localDependencies(depfile)) {
          if (path.startsWith('.onlinecpp/')) continue;
          dependencies[path] = result.readFiles?.[path] ? await wait(this.digest(result.readFiles[path])) : await dependencyDigest(path);
        }
        const objectBytes = result.files?.[objectFile] ?? await wait(this.fileSystem.readBinaryFile(scratch + '.o'));
        const digest = await wait(this.digest(objectBytes)), probes = result.probes || {};
        await wait(Promise.all([
          this.fileSystem.writeBinaryFile(object, objectBytes),
          this.fileSystem.writeFile(object + '.json', JSON.stringify({ key, dependencies, probes, digest })),
        ]));
        this.objectCache.set(key, { path: object, dependencies, probes, digest });
        keys.push(digest);
      }
      this.check(signal);
      const linkKey = await wait(this.digest(JSON.stringify([keys, WASM_LD_BASE, WASM_LD_CPP_LIBS])));
      const linkMetadata = `.onlinecpp/cache/link-${linkKey}.json`;
      if (this.lastBuild?.key !== linkKey) {
        try {
          const saved = JSON.parse(await wait(this.fileSystem.readFile(linkMetadata)));
          if (saved.key === linkKey && typeof saved.path === 'string' && typeof saved.digest === 'string') this.lastBuild = saved;
        } catch (error: any) { if (error.name === 'AbortError') throw error; }
      }
      if (this.lastBuild?.key === linkKey && await wait(this.fileSystem.fileExists(this.lastBuild.path))) {
        const wasmBytes = await wait(this.fileSystem.readBinaryFile(this.lastBuild.path));
        if (await wait(this.digest(wasmBytes)) === this.lastBuild.digest) {
          if (this.lastBuild.path !== outputPath) {
            await wait(this.fileSystem.writeBinaryFile(outputPath, wasmBytes));
            this.lastBuild = { ...this.lastBuild, path: outputPath };
            await wait(this.fileSystem.writeFile(linkMetadata, JSON.stringify(this.lastBuild)));
          }
          this.terminalService.writeLine('\x1b[32m[Cache] Build unchanged; skipping linker\x1b[0m');
          return { exitCode: 0, stdout, stderr, outputPath, wasmBytes, durationMs: performance.now() - t0 };
        }
      }
      const scratch = `.onlinecpp/cache/${crypto.randomUUID()}.wasm`;
      const linkOut = '/home/user/' + scratch;
      const result = await wait(this.rpc<ToolResponse>('run', { tool: 'wasm-ld', capture: [linkOut], argv: ['wasm-ld', ...paths, '-o', linkOut, ...WASM_LD_BASE, ...WASM_LD_CPP_LIBS] }));
      stdout += result.stdout || ''; stderr += result.stderr || ''; this.check(signal);
      if (result.exitCode !== 0) return { ...result, stdout, stderr, durationMs: performance.now() - t0 };
      const wasmBytes = result.files?.[linkOut] ?? await wait(this.fileSystem.readBinaryFile(scratch));
      if (!wasmBytes?.length) throw new Error('Linker produced no output');
      // Compiling once here also proves the module is valid, and the runtime worker
      // reuses this exact module instead of compiling the bytes a second time.
      const module = await wait(WebAssembly.compile(wasmBytes as BufferSource));
      const exports = WebAssembly.Module.exports(module);
      if (!exports.some((item) => ['main', '__main_argc_argv', '_start'].includes(item.name))) throw new Error('Program entry point missing: define main()');
      await wait(this.fileSystem.writeBinaryFile(outputPath, wasmBytes)); this.check(signal);
      this.lastBuild = { key: linkKey, path: outputPath, digest: await wait(this.digest(wasmBytes)) };
      this.lastModule = { path: outputPath, module };
      await wait(this.fileSystem.writeFile(linkMetadata, JSON.stringify(this.lastBuild)));
      const durationMs = performance.now() - t0;
      this.terminalService.writeLine(`\x1b[32m[Compiler] Build successful in ${durationMs.toFixed(1)}ms → ${outputPath} (IndexedDB committed${this.fileSystem.getStorageMode() === 'disk' ? ', disk sync queued' : ', browser storage only'})\x1b[0m`);
      return { exitCode: 0, stdout, stderr, outputPath, wasmBytes, wasmModule: module, durationMs };
    } catch (error: any) {
      const cancelled = signal?.aborted || error.name === 'AbortError';
      const message = cancelled ? 'Build interrupted' : error.message || String(error);
      this.terminalService.writeLine(`\x1b[${cancelled ? 33 : 31}m[Compiler] ${message}\x1b[0m`);
      return { exitCode: cancelled ? 130 : 1, stdout, stderr: message, durationMs: performance.now() - t0 };
    } finally { options.signal?.removeEventListener('abort', onAbort); this.taskAbort = null; }
  }

  public async runWasmBinary(name = 'program.wasm', bytes?: Uint8Array, options: { signal?: AbortSignal; cwd?: string; args?: string[]; module?: WebAssembly.Module } = {}): Promise<number> {
    if (this.isBusy()) throw new Error('A compiler or program is already running');
    const controller = this.taskAbort = new AbortController();
    const t0 = performance.now();
    const signal = controller.signal;
    const onAbort = () => controller.abort(abortError());
    const wait = <T>(promise: Promise<T>) => abortable(promise, signal);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    const release = this.terminalService.beginTask(onAbort);
    let control: Int32Array | undefined;
    let code = 1, line = '', eof = false;
    const queued: number[] = []; let queueHead = 0;
    let pumpTimer: ReturnType<typeof setTimeout> | undefined;
    let outputTimer: ReturnType<typeof setInterval> | undefined;
    let drainOutput = () => {};
    try {
      this.check(signal);
      // Reuse an already-compiled module when the caller does not supply one, so a
      // repeated "Run" on an unchanged build skips WebAssembly compilation entirely.
      const module = options.module ?? (bytes ? undefined : (this.lastModule?.path === name ? this.lastModule.module : undefined));
      if (!module) bytes ||= await wait(this.fileSystem.readBinaryFile(name));
      await wait(this.fileSystem.io.finishRuntime());
      const port = await wait(this.fileSystem.io.connect('runtime')); this.check(signal);
      control = new Int32Array(new SharedArrayBuffer(12));
      const data = new Uint8Array(new SharedArrayBuffer(65536));
      const pump = () => {
        while (queueHead < queued.length) {
          const write = Atomics.load(control!, 1), next = (write + 1) % data.length;
          if (next === Atomics.load(control!, 0)) break;
          data[write] = queued[queueHead++]; Atomics.store(control!, 1, next);
        }
        Atomics.notify(control!, 1);
        if (queueHead < queued.length) pumpTimer = setTimeout(pump, 4);
        else { queued.length = 0; queueHead = 0; if (eof) { Atomics.store(control!, 2, 1); Atomics.notify(control!, 1); } }
      };
      const feed = (text: string) => { for (const byte of new TextEncoder().encode(text)) queued.push(byte); clearTimeout(pumpTimer); pump(); };
      this.terminalService.startProgramExecution(name, (input) => {
        const normalized = input.replace(/\x1b\[20[01]~/g, '').replace(/\r\n|\r/g, '\n');
        for (const char of normalized) {
          if (char === '\x03') { onAbort(); return; }
          if (char === '\x04') { if (line) { feed(line); line = ''; } else { eof = true; pump(); } return; }
          if (char === '\n') { feed(line + '\n'); line = ''; }
          else if (char === '\x7f' || char === '\b') line = line.slice(0, -1);
          else if (char >= ' ' || char === '\t') line += char;
        }
        if (normalized.includes('\n') && line) { feed(line + '\n'); line = ''; }
      }, onAbort);
      const runtime = this.runtime = new Worker(new URL('../workers/runtime.worker.ts', import.meta.url), { type: 'module' });
      const output = new ProcessOutput();
      this.stdout = new TextDecoder(); this.stderr = new TextDecoder();
      drainOutput = () => {
        const { chunks, end } = output.read();
        if (!chunks.length) return;
        const text = chunks.map((chunk) => (chunk.stream === 2 ? this.stderr : this.stdout).decode(chunk.bytes, { stream: true })).join('');
        this.terminalService.write(text, () => output.acknowledge(end));
      };
      outputTimer = setInterval(drainOutput, 8);
      code = await wait(new Promise<number>((resolve, reject) => {
        this.runtimeReject = reject;
        runtime.onerror = (event) => reject(new Error(event.message));
        runtime.onmessage = ({ data }) => {
          if (data.type === 'exit') resolve(data.code);
          else if (data.type === 'error') reject(new Error(data.message));
        };
        runtime.postMessage({ bytes, module, port, stdinControl: control!.buffer, stdinData: data.buffer, output: output.shared, cwd: options.cwd || '', args: options.args || [], program: name }, [port]);
      }));
    } catch (error: any) {
      code = signal?.aborted || error.name === 'AbortError' ? 130 : 1;
      if (code !== 130) this.terminalService.writeLine(`\x1b[31mRuntime error: ${error.message || error}\x1b[0m`);
    } finally {
      this.runtime?.terminate(); this.runtime = null; this.runtimeReject = null;
      clearInterval(outputTimer); drainOutput();
      const finalText = this.stdout.decode() + this.stderr.decode();
      if (finalText) this.terminalService.write(finalText);
      clearTimeout(pumpTimer); if (control) { Atomics.store(control, 2, 1); Atomics.notify(control, 1); }
      options.signal?.removeEventListener('abort', onAbort);
      try { await this.fileSystem.io.finishRuntime(); }
      catch (error: any) { code = 1; this.terminalService.writeLine(`\x1b[31mFile commit failed: ${error.message} — keep this page open and retry saving.\x1b[0m`); }
      this.taskAbort = null;
      this.terminalService.endProgramExecution(code, performance.now() - t0); release();
    }
    return code;
  }
}
