import { FileSystemService } from '../src/services/fileSystem';
import { EmceptionService } from '../src/services/emceptionService';
import { MonacoEditorService } from '../src/services/monacoEditor';
import { TerminalService } from '../src/services/terminalService';
import { WriteQueue } from '../src/services/writeQueue';
import { ClangdService } from '../src/services/clangdService';
import { BufferedFileSystem, IndexedIOJournal, type DiskBackend } from '../src/services/bufferedFileSystem';

const results = document.querySelector('#results')!;
const log = (message: string) => results.textContent += message + '\n';
const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (condition: () => boolean, timeout = 10000) => {
  const deadline = performance.now() + timeout;
  while (!condition()) { if (performance.now() > deadline) throw new Error('Timed out waiting for test condition'); await sleep(10); }
};
const settings: any = { fontSize: 14, tabSize: 4, minimap: false, wordWrap: 'off', autoSave: true };
const group = new URLSearchParams(location.search).get('group') || 'all';

document.querySelector('#start')!.addEventListener('click', async () => {
  (document.querySelector('#start') as HTMLButtonElement).disabled = true;
  let compiler: EmceptionService | undefined;
  try {
    assert(crossOriginIsolated, 'COOP/COEP missing');
    const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle('onlinecpp-regression-' + Date.now(), { create: true });
    const fs = new FileSystemService(); await fs.mountDirectory(folder);
    const bufferedJournal = await IndexedIOJournal.open(null, 'io-test-' + crypto.randomUUID());
    const external = new Map<string, Uint8Array>(); let externalWrites = 0;
    const backend: DiskBackend = {
      stat: async (path) => !path ? { kind: 'directory', size: 0, lastModified: 0 } : external.has(path) ? { kind: 'file', size: external.get(path)!.length, lastModified: 1 } : null,
      list: async () => [...external.keys()].map((name) => ({ name, kind: 'file' })),
      read: async (path) => external.get(path)!.slice(),
      write: async (path, bytes) => { await sleep(80); externalWrites++; external.set(path, bytes); },
      mkdir: async () => {}, remove: async (path) => { external.delete(path); },
    };
    const buffered = new BufferedFileSystem(bufferedJournal, backend, () => {}, 1000); await buffered.init();
    const cacheStart = performance.now();
    await buffered.write('output.txt', 'old'); await buffered.write('output.txt', 'latest');
    await buffered.write('scratch.o', 'temporary'); await buffered.remove('scratch.o');
    assert(externalWrites === 0 && (await bufferedJournal.load()).length === 1, 'Writes were not staged durably before disk');
    assert(new TextDecoder().decode(await buffered.read('output.txt')) === 'latest', 'Pending IDB read did not return latest version');
    log('PASS real IndexedDB: read-your-writes / 2 versions + scratch coalesced before external IO (' + (performance.now() - cacheStart).toFixed(0) + 'ms)');
    await buffered.flushDisk(); assert(externalWrites === 1 && !(await bufferedJournal.load()).length, 'Disk cleanup/coalescing failed'); bufferedJournal.close();
    const browserKey = 'browser-test-' + crypto.randomUUID(), browserJournal = await IndexedIOJournal.open(null, browserKey);
    const browserFS = new BufferedFileSystem(browserJournal, null); await browserFS.init(); await browserFS.write('src/main.cpp', 'browser only');
    await browserFS.flushDisk(); browserJournal.close();
    const reopenedJournal = await IndexedIOJournal.open(null, browserKey), reopened = new BufferedFileSystem(reopenedJournal, null); await reopened.init();
    assert(new TextDecoder().decode(await reopened.read('src/main.cpp')) === 'browser only', 'Browser-only IDB reopen lost files');
    await reopened.remove('src'); reopenedJournal.close(); log('PASS real IndexedDB: browser-only persistence / reopen / delete without disk');
    let count = 0; const queue = new WriteQueue<string>(async () => { count++; await sleep(20); });
    const burst = Array.from({ length: 200 }, (_, i) => queue.enqueue('burst.cpp', String(i), 30));
    await queue.flush(); await Promise.all(burst); assert(count === 1, '200 edits should coalesce into one IO');
    log('PASS queue: 200 edits -> 1 write');

    const editor = new MonacoEditorService(); editor.mount(document.querySelector('#editor') as HTMLElement, settings);
    editor.setOnSave(async (path, text) => { await sleep(120); await fs.writeFile(path, text); });
    editor.openFile('a.cpp', 'initial'); editor.getActiveModel()!.setValue('first');
    const saving = editor.saveActiveFile(); await sleep(20); editor.getActiveModel()!.setValue('latest');
    await saving; assert(editor.getOpenTabs()[0].isDirty, 'Stale save marked a newer revision clean');
    editor.openFile('b.cpp', 'b'); editor.getActiveModel()!.setValue('other');
    await editor.saveAllFiles();
    assert(await fs.readFile('a.cpp') === 'latest', 'Tab switch lost a.cpp');
    assert(await fs.readFile('b.cpp') === 'other', 'Tab switch lost b.cpp');
    assert(!editor.hasUnsavedChanges(), 'All saved tabs should be clean');
    editor.setOnSave(async () => { throw new Error('disk full'); });
    editor.getActiveModel()!.setValue('unsaved');
    await editor.saveActiveFile().catch(() => {});
    assert(editor.getOpenTabs().find((tab) => tab.path === 'b.cpp')!.isDirty, 'Failed save marked clean');
    editor.setOnSave(async (path, text) => fs.writeFile(path, text)); await editor.saveAllFiles(); editor.dispose();
    log('PASS editor: slow write / newer edit / tab switch / disk error');

    const terminal = new TerminalService(); terminal.mount(document.querySelector('#terminal') as HTMLElement);
    const messages: string[] = [];
    const write = terminal.write.bind(terminal), writeLine = terminal.writeLine.bind(terminal);
    terminal.write = (text, consumed) => { messages.push(text); write(text, consumed); };
    terminal.writeLine = (text) => { messages.push(text); writeLine(text); };
    const xterm = terminal.getTerminal();
    const prompts = async () => {
      await new Promise<void>((resolve) => xterm.write('', resolve));
      let count = 0;
      for (let i = 0; i < xterm.buffer.active.length; i++) if (xterm.buffer.active.getLine(i)?.translateToString().includes('onlinecpp:/workspace$')) count++;
      return count;
    };
    let dispatched = 0, interrupted = false;
    terminal.setCommandLineHandler(async () => { dispatched++; await sleep(10); });
    const before = await prompts();
    const release = terminal.beginTask(() => { interrupted = true; });
    xterm.input('echo must-not-run\r', true); assert(dispatched === 0, 'Shell accepted input during foreground build');
    xterm.input('\x03', true); assert(interrupted, 'Ctrl+C did not reach foreground task');
    release(); assert(await prompts() === before + 1, 'Foreground completion duplicated the prompt');
    xterm.input('echo ready\r', true); await sleep(30); assert(dispatched === 1, 'Shell did not resume');
    log('PASS terminal: foreground ownership / Ctrl+C / single prompt / shell resumes');

    await fs.writeFile('open.txt', 'old'); await fs.io.request('open', 'open.txt', { flags: 2 });
    await fs.io.request('writeAt', 'open.txt', { position: 0, bytes: new TextEncoder().encode('new') });
    let conflicted = false; try { await fs.writeFile('open.txt', 'editor'); } catch { conflicted = true; }
    assert(conflicted, 'Editor silently overwrote a program-owned file');
    await fs.io.request('close', 'open.txt'); assert(await fs.readFile('open.txt') === 'new', 'Runtime close did not commit');
    await fs.writeFile('open.txt', 'editor');
    let escaped = false; try { await fs.io.request('write', '../escape.txt', 'bad'); } catch { escaped = true; }
    assert(escaped, 'Native IO escaped selected folder');
    log('PASS native IO: same-file conflict protection / commit / path sandbox');
    await fs.writeBinaryFile('move-source/.hidden/bytes.bin', new Uint8Array([0, 255, 7]));
    await fs.move('move-source', 'move-dest');
    assert((await fs.readBinaryFile('move-dest/.hidden/bytes.bin')).join(',') === '0,255,7', 'Directory move lost hidden/binary data');
    let unsafeMove = false; try { await fs.move('move-dest', './move-dest'); } catch { unsafeMove = true; }
    assert(unsafeMove && await fs.directoryExists('move-dest'), 'Moving onto itself deleted the source');
    let recursiveCopy = false; try { await fs.copyDirectory('move-dest', 'move-dest/child'); } catch { recursiveCopy = true; }
    assert(recursiveCopy, 'Copying a directory into itself was not rejected');
    log('PASS native IO: hidden binary directory move / canonical same-path safety / recursive copy safety');

    compiler = new EmceptionService(terminal, fs);
    if (group === 'all' || group === 'compiler') {
    const source = '#include <iostream>\n#include <fstream>\n#include <cstdio>\nint main(){std::ifstream in("input.txt"); int x=0; in>>x; std::ofstream out("result.txt"); out<<x+7; out.close(); FILE *f=fopen("binary.dat","wb"); unsigned char b[]={0,255,42}; fwrite(b,1,3,f); fclose(f); std::cout<<"ANSWER="<<x+7<<"\\n"; return x==35?0:9;}';
    await fs.writeFile('main.cpp', source); await fs.writeFile('input.txt', '35');
    log('Running real clang + wasm-ld (cold toolchain may download assets)...');
    const build = await compiler.compile('main.cpp', { 'main.cpp': source }, { outputPath: 'main.wasm', optimization: '-O0' });
    assert(build.exitCode === 0, 'Compilation failed: ' + build.stderr);
    assert(await fs.fileExists('main.wasm'), 'WASM missing from mounted folder');
    log('PASS cold build: ' + build.durationMs.toFixed(0) + 'ms');
    log('Imports: ' + WebAssembly.Module.imports(await WebAssembly.compile(build.wasmBytes! as BufferSource)).map((item) => item.module + '.' + item.name).join(', '));
    const warm = await compiler.compile('main.cpp', { 'main.cpp': source }, { outputPath: 'main.wasm', optimization: '-O0' });
    assert(warm.exitCode === 0, 'Warm compilation failed: ' + warm.stderr);
    log('PASS unchanged build: ' + warm.durationMs.toFixed(0) + 'ms');
    const code = await compiler.runWasmBinary('main.wasm');
    assert(code === 0, 'Runtime failed, code ' + code);
    assert(await fs.readFile('result.txt') === '42', 'fstream read/write failed');
    assert((await fs.readBinaryFile('binary.dat')).join(',') === '0,255,42', 'Binary fopen/fwrite failed');
    log('PASS runtime: local input -> ifstream -> ofstream + binary fwrite');

    const project = 'project with spaces/';
    const pmain = project + 'main.cpp', helper = project + 'helper.cpp', header = project + 'value.hpp', custom = project + 'value.def';
    const mainSource = 'int answer(); int main(){return answer()==42?0:9;}';
    const helperSource = '#include "value.hpp"\n#include "value.def"\nint answer(){return VALUE+EXTRA;}';
    await fs.writeFile(pmain, mainSource); await fs.writeFile(helper, helperSource); await fs.writeFile(header, '#define VALUE 40\n');
    await fs.writeFile(custom, '#define EXTRA 2\n'); await fs.writeFile(project + 'unused.hpp', '// unused v1\n');
    const projectFiles = async () => Object.fromEntries(Object.entries(await fs.getAllFilesContent(pmain, 'project')).filter(([path]) => path.startsWith(project)));
    let files = await projectFiles(); assert(files[pmain] === mainSource && !('input.txt' in files), 'Source snapshot incorrect');
    const projectBuild = () => compiler!.compile(pmain, files, { buildMode: 'project' });
    let result = await projectBuild(); assert(result.exitCode === 0, result.stderr);
    assert(await compiler.runWasmBinary(result.outputPath) === 0, 'Multi-source link incorrect');
    const mark = messages.length;
    await fs.writeFile(project + 'unused.hpp', '// unused v2\n'); files = await projectFiles();
    result = await projectBuild(); assert(result.exitCode === 0, result.stderr);
    assert(messages.slice(mark).filter((text) => text.includes('skipping clang')).length === 2, 'Unused header forced a rebuild');
    assert(messages.slice(mark).some((text) => text.includes('skipping linker')), 'Unchanged dependencies relinked');
    await fs.writeFile(header, '#define VALUE 41\n'); files = await projectFiles();
    const dependencyMark = messages.length; result = await projectBuild(); assert(result.exitCode === 0, result.stderr);
    assert(messages.slice(dependencyMark).filter((text) => text.includes('skipping clang')).length === 1, 'Dependency invalidation did not preserve the unrelated object');
    assert(!messages.slice(dependencyMark).some((text) => text.includes('skipping linker')), 'Changed object reused stale linker result');
    assert(await compiler.runWasmBinary(result.outputPath) === 9, 'Header change produced a stale binary');
    await fs.writeFile(custom, '#define EXTRA 1\n');
    result = await projectBuild(); assert(result.exitCode === 0, result.stderr);
    assert(await compiler.runWasmBinary(result.outputPath) === 0, 'Nonstandard include dependency was not invalidated');
    await fs.deleteFile(custom); result = await projectBuild();
    assert(result.exitCode !== 0 && !result.wasmBytes, 'Missing header executed/reused an old result');
    await fs.writeFile(custom, '#define EXTRA 1\n');
    result = await projectBuild(); assert(result.exitCode === 0, result.stderr);
    compiler.resetWorkspace(); const persistentMark = messages.length;
    result = await projectBuild(); assert(result.exitCode === 0, result.stderr);
    assert(messages.slice(persistentMark).filter((text) => text.includes('skipping clang')).length === 2, 'Disk object cache did not survive compiler restart');
    assert(messages.slice(persistentMark).some((text) => text.includes('skipping linker')), 'Disk linker metadata did not survive restart');
    log('PASS project cache: multiple sources / unused header / dependent header / custom include / deleted header / restart / spaces');

    const optionalSource = '#if __has_include("optional.def")\n#define RESULT 7\n#else\n#define RESULT 0\n#endif\nint main(){return RESULT;}';
    await fs.writeFile('optional.cpp', optionalSource);
    const optionalBuild = () => compiler!.compile('optional.cpp', { 'optional.cpp': optionalSource });
    let optional = await optionalBuild(); assert(optional.exitCode === 0, optional.stderr);
    assert(await compiler.runWasmBinary(optional.outputPath) === 0, 'Absent optional include incorrect');
    await fs.writeFile('optional.def', '// probe only, not included');
    optional = await optionalBuild(); assert(optional.exitCode === 0, optional.stderr);
    assert(await compiler.runWasmBinary(optional.outputPath) === 7, '__has_include addition reused a stale object/link');
    await fs.deleteFile('optional.def');
    optional = await optionalBuild(); assert(optional.exitCode === 0, optional.stderr);
    assert(await compiler.runWasmBinary(optional.outputPath) === 0, '__has_include removal reused a stale object/link');
    log('PASS cache: custom-extension __has_include additions and removals');
    }

    if (group === 'all' || group === 'runtime') {
    const cSource = `#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/stat.h>
#include <fcntl.h>
static void done(void){FILE*f=fopen("at-exit.txt","w");fputs("done",f);fclose(f);}
int main(int argc,char**argv){
 if(argc!=3||strcmp(argv[1],"hello world")||strcmp(argv[2],"42"))return 10;
 atexit(done);
 FILE*f=fopen("seek.bin","w+b");if(!f)return 11;
 fwrite("abc",1,3,f);fseek(f,-2,SEEK_END);fwrite("XY",1,2,f);rewind(f);if(fgetc(f)!='a')return 12;fclose(f);
 f=fopen("seek.bin","ab");fseek(f,0,SEEK_SET);fputc('!',f);fclose(f);
 int fd=open("seek.bin",O_WRONLY);if(fd<0||ftruncate(fd,2)||lseek(fd,4,SEEK_SET)!=4||write(fd,"Z",1)!=1)return 13;close(fd);
 if(mkdir("filled",0755))return 14;f=fopen("filled/keep.txt","w");fputs("keep",f);fclose(f);
 if(rmdir("filled")==0||mkdir("missing/child",0755)==0)return 15;
 if(fopen("../../escape.txt","w"))return 16;
 if(remove("filled/keep.txt")||rmdir("filled"))return 17;
 return 0;
}`;
    await fs.createDirectory('data area'); await fs.writeFile('native.c', cSource);
    log('Running C runtime/ABI regression...');
    const cController = new AbortController(), timeout = setTimeout(() => cController.abort(), 30000);
    const cBuild = await compiler.compile('native.c', { 'native.c': cSource }, { signal: cController.signal });
    clearTimeout(timeout); assert(cBuild.exitCode === 0, cBuild.stderr);
    const cModule = await WebAssembly.compile(cBuild.wasmBytes! as BufferSource);
    log('C imports: ' + WebAssembly.Module.imports(cModule).map((item) => item.module + '.' + item.name).join(', '));
    log('C exports: ' + WebAssembly.Module.exports(cModule).map((item) => item.name).join(', '));
    const cExit = await compiler.runWasmBinary(cBuild.outputPath, undefined, { cwd: 'data area', args: ['hello world', '42'] });
    assert(cExit === 0, 'C/POSIX runtime failed: ' + cExit);
    log('C runtime files: ' + (await fs.listFiles('data area')).map((file) => file.name).join(', '));
    assert((await fs.readBinaryFile('data area/seek.bin')).join(',') === '97,88,0,0,90', 'seek/append/truncate/hole failed');
    assert(await fs.readFile('data area/at-exit.txt') === 'done', 'atexit handlers were skipped');
    assert(!await fs.directoryExists('data area/filled'), 'rmdir left a stale cached directory');
    log('PASS C runtime: argc/argv / cwd / seek / append / truncate / holes / atexit / safe mkdir+remove');

    const stdinSource = '#include <stdio.h>\nint main(){int c,n=0;while((c=getchar())!=EOF)n++;FILE*f=fopen("stdin-count.txt","w");fprintf(f,"%d",n);fclose(f);return 0;}';
    await fs.writeFile('stdin.c', stdinSource);
    const inputBuild = await compiler.compile('stdin.c', { 'stdin.c': stdinSource }); assert(inputBuild.exitCode === 0, inputBuild.stderr);
    const inputRun = compiler.runWasmBinary(inputBuild.outputPath);
    await until(() => (terminal as any).isRunningProgram);
    xterm.input('a'.repeat(70000) + '\r', true); xterm.input('\x04', true);
    assert(await inputRun === 0, 'stdin/EOF failed');
    assert(await fs.readFile('stdin-count.txt') === '70001', 'stdin ring truncated a large paste');
    log('PASS stdin: 70KB paste crosses the shared ring and EOF exits cleanly');

    const floodSource = '#include <stdio.h>\nint main(){while(1)puts("continuous-output");}';
    await fs.writeFile('flood.c', floodSource);
    const floodBuild = await compiler.compile('flood.c', { 'flood.c': floodSource }); assert(floodBuild.exitCode === 0, floodBuild.stderr);
    const floodAbort = new AbortController(); let beats = 0;
    const heartbeat = setInterval(() => beats++, 10);
    const flooding = compiler.runWasmBinary(floodBuild.outputPath, undefined, { signal: floodAbort.signal });
    await sleep(400); const floodStop = performance.now(); floodAbort.abort();
    assert(await flooding === 130 && beats > 2, 'Flooding output blocked UI/cancellation'); clearInterval(heartbeat);
    assert(performance.now() - floodStop < 1000, 'Output queue delayed SIGINT');
    log('PASS output: bounded backpressure keeps UI responsive and SIGINT immediate');
    }

    if (group === 'all' || group === 'compiler' || group === 'runtime') {
    const infinite = '#include <cstdio>\nint main(){ FILE*f=fopen("interrupted.txt","w"); fputs("preserved",f); fflush(f); puts("FIRST-OUTPUT"); puts("VISIBLE-BEFORE-LOOP"); volatile int x=0; while(1){x++;} }';
    await fs.writeFile('loop.cpp', infinite);
    const loop = await compiler.compile('loop.cpp', { 'loop.cpp': infinite }, { outputPath: 'loop.wasm' });
    assert(loop.exitCode === 0, loop.stderr);
    const controller = new AbortController();
    const execution = compiler.runWasmBinary('loop.wasm', undefined, { signal: controller.signal });
    await sleep(500);
    assert(messages.some((text) => text.includes('VISIBLE-BEFORE-LOOP')), 'Trailing stdout waited for a non-yielding program to exit');
    const stop = performance.now(); controller.abort();
    assert(await execution === 130, 'Infinite loop did not interrupt');
    assert(await fs.readFile('interrupted.txt') === 'preserved', 'Completed write lost after interrupt');
    log('PASS infinite-loop SIGINT: ' + (performance.now() - stop).toFixed(0) + 'ms; file preserved');

    const cancel = new AbortController();
    const toolMark = messages.length;
    const cancelled = compiler.compile('cancel.cpp', { 'cancel.cpp': '#include <bits/stdc++.h>\nint main(){return 0;}' }, { signal: cancel.signal });
    await until(() => messages.slice(toolMark).some((text) => text.includes('[Toolchain] clang')));
    const cancelTime = performance.now(); cancel.abort();
    assert((await cancelled).exitCode === 130, 'Compiler did not interrupt');
    log('PASS compiler SIGINT: ' + (performance.now() - cancelTime).toFixed(0) + 'ms');
    compiler.stop();
    }

    if (group === 'all' || group === 'clangd') {
    const clangd = new ClangdService();
    if (clangd.getStatusText().isLsp) {
      const code = 'int square(int x) { return x*x; }\nint main() { return square(2); }';
      await clangd.attachDocument('clangd-a.cpp', code);
      const sessions = (clangd as any).sessions; const original = sessions.get('file:///clangd-a.cpp');
      assert(original, 'Real clangd session failed to initialize');
      const hover: any = await clangd.sendLspRequest('textDocument/hover', { textDocument: { uri: 'file:///clangd-a.cpp' }, position: { line: 0, character: 5 } }, 20000);
      assert(JSON.stringify(hover).includes('square'), 'Real clangd hover did not return symbol data');
      await clangd.attachDocument('clangd-b.cpp', 'int value = 3;'); await clangd.attachDocument('clangd-a.cpp', code);
      assert(sessions.get('file:///clangd-a.cpp') === original, 'Tab switch restarted clangd');
      log('PASS real clangd: symbol hover / tab-switch session reuse');
      const stdCode = '#include <vector>\n#include <iostream>\nusing namespace std;\nint main(){ vector<int> values; cout << values.size(); // no semicolon warning\n vec\n}';
      await clangd.attachDocument('std.cpp', stdCode);
      const stdCompletion: any = await clangd.sendLspRequest('textDocument/completion', { textDocument: { uri: 'file:///std.cpp' }, position: { line: 4, character: 4 } }, 20000);
      const stdItems = Array.isArray(stdCompletion) ? stdCompletion : stdCompletion?.items || [];
      assert(stdItems.some((item: any) => /vector/.test(item.label)), 'Real clangd did not recognize using namespace std');
      log('PASS real clangd: using namespace std / unqualified vector completion');
    } else log('SKIP real clangd: JSPI unavailable in this browser');
    clangd.dispose();
    }
    await fs.syncToDisk();
    const saved = await (await folder.getFileHandle('a.cpp')).getFile(); assert(await saved.text() === 'latest', 'Explicit sync did not reach external handle');
    log('PASS native write-back: explicit sync reaches external directory handle');
    let binary = await fs.fileExists('main.wasm') ? await fs.readBinaryFile('main.wasm') : null;
    compiler.stop(); await fs.useBrowserStorage();
    const browserDir = 'io-regression-' + crypto.randomUUID(), browserSource = browserDir + '/main.cpp';
    await fs.writeFile(browserSource, 'int main(){}');
    assert((await fs.getAllFilesContent(browserSource, 'single'))[browserSource] === 'int main(){}', 'Browser-only source snapshot missed pending files');
    assert(await fs.directoryExists(browserDir) && await fs.readFile(browserSource) === 'int main(){}', 'Browser-only service read/stat failed');
    if (group === 'browser') {
      const source = '#include <fstream>\nint main(){int n=0; std::ifstream in("input.txt"); in>>n; std::ofstream out("result.txt"); out<<n+7; return n==35?0:9;}';
      await fs.writeFile(browserSource, source);
      const build = await compiler.compile(browserSource, { [browserSource]: source });
      assert(build.exitCode === 0 && build.wasmBytes, 'Browser-only compilation failed: ' + build.stderr); binary = build.wasmBytes!;
      log('PASS browser-only workspace: real clang / wasm-ld compilation without external disk');
    }
    if (binary) {
      await fs.writeBinaryFile(browserDir + '/program.wasm', binary); await fs.writeFile(browserDir + '/input.txt', '35');
      assert(await compiler.runWasmBinary(browserDir + '/program.wasm', undefined, { cwd: browserDir }) === 0, 'Browser-only C++ executable failed');
      assert(await fs.readFile(browserDir + '/result.txt') === '42', 'Browser-only C++ fstream IO failed');
      log('PASS browser-only workspace: real C++ executable / ifstream / ofstream / binary output');
    }
    let touchedDisk = false; try { await folder.getDirectoryHandle(browserDir); touchedDisk = true; } catch {}
    assert(!touchedDisk, 'Browser-only mode wrote to the previously selected native directory');
    await fs.deleteFile(browserDir); await fs.mountDirectory(folder);
    log('PASS browser-only workspace: service mount / source snapshot / read / stat / no external IO / switch back');
    log('ALL CORE REGRESSIONS PASSED');
  } catch (error: any) { log('FAIL: ' + (error.stack || error)); compiler?.stop(); }
});
