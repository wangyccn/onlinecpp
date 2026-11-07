import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

export type CommandHandler = (cmd: string, args: string[]) => Promise<void> | void;
export type CommandLineHandler = (commandLine: string) => Promise<void> | void;

export class TerminalService {
  private term: Terminal;
  private fitAddon: FitAddon;
  private container: HTMLElement | null = null;
  private commandHandler: CommandHandler | null = null;
  private rawCommandHandler: CommandLineHandler | null = null;

  private currentInput = '';
  private cursorIndex = 0;
  private commandHistory: string[] = [];
  private historyIndex = -1;

  private isRunningProgram = false;
  private programStdinCallback: ((data: string) => void) | null = null;
  private currentDir = '';

  constructor() {
    this.term = new Terminal({
      theme: {
        background: '#181818',
        foreground: '#cccccc',
        cursor: '#aeafad',
        cursorAccent: '#181818',
        selectionBackground: '#264f78',
        black: '#000000',
        red: '#cd3131',
        green: '#0dbc79',
        yellow: '#e5e510',
        blue: '#2472c8',
        magenta: '#bc3fbc',
        cyan: '#11a8cd',
        white: '#e5e5e5',
        brightBlack: '#666666',
        brightRed: '#f14c4c',
        brightGreen: '#23d18b',
        brightYellow: '#f5f543',
        brightBlue: '#3b8eea',
        brightMagenta: '#d670d6',
        brightCyan: '#29b8db',
        brightWhite: '#ffffff',
      },
      fontFamily: 'Consolas, "Fira Code", "Courier New", monospace',
      fontSize: 13,
      lineHeight: 1.3,
      cursorBlink: true,
      convertEol: true,
    });

    this.fitAddon = new FitAddon();
    this.term.loadAddon(this.fitAddon);

    this.setupKeyHandlers();
  }

  public getTerminal(): Terminal {
    return this.term;
  }

  public mount(container: HTMLElement): void {
    this.container = container;
    this.term.open(container);
    this.fit();

    window.addEventListener('resize', () => this.fit());

    this.writeWelcomeBanner();
    this.showPrompt();
  }

  public fit(): void {
    try {
      if (this.container && this.container.clientWidth > 0 && this.container.clientHeight > 0) {
        this.fitAddon.fit();
      }
    } catch (e) {
      // Ignore fit layout errors before initial layout
    }
  }

  public setCommandHandler(handler: CommandHandler): void {
    this.commandHandler = handler;
  }

  public setCommandLineHandler(handler: CommandLineHandler): void {
    this.rawCommandHandler = handler;
  }

  public write(text: string): void {
    this.term.write(text);
  }

  public writeLine(text: string): void {
    this.term.writeln(text);
  }

  public clear(): void {
    this.term.clear();
  }

  public focus(): void {
    this.term.focus();
  }

  public setCwd(dir: string): void {
    this.currentDir = dir.replace(/^\/+|\/+$/g, '');
  }

  public getCwd(): string {
    return this.currentDir;
  }

  public showPrompt(): void {
    if (this.isRunningProgram) return;
    this.currentInput = '';
    this.cursorIndex = 0;
    const pathDisplay = this.currentDir ? `/workspace/${this.currentDir}` : '/workspace';
    this.term.write(`\r\n\x1b[1;32monlinecpp\x1b[0m:\x1b[1;34m${pathDisplay}\x1b[0m$ `);
  }

  public startProgramExecution(name: string, stdinHandler?: (data: string) => void): void {
    this.isRunningProgram = true;
    this.programStdinCallback = stdinHandler || null;
    this.term.writeln(`\r\n\x1b[36m>>> [Executing: ${name}] <<<\x1b[0m`);
  }

  public endProgramExecution(exitCode: number, durationMs?: number): void {
    this.isRunningProgram = false;
    this.programStdinCallback = null;
    const durStr = durationMs !== undefined ? ` (${durationMs.toFixed(1)}ms)` : '';
    const color = exitCode === 0 ? '\x1b[32m' : '\x1b[31m';
    this.term.writeln(`\r\n\x1b[90m----------------------------------------\x1b[0m`);
    this.term.writeln(`${color}Program exited with code ${exitCode}${durStr}\x1b[0m`);
    this.showPrompt();
  }

  private writeWelcomeBanner(): void {
    this.term.writeln('\x1b[1;36m* Welcome to Online C++ Local Terminal (Xterm.js + Emception) *\x1b[0m');
    this.term.writeln('\x1b[90mType \x1b[1;37mhelp\x1b[0m\x1b[90m for available commands, or click Run (▶) in the top bar.\x1b[0m');
  }

  private setupKeyHandlers(): void {
    this.term.onData((data) => {
      // If a program is currently running interactively, forward data to its stdin!
      if (this.isRunningProgram) {
        // Strip bracketed paste mode sequences if present
        const cleanData = data.replace(/\x1b\[20[01]~/g, '');
        if (!cleanData) return;

        const code = cleanData.charCodeAt(0);
        if (code === 3) {
          // Ctrl+C during program execution
          this.term.write('^C\r\n');
          if (this.programStdinCallback) {
            this.programStdinCallback('\x03');
          }
          this.endProgramExecution(130);
          return;
        }

        if (this.programStdinCallback) {
          this.programStdinCallback(cleanData);
        }

        // Echo characters locally for standard CLI interactions
        if (cleanData === '\r' || cleanData === '\n') {
          this.term.write('\r\n');
        } else if (cleanData === '\x7f' || cleanData === '\b') {
          // Backspace
          this.term.write('\b \b');
        } else {
          // Multi-line paste or regular text input:
          // CRITICAL: In terminals, bare \r moves cursor to column 0 on the SAME line without advancing row.
          // All newlines (\r\n, bare \r, or bare \n) must be echoed as \r\n to prevent text overwriting!
          let echoText = cleanData.replace(/\r\n|\r|\n/g, '\r\n');
          // If this was a multi-line paste without a trailing newline, advance to the next line
          if ((cleanData.includes('\r') || cleanData.includes('\n')) && !cleanData.endsWith('\r') && !cleanData.endsWith('\n')) {
            echoText += '\r\n';
          }
          this.term.write(echoText);
        }
        return;
      }

      // Handle terminal shell keypresses
      this.handleShellInput(data);
    });
  }

  private handleShellInput(data: string): void {
    // Strip bracketed paste mode sequences if present
    data = data.replace(/\x1b\[20[01]~/g, '');
    if (!data) return;

    // Handle multi-line pasted commands in shell
    if ((data.includes('\r') || data.includes('\n')) && data.length > 1) {
      const lines = data.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (i > 0) {
          this.term.write('\r\n');
          const cmdLine = this.currentInput.trim();
          this.currentInput = '';
          this.cursorIndex = 0;
          if (cmdLine) {
            this.commandHistory.push(cmdLine);
            this.historyIndex = this.commandHistory.length;
            this.executeCommand(cmdLine);
          } else {
            this.showPrompt();
          }
        }
        if (line) {
          this.currentInput += line;
          this.cursorIndex += line.length;
          this.term.write(line);
        }
      }
      return;
    }

    const code = data.charCodeAt(0);

    // Enter / Return
    if (data === '\r' || data === '\n') {
      this.term.write('\r\n');
      const cmdLine = this.currentInput.trim();
      this.currentInput = '';
      this.cursorIndex = 0;

      if (cmdLine) {
        this.commandHistory.push(cmdLine);
        this.historyIndex = this.commandHistory.length;
        this.executeCommand(cmdLine);
      } else {
        this.showPrompt();
      }
      return;
    }

    // Ctrl+C (Interrupt)
    if (code === 3) {
      this.term.write('^C\r\n');
      this.currentInput = '';
      this.cursorIndex = 0;
      this.showPrompt();
      return;
    }

    // Ctrl+L (Clear Screen)
    if (code === 12) {
      this.clear();
      this.showPrompt();
      this.term.write(this.currentInput);
      return;
    }

    // Backspace (ASCII 127 or 8)
    if (code === 127 || code === 8) {
      if (this.cursorIndex > 0) {
        this.currentInput =
          this.currentInput.slice(0, this.cursorIndex - 1) +
          this.currentInput.slice(this.cursorIndex);
        this.cursorIndex--;

        if (this.cursorIndex === this.currentInput.length) {
          this.term.write('\b \b');
        } else {
          this.term.write('\b');
          const remaining = this.currentInput.slice(this.cursorIndex);
          this.term.write(remaining + ' ');
          for (let i = 0; i <= remaining.length; i++) {
            this.term.write('\b');
          }
        }
      }
      return;
    }

    // Escape sequences (Arrows, Home, End, etc.)
    if (data.startsWith('\x1b[')) {
      const seq = data.slice(2);
      switch (seq) {
        case 'A': // Up Arrow (History prev)
          if (this.commandHistory.length > 0 && this.historyIndex > 0) {
            this.historyIndex--;
            this.replaceInput(this.commandHistory[this.historyIndex]);
          }
          break;
        case 'B': // Down Arrow (History next)
          if (this.historyIndex < this.commandHistory.length - 1) {
            this.historyIndex++;
            this.replaceInput(this.commandHistory[this.historyIndex]);
          } else {
            this.historyIndex = this.commandHistory.length;
            this.replaceInput('');
          }
          break;
        case 'C': // Right Arrow
          if (this.cursorIndex < this.currentInput.length) {
            this.cursorIndex++;
            this.term.write(data);
          }
          break;
        case 'D': // Left Arrow
          if (this.cursorIndex > 0) {
            this.cursorIndex--;
            this.term.write(data);
          }
          break;
        case 'H': // Home
          while (this.cursorIndex > 0) {
            this.term.write('\b');
            this.cursorIndex--;
          }
          break;
        case 'F': // End
          while (this.cursorIndex < this.currentInput.length) {
            this.term.write(this.currentInput[this.cursorIndex]);
            this.cursorIndex++;
          }
          break;
      }
      return;
    }

    // Printable Characters (single character or pasted string)
    if (code >= 32 && !data.startsWith('\x1b')) {
      if (this.cursorIndex === this.currentInput.length) {
        this.currentInput += data;
        this.cursorIndex += data.length;
        this.term.write(data);
      } else {
        this.currentInput =
          this.currentInput.slice(0, this.cursorIndex) +
          data +
          this.currentInput.slice(this.cursorIndex);
        this.cursorIndex += data.length;
        this.term.write(data);
        const remaining = this.currentInput.slice(this.cursorIndex);
        this.term.write(remaining);
        for (let i = 0; i < remaining.length; i++) {
          this.term.write('\b');
        }
      }
    }
  }

  private replaceInput(newText: string): void {
    while (this.cursorIndex > 0) {
      this.term.write('\b \b');
      this.cursorIndex--;
    }
    const oldLen = this.currentInput.length;
    for (let i = 0; i < oldLen; i++) {
      this.term.write(' ');
    }
    for (let i = 0; i < oldLen; i++) {
      this.term.write('\b');
    }

    this.currentInput = newText;
    this.cursorIndex = newText.length;
    this.term.write(newText);
  }

  private async executeCommand(commandLine: string): Promise<void> {
    const trimmed = commandLine.trim();
    if (!trimmed) {
      this.showPrompt();
      return;
    }

    if (this.rawCommandHandler) {
      try {
        await this.rawCommandHandler(trimmed);
      } catch (err: any) {
        this.term.writeln(`\x1b[31mError: ${err.message || String(err)}\x1b[0m`);
      }
    } else if (this.commandHandler) {
      const parts = trimmed.split(/\s+/);
      const cmd = parts[0];
      const args = parts.slice(1);

      try {
        await this.commandHandler(cmd, args);
      } catch (err: any) {
        this.term.writeln(`\x1b[31mError: ${err.message || String(err)}\x1b[0m`);
      }
    } else {
      this.term.writeln(`Command not recognized: ${trimmed}`);
    }

    if (!this.isRunningProgram) {
      this.showPrompt();
    }
  }
}
