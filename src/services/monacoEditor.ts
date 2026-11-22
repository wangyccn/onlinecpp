import * as monaco from 'monaco-editor';
import { OpenTab, EditorSettings } from '../types';
import { WriteQueue } from './writeQueue';

export class MonacoEditorService {
  private editor: monaco.editor.IStandaloneCodeEditor | null = null;
  private models: Map<string, monaco.editor.ITextModel> = new Map();
  private openTabs: OpenTab[] = [];
  private activePath: string | null = null;

  private onSaveCallback: ((path: string, content: string) => Promise<void> | void) | null = null;
  private onTabsChangedCallbacks: Array<(tabs: OpenTab[], activePath: string | null) => void> = [];
  private onCursorChangeCallbacks: Array<(line: number, col: number) => void> = [];
  private onContentChangeCallbacks: Array<(path: string, content: string, version: number) => void> = [];
  private onModelChangeCallbacks: Array<(path: string, model: monaco.editor.ITextModel) => void> = [];
  private autoSaveEnabled = true;
  private queuedSaves = new Map<string, { version: number; promise: Promise<void> }>();
  private saves = new WriteQueue<{ content: string; version: number }>(async (path, snapshot) => {
    if (!this.onSaveCallback) throw new Error('No save handler registered');
    await this.onSaveCallback(path, snapshot.content);
    const tab = this.openTabs.find((item) => item.path === path);
    const model = this.models.get(path);
    // An older completion must never mark newer edits as saved.
    if (tab && model && !model.isDisposed() && model.getVersionId() === snapshot.version) {
      tab.content = snapshot.content;
      tab.isDirty = false;
      this.notifyTabsChanged();
    }
  });
  private onSaveErrorCallback: ((path: string, error: unknown) => void) | null = null;
  private updatingFromDisk = false;

  constructor() {
    this.setupWorkerEnvironment();
  }

  private setupWorkerEnvironment(): void {
    if (typeof window !== 'undefined') {
      window.MonacoEnvironment = {
        getWorker(_: string, _label: string) {
          return new Worker(new URL('../workers/editor.worker.ts', import.meta.url), { type: 'module' });
        },
      };
    }
  }

  public mount(container: HTMLElement, settings: EditorSettings): void {
    this.autoSaveEnabled = settings.autoSave !== false;
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
      quickSuggestions: { other: true, comments: false, strings: false },
      wordBasedSuggestions: 'off',
      padding: { top: 12, bottom: 12 },
    });

    // Keybindings: Ctrl+S / Cmd+S to Save
    this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      this.saveActiveFile().catch((error) => this.reportSaveError(this.activePath || '', error));
    });

    // Track Cursor Position
    this.editor.onDidChangeCursorPosition((e) => {
      for (const cb of this.onCursorChangeCallbacks) {
        cb(e.position.lineNumber, e.position.column);
      }
    });

    // Track Model Content Changes (Dirty State, Auto-Save, and Real-time Language Server Sync)
    window.addEventListener('beforeunload', (event) => {
      if (this.hasUnsavedChanges()) { event.preventDefault(); event.returnValue = ''; }
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && this.autoSaveEnabled) this.saveAllFiles().catch((error) => this.reportSaveError('', error));
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

  public onContentChange(callback: (path: string, content: string, version: number) => void): () => void {
    this.onContentChangeCallbacks.push(callback);
    return () => {
      this.onContentChangeCallbacks = this.onContentChangeCallbacks.filter((c) => c !== callback);
    };
  }

  public onModelChange(callback: (path: string, model: monaco.editor.ITextModel) => void): () => void {
    this.onModelChangeCallbacks.push(callback);
    return () => {
      this.onModelChangeCallbacks = this.onModelChangeCallbacks.filter((c) => c !== callback);
    };
  }

  public setOnSave(callback: (path: string, content: string) => Promise<void> | void): void {
    this.onSaveCallback = callback;
  }

  public onSaveError(callback: (path: string, error: unknown) => void): void { this.onSaveErrorCallback = callback; }
  private reportSaveError(path: string, error: unknown): void {
    console.error(`[Save] ${path}`, error);
    this.onSaveErrorCallback?.(path, error);
  }
  public hasUnsavedChanges(): boolean { return this.saves.busy || this.openTabs.some((tab) => tab.isDirty); }

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
      const trackedModel = model;
      model.onDidChangeContent(() => {
        const content = trackedModel.getValue(), version = trackedModel.getVersionId();
        const tab = this.openTabs.find((item) => item.path === path);
        if (tab && !tab.isDirty && !this.updatingFromDisk) { tab.isDirty = true; this.notifyTabsChanged(); }
        for (const cb of this.onContentChangeCallbacks) cb(path, content, version);
        if (this.autoSaveEnabled && !this.updatingFromDisk) {
          this.queueSave(path, content, version, 800).catch((error) => this.reportSaveError(path, error));
        }
      });
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

    for (const cb of this.onModelChangeCallbacks) {
      cb(path, model);
    }

    this.notifyTabsChanged();
  }

  public async closeTab(path: string): Promise<void> {
    let index = this.openTabs.findIndex((t) => t.path === path);
    if (index === -1) return;
    if (this.openTabs[index].isDirty) {
      try { await this.saveFile(path); } catch (error) { this.reportSaveError(path, error); return; }
      index = this.openTabs.findIndex((t) => t.path === path);
      if (index === -1) return;
      if (this.openTabs[index]?.isDirty) return;
    }

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
    this.models.get(path)?.dispose();
    this.models.delete(path);
  }

  public async saveActiveFile(): Promise<void> {
    if (this.activePath) await this.saveFile(this.activePath);
  }

  /** Dispose every descendant before a destructive filesystem operation. */
  public async closeTabsUnder(path: string): Promise<void> {
    const matches = (candidate: string) => candidate === path || candidate.startsWith(path + '/');
    for (const tab of this.getOpenTabs().filter((tab) => matches(tab.path))) await this.closeTab(tab.path);
    if (this.openTabs.some((tab) => matches(tab.path))) throw new Error('Files changed or could not be saved; retry after saving before removing or moving them');
  }

  private saveFile(path: string): Promise<void> {
    const model = this.models.get(path);
    if (!model || model.isDisposed() || !this.openTabs.find((tab) => tab.path === path)?.isDirty) return Promise.resolve();
    return this.queueSave(path, model.getValue(), model.getVersionId());
  }

  private queueSave(path: string, content: string, version: number, delay = 0): Promise<void> {
    const queued = this.queuedSaves.get(path);
    if (queued?.version === version) {
      return delay ? queued.promise : Promise.all([queued.promise, this.saves.flush(path)]).then(() => {});
    }
    const promise = this.saves.enqueue(path, { content, version }, delay);
    this.queuedSaves.set(path, { version, promise });
    const clear = () => { if (this.queuedSaves.get(path)?.promise === promise) this.queuedSaves.delete(path); };
    promise.then(clear, clear);
    return promise;
  }

  public async saveAllFiles(): Promise<void> {
    await Promise.all(this.openTabs.filter((tab) => tab.isDirty).map((tab) => this.saveFile(tab.path)));
    await this.saves.flush();
  }

  public resetWorkspace(): void {
    if (this.hasUnsavedChanges()) throw new Error('Save all files before switching folders');
    this.editor?.setModel(null);
    this.models.forEach((model) => model.dispose());
    this.models.clear(); this.openTabs = []; this.activePath = null;
    this.notifyTabsChanged();
  }

  public updateFileContent(path: string, newContent: string): void {
    const model = this.models.get(path);
    if (model && model.getValue() !== newContent) {
      model.setValue(newContent);
    }
  }

  public updateFileFromDisk(path: string, text: string): void {
    const tab = this.openTabs.find((item) => item.path === path), model = this.models.get(path);
    if (!tab || tab.isDirty || !model || model.isDisposed()) return;
    this.updatingFromDisk = true;
    try { if (model.getValue() !== text) model.setValue(text); tab.content = text; }
    finally { this.updatingFromDisk = false; }
  }

  public getDirtyModelsContent(): Record<string, string> {
    const content = this.getAllOpenModelsContent();
    return Object.fromEntries(this.openTabs.filter((tab) => tab.isDirty).map((tab) => [tab.path, content[tab.path]]));
  }

  public formatDocument(): void {
    if (this.editor) {
      this.editor.getAction('editor.action.formatDocument')?.run();
    }
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
