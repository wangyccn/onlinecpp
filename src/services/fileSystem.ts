import { FileItem } from '../types';

export class FileSystemService {
  private rootDirHandle: FileSystemDirectoryHandle | null = null;
  private rootName = '';
  private onFilesChangedCallbacks: Array<(items: FileItem[]) => void> = [];
  private taskQueue: Promise<any> = Promise.resolve();

  constructor() {
    // No mock/virtual demo files. The user must open a real local folder.
  }

  public enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.taskQueue.then(task, task);
    this.taskQueue = next.catch(() => {});
    return next;
  }

  public hasOpenFolder(): boolean {
    return this.rootDirHandle !== null;
  }

  public getRootName(): string {
    return this.rootName || 'No Folder Opened';
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

  public async openNativeDirectory(): Promise<boolean> {
    const showPicker = (window as any).showDirectoryPicker;
    if (!showPicker) {
      alert('Your browser does not support the File System Access API (window.showDirectoryPicker). Please use Chrome, Edge, or Opera.');
      return false;
    }

    try {
      const dirHandle = await showPicker({
        mode: 'readwrite',
      });
      this.rootDirHandle = dirHandle;
      this.rootName = dirHandle.name;
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
    if (!this.rootDirHandle) {
      return [];
    }

    const clean = targetDir.replace(/^\/+|\/+$/g, '');
    if (!clean) {
      return await this.readDirectoryRecursively(this.rootDirHandle, '');
    }

    const dirHandle = await this.resolveDirectoryHandle(clean);
    if (!dirHandle) {
      return [];
    }

    return await this.readDirectoryRecursively(dirHandle, clean);
  }

  public async resolveDirectoryHandle(
    dirPath: string
  ): Promise<FileSystemDirectoryHandle | null> {
    if (!this.rootDirHandle) return null;
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
    const handle = await this.resolveDirectoryHandle(dirPath);
    return handle !== null;
  }

  public async fileExists(filePath: string): Promise<boolean> {
    const handle = await this.resolveNativeFileHandle(filePath, false);
    return handle !== null;
  }

  public async getFileMetadata(filePath: string): Promise<{ size: number; lastModified: number } | null> {
    try {
      const handle = await this.resolveNativeFileHandle(filePath, false);
      if (!handle) return null;
      const file = await handle.getFile();
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
    dirHandle: FileSystemDirectoryHandle,
    relativeDir: string,
    depth = 0
  ): Promise<FileItem[]> {
    if (depth > 6) return [];
    const items: FileItem[] = [];

    try {
      // @ts-ignore
      for await (const [name, handle] of dirHandle.entries()) {
        if (this.shouldIgnoreName(name)) {
          continue;
        }
        const itemPath = relativeDir ? `${relativeDir}/${name}` : name;
        if (handle.kind === 'directory') {
          const children = await this.readDirectoryRecursively(
            handle as FileSystemDirectoryHandle,
            itemPath,
            depth + 1
          );
          items.push({
            name,
            path: itemPath,
            isDirectory: true,
            isExpanded: true,
            handle,
            children,
          });
        } else {
          items.push({
            name,
            path: itemPath,
            isDirectory: false,
            handle,
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
    const fileHandle = await this.resolveNativeFileHandle(filePath, false);
    if (!fileHandle) {
      throw new Error(`File not found: ${filePath}`);
    }
    const file = await fileHandle.getFile();
    return await file.text();
  }

  public async readBinaryFile(filePath: string): Promise<Uint8Array> {
    const fileHandle = await this.resolveNativeFileHandle(filePath, false);
    if (!fileHandle) {
      throw new Error(`File not found: ${filePath}`);
    }
    const file = await fileHandle.getFile();
    const buffer = await file.arrayBuffer();
    return new Uint8Array(buffer);
  }

  public async copyFile(srcPath: string, destPath: string): Promise<void> {
    const data = await this.readBinaryFile(srcPath);
    await this.writeBinaryFile(destPath, data);
  }

  public async copyDirectory(srcDir: string, destDir: string): Promise<void> {
    await this.createDirectory(destDir);
    const items = await this.listFiles(srcDir);
    for (const item of items) {
      const cleanSrc = srcDir.replace(/^\/+|\/+$/g, '');
      const relative = cleanSrc ? item.path.substring(cleanSrc.length).replace(/^\/+/, '') : item.path;
      const targetPath = destDir ? `${destDir.replace(/^\/+|\/+$/g, '')}/${relative}` : relative;

      if (item.isDirectory) {
        await this.copyDirectory(item.path, targetPath);
      } else {
        await this.copyFile(item.path, targetPath);
      }
    }
  }

  public async move(srcPath: string, destPath: string): Promise<void> {
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
    return this.enqueue(async () => {
      const fileHandle = await this.resolveNativeFileHandle(filePath, true);
      if (!fileHandle) {
        throw new Error(`Could not create or write to file: ${filePath}`);
      }
      // @ts-ignore
      const writable = await fileHandle.createWritable();
      await writable.write(content);
      await writable.close();
    });
  }

  public async writeBinaryFile(filePath: string, data: Uint8Array): Promise<void> {
    return this.enqueue(async () => {
      const fileHandle = await this.resolveNativeFileHandle(filePath, true);
      if (!fileHandle) {
        throw new Error(`Could not create or write binary file: ${filePath}`);
      }
      // @ts-ignore
      const writable = await fileHandle.createWritable();
      await writable.write(data as any);
      await writable.close();

      const items = await this.listFiles();
      this.notifyFilesChanged(items);
    });
  }

  public async createFile(filePath: string, initialContent?: string): Promise<void> {
    return this.enqueue(async () => {
      const content = initialContent !== undefined ? initialContent : this.getDefaultTemplateForFile(filePath);

      const fileHandle = await this.resolveNativeFileHandle(filePath, true);
      if (fileHandle) {
        // @ts-ignore
        const writable = await fileHandle.createWritable();
        await writable.write(content);
        await writable.close();
      }

      const items = await this.listFiles();
      this.notifyFilesChanged(items);
    });
  }

  public async createDirectory(dirPath: string): Promise<void> {
    return this.enqueue(async () => {
      if (!this.rootDirHandle) return;
      const segments = dirPath.split('/').filter(Boolean);
      let currentDir = this.rootDirHandle;
      for (const seg of segments) {
        currentDir = await currentDir.getDirectoryHandle(seg, { create: true });
      }

      const items = await this.listFiles();
      this.notifyFilesChanged(items);
    });
  }

  public async deleteFile(filePath: string): Promise<void> {
    return this.enqueue(async () => {
      if (!this.rootDirHandle) return;
      const segments = filePath.split('/').filter(Boolean);
      const fileName = segments.pop()!;
      let currentDir = this.rootDirHandle;
      for (const seg of segments) {
        currentDir = await currentDir.getDirectoryHandle(seg);
      }
      await currentDir.removeEntry(fileName, { recursive: true });

      const items = await this.listFiles();
      this.notifyFilesChanged(items);
    });
  }

  public async renameFile(oldPath: string, newPath: string): Promise<void> {
    const content = await this.readFile(oldPath);
    await this.createFile(newPath, content);
    await this.deleteFile(oldPath);
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

  public async getAllFilesContent(): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    if (!this.rootDirHandle) return result;

    const allFiles = await this.listFiles();
    const gather = async (items: FileItem[]) => {
      for (const item of items) {
        if (item.isDirectory && item.children) {
          await gather(item.children);
        } else if (!item.isDirectory) {
          if (this.shouldIgnoreName(item.name) || !this.isSourceOrTextFile(item.name)) continue;
          try {
            result[item.path] = await this.readFile(item.path);
          } catch (e) {
            console.warn(`Could not read file ${item.path}:`, e);
          }
        }
      }
    };
    await gather(allFiles);
    return result;
  }

  private async resolveNativeFileHandle(
    filePath: string,
    create: boolean
  ): Promise<FileSystemFileHandle | null> {
    if (!this.rootDirHandle) return null;
    const segments = filePath.split('/').filter(Boolean);
    const fileName = segments.pop()!;
    let currentDir = this.rootDirHandle;
    for (const seg of segments) {
      currentDir = await currentDir.getDirectoryHandle(seg, { create });
    }
    return await currentDir.getFileHandle(fileName, { create });
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
