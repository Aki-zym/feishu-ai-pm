import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { cp, mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
export const root = resolve(import.meta.dirname, '../../..');
const webSource = resolve(root, 'apps', 'web', 'dist');
const webTarget = resolve(root, 'plugins', 'cindy-pm-intake', 'web-dist');
export const runtimeEntry = resolve(root, 'plugins', 'cindy-pm-intake', 'node', 'pm-runtime.entry.mjs');
export const runtimeOutput = resolve(root, 'plugins', 'cindy-pm-intake', 'node', 'pm-runtime.cjs');
const statusSource = resolve(root, 'plugins', 'cindy-pm-intake', 'node', 'macos-status', 'main.swift');
const statusOutput = resolve(root, 'plugins', 'cindy-pm-intake', 'node', 'macos-status', 'TooManyTasksStatus');
const textExtensions = new Set(['.html', '.js', '.css', '.json', '.map', '.txt', '.md', '.svg']);
export const pinnedEsbuildVersion = '0.25.9';

const rootRequire = createRequire(resolve(root, 'package.json'));
export const esbuildModulePath = rootRequire.resolve('esbuild');
const esbuild = rootRequire('esbuild');
if (esbuild.version !== pinnedEsbuildVersion) {
  throw new Error(`bundle requires esbuild ${pinnedEsbuildVersion}, received ${esbuild.version} from ${esbuildModulePath}`);
}

export const bundleLockPath = resolve(
  tmpdir(),
  `cindy-pm-runtime-${createHash('sha256').update(root).digest('hex').slice(0, 24)}.lock`,
);

export const normalizeGeneratedText = (value) => value
  .replace(/\r+\n/g, '\n')
  .replace(/\r/g, '\n')
  .replace(/[ \t]+$/gmu, '');

async function normalizeTextTree(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await normalizeTextTree(path);
    else if (entry.isFile() && textExtensions.has(extname(entry.name).toLowerCase())) {
      await writeFile(path, normalizeGeneratedText(await readFile(path, 'utf8')), 'utf8');
    }
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

async function clearDeadBundleLock(lockPath) {
  try {
    const owner = JSON.parse(await readFile(lockPath, 'utf8'));
    if (owner.root === root && !processIsAlive(owner.pid)) {
      await rm(lockPath, { force: true });
      return true;
    }
  } catch {
    // An unreadable lock is not safe to remove automatically.
  }
  return false;
}

export async function withBundleLock(action, options = {}) {
  const lockPath = options.lockPath ?? bundleLockPath;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const retryMs = options.retryMs ?? 50;
  const startedAt = Date.now();
  const token = randomUUID();
  let handle;
  while (!handle) {
    try {
      const candidate = await open(lockPath, 'wx');
      try {
        await candidate.writeFile(JSON.stringify({ pid: process.pid, root, token, created_at: new Date().toISOString() }), 'utf8');
        handle = candidate;
      } catch (error) {
        await candidate.close();
        await rm(lockPath, { force: true });
        throw error;
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (await clearDeadBundleLock(lockPath)) continue;
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`bundle lock remained busy for ${timeoutMs}ms: ${lockPath}`);
      }
      await delay(retryMs);
    }
  }
  try {
    return await action();
  } finally {
    await handle.close();
    try {
      const owner = JSON.parse(await readFile(lockPath, 'utf8'));
      if (owner.token === token) await rm(lockPath, { force: true });
    } catch {
      // A missing lock is already released; a replaced lock belongs to another process.
    }
  }
}

export async function writeTextAtomically(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, value, 'utf8');
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export function runtimeBuildOptions() {
  return {
    absWorkingDir: root,
    entryPoints: [runtimeEntry],
    outfile: runtimeOutput,
    bundle: true,
    packages: 'bundle',
    platform: 'node',
    format: 'cjs',
    target: ['node24'],
    conditions: ['node'],
    mainFields: ['main', 'module'],
    resolveExtensions: ['.tsx', '.ts', '.jsx', '.js', '.css', '.json'],
    external: ['node:*'],
    define: { 'process.env.CINDY_RUNTIME_BUNDLE': 'true' },
    supported: { 'regexp-unicode-property-escapes': true },
    minifySyntax: true,
    treeShaking: true,
    charset: 'ascii',
    legalComments: 'eof',
    metafile: true,
    write: false,
    logLevel: 'info',
  };
}

async function hashRuntimeInputs(inputPaths) {
  const hash = createHash('sha256');
  for (const input of [...inputPaths].sort()) {
    const path = isAbsolute(input) ? input : resolve(root, input);
    const bytes = await readFile(path);
    hash.update(relative(root, path).replaceAll('\\', '/'));
    hash.update('\0');
    hash.update(createHash('sha256').update(bytes).digest('hex'));
    hash.update('\n');
  }
  return hash.digest('hex');
}

function runtimeConfigHash(options) {
  const projection = {
    entryPoints: options.entryPoints.map((path) => relative(root, path).replaceAll('\\', '/')),
    outfile: relative(root, options.outfile).replaceAll('\\', '/'),
    bundle: options.bundle,
    packages: options.packages,
    platform: options.platform,
    format: options.format,
    target: options.target,
    conditions: options.conditions,
    mainFields: options.mainFields,
    resolveExtensions: options.resolveExtensions,
    external: options.external,
    define: options.define,
    supported: options.supported,
    minifySyntax: options.minifySyntax,
    treeShaking: options.treeShaking,
    charset: options.charset,
    legalComments: options.legalComments,
    write: options.write,
  };
  return createHash('sha256').update(JSON.stringify(projection)).digest('hex');
}

export async function bundlePmRuntime() {
  return withBundleLock(async () => {
    if (process.platform === 'win32') {
      await execFileAsync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm run build -w @ai-pm/web'], { cwd: root, stdio: 'inherit' });
    } else {
      await execFileAsync('npm', ['run', 'build', '-w', '@ai-pm/web'], { cwd: root, stdio: 'inherit' });
    }
    await rm(webTarget, { recursive: true, force: true });
    await mkdir(webTarget, { recursive: true });
    await cp(webSource, webTarget, { recursive: true, force: true });
    await normalizeTextTree(webTarget);

    const buildOptions = runtimeBuildOptions();
    const result = await esbuild.build(buildOptions);
    if (result.outputFiles.length !== 1) throw new Error(`expected one runtime output, received ${result.outputFiles.length}`);
    const bundledRuntime = normalizeGeneratedText(result.outputFiles[0].text);
    await writeTextAtomically(runtimeOutput, bundledRuntime);

    if (process.platform === 'darwin') {
      await execFileAsync('swiftc', ['-O', statusSource, '-o', statusOutput], { cwd: root, stdio: 'inherit' });
      console.log(`macOS 菜单栏运行时已生成：${statusOutput}`);
    } else {
      console.log(`当前平台为 ${process.platform}，跳过 macOS 菜单栏运行时编译。`);
    }

    const state = {
      esbuild_version: esbuild.version,
      esbuild_module: relative(root, esbuildModulePath).replaceAll('\\', '/'),
      config_sha256: runtimeConfigHash(buildOptions),
      input_count: Object.keys(result.metafile.inputs).length,
      input_sha256: await hashRuntimeInputs(Object.keys(result.metafile.inputs)),
      output_sha256: createHash('sha256').update(bundledRuntime).digest('hex'),
    };
    console.log(`本机任务库运行时已生成：${runtimeOutput}`);
    console.log(`本机任务库网页资源已复制：${webTarget}`);
    console.log(`bundle-runtime-state ${JSON.stringify(state)}`);
    return state;
  });
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) await bundlePmRuntime();
