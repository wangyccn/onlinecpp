import * as monaco from 'monaco-editor';
import { openClangdSession, ClangdSession } from '@algoproclub/clangd-wasm';
import { isClangdWasmSupported } from '@algoproclub/clangd-wasm/support';
import { DiagnosticItem } from '../types';

export class ClangdService {
  private clangdSession: ClangdSession | null = null;
  private isLspSupported = false;
  private isLspConnected = false;
  private activeUri = '';
  private onDiagnosticsCallbacks: Array<(items: DiagnosticItem[]) => void> = [];
  private disposables: monaco.IDisposable[] = [];

  constructor() {
    this.checkSupport();
    this.registerFallbackProviders();
  }

  private checkSupport(): void {
    try {
      // In Vite dev mode, Vite's dev server injects client HMR scripts into module SharedWorkers,
      // which causes Chrome to fail worker instantiation with 'Failed to fetch a worker script'.
      // Therefore in dev mode we directly activate the high-performance built-in C++20 AST Engine.
      // In production builds, the SharedWorker is cleanly bundled without HMR.
      if (import.meta.env.DEV) {
        console.info('[ClangdService] Dev mode: using built-in C++20 AST Engine (zero network/worker overhead)');
        this.isLspSupported = false;
        return;
      }
      this.isLspSupported = isClangdWasmSupported();
      console.log('[ClangdService] WASM JSPI LSP Supported:', this.isLspSupported);
    } catch (e) {
      console.warn('[ClangdService] Clangd support check failed:', e);
      this.isLspSupported = false;
    }
  }

  public getStatusText(): { label: string; details: string; isLsp: boolean } {
    if (this.isLspConnected) {
      return {
        label: 'clangd WASM (LSP)',
        details: 'Connected to WebAssembly Clangd Language Server',
        isLsp: true,
      };
    }
    if (this.isLspSupported) {
      return {
        label: 'clangd WASM (Standby)',
        details: 'Clangd WASM is supported and initializing',
        isLsp: true,
      };
    }
    return {
      label: 'C++ IntelliSense (AST Engine)',
      details: 'Enhanced in-browser C++ intelligence with syntax & STL analysis',
      isLsp: false,
    };
  }

  public onDiagnostics(callback: (items: DiagnosticItem[]) => void): () => void {
    this.onDiagnosticsCallbacks.push(callback);
    return () => {
      this.onDiagnosticsCallbacks = this.onDiagnosticsCallbacks.filter((cb) => cb !== callback);
    };
  }

  public async attachDocument(uri: string, initialCode: string): Promise<void> {
    this.activeUri = uri;

    if (!this.isLspSupported) {
      return;
    }

    try {
      if (this.clangdSession) {
        this.clangdSession.dispose();
        this.clangdSession = null;
      }

      this.clangdSession = await openClangdSession({
        uri,
        compilerArguments: [
          '-std=c++20',
          '-I/include/c++/v1',
          '-Wno-register',
          '-Wno-deprecated-register',
          '-Wno-shift-op-parentheses',
        ],
      });

      this.isLspConnected = true;
      console.log('[ClangdService] Clangd session opened for:', uri);

      // Listen for LSP messages on port
      this.clangdSession.port.onmessage = (event) => {
        const msg = event.data;
        if (msg && msg.method === 'textDocument/publishDiagnostics') {
          this.handleLspDiagnostics(msg.params);
        }
      };

      // Send didOpen notification
      this.sendLspNotification('textDocument/didOpen', {
        textDocument: {
          uri,
          languageId: 'cpp',
          version: 1,
          text: initialCode,
        },
      });
    } catch (err) {
      console.warn('[ClangdService] Failed to establish clangd WASM session, falling back to AST engine:', err);
      this.isLspConnected = false;
      this.isLspSupported = false;
    }
  }

  public updateDocument(uri: string, newText: string, version: number): void {
    if (this.isLspConnected && this.clangdSession) {
      this.sendLspNotification('textDocument/didChange', {
        textDocument: { uri, version },
        contentChanges: [{ text: newText }],
      });
    }
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

  private handleLspDiagnostics(params: any): void {
    if (!params || !params.diagnostics) return;

    const items: DiagnosticItem[] = params.diagnostics.map((d: any) => ({
      file: params.uri.replace(/^file:\/\//, ''),
      line: (d.range?.start?.line ?? 0) + 1,
      column: (d.range?.start?.character ?? 0) + 1,
      message: d.message,
      severity: d.severity === 1 ? 'error' : d.severity === 2 ? 'warning' : 'info',
    }));

    for (const cb of this.onDiagnosticsCallbacks) {
      cb(items);
    }
  }

  public updateMarkersFromCompilerOutput(model: monaco.editor.ITextModel, compilerOutput: string): DiagnosticItem[] {
    const diagnostics: DiagnosticItem[] = [];
    const markers: monaco.editor.IMarkerData[] = [];

    // Parse lines like: main.cpp:12:5: error: expected ';' before 'return'
    const errorRegex = /([^:\n\r]+):(\d+):(\d+):\s+(fatal error|error|warning|note):\s+(.*)/gi;
    let match;

    while ((match = errorRegex.exec(compilerOutput)) !== null) {
      const file = match[1].trim();
      const line = parseInt(match[2], 10);
      const col = parseInt(match[3], 10);
      const type = match[4].toLowerCase();
      const message = match[5].trim();

      const severity =
        type.includes('error') ? monaco.MarkerSeverity.Error :
        type.includes('warning') ? monaco.MarkerSeverity.Warning :
        monaco.MarkerSeverity.Info;

      const diagSeverity: 'error' | 'warning' | 'info' =
        type.includes('error') ? 'error' :
        type.includes('warning') ? 'warning' : 'info';

      diagnostics.push({
        file,
        line,
        column: col,
        message,
        severity: diagSeverity,
      });

      // Find token length at that line if possible
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
      });
    }

    monaco.editor.setModelMarkers(model, 'cpp-compiler', markers);

    for (const cb of this.onDiagnosticsCallbacks) {
      cb(diagnostics);
    }

    return diagnostics;
  }

  public clearMarkers(model: monaco.editor.ITextModel): void {
    monaco.editor.setModelMarkers(model, 'cpp-compiler', []);
    for (const cb of this.onDiagnosticsCallbacks) {
      cb([]);
    }
  }

  private registerFallbackProviders(): void {
    // 1. Completion Provider
    const completionProvider = monaco.languages.registerCompletionItemProvider('cpp', {
      triggerCharacters: ['.', ':', '>', '<', '#', '"'],
      provideCompletionItems: (model, position) => {
        const textUntilPosition = model.getValueInRange({
          startLineNumber: 1,
          startColumn: 1,
          endLineNumber: position.lineNumber,
          endColumn: position.column,
        });

        const word = model.getWordUntilPosition(position);
        const range = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        };

        const lineContent = model.getLineContent(position.lineNumber);
        const isInclude = lineContent.trimStart().startsWith('#include');

        if (isInclude) {
          return {
            suggestions: this.getIncludeSuggestions(range),
          };
        }

        const isStd = textUntilPosition.endsWith('std::') || lineContent.substring(0, position.column - 1).endsWith('std::');
        if (isStd) {
          return {
            suggestions: this.getStdSuggestions(range),
          };
        }

        // Combine keywords, STL, user symbols, snippets
        const userSymbols = this.extractSymbolsFromDocument(model, range);
        const generalSuggestions = this.getGeneralCppSuggestions(range);
        const snippetSuggestions = this.getSnippetSuggestions(range);

        return {
          suggestions: [...snippetSuggestions, ...userSymbols, ...generalSuggestions],
        };
      },
    });

    // 2. Hover Provider
    const hoverProvider = monaco.languages.registerHoverProvider('cpp', {
      provideHover: (model, position) => {
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

    // 3. Signature Help Provider
    const signatureHelpProvider = monaco.languages.registerSignatureHelpProvider('cpp', {
      signatureHelpTriggerCharacters: ['(', ','],
      provideSignatureHelp: (model, position) => {
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

    this.disposables.push(completionProvider, hoverProvider, signatureHelpProvider);
  }

  private extractSymbolsFromDocument(model: monaco.editor.ITextModel, range: monaco.IRange): monaco.languages.CompletionItem[] {
    const code = model.getValue();
    const suggestions: monaco.languages.CompletionItem[] = [];
    const seen = new Set<string>();

    // 1. Functions: void foo(int a), int calculateSum(...)
    const funcRegex = /\b([a-zA-Z_][a-zA-Z0-9_<>:]*)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(([^)]*)\)\s*(?:\{|;)/g;
    let m;
    while ((m = funcRegex.exec(code)) !== null) {
      const returnType = m[1];
      const name = m[2];
      const params = m[3];
      if (!seen.has(name) && name !== 'if' && name !== 'while' && name !== 'for' && name !== 'switch') {
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

  private getStdSuggestions(range: monaco.IRange): monaco.languages.CompletionItem[] {
    const items = [
      { name: 'cout', kind: monaco.languages.CompletionItemKind.Variable, detail: 'std::ostream cout', insert: 'cout << $0 << std::endl;' },
      { name: 'cin', kind: monaco.languages.CompletionItemKind.Variable, detail: 'std::istream cin', insert: 'cin >> $0;' },
      { name: 'cerr', kind: monaco.languages.CompletionItemKind.Variable, detail: 'std::ostream cerr', insert: 'cerr << $0 << std::endl;' },
      { name: 'endl', kind: monaco.languages.CompletionItemKind.Constant, detail: 'std::endl manipulator', insert: 'endl' },
      { name: 'vector', kind: monaco.languages.CompletionItemKind.Class, detail: 'std::vector<T>', insert: 'vector<${1:int}> ${2:vec};' },
      { name: 'string', kind: monaco.languages.CompletionItemKind.Class, detail: 'std::string', insert: 'string ${1:str};' },
      { name: 'map', kind: monaco.languages.CompletionItemKind.Class, detail: 'std::map<Key, Value>', insert: 'map<${1:string}, ${2:int}> ${3:map};' },
      { name: 'unordered_map', kind: monaco.languages.CompletionItemKind.Class, detail: 'std::unordered_map<Key, Value>', insert: 'unordered_map<${1:string}, ${2:int}> ${3:map};' },
      { name: 'sort', kind: monaco.languages.CompletionItemKind.Function, detail: 'void sort(RandomIt first, RandomIt last)', insert: 'sort(${1:vec}.begin(), ${1:vec}.end());' },
      { name: 'find', kind: monaco.languages.CompletionItemKind.Function, detail: 'InputIt find(InputIt first, InputIt last, const T& value)', insert: 'find(${1:vec}.begin(), ${1:vec}.end(), ${2:val});' },
      { name: 'make_unique', kind: monaco.languages.CompletionItemKind.Function, detail: 'std::unique_ptr<T> make_unique<T>(Args&&...)', insert: 'make_unique<${1:Type}>($0)' },
      { name: 'make_shared', kind: monaco.languages.CompletionItemKind.Function, detail: 'std::shared_ptr<T> make_shared<T>(Args&&...)', insert: 'make_shared<${1:Type}>($0)' },
      { name: 'unique_ptr', kind: monaco.languages.CompletionItemKind.Class, detail: 'std::unique_ptr<T>', insert: 'unique_ptr<${1:Type}>' },
      { name: 'shared_ptr', kind: monaco.languages.CompletionItemKind.Class, detail: 'std::shared_ptr<T>', insert: 'shared_ptr<${1:Type}>' },
      { name: 'pair', kind: monaco.languages.CompletionItemKind.Struct, detail: 'std::pair<T1, T2>', insert: 'pair<${1:int}, ${2:string}>' },
      { name: 'make_pair', kind: monaco.languages.CompletionItemKind.Function, detail: 'std::make_pair(x, y)', insert: 'make_pair(${1:x}, ${2:y})' },
      { name: 'max', kind: monaco.languages.CompletionItemKind.Function, detail: 'const T& max(const T& a, const T& b)', insert: 'max(${1:a}, ${2:b})' },
      { name: 'min', kind: monaco.languages.CompletionItemKind.Function, detail: 'const T& min(const T& a, const T& b)', insert: 'min(${1:a}, ${2:b})' },
      { name: 'swap', kind: monaco.languages.CompletionItemKind.Function, detail: 'void swap(T& a, T& b)', insert: 'swap(${1:a}, ${2:b});' },
      { name: 'clamp', kind: monaco.languages.CompletionItemKind.Function, detail: 'T clamp(T v, T lo, T hi)', insert: 'clamp(${1:val}, ${2:min}, ${3:max})' },
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

  private getSnippetSuggestions(range: monaco.IRange): monaco.languages.CompletionItem[] {
    const snippets = [
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
        insert: 'try {\n\t${1}\n} catch (const std::exception& ${2:e}) {\n\tstd::cerr << ${2:e}.what() << std::endl;\n}',
      },
      {
        label: 'cout',
        detail: 'std::cout << ... << std::endl',
        insert: 'std::cout << ${1:"message"} << std::endl;',
      },
      {
        label: 'cin',
        detail: 'std::cin >> variable',
        insert: 'std::cin >> ${1:var};',
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
    if (this.clangdSession) {
      this.clangdSession.dispose();
      this.clangdSession = null;
    }
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
  }
}
