import { FileSystemService } from './fileSystem';
import { TerminalService } from './terminalService';
import { MonacoEditorService } from './monacoEditor';
import { EmceptionService } from './emceptionService';
import { ClangdService } from './clangdService';
import { md5 } from '../utils/md5';
import { FileItem } from '../types';

export interface ShellContext {
  fileSystem: FileSystemService;
  terminalService: TerminalService;
  editorService: MonacoEditorService;
  emceptionService: EmceptionService;
  clangdService: ClangdService;
  getSettings: () => any;
  saveSettings: (settings: any) => void;
  updateStatus: () => void;
  openFolderAction: () => Promise<void>;
  compileProject: () => Promise<void>;
  runProject: () => Promise<void>;
  runOnly?: () => Promise<void>;
  navigateRoute: (hash: string) => void;
}

interface CommandStream {
  stdin: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export class ShellService {
  private ctx: ShellContext;

  constructor(ctx: ShellContext) {
    this.ctx = ctx;
  }

  public resolvePath(inputPath: string): string {
    const cwd = this.ctx.terminalService.getCwd();
    const clean = inputPath.trim().replace(/^['"]|['"]$/g, '');
    if (!clean || clean === '.') return cwd;
    if (clean === '~' || clean === '/') return '';
    if (clean.startsWith('/workspace/')) return clean.slice('/workspace/'.length).replace(/^\/+/, '');
    if (clean.startsWith('/')) return clean.replace(/^\/+/, '');

    if (clean.startsWith('./')) {
      const sub = clean.slice(2);
      return cwd ? `${cwd}/${sub}` : sub;
    }

    if (clean.includes('..') || clean.includes('/')) {
      const base = cwd ? cwd.split('/').filter(Boolean) : [];
      const parts = clean.split('/').filter(Boolean);
      const resolved = [...base];
      for (const p of parts) {
        if (p === '.') continue;
        if (p === '..') {
          if (resolved.length > 0) resolved.pop();
        } else {
          resolved.push(p);
        }
      }
      return resolved.join('/');
    }

    return cwd ? `${cwd}/${clean}` : clean;
  }

  /**
   * Split a command line into pipeline stages while respecting single & double quotes.
   */
  public splitPipeline(commandLine: string): string[] {
    const stages: string[] = [];
    let cur = '';
    let inSingle = false;
    let inDouble = false;
    let escaped = false;

    for (let i = 0; i < commandLine.length; i++) {
      const c = commandLine[i];
      if (escaped) {
        cur += c;
        escaped = false;
      } else if (c === '\\') {
        cur += c;
        escaped = true;
      } else if (c === "'" && !inDouble) {
        inSingle = !inSingle;
        cur += c;
      } else if (c === '"' && !inSingle) {
        inDouble = !inDouble;
        cur += c;
      } else if (c === '|' && !inSingle && !inDouble) {
        stages.push(cur.trim());
        cur = '';
      } else {
        cur += c;
      }
    }
    if (cur.trim()) stages.push(cur.trim());
    return stages;
  }

  /**
   * Parse a single command string into argument tokens, respecting quotes.
   */
  public parseArguments(cmdStr: string): string[] {
    const args: string[] = [];
    let cur = '';
    let inSingle = false;
    let inDouble = false;
    let escaped = false;

    for (let i = 0; i < cmdStr.length; i++) {
      const c = cmdStr[i];
      if (escaped) {
        cur += c;
        escaped = false;
      } else if (c === '\\') {
        escaped = true;
      } else if (c === "'" && !inDouble) {
        inSingle = !inSingle;
      } else if (c === '"' && !inSingle) {
        inDouble = !inDouble;
      } else if (/\s/.test(c) && !inSingle && !inDouble) {
        if (cur.length > 0) {
          args.push(cur);
          cur = '';
        }
      } else {
        cur += c;
      }
    }
    if (cur.length > 0) {
      args.push(cur);
    }
    return args;
  }

  /**
   * Main entrypoint to execute a full command line with pipes and redirection.
   */
  public async executeCommandLine(rawCmd: string): Promise<void> {
    const trimmed = rawCmd.trim();
    if (!trimmed) return;

    // Check for output redirection ('>' or '>>') at the very end of the pipeline
    let redirectFile = '';
    let isAppend = false;
    let cmdToRun = trimmed;

    // Detect redirection outside quotes
    let inSingle = false;
    let inDouble = false;
    let redirectIndex = -1;

    for (let i = 0; i < trimmed.length; i++) {
      const c = trimmed[i];
      if (c === "'" && !inDouble) inSingle = !inSingle;
      else if (c === '"' && !inSingle) inDouble = !inDouble;
      else if (c === '>' && !inSingle && !inDouble) {
        redirectIndex = i;
        if (i + 1 < trimmed.length && trimmed[i + 1] === '>') {
          isAppend = true;
          redirectIndex = i;
          redirectFile = trimmed.slice(i + 2).trim();
          cmdToRun = trimmed.slice(0, i).trim();
        } else {
          isAppend = false;
          redirectFile = trimmed.slice(i + 1).trim();
          cmdToRun = trimmed.slice(0, i).trim();
        }
        break;
      }
    }

    const stages = this.splitPipeline(cmdToRun);
    if (stages.length === 0) return;

    let currentStdin = '';

    for (let i = 0; i < stages.length; i++) {
      const stageCmd = stages[i];
      const isLastStage = i === stages.length - 1;
      let stageStdout = '';

      const stream: CommandStream = {
        stdin: currentStdin,
        stdout: (text: string) => {
          if (isLastStage) {
            if (redirectFile) {
              stageStdout += text;
            } else {
              this.ctx.terminalService.write(text.replace(/\r?\n/g, '\r\n'));
            }
          } else {
            stageStdout += text;
          }
        },
        stderr: (text: string) => {
          this.ctx.terminalService.writeLine(`\x1b[31m${text}\x1b[0m`);
        },
      };

      const tokens = this.parseArguments(stageCmd);
      if (tokens.length === 0) continue;

      const cmd = tokens[0];
      const args = tokens.slice(1);

      await this.dispatchCommand(cmd, args, stream);
      currentStdin = stageStdout;
    }

    // If redirection was requested for the final output:
    if (redirectFile && currentStdin) {
      const destPath = this.resolvePath(redirectFile);
      try {
        let contentToWrite = currentStdin;
        if (isAppend) {
          try {
            const existing = await this.ctx.fileSystem.readFile(destPath);
            contentToWrite = existing + currentStdin;
          } catch {
            contentToWrite = currentStdin;
          }
        }
        await this.ctx.fileSystem.writeFile(destPath, contentToWrite);
      } catch (err: any) {
        this.ctx.terminalService.writeLine(`\x1b[31mRedirection failed for '${redirectFile}': ${err.message}\x1b[0m`);
      }
    }
  }

  private async dispatchCommand(cmd: string, args: string[], stream: CommandStream): Promise<void> {
    switch (cmd.toLowerCase()) {
      case 'wget':
        await this.execWget(args, stream);
        break;

      case 'curl':
        await this.execCurl(args, stream);
        break;

      case 'sed':
        await this.execSed(args, stream);
        break;

      case 'rm':
      case 'del':
        await this.execRm(args, stream);
        break;

      case 'cp':
      case 'copy':
        await this.execCp(args, stream);
        break;

      case 'mv':
      case 'move':
        await this.execMv(args, stream);
        break;

      case 'ln':
        await this.execLn(args, stream);
        break;

      case 'file':
        await this.execFile(args, stream);
        break;

      case 'cat':
      case 'type':
        await this.execCat(args, stream);
        break;

      case 'wc':
        await this.execWc(args, stream);
        break;

      case 'md5sum':
      case 'md5':
        await this.execMd5sum(args, stream);
        break;

      case 'find':
        await this.execFind(args, stream);
        break;

      case 'grep':
        await this.execGrep(args, stream);
        break;

      case 'cd':
        await this.execCd(args, stream);
        break;

      case 'pwd':
        await this.execPwd(stream);
        break;

      case 'ls':
      case 'dir':
        await this.execLs(args, stream);
        break;

      case 'code':
      case 'open':
      case 'edit':
        await this.execCode(args, stream);
        break;

      case 'touch':
      case 'new':
        await this.execTouch(args, stream);
        break;

      case 'mkdir':
        await this.execMkdir(args, stream);
        break;

      case 'compile':
      case 'build':
        await this.execCompile(args, stream);
        break;

      case 'run':
        await this.execRun(args, stream);
        break;

      case 'mode':
        await this.execMode(args, stream);
        break;

      case 'clear':
      case 'cls':
        this.ctx.terminalService.clear();
        break;

      case 'echo':
        stream.stdout(args.join(' ') + '\n');
        break;

      case 'date':
      case 'time':
        stream.stdout(new Date().toLocaleString() + '\n');
        break;

      case 'info':
        this.execInfo(stream);
        break;

      case 'help':
        this.execHelp(stream);
        break;

      default:
        if (cmd.startsWith('./') && (cmd.endsWith('.wasm') || cmd.endsWith('.out'))) {
          const target = this.resolvePath(cmd.slice(2));
          await this.ctx.emceptionService.runWasmBinary(target);
          break;
        }
        stream.stderr(`Command not found: ${cmd}. Type "help" for a list of available commands.`);
    }
  }

  // =========================================================================
  // Command Implementations
  // =========================================================================

  private async execWget(args: string[], stream: CommandStream): Promise<void> {
    let outputName = '';
    let quiet = false;
    let url = '';

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '-O' && i + 1 < args.length) {
        outputName = args[++i];
      } else if (arg.startsWith('-O') && arg.length > 2) {
        outputName = arg.slice(2);
      } else if (arg === '-q' || arg === '--quiet') {
        quiet = true;
      } else if (!arg.startsWith('-')) {
        url = arg;
      }
    }

    if (!url) {
      stream.stderr('wget: missing URL\r\nUsage: wget [-O output_file] [-q] <URL>');
      return;
    }

    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url;
    }

    if (!outputName) {
      try {
        const parsed = new URL(url);
        outputName = parsed.pathname.split('/').filter(Boolean).pop() || 'index.html';
      } catch {
        outputName = 'index.html';
      }
    }

    const destPath = this.resolvePath(outputName);

    if (!quiet) {
      stream.stdout(`--${new Date().toISOString().replace('T', ' ').slice(0, 19)}--  ${url}\r\n`);
      stream.stdout(`Connecting to host... awaiting response...\r\n`);
    }

    try {
      const res = await fetch(url);
      if (!res.ok) {
        stream.stderr(`wget: server returned error: HTTP ${res.status} ${res.statusText}`);
        return;
      }
      const buf = await res.arrayBuffer();
      const bytes = new Uint8Array(buf);
      await this.ctx.fileSystem.writeBinaryFile(destPath, bytes);

      const szStr = (bytes.length / 1024).toFixed(1) + ' KB';
      if (!quiet) {
        stream.stdout(`\x1b[32mHTTP 200 OK (${szStr})\x1b[0m\r\n`);
        stream.stdout(`\x1b[32mSaved [${bytes.length} bytes] -> "${destPath}"\x1b[0m\r\n`);
      }
    } catch (err: any) {
      stream.stderr(`wget: failed to download "${url}": ${err.message || String(err)}`);
      stream.stdout(`\x1b[33m[Notice] Browser CORS restrictions may block cross-origin requests. Use URLs with CORS enabled (e.g. raw.githubusercontent.com, cdn.jsdelivr.net, unpkg.com).\x1b[0m\r\n`);
    }
  }

  private async execCurl(args: string[], stream: CommandStream): Promise<void> {
    let outputName = '';
    let silent = false;
    let headOnly = false;
    let method = 'GET';
    let bodyData: string | undefined = undefined;
    const headers: Record<string, string> = {};
    let url = '';

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '-o' && i + 1 < args.length) {
        outputName = args[++i];
      } else if (arg === '-O') {
        outputName = '__REMOTE__';
      } else if (arg === '-s' || arg === '--silent') {
        silent = true;
      } else if (arg === '-I' || arg === '--head') {
        headOnly = true;
        method = 'HEAD';
      } else if (arg === '-X' && i + 1 < args.length) {
        method = args[++i].toUpperCase();
      } else if (arg === '-d' && i + 1 < args.length) {
        bodyData = args[++i];
        if (method === 'GET') method = 'POST';
      } else if (arg === '-H' && i + 1 < args.length) {
        const h = args[++i];
        const colon = h.indexOf(':');
        if (colon > 0) {
          headers[h.slice(0, colon).trim()] = h.slice(colon + 1).trim();
        }
      } else if (!arg.startsWith('-')) {
        url = arg;
      }
    }

    if (!url) {
      stream.stderr('curl: no URL specified!\r\nUsage: curl [-o output_file] [-s] [-I] [-X METHOD] <URL>');
      return;
    }

    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url;
    }

    if (outputName === '__REMOTE__') {
      try {
        const parsed = new URL(url);
        outputName = parsed.pathname.split('/').filter(Boolean).pop() || 'index.html';
      } catch {
        outputName = 'index.html';
      }
    }

    try {
      const reqOptions: RequestInit = {
        method,
        headers,
        body: bodyData,
      };
      const res = await fetch(url, reqOptions);

      if (headOnly) {
        let headerStr = `HTTP/1.1 ${res.status} ${res.statusText}\r\n`;
        res.headers.forEach((val, key) => {
          headerStr += `${key}: ${val}\r\n`;
        });
        stream.stdout(headerStr);
        return;
      }

      if (outputName) {
        const destPath = this.resolvePath(outputName);
        const buf = await res.arrayBuffer();
        const bytes = new Uint8Array(buf);
        await this.ctx.fileSystem.writeBinaryFile(destPath, bytes);
        if (!silent) {
          stream.stdout(`\x1b[32m[curl] Saved ${bytes.length} bytes -> "${destPath}"\x1b[0m\r\n`);
        }
      } else {
        const text = await res.text();
        stream.stdout(text);
        if (!text.endsWith('\n')) {
          stream.stdout('\r\n');
        }
      }
    } catch (err: any) {
      if (!silent) {
        stream.stderr(`curl: (7) Failed to connect / fetch "${url}": ${err.message || String(err)}`);
        stream.stdout(`\x1b[33m[Notice] Browser CORS restrictions may block cross-origin requests to this URL.\x1b[0m\r\n`);
      }
    }
  }

  private async execSed(args: string[], stream: CommandStream): Promise<void> {
    let inPlace = false;
    let script = '';
    const files: string[] = [];

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '-i' || arg.startsWith('-i=')) {
        inPlace = true;
      } else if (arg === '-e' && i + 1 < args.length) {
        script = args[++i];
      } else if (!script && !arg.startsWith('-')) {
        script = arg;
      } else if (!arg.startsWith('-')) {
        files.push(arg);
      }
    }

    if (!script) {
      stream.stderr("sed: no script provided\r\nUsage: sed [-i] 's/find/replace/[g|i]' [file...]");
      return;
    }

    const parseSed = (inputStr: string): string => {
      let result = inputStr;

      if (script.startsWith('s') && script.length >= 3) {
        const delim = script[1];
        const parts: string[] = [];
        let cur = '';
        let escaped = false;
        for (let j = 2; j < script.length; j++) {
          const c = script[j];
          if (escaped) {
            cur += c;
            escaped = false;
          } else if (c === '\\') {
            escaped = true;
          } else if (c === delim) {
            parts.push(cur);
            cur = '';
          } else {
            cur += c;
          }
        }
        parts.push(cur);

        if (parts.length >= 2) {
          const findPattern = parts[0];
          const replacement = parts[1];
          const flags = parts[2] || '';
          const regexFlags = (flags.includes('g') ? 'g' : '') + (flags.includes('i') ? 'i' : '') + 'm';
          try {
            const re = new RegExp(findPattern, regexFlags);
            result = result.replace(re, replacement);
          } catch (e: any) {
            stream.stderr(`sed: invalid regular expression: ${e.message}`);
          }
        }
      } else if (script.endsWith('d')) {
        const matchPattern = script.slice(0, -1).trim();
        const lines = result.split(/\r?\n/);
        let filteredLines: string[] = [];
        if (/^\d+$/.test(matchPattern)) {
          const lineNum = parseInt(matchPattern, 10);
          filteredLines = lines.filter((_, idx) => idx + 1 !== lineNum);
        } else if (matchPattern.startsWith('/') && matchPattern.endsWith('/')) {
          const pat = matchPattern.slice(1, -1);
          const re = new RegExp(pat);
          filteredLines = lines.filter((l) => !re.test(l));
        } else {
          filteredLines = lines;
        }
        result = filteredLines.join('\n');
      }

      return result;
    };

    if (files.length > 0) {
      for (const f of files) {
        const resolved = this.resolvePath(f);
        try {
          const content = await this.ctx.fileSystem.readFile(resolved);
          const transformed = parseSed(content);
          if (inPlace) {
            await this.ctx.fileSystem.writeFile(resolved, transformed);
            this.ctx.editorService.updateFileContent(resolved, transformed);
          } else {
            stream.stdout(transformed);
            if (!transformed.endsWith('\n')) stream.stdout('\r\n');
          }
        } catch {
          stream.stderr(`sed: can't read ${f}: No such file or directory`);
        }
      }
    } else if (stream.stdin) {
      const transformed = parseSed(stream.stdin);
      stream.stdout(transformed);
      if (!transformed.endsWith('\n')) stream.stdout('\r\n');
    } else {
      stream.stderr("sed: no input files and no piped stdin\r\nUsage: sed [-i] 's/find/replace/g' <file>");
    }
  }

  private async execRm(args: string[], stream: CommandStream): Promise<void> {
    let recursive = false;
    let force = false;
    const targets: string[] = [];

    for (const arg of args) {
      if (arg === '-rf' || arg === '-fr' || arg === '-r' || arg === '-R' || arg === '--recursive') {
        recursive = true;
        if (arg.includes('f')) force = true;
      } else if (arg === '-f' || arg === '--force') {
        force = true;
      } else if (arg.startsWith('-') && !arg.startsWith('--')) {
        if (arg.includes('r') || arg.includes('R')) recursive = true;
        if (arg.includes('f')) force = true;
      } else {
        targets.push(arg);
      }
    }

    if (targets.length === 0) {
      if (!force) stream.stderr('rm: missing operand\r\nUsage: rm [-r] [-f] [-rf] <file|dir>...');
      return;
    }

    for (const t of targets) {
      const resolved = this.resolvePath(t);
      const isDir = await this.ctx.fileSystem.directoryExists(resolved);
      const isFile = await this.ctx.fileSystem.fileExists(resolved);

      if (!isDir && !isFile) {
        if (!force) {
          stream.stderr(`rm: cannot remove '${t}': No such file or directory`);
        }
        continue;
      }

      if (isDir && !recursive) {
        stream.stderr(`rm: cannot remove '${t}': Is a directory (use -r or -rf)`);
        continue;
      }

      try {
        await this.ctx.fileSystem.deleteFile(resolved);
        this.ctx.editorService.closeTab(resolved);
      } catch (e: any) {
        if (!force) {
          stream.stderr(`rm: cannot remove '${t}': ${e.message}`);
        }
      }
    }
  }

  private async execCp(args: string[], stream: CommandStream): Promise<void> {
    let recursive = false;
    const paths: string[] = [];

    for (const arg of args) {
      if (arg === '-r' || arg === '-R' || arg === '--recursive') {
        recursive = true;
      } else if (!arg.startsWith('-')) {
        paths.push(arg);
      }
    }

    if (paths.length < 2) {
      stream.stderr(`cp: missing destination operand\r\nUsage: cp [-r] <source> <dest>`);
      return;
    }

    const src = paths[0];
    const dest = paths[1];
    const resolvedSrc = this.resolvePath(src);
    let resolvedDest = this.resolvePath(dest);

    const isSrcDir = await this.ctx.fileSystem.directoryExists(resolvedSrc);
    const isSrcFile = await this.ctx.fileSystem.fileExists(resolvedSrc);

    if (!isSrcDir && !isSrcFile) {
      stream.stderr(`cp: cannot stat '${src}': No such file or directory`);
      return;
    }

    if (isSrcDir && !recursive) {
      stream.stderr(`cp: -r not specified; omitting directory '${src}'`);
      return;
    }

    const isDestDir = await this.ctx.fileSystem.directoryExists(resolvedDest);
    if (isDestDir) {
      const srcName = resolvedSrc.split('/').pop() || src;
      resolvedDest = resolvedDest ? `${resolvedDest}/${srcName}` : srcName;
    }

    try {
      if (isSrcDir) {
        await this.ctx.fileSystem.copyDirectory(resolvedSrc, resolvedDest);
      } else {
        await this.ctx.fileSystem.copyFile(resolvedSrc, resolvedDest);
      }
    } catch (err: any) {
      stream.stderr(`cp: failed to copy '${src}' to '${dest}': ${err.message}`);
    }
  }

  private async execMv(args: string[], stream: CommandStream): Promise<void> {
    const paths = args.filter((a) => !a.startsWith('-'));
    if (paths.length < 2) {
      stream.stderr('mv: missing destination file operand\r\nUsage: mv <source> <dest>');
      return;
    }

    const src = paths[0];
    const dest = paths[1];
    const resolvedSrc = this.resolvePath(src);
    let resolvedDest = this.resolvePath(dest);

    const isSrcDir = await this.ctx.fileSystem.directoryExists(resolvedSrc);
    const isSrcFile = await this.ctx.fileSystem.fileExists(resolvedSrc);

    if (!isSrcDir && !isSrcFile) {
      stream.stderr(`mv: cannot stat '${src}': No such file or directory`);
      return;
    }

    const isDestDir = await this.ctx.fileSystem.directoryExists(resolvedDest);
    if (isDestDir) {
      const srcName = resolvedSrc.split('/').pop() || src;
      resolvedDest = resolvedDest ? `${resolvedDest}/${srcName}` : srcName;
    }

    try {
      await this.ctx.fileSystem.move(resolvedSrc, resolvedDest);
      this.ctx.editorService.closeTab(resolvedSrc);
    } catch (err: any) {
      stream.stderr(`mv: failed to move '${src}' to '${dest}': ${err.message}`);
    }
  }

  private async execLn(args: string[], stream: CommandStream): Promise<void> {
    let symbolic = false;
    const paths: string[] = [];

    for (const arg of args) {
      if (arg === '-s' || arg === '--symbolic') {
        symbolic = true;
      } else if (!arg.startsWith('-')) {
        paths.push(arg);
      }
    }

    if (paths.length < 2) {
      stream.stderr('ln: missing destination operand\r\nUsage: ln [-s] <target> <link_name>');
      return;
    }

    const target = paths[0];
    const linkName = paths[1];
    const resolvedTarget = this.resolvePath(target);
    const resolvedLink = this.resolvePath(linkName);

    const exists = (await this.ctx.fileSystem.fileExists(resolvedTarget)) || (await this.ctx.fileSystem.directoryExists(resolvedTarget));
    if (!exists) {
      stream.stderr(`ln: failed to access '${target}': No such file or directory`);
      return;
    }

    try {
      await this.ctx.fileSystem.copyFile(resolvedTarget, resolvedLink);
      if (symbolic) {
        stream.stdout(`\x1b[32m'${linkName}' -> '${target}' (symbolic link alias created)\x1b[0m\r\n`);
      } else {
        stream.stdout(`\x1b[32m'${linkName}' => '${target}' (hard link mirror created)\x1b[0m\r\n`);
      }
    } catch (err: any) {
      stream.stderr(`ln: failed to create link '${linkName}': ${err.message}`);
    }
  }

  private async execFile(args: string[], stream: CommandStream): Promise<void> {
    const paths = args.filter((a) => !a.startsWith('-'));
    if (paths.length === 0) {
      stream.stderr('file: missing operand\r\nUsage: file <path>...');
      return;
    }

    for (const p of paths) {
      const resolved = this.resolvePath(p);
      const isDir = await this.ctx.fileSystem.directoryExists(resolved);
      if (isDir) {
        stream.stdout(`${p}: directory\r\n`);
        continue;
      }

      try {
        const bytes = await this.ctx.fileSystem.readBinaryFile(resolved);
        if (bytes.length === 0) {
          stream.stdout(`${p}: empty\r\n`);
          continue;
        }

        // Check WebAssembly binary magic: 0x00 0x61 0x73 0x6d ('\0asm')
        if (bytes.length >= 4 && bytes[0] === 0x00 && bytes[1] === 0x61 && bytes[2] === 0x73 && bytes[3] === 0x6d) {
          stream.stdout(`${p}: WebAssembly (wasm) binary module version 0x1 (MVP)\r\n`);
          continue;
        }

        // Check ELF binary magic
        if (bytes.length >= 4 && bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46) {
          stream.stdout(`${p}: ELF binary object\r\n`);
          continue;
        }

        const lower = p.toLowerCase();
        if (lower.endsWith('.cpp') || lower.endsWith('.cc') || lower.endsWith('.cxx')) {
          stream.stdout(`${p}: C++ source, ASCII text\r\n`);
        } else if (lower.endsWith('.c')) {
          stream.stdout(`${p}: C source, ASCII text\r\n`);
        } else if (lower.endsWith('.h') || lower.endsWith('.hpp')) {
          stream.stdout(`${p}: C/C++ header, ASCII text\r\n`);
        } else if (lower.endsWith('.json')) {
          stream.stdout(`${p}: JSON data\r\n`);
        } else if (lower.endsWith('.md')) {
          stream.stdout(`${p}: Markdown document, UTF-8 text\r\n`);
        } else {
          let isText = true;
          for (let i = 0; i < Math.min(bytes.length, 512); i++) {
            if (bytes[i] === 0) {
              isText = false;
              break;
            }
          }
          if (isText) {
            stream.stdout(`${p}: ASCII text\r\n`);
          } else {
            stream.stdout(`${p}: data\r\n`);
          }
        }
      } catch {
        stream.stderr(`file: cannot open '${p}': No such file or directory`);
      }
    }
  }

  private async execCat(args: string[], stream: CommandStream): Promise<void> {
    let numberLines = false;
    let numberNonEmpty = false;
    let showEnds = false;
    const files: string[] = [];

    for (const arg of args) {
      if (arg === '-n') numberLines = true;
      else if (arg === '-b') numberNonEmpty = true;
      else if (arg === '-E' || arg === '-e') showEnds = true;
      else if (!arg.startsWith('-')) files.push(arg);
    }

    const formatText = (text: string): string => {
      if (!numberLines && !numberNonEmpty && !showEnds) return text;
      const lines = text.split(/\r?\n/);
      let lineNum = 1;
      const outLines: string[] = [];
      for (let i = 0; i < lines.length; i++) {
        let l = lines[i];
        if (showEnds) l += '$';
        if (numberNonEmpty) {
          if (lines[i].trim().length > 0) {
            outLines.push(`${String(lineNum++).padStart(6, ' ')}  ${l}`);
          } else {
            outLines.push(l);
          }
        } else if (numberLines) {
          outLines.push(`${String(lineNum++).padStart(6, ' ')}  ${l}`);
        } else {
          outLines.push(l);
        }
      }
      return outLines.join('\n');
    };

    if (files.length > 0) {
      for (const f of files) {
        if (f === '-') {
          if (stream.stdin) {
            const res = formatText(stream.stdin);
            stream.stdout(res);
            if (!res.endsWith('\n')) stream.stdout('\r\n');
          }
          continue;
        }
        const resolved = this.resolvePath(f);
        try {
          const content = await this.ctx.fileSystem.readFile(resolved);
          const res = formatText(content);
          stream.stdout(res);
          if (!res.endsWith('\n')) stream.stdout('\r\n');
        } catch {
          stream.stderr(`cat: ${f}: No such file or directory`);
        }
      }
    } else if (stream.stdin) {
      const res = formatText(stream.stdin);
      stream.stdout(res);
      if (!res.endsWith('\n')) stream.stdout('\r\n');
    } else {
      stream.stderr('cat: missing file operand\r\nUsage: cat [-n] [-b] [-E] <file>...');
    }
  }

  private async execWc(args: string[], stream: CommandStream): Promise<void> {
    let showLines = false;
    let showWords = false;
    let showBytes = false;
    let showChars = false;
    const files: string[] = [];

    for (const arg of args) {
      if (arg === '-l' || arg === '--lines') showLines = true;
      else if (arg === '-w' || arg === '--words') showWords = true;
      else if (arg === '-c' || arg === '--bytes') showBytes = true;
      else if (arg === '-m' || arg === '--chars') showChars = true;
      else if (arg.startsWith('-') && !arg.startsWith('--')) {
        if (arg.includes('l')) showLines = true;
        if (arg.includes('w')) showWords = true;
        if (arg.includes('c')) showBytes = true;
        if (arg.includes('m')) showChars = true;
      } else {
        files.push(arg);
      }
    }

    if (!showLines && !showWords && !showBytes && !showChars) {
      showLines = true;
      showWords = true;
      showBytes = true;
    }

    const countContent = (text: string) => {
      const lines = (text.match(/\n/g) || []).length;
      const words = text.trim() ? text.trim().split(/\s+/).length : 0;
      const bytes = new TextEncoder().encode(text).length;
      const chars = text.length;
      return { lines, words, bytes, chars };
    };

    const formatCounts = (c: { lines: number; words: number; bytes: number; chars: number }, label?: string) => {
      const parts: string[] = [];
      if (showLines) parts.push(String(c.lines).padStart(7, ' '));
      if (showWords) parts.push(String(c.words).padStart(7, ' '));
      if (showChars) parts.push(String(c.chars).padStart(7, ' '));
      if (showBytes) parts.push(String(c.bytes).padStart(7, ' '));
      if (label) parts.push(` ${label}`);
      return parts.join(' ');
    };

    if (files.length > 0) {
      const total = { lines: 0, words: 0, bytes: 0, chars: 0 };
      for (const f of files) {
        const resolved = this.resolvePath(f);
        try {
          const content = await this.ctx.fileSystem.readFile(resolved);
          const c = countContent(content);
          total.lines += c.lines;
          total.words += c.words;
          total.bytes += c.bytes;
          total.chars += c.chars;
          stream.stdout(`${formatCounts(c, f)}\r\n`);
        } catch {
          stream.stderr(`wc: ${f}: No such file or directory`);
        }
      }
      if (files.length > 1) {
        stream.stdout(`${formatCounts(total, 'total')}\r\n`);
      }
    } else if (stream.stdin !== undefined) {
      const c = countContent(stream.stdin);
      stream.stdout(`${formatCounts(c)}\r\n`);
    } else {
      stream.stderr('wc: no input files\r\nUsage: wc [-l] [-w] [-c] [-m] [file...]');
    }
  }

  private async execMd5sum(args: string[], stream: CommandStream): Promise<void> {
    let checkMode = false;
    let checkFile = '';
    const files: string[] = [];

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '-c' && i + 1 < args.length) {
        checkMode = true;
        checkFile = args[++i];
      } else if (arg === '-c') {
        checkMode = true;
      } else if (!arg.startsWith('-')) {
        files.push(arg);
      }
    }

    if (checkMode) {
      const targetFile = checkFile || files[0];
      if (!targetFile && !stream.stdin) {
        stream.stderr('md5sum: no checksum file specified for -c');
        return;
      }
      let lines: string[] = [];
      if (targetFile) {
        const resolved = this.resolvePath(targetFile);
        try {
          const content = await this.ctx.fileSystem.readFile(resolved);
          lines = content.split(/\r?\n/).filter(Boolean);
        } catch {
          stream.stderr(`md5sum: ${targetFile}: No such file or directory`);
          return;
        }
      } else if (stream.stdin) {
        lines = stream.stdin.split(/\r?\n/).filter(Boolean);
      }

      for (const line of lines) {
        const m = line.trim().match(/^([a-fA-F0-9]{32})\s+[* ]?(.+)$/);
        if (m) {
          const expectedHash = m[1].toLowerCase();
          const checkTarget = m[2];
          const resolved = this.resolvePath(checkTarget);
          try {
            const bytes = await this.ctx.fileSystem.readBinaryFile(resolved);
            const actualHash = md5(bytes);
            if (actualHash === expectedHash) {
              stream.stdout(`${checkTarget}: \x1b[32mOK\x1b[0m\r\n`);
            } else {
              stream.stdout(`${checkTarget}: \x1b[31mFAILED\x1b[0m\r\n`);
            }
          } catch {
            stream.stdout(`${checkTarget}: \x1b[31mFAILED (Cannot open)\x1b[0m\r\n`);
          }
        }
      }
      return;
    }

    if (files.length > 0) {
      for (const f of files) {
        const resolved = this.resolvePath(f);
        try {
          const bytes = await this.ctx.fileSystem.readBinaryFile(resolved);
          const hash = md5(bytes);
          stream.stdout(`${hash}  ${f}\r\n`);
        } catch {
          stream.stderr(`md5sum: ${f}: No such file or directory`);
        }
      }
    } else if (stream.stdin !== undefined) {
      const hash = md5(stream.stdin);
      stream.stdout(`${hash}  -\r\n`);
    } else {
      stream.stderr('md5sum: missing operand\r\nUsage: md5sum <file>... or md5sum -c <checksum_file>');
    }
  }

  private async execFind(args: string[], stream: CommandStream): Promise<void> {
    let targetPath = '.';
    let namePattern = '';
    let caseInsensitive = false;
    let typeFilter: 'f' | 'd' | null = null;
    let maxDepth = 999;

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '-name' && i + 1 < args.length) {
        namePattern = args[++i];
      } else if (arg === '-iname' && i + 1 < args.length) {
        namePattern = args[++i];
        caseInsensitive = true;
      } else if (arg === '-type' && i + 1 < args.length) {
        const t = args[++i];
        if (t === 'f' || t === 'd') typeFilter = t;
      } else if (arg === '-maxdepth' && i + 1 < args.length) {
        maxDepth = parseInt(args[++i], 10) || 999;
      } else if (!arg.startsWith('-') && i === 0) {
        targetPath = arg;
      }
    }

    const resolvedTarget = this.resolvePath(targetPath);
    const exists = (await this.ctx.fileSystem.directoryExists(resolvedTarget)) || (await this.ctx.fileSystem.fileExists(resolvedTarget));
    if (!exists && targetPath !== '.') {
      stream.stderr(`find: '${targetPath}': No such file or directory`);
      return;
    }

    let regex: RegExp | null = null;
    if (namePattern) {
      const escaped = namePattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');
      regex = new RegExp(`^${escaped}$`, caseInsensitive ? 'i' : '');
    }

    const allItems = await this.ctx.fileSystem.listFiles(resolvedTarget);
    const prefix = targetPath.replace(/\/+$/, '');

    const printItem = (item: FileItem, depth: number) => {
      if (depth > maxDepth) return;
      const name = item.name;
      const isDir = item.isDirectory;

      let matches = true;
      if (typeFilter === 'f' && isDir) matches = false;
      if (typeFilter === 'd' && !isDir) matches = false;
      if (regex && !regex.test(name)) matches = false;

      if (matches) {
        const cleanSub = item.path.replace(/^\/+/, '');
        const displayPath = prefix === '.' ? `./${cleanSub}` : `${prefix}/${name}`;
        stream.stdout(`${displayPath}\r\n`);
      }

      if (isDir && item.children) {
        for (const child of item.children) {
          printItem(child, depth + 1);
        }
      }
    };

    for (const item of allItems) {
      printItem(item, 1);
    }
  }

  private async execGrep(args: string[], stream: CommandStream): Promise<void> {
    let ignoreCase = false;
    let showLineNum = false;
    let invertMatch = false;
    let countOnly = false;
    let recursive = false;
    let listFilesOnly = false;
    let pattern = '';
    const files: string[] = [];

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '-i' || arg === '--ignore-case') ignoreCase = true;
      else if (arg === '-n' || arg === '--line-number') showLineNum = true;
      else if (arg === '-v' || arg === '--invert-match') invertMatch = true;
      else if (arg === '-c' || arg === '--count') countOnly = true;
      else if (arg === '-r' || arg === '-R' || arg === '--recursive') recursive = true;
      else if (arg === '-l' || arg === '--files-with-matches') listFilesOnly = true;
      else if (arg.startsWith('-') && !arg.startsWith('--')) {
        if (arg.includes('i')) ignoreCase = true;
        if (arg.includes('n')) showLineNum = true;
        if (arg.includes('v')) invertMatch = true;
        if (arg.includes('c')) countOnly = true;
        if (arg.includes('r') || arg.includes('R')) recursive = true;
        if (arg.includes('l')) listFilesOnly = true;
      } else if (!pattern) {
        pattern = arg;
      } else {
        files.push(arg);
      }
    }

    if (!pattern) {
      stream.stderr('grep: missing pattern\r\nUsage: grep [options] <pattern> [file...]');
      return;
    }

    let re: RegExp;
    try {
      re = new RegExp(pattern, (ignoreCase ? 'i' : '') + 'g');
    } catch (err: any) {
      stream.stderr(`grep: invalid regular expression '${pattern}': ${err.message}`);
      return;
    }

    const highlightMatch = (line: string): string => {
      return line.replace(re, (match) => `\x1b[1;31m${match}\x1b[0m`);
    };

    const processText = (text: string, label?: string) => {
      const lines = text.split(/\r?\n/);
      let matchCount = 0;

      for (let idx = 0; idx < lines.length; idx++) {
        const line = lines[idx];
        const matches = re.test(line);
        re.lastIndex = 0;

        const selected = invertMatch ? !matches : matches;
        if (selected) {
          matchCount++;
          if (listFilesOnly) {
            if (label) stream.stdout(`${label}\r\n`);
            return;
          }
          if (!countOnly) {
            const highlighted = invertMatch ? line : highlightMatch(line);
            const prefix = label ? `\x1b[35m${label}\x1b[0m:` : '';
            const linePrefix = showLineNum ? `\x1b[32m${idx + 1}\x1b[0m:` : '';
            stream.stdout(`${prefix}${linePrefix}${highlighted}\r\n`);
          }
        }
      }

      if (countOnly) {
        if (label) {
          stream.stdout(`\x1b[35m${label}\x1b[0m:${matchCount}\r\n`);
        } else {
          stream.stdout(`${matchCount}\r\n`);
        }
      }
    };

    if (recursive) {
      const targetDir = files[0] ? this.resolvePath(files[0]) : '';
      const allFiles = await this.ctx.fileSystem.getAllFilesContent();
      for (const [filePath, content] of Object.entries(allFiles)) {
        if (!targetDir || filePath.startsWith(targetDir)) {
          processText(content, filePath);
        }
      }
    } else if (files.length > 0) {
      for (const f of files) {
        const resolved = this.resolvePath(f);
        try {
          const content = await this.ctx.fileSystem.readFile(resolved);
          processText(content, files.length > 1 ? f : undefined);
        } catch {
          stream.stderr(`grep: ${f}: No such file or directory`);
        }
      }
    } else if (stream.stdin !== undefined) {
      processText(stream.stdin);
    } else {
      stream.stderr('grep: no file specified\r\nUsage: grep [options] <pattern> [file...]');
    }
  }

  private async execCd(args: string[], stream: CommandStream): Promise<void> {
    const dest = args[0];
    if (!dest || dest === '~' || dest === '/') {
      this.ctx.terminalService.setCwd('');
      return;
    }
    const resolved = this.resolvePath(dest);
    if (!resolved) {
      this.ctx.terminalService.setCwd('');
      return;
    }
    const exists = await this.ctx.fileSystem.directoryExists(resolved);
    if (exists) {
      this.ctx.terminalService.setCwd(resolved);
    } else {
      stream.stderr(`cd: no such file or directory: ${dest}`);
    }
  }

  private async execPwd(stream: CommandStream): Promise<void> {
    const cwd = this.ctx.terminalService.getCwd();
    stream.stdout((cwd ? `/workspace/${cwd}` : '/workspace') + '\r\n');
  }

  private async execLs(args: string[], stream: CommandStream): Promise<void> {
    const isLong = args.includes('-l') || args.includes('-la') || args.includes('-al');
    const targetArg = args.find((a) => !a.startsWith('-')) || '';
    const targetDir = this.resolvePath(targetArg);

    const files = await this.ctx.fileSystem.listFiles(targetDir);
    if (files.length === 0) {
      stream.stdout('\x1b[90m(No files in directory)\x1b[0m\r\n');
    } else if (isLong) {
      for (const f of files) {
        if (f.isDirectory) {
          stream.stdout(`drwxr-xr-x         -  \x1b[1;34m${f.name}/\x1b[0m\r\n`);
        } else {
          const meta = await this.ctx.fileSystem.getFileMetadata(f.path);
          const szStr = meta ? `${meta.size} B`.padStart(10, ' ') : '         - ';
          stream.stdout(`-rw-r--r-- ${szStr}  \x1b[37m${f.name}\x1b[0m\r\n`);
        }
      }
    } else {
      const names = files.map((f) => {
        if (f.isDirectory) return `\x1b[1;34m${f.name}/\x1b[0m`;
        if (f.name.endsWith('.wasm')) return `\x1b[1;35m${f.name}\x1b[0m`;
        if (f.name.endsWith('.cpp') || f.name.endsWith('.cc')) return `\x1b[1;36m${f.name}\x1b[0m`;
        if (f.name.endsWith('.h') || f.name.endsWith('.hpp')) return `\x1b[33m${f.name}\x1b[0m`;
        return `\x1b[37m${f.name}\x1b[0m`;
      });
      stream.stdout(names.join('   ') + '\r\n');
    }
  }

  private async execCode(args: string[], stream: CommandStream): Promise<void> {
    if (!args[0]) {
      stream.stderr('Usage: code <filename>');
      return;
    }
    const filePath = this.resolvePath(args[0]);
    try {
      const content = await this.ctx.fileSystem.readFile(filePath);
      this.ctx.editorService.openFile(filePath, content);
      this.ctx.clangdService.attachDocument(`file:///${filePath}`, content);
      this.ctx.navigateRoute(`#/file/${encodeURIComponent(filePath)}`);
      stream.stdout(`\x1b[32mOpened "${filePath}" in editor.\x1b[0m\r\n`);
    } catch {
      stream.stderr(`code: file not found: ${args[0]}`);
    }
  }

  private async execTouch(args: string[], stream: CommandStream): Promise<void> {
    if (!args[0]) {
      stream.stderr('Usage: touch <filename>');
      return;
    }
    const filePath = this.resolvePath(args[0]);
    const template = this.ctx.fileSystem.getDefaultTemplateForFile(filePath);
    try {
      await this.ctx.fileSystem.createFile(filePath, template);
      stream.stdout(`\x1b[32mCreated file: ${filePath}\x1b[0m\r\n`);
    } catch (e: any) {
      stream.stderr(`touch: failed to create ${args[0]}: ${e.message}`);
    }
  }

  private async execMkdir(args: string[], stream: CommandStream): Promise<void> {
    if (!args[0]) {
      stream.stderr('Usage: mkdir <dirname>');
      return;
    }
    const dirPath = this.resolvePath(args[0]);
    try {
      await this.ctx.fileSystem.createDirectory(dirPath);
      stream.stdout(`\x1b[32mCreated directory: ${dirPath}\x1b[0m\r\n`);
    } catch (e: any) {
      stream.stderr(`mkdir: failed to create ${args[0]}: ${e.message}`);
    }
  }

  private async execCompile(args: string[], _stream: CommandStream): Promise<void> {
    if (args[0]) {
      const targetPath = this.resolvePath(args[0]);
      try {
        const content = await this.ctx.fileSystem.readFile(targetPath);
        this.ctx.editorService.openFile(targetPath, content);
        this.ctx.navigateRoute(`#/file/${encodeURIComponent(targetPath)}`);
      } catch {
        this.ctx.terminalService.writeLine(`\x1b[31mFile not found: ${args[0]}\x1b[0m`);
        return;
      }
    }
    await this.ctx.compileProject();
  }

  private async execRun(args: string[], _stream: CommandStream): Promise<void> {
    if (args.length === 0 && this.ctx.runOnly) {
      await this.ctx.runOnly();
      return;
    }
    const target = args[0] ? this.resolvePath(args[0]) : 'program.wasm';
    await this.ctx.emceptionService.runWasmBinary(target);
  }

  private async execMode(args: string[], stream: CommandStream): Promise<void> {
    const settings = this.ctx.getSettings();
    const sub = (args[0] || '').toLowerCase();
    if (sub === 'single' || sub === 'project') {
      settings.buildMode = sub;
      this.ctx.saveSettings(settings);
      this.ctx.updateStatus();
      stream.stdout(`\x1b[36mBuild mode set to: ${sub === 'single' ? 'Single File Mode' : 'Multi-file Project Mode'}\x1b[0m\r\n`);
    } else {
      stream.stdout(`\x1b[36mCurrent build mode: ${settings.buildMode === 'single' ? 'Single File Mode' : 'Multi-file Project Mode'}\x1b[0m\r\n`);
      stream.stdout('  Usage: mode single | mode project\r\n');
    }
  }

  private execInfo(stream: CommandStream): void {
    const settings = this.ctx.getSettings();
    const cwd = this.ctx.terminalService.getCwd();
    stream.stdout('\x1b[1;36mOnline C++ Local Studio\x1b[0m\r\n');
    stream.stdout(`  Folder: ${this.ctx.fileSystem.getRootName()}\r\n`);
    stream.stdout(`  Working Directory: ${cwd ? '/workspace/' + cwd : '/workspace'}\r\n`);
    stream.stdout(`  Build Mode: ${settings.buildMode === 'single' ? 'Single File Mode' : 'Multi-file Project Mode'}\r\n`);
    stream.stdout(`  WASM Storage: ${settings.wasmStorageMode === 'timestamp' ? 'Timestamp' : 'Overwrite'}\r\n`);
    stream.stdout(`  Auto-Save: ${settings.autoSave ? 'Enabled' : 'Disabled'}\r\n`);
    stream.stdout(`  C++ Standard: ${settings.cxxStandard}\r\n`);
    stream.stdout(`  Optimization: ${settings.optimization}\r\n`);
    stream.stdout(`  Clangd Status: ${this.ctx.clangdService.getStatusText().label}\r\n`);
    stream.stdout(`  Compiler: Emception (Clang / wasm-ld)\r\n`);
  }

  private execHelp(stream: CommandStream): void {
    stream.stdout('\x1b[1;36mAvailable Terminal Commands:\x1b[0m\r\n');
    stream.stdout('  \x1b[1;33mNetworking & Web:\x1b[0m\r\n');
    stream.stdout('    \x1b[32mwget <url> [-O file] [-q]\x1b[0m   - Download file from internet/CDN\r\n');
    stream.stdout('    \x1b[32mcurl <url> [-o file] [-I] [-s]\x1b[0m - Transfer data from URL or inspect headers\r\n');
    stream.stdout('  \x1b[1;33mText & File Processing:\x1b[0m\r\n');
    stream.stdout('    \x1b[32msed [-i] \'s/old/new/g\' [file]\x1b[0m - Stream editor for filtering and transforming text\r\n');
    stream.stdout('    \x1b[32mgrep [-i] [-n] [-r] <pat> [f]\x1b[0m - Search for pattern with highlighting & line numbers\r\n');
    stream.stdout('    \x1b[32mcat [-n] [-b] [-E] <file>...\x1b[0m - Concatenate and display files or stdin\r\n');
    stream.stdout('    \x1b[32mwc [-l] [-w] [-c] [file...]\x1b[0m   - Word, line, character, and byte count\r\n');
    stream.stdout('    \x1b[32mmd5sum [-c] <file>...\x1b[0m         - Compute or check MD5 message digest (RFC 1321)\r\n');
    stream.stdout('    \x1b[32mfile <path>...\x1b[0m               - Determine file format (WASM, C++, text, binary)\r\n');
    stream.stdout('  \x1b[1;33mFile & Directory Management:\x1b[0m\r\n');
    stream.stdout('    \x1b[32mfind [dir] [-name pattern]\x1b[0m    - Search directory tree for files matching criteria\r\n');
    stream.stdout('    \x1b[32mcp [-r] <src> <dest>\x1b[0m          - Copy files or directories recursively\r\n');
    stream.stdout('    \x1b[32mmv <src> <dest>\x1b[0m               - Move or rename file or directory\r\n');
    stream.stdout('    \x1b[32mrm [-rf] [-r] <file|dir>...\x1b[0m   - Remove files or directories recursively\r\n');
    stream.stdout('    \x1b[32mln [-s] <target> <link>\x1b[0m       - Create symbolic or hard link alias\r\n');
    stream.stdout('    \x1b[32mtouch <file>\x1b[0m                  - Create new file (with auto C++ boilerplate)\r\n');
    stream.stdout('    \x1b[32mmkdir <dir>\x1b[0m                   - Create new directory\r\n');
    stream.stdout('    \x1b[32mcode <file>\x1b[0m                   - Open file in Monaco code editor\r\n');
    stream.stdout('    \x1b[32mls [-l] [path]\x1b[0m                - List files in current or specified folder\r\n');
    stream.stdout('    \x1b[32mcd <dir>\x1b[0m                      - Change directory (e.g. cd src, cd .., cd /)\r\n');
    stream.stdout('    \x1b[32mpwd\x1b[0m                           - Print current working directory\r\n');
    stream.stdout('  \x1b[1;33mBuild & Execution:\x1b[0m\r\n');
    stream.stdout('    \x1b[32mcompile [file]\x1b[0m                - Compile C++ code to WebAssembly with Clang\r\n');
    stream.stdout('    \x1b[32mrun [wasm]\x1b[0m                    - Execute WebAssembly binary with WASI stdin/stdout\r\n');
    stream.stdout('    \x1b[32mmode [single|project]\x1b[0m         - Switch single-file vs project build mode\r\n');
    stream.stdout('  \x1b[1;33mGeneral & Shell Features:\x1b[0m\r\n');
    stream.stdout('    \x1b[32mpipelines (|)\x1b[0m                 - e.g. cat main.cpp | grep cout | wc -l\r\n');
    stream.stdout('    \x1b[32mredirection (> / >>)\x1b[0m          - e.g. echo "int main(){}" > hello.cpp\r\n');
    stream.stdout('    \x1b[32mclear\x1b[0m                         - Clear terminal screen\r\n');
    stream.stdout('    \x1b[32minfo\x1b[0m                          - Display IDE and compiler configuration\r\n');
    stream.stdout('    \x1b[32mecho [text]\x1b[0m                   - Print text to stdout\r\n');
    stream.stdout('    \x1b[32mdate\x1b[0m                          - Print current date and time\r\n');
  }
}
