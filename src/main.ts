import './styles/vscode.css';
import { FileSystemService } from './services/fileSystem';
import { MonacoEditorService } from './services/monacoEditor';
import { ClangdService } from './services/clangdService';
import { TerminalService } from './services/terminalService';
import { EmceptionService } from './services/emceptionService';
import { ShellService } from './services/shellService';
import { SimpleRouter } from './router';
import { FileItem, OpenTab, DiagnosticItem, EditorSettings } from './types';
import { abortable } from './services/abort';
import { progressService } from './services/progressService';

class OnlineCppIDE {
  private fileSystem: FileSystemService;
  private editorService: MonacoEditorService;
  private clangdService: ClangdService;
  private terminalService: TerminalService;
  private emceptionService: EmceptionService;
  private shellService: ShellService;
  private router: SimpleRouter;

  private settings: EditorSettings = {
    fontSize: 14,
    tabSize: 4,
    minimap: true,
    wordWrap: 'on',
    cxxStandard: 'c++20',
    optimization: '-O0',
    enableClangd: true,
    autoSave: true,
    wasmStorageMode: 'overwrite',
    buildMode: 'single',
    storageMode: 'disk',
  };

  private isExecutingTask = false;
  private taskAbort: AbortController | null = null;
  private warmStarted = false;
  private lastOutputPaths = new Map<string, string>();

  private currentDiagnostics: DiagnosticItem[] = [];
  private activePanelTab: 'terminal' | 'output' | 'problems' = 'terminal';
  private outputLogs: string[] = [];

  constructor() {
    this.fileSystem = new FileSystemService();
    this.editorService = new MonacoEditorService();
    this.clangdService = new ClangdService();
    this.terminalService = new TerminalService();
    this.emceptionService = new EmceptionService(this.terminalService, this.fileSystem);
    this.router = new SimpleRouter();

    this.shellService = new ShellService({
      fileSystem: this.fileSystem,
      terminalService: this.terminalService,
      editorService: this.editorService,
      emceptionService: this.emceptionService,
      clangdService: this.clangdService,
      getSettings: () => this.settings,
      saveSettings: (s) => {
        this.settings = s;
        this.saveSettings();
      },
      updateStatus: () => this.updateStatus(),
      openFolderAction: () => this.openFolderAction(),
      compileProject: () => this.compileCurrentProject(),
      runProject: () => this.runCurrentProject(),
      runOnly: () => this.runCachedWasmOnly(),
      runBinary: (path, args) => this.runBinaryFromShell(path, args),
      navigateRoute: (hash) => this.router.navigate(hash),
    });

    this.loadSettings();
    this.renderLayout();
    this.initServices();
    this.setupRoutes();
  }

  private loadSettings(): void {
    const saved = localStorage.getItem('onlinecpp_settings');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        this.settings = { ...this.settings, ...parsed };
      } catch (e) {
        console.warn('Failed to parse settings:', e);
      }
    }
  }

  private saveSettings(): void {
    localStorage.setItem('onlinecpp_settings', JSON.stringify(this.settings));
    this.editorService.applySettings(this.settings);
    this.clangdService.configure(this.settings.cxxStandard, this.settings.enableClangd);
  }

  private renderLayout(): void {
    const app = document.getElementById('app');
    if (!app) return;

    app.innerHTML = `
      <!-- TOP TITLE BAR -->
      <header class="titlebar">
        <div class="titlebar-left">
          <div class="logo-badge">
            <svg class="logo-icon" viewBox="0 0 24 24">
              <path d="M14.25.18l.9.2.73.26.59.3.45.32.34.34.25.34.19.34.14.35.1.34.05.34.02.32-.02.32-.05.34-.1.35-.14.34-.19.34-.25.34-.34.33-.45.33-.59.3-.73.26-.9.2-.74.1-1.07.03h-2.1l-.8-.06-.75-.13-.7-.2-.64-.26-.57-.32-.5-.38-.41-.43-.34-.48-.25-.52-.16-.56-.09-.58-.02-.6.02-.6.09-.58.16-.55.25-.53.34-.48.41-.43.5-.38.57-.32.64-.26.7-.2.75-.13.8-.06h2.1l1.07.03.74.1zm5.2 6.54l.43.34.34.38.25.42.17.44.1.46.03.48v.48l-.06.47-.13.45-.2.43-.28.4-.37.36-.45.3-.53.25-.6.18-.67.11-.74.05h-1.5l-.67-.08-.63-.15-.57-.22-.5-.28-.43-.34-.34-.39-.25-.42-.17-.44-.1-.46-.03-.48v-.48l.06-.47.13-.45.2-.43.28-.4.37-.36.45-.3.53-.25.6-.18.67-.11.74-.05h1.5l.67.08.63.15.57.22.5.28z"/>
            </svg>
            <span>Online C++ Studio</span>
          </div>
          <span class="title-tag">Local Wasm IDE</span>
        </div>

        <div class="titlebar-center">
          <button id="btn-run" class="action-btn btn-run" title="Build and Run with WebAssembly (F5)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
            <span>Run</span>
          </button>
          <button id="btn-run-only" class="action-btn btn-run-only" title="Run Cached WebAssembly Binary without Compiling (Ctrl+F5)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2"/><polygon points="10 8 16 12 10 16 10 8"/></svg>
            <span>Run Only</span>
          </button>
          <button id="btn-compile" class="action-btn btn-compile" title="Compile C++ to WebAssembly (Ctrl+B)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m15 12-8.5 8.5c-.83.83-2.17.83-3 0 0 0 0 0 0 0a2.12 2.12 0 0 1 0-3L12 9"/><path d="M17.64 15 22 10.64"/><path d="m20.91 3.26-6.5 6.5"/></svg>
            <span>Compile</span>
          </button>
          <button id="btn-stop" class="action-btn" title="Interrupt foreground task (Ctrl+C)" disabled>■ Stop</button>
          <button id="btn-save" class="action-btn" title="Save file (Ctrl+S)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
            <span>Save</span>
          </button>
          <button id="btn-open-folder" class="action-btn" title="Open Local Directory with File System Access API">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
            <span>Open Folder</span>
          </button>
        </div>

        <div class="titlebar-right">
          <button id="btn-settings" class="icon-btn" title="Editor & Compiler Settings">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
          </button>
          <button id="btn-about" class="icon-btn" title="About & Architecture">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
          </button>
        </div>
      </header>

      <!-- MAIN CONTAINER -->
      <main class="main-container">
        <!-- Activity Bar -->
        <div class="activity-bar">
          <div class="activity-icons-top">
            <div class="activity-item active" title="Explorer">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>
            </div>
            <div class="activity-item active" id="act-terminal" title="Terminal (Toggle)">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
            </div>
          </div>
          <div class="activity-icons-bottom">
            <div class="activity-item" id="act-settings" title="Settings">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
            </div>
          </div>
        </div>

        <!-- Sidebar (Explorer) -->
        <aside class="sidebar">
          <div class="sidebar-header">
            <span>Explorer</span>
            <div class="sidebar-tools">
              <button id="btn-new-file" class="sidebar-tool-btn" title="New C++ File (Auto boilerplate)">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>
              </button>
              <button id="btn-new-folder" class="sidebar-tool-btn" title="New Folder">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg>
              </button>
              <button id="btn-refresh-files" class="sidebar-tool-btn" title="Refresh Explorer">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
              </button>
            </div>
          </div>

          <div class="project-title" id="project-title">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>
            <span id="project-name">No Folder Opened</span>
          </div>

          <div class="file-tree" id="file-tree"></div>
        </aside>

        <!-- Editor & Bottom Panel Workspace -->
        <div class="editor-panel-area">
          <!-- Editor Tabs -->
          <div class="tabs-bar" id="tabs-bar"></div>

          <!-- Breadcrumbs -->
          <div class="breadcrumbs-bar" id="breadcrumbs-bar">
            <span class="breadcrumb-part" id="breadcrumb-root">No Folder</span>
            <span class="breadcrumb-sep">&gt;</span>
            <span class="breadcrumb-part" id="breadcrumb-file">Open folder to start</span>
          </div>

          <!-- Monaco Editor Mount Container -->
          <div class="editor-container" id="editor-container">
            <div id="monaco-root"></div>
            <div id="editor-welcome-view" class="editor-welcome" style="display: none;">
              <div class="editor-welcome-title">Online C++ Local Studio</div>
              <p>基于 WebAssembly 的本地原生 C++ 开发环境</p>
              <div class="editor-welcome-actions">
                <div class="welcome-action-item" id="welcome-open-folder">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                  <span>打开本地文件夹 (Open Folder)</span>
                </div>
              </div>
            </div>
          </div>

          <!-- Resizer Divider -->
          <div class="panel-divider" id="panel-resizer"></div>

          <!-- Bottom Panel (TERMINAL / OUTPUT / PROBLEMS) -->
          <div class="bottom-panel" id="bottom-panel">
            <div class="panel-header">
              <div class="panel-tabs">
                <div class="panel-tab active" data-tab="terminal">
                  Terminal
                </div>
                <div class="panel-tab" data-tab="output">
                  Output
                </div>
                <div class="panel-tab" data-tab="problems">
                  Problems
                  <span class="badge" id="badge-problems">0</span>
                </div>
              </div>

              <div class="panel-controls">
                <button id="btn-clear-panel" class="icon-btn" title="Clear">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>
                </button>
                <button id="btn-toggle-panel-max" class="icon-btn" title="Toggle Maximize">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
                </button>
                <button id="btn-close-panel" class="icon-btn" title="Hide Panel">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
              </div>
            </div>

            <div class="panel-body">
              <div class="panel-content active" id="tab-terminal">
                <div id="xterm-container"></div>
              </div>
              <div class="panel-content" id="tab-output">
                <div id="output-container"></div>
              </div>
              <div class="panel-content" id="tab-problems">
                <div id="problems-container">
                  <div style="padding: 16px; color: #858585; text-align: center;">No problems detected in workspace</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>

      <!-- BOTTOM STATUS BAR -->
      <footer class="status-bar">
        <div class="status-left">
          <div class="status-item" id="status-buildmode" style="cursor: pointer;" title="Build Mode: Click to toggle Single File vs Project Mode">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>
            <span id="status-buildmode-text">Mode: Single File</span>
          </div>
          <div class="status-item" id="status-problems" title="Errors and Warnings">
            <span id="status-error-count">0</span> errors, <span id="status-warning-count">0</span> warnings
          </div>
          <div class="status-item" id="status-clangd" title="Clangd WASM Language Server">
            <div class="status-dot"></div>
            <span id="status-clangd-label">clangd WASM</span>
          </div>
        </div>

        <div class="status-right">
          <div class="status-item" id="status-cursor">Ln 1, Col 1</div>
          <div class="status-item" id="status-autosave" title="Auto-Save status">Auto-Save: On</div>
          <button type="button" class="status-item" id="status-storage" title="Click to save and synchronize pending files to disk" style="background:none;border:0;color:inherit;font:inherit;cursor:pointer">Disk synced</button>
          <div class="status-item" title="Tab Indentation">Spaces: 4</div>
          <div class="status-item" title="File Encoding">UTF-8</div>
          <div class="status-item" id="status-std" title="C++ Standard">C++20</div>
          <div class="status-item" id="status-toolchain" title="WebAssembly Toolchain Status">WASM Ready</div>
        </div>
      </footer>

      <!-- MODALS CONTAINER -->
      <div id="modal-container"></div>
    `;
  }

  private async initServices(): Promise<void> {
    this.clangdService.configure(this.settings.cxxStandard, this.settings.enableClangd);

    // Mount progress bar
    progressService.mount();

    // 1. Mount Monaco Editor
    const monacoRoot = document.getElementById('monaco-root');
    if (monacoRoot) {
      this.editorService.mount(monacoRoot, this.settings);
    }

    // 2. Mount Xterm.js Terminal
    const xtermRoot = document.getElementById('xterm-container');
    if (xtermRoot) {
      this.terminalService.mount(xtermRoot);
    }

    // 3. Connect Terminal Command Dispatcher with ShellService
    this.terminalService.setCommandLineHandler(async (commandLine) => {
      await this.shellService.executeCommandLine(commandLine);
    });
    this.terminalService.setCommandHandler(async (cmd, args) => {
      await this.shellService.executeCommandLine([cmd, ...args].join(' '));
    });

    // 4. Editor Save Handler
    this.editorService.setOnSave(async (path, content) => {
      if (!this.fileSystem.hasOpenFolder()) throw new Error('Open a local folder before saving');
      if (this.fileSystem.hasOpenFolder()) {
        await this.fileSystem.writeFile(path, content);
        this.logOutput(`[Saved to IndexedDB] "${path}"${this.fileSystem.getStorageMode() === 'disk' ? ' — external disk sync queued.' : ' — browser storage only.'}`);
        this.updateStatus();
      }
    });

    this.editorService.onSaveError((path, error: any) => {
      this.logOutput(`[Save failed] ${path}: ${error.message || error}. Changes remain unsaved.`);
      const status = document.getElementById('status-autosave');
      if (status) { status.textContent = 'Save failed — retry Ctrl+S'; status.title = String(error); }
    });

    // 5. Update Cursor Position in Status Bar
    this.editorService.onCursorChange((line, col) => {
      const el = document.getElementById('status-cursor');
      if (el) el.textContent = `Ln ${line}, Col ${col}`;
    });

    // 6. Refresh Tabs UI
    this.editorService.onTabsChanged((tabs, activePath) => {
      this.clangdService.retainDocuments(tabs.map((tab) => tab.path));
      this.renderTabs(tabs, activePath);
      this.updateBreadcrumbs(activePath);
      this.updateEditorWelcomeState(tabs.length);
    });

    // 7. Update File Tree when file system changes
    this.fileSystem.onFilesChanged((items) => {
      this.renderFileTree(items);
      const titleEl = document.getElementById('project-name');
      if (titleEl) titleEl.textContent = this.fileSystem.getRootName();
    });

    // 8. Handle Clangd Diagnostics
    let lastStorageError = '';
    let diskSyncTask: ReturnType<typeof progressService.start> | undefined;
    const diskSyncLabel = (pending: number) => `Syncing ${pending} file${pending === 1 ? '' : 's'} to disk...`;
    const finishDiskSync = () => { diskSyncTask?.done(); diskSyncTask = undefined; };
    this.fileSystem.io.onStorageStatus = (status) => {
      this.updateStatus();
      if (status.error && status.error !== lastStorageError) this.logOutput('[Disk sync failed] ' + status.error + '. Data is safe in IndexedDB — click the disk status to retry.');
      lastStorageError = status.error || '';
      // The task must always be released: a leaked one keeps the bar spinning forever and blocks closing the tab.
      if (status.mode === 'browser' || status.pending === 0 || status.error) { finishDiskSync(); return; }
      if (diskSyncTask) diskSyncTask.update(-1, diskSyncLabel(status.pending));
      else diskSyncTask = progressService.start('disk-sync', diskSyncLabel(status.pending), -1);
    };
    document.getElementById('status-storage')?.addEventListener('click', async () => {
      const task = progressService.start('manual-disk-sync', 'Syncing files to disk...', -1);
      try { await this.editorService.saveAllFiles(); await this.fileSystem.syncToDisk(); this.logOutput('[Disk sync] All pending files written to disk.'); }
      catch (error: any) { this.logOutput('[Sync failed] ' + (error?.message || error)); }
      finally { task.done(); this.updateStatus(); }
    });
    window.addEventListener('beforeunload', (event) => {
      // Only unsaved editor content blocks closing: the write-back cache survives a reload.
      if (this.editorService.hasUnsavedChanges()) {
        event.preventDefault(); event.returnValue = '';
      }
    });

    this.clangdService.onDiagnostics((items) => {
      this.currentDiagnostics = items;
      this.renderDiagnostics(items);
    });

    // Language Server Status Updates
    this.clangdService.onStatusChange(() => {
      this.updateStatus();
    });

    // Real-time Editor Synchronization to Language Server
    this.editorService.onContentChange((path, content, version) => {
      this.clangdService.updateDocument(`file:///${path}`, content, version);
    });

    this.editorService.onModelChange((path, model) => {
      this.clangdService.attachDocument(`file:///${path}`, model.getValue());
    });

    // 9. Attach Button Listeners
    this.bindEvents();

    // 10. Update Status Bar
    this.updateStatus();

    // 11. Initial State: check if folder is opened
    if (!this.fileSystem.hasOpenFolder()) {
      this.renderNoFolderState();
    }

    if (this.settings.storageMode === 'browser') {
      void this.fileSystem.useBrowserStorage().then(() => this.showCurrentWorkspace()).catch((error) => {
        this.logOutput('[Browser storage failed] ' + error.message);
      });
    }

    // 12. Warm the Emception toolchain in the background (no UI entry point needed:
    // the toolchain is fetched automatically once a workspace exists).
    const idle = (window as any).requestIdleCallback as ((cb: () => void, opts?: { timeout: number }) => void) | undefined;
    if (idle) idle(() => void this.warmToolchain(), { timeout: 2500 });
    else setTimeout(() => void this.warmToolchain(), 600);
  }

  /** Fetch + boot the Clang/WASM toolchain ahead of the first build. */
  private warmToolchain(): Promise<boolean> | null {
    if (!this.fileSystem.hasOpenFolder() || this.warmStarted) return null;
    this.warmStarted = true;
    const task = progressService.start('toolchain-download', 'Preparing C++ toolchain…', -1);
    return this.emceptionService.prepare(this.settings.cxxStandard, this.settings.optimization).then((ready) => {
      const toolchainEl = document.getElementById('status-toolchain');
      if (toolchainEl) toolchainEl.textContent = ready ? 'Emception: Ready' : 'Emception: Standby';
      if (ready) this.terminalService.writeLine('\x1b[32m[Toolchain] C++ toolchain ready.\x1b[0m');
      return ready;
    }).catch((error: any) => {
      this.terminalService.writeLine(`\x1b[33m[Toolchain] Warm-up skipped: ${error?.message || error}\x1b[0m`);
      return false;
    }).finally(() => { task.done(); this.warmStarted = false; });
  }

  private updateEditorWelcomeState(openTabCount: number): void {
    const monacoRoot = document.getElementById('monaco-root');
    const welcome = document.getElementById('editor-welcome-view');
    if (!monacoRoot || !welcome) return;

    if (openTabCount === 0) {
      monacoRoot.style.display = 'none';
      welcome.style.display = 'flex';
    } else {
      monacoRoot.style.display = 'block';
      welcome.style.display = 'none';
    }
  }

  private renderNoFolderState(): void {
    const fileTree = document.getElementById('file-tree');
    if (fileTree) {
      fileTree.innerHTML = `
        <div class="no-folder-view">
          <p class="no-folder-desc">尚未打开本地文件夹。<br/>请选择本地磁盘上的项目文件夹开始编写和编译 C++ 代码。</p>
          <button id="btn-empty-open-folder" class="btn-open-folder-primary">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
            <span>选择本地文件夹</span>
          </button>
        </div>
      `;

      document.getElementById('btn-empty-open-folder')?.addEventListener('click', () => {
        this.openFolderAction();
      });
    }

    this.updateEditorWelcomeState(0);
  }

  private setupRoutes(): void {
    this.router
      .on('/', () => {
        this.closeModals();
      })
      .on('/file/:path', (params) => {
        this.closeModals();
        if (params.path && this.fileSystem.hasOpenFolder()) {
          this.fileSystem.readFile(params.path).then((content) => {
            this.editorService.openFile(params.path, content);
          }).catch(console.warn);
        }
      })
      .on('/settings', () => {
        this.openSettingsModal();
      })
      .on('/about', () => {
        this.openAboutModal();
      })
      .notFound(() => {
        this.router.navigate('#/');
      })
      .start();
  }

  private bindEvents(): void {
    document.getElementById('btn-stop')?.addEventListener('click', () => this.interruptExecution());
    // Run Button
    document.getElementById('btn-run')?.addEventListener('click', () => this.runCurrentProject());

    // Run Only (Cached WASM) Button
    document.getElementById('btn-run-only')?.addEventListener('click', () => this.runCachedWasmOnly());

    // Compile Button
    document.getElementById('btn-compile')?.addEventListener('click', () => this.compileCurrentProject());

    // Save Button
    document.getElementById('btn-save')?.addEventListener('click', async () => {
      try { await this.editorService.saveActiveFile(); }
      catch (error: any) { this.logOutput(`[Save failed] ${error.message || error}. Changes remain unsaved.`); }
    });

    // Open Local Folder Buttons
    document.getElementById('btn-open-folder')?.addEventListener('click', () => this.openFolderAction());
    document.getElementById('welcome-open-folder')?.addEventListener('click', () => this.openFolderAction());

    // Settings Button
    document.getElementById('btn-settings')?.addEventListener('click', () => {
      this.router.navigate('#/settings');
    });
    document.getElementById('act-settings')?.addEventListener('click', () => {
      this.router.navigate('#/settings');
    });

    // About Button
    document.getElementById('btn-about')?.addEventListener('click', () => {
      this.router.navigate('#/about');
    });

    // Explorer Header Actions
    document.getElementById('btn-new-file')?.addEventListener('click', () => this.promptCreateFile());
    document.getElementById('btn-new-folder')?.addEventListener('click', () => this.promptCreateFolder());
    document.getElementById('btn-refresh-files')?.addEventListener('click', async () => {
      if (this.fileSystem.hasOpenFolder()) {
        const files = await this.fileSystem.listFiles();
        this.renderFileTree(files);
      }
    });

    // Status Bar Build Mode Toggle
    document.getElementById('status-buildmode')?.addEventListener('click', () => {
      this.settings.buildMode = this.settings.buildMode === 'single' ? 'project' : 'single';
      this.saveSettings();
      this.updateStatus();
      const modeName = this.settings.buildMode === 'single' ? 'Single File Mode (each file has its own main)' : 'Project Mode (all files linked)';
      this.terminalService.writeLine(`\r\n\x1b[36m[Mode Switch] Now in ${modeName}\x1b[0m`);
    });

    // Activity Bar Terminal Icon (Toggle Open / Close)
    document.getElementById('act-terminal')?.addEventListener('click', () => {
      const panel = document.getElementById('bottom-panel');
      const isPanelOpen = panel && !panel.classList.contains('collapsed');
      const actTerm = document.getElementById('act-terminal');

      if (isPanelOpen && this.activePanelTab === 'terminal') {
        panel.classList.add('collapsed');
        actTerm?.classList.remove('active');
      } else {
        this.switchPanelTab('terminal');
        this.terminalService.focus();
        actTerm?.classList.add('active');
      }
    });

    // Panel Tabs Switching
    document.querySelectorAll('.panel-tab').forEach((tabEl) => {
      tabEl.addEventListener('click', (e) => {
        const target = e.currentTarget as HTMLElement;
        const tab = target.dataset.tab as 'terminal' | 'output' | 'problems';
        if (tab) this.switchPanelTab(tab);
      });
    });

    // Panel Controls
    document.getElementById('btn-clear-panel')?.addEventListener('click', () => {
      if (this.activePanelTab === 'terminal') {
        this.terminalService.clear();
      } else if (this.activePanelTab === 'output') {
        this.outputLogs = [];
        const out = document.getElementById('output-container');
        if (out) out.textContent = '';
      }
    });

    document.getElementById('btn-toggle-panel-max')?.addEventListener('click', () => {
      const panel = document.getElementById('bottom-panel');
      panel?.classList.toggle('maximized');
      setTimeout(() => this.terminalService.fit(), 50);
    });

    document.getElementById('btn-close-panel')?.addEventListener('click', () => {
      const panel = document.getElementById('bottom-panel');
      panel?.classList.add('collapsed');
      document.getElementById('act-terminal')?.classList.remove('active');
      setTimeout(() => this.terminalService.fit(), 50);
    });

    // Resizer Divider for Bottom Panel
    const resizer = document.getElementById('panel-resizer');
    const bottomPanel = document.getElementById('bottom-panel');
    if (resizer && bottomPanel) {
      let isResizing = false;
      let startY = 0;
      let startHeight = 0;

      resizer.addEventListener('mousedown', (e) => {
        isResizing = true;
        startY = e.clientY;
        startHeight = bottomPanel.offsetHeight;
        document.body.style.cursor = 'row-resize';
      });

      window.addEventListener('mousemove', (e) => {
        if (!isResizing) return;
        const dy = startY - e.clientY;
        const newHeight = Math.max(80, Math.min(window.innerHeight - 150, startHeight + dy));
        bottomPanel.style.height = `${newHeight}px`;
        this.terminalService.fit();
      });

      window.addEventListener('mouseup', () => {
        if (isResizing) {
          isResizing = false;
          document.body.style.cursor = '';
        }
      });
    }

    // Keyboard Shortcuts: F5 -> Run, Ctrl+F5 -> Run Only, Ctrl+B -> Compile
    window.addEventListener('keydown', (e) => {
      if (e.key === 'F5') {
        e.preventDefault();
        if (e.ctrlKey || e.metaKey || e.shiftKey) {
          this.runCachedWasmOnly();
        } else {
          this.runCurrentProject();
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
        e.preventDefault();
        this.compileCurrentProject();
      }
    });
  }

  private async openFolderAction(): Promise<void> {
    if (this.isExecutingTask || this.emceptionService.isBusy()) return;
    try { await this.editorService.saveAllFiles(); } catch (error) { this.logOutput('[Folder] Save failed; keeping the current folder open.'); return; }
    const ok = await this.fileSystem.openNativeDirectory(async () => {
      await this.editorService.saveAllFiles();
      this.editorService.resetWorkspace();
      this.clangdService.resetWorkspace();
      this.emceptionService.resetWorkspace();
      this.lastOutputPaths.clear();
    });
    if (ok) {
      this.settings.storageMode = 'disk'; this.saveSettings();
      this.logOutput(`[FileSystem] Opened local native folder: "${this.fileSystem.getRootName()}"`);
      const files = await this.fileSystem.listFiles();
      this.renderFileTree(files);

      // Check if folder contains any C++ files
      const cppFile = this.findFirstCppFile(files);
      if (cppFile) {
        const content = await this.fileSystem.readFile(cppFile.path);
        this.editorService.openFile(cppFile.path, content);
        this.clangdService.attachDocument(`file:///${cppFile.path}`, content);
      } else if (files.length === 0) {
        // If folder is completely empty, offer to create main.cpp automatically
        if (confirm('The opened folder is empty. Would you like to create main.cpp with the standard C++ template?')) {
          await this.fileSystem.createFile('main.cpp');
          const content = await this.fileSystem.readFile('main.cpp');
          this.editorService.openFile('main.cpp', content);
          this.clangdService.attachDocument('file:///main.cpp', content);
        }
      }
      void this.warmToolchain();
    }
  }

  private async showCurrentWorkspace(): Promise<void> {
    const files = await this.fileSystem.listFiles(); this.renderFileTree(files);
    const title = document.getElementById('project-name'); if (title) title.textContent = this.fileSystem.getRootName();
    const source = this.findFirstCppFile(files);
    if (source) this.editorService.openFile(source.path, await this.fileSystem.readFile(source.path));
    this.updateStatus();
    void this.warmToolchain();
  }

  private findFirstCppFile(items: FileItem[]): FileItem | null {
    for (const item of items) {
      if (!item.isDirectory) {
        if (item.name.endsWith('.cpp') || item.name.endsWith('.cc') || item.name.endsWith('.cxx')) {
          return item;
        }
      } else if (item.children) {
        const found = this.findFirstCppFile(item.children);
        if (found) return found;
      }
    }
    return null;
  }

  private switchPanelTab(tab: 'terminal' | 'output' | 'problems'): void {
    this.activePanelTab = tab;

    const panel = document.getElementById('bottom-panel');
    panel?.classList.remove('collapsed');

    const actTerminal = document.getElementById('act-terminal');
    if (tab === 'terminal') {
      actTerminal?.classList.add('active');
    } else {
      actTerminal?.classList.remove('active');
    }

    document.querySelectorAll('.panel-tab').forEach((el) => {
      const t = el as HTMLElement;
      if (t.dataset.tab === tab) {
        t.classList.add('active');
      } else {
        t.classList.remove('active');
      }
    });

    document.querySelectorAll('.panel-content').forEach((el) => {
      el.classList.remove('active');
    });

    const activeContent = document.getElementById(`tab-${tab}`);
    activeContent?.classList.add('active');

    if (tab === 'terminal') {
      setTimeout(() => this.terminalService.fit(), 50);
    }
  }

  private logOutput(message: string): void {
    const timestamp = new Date().toLocaleTimeString();
    const formatted = `[${timestamp}] ${message}`;
    this.outputLogs.push(formatted);

    const out = document.getElementById('output-container');
    if (out) {
      out.textContent = this.outputLogs.join('\n');
      out.scrollTop = out.scrollHeight;
    }
  }

  private setExecutionButtonsState(busy: boolean): void {
    const btnRun = document.getElementById('btn-run') as HTMLButtonElement | null;
    const btnRunOnly = document.getElementById('btn-run-only') as HTMLButtonElement | null;
    const btnCompile = document.getElementById('btn-compile') as HTMLButtonElement | null;
    const stop = document.getElementById('btn-stop') as HTMLButtonElement | null;
    if (stop) stop.disabled = !busy;
    if (btnRun) {
      btnRun.disabled = busy;
      btnRun.classList.toggle('disabled', busy);
    }
    if (btnRunOnly) {
      btnRunOnly.disabled = busy;
      btnRunOnly.classList.toggle('disabled', busy);
    }
    if (btnCompile) {
      btnCompile.disabled = busy;
      btnCompile.classList.toggle('disabled', busy);
    }
  }

  private getWasmOutputPath(activePath: string): string {
    const base = activePath.replace(/\.[^/.]+$/, '');
    return this.settings.wasmStorageMode === 'timestamp'
      ? `${base}_${new Date().toISOString().replace(/[-:TZ.]/g, '')}.wasm`
      : `${base}.wasm`;
  }

  private async runCurrentProject(): Promise<void> { await this.buildCurrentProject(true); }
  private async compileCurrentProject(): Promise<void> { await this.buildCurrentProject(false); }

  private beginExecution(): { signal: AbortSignal; end: () => void } | null {
    if (this.isExecutingTask || this.emceptionService.isBusy()) return null;
    this.isExecutingTask = true;
    const controller = this.taskAbort = new AbortController();
    this.setExecutionButtonsState(true);
    this.clangdService.setPaused(true);
    const release = this.terminalService.beginTask(() => this.interruptExecution());
    return { signal: controller.signal, end: () => {
      this.taskAbort = null; this.isExecutingTask = false;
      this.setExecutionButtonsState(false); this.clangdService.setPaused(false); release();
    } };
  }

  private interruptExecution(): void {
    this.taskAbort?.abort();
    this.emceptionService.stop();
  }

  private async buildCurrentProject(run: boolean): Promise<void> {
    if (!this.fileSystem.hasOpenFolder()) { await this.openFolderAction(); return; }
    const activePath = this.editorService.getActivePath();
    if (!activePath) return;
    const task = this.beginExecution(); if (!task) return;
    const progress = progressService.start('build', run ? 'Building & Running...' : 'Compiling...', -1);
    try {
      this.switchPanelTab('terminal'); this.terminalService.focus();
      await abortable(this.editorService.saveAllFiles(), task.signal);
      await abortable(this.fileSystem.flush(), task.signal);
      progress.update(15, 'Reading source files...');
      const allFiles = await abortable(this.fileSystem.getAllFilesContent(activePath, this.settings.buildMode), task.signal);
      task.signal.throwIfAborted();
      Object.assign(allFiles, this.editorService.getDirtyModelsContent());
      progress.update(30, 'Compiling with Clang...');
      const result = await this.emceptionService.compile(activePath, allFiles, {
        standard: this.settings.cxxStandard, optimization: this.settings.optimization,
        buildMode: this.settings.buildMode, outputPath: this.getWasmOutputPath(activePath), signal: task.signal,
      });
      if (result.exitCode === 130 || task.signal.aborted) return;
      const model = this.editorService.getActiveModel();
      if (model) {
        if (result.stderr || result.stdout) this.clangdService.updateMarkersFromCompilerOutput(model, result.stderr || result.stdout);
        else if (result.exitCode === 0) this.clangdService.clearMarkers(model);
      }
      if (result.exitCode !== 0) { this.logOutput(`[Build failed] ${result.stderr}`); return; }
      this.lastOutputPaths.set(activePath, result.outputPath!);
      this.logOutput(`[Build] ${result.outputPath} — ${result.durationMs.toFixed(1)}ms (IndexedDB committed${this.fileSystem.getStorageMode() === 'disk' ? ', disk sync queued' : ', browser storage only'})`);
      if (run) {
        progress.update(80, 'Running program...');
        await this.emceptionService.runWasmBinary(result.outputPath, result.wasmBytes, { signal: task.signal, module: result.wasmModule });
        await this.refreshOpenFiles();
      }
      progress.update(100, 'Done');
      this.renderFileTree(await this.fileSystem.listFiles());
    } catch (error: any) {
      if (error.name !== 'AbortError') {
        this.terminalService.writeLine(`\x1b[31m[Task] ${error.message || error}\x1b[0m`);
        this.logOutput(`[Task failed] ${error.message || error}`);
      }
    } finally { task.end(); progress.done(); }
  }

  private async runCachedWasmOnly(): Promise<void> {
    if (!this.fileSystem.hasOpenFolder()) { await this.openFolderAction(); return; }
    const task = this.beginExecution(); if (!task) return;
    const progress = progressService.start('run-only', 'Loading cached WASM...', -1);
    try {
      this.switchPanelTab('terminal'); this.terminalService.focus();
      await abortable(this.editorService.saveAllFiles(), task.signal);
      progress.update(20, 'Locating WASM binary...');
      const active = this.editorService.getActivePath();
      let target = active ? this.lastOutputPaths.get(active) || active.replace(/\.[^/.]+$/, '') + '.wasm' : 'program.wasm';
      if (!await this.fileSystem.fileExists(target) && active) {
        const parent = active.split('/').slice(0, -1).join('/');
        const base = active.split('/').pop()!.replace(/\.[^.]+$/, '');
        const candidates = (await this.fileSystem.listFiles(parent)).filter((file) => !file.isDirectory && file.name.startsWith(base + '_') && file.name.endsWith('.wasm'));
        candidates.sort((a, b) => b.name.localeCompare(a.name));
        if (candidates[0]) target = candidates[0].path;
      }
      task.signal.throwIfAborted();
      progress.update(50, 'Running program...');
      await this.emceptionService.runWasmBinary(target, undefined, { signal: task.signal });
      await this.refreshOpenFiles();
      progress.update(100, 'Done');
      this.renderFileTree(await this.fileSystem.listFiles());
    } catch (error: any) {
      if (error.name !== 'AbortError') this.terminalService.writeLine(`\x1b[31m[Run] ${error.message || error}\x1b[0m`);
    } finally { task.end(); progress.done(); }
  }

  private async refreshOpenFiles(): Promise<void> {
    for (const tab of this.editorService.getOpenTabs()) if (!tab.isDirty && this.fileSystem.isSourceOrTextFile(tab.name)) {
      try { this.editorService.updateFileFromDisk(tab.path, await this.fileSystem.readFile(tab.path)); } catch { /* Files may have been removed by the program. */ }
    }
  }

  private async runBinaryFromShell(path: string, args: string[]): Promise<void> {
    const task = this.beginExecution(); if (!task) return;
    const progress = progressService.start('run-binary', 'Running program...', -1);
    try {
      await abortable(this.editorService.saveAllFiles(), task.signal);
      await this.emceptionService.runWasmBinary(path, undefined, { signal: task.signal, args, cwd: this.terminalService.getCwd() });
      await this.refreshOpenFiles();
      progress.update(100, 'Done');
      this.renderFileTree(await this.fileSystem.listFiles());
    } catch (error: any) {
      if (error.name !== 'AbortError') this.terminalService.writeLine('Run failed: ' + (error.message || error));
    } finally { task.end(); progress.done(); }
  }

  private resolveCwdPath(inputPath: string): string {
    const cwd = this.terminalService.getCwd();
    const clean = inputPath.trim().replace(/^[\/\\]+/, '');
    if (!clean || clean === '.') {
      return cwd;
    }
    if (clean === '~' || clean === '/') {
      return '';
    }
    if (clean === '..') {
      const parts = cwd.split('/').filter(Boolean);
      parts.pop();
      return parts.join('/');
    }
    if (clean.startsWith('../') || clean.includes('/..')) {
      const parts = (cwd ? cwd.split('/') : []).concat(clean.split('/'));
      const resolved: string[] = [];
      for (const p of parts) {
        if (p === '..') resolved.pop();
        else if (p && p !== '.') resolved.push(p);
      }
      return resolved.join('/');
    }
    return cwd ? `${cwd}/${clean}` : clean;
  }

  private async handleTerminalCommand(cmd: string, args: string[]): Promise<void> {
    await this.shellService.executeCommandLine([cmd, ...args].join(' '));
  }

  private renderTabs(tabs: OpenTab[], activePath: string | null): void {
    const tabsBar = document.getElementById('tabs-bar');
    if (!tabsBar) return;

    tabsBar.innerHTML = '';

    tabs.forEach((tab) => {
      const tabEl = document.createElement('div');
      tabEl.className = `tab-item ${tab.path === activePath ? 'active' : ''} ${tab.isDirty ? 'dirty' : ''}`;

      const iconSvg = this.getFileIconSvg(tab.name);

      tabEl.innerHTML = `
        ${iconSvg}
        <span class="tab-name">${tab.name}</span>
        <span class="tab-dirty-indicator"></span>
        <button class="tab-close-btn" title="Close (Ctrl+W)">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      `;

      tabEl.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        if (target.closest('.tab-close-btn')) {
          e.stopPropagation();
          this.editorService.closeTab(tab.path);
        } else {
          this.editorService.openFile(tab.path, tab.content);
          this.router.navigate(`#/file/${encodeURIComponent(tab.path)}`);
        }
      });

      tabsBar.appendChild(tabEl);
    });
  }

  private renderFileTree(items: FileItem[]): void {
    const container = document.getElementById('file-tree');
    if (!container) return;

    container.innerHTML = '';
    if (items.length === 0) {
      if (!this.fileSystem.hasOpenFolder()) {
        this.renderNoFolderState();
      } else {
        container.innerHTML = `<div style="padding: 16px; color: #858585; font-size: 12px; text-align: center;">Folder is empty.<br/>Click "+" to create a C++ file.</div>`;
      }
      return;
    }

    this.renderTreeNodes(items, container, 0);
  }

  private renderTreeNodes(items: FileItem[], parentEl: HTMLElement, level: number): void {
    const activePath = this.editorService.getActivePath();

    items.forEach((item) => {
      const nodeEl = document.createElement('div');
      nodeEl.className = `tree-node ${item.path === activePath ? 'active' : ''}`;
      nodeEl.style.paddingLeft = `${level * 14 + 10}px`;

      const chevronSvg = item.isDirectory
        ? `<span class="tree-chevron"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${item.isExpanded ? '<path d="m6 9 6 6 6-6"/>' : '<path d="m9 18 6-6-6-6"/>'}</svg></span>`
        : '<span class="tree-chevron"></span>';

      const iconSvg = item.isDirectory
        ? `<span class="tree-icon icon-folder"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg></span>`
        : `<span class="tree-icon">${this.getFileIconSvg(item.name)}</span>`;

      nodeEl.innerHTML = `
        ${chevronSvg}
        ${iconSvg}
        <span class="tree-name">${item.name}</span>
        <div class="tree-actions">
          <button class="tree-action-btn btn-export-file" title="Export to external file system">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          </button>
          <button class="tree-action-btn btn-delete-file" title="Delete">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>
      `;

      nodeEl.addEventListener('click', async (e) => {
        const target = e.target as HTMLElement;
        if (target.closest('.btn-delete-file')) {
          e.stopPropagation();
            if (confirm(`Delete "${item.name}"?`)) {
              try {
                await this.editorService.closeTabsUnder(item.path);
                await this.fileSystem.deleteFile(item.path);
              } catch (error: any) { this.logOutput(`[Delete] ${error.message || error}`); }
            }
          return;
        }
        if (target.closest('.btn-export-file')) {
          e.stopPropagation();
          if (!item.isDirectory) {
            await this.exportFile(item.path);
          }
          return;
        }

        if (item.isDirectory) {
          item.isExpanded = !item.isExpanded;
          const files = await this.fileSystem.listFiles();
          this.renderFileTree(files);
        } else {
          const content = await this.fileSystem.readFile(item.path);
          this.editorService.openFile(item.path, content);
          this.router.navigate(`#/file/${encodeURIComponent(item.path)}`);
          this.clangdService.attachDocument(`file:///${item.path}`, content);
        }
      });

      parentEl.appendChild(nodeEl);

      if (item.isDirectory && item.isExpanded && item.children) {
        this.renderTreeNodes(item.children, parentEl, level + 1);
      }
    });
  }

  private updateBreadcrumbs(activePath: string | null): void {
    const rootEl = document.getElementById('breadcrumb-root');
    const fileEl = document.getElementById('breadcrumb-file');
    if (rootEl) rootEl.textContent = this.fileSystem.getRootName();
    if (fileEl) fileEl.textContent = activePath || (this.fileSystem.hasOpenFolder() ? 'No file open' : 'Open folder to start');
  }

  private renderDiagnostics(items: DiagnosticItem[]): void {
    const badge = document.getElementById('badge-problems');
    const container = document.getElementById('problems-container');
    const errCount = document.getElementById('status-error-count');
    const warnCount = document.getElementById('status-warning-count');

    const errors = items.filter((i) => i.severity === 'error').length;
    const warnings = items.filter((i) => i.severity === 'warning').length;

    if (badge) {
      badge.textContent = String(items.length);
      badge.className = `badge ${errors > 0 ? 'badge-error' : warnings > 0 ? 'badge-warning' : ''}`;
    }

    if (errCount) errCount.textContent = String(errors);
    if (warnCount) warnCount.textContent = String(warnings);

    if (!container) return;

    if (items.length === 0) {
      container.innerHTML = `<div style="padding: 16px; color: #858585; text-align: center;">No problems detected in workspace</div>`;
      return;
    }

    container.innerHTML = items
      .map(
        (item) => `
        <div class="problem-item" data-file="${item.file}" data-line="${item.line}">
          <span class="problem-icon ${item.severity}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              ${item.severity === 'error' ? '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>' : '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>'}
            </svg>
          </span>
          <span class="problem-msg">${item.message}</span>
          <span class="problem-loc">${item.file} [${item.line}, ${item.column}]</span>
        </div>
      `
      )
      .join('');

    container.querySelectorAll('.problem-item').forEach((el) => {
      el.addEventListener('click', (e) => {
        const target = e.currentTarget as HTMLElement;
        const line = parseInt(target.dataset.line || '1', 10);
        const editor = this.editorService.getEditor();
        if (editor) {
          editor.revealLineInCenter(line);
          editor.setPosition({ lineNumber: line, column: 1 });
          editor.focus();
        }
      });
    });
  }

  private updateStatus(): void {
    const clangdStatus = this.clangdService.getStatusText();
    const clangdEl = document.getElementById('status-clangd-label');
    if (clangdEl) {
      clangdEl.textContent = clangdStatus.label;
      const parent = clangdEl.parentElement;
      if (parent) parent.title = clangdStatus.details;
    }

    const stdEl = document.getElementById('status-std');
    if (stdEl) {
      stdEl.textContent = this.settings.cxxStandard.toUpperCase();
    }

    const modeEl = document.getElementById('status-buildmode-text');
    if (modeEl) {
      modeEl.textContent = this.settings.buildMode === 'single' ? 'Mode: Single File' : 'Mode: Project';
    }

    const autoSaveEl = document.getElementById('status-autosave');
    if (autoSaveEl) {
      autoSaveEl.textContent = this.settings.autoSave ? 'Auto-Save: On' : 'Auto-Save: Off';
    }
    const storage = this.fileSystem.io.storageStatus, storageEl = document.getElementById('status-storage');
    if (storageEl) {
      storageEl.textContent = storage.mode === 'browser' ? 'IndexedDB only' : storage.error ? 'Disk sync failed — retry' : storage.pending ? `Disk sync: ${storage.pending} pending` : 'Disk synced';
      storageEl.title = storage.error || (storage.mode === 'browser' ? '无需存储磁盘：文件只保存在此浏览器的 IndexedDB。清除站点数据会删除文件。' : '写入已先保存至 IndexedDB；点击立即同步到外部磁盘。');
    }
  }

  private getFileIconSvg(filename: string): string {
    const ext = filename.split('.').pop()?.toLowerCase();
    switch (ext) {
      case 'cpp':
      case 'cc':
      case 'cxx':
        return `<svg class="tree-icon icon-cpp" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm1 14.5a3.5 3.5 0 0 1-3.5-3.5 3.5 3.5 0 0 1 3.5-3.5 3.5 3.5 0 0 1 2.5 1.05l-1.4 1.4A1.5 1.5 0 0 0 13 11a1.5 1.5 0 0 0-1.5 1.5 1.5 1.5 0 0 0 1.5 1.5 1.5 1.5 0 0 0 1.1-.45l1.4 1.4A3.5 3.5 0 0 1 13 16.5z"/></svg>`;
      case 'h':
      case 'hpp':
        return `<svg class="tree-icon icon-h" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm3 13h-2v-3h-2v3H9V9h2v3h2V9h2z"/></svg>`;
      case 'wasm':
        return `<svg class="tree-icon icon-wasm" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>`;
      case 'md':
        return `<svg class="tree-icon icon-doc" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
      default:
        return `<svg class="tree-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>`;
    }
  }

  private promptCreateFile(): void {
    if (!this.fileSystem.hasOpenFolder()) {
      alert('请先打开一个本地文件夹，再创建文件。');
      this.openFolderAction();
      return;
    }

    const modal = document.getElementById('modal-container');
    if (!modal) return;

    modal.innerHTML = `
      <div class="modal-overlay">
        <div class="modal-card">
          <div class="modal-header">
            <span>New C++ File</span>
            <button class="icon-btn btn-modal-close"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
          </div>
          <div class="modal-body">
            <div class="form-group">
              <label class="form-label">File name (e.g. main.cpp, calculator.cpp, helper.h)</label>
              <span class="form-desc">C++ files (.cpp, .cc) automatically receive standard template with std::cout and main().</span>
              <input type="text" id="input-new-filename" class="prompt-input" placeholder="main.cpp" autofocus />
            </div>
          </div>
          <div class="modal-footer">
            <button class="action-btn btn-modal-cancel">Cancel</button>
            <button id="btn-confirm-create-file" class="action-btn btn-run">Create File</button>
          </div>
        </div>
      </div>
    `;

    const input = document.getElementById('input-new-filename') as HTMLInputElement;
    input?.focus();

    const doCreate = async () => {
      const name = input?.value.trim();
      if (!name) return;

      // Close modal immediately so UI is never stuck!
      this.closeModals();

      const template = this.fileSystem.getDefaultTemplateForFile(name);
      // Immediately open tab and attach language server without waiting for disk I/O
      this.editorService.openFile(name, template);
      this.clangdService.attachDocument(`file:///${name}`, template);
      this.router.navigate(`#/file/${encodeURIComponent(name)}`);

      // Write to disk in background
      try {
        await this.fileSystem.createFile(name, template);
      } catch (err: any) {
        console.warn('Failed to write new file to disk:', err);
      }
    };

    document.getElementById('btn-confirm-create-file')?.addEventListener('click', doCreate);
    input?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doCreate();
      if (e.key === 'Escape') this.closeModals();
    });

    modal.querySelectorAll('.btn-modal-close, .btn-modal-cancel').forEach((b) => {
      b.addEventListener('click', () => this.closeModals());
    });
  }

  private promptCreateFolder(): void {
    if (!this.fileSystem.hasOpenFolder()) {
      alert('请先打开一个本地文件夹，再创建子文件夹。');
      this.openFolderAction();
      return;
    }

    const modal = document.getElementById('modal-container');
    if (!modal) return;

    modal.innerHTML = `
      <div class="modal-overlay">
        <div class="modal-card">
          <div class="modal-header">
            <span>New Folder</span>
            <button class="icon-btn btn-modal-close"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
          </div>
          <div class="modal-body">
            <div class="form-group">
              <label class="form-label">Folder name</label>
              <input type="text" id="input-new-foldername" class="prompt-input" placeholder="src" autofocus />
            </div>
          </div>
          <div class="modal-footer">
            <button class="action-btn btn-modal-cancel">Cancel</button>
            <button id="btn-confirm-create-folder" class="action-btn btn-run">Create Folder</button>
          </div>
        </div>
      </div>
    `;

    const input = document.getElementById('input-new-foldername') as HTMLInputElement;
    input?.focus();

    const doCreate = async () => {
      const name = input?.value.trim();
      if (name) {
        await this.fileSystem.createDirectory(name);
        this.closeModals();
      }
    };

    document.getElementById('btn-confirm-create-folder')?.addEventListener('click', doCreate);
    input?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doCreate();
      if (e.key === 'Escape') this.closeModals();
    });

    modal.querySelectorAll('.btn-modal-close, .btn-modal-cancel').forEach((b) => {
      b.addEventListener('click', () => this.closeModals());
    });
  }

  private async exportFile(filePath: string): Promise<void> {
    try {
      const bytes = await this.fileSystem.readBinaryFile(filePath);
      const name = filePath.split('/').pop() || 'export.bin';
      // Try File System Access API save picker first
      const savePicker = (window as any).showSaveFilePicker;
      if (savePicker) {
        try {
          const handle = await savePicker({ suggestedName: name });
          const writable = await handle.createWritable();
          await writable.write(bytes);
          await writable.close();
          this.logOutput(`[Export] Saved "${filePath}" to external file system as "${handle.name}".`);
          return;
        } catch (e: any) {
          if (e.name === 'AbortError') return;
          // Fall through to download fallback
        }
      }
      // Fallback: trigger browser download
      const blob = new Blob([bytes.buffer as ArrayBuffer], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      this.logOutput(`[Export] Downloaded "${filePath}" as "${name}".`);
    } catch (error: any) {
      this.logOutput(`[Export] Failed: ${error.message || error}`);
    }
  }

  private openSettingsModal(): void {
    const modal = document.getElementById('modal-container');
    if (!modal) return;

    modal.innerHTML = `
      <div class="modal-overlay">
        <div class="modal-card">
          <div class="modal-header">
            <span>Editor & Compiler Settings</span>
            <button class="icon-btn btn-modal-close"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
          </div>
          <div class="modal-body">
            <div class="form-group">
              <label class="form-label">编译模式 (Build Mode)</label>
              <span class="form-desc">单文件模式仅编译当前打开的文件，允许每个文件拥有独立的 main() 函数；工程模式联合编译所有 .cpp 源码。</span>
              <select id="setting-build-mode" class="form-control">
                <option value="single" ${this.settings.buildMode === 'single' ? 'selected' : ''}>单文件独立模式 (Single File - Recommended)</option>
                <option value="project" ${this.settings.buildMode === 'project' ? 'selected' : ''}>多文件工程模式 (Project Mode)</option>
              </select>
            </div>

            <div class="form-group">
              <label class="form-label" for="setting-storage-mode">文件存储模式 (File Storage)</label>
              <span class="form-desc">本地模式先保存到 IndexedDB，再合并异步写盘；无需存储磁盘模式使用独立浏览器工作区，不自动迁移本地文件。清除站点数据会删除浏览器工作区及未同步的数据。</span>
              <select id="setting-storage-mode" class="form-control">
                <option value="disk" ${this.settings.storageMode === 'disk' ? 'selected' : ''}>本地磁盘 + IndexedDB 写回缓存（推荐）</option>
                <option value="browser" ${this.settings.storageMode === 'browser' ? 'selected' : ''}>无需存储磁盘（仅 IndexedDB）</option>
              </select>
            </div>

            <div class="form-group">
              <label class="form-label">WASM 二进制导出方式 (WASM Storage Mode)</label>
              <span class="form-desc">编译成功后将 .wasm 保存到当前工作区；本地模式后台异步写盘。</span>
              <select id="setting-wasm-storage" class="form-control">
                <option value="overwrite" ${this.settings.wasmStorageMode === 'overwrite' ? 'selected' : ''}>覆盖存储 (如 main.wasm - 推荐)</option>
                <option value="timestamp" ${this.settings.wasmStorageMode === 'timestamp' ? 'selected' : ''}>按时间戳存储 (如 main_20261107_0850.wasm)</option>
              </select>
            </div>

            <div class="form-group">
              <label class="form-label">自动保存 (Auto-Save)</label>
              <span class="form-desc">停止编辑 800ms 后合并保存；IndexedDB 事务成功后移除未保存标记，外部磁盘同步状态单独显示。点击底部磁盘状态可立即同步。</span>
              <select id="setting-auto-save" class="form-control">
                <option value="true" ${this.settings.autoSave ? 'selected' : ''}>开启 (Auto-Save On - Recommended)</option>
                <option value="false" ${!this.settings.autoSave ? 'selected' : ''}>关闭 (仅按 Ctrl+S 手动保存)</option>
              </select>
            </div>

            <div class="form-group">
              <label class="form-label">C++ Language Standard</label>
              <select id="setting-cxx-std" class="form-control">
                <option value="c++11" ${this.settings.cxxStandard === 'c++11' ? 'selected' : ''}>C++11</option>
                <option value="c++14" ${this.settings.cxxStandard === 'c++14' ? 'selected' : ''}>C++14 (NOIP / Classic)</option>
                <option value="c++17" ${this.settings.cxxStandard === 'c++17' ? 'selected' : ''}>C++17</option>
                <option value="c++20" ${this.settings.cxxStandard === 'c++20' ? 'selected' : ''}>C++20 (Recommended)</option>
                <option value="c++23" ${this.settings.cxxStandard === 'c++23' ? 'selected' : ''}>C++23</option>
              </select>
            </div>

            <div class="form-group">
              <label class="form-label">Compiler Optimization Flag</label>
              <select id="setting-opt" class="form-control">
                <option value="-O0" ${this.settings.optimization === '-O0' ? 'selected' : ''}>-O0 (Fast Build, No Optimization — Default)</option>
                <option value="-O1" ${this.settings.optimization === '-O1' ? 'selected' : ''}>-O1 (Balanced Build Time & Runtime Speed)</option>
                <option value="-O2" ${this.settings.optimization === '-O2' ? 'selected' : ''}>-O2 (Release Optimization, Slower Build)</option>
                <option value="-O3" ${this.settings.optimization === '-O3' ? 'selected' : ''}>-O3 (Aggressive Optimization)</option>
              </select>
            </div>

            <div class="form-group">
              <label class="form-label">Font Size</label>
              <input type="number" id="setting-fontsize" class="form-control" value="${this.settings.fontSize}" min="10" max="32" />
            </div>

            <div class="form-group">
              <label class="form-label">Tab Size</label>
              <select id="setting-tabsize" class="form-control">
                <option value="2" ${this.settings.tabSize === 2 ? 'selected' : ''}>2 spaces</option>
                <option value="4" ${this.settings.tabSize === 4 ? 'selected' : ''}>4 spaces</option>
              </select>
            </div>

            <div class="form-group">
              <label class="form-label">Minimap</label>
              <select id="setting-minimap" class="form-control">
                <option value="true" ${this.settings.minimap ? 'selected' : ''}>Enabled</option>
                <option value="false" ${!this.settings.minimap ? 'selected' : ''}>Disabled</option>
              </select>
            </div>

            <div class="form-group">
              <label class="form-label">清理空间 (Storage Cleanup)</label>
              <span class="form-desc">清理构建缓存（WASM、.o 文件等）或全部 IndexedDB 内容。不会影响已导出文件和本地文件系统。</span>
              <div class="cleanup-section" style="display:flex;gap:8px;flex-wrap:wrap;">
                <button id="btn-clear-cache" class="cleanup-btn btn-clear-cache" title="Delete .wasm, .o, .a and build cache from IndexedDB">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                  <span>清理构建缓存</span>
                </button>
                <button id="btn-clear-all-storage" class="cleanup-btn btn-clear-all" title="Delete ALL IndexedDB data (files, cache, settings remain)">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg>
                  <span>清空全部 IndexedDB</span>
                </button>
              </div>
            </div>
          </div>
          <div class="modal-footer">
            <button id="btn-save-settings" class="action-btn btn-run">Save & Apply</button>
          </div>
        </div>
      </div>
    `;

    document.getElementById('btn-save-settings')?.addEventListener('click', async () => {
      if (this.isExecutingTask || this.emceptionService.isBusy()) { alert('请等待或中断当前任务后再修改设置。'); return; }
      const storageMode = (document.getElementById('setting-storage-mode') as HTMLSelectElement).value as 'disk' | 'browser';
      const bm = (document.getElementById('setting-build-mode') as HTMLSelectElement).value as any;
      const wsm = (document.getElementById('setting-wasm-storage') as HTMLSelectElement).value as any;
      const as = (document.getElementById('setting-auto-save') as HTMLSelectElement).value === 'true';
      const std = (document.getElementById('setting-cxx-std') as HTMLSelectElement).value as any;
      const opt = (document.getElementById('setting-opt') as HTMLSelectElement).value as any;
      const fz = parseInt((document.getElementById('setting-fontsize') as HTMLInputElement).value, 10);
      const tab = parseInt((document.getElementById('setting-tabsize') as HTMLSelectElement).value, 10);
      const mm = (document.getElementById('setting-minimap') as HTMLSelectElement).value === 'true';
      const saveButton = document.getElementById('btn-save-settings') as HTMLButtonElement;
      saveButton.disabled = true;
      this.isExecutingTask = true; this.editorService.getEditor()?.updateOptions({ readOnly: true });
      try {
        if (storageMode !== this.fileSystem.getStorageMode()) {
          await this.editorService.saveAllFiles();
          if (storageMode === 'browser') await this.fileSystem.useBrowserStorage();
          else if (!await this.fileSystem.openNativeDirectory()) return;
          this.editorService.resetWorkspace(); this.clangdService.resetWorkspace(); this.emceptionService.resetWorkspace(); this.lastOutputPaths.clear();
          await this.showCurrentWorkspace();
        }
      } catch (error: any) { alert('切换存储失败，原工作区保留：' + error.message); return; }
      finally { saveButton.disabled = false; this.isExecutingTask = false; this.editorService.getEditor()?.updateOptions({ readOnly: false }); }


      this.settings.buildMode = bm;
      this.settings.storageMode = storageMode;
      this.settings.wasmStorageMode = wsm;
      this.settings.autoSave = as;
      this.settings.cxxStandard = std;
      this.settings.optimization = opt;
      localStorage.setItem('onlinecpp_opt_explicit', 'true');
      this.settings.fontSize = fz || 14;
      this.settings.tabSize = tab || 4;
      this.settings.minimap = mm;

      this.saveSettings();
      this.updateStatus();
      this.closeModals();
    });

    modal.querySelectorAll('.btn-modal-close').forEach((b) => {
      b.addEventListener('click', () => this.closeModals());
    });

    // Cleanup: Clear Build Cache
    document.getElementById('btn-clear-cache')?.addEventListener('click', async () => {
      if (this.isExecutingTask || this.emceptionService.isBusy()) { alert('请等待或中断当前任务后再清理。'); return; }
      if (!confirm('确认清理构建缓存？将删除 .wasm、.o、.a 等构建产物和 .onlinecpp 缓存目录。源代码文件不受影响。')) return;
      const task = progressService.start('clear-cache', 'Cleaning build cache...', -1);
      try {
        await this.fileSystem.clearCache();
        const files = await this.fileSystem.listFiles();
        this.renderFileTree(files);
        this.logOutput('[Cleanup] Build cache cleared (.wasm, .o, .onlinecpp/* removed).');
        this.terminalService.writeLine('\x1b[32m[Cleanup] Build cache cleared.\x1b[0m');
      } catch (error: any) {
        this.logOutput(`[Cleanup] Failed: ${error.message || error}`);
        alert('清理失败: ' + error.message);
      } finally { task.done(); }
    });

    // Cleanup: Clear All IndexedDB
    document.getElementById('btn-clear-all-storage')?.addEventListener('click', async () => {
      if (this.isExecutingTask || this.emceptionService.isBusy()) { alert('请等待或中断当前任务后再清理。'); return; }
      if (!confirm('⚠️ 确认清空全部 IndexedDB 数据？这将删除浏览器中存储的所有文件、缓存和构建产物。\n\n不会影响:\n• 已导出到外部文件系统的文件\n• 本地磁盘上的文件\n• 编辑器设置\n\n此操作不可撤销！')) return;
      if (!confirm('再次确认：真的要清空全部 IndexedDB 数据吗？')) return;
      const task = progressService.start('clear-all', 'Clearing all IndexedDB storage...', -1);
      try {
        await this.editorService.saveAllFiles();
        await this.fileSystem.clearAllStorage();
        this.emceptionService.resetWorkspace();
        this.editorService.resetWorkspace();
        this.clangdService.resetWorkspace();
        this.lastOutputPaths.clear();
        const files = await this.fileSystem.listFiles();
        this.renderFileTree(files);
        this.logOutput('[Cleanup] All IndexedDB storage cleared.');
        this.terminalService.writeLine('\x1b[32m[Cleanup] All IndexedDB storage cleared.\x1b[0m');
      } catch (error: any) {
        this.logOutput(`[Cleanup] Failed: ${error.message || error}`);
        alert('清理失败: ' + error.message);
      } finally { task.done(); }
    });
  }

  private openAboutModal(): void {
    const modal = document.getElementById('modal-container');
    if (!modal) return;

    modal.innerHTML = `
      <div class="modal-overlay">
        <div class="modal-card">
          <div class="modal-header">
            <span>About Online C++ Studio</span>
            <button class="icon-btn btn-modal-close"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
          </div>
          <div class="modal-body" style="line-height: 1.6; font-size: 13px;">
            <p><strong>Online C++ Studio</strong> is a complete, native-grade C++ development environment running client-side inside the browser.</p>
            <div style="background: #202020; padding: 12px; border-radius: 4px; border: 1px solid #333;">
              <p><strong>Integrated Architecture:</strong></p>
              <ul style="margin-left: 20px; margin-top: 6px;">
                <li><strong>Monaco Editor:</strong> VS Code's editor engine with syntax highlighting, shortcuts, and code formatting.</li>
                <li><strong>Clangd WASM:</strong> Real-time C++ language server intelligence, autocompletion, hover docs, and diagnostics.</li>
                <li><strong>Local File API:</strong> Direct local folder access via the standard File System Access API.</li>
                <li><strong>Xterm.js:</strong> Interactive terminal emulator with full command system and ANSI color support.</li>
                <li><strong>Emception:</strong> In-browser Clang/wasm-ld compiler targeting WebAssembly with C++20 and standard library support.</li>
                <li><strong>WASM Runner:</strong> Direct execution of compiled WebAssembly binaries with real-time stdin/stdout piped to xterm!</li>
              </ul>
            </div>
            <p style="color: #999; font-size: 12px; margin-top: 8px;">Shortcuts: <kbd style="background:#333;padding:2px 6px;border-radius:3px;">F5</kbd> Build & Run, <kbd style="background:#333;padding:2px 6px;border-radius:3px;">Ctrl+F5</kbd> Run Only, <kbd style="background:#333;padding:2px 6px;border-radius:3px;">Ctrl+B</kbd> Compile, <kbd style="background:#333;padding:2px 6px;border-radius:3px;">Ctrl+S</kbd> Save.</p>
          </div>
          <div class="modal-footer">
            <button class="action-btn btn-run btn-modal-close">Close</button>
          </div>
        </div>
      </div>
    `;

    modal.querySelectorAll('.btn-modal-close').forEach((b) => {
      b.addEventListener('click', () => this.closeModals());
    });
  }

  private closeModals(): void {
    const modal = document.getElementById('modal-container');
    if (modal) modal.innerHTML = '';
    if (window.location.hash === '#/settings' || window.location.hash === '#/about') {
      window.location.hash = '#/';
    }
  }
}

// Bootstrap application on DOM load
window.addEventListener('DOMContentLoaded', () => {
  new OnlineCppIDE();
});
