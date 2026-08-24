import { cp, mkdir, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { build } from 'esbuild';

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, '../../..');
const webSource = resolve(root, 'apps', 'web', 'dist');
const webTarget = resolve(root, 'plugins', 'cindy-pm-intake', 'web-dist');
const runtimeEntry = resolve(root, 'plugins', 'cindy-pm-intake', 'node', 'pm-runtime.entry.mjs');
const runtimeOutput = resolve(root, 'plugins', 'cindy-pm-intake', 'node', 'pm-runtime.cjs');
const statusSource = resolve(root, 'plugins', 'cindy-pm-intake', 'node', 'macos-status', 'main.swift');
const statusOutput = resolve(root, 'plugins', 'cindy-pm-intake', 'node', 'macos-status', 'TooManyTasksStatus');

await execFileAsync('npm', ['run', 'build', '-w', '@ai-pm/web'], { cwd: root, stdio: 'inherit' });
await rm(webTarget, { recursive: true, force: true });
await mkdir(webTarget, { recursive: true });
await cp(webSource, webTarget, { recursive: true, force: true });

await build({
  entryPoints: [runtimeEntry],
  outfile: runtimeOutput,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  external: ['node:*'],
  logLevel: 'info',
});

if (process.platform === 'darwin') {
  await execFileAsync('swiftc', ['-O', statusSource, '-o', statusOutput], { cwd: root, stdio: 'inherit' });
  console.log(`macOS 菜单栏运行时已生成：${statusOutput}`);
} else {
  console.log(`当前平台为 ${process.platform}，跳过 macOS 菜单栏运行时编译。`);
}

console.log(`本机任务库运行时已生成：${runtimeOutput}`);
console.log(`本机任务库网页资源已复制：${webTarget}`);
