import { lstat, readdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { AppConfig } from '../config.js';
import type { WorkspaceEntry, WorkspaceReferenceAdapter } from '../integration-contracts.js';

export class ReadonlyWorkspaceAdapter implements WorkspaceReferenceAdapter {
  readonly kind = 'readonly_bridge' as const;
  private readonly maxEntries = 200;
  private readonly maxDepth = 2;

  constructor(private readonly config: AppConfig['workspace']) {}

  async inspect(referencePath: string) {
    const inspectedAt = new Date().toISOString();
    if (!this.config.readEnabled) {
      return { state: 'not_enabled' as const, referencePath, entries: [], truncated: false, inspectedAt };
    }
    if (!isAbsolute(referencePath)) {
      return { state: 'unavailable' as const, referencePath, entries: [], truncated: false, inspectedAt, error: '只读扫描需要用户通过原生选择器授权本地目录。' };
    }
    const rootPath = resolve(referencePath);
    const allowed = this.config.allowedPaths.some((item) => {
      const allowedPath = resolve(item);
      const left = process.platform === 'win32' ? allowedPath.toLowerCase() : allowedPath;
      const right = process.platform === 'win32' ? rootPath.toLowerCase() : rootPath;
      return right === left || right.startsWith(left + sep);
    });
    if (!allowed) {
      return { state: 'unavailable' as const, referencePath, entries: [], truncated: false, inspectedAt, error: '该目录不在用户授权白名单中，请重新使用原生选择器授权。' };
    }
    try {
      const root = await lstat(rootPath);
      if (!root.isDirectory()) throw new Error('选择的路径不是目录。');
      const entries: WorkspaceEntry[] = [];
      let truncated = false;
      const visit = async (directory: string, depth: number) => {
        if (depth > this.maxDepth || entries.length >= this.maxEntries) {
          truncated = true;
          return;
        }
        const children = await readdir(directory, { withFileTypes: true });
        for (const child of children) {
          if (entries.length >= this.maxEntries) {
            truncated = true;
            break;
          }
          if (child.isSymbolicLink()) continue;
          const childPath = join(directory, child.name);
          const info = await lstat(childPath);
          const isDirectory = info.isDirectory();
          entries.push({
            relativePath: relative(rootPath, childPath).replaceAll('\\', '/'),
            type: isDirectory ? 'directory' : 'file',
            size: isDirectory ? null : info.size,
            modifiedAt: info.mtime.toISOString(),
          });
          if (isDirectory) await visit(childPath, depth + 1);
        }
      };
      await visit(referencePath, 0);
      return { state: 'ready' as const, referencePath, entries, truncated, inspectedAt };
    } catch (error) {
      return {
        state: 'unavailable' as const,
        referencePath,
        entries: [],
        truncated: false,
        inspectedAt,
        error: error instanceof Error ? error.message.slice(0, 200) : '目录不可读取。',
      };
    }
  }
}
