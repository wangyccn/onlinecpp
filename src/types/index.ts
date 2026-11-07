export interface FileItem {
  name: string;
  path: string;
  isDirectory: boolean;
  content?: string;
  handle?: FileSystemFileHandle | FileSystemDirectoryHandle;
  children?: FileItem[];
  isExpanded?: boolean;
}

export interface OpenTab {
  path: string;
  name: string;
  isDirty: boolean;
  content: string;
}

export interface DiagnosticItem {
  file: string;
  line: number;
  column: number;
  message: string;
  severity: 'error' | 'warning' | 'info';
}

export interface CompilerResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  outputPath?: string;
  wasmBytes?: Uint8Array;
  durationMs: number;
}

export interface EditorSettings {
  fontSize: number;
  tabSize: number;
  minimap: boolean;
  wordWrap: 'on' | 'off';
  cxxStandard: 'c++11' | 'c++14' | 'c++17' | 'c++20' | 'c++23';
  optimization: '-O0' | '-O1' | '-O2' | '-O3';
  enableClangd: boolean;
  autoSave: boolean;
  wasmStorageMode: 'overwrite' | 'timestamp';
  buildMode: 'single' | 'project';
}
