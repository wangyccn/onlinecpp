import * as monaco from 'monaco-editor';
import { OpenTab, EditorSettings } from '../types';

export class MonacoEditorService {
  private editor: monaco.editor.IStandaloneCodeEditor | null = null;
  private models: Map<string, monaco.editor.ITextModel> = new Map();
  private openTabs: OpenTab[] = [];
  private activePath: string | null = null;

  private onSaveCallback: ((path: string, content: string) => Promise<void> | void) | null = null;
  private onTabsChangedCallbacks: Array<(tabs: OpenTab[], activePath: string | null) => void> = [];
  private onCursorChangeCallbacks: Array<(line: number, col: number) => void> = [];
  private autoSaveEnabled = true;
  private autoSaveTimer: any = null;

  constructor() {
    this.setupWorkerEnvironment();
  }

  private setupWorkerEnvironment(): void {
    if (typeof window !== 'undefined') {
      window.MonacoEnvironment = {
        getWorker(_: string, _label: string) {
          try {
            const workerUrl = new URL('workers/editor.worker.js', window.location.href);
            return new Worker(workerUrl);
          } catch {
            return new Worker('./workers/editor.worker.js');
          }
        },
      };
    }
  }

  public mount(container: HTMLElement, settings: EditorSettings): void {
    this.editor = monaco.editor.create(container, {
      value: '',
      language: 'cpp',
      theme: 'vs-dark',
      fontSize: settings.fontSize || 14,
      fontFamily: "'Fira Code', 'Cascadia Code', Consolas, 'Courier New', monospace",
      fontLigatures: true,
      tabSize: settings.tabSize || 4,
      minimap: { enabled: settings.minimap },
      wordWrap: settings.wordWrap || 'on',
      automaticLayout: true,
      lineNumbers: 'on',
      scrollBeyondLastLine: false,
      renderLineHighlight: 'all',
      smoothScrolling: true,
      cursorBlinking: 'smooth',
      padding: { top: 12, bottom: 12 },
    });

    // Keybindings: Ctrl+S / Cmd+S to Save
    this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      this.saveActiveFile();
    });

    // Track Cursor Position
    this.editor.onDidChangeCursorPosition((e) => {
      for (const cb of this.onCursorChangeCallbacks) {
        cb(e.position.lineNumber, e.position.column);
      }
    });

    // Track Model Content Changes (Dirty State & Auto-Save)
    this.editor.onDidChangeModelContent(() => {
      if (this.activePath) {
        const tab = this.openTabs.find((t) => t.path === this.activePath);
        if (tab && !tab.isDirty) {
          tab.isDirty = true;
          this.notifyTabsChanged();
        }
        this.triggerAutoSave();
      }
    });
  }

  public getEditor(): monaco.editor.IStandaloneCodeEditor | null {
    return this.editor;
  }

  public getActiveModel(): monaco.editor.ITextModel | null {
    return this.editor?.getModel() || null;
  }

  public getActivePath(): string | null {
    return this.activePath;
  }

  public getOpenTabs(): OpenTab[] {
    return [...this.openTabs];
  }

  public onTabsChanged(callback: (tabs: OpenTab[], activePath: string | null) => void): () => void {
    this.onTabsChangedCallbacks.push(callback);
    return () => {
      this.onTabsChangedCallbacks = this.onTabsChangedCallbacks.filter((c) => c !== callback);
    };
  }

  public onCursorChange(callback: (line: number, col: number) => void): () => void {
    this.onCursorChangeCallbacks.push(callback);
    return () => {
      this.onCursorChangeCallbacks = this.onCursorChangeCallbacks.filter((c) => c !== callback);
    };
  }

  public setOnSave(callback: (path: string, content: string) => Promise<void> | void): void {
    this.onSaveCallback = callback;
  }

  public getActiveContent(): string | null {
    return this.editor?.getModel()?.getValue() ?? null;
  }

  public getAllOpenModelsContent(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [path, model] of this.models.entries()) {
      if (!model.isDisposed()) {
        result[path] = model.getValue();
      }
    }
    return result;
  }

  private notifyTabsChanged(): void {
    for (const cb of this.onTabsChangedCallbacks) {
      cb([...this.openTabs], this.activePath);
    }
  }

  public openFile(path: string, content: string): void {
    let model = this.models.get(path);

    if (!model) {
      const uri = monaco.Uri.parse(`file:///${path}`);
      model = monaco.editor.getModel(uri) || monaco.editor.createModel(content, this.detectLanguage(path), uri);
      this.models.set(path, model);
    }

    let tab = this.openTabs.find((t) => t.path === path);
    if (!tab) {
      const name = path.split('/').pop() || path;
      tab = { path, name, isDirty: false, content };
      this.openTabs.push(tab);
    }

    this.activePath = path;
    if (this.editor) {
      this.editor.setModel(model);
      this.editor.focus();
    }

    this.notifyTabsChanged();
  }

  public closeTab(path: string): void {
    const index = this.openTabs.findIndex((t) => t.path === path);
    if (index === -1) return;

    this.openTabs.splice(index, 1);

    if (this.activePath === path) {
      if (this.openTabs.length > 0) {
        const nextIndex = Math.max(0, index - 1);
        const nextTab = this.openTabs[nextIndex];
        this.openFile(nextTab.path, nextTab.content);
      } else {
        this.activePath = null;
        if (this.editor) {
          this.editor.setModel(null);
        }
      }
    }

    this.notifyTabsChanged();
  }

  public async saveActiveFile(): Promise<void> {
    if (!this.activePath || !this.editor) return;

    const model = this.editor.getModel();
    if (!model) return;

    const content = model.getValue();
    const tab = this.openTabs.find((t) => t.path === this.activePath);
    if (tab) {
      tab.isDirty = false;
      tab.content = content;
      this.notifyTabsChanged();
    }

    if (this.onSaveCallback) {
      await this.onSaveCallback(this.activePath, content);
    }
  }

  public updateFileContent(path: string, newContent: string): void {
    const model = this.models.get(path);
    if (model && model.getValue() !== newContent) {
      model.setValue(newContent);
    }
  }

  public formatDocument(): void {
    if (this.editor) {
      this.editor.getAction('editor.action.formatDocument')?.run();
    }
  }

  private triggerAutoSave(): void {
    if (!this.autoSaveEnabled) return;
    if (this.autoSaveTimer) {
      clearTimeout(this.autoSaveTimer);
    }
    this.autoSaveTimer = setTimeout(() => {
      this.saveActiveFile();
    }, 1000);
  }

  public applySettings(settings: EditorSettings): void {
    if (!this.editor) return;
    this.autoSaveEnabled = settings.autoSave !== false;
    this.editor.updateOptions({
      fontSize: settings.fontSize,
      tabSize: settings.tabSize,
      minimap: { enabled: settings.minimap },
      wordWrap: settings.wordWrap,
    });
  }

  private detectLanguage(filename: string): string {
    const ext = filename.split('.').pop()?.toLowerCase();
    switch (ext) {
      case 'cpp':
      case 'cc':
      case 'cxx':
      case 'c':
      case 'h':
      case 'hpp':
        return 'cpp';
      default:
        return 'plaintext';
    }
  }

  public dispose(): void {
    this.models.forEach((model) => model.dispose());
    this.models.clear();
    this.editor?.dispose();
    this.editor = null;
  }
}
