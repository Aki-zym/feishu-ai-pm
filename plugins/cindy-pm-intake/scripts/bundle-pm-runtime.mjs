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

console.log(`本机任务库运行时已生成：${runtimeOutput}`);
console.log(`本机任务库网页资源已复制：${webTarget}`);
