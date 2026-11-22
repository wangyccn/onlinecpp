import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transformWithOxc } from 'vite';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function moduleUrl(file, replacements = {}) {
  let source = await readFile(new URL('../' + file, import.meta.url), 'utf8');
  for (const [from, to] of Object.entries(replacements)) source = source.replace(from, to);
  const { code } = await transformWithOxc(source, file, { sourcemap: false });
  return 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
}
const queueUrl = await moduleUrl('src/services/writeQueue.ts');
const { WriteQueue } = await import(queueUrl);
const localPathsUrl = await moduleUrl('src/services/localPaths.ts');
const { cleanNativePath, localDependencies } = await import(localPathsUrl);
const processOutputUrl = await moduleUrl('src/services/processOutput.ts');
const { ProcessOutput } = await import(processOutputUrl);
const lexicalUrl = await moduleUrl('src/services/cppLexical.ts');
const { scanCpp, isCppComment } = await import(lexicalUrl);
const bufferedUrl = await moduleUrl('src/services/bufferedFileSystem.ts');
const { BufferedFileSystem } = await import(bufferedUrl);
let passed = 0;
async function test(name, task) { await task(); console.log('PASS', name); passed++; }

await test('canonical local paths and escaped depfiles match the compiler input snapshot', async () => {
  assert.equal(cleanNativePath('src/.././main.cpp'), 'main.cpp');
  assert.equal(cleanNativePath('dir\\file.cpp'), 'dir/file.cpp');
  assert.throws(() => cleanNativePath('../outside'), /escapes/);
  const depfile = 'object: /home/user/src/../my\\ file.hpp ' + String.fromCharCode(92, 10) + ' /home/user/price$$.def /usr/include/stddef.h /home/user/./main.cpp';
  assert.deepEqual(localDependencies(depfile), ['my file.hpp', 'price$.def', 'main.cpp']);
});
await test('shared stdout/stderr preserves framing and wraps without corrupting records', async () => {
  const producer = new ProcessOutput(new SharedArrayBuffer(128 + 8)), consumer = new ProcessOutput(producer.shared);
  for (let round = 0; round < 12; round++) {
    const input = new Uint8Array(37).fill(round);
    producer.write(round % 2 + 1, input); input.fill(255);
    const { chunks, end } = consumer.read();
    assert.equal(chunks.length, 1); assert.equal(chunks[0].stream, round % 2 + 1);
    assert.deepEqual(chunks[0].bytes, new Uint8Array(37).fill(round)); consumer.acknowledge(end);
  }
  assert.equal(consumer.read().chunks.length, 0);
});
await test('large output is split into bounded records without truncation', async () => {
  const producer = new ProcessOutput(), consumer = new ProcessOutput(producer.shared);
  const input = Uint8Array.from({ length: 100000 }, (_, i) => i & 255);
  for (let round = 0; round < 4; round++) {
    producer.write(1, input);
    const { chunks, end } = consumer.read();
    const actual = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.bytes.length, 0)); let offset = 0;
    for (const chunk of chunks) { actual.set(chunk.bytes, offset); offset += chunk.bytes.length; }
    assert.deepEqual(actual, input); consumer.acknowledge(end);
  }
});

await test('500 typing revisions collapse into a single write', async () => {
  const writes = []; const queue = new WriteQueue(async (path, value) => writes.push([path, value]));
  const promises = Array.from({ length: 500 }, (_, i) => queue.enqueue('a', i, 100));
  await queue.flush(); await Promise.all(promises);
  assert.deepEqual(writes, [['a', 499]]);
});
await test('slow same-file writes never overlap; obsolete pending writes are removed', async () => {
  const writes = []; let active = 0;
  const queue = new WriteQueue(async (_, value) => { assert.equal(++active, 1); await sleep(20); writes.push(value); active--; });
  const first = queue.enqueue('a', 0);
  await sleep(1);
  const rest = Array.from({ length: 100 }, (_, i) => queue.enqueue('a', i + 1));
  await Promise.all([first, ...rest]);
  assert.deepEqual(writes, [0, 100]);
});
await test('unrelated files bypass a slow file; concurrency is bounded', async () => {
  let active = 0, maximum = 0; const completed = [];
  const queue = new WriteQueue(async (path) => { active++; maximum = Math.max(maximum, active); await sleep(path === 'slow' ? 60 : 1); completed.push(path); active--; }, 3);
  await Promise.all(['slow', 'a', 'b', 'c', 'd'].map((key) => queue.enqueue(key, key)));
  assert.equal(maximum, 3); assert.notEqual(completed[0], 'slow');
});
await test('failed IO rejects callers and does not poison the next revision', async () => {
  const queue = new WriteQueue(async (_, value) => { if (value === 'bad') throw new Error('disk full'); });
  await assert.rejects(queue.enqueue('a', 'bad'), /disk full/);
  await queue.enqueue('a', 'good'); await queue.flush(); assert.equal(queue.busy, false);
});
await test('path-scoped flush does not wait for unrelated slow saves', async () => {
  let unblock; const slow = new Promise((resolve) => unblock = resolve);
  const queue = new WriteQueue(async (path) => { if (path === 'slow') await slow; });
  const writing = queue.enqueue('slow', 'data');
  const scratch = queue.enqueue('cache/scratch', 'object', 500);
  await Promise.race([queue.flush('cache'), sleep(100).then(() => { throw new Error('Unrelated save blocked cleanup'); })]);
  await scratch; unblock(); await writing;
});
const abortUrl = await moduleUrl('src/services/abort.ts');
const { abortable } = await import(abortUrl);
await test('cancelled waits settle promptly but atomic commits continue', async () => {
  const controller = new AbortController(); let committed = false;
  const commit = sleep(30).then(() => { committed = true; });
  const waiting = abortable(commit, controller.signal); controller.abort();
  await assert.rejects(waiting, { name: 'AbortError' }); assert.equal(committed, false);
  await commit; assert.equal(committed, true);
});

const models = new Map();
class Model {
  constructor(value, uri) { this.value = value; this.uri = uri; this.version = 1; this.listeners = []; }
  getValue() { return this.value; }
  getVersionId() { return this.version; }
  getLineContent(line) { return this.value.split('\n')[line - 1]; }
  getOffsetAt(position) { return this.value.split('\n').slice(0, position.lineNumber - 1).reduce((n, line) => n + line.length + 1, 0) + position.column - 1; }
  getWordUntilPosition(position) { const before = this.getLineContent(position.lineNumber).slice(0, position.column - 1), word = before.match(/\w*$/)[0]; return { word, startColumn: position.column - word.length, endColumn: position.column }; }
  isDisposed() { return !!this.disposed; }
  onDidChangeContent(fn) { this.listeners.push(fn); }
  setValue(value) { this.value = value; this.version++; this.listeners.forEach((fn) => fn()); }
  dispose() { this.disposed = true; models.delete(this.uri.toString()); }
}
const disposable = () => ({ dispose() {} });
const providers = {};
globalThis.window = { addEventListener() {} };
globalThis.document = { addEventListener() {}, visibilityState: 'visible' };
globalThis.__monaco = {
  Uri: { parse: (uri) => ({ toString: () => uri }) }, KeyMod: { CtrlCmd: 0 }, KeyCode: { KeyS: 0 },
  editor: {
    create: () => { let model = null; return { addCommand() {}, onDidChangeCursorPosition() {}, setModel(value) { model = value; }, getModel: () => model, focus() {}, dispose() {}, updateOptions() {} }; },
    createModel: (value, _, uri) => { const model = new Model(value, uri); models.set(uri.toString(), model); return model; },
    getModel: (uri) => models.get(uri.toString()), getModels: () => [...models.values()], setModelMarkers() {},
  },
  MarkerSeverity: { Error: 8, Warning: 4 },
  languages: new Proxy({ CompletionItemKind: {},
    registerCompletionItemProvider: (_, provider) => { providers.completion = provider; return disposable(); },
    registerHoverProvider: (_, provider) => { providers.hover = provider; return disposable(); },
  }, { get: (obj, name) => obj[name] || disposable }),
};
const editorUrl = await moduleUrl('src/services/monacoEditor.ts', {
  "import * as monaco from 'monaco-editor';": 'const monaco = globalThis.__monaco;',
  "import { WriteQueue } from './writeQueue';": 'import { WriteQueue } from ' + JSON.stringify(queueUrl) + ';',
});
const { MonacoEditorService } = await import(editorUrl);
const makeEditor = () => { const editor = new MonacoEditorService(); editor.mount({}, { autoSave: true }); return editor; };
await test('old completion cannot clear a newer dirty revision', async () => {
  const editor = makeEditor(); const disk = new Map();
  editor.setOnSave(async (path, value) => { await sleep(30); disk.set(path, value); });
  editor.openFile('race.cpp', ''); editor.getActiveModel().setValue('v1');
  const saving = editor.saveActiveFile(); await sleep(5); editor.getActiveModel().setValue('v2'); await saving;
  assert.equal(editor.getOpenTabs()[0].isDirty, true);
  await editor.saveAllFiles(); assert.equal(disk.get('race.cpp'), 'v2'); assert.equal(editor.getOpenTabs()[0].isDirty, false); editor.dispose();
});
await test('autosave follows the edited path rather than whichever tab is active later', async () => {
  const editor = makeEditor(); const disk = new Map(); editor.setOnSave((path, value) => { disk.set(path, value); });
  editor.openFile('first.cpp', ''); editor.getActiveModel().setValue('first');
  editor.openFile('second.cpp', ''); editor.getActiveModel().setValue('second');
  await sleep(850); assert.equal(disk.get('first.cpp'), 'first'); assert.equal(disk.get('second.cpp'), 'second'); editor.dispose();
});
await test('failed saves retain dirty data for explicit retry', async () => {
  const editor = makeEditor(); editor.applySettings({ autoSave: false }); editor.openFile('failed.cpp', ''); editor.getActiveModel().setValue('important');
  editor.setOnSave(async () => { throw new Error('permission revoked'); });
  await assert.rejects(editor.saveActiveFile(), /permission revoked/);
  assert.equal(editor.getOpenTabs()[0].isDirty, true); assert.equal(editor.getActiveContent(), 'important');
  editor.setOnSave(async () => {}); await editor.saveAllFiles(); assert.equal(editor.hasUnsavedChanges(), false); editor.dispose();
});
await test('close waits for durable save and disposes stale models', async () => {
  const editor = makeEditor(); let committed = false; editor.setOnSave(async () => { await sleep(20); committed = true; });
  editor.openFile('close.cpp', ''); editor.getActiveModel().setValue('keep');
  const closing = editor.closeTab('close.cpp'); assert.equal(editor.getOpenTabs().length, 1); await closing;
  assert.equal(committed, true); assert.equal(editor.getOpenTabs().length, 0); assert.deepEqual(editor.getAllOpenModelsContent(), {}); editor.dispose();
});
await test('repeated Ctrl+S for one revision shares its in-flight commit', async () => {
  const editor = makeEditor(); let writes = 0;
  editor.setOnSave(async () => { writes++; await sleep(25); });
  editor.openFile('dedup.cpp', ''); editor.getActiveModel().setValue('one revision');
  const save = editor.saveActiveFile(); await sleep(5);
  await Promise.all([save, editor.saveActiveFile(), editor.saveActiveFile()]);
  assert.equal(writes, 1); assert.equal(editor.hasUnsavedChanges(), false); editor.dispose();
});
await test('closing a removed/moved directory saves and disposes all descendant models', async () => {
  const editor = makeEditor(); const disk = new Map(); editor.setOnSave((path, text) => { disk.set(path, text); });
  editor.openFile('dir/a.cpp', 'a'); editor.getActiveModel().setValue('saved a');
  editor.openFile('dir/nested/b.cpp', 'b'); editor.getActiveModel().setValue('saved b');
  editor.openFile('directory.cpp', 'unrelated');
  await editor.closeTabsUnder('dir');
  assert.equal(disk.get('dir/a.cpp'), 'saved a'); assert.equal(disk.get('dir/nested/b.cpp'), 'saved b');
  assert.deepEqual(editor.getAllOpenModelsContent(), { 'directory.cpp': 'unrelated' }); editor.dispose();
});
await test('a new edit during directory closure prevents destructive IO', async () => {
  const editor = makeEditor(); editor.setOnSave(async () => { await sleep(25); });
  editor.openFile('dir/a.cpp', 'a'); editor.getActiveModel().setValue('first');
  const closing = editor.closeTabsUnder('dir'); await sleep(5); editor.getActiveModel().setValue('newer');
  await assert.rejects(closing, /Files changed/); assert.equal(editor.getActiveContent(), 'newer');
  assert.equal(editor.hasUnsavedChanges(), true); await editor.closeTabsUnder('dir'); editor.dispose();
});

let sessionCount = 0, disposedSessions = 0;
globalThis.__sessionOptions = [];
globalThis.__openSession = async (options) => {
  globalThis.__sessionOptions.push(options);
  sessionCount++; await sleep(10); const messages = [], listeners = [];
  return { port: { messages, postMessage: (message) => messages.push(message), addEventListener: (_, fn) => listeners.push(fn), start() {} }, closed: new Promise(() => {}), dispose() { disposedSessions++; } };
};
const clangdUrl = await moduleUrl('src/services/clangdService.ts', {
  "import { scanCpp, isCppComment } from './cppLexical';": 'import { scanCpp, isCppComment } from ' + JSON.stringify(lexicalUrl) + ';',
  "import * as monaco from 'monaco-editor';": 'const monaco = globalThis.__monaco;',
  "import { openClangdSession, ClangdSession } from '@algoproclub/clangd-wasm';": 'const openClangdSession = (...args) => globalThis.__openSession(...args);',
  "import { isClangdWasmSupported } from '@algoproclub/clangd-wasm/support';": 'const isClangdWasmSupported = () => true;',
});
const { ClangdService } = await import(clangdUrl);
await test('clangd attach is deduplicated and tab switching reuses document sessions', async () => {
  const service = new ClangdService();
  await Promise.all([service.attachDocument('a.cpp', 'a'), service.attachDocument('a.cpp', 'a')]);
  await service.attachDocument('b.cpp', 'b'); await service.attachDocument('a.cpp', 'a');
  assert.equal(sessionCount, 2); assert.equal(disposedSessions, 0); service.dispose();
});
await test('clangd receives the latest edit made while its session was starting', async () => {
  const service = new ClangdService(); const opening = service.attachDocument('pending.cpp', 'old');
  service.updateDocument('pending.cpp', 'latest', 7); await opening;
  const sent = service.sessions.get('file:///pending.cpp').port.messages.find((message) => message.method === 'textDocument/didOpen');
  assert.equal(sent.params.textDocument.text, 'latest'); assert.equal(sent.params.textDocument.version, 7); service.dispose();
});
await test('completion flushes pending didChange; cancellation reaches clangd', async () => {
  const service = new ClangdService(); await service.attachDocument('complete.cpp', 'old'); service.updateDocument('complete.cpp', 'new', 2);
  let cancel; const token = { isCancellationRequested: false, onCancellationRequested(fn) { cancel = fn; return disposable(); } };
  const response = service.sendLspRequest('textDocument/completion', { textDocument: { uri: 'file:///complete.cpp' } }, 500, token);
  const messages = service.sessions.get('file:///complete.cpp').port.messages;
  assert.equal(messages.at(-2).method, 'textDocument/didChange'); cancel(); await assert.rejects(response, /cancelled/);
  assert.equal(messages.at(-1).method, '$/cancelRequest'); service.dispose();
});
await test('foreground build pauses language updates and resumes with one latest revision', async () => {
  const service = new ClangdService(); await service.attachDocument('pause.cpp', 'old'); service.setPaused(true);
  service.updateDocument('pause.cpp', 'v2', 2); service.updateDocument('pause.cpp', 'v3', 3); await sleep(370);
  const messages = service.sessions.get('file:///pause.cpp').port.messages; assert.equal(messages.length, 1);
  service.setPaused(false); assert.equal(messages.at(-1).params.contentChanges[0].text, 'v3'); service.dispose();
});
await test('documents opened during a build attach when the foreground task ends', async () => {
  const service = new ClangdService(); service.setPaused(true); await service.attachDocument('new.cpp', 'latest');
  assert.equal(service.sessions.size, 0); service.setPaused(false); await sleep(30);
  assert.equal(service.sessions.size, 1); service.dispose();
});
await test('clangd opens C files with C17, not a C++ standard', async () => {
  const service = new ClangdService(); await service.attachDocument('native.c', 'int main(void){return 0;}');
  assert.deepEqual(globalThis.__sessionOptions.at(-1).compilerArguments.slice(0, 3), ['-x', 'c', '-std=c17']);
  assert.equal(service.sessions.get('file:///native.c').port.messages[0].params.textDocument.languageId, 'c'); service.dispose();
});

const compilerUrl = await moduleUrl('src/services/emceptionService.ts', {
  "import { DEFAULT_MANIFEST_URL } from '@gameguild/emception-browser';": "const DEFAULT_MANIFEST_URL = 'test-manifest';",
  "import { abortable } from './abort';": 'import { abortable } from ' + JSON.stringify(abortUrl) + ';',
  "import { localDependencies } from './localPaths';": 'import { localDependencies } from ' + JSON.stringify(localPathsUrl) + ';',
  "import { ProcessOutput } from './processOutput';": 'import { ProcessOutput } from ' + JSON.stringify(processOutputUrl) + ';',
});
const { EmceptionService } = await import(compilerUrl);
const fakeTerminal = { writeLine() {}, beginTask() { return () => {}; }, endProgramExecution() {} };
const fakeFS = { io: { disconnectCompiler() {}, async finishRuntime() {} } };
await test('compiler can interrupt during slow initialization, and rejects concurrent work', async () => {
  const service = new EmceptionService(fakeTerminal, fakeFS); service.init = () => new Promise(() => {});
  const controller = new AbortController();
  const compile = service.compile('main.cpp', { 'main.cpp': 'int main(){}' }, { signal: controller.signal });
  await assert.rejects(service.compile('main.cpp', {}), /already running/);
  await assert.rejects(service.runWasmBinary('main.wasm'), /already running/);
  controller.abort(); const result = await compile; assert.equal(result.exitCode, 130); assert.equal(service.isBusy(), false);
});
await test('runtime can interrupt while reading a binary, before a Worker is created', async () => {
  const controller = new AbortController();
  const service = new EmceptionService(fakeTerminal, { ...fakeFS, readBinaryFile: () => new Promise(() => {}) });
  const run = service.runWasmBinary('main.wasm', undefined, { signal: controller.signal });
  controller.abort(); assert.equal(await run, 130); assert.equal(service.isBusy(), false);
});
await test('C++ comment masking preserves offsets and ignores comment markers inside literals', async () => {
  const code = 'const char *url = "https://example"; // auto phantom();\nint value = 1; /* auto ghost(); */\nR"tag(// not comment /* either */)tag";';
  const scan = scanCpp(code);
  assert.equal(scan.code.length, code.length); assert.equal(scan.code.split('\n').length, 3);
  assert(scan.code.includes('https://example')); assert(!scan.symbols.includes('phantom')); assert(!scan.symbols.includes('ghost'));
  assert.equal(isCppComment(scan, code.indexOf('phantom')), true);
  assert.equal(isCppComment(scan, code.indexOf('not comment')), false);
  assert.equal(isCppComment(scan, code.indexOf('\n')), true);
});
const noCancel = { isCancellationRequested: false, onCancellationRequested: disposable };
const range = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 };
await test('using namespace std / using declarations / partial std:: all complete', async () => {
  const service = new ClangdService();
  for (const code of ['using namespace std;\nvec', 'using std::vector;\nvec', '// using namespace std;\nstd::vec']) {
    const model = new Model(code, { toString: () => 'file:///symbols.cpp' });
    const suggestions = await providers.completion.provideCompletionItems(model, { lineNumber: 2, column: code.split('\n')[1].length + 1 }, {}, noCancel);
    assert(suggestions.suggestions.some((item) => item.label === 'vector'));
  }
  const model = new Model('// using namespace std;\nvec', { toString: () => 'file:///symbols.cpp' });
  assert.equal(service.visibleStd(model, { lineNumber: 2, column: 4 }, range).length, 0); service.dispose();
});
await test('comments never request LSP completion/hover, create phantom symbols, or require semicolons', async () => {
  const service = new ClangdService();
  const code = '#include <iostream> // header\nint value = 1; // no missing semicolon\n// auto phantom();\n/* int ghost; */\n// auto';
  const model = new Model(code, { toString: () => 'file:///comments.cpp' });
  assert.deepEqual(await providers.completion.provideCompletionItems(model, { lineNumber: 5, column: 8 }, {}, noCancel), { suggestions: [] });
  assert.equal(await providers.hover.provideHover(model, { lineNumber: 5, column: 8 }, noCancel), null);
  assert(!service.extractSymbolsFromDocument(model, range).some((item) => ['phantom', 'ghost', 'auto'].includes(item.label)));
  assert(!service.runAstDiagnostics(model).some((item) => /semicolon|Expected ';'|header include/.test(item.message)));
  model.setValue('int value = 1 // genuinely missing');
  assert(service.runAstDiagnostics(model).some((item) => item.message.includes("Expected ';'"))); service.dispose();
});
await test('expected hover cancellation is silent and does not run fallback', async () => {
  const service = new ClangdService(); await service.attachDocument('hover.cpp', 'int x;');
  const model = new Model('int x;', { toString: () => 'file:///hover.cpp' });
  const oldWarn = console.warn; const warnings = []; console.warn = (...args) => warnings.push(args);
  try {
    for (const error of [Object.assign(new Error('cancelled'), { name: 'AbortError' }), Object.assign(new Error('content changed'), { code: -32801 })]) {
      service.sendLspRequest = async () => { throw error; };
      assert.equal(await providers.hover.provideHover(model, { lineNumber: 1, column: 5 }, noCancel), null);
    }
    assert.equal(warnings.length, 0);
  } finally { console.warn = oldWarn; service.dispose(); }
});

class Journal {
  records = new Map(); fail = false;
  async load() { return structuredClone([...this.records.values()]); }
  async update(entries, remove = []) {
    if (this.fail) throw new Error('quota exceeded');
    for (const path of remove) this.records.delete(path);
    for (const entry of entries) this.records.set(entry.path, structuredClone(entry));
  }
  async removeVersion(path, version) { if (this.records.get(path)?.version === version) this.records.delete(path); }
}
function memoryDisk() {
  const data = new Map(), dirs = new Set(['']), writes = [];
  const disk = {
    data, dirs, writes, delay: 0, active: 0, maxActive: 0, fail: false, gate: null,
    async stat(path) { return dirs.has(path) ? { kind: 'directory', size: 0, lastModified: 0 } : data.has(path) ? { kind: 'file', size: data.get(path).length, lastModified: 1 } : null; },
    async list(path) { return [...dirs, ...data.keys()].filter((name) => name !== path && name.startsWith(path ? path + '/' : '') && !name.slice(path ? path.length + 1 : 0).includes('/')).map((name) => ({ name: name.split('/').pop(), kind: dirs.has(name) ? 'directory' : 'file' })); },
    async read(path) { if (!data.has(path)) throw Object.assign(new Error('missing'), { name: 'NotFoundError' }); return data.get(path).slice(); },
    async write(path, bytes) {
      this.active++; this.maxActive = Math.max(this.maxActive, this.active);
      try { if (this.gate) await this.gate; if (this.delay) await sleep(this.delay); if (this.fail) throw new Error('permission revoked'); this.writes.push(path); data.set(path, bytes.slice()); } finally { this.active--; }
    },
    async mkdir(path) { dirs.add(path); },
    async remove(path) { for (const name of [...data.keys(), ...dirs]) if (name === path || name.startsWith(path + '/')) { data.delete(name); dirs.delete(name); } },
  }; return disk;
}
const text = (bytes) => new TextDecoder().decode(bytes);
await test('IO write-back returns before slow disk, reads latest IDB version, and cancels scratch IO', async () => {
  const journal = new Journal(), disk = memoryDisk(), fs = new BufferedFileSystem(journal, disk, () => {}, 1000); await fs.init();
  for (let i = 0; i < 100; i++) await fs.write('output.txt', String(i));
  assert.equal(text(await fs.read('output.txt')), '99'); assert.equal(disk.writes.length, 0);
  assert.equal((await fs.list(''))[0].name, 'output.txt'); assert.equal((await fs.stat('output.txt')).size, 2);
  await fs.write('scratch.o', 'temporary'); await fs.remove('scratch.o');
  await fs.flushDisk(); assert.deepEqual(disk.writes, ['output.txt']); assert.equal(journal.records.size, 0);
  assert.equal(text(await fs.read('output.txt')), '99');
});
await test('old disk completion cannot erase a newer pending version', async () => {
  const journal = new Journal(), disk = memoryDisk(); let release; disk.gate = new Promise((resolve) => release = resolve);
  const fs = new BufferedFileSystem(journal, disk, () => {}, 0); await fs.init(); await fs.write('a', 'old'); await sleep(1);
  await fs.write('a', 'new'); assert.equal(text(await fs.read('a')), 'new');
  release(); await fs.flushDisk(); assert.equal(text(disk.data.get('a')), 'new'); assert.equal(journal.records.size, 0);
});
await test('failed disk sync retains durable journal and replay/retry succeeds', async () => {
  const journal = new Journal(), disk = memoryDisk(); disk.fail = true;
  const fs = new BufferedFileSystem(journal, disk, () => {}, 1000); await fs.init(); await fs.write('important.cpp', 'keep');
  await assert.rejects(fs.flushDisk(), /permission/); assert.equal(journal.records.size, 1); assert.equal(text(await fs.read('important.cpp')), 'keep');
  disk.fail = false; const recovered = new BufferedFileSystem(journal, disk); await recovered.init(); await recovered.flushDisk();
  assert.equal(text(disk.data.get('important.cpp')), 'keep'); assert.equal(journal.records.size, 0);
});
await test('delete/recreate directories never exposes stale children or resurrects old writes', async () => {
  const journal = new Journal(), disk = memoryDisk(), fs = new BufferedFileSystem(journal, disk, () => {}, 1000); await fs.init();
  await fs.write('dir/old', 'old'); await fs.flushDisk();
  await fs.remove('dir'); await fs.write('dir/new', 'new');
  assert.equal(await fs.stat('dir/old'), null); assert.deepEqual((await fs.list('dir')).map((item) => item.name), ['new']);
  await fs.flushDisk(); assert(!disk.data.has('dir/old')); assert.equal(text(disk.data.get('dir/new')), 'new');
});
await test('browser-only filesystem persists without disk IO or journal cleanup', async () => {
  const journal = new Journal(), fs = new BufferedFileSystem(journal, null); await fs.init(); await fs.write('src/main.cpp', 'browser');
  await fs.flushDisk(); assert.equal(journal.records.size, 2); assert.equal(fs.status.pending, 0);
  const reopened = new BufferedFileSystem(journal, null); await reopened.init(); assert.equal(text(await reopened.read('src/main.cpp')), 'browser');
  await reopened.remove('src'); assert.equal(journal.records.size, 0);
});
await test('delete / recreate / delete cannot resurrect an existing external file', async () => {
  const disk = memoryDisk(), fs = new BufferedFileSystem(new Journal(), disk, () => {}, 1000); await fs.init();
  await fs.write('existing', 'old'); await fs.flushDisk();
  await fs.remove('existing'); await fs.write('existing', 'new'); await fs.remove('existing');
  await fs.flushDisk(); assert(!disk.data.has('existing'));
});
await test('journal quota errors fail the save instead of acknowledging memory-only data', async () => {
  const journal = new Journal(), fs = new BufferedFileSystem(journal, null); await fs.init(); journal.fail = true;
  await assert.rejects(fs.write('a', 'keep dirty'), /quota/); assert.equal(await fs.stat('a'), null);
});
await test('disk write pool is bounded while unrelated files run concurrently', async () => {
  const disk = memoryDisk(); disk.delay = 20; const fs = new BufferedFileSystem(new Journal(), disk, () => {}, 0, 3); await fs.init();
  await Promise.all(['a', 'b', 'c', 'd', 'e'].map((path) => fs.write(path, path))); await fs.flushDisk(); assert.equal(disk.maxActive, 3);
});
await test('a wedged disk write times out instead of pinning the queue forever', async () => {
  const journal = new Journal(), disk = memoryDisk(); disk.gate = new Promise(() => {});
  // commitTimeout = 50ms so the never-settling external write is detected quickly.
  const fs = new BufferedFileSystem(journal, disk, () => {}, 0, 6, 50); await fs.init();
  await fs.write('locked.cpp', 'x'); await sleep(5);
  await assert.rejects(fs.flushDisk(), /timed out/);
  assert.equal(journal.records.size, 1);
  assert.equal(text(await fs.read('locked.cpp')), 'x');
  disk.gate = null; disk.writes.length = 0;
  await fs.flushDisk();
  assert.equal(text(disk.data.get('locked.cpp')), 'x'); assert.equal(journal.records.size, 0); assert.equal(fs.status.pending, 0);
});
await test('background disk sync retries a transient failure without user action', async () => {
  const disk = memoryDisk(); let failures = 2;
  const realWrite = disk.write.bind(disk);
  disk.write = async (path, bytes) => { if (failures-- > 0) throw new Error('EBUSY'); return realWrite(path, bytes); };
  const journal = new Journal(), fs = new BufferedFileSystem(journal, disk, () => {}, 0); await fs.init();
  await fs.write('retry.cpp', 'v1');
  for (let i = 0; i < 80 && fs.status.pending; i++) await sleep(100);
  assert.equal(fs.status.pending, 0); assert.equal(text(disk.data.get('retry.cpp')), 'v1'); assert.equal(journal.records.size, 0);
});
console.log('\n' + passed + ' regression tests passed.');
