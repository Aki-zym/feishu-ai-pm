import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, resolve } from 'node:path';

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, '../../..');
const pluginRoot = resolve(root, 'plugins', 'cindy-pm-intake');
const ghost = JSON.parse(await readFile(resolve(pluginRoot, 'ghost.json'), 'utf8'));
const packagePath = resolve(pluginRoot, `${ghost.id}-${ghost.version}.cindy`);
const stagingRoot = resolve(pluginRoot, '.package-tmp');
const files = [
  'README.md',
  'ghost.json',
  'main.js',
  'node/worker.cjs',
  'settings.html',
  'settings.js',
  'skills/pm-progress-update/SKILL.md',
];
const forbidden = [
  'node/aily.cjs',
  'node/aily-sdk.cjs',
  'node/pm-runtime.cjs',
  'node/macos-status/TooManyTasksStatus',
  'web-dist',
];

for (const relativePath of forbidden) {
  try {
    await readFile(resolve(pluginRoot, relativePath));
    throw new Error(`薄插件目录仍包含已废弃产物：${relativePath}`);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EISDIR') {
      throw new Error(`薄插件目录仍包含已废弃目录：${relativePath}`);
    }
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') continue;
    throw error;
  }
}

await rm(stagingRoot, { recursive: true, force: true });
await mkdir(stagingRoot, { recursive: true });
for (const relativePath of files) {
  const target = resolve(stagingRoot, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await cp(resolve(pluginRoot, relativePath), target);
}
await rm(packagePath, { force: true });
await execFileAsync('zip', ['-q', '-r', packagePath, '.'], { cwd: stagingRoot });
await rm(stagingRoot, { recursive: true, force: true });

const { stdout } = await execFileAsync('unzip', ['-Z1', packagePath], { cwd: root });
const packagedFiles = stdout.trim().split(/\r?\n/u).filter((value) => value && !value.endsWith('/')).sort();
if (JSON.stringify(packagedFiles) !== JSON.stringify([...files].sort())) {
  throw new Error(`插件包内容不符合薄插件白名单：${packagedFiles.join(', ')}`);
}
console.log(`TooManyTasks Cindy 薄插件已生成：${packagePath}`);
