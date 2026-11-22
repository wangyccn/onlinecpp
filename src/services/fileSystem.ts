import { FileItem } from '../types';
import { NativeIO, NativeEntry, NativeStat, type StorageMode } from './nativeIO';
import { WriteQueue } from './writeQueue';
import { cleanNativePath } from './localPaths';

export class FileSystemService {
  private rootDirHandle: FileSystemDirectoryHandle | null = null;
  private rootName = '';
  private browserWorkspace = false;
  private onFilesChangedCallbacks: Array<(items: FileItem[]) => void> = [];
  public readonly io = new NativeIO();
  private writes = new WriteQueue<Uint8Array | string>((path, data) => this.io.request('write', path, data));
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;

  public flush(): Promise<void> { return this.writes.flush(); }
  public async syncToDisk(): Promise<void> { await this.flush(); await this.io.request('flushDisk', ''); }
  public async clearAllStorage(): Promise<void> { await this.flush(); await this.io.request('clearAll', ''); await this.refreshSoon(); }
  public async clearCache(): Promise<void> { await this.flush(); await this.io.request('clearCache', ''); await this.refreshSoon(); }
  public getStorageMode(): StorageMode { return this.browserWorkspace ? 'browser' : 'disk'; }
  public async useBrowserStorage(): Promise<void> {
    await this.flush(); await this.io.mount(null);
    this.browserWorkspace = true; this.rootName = 'Browser Workspace (IndexedDB)';
    this.notifyFilesChanged(await this.listFiles());
  }

  private refreshSoon(): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.listFiles().then((items) => this.notifyFilesChanged(items)).catch(console.warn);
    }, 200);
  }

  public hasOpenFolder(): boolean {
    return this.browserWorkspace || this.rootDirHandle !== null;
  }

  public getRootName(): string {
    return this.rootName || 'No Folder Opened';
  }

  public async mountDirectory(handle: FileSystemDirectoryHandle): Promise<void> {
    await this.flush(); await this.io.mount(handle);
    this.browserWorkspace = false; this.rootDirHandle = handle; this.rootName = handle.name;
  }

  public onFilesChanged(callback: (items: FileItem[]) => void): () => void {
    this.onFilesChangedCallbacks.push(callback);
    return () => {
      this.onFilesChangedCallbacks = this.onFilesChangedCallbacks.filter((c) => c !== callback);
    };
  }

  private notifyFilesChanged(items: FileItem[]): void {
    for (const cb of this.onFilesChangedCallbacks) {
      cb(items);
    }
  }

  public async openNativeDirectory(beforeMount?: () => Promise<void>): Promise<boolean> {
    const showPicker = (window as any).showDirectoryPicker;
    if (!showPicker) {
      alert('Your browser does not support the File System Access API (window.showDirectoryPicker). Please use Chrome, Edge, or Opera.');
      return false;
    }

    try {
      const dirHandle = await showPicker({
        mode: 'readwrite',
      });
      await beforeMount?.();
      await this.mountDirectory(dirHandle);
      const files = await this.listFiles();
      this.notifyFilesChanged(files);
      return true;
    } catch (e: any) {
      if (e.name !== 'AbortError') {
        console.error('Error opening local directory:', e);
        alert('Failed to open folder: ' + e.message);
      }
      return false;
    }
  }

  public async listFiles(targetDir = ''): Promise<FileItem[]> {
    if (!this.hasOpenFolder()) {
      return [];
    }

    const clean = targetDir.replace(/^\/+|\/+$/g, '');
    if (!clean) {
      return await this.readDirectoryRecursively('');
    }

    return await this.readDirectoryRecursively(clean);
  }

  public async resolveDirectoryHandle(
    dirPath: string
  ): Promise<FileSystemDirectoryHandle | null> {
    if (this.browserWorkspace || !this.rootDirHandle) return null;
    const clean = dirPath.replace(/^\/+|\/+$/g, '');
    if (!clean || clean === '.') return this.rootDirHandle;
    const segments = clean.split('/').filter(Boolean);
    let currentDir = this.rootDirHandle;
    try {
      for (const seg of segments) {
        currentDir = await currentDir.getDirectoryHandle(seg, { create: false });
      }
      return currentDir;
    } catch {
      return null;
    }
  }

  public async directoryExists(dirPath: string): Promise<boolean> {
    return (await this.io.request<NativeStat | null>('stat', dirPath))?.kind === 'directory';
  }

  public async fileExists(filePath: string): Promise<boolean> {
    return (await this.io.request<NativeStat | null>('stat', filePath))?.kind === 'file';
  }

  public async getFileMetadata(filePath: string): Promise<{ size: number; lastModified: number } | null> {
    try {
      const file = await this.io.request<NativeStat | null>('stat', filePath);
      if (!file || file.kind !== 'file') return null;
      return {
        size: file.size,
        lastModified: file.lastModified,
      };
    } catch {
      return null;
    }
  }

  private readonly IGNORED_NAMES = new Set([
    'node_modules', 'build', 'dist', 'out', 'target', '.git', '.idea', '.vscode',
    'cmake-build-debug', 'cmake-build-release', '__pycache__', 'bin', 'obj', '.gemini',
    '.system_generated', '.cache', '.pnpm-store'
  ]);

  public shouldIgnoreName(name: string): boolean {
    if (!name) return true;
    if (name.startsWith('.') || name.startsWith('~')) return true;
    // Chromium File System Access API atomic swap files (e.g. main.cpp.1.crswap)
    if (name.includes('.crswap') || name.endsWith('.tmp') || name.endsWith('.swp') || name.endsWith('.bak')) {
      return true;
    }
    if (this.IGNORED_NAMES.has(name)) return true;
    return false;
  }

  private async readDirectoryRecursively(
    relativeDir: string,
    depth = 0
  ): Promise<FileItem[]> {
    if (depth > 6) return [];
    const items: FileItem[] = [];

    try {
      const entries = await this.io.request<NativeEntry[]>('list', relativeDir);
      for (const { name, kind } of entries) {
        if (this.shouldIgnoreName(name)) {
          continue;
        }
        const itemPath = relativeDir ? `${relativeDir}/${name}` : name;
        if (kind === 'directory') {
          const children = await this.readDirectoryRecursively(
            itemPath,
            depth + 1
          );
          items.push({
            name,
            path: itemPath,
            isDirectory: true,
            isExpanded: true,
            children,
          });
        } else {
          items.push({
            name,
            path: itemPath,
            isDirectory: false,
          });
        }
      }
    } catch (e) {
      console.warn(`Error reading directory ${relativeDir}:`, e);
    }

    // Sort folders first, then files alphabetically
    items.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name);
    });

    return items;
  }

  public async readFile(filePath: string): Promise<string> {
    return new TextDecoder().decode(await this.readBinaryFile(filePath));
  }

  public async readBinaryFile(filePath: string): Promise<Uint8Array> {
    return this.io.request<Uint8Array>('read', filePath);
  }

  public async copyFile(srcPath: string, destPath: string): Promise<void> {
    const data = await this.readBinaryFile(srcPath);
    await this.writeBinaryFile(destPath, data);
  }

  public async copyDirectory(srcDir: string, destDir: string): Promise<void> {
    srcDir = cleanNativePath(srcDir); destDir = cleanNativePath(destDir);
    if (destDir === srcDir || !srcDir || destDir.startsWith(srcDir + '/')) throw new Error('Cannot copy a directory into itself');
    await this.createDirectory(destDir);
    // Copy actual entries, not the filtered/depth-limited explorer tree.
    const items = await this.io.request<NativeEntry[]>('list', srcDir);
    for (const item of items) {
      const sourcePath = srcDir + '/' + item.name, targetPath = destDir ? destDir + '/' + item.name : item.name;
      if (item.kind === 'directory') {
        await this.copyDirectory(sourcePath, targetPath);
      } else {
        await this.copyFile(sourcePath, targetPath);
      }
    }
  }

  public async move(srcPath: string, destPath: string): Promise<void> {
    srcPath = cleanNativePath(srcPath); destPath = cleanNativePath(destPath);
    if (srcPath === destPath) throw new Error('Source and destination must differ');
    const isDir = await this.directoryExists(srcPath);
    if (isDir) {
      await this.copyDirectory(srcPath, destPath);
      await this.deleteFile(srcPath);
    } else {
      await this.copyFile(srcPath, destPath);
      await this.deleteFile(srcPath);
    }
  }

  public async writeFile(filePath: string, content: string): Promise<void> {
    await this.writes.enqueue(cleanNativePath(filePath), content);
  }

  public async writeBinaryFile(filePath: string, data: Uint8Array): Promise<void> {
    filePath = cleanNativePath(filePath);
    await this.writes.enqueue(filePath, data.slice());
    if (!filePath.split('/').some((name) => this.shouldIgnoreName(name))) this.refreshSoon();
  }

  public async createFile(filePath: string, initialContent?: string): Promise<void> {
    await this.writeFile(filePath, initialContent ?? this.getDefaultTemplateForFile(filePath));
    if (!filePath.split('/').some((name) => this.shouldIgnoreName(name))) this.refreshSoon();
  }

  public async createDirectory(dirPath: string): Promise<void> {
    await this.io.request('mkdir', dirPath);
    if (!dirPath.split('/').some((name) => this.shouldIgnoreName(name))) this.refreshSoon();
  }

  public async deleteFile(filePath: string): Promise<void> {
    filePath = cleanNativePath(filePath);
    await this.writes.flush(filePath);
    await this.io.request('delete', filePath);
    if (!filePath.split('/').some((name) => this.shouldIgnoreName(name))) this.refreshSoon();
  }

  public async renameFile(oldPath: string, newPath: string): Promise<void> {
    await this.move(oldPath, newPath);
  }

  private static readonly BINARY_EXTENSIONS = new Set([
    '.wasm', '.o', '.obj', '.a', '.so', '.dylib', '.dll', '.exe',
    '.bin', '.dat', '.zip', '.tar', '.gz', '.7z', '.png', '.jpg',
    '.jpeg', '.gif', '.ico', '.pdf', '.mp3', '.mp4'
  ]);

  public isSourceOrTextFile(name: string): boolean {
    const ext = name.includes('.') ? name.substring(name.lastIndexOf('.')).toLowerCase() : '';
    return !FileSystemService.BINARY_EXTENSIONS.has(ext);
  }

  public async getAllFilesContent(mainFile?: string, mode: 'single' | 'project' = 'project'): Promise<Record<string, string>> {
    if (!this.hasOpenFolder()) return {};
    return this.io.request('snapshot', '', { mainFile, mode, ignored: [...this.IGNORED_NAMES] });
  }

  public getDefaultTemplateForFile(filePath: string): string {
    const name = filePath.split('/').pop() || '';
    const ext = name.includes('.') ? name.substring(name.lastIndexOf('.')).toLowerCase() : '';

    if (ext === '.cpp' || ext === '.cc' || ext === '.cxx') {
      return `#include <iostream>

int main() {
    std::cout << "Hello, World!" << std::endl;
    return 0;
}
`;
    }

    if (ext === '.c') {
      return `#include <stdio.h>

int main() {
    printf("Hello, World!\\n");
    return 0;
}
`;
    }

    if (ext === '.h' || ext === '.hpp') {
      const guardName = name
        .replace(/[^a-zA-Z0-9_]/g, '_')
        .toUpperCase();
      return `#pragma once
#ifndef ${guardName}
#define ${guardName}

// Declarations here

#endif // ${guardName}
`;
    }

    return '';
  }
}
