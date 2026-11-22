import * as monaco from 'monaco-editor';
import { openClangdSession, ClangdSession } from '@algoproclub/clangd-wasm';
import { isClangdWasmSupported } from '@algoproclub/clangd-wasm/support';
import { DiagnosticItem } from '../types';
import { scanCpp, isCppComment } from './cppLexical';

const lspCancellation = (message: string) => Object.assign(new Error(message), { name: 'AbortError' });
const isLspCancellation = (error: any) => error?.name === 'AbortError' || [-32800, -32801, -32802].includes(error?.code);

const LSP_TO_MONACO_KIND_MAP: Record<number, monaco.languages.CompletionItemKind> = {
  1: monaco.languages.CompletionItemKind.Text,
  2: monaco.languages.CompletionItemKind.Method,
  3: monaco.languages.CompletionItemKind.Function,
  4: monaco.languages.CompletionItemKind.Constructor,
  5: monaco.languages.CompletionItemKind.Field,
  6: monaco.languages.CompletionItemKind.Variable,
  7: monaco.languages.CompletionItemKind.Class,
  8: monaco.languages.CompletionItemKind.Interface,
  9: monaco.languages.CompletionItemKind.Module,
  10: monaco.languages.CompletionItemKind.Property,
  11: monaco.languages.CompletionItemKind.Unit,
  12: monaco.languages.CompletionItemKind.Value,
  13: monaco.languages.CompletionItemKind.Enum,
  14: monaco.languages.CompletionItemKind.Keyword,
  15: monaco.languages.CompletionItemKind.Snippet,
  16: monaco.languages.CompletionItemKind.Color,
  17: monaco.languages.CompletionItemKind.File,
  18: monaco.languages.CompletionItemKind.Reference,
  19: monaco.languages.CompletionItemKind.Folder,
  20: monaco.languages.CompletionItemKind.EnumMember,
  21: monaco.languages.CompletionItemKind.Constant,
  22: monaco.languages.CompletionItemKind.Struct,
  23: monaco.languages.CompletionItemKind.Event,
  24: monaco.languages.CompletionItemKind.Operator,
  25: monaco.languages.CompletionItemKind.TypeParameter,
};

export class ClangdService {
  private clangdSession: ClangdSession | null = null;
  private sessions = new Map<string, ClangdSession>();
  private sessionPromises = new Map<string, Promise<void>>();
  private sessionControllers = new Map<string, AbortController>();
  private documents = new Map<string, { text: string; version: number; sentVersion: number }>();
  private paused = false;
  private lexicalCache = new WeakMap<monaco.editor.ITextModel, { version: number; scan: ReturnType<typeof scanCpp> }>();
  private enabled = true;
  private standard = 'c++20';
  private isLspSupported = false;
  private isLspConnected = false;
  private isInitializing = false;
  private activeUri = '';
  private nextRequestId = 0;
  private pendingRequests = new Map<number, {
    resolve: (res: any) => void;
    reject: (err: any) => void;
    timer: any;
    uri: string;
    method: string;
  }>();

  // Diagnostics storage
  private lspDiagnostics: Map<string, DiagnosticItem[]> = new Map();
  private astDiagnostics: Map<string, DiagnosticItem[]> = new Map();
  private compilerDiagnostics: DiagnosticItem[] = [];

  private onDiagnosticsCallbacks: Array<(items: DiagnosticItem[]) => void> = [];
  private onStatusChangeCallbacks: Array<() => void> = [];
  private disposables: monaco.IDisposable[] = [];
  private debouncedUpdateTimers = new Map<string, any>();

  constructor() {
    this.checkSupport();
    this.registerMonacoLanguageProviders();
  }

  private checkSupport(): void {
    try {
      this.isLspSupported = isClangdWasmSupported();
      console.log('[ClangdService] WASM JSPI LSP Supported in this environment:', this.isLspSupported);
    } catch (e) {
      console.warn('[ClangdService] Clangd support check failed:', e);
      this.isLspSupported = false;
    }
  }

  public getStatusText(): { label: string; details: string; isLsp: boolean } {
    if (this.isLspConnected) {
      return {
        label: 'clangd WASM (LSP)',
        details: 'Connected to WebAssembly Clangd Language Server (C++20 LSP active)',
        isLsp: true,
      };
    }
    if (this.isInitializing) {
      return {
        label: 'clangd WASM (Starting...)',
        details: 'Spawning WebAssembly Clangd Language Server instance',
        isLsp: true,
      };
    }
    if (this.isLspSupported) {
      return {
        label: 'clangd WASM (Standby)',
        details: 'Clangd WASM is supported and will attach to opened documents',
        isLsp: true,
      };
    }
    return {
      label: 'C++ IntelliSense (AST Engine)',
      details: 'Enhanced in-browser C++ intelligence with real-time AST syntax analysis',
      isLsp: false,
    };
  }

  public onDiagnostics(callback: (items: DiagnosticItem[]) => void): () => void {
    this.onDiagnosticsCallbacks.push(callback);
    return () => {
      this.onDiagnosticsCallbacks = this.onDiagnosticsCallbacks.filter((cb) => cb !== callback);
    };
  }

  public onStatusChange(callback: () => void): () => void {
    this.onStatusChangeCallbacks.push(callback);
    return () => {
      this.onStatusChangeCallbacks = this.onStatusChangeCallbacks.filter((cb) => cb !== callback);
    };
  }

  private notifyStatusChange(): void {
    for (const cb of this.onStatusChangeCallbacks) {
      cb();
    }
  }

  private normalizeUri(uri: string): string {
    if (uri.startsWith('file://')) {
      return uri;
    }
    return `file:///${uri.replace(/^[\/\\]+/, '')}`;
  }

  private getModelByUri(uri: string): monaco.editor.ITextModel | null {
    const norm = this.normalizeUri(uri);
    return (
      monaco.editor.getModel(monaco.Uri.parse(norm)) ||
      monaco.editor.getModels().find((m) => {
        const mUri = m.uri.toString();
        return mUri === norm || mUri.endsWith(norm.replace(/^file:\/\/\/?/, ''));
      }) ||
      null
    );
  }

  public configure(standard: string, enabled: boolean): void {
    if (this.standard === standard && this.enabled === enabled) return;
    this.resetWorkspace(); this.standard = standard; this.enabled = enabled;
    const model = monaco.editor.getModels().find((model) => model.uri.toString() === this.activeUri);
    if (model) void this.attachDocument(this.activeUri, model.getValue());
  }

  public setPaused(paused: boolean): void {
    this.paused = paused;
    if (paused) {
      for (const [id, request] of this.pendingRequests) {
        this.sessions.get(request.uri)?.port.postMessage({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id } });
        request.reject(lspCancellation('Language service paused for foreground task')); clearTimeout(request.timer);
      }
      this.pendingRequests.clear();
    } else {
      for (const uri of this.sessions.keys()) this.flushDocument(uri);
      const document = this.documents.get(this.activeUri);
      if (document && !this.sessions.has(this.activeUri)) void this.attachDocument(this.activeUri, document.text);
    }
  }

  public retainDocuments(paths: string[]): void {
    const keep = new Set(paths.map((path) => this.normalizeUri(path)));
    for (const [id, request] of this.pendingRequests) if (!keep.has(request.uri)) {
      this.sessions.get(request.uri)?.port.postMessage({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id } });
      request.reject(lspCancellation('Document closed')); this.pendingRequests.delete(id);
    }
    for (const [uri, session] of this.sessions) {
      if (!keep.has(uri)) { session.dispose(); this.sessions.delete(uri); }
    }
    for (const [uri, controller] of this.sessionControllers) if (!keep.has(uri)) { controller.abort(); this.sessionControllers.delete(uri); }
    for (const uri of this.documents.keys()) if (!keep.has(uri)) {
      this.documents.delete(uri); this.lspDiagnostics.delete(uri); this.astDiagnostics.delete(uri);
      clearTimeout(this.debouncedUpdateTimers.get(uri)); this.debouncedUpdateTimers.delete(uri);
    }
    this.isLspConnected = this.sessions.size > 0;
  }

  public resetWorkspace(): void {
    for (const controller of this.sessionControllers.values()) controller.abort();
    this.sessionControllers.clear();
    for (const session of this.sessions.values()) session.dispose();
    this.sessions.clear(); this.sessionPromises.clear(); this.documents.clear();
    this.clangdSession = null; this.isLspConnected = false; this.isInitializing = false;
    for (const timer of this.debouncedUpdateTimers.values()) clearTimeout(timer);
    this.debouncedUpdateTimers.clear();
    for (const request of this.pendingRequests.values()) { clearTimeout(request.timer); request.reject(lspCancellation('Workspace closed')); }
    this.pendingRequests.clear(); this.lspDiagnostics.clear(); this.astDiagnostics.clear(); this.compilerDiagnostics = [];
    this.notifyStatusChange(); this.broadcastDiagnostics();
  }

  public async attachDocument(rawUri: string, initialCode: string): Promise<void> {
    const uri = this.normalizeUri(rawUri); this.activeUri = uri;
    if (!/\.(c|cc|cpp|cxx|h|hh|hpp|hxx)$/i.test(uri)) return;
    if (!this.documents.has(uri)) this.documents.set(uri, { text: initialCode, version: this.getModelByUri(uri)?.getVersionId() || 1, sentVersion: 0 });
    if (!this.enabled || this.paused) return;
    if (this.sessions.has(uri)) { this.clangdSession = this.sessions.get(uri)!; this.flushDocument(uri); return; }
    if (this.sessionPromises.has(uri)) return this.sessionPromises.get(uri);
    if (!this.isLspSupported) { const model = this.getModelByUri(uri); if (model) this.runAstDiagnostics(model); return; }
    const controller = new AbortController(); this.sessionControllers.set(uri, controller);
    const opening = (async () => {
      try {
        this.isInitializing = true; this.notifyStatusChange();
        const c = uri.toLowerCase().endsWith('.c');
        const session = await openClangdSession({ uri, signal: controller.signal, compilerArguments: [
          '-x', c ? 'c' : 'c++', c ? '-std=c17' : `-std=${this.standard}`, '-Wno-register', '-Wno-deprecated-register', '-Wno-shift-op-parentheses',
        ] });
        if (controller.signal.aborted || !this.documents.has(uri)) { session.dispose(); return; }
        this.sessions.set(uri, session); this.clangdSession = session;
        this.isLspConnected = true;
        session.port.addEventListener('message', (event) => this.handlePortMessage(event.data)); session.port.start();
        const document = this.documents.get(uri)!;
        session.port.postMessage({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: {
          textDocument: { uri, languageId: c ? 'c' : 'cpp', version: document.version, text: document.text },
        } });
        document.sentVersion = document.version;
        session.closed.then(() => {
          if (this.sessions.get(uri) === session) { this.sessions.delete(uri); this.isLspConnected = this.sessions.size > 0; this.notifyStatusChange(); }
        }).catch(() => {});
      } catch (error) {
        if (!controller.signal.aborted) {
          console.warn('[ClangdService] Session unavailable:', error);
          const model = this.getModelByUri(uri); if (model && !this.paused) this.runAstDiagnostics(model);
        }
      } finally {
        if (this.sessionControllers.get(uri) === controller) { this.sessionPromises.delete(uri); this.sessionControllers.delete(uri); }
        this.isInitializing = this.sessionPromises.size > 0; this.notifyStatusChange();
      }
    })();
    this.sessionPromises.set(uri, opening);
    return opening;
  }

  public updateDocument(rawUri: string, newText: string, version: number): void {
    const uri = this.normalizeUri(rawUri);
    const previous = this.documents.get(uri);
    this.documents.set(uri, { text: newText, version, sentVersion: previous?.sentVersion || 0 });
    clearTimeout(this.debouncedUpdateTimers.get(uri));
    const timer = setTimeout(() => {
      this.debouncedUpdateTimers.delete(uri);
      if (this.paused || !this.enabled) return;
      if (this.sessions.has(uri)) this.flushDocument(uri);
      else if (!this.sessionPromises.has(uri)) { const model = this.getModelByUri(uri); if (model) this.runAstDiagnostics(model); }
    }, 350);
    this.debouncedUpdateTimers.set(uri, timer);
  }

  private flushDocument(uri: string): void {
    if (this.paused || !this.enabled) return;
    const document = this.documents.get(uri), session = this.sessions.get(uri);
    if (!document || !session || document.sentVersion >= document.version) return;
    clearTimeout(this.debouncedUpdateTimers.get(uri)); this.debouncedUpdateTimers.delete(uri);
    session.port.postMessage({ jsonrpc: '2.0', method: 'textDocument/didChange', params: {
      textDocument: { uri, version: document.version }, contentChanges: [{ text: document.text }],
    } });
    document.sentVersion = document.version;
  }

  public sendLspRequest<T = any>(method: string, params: any, timeoutMs = 1600, token?: monaco.CancellationToken): Promise<T> {
    const uri = this.normalizeUri(params.textDocument?.uri || this.activeUri);
    const session = this.sessions.get(uri);
    if (!session || this.paused || !this.enabled || token?.isCancellationRequested) {
      return Promise.reject(lspCancellation('Clangd LSP not available'));
    }
    this.flushDocument(uri);
    // Superseded completion/hover requests must not keep the single WASM engine busy.
    for (const [id, pending] of this.pendingRequests) if (pending.uri === uri && pending.method === method) {
      session.port.postMessage({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id } });
      this.pendingRequests.delete(id); pending.reject(lspCancellation('LSP request superseded'));
    }

    const id = ++this.nextRequestId;
    return new Promise<T>((resolve, reject) => {
      let cancellation: monaco.IDisposable | undefined;
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        cancellation?.dispose();
        session.port.postMessage({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id } });
        reject(new Error(`LSP request ${method} (id=${id}) timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve: (val) => {
          clearTimeout(timer);
          cancellation?.dispose();
          resolve(val);
        },
        reject: (err) => {
          clearTimeout(timer);
          cancellation?.dispose();
          reject(err);
        },
        timer,
        uri, method,
      });
      cancellation = token?.onCancellationRequested(() => {
        const pending = this.pendingRequests.get(id); this.pendingRequests.delete(id);
        session.port.postMessage({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id } });
        pending?.reject(lspCancellation('LSP request cancelled'));
      });

      session.port.postMessage({
        jsonrpc: '2.0',
        id,
        method,
        params,
      });
    });
  }

  private sendLspNotification(method: string, params: any): void {
    if (this.clangdSession?.port) {
      this.clangdSession.port.postMessage({
        jsonrpc: '2.0',
        method,
        params,
      });
    }
  }

  private handlePortMessage(data: any): void {
    if (!data || typeof data !== 'object') return;

    // 1. JSON-RPC Response to pending request
    if (data.id !== undefined && this.pendingRequests.has(data.id)) {
      const pending = this.pendingRequests.get(data.id)!;
      this.pendingRequests.delete(data.id);
      clearTimeout(pending.timer);

      if (data.error) {
        pending.reject(Object.assign(new Error(data.error.message || `LSP error ${data.error.code}`), { code: data.error.code }));
      } else {
        pending.resolve(data.result);
      }
      return;
    }

    // 2. Server Notification: textDocument/publishDiagnostics
    if (data.method === 'textDocument/publishDiagnostics') {
      this.handleLspDiagnostics(data.params);
      return;
    }
  }

  private handleLspDiagnostics(params: any): void {
    if (!params || !params.diagnostics) return;

    const uri = this.normalizeUri(params.uri);
    if (params.version !== undefined && params.version < (this.documents.get(uri)?.version || 0)) return;
    const items: DiagnosticItem[] = params.diagnostics.map((d: any) => ({
      file: uri.replace(/^file:\/\/\/?/, ''),
      line: (d.range?.start?.line ?? 0) + 1,
      column: (d.range?.start?.character ?? 0) + 1,
      message: d.message,
      severity: d.severity === 1 ? 'error' : d.severity === 2 ? 'warning' : 'info',
    }));

    this.lspDiagnostics.set(uri, items);

    // Update Monaco editor markers dynamically
    const model = this.getModelByUri(uri);
    if (model) {
      const markers: monaco.editor.IMarkerData[] = params.diagnostics.map((d: any) => ({
        severity:
          d.severity === 1 ? monaco.MarkerSeverity.Error :
          d.severity === 2 ? monaco.MarkerSeverity.Warning :
          d.severity === 3 ? monaco.MarkerSeverity.Info : monaco.MarkerSeverity.Hint,
        message: d.message,
        startLineNumber: (d.range?.start?.line ?? 0) + 1,
        startColumn: (d.range?.start?.character ?? 0) + 1,
        endLineNumber: (d.range?.end?.line ?? 0) + 1,
        endColumn: (d.range?.end?.character ?? 0) + 1,
        source: 'clangd',
      }));

      monaco.editor.setModelMarkers(model, 'clangd-lsp', markers);
      // Clear AST markers as LSP is fully active
      monaco.editor.setModelMarkers(model, 'ast-engine', []);
    }

    this.broadcastDiagnostics();
  }

  public runAstDiagnostics(model: monaco.editor.ITextModel): DiagnosticItem[] {
    const uri = this.normalizeUri(model.uri.toString());
    const code = model.getValue();
    const lines = code.split(/\r?\n/);
    const uncommented = this.lexical(model).code.split(/\r?\n/);
    const markers: monaco.editor.IMarkerData[] = [];
    const items: DiagnosticItem[] = [];

    const addIssue = (
      line: number,
      col: number,
      endCol: number,
      message: string,
      severity: 'error' | 'warning' = 'error'
    ) => {
      markers.push({
        severity: severity === 'error' ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
        message,
        startLineNumber: line,
        startColumn: Math.max(1, col),
        endLineNumber: line,
        endColumn: Math.max(col + 1, endCol),
        source: 'ast-engine',
      });
      items.push({
        file: uri.replace(/^file:\/\/\/?/, ''),
        line,
        column: col,
        message,
        severity,
      });
    };

    // 1. Bracket & Parentheses Matching
    const stack: Array<{ char: string; line: number; col: number }> = [];
    const pairMap: Record<string, string> = { '}': '{', ')': '(', ']': '[' };

    let inBlockComment = false;

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const lineNum = lineIdx + 1;
      const lineText = lines[lineIdx];
      let inString = false;
      let inChar = false;
      let stringStartCol = 0;

      for (let c = 0; c < lineText.length; c++) {
        const ch = lineText[c];
        const next = lineText[c + 1];

        if (inBlockComment) {
          if (ch === '*' && next === '/') {
            inBlockComment = false;
            c++;
          }
          continue;
        }

        if (!inString && !inChar && ch === '/' && next === '*') {
          inBlockComment = true;
          c++;
          continue;
        }

        if (!inString && !inChar && ch === '/' && next === '/') {
          // Line comment: remainder of line is ignored
          break;
        }

        if (!inChar && ch === '"' && (c === 0 || lineText[c - 1] !== '\\')) {
          inString = !inString;
          if (inString) stringStartCol = c + 1;
          continue;
        }

        if (!inString && ch === "'" && (c === 0 || lineText[c - 1] !== '\\')) {
          inChar = !inChar;
          continue;
        }

        if (inString || inChar) continue;

        if (ch === '{' || ch === '(' || ch === '[') {
          stack.push({ char: ch, line: lineNum, col: c + 1 });
        } else if (ch === '}' || ch === ')' || ch === ']') {
          const expected = pairMap[ch];
          if (stack.length === 0) {
            addIssue(lineNum, c + 1, c + 2, `Unmatched closing bracket '${ch}'`);
          } else {
            const top = stack.pop()!;
            if (top.char !== expected) {
              addIssue(
                lineNum,
                c + 1,
                c + 2,
                `Mismatched closing bracket '${ch}', expected match for '${top.char}' opened at line ${top.line}`
              );
            }
          }
        }
      }

      if (inString && !lineText.endsWith('\\')) {
        addIssue(lineNum, stringStartCol, lineText.length + 1, 'Unterminated string literal');
      }

      // 2. Syntax Check: Missing Semicolons
      const trimmed = uncommented[lineIdx].trim();
      if (
        trimmed &&
        !trimmed.startsWith('//') &&
        !trimmed.startsWith('#') &&
        !trimmed.startsWith('/*') &&
        !inBlockComment
      ) {
        // Statements that normally require a semicolon at line end
        const isStatementStarter = /^(?:std::)?(?:cout|cin|cerr|return|break|continue|throw)\b/.test(trimmed) ||
                                  /^(?:int|long|short|char|float|double|bool|auto|string|vector<[^>]+>)\s+[a-zA-Z_0-9]+(?:\s*=.*)?$/.test(trimmed);

        const endsWithSemicolonOrBracket = /[;{}:,\\]$/.test(trimmed) || trimmed.endsWith('<<') || trimmed.endsWith('>>');

        if (isStatementStarter && !endsWithSemicolonOrBracket) {
          // Check next line to ensure it is not a continuation
          const nextLine = uncommented[lineIdx + 1]?.trim() || '';
          const isContinuation =
            nextLine.startsWith('<<') ||
            nextLine.startsWith('>>') ||
            nextLine.startsWith('+') ||
            nextLine.startsWith('-') ||
            nextLine.startsWith('*') ||
            nextLine.startsWith('/') ||
            nextLine.startsWith('.') ||
            nextLine.startsWith('->') ||
            nextLine.startsWith('?') ||
            nextLine.startsWith(':');

          if (!isContinuation) {
            addIssue(
              lineNum,
              lineText.length,
              lineText.length + 1,
              "Expected ';' at end of statement"
            );
          }
        }
      }

      // 3. Include syntax check
      if (trimmed.startsWith('#include')) {
        const afterInclude = trimmed.substring(8).trim();
        if (afterInclude.startsWith('<') && !afterInclude.endsWith('>')) {
          addIssue(lineNum, 1, lineText.length + 1, "Expected '>' to terminate header include");
        } else if (afterInclude.startsWith('"') && (!afterInclude.endsWith('"') || afterInclude.length === 1)) {
          addIssue(lineNum, 1, lineText.length + 1, 'Expected closing \'"\' to terminate header include');
        }
      }
    }

    // Unclosed brackets remaining in stack
    while (stack.length > 0) {
      const unclosed = stack.pop()!;
      addIssue(
        unclosed.line,
        unclosed.col,
        unclosed.col + 1,
        `Unclosed bracket '${unclosed.char}'`
      );
    }

    monaco.editor.setModelMarkers(model, 'ast-engine', markers);
    this.astDiagnostics.set(uri, items);
    this.broadcastDiagnostics();

    return items;
  }

  public updateMarkersFromCompilerOutput(model: monaco.editor.ITextModel, compilerOutput: string): DiagnosticItem[] {
    const diagnostics: DiagnosticItem[] = [];
    const markers: monaco.editor.IMarkerData[] = [];

    // Parse standard Clang compiler output
    const errorRegex = /([^:\n\r]+):(\d+):(\d+):\s+(fatal error|error|warning|note):\s+(.*)/gi;
    let match;

    while ((match = errorRegex.exec(compilerOutput)) !== null) {
      const file = match[1].trim();
      const line = parseInt(match[2], 10);
      const col = parseInt(match[3], 10);
      const type = match[4].toLowerCase();
      const message = match[5].trim();

      const isError = type.includes('error');
      const isWarning = type.includes('warning');

      const severity =
        isError ? monaco.MarkerSeverity.Error :
        isWarning ? monaco.MarkerSeverity.Warning :
        monaco.MarkerSeverity.Info;

      const diagSeverity: 'error' | 'warning' | 'info' =
        isError ? 'error' : isWarning ? 'warning' : 'info';

      diagnostics.push({
        file,
        line,
        column: col,
        message: type.includes('note') ? `[Note] ${message}` : message,
        severity: diagSeverity,
      });

      const lineContent = model.getLineContent(line) || '';
      let endCol = col + 1;
      const rest = lineContent.substring(col - 1);
      const tokenMatch = rest.match(/^[a-zA-Z0-9_]+/);
      if (tokenMatch) {
        endCol = col + tokenMatch[0].length;
      }

      markers.push({
        severity,
        message,
        startLineNumber: line,
        startColumn: col,
        endLineNumber: line,
        endColumn: Math.max(col + 1, endCol),
        source: 'compiler',
      });
    }

    monaco.editor.setModelMarkers(model, 'cpp-compiler', markers);
    this.compilerDiagnostics = diagnostics;
    this.broadcastDiagnostics();

    return diagnostics;
  }

  public clearCompilerMarkers(model: monaco.editor.ITextModel): void {
    monaco.editor.setModelMarkers(model, 'cpp-compiler', []);
    this.compilerDiagnostics = [];
    this.broadcastDiagnostics();
  }

  public clearMarkers(model: monaco.editor.ITextModel): void {
    this.clearCompilerMarkers(model);
  }

  private broadcastDiagnostics(): void {
    let activeItems: DiagnosticItem[] = [];

    if (this.compilerDiagnostics.length > 0) {
      activeItems = [...this.compilerDiagnostics];
    } else if (this.isLspConnected) {
      const lspItems = this.lspDiagnostics.get(this.activeUri) || [];
      activeItems = [...lspItems];
    } else {
      const astItems = this.astDiagnostics.get(this.activeUri) || [];
      activeItems = [...astItems];
    }

    for (const cb of this.onDiagnosticsCallbacks) {
      cb(activeItems);
    }
  }

  private lexical(model: monaco.editor.ITextModel): ReturnType<typeof scanCpp> {
    const version = model.getVersionId(), cached = this.lexicalCache.get(model);
    if (cached?.version === version) return cached.scan;
    const scan = scanCpp(model.getValue()); this.lexicalCache.set(model, { version, scan }); return scan;
  }

  private inComment(model: monaco.editor.ITextModel, position: monaco.Position): boolean {
    return isCppComment(this.lexical(model), model.getOffsetAt(position));
  }

  private visibleStd(model: monaco.editor.ITextModel, position: monaco.Position, range: monaco.IRange): monaco.languages.CompletionItem[] {
    const before = this.lexical(model).symbols.slice(0, model.getOffsetAt(position));
    const hasUsingNamespaceStd = /\busing\s+namespace\s+std\s*;/.test(before);
    if (hasUsingNamespaceStd) return this.getStdSuggestions(range, false);
    const names = new Set([...before.matchAll(/\busing\s+std\s*::\s*(\w+)\s*;/g)].map((match) => match[1]));
    return this.getStdSuggestions(range, true).filter((item) => names.has(String(item.label)));
  }

  private registerMonacoLanguageProviders(): void {
    // 1. Completion Provider (LSP First + AST & Snippet Fallback)
    const completionProvider = monaco.languages.registerCompletionItemProvider('cpp', {
      triggerCharacters: ['.', ':', '>', '<', '#', '"', '/'],
      provideCompletionItems: async (model, position, context, token) => {
        if (token.isCancellationRequested || this.inComment(model, position)) return { suggestions: [] };
        const requestedVersion = model.getVersionId();
        const lineContent = model.getLineContent(position.lineNumber);
        const textUntilPosition = lineContent.substring(0, position.column - 1);
        const word = model.getWordUntilPosition(position);
        const defaultRange: monaco.IRange = {
          startLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endLineNumber: position.lineNumber,
          endColumn: word.endColumn,
        };

        // If LSP is connected, send textDocument/completion request
        if (this.isLspConnected && this.clangdSession) {
          try {
            const uri = this.normalizeUri(model.uri.toString());
            const response = await this.sendLspRequest(
              'textDocument/completion',
              {
                textDocument: { uri },
                position: {
                  line: position.lineNumber - 1,
                  character: position.column - 1,
                },
                context: {
                  triggerKind:
                    context.triggerKind === monaco.languages.CompletionTriggerKind.TriggerCharacter ? 2 : 1,
                  triggerCharacter: context.triggerCharacter,
                },
              },
              1600, token
            );

            if (token.isCancellationRequested || requestedVersion !== model.getVersionId()) return { suggestions: [] };
            if (response) {
              const rawItems = Array.isArray(response) ? response : (response.items || []);
              if (rawItems.length > 0) {
                const suggestions = this.convertLspCompletionItems(rawItems, model, position, defaultRange);
                // When `using namespace std;` is in scope, strip redundant `std::` from LSP completions
                // to match the user's coding style and avoid unmaintainable qualified names.
                const before = this.lexical(model).symbols.slice(0, model.getOffsetAt(position));
                const hasUsingNamespaceStd = /\busing\s+namespace\s+std\s*;/.test(before);
                if (hasUsingNamespaceStd) {
                  for (const item of suggestions) {
                    if (typeof item.insertText === 'string' && item.insertText.startsWith('std::')) {
                      item.insertText = item.insertText.slice(5);
                    }
                    if (typeof item.filterText === 'string' && item.filterText.startsWith('std::')) {
                      item.filterText = item.filterText.slice(5);
                    }
                  }
                }
                if (!/(?:\.|->|::)\w*$/.test(textUntilPosition)) {
                  const existing = new Set(suggestions.map((item) => String(item.filterText || item.label).replace(/\(.*$/, '').trim()));
                  suggestions.push(...this.visibleStd(model, position, defaultRange).filter((item) => !existing.has(String(item.label))));
                }

                // Blend in standard template snippets if appropriate
                if (word.word && word.word.length >= 2) {
                  const before = this.lexical(model).symbols.slice(0, model.getOffsetAt(position));
                  const hasUsingNamespaceStd = /\busing\s+namespace\s+std\s*;/.test(before);
                  const snippets = this.getSnippetSuggestions(defaultRange, !hasUsingNamespaceStd).filter((s) =>
                    s.label.toString().toLowerCase().startsWith(word.word.toLowerCase())
                  );
                  suggestions.push(...snippets);
                }

                return {
                  suggestions,
                  incomplete: response.isIncomplete ?? false,
                };
              }
            }
          } catch (err) {
            if (isLspCancellation(err) || token.isCancellationRequested) return { suggestions: [] };
            console.warn('[ClangdService] LSP completion failed, falling back to AST Engine:', err);
          }
        }

        // Fallback: Enhanced AST & C++20 Standard Library Suggestions
        return {
          suggestions: this.getEnhancedFallbackCompletions(
            model,
            position,
            defaultRange,
            textUntilPosition,
            lineContent
          ),
        };
      },
    });

    // 2. Hover Provider (LSP First + Standard Docs Fallback)
    const hoverProvider = monaco.languages.registerHoverProvider('cpp', {
      provideHover: async (model, position, token) => {
        if (token.isCancellationRequested || this.inComment(model, position)) return null;
        if (this.isLspConnected && this.clangdSession) {
          try {
            const uri = this.normalizeUri(model.uri.toString());
            const response = await this.sendLspRequest(
              'textDocument/hover',
              {
                textDocument: { uri },
                position: {
                  line: position.lineNumber - 1,
                  character: position.column - 1,
                },
              },
              1200, token
            );

            if (token.isCancellationRequested) return null;
            if (response && response.contents) {
              let contents: monaco.IMarkdownString[] = [];

              if (typeof response.contents === 'string') {
                contents = [{ value: response.contents }];
              } else if (Array.isArray(response.contents)) {
                contents = response.contents.map((c: any) => ({
                  value: typeof c === 'string' ? c : `\`\`\`cpp\n${c.value}\n\`\`\``,
                }));
              } else if (typeof response.contents === 'object' && 'value' in response.contents) {
                contents = [{ value: response.contents.value }];
              }

              let range: monaco.IRange | undefined;
              if (response.range) {
                range = {
                  startLineNumber: response.range.start.line + 1,
                  startColumn: response.range.start.character + 1,
                  endLineNumber: response.range.end.line + 1,
                  endColumn: response.range.end.character + 1,
                };
              }

              return { contents, range };
            }
          } catch (err) {
            if (isLspCancellation(err) || token.isCancellationRequested) return null;
            console.warn('[ClangdService] LSP hover failed:', err);
          }
        }

        // Fallback hover
        const word = model.getWordAtPosition(position);
        if (!word) return null;
        const info = this.getCppSymbolDocumentation(word.word);
        if (!info) return null;

        return {
          range: new monaco.Range(
            position.lineNumber,
            word.startColumn,
            position.lineNumber,
            word.endColumn
          ),
          contents: [
            { value: `**\`${info.signature}\`**` },
            { value: info.description },
          ],
        };
      },
    });

    // 3. Signature Help Provider (LSP First + Fallback)
    const signatureHelpProvider = monaco.languages.registerSignatureHelpProvider('cpp', {
      signatureHelpTriggerCharacters: ['(', ','],
      provideSignatureHelp: async (model, position, token, context) => {
        if (token.isCancellationRequested || this.inComment(model, position)) return null;
        if (this.isLspConnected && this.clangdSession) {
          try {
            const uri = this.normalizeUri(model.uri.toString());
            const response = await this.sendLspRequest(
              'textDocument/signatureHelp',
              {
                textDocument: { uri },
                position: {
                  line: position.lineNumber - 1,
                  character: position.column - 1,
                },
                context: {
                  triggerKind:
                    context.triggerKind === monaco.languages.SignatureHelpTriggerKind.TriggerCharacter ? 2 : 1,
                  triggerCharacter: context.triggerCharacter,
                  isRetrigger: context.isRetrigger,
                },
              },
              1200, token
            );

            if (response && response.signatures && response.signatures.length > 0) {
              return {
                value: {
                  signatures: response.signatures.map((s: any) => ({
                    label: s.label,
                    documentation: typeof s.documentation === 'object' ? s.documentation?.value : s.documentation,
                    parameters: (s.parameters || []).map((p: any) => ({
                      label: p.label,
                      documentation: typeof p.documentation === 'object' ? p.documentation?.value : p.documentation,
                    })),
                  })),
                  activeSignature: response.activeSignature ?? 0,
                  activeParameter: response.activeParameter ?? 0,
                },
                dispose: () => {},
              };
            }
          } catch (err) {
            if (isLspCancellation(err) || token.isCancellationRequested) return null;
            console.warn('[ClangdService] LSP signatureHelp failed:', err);
          }
        }

        // Fallback signature help
        const line = model.getLineContent(position.lineNumber);
        const before = line.substring(0, position.column - 1);
        const match = before.match(/([a-zA-Z0-9_]+)\s*\(([^()]*)$/);
        if (!match) return null;

        const funcName = match[1];
        const argsStr = match[2];
        const activeParam = argsStr.split(',').length - 1;

        const sig = this.getFunctionSignature(funcName);
        if (!sig) return null;

        return {
          value: {
            signatures: [sig],
            activeSignature: 0,
            activeParameter: activeParam,
          },
          dispose: () => {},
        };
      },
    });

    // 4. Document Formatting Provider
    const formattingProvider = monaco.languages.registerDocumentFormattingEditProvider('cpp', {
      provideDocumentFormattingEdits: async (model, options, token) => {
        if (this.isLspConnected && this.clangdSession) {
          try {
            const uri = this.normalizeUri(model.uri.toString());
            const edits = await this.sendLspRequest(
              'textDocument/formatting',
              {
                textDocument: { uri },
                options: {
                  tabSize: options.tabSize,
                  insertSpaces: options.insertSpaces,
                },
              },
              3000, token
            );

            if (Array.isArray(edits)) {
              return edits.map((edit: any) => ({
                range: {
                  startLineNumber: edit.range.start.line + 1,
                  startColumn: edit.range.start.character + 1,
                  endLineNumber: edit.range.end.line + 1,
                  endColumn: edit.range.end.character + 1,
                },
                text: edit.newText,
              }));
            }
          } catch (e) {
            if (isLspCancellation(e) || token.isCancellationRequested) return [];
            console.warn('[ClangdService] LSP formatting failed:', e);
          }
        }
        return [];
      },
    });

    // 5. Definition Provider
    const definitionProvider = monaco.languages.registerDefinitionProvider('cpp', {
      provideDefinition: async (model, position, token) => {
        if (token.isCancellationRequested || this.inComment(model, position)) return null;
        if (this.isLspConnected && this.clangdSession) {
          try {
            const uri = this.normalizeUri(model.uri.toString());
            const response = await this.sendLspRequest(
              'textDocument/definition',
              {
                textDocument: { uri },
                position: {
                  line: position.lineNumber - 1,
                  character: position.column - 1,
                },
              },
              1600, token
            );

            if (response) {
              const locs = Array.isArray(response) ? response : [response];
              return locs.map((loc: any) => ({
                uri: monaco.Uri.parse(loc.uri),
                range: {
                  startLineNumber: loc.range.start.line + 1,
                  startColumn: loc.range.start.character + 1,
                  endLineNumber: loc.range.end.line + 1,
                  endColumn: loc.range.end.character + 1,
                },
              }));
            }
          } catch (e) {
            if (isLspCancellation(e) || token.isCancellationRequested) return null;
            console.warn('[ClangdService] LSP definition failed:', e);
          }
        }
        return null;
      },
    });

    this.disposables.push(
      completionProvider,
      hoverProvider,
      signatureHelpProvider,
      formattingProvider,
      definitionProvider
    );
  }

  private convertLspCompletionItems(
    rawItems: any[],
    model: monaco.editor.ITextModel,
    position: monaco.Position,
    defaultRange: monaco.IRange
  ): monaco.languages.CompletionItem[] {
    return rawItems.map((item: any, idx: number) => {
      let range: monaco.IRange = defaultRange;
      let insertText = item.insertText || item.label;

      if (item.textEdit) {
        if ('range' in item.textEdit) {
          const r = item.textEdit.range;
          range = {
            startLineNumber: r.start.line + 1,
            startColumn: r.start.character + 1,
            endLineNumber: r.end.line + 1,
            endColumn: r.end.character + 1,
          };
          insertText = item.textEdit.newText;
        } else if ('insert' in item.textEdit) {
          const r = item.textEdit.insert;
          range = {
            startLineNumber: r.start.line + 1,
            startColumn: r.start.character + 1,
            endLineNumber: r.end.line + 1,
            endColumn: r.end.character + 1,
          };
          insertText = item.textEdit.newText;
        }
      }

      const isSnippet = item.insertTextFormat === 2;

      let docValue: string | monaco.IMarkdownString | undefined;
      if (typeof item.documentation === 'object' && item.documentation !== null) {
        docValue = { value: item.documentation.value || '' };
      } else if (typeof item.documentation === 'string') {
        docValue = item.documentation;
      }

      let additionalTextEdits: monaco.editor.ISingleEditOperation[] | undefined;
      if (Array.isArray(item.additionalTextEdits)) {
        additionalTextEdits = item.additionalTextEdits.map((e: any) => ({
          range: {
            startLineNumber: e.range.start.line + 1,
            startColumn: e.range.start.character + 1,
            endLineNumber: e.range.end.line + 1,
            endColumn: e.range.end.character + 1,
          },
          text: e.newText,
        }));
      }

      const monacoKind =
        (item.kind && LSP_TO_MONACO_KIND_MAP[item.kind]) || monaco.languages.CompletionItemKind.Property;

      return {
        label: item.label,
        kind: monacoKind,
        detail: item.detail,
        documentation: docValue,
        sortText: item.sortText || String(idx).padStart(5, '0'),
        filterText: item.filterText || (typeof item.label === 'string' ? item.label.split('(')[0] : undefined),
        insertText,
        insertTextRules: isSnippet
          ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
          : undefined,
        range,
        additionalTextEdits,
      };
    });
  }

  private getEnhancedFallbackCompletions(
    model: monaco.editor.ITextModel,
    position: monaco.Position,
    range: monaco.IRange,
    textUntilPosition: string,
    lineContent: string
  ): monaco.languages.CompletionItem[] {
    const isInclude = lineContent.trimStart().startsWith('#include');
    if (isInclude) {
      return this.getIncludeSuggestions(range);
    }

    const isStd = /\bstd::\w*$/.test(textUntilPosition);
    if (isStd) {
      return this.getStdSuggestions(range, true);
    }

    // Dot or Arrow Member Access: obj. or ptr->
    const memberMatch = textUntilPosition.match(/([a-zA-Z0-9_]+)(?:\.|\->)$/);
    if (memberMatch) {
      const varName = memberMatch[1];
      return this.getMemberSuggestions(varName, model, range);
    }

    // General suggestions
    const userSymbols = this.extractSymbolsFromDocument(model, range);
    const generalSuggestions = this.getGeneralCppSuggestions(range);
    // Detect whether std is qualified in scope to pass correct prefix mode to snippets
    const before = this.lexical(model).symbols.slice(0, model.getOffsetAt(position));
    const hasUsingNamespaceStd = /\busing\s+namespace\s+std\s*;/.test(before);
    const snippetSuggestions = this.getSnippetSuggestions(range, !hasUsingNamespaceStd);

    return [...this.visibleStd(model, position, range), ...snippetSuggestions, ...userSymbols, ...generalSuggestions];
  }

  private getMemberSuggestions(
    varName: string,
    model: monaco.editor.ITextModel,
    range: monaco.IRange
  ): monaco.languages.CompletionItem[] {
    const code = this.lexical(model).symbols;
    let detectedType = '';

    const varDeclRegex = new RegExp(`\\b([a-zA-Z0-9_<>:]+)\\s+${varName}\\b`, 'g');
    let m;
    while ((m = varDeclRegex.exec(code)) !== null) {
      detectedType = m[1];
    }

    const isVector = detectedType.includes('vector') || varName.endsWith('vec') || varName.endsWith('list');
    const isString = detectedType.includes('string') || varName.endsWith('str') || varName.endsWith('s');
    const isMap = detectedType.includes('map') || varName.endsWith('map');
    const isPair = detectedType.includes('pair');

    const suggestions: monaco.languages.CompletionItem[] = [];

    if (isVector) {
      const vecMethods = [
        { name: 'size()', insert: 'size()', detail: 'size_t size() const noexcept' },
        { name: 'empty()', insert: 'empty()', detail: 'bool empty() const noexcept' },
        { name: 'push_back(...)', insert: 'push_back(${1:val});', detail: 'void push_back(const T& value)' },
        { name: 'emplace_back(...)', insert: 'emplace_back(${1:args});', detail: 'decltype(auto) emplace_back(Args&&... args)' },
        { name: 'pop_back()', insert: 'pop_back();', detail: 'void pop_back()' },
        { name: 'clear()', insert: 'clear();', detail: 'void clear() noexcept' },
        { name: 'begin()', insert: 'begin()', detail: 'iterator begin() noexcept' },
        { name: 'end()', insert: 'end()', detail: 'iterator end() noexcept' },
        { name: 'front()', insert: 'front()', detail: 'reference front()' },
        { name: 'back()', insert: 'back()', detail: 'reference back()' },
        { name: 'resize(...)', insert: 'resize(${1:count});', detail: 'void resize(size_type count)' },
        { name: 'data()', insert: 'data()', detail: 'T* data() noexcept' },
      ];
      vecMethods.forEach((m) => {
        suggestions.push({
          label: m.name,
          kind: monaco.languages.CompletionItemKind.Method,
          detail: m.detail,
          insertText: m.insert,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          range,
        });
      });
    } else if (isString) {
      const strMethods = [
        { name: 'length()', insert: 'length()', detail: 'size_t length() const noexcept' },
        { name: 'size()', insert: 'size()', detail: 'size_t size() const noexcept' },
        { name: 'substr(...)', insert: 'substr(${1:pos}, ${2:count})', detail: 'string substr(size_t pos = 0, size_t count = npos) const' },
        { name: 'find(...)', insert: 'find(${1:str})', detail: 'size_t find(const string& str, size_t pos = 0) const' },
        { name: 'c_str()', insert: 'c_str()', detail: 'const char* c_str() const noexcept' },
        { name: 'empty()', insert: 'empty()', detail: 'bool empty() const noexcept' },
        { name: 'push_back(...)', insert: 'push_back(${1:ch});', detail: 'void push_back(CharT ch)' },
        { name: 'clear()', insert: 'clear();', detail: 'void clear() noexcept' },
        { name: 'starts_with(...)', insert: 'starts_with(${1:str})', detail: 'bool starts_with(string_view x) const noexcept' },
        { name: 'ends_with(...)', insert: 'ends_with(${1:str})', detail: 'bool ends_with(string_view x) const noexcept' },
      ];
      strMethods.forEach((m) => {
        suggestions.push({
          label: m.name,
          kind: monaco.languages.CompletionItemKind.Method,
          detail: m.detail,
          insertText: m.insert,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          range,
        });
      });
    } else if (isPair) {
      suggestions.push(
        { label: 'first', kind: monaco.languages.CompletionItemKind.Field, detail: 'T1 first', insertText: 'first', range },
        { label: 'second', kind: monaco.languages.CompletionItemKind.Field, detail: 'T2 second', insertText: 'second', range }
      );
    } else {
      // General container member methods
      const common = [
        { name: 'size()', insert: 'size()', detail: 'size_t size() const' },
        { name: 'empty()', insert: 'empty()', detail: 'bool empty() const' },
        { name: 'clear()', insert: 'clear();', detail: 'void clear()' },
        { name: 'begin()', insert: 'begin()', detail: 'iterator begin()' },
        { name: 'end()', insert: 'end()', detail: 'iterator end()' },
      ];
      common.forEach((m) => {
        suggestions.push({
          label: m.name,
          kind: monaco.languages.CompletionItemKind.Method,
          detail: m.detail,
          insertText: m.insert,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          range,
        });
      });
    }

    return suggestions;
  }

  private extractSymbolsFromDocument(
    model: monaco.editor.ITextModel,
    range: monaco.IRange
  ): monaco.languages.CompletionItem[] {
    const code = this.lexical(model).symbols;
    const suggestions: monaco.languages.CompletionItem[] = [];
    const seen = new Set<string>();

    // 1. Functions: void foo(int a), int calculateSum(...)
    const funcRegex = /\b([a-zA-Z_][a-zA-Z0-9_<>:]*)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(([^)]*)\)\s*(?:\{|;)/g;
    let m;
    while ((m = funcRegex.exec(code)) !== null) {
      const returnType = m[1];
      const name = m[2];
      const params = m[3];
      if (!seen.has(name) && !['if', 'while', 'for', 'switch', 'catch'].includes(name)) {
        seen.add(name);
        suggestions.push({
          label: name,
          kind: monaco.languages.CompletionItemKind.Function,
          detail: `${returnType} ${name}(${params})`,
          documentation: `User defined function: \`${returnType} ${name}(${params})\``,
          insertText: `${name}($0)`,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          range,
        });
      }
    }

    // 2. Classes & Structs: class Calculator, struct Point
    const classRegex = /\b(class|struct)\s+([a-zA-Z_][a-zA-Z0-9_]*)/g;
    while ((m = classRegex.exec(code)) !== null) {
      const kind = m[1];
      const name = m[2];
      if (!seen.has(name)) {
        seen.add(name);
        suggestions.push({
          label: name,
          kind: kind === 'class' ? monaco.languages.CompletionItemKind.Class : monaco.languages.CompletionItemKind.Struct,
          detail: `${kind} ${name}`,
          documentation: `User defined ${kind}`,
          insertText: name,
          range,
        });
      }
    }

    // 3. Variables: int count = 0;
    const varRegex = /\b(?:int|double|float|bool|char|auto|std::string|std::vector<[^>]+>)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:=|;|,)/g;
    while ((m = varRegex.exec(code)) !== null) {
      const name = m[1];
      if (!seen.has(name)) {
        seen.add(name);
        suggestions.push({
          label: name,
          kind: monaco.languages.CompletionItemKind.Variable,
          detail: `Local variable: ${name}`,
          insertText: name,
          range,
        });
      }
    }

    return suggestions;
  }

  private getIncludeSuggestions(range: monaco.IRange): monaco.languages.CompletionItem[] {
    const headers = [
      'bits/stdc++.h',
      'iostream', 'vector', 'string', 'algorithm', 'map', 'unordered_map',
      'set', 'unordered_set', 'memory', 'cmath', 'cstdio', 'cstdlib',
      'cstring', 'chrono', 'thread', 'mutex', 'future', 'functional',
      'queue', 'stack', 'deque', 'array', 'tuple', 'utility', 'numeric',
      'fstream', 'sstream', 'iomanip', 'iterator', 'optional', 'variant',
      'span', 'ranges', 'format', 'regex', 'stdexcept', 'cassert'
    ];

    return headers.map((h) => ({
      label: `<${h}>`,
      kind: monaco.languages.CompletionItemKind.Module,
      detail: h === 'bits/stdc++.h' ? 'Universal C++ Header <bits/stdc++.h> (All Standard Headers)' : `C++ Standard Library Header <${h}>`,
      insertText: `<${h}>`,
      range,
    }));
  }

  private getStdSuggestions(range: monaco.IRange, qualified = true): monaco.languages.CompletionItem[] {
    // When `using namespace std;` is in scope, completions should NOT add `std::` prefix.
    // When accessed via `std::`, or when no using-declaration exists, prefix with `std::`.
    // Note: snippet placeholders like ${1:vec} must not be confused with template literal interpolation.
    const p = qualified ? 'std::' : '';
    const items: Array<{ name: string; kind: monaco.languages.CompletionItemKind; detail: string; insert: string }> = [
      { name: 'cout', kind: monaco.languages.CompletionItemKind.Variable, detail: 'std::ostream cout', insert: p + 'cout << $0 << ' + p + 'endl;' },
      { name: 'cin', kind: monaco.languages.CompletionItemKind.Variable, detail: 'std::istream cin', insert: p + 'cin >> $0;' },
      { name: 'cerr', kind: monaco.languages.CompletionItemKind.Variable, detail: 'std::ostream cerr', insert: p + 'cerr << $0 << ' + p + 'endl;' },
      { name: 'endl', kind: monaco.languages.CompletionItemKind.Constant, detail: 'std::endl manipulator', insert: p + 'endl' },
      { name: 'vector', kind: monaco.languages.CompletionItemKind.Class, detail: 'std::vector<T>', insert: p + 'vector<${1:int}> ${2:vec};' },
      { name: 'string', kind: monaco.languages.CompletionItemKind.Class, detail: 'std::string', insert: p + 'string ${1:str};' },
      { name: 'map', kind: monaco.languages.CompletionItemKind.Class, detail: 'std::map<Key, Value>', insert: p + 'map<${1:string}, ${2:int}> ${3:map};' },
      { name: 'unordered_map', kind: monaco.languages.CompletionItemKind.Class, detail: 'std::unordered_map<Key, Value>', insert: p + 'unordered_map<${1:string}, ${2:int}> ${3:map};' },
      { name: 'set', kind: monaco.languages.CompletionItemKind.Class, detail: 'std::set<T>', insert: p + 'set<${1:int}> ${2:s};' },
      { name: 'sort', kind: monaco.languages.CompletionItemKind.Function, detail: 'void sort(RandomIt first, RandomIt last)', insert: p + 'sort(${1:vec}.begin(), ${1:vec}.end());' },
      { name: 'reverse', kind: monaco.languages.CompletionItemKind.Function, detail: 'void reverse(BidirIt first, BidirIt last)', insert: p + 'reverse(${1:vec}.begin(), ${1:vec}.end());' },
      { name: 'find', kind: monaco.languages.CompletionItemKind.Function, detail: 'InputIt find(InputIt first, InputIt last, const T& value)', insert: p + 'find(${1:vec}.begin(), ${1:vec}.end(), ${2:val});' },
      { name: 'binary_search', kind: monaco.languages.CompletionItemKind.Function, detail: 'bool binary_search(ForwardIt first, ForwardIt last, const T& value)', insert: p + 'binary_search(${1:vec}.begin(), ${1:vec}.end(), ${2:val})' },
      { name: 'lower_bound', kind: monaco.languages.CompletionItemKind.Function, detail: 'ForwardIt lower_bound(ForwardIt first, ForwardIt last, const T& value)', insert: p + 'lower_bound(${1:vec}.begin(), ${1:vec}.end(), ${2:val})' },
      { name: 'upper_bound', kind: monaco.languages.CompletionItemKind.Function, detail: 'ForwardIt upper_bound(ForwardIt first, ForwardIt last, const T& value)', insert: p + 'upper_bound(${1:vec}.begin(), ${1:vec}.end(), ${2:val})' },
      { name: 'make_unique', kind: monaco.languages.CompletionItemKind.Function, detail: 'std::unique_ptr<T> make_unique<T>(Args&&...)', insert: p + 'make_unique<${1:Type}>($0)' },
      { name: 'make_shared', kind: monaco.languages.CompletionItemKind.Function, detail: 'std::shared_ptr<T> make_shared<T>(Args&&...)', insert: p + 'make_shared<${1:Type}>($0)' },
      { name: 'unique_ptr', kind: monaco.languages.CompletionItemKind.Class, detail: 'std::unique_ptr<T>', insert: p + 'unique_ptr<${1:Type}>' },
      { name: 'shared_ptr', kind: monaco.languages.CompletionItemKind.Class, detail: 'std::shared_ptr<T>', insert: p + 'shared_ptr<${1:Type}>' },
      { name: 'pair', kind: monaco.languages.CompletionItemKind.Struct, detail: 'std::pair<T1, T2>', insert: p + 'pair<${1:int}, ${2:string}>' },
      { name: 'make_pair', kind: monaco.languages.CompletionItemKind.Function, detail: 'std::make_pair(x, y)', insert: p + 'make_pair(${1:x}, ${2:y})' },
      { name: 'max', kind: monaco.languages.CompletionItemKind.Function, detail: 'const T& max(const T& a, const T& b)', insert: p + 'max(${1:a}, ${2:b})' },
      { name: 'min', kind: monaco.languages.CompletionItemKind.Function, detail: 'const T& min(const T& a, const T& b)', insert: p + 'min(${1:a}, ${2:b})' },
      { name: 'swap', kind: monaco.languages.CompletionItemKind.Function, detail: 'void swap(T& a, T& b)', insert: p + 'swap(${1:a}, ${2:b});' },
      { name: 'clamp', kind: monaco.languages.CompletionItemKind.Function, detail: 'T clamp(T v, T lo, T hi)', insert: p + 'clamp(${1:val}, ${2:min}, ${3:max})' },
      { name: 'iota', kind: monaco.languages.CompletionItemKind.Function, detail: 'void iota(ForwardIt first, ForwardIt last, T value)', insert: p + 'iota(${1:vec}.begin(), ${1:vec}.end(), ${2:0});' },
    ];

    return items.map((item) => ({
      label: item.name,
      kind: item.kind,
      detail: item.detail,
      insertText: item.insert,
      insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
      range,
    }));
  }

  private getGeneralCppSuggestions(range: monaco.IRange): monaco.languages.CompletionItem[] {
    const keywords = [
      'int', 'char', 'float', 'double', 'bool', 'void', 'auto', 'const', 'constexpr',
      'static', 'struct', 'class', 'enum', 'union', 'namespace', 'template', 'typename',
      'using', 'typedef', 'public', 'private', 'protected', 'virtual', 'override', 'final',
      'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break',
      'continue', 'sizeof', 'new', 'delete', 'nullptr', 'true', 'false', 'this', 'throw',
      'try', 'catch', 'noexcept', 'decltype', 'explicit', 'friend', 'inline'
    ];

    return keywords.map((kw) => ({
      label: kw,
      kind: monaco.languages.CompletionItemKind.Keyword,
      insertText: kw,
      range,
    }));
  }

  private getSnippetSuggestions(range: monaco.IRange, qualified = true): monaco.languages.CompletionItem[] {
    const p = qualified ? 'std::' : '';
    const snippets: Array<{ label: string; detail: string; insert: string }> = [
      {
        label: 'main',
        detail: 'int main(int argc, char* argv[])',
        insert: 'int main() {\n\t${1:std::cout << "Hello, World!" << std::endl;}\n\treturn 0;\n}',
      },
      {
        label: 'for',
        detail: 'for loop with index',
        insert: 'for (int ${1:i} = 0; ${1:i} < ${2:n}; ++${1:i}) {\n\t$0\n}',
      },
      {
        label: 'foreach',
        detail: 'range-based for loop',
        insert: 'for (const auto& ${1:item} : ${2:container}) {\n\t$0\n}',
      },
      {
        label: 'if',
        detail: 'if condition statement',
        insert: 'if (${1:condition}) {\n\t$0\n}',
      },
      {
        label: 'ifelse',
        detail: 'if-else condition statement',
        insert: 'if (${1:condition}) {\n\t${2}\n} else {\n\t$0\n}',
      },
      {
        label: 'while',
        detail: 'while loop',
        insert: 'while (${1:condition}) {\n\t$0\n}',
      },
      {
        label: 'class',
        detail: 'C++ class definition',
        insert: 'class ${1:ClassName} {\npublic:\n\t${1:ClassName}();\n\t~${1:ClassName}();\n\nprivate:\n\t$0\n};',
      },
      {
        label: 'struct',
        detail: 'C++ struct definition',
        insert: 'struct ${1:StructName} {\n\t$0\n};',
      },
      {
        label: 'template',
        detail: 'template <typename T>',
        insert: 'template <typename ${1:T}>\n$0',
      },
      {
        label: 'trycatch',
        detail: 'try-catch block',
        insert: 'try {\n\t${1}\n} catch (const ' + p + 'exception& ${2:e}) {\n\t' + p + 'cerr << ${2:e}.what() << ' + p + 'endl;\n}',
      },
      {
        label: 'cout',
        detail: p + 'cout << ... << ' + p + 'endl',
        insert: p + 'cout << ${1:"message"} << ' + p + 'endl;',
      },
      {
        label: 'cin',
        detail: p + 'cin >> variable',
        insert: p + 'cin >> ${1:var};',
      },
      {
        label: 'lambda',
        detail: '[&](...) -> ... { ... }',
        insert: '[${1:&}](${2:args}) {\n\t$0\n}',
      },
    ];

    return snippets.map((s) => ({
      label: s.label,
      kind: monaco.languages.CompletionItemKind.Snippet,
      detail: s.detail,
      insertText: s.insert,
      insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
      range,
    }));
  }

  private getCppSymbolDocumentation(symbol: string): { signature: string; description: string } | null {
    const docs: Record<string, { signature: string; description: string }> = {
      cout: { signature: 'extern std::ostream cout;', description: 'Standard output stream object for writing formatted text to console.' },
      cin: { signature: 'extern std::istream cin;', description: 'Standard input stream object for reading data from keyboard/console.' },
      endl: { signature: 'template <class CharT, class Traits>\nstd::basic_ostream<CharT, Traits>& endl(std::basic_ostream<CharT, Traits>& os);', description: 'Inserts a newline character into the output stream and flushes the stream.' },
      vector: { signature: 'template<class T, class Allocator = std::allocator<T>> class vector;', description: 'A sequence container that encapsulates dynamic size arrays with contiguous storage.' },
      string: { signature: 'typedef std::basic_string<char> string;', description: 'Standard C++ character string container representing a sequence of characters.' },
      map: { signature: 'template<class Key, class T, class Compare = std::less<Key>> class map;', description: 'Sorted associative container that contains key-value pairs with unique keys (Red-Black Tree).' },
      sort: { signature: 'template<class RandomIt> void sort(RandomIt first, RandomIt last);', description: 'Sorts the elements in the range [first, last) into ascending order (O(N log N)).' },
      accumulate: { signature: 'template<class InputIt, class T> T accumulate(InputIt first, InputIt last, T init);', description: 'Computes the sum of the given value init and the elements in the range [first, last).' },
    };

    return docs[symbol] || null;
  }

  private getFunctionSignature(funcName: string): monaco.languages.SignatureInformation | null {
    const signatures: Record<string, monaco.languages.SignatureInformation> = {
      sort: {
        label: 'sort(first, last, [comp])',
        documentation: 'Sorts elements in the range [first, last)',
        parameters: [
          { label: 'first', documentation: 'Random-access iterator to beginning of range' },
          { label: 'last', documentation: 'Random-access iterator to end of range' },
          { label: 'comp', documentation: 'Optional comparison function' },
        ],
      },
      calculateSum: {
        label: 'calculateSum(const std::vector<int>& values)',
        documentation: 'Calculates the sum of all elements in the vector',
        parameters: [
          { label: 'values', documentation: 'Constant reference to std::vector<int>' },
        ],
      },
      factorial: {
        label: 'factorial(int n)',
        documentation: 'Calculates the factorial of an integer n (n!)',
        parameters: [
          { label: 'n', documentation: 'The non-negative integer' },
        ],
      },
    };

    return signatures[funcName] || null;
  }

  public dispose(): void {
    this.resetWorkspace();
    this.disposables.forEach((disposable) => disposable.dispose()); this.disposables = [];
  }
}
