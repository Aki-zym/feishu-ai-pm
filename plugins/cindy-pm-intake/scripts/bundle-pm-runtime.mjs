import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { basename, dirname, extname, isAbsolute, relative, resolve } from 'node:path';
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

function bundleLockError(code, message) {
  return Object.assign(new Error(message), { code });
}

function parseLegacyLock(value, lockPath) {
  try {
    const owner = JSON.parse(value);
    if (!owner || typeof owner !== 'object' || Array.isArray(owner)
      || owner.root !== root || !Number.isInteger(owner.pid) || owner.pid <= 0
      || typeof owner.token !== 'string' || !owner.token
      || typeof owner.created_at !== 'string' || !Number.isFinite(Date.parse(owner.created_at))) {
      throw new Error('invalid owner identity');
    }
    return owner;
  } catch {
    throw bundleLockError('BUNDLE_LOCK_UNSAFE_METADATA', `bundle lock metadata is unreadable, malformed, or belongs to another root: ${lockPath}`);
  }
}

function endpointForLockPath(lockPath) {
  const key = createHash('sha256').update(resolve(lockPath)).digest('hex').slice(0, 32);
  if (process.platform === 'win32') return `\\\\.\\pipe\\cindy-pm-runtime-${key}`;
  return { host: '127.0.0.1', port: 49_152 + (Number.parseInt(key.slice(0, 8), 16) % 16_384), exclusive: true };
}

async function listenForBundleLease(lockPath) {
  const server = createServer((socket) => socket.destroy());
  const endpoint = endpointForLockPath(lockPath);
  try {
    await new Promise((resolveListen, rejectListen) => {
      const onError = (error) => rejectListen(error);
      server.once('error', onError);
      server.listen(endpoint, () => {
        server.off('error', onError);
        resolveListen();
      });
    });
    return server;
  } catch (error) {
    if (server.listening) await closeBundleEndpoint(server);
    if (error?.code === 'EADDRINUSE') return null;
    throw error;
  }
}

async function closeBundleEndpoint(server) {
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
}

async function assertNoRecoveryArtifacts(lockPath) {
  const prefix = `${basename(lockPath)}.recovery-`;
  const artifacts = (await readdir(dirname(lockPath))).filter((entry) => entry.startsWith(prefix));
  if (artifacts.length > 0) {
    throw bundleLockError(
      'BUNDLE_LOCK_UNSAFE_METADATA',
      `bundle lock has an unfinished ownership recovery and requires manual inspection: ${artifacts.join(', ')}`,
    );
  }
}

async function restoreClaimedLock(quarantinePath, lockPath, claimedText) {
  try {
    await writeFile(lockPath, claimedText, { encoding: 'utf8', flag: 'wx' });
    await rm(quarantinePath);
  } catch (error) {
    throw bundleLockError(
      'BUNDLE_LOCK_UNSAFE_METADATA',
      `bundle lock identity changed during stale recovery and could not be restored safely: ${error?.code ?? 'unknown'}`,
    );
  }
}

async function recoverLegacyLockWhileEndpointHeld(lockPath) {
  await assertNoRecoveryArtifacts(lockPath);
  let observedText;
  try {
    observedText = await readFile(lockPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return 'ready';
    throw bundleLockError('BUNDLE_LOCK_UNSAFE_METADATA', `bundle lock metadata cannot be read safely: ${lockPath}`);
  }
  const observedOwner = parseLegacyLock(observedText, lockPath);
  if (processIsAlive(observedOwner.pid)) return 'busy';

  const quarantinePath = `${lockPath}.recovery-${randomUUID()}`;
  try {
    await rename(lockPath, quarantinePath);
  } catch (error) {
    throw bundleLockError('BUNDLE_LOCK_UNSAFE_METADATA', `bundle lock changed before stale recovery could claim it atomically: ${error?.code ?? 'unknown'}`);
  }
  let claimedText;
  try {
    claimedText = await readFile(quarantinePath, 'utf8');
  } catch (error) {
    await restoreClaimedLock(quarantinePath, lockPath, observedText);
    throw bundleLockError('BUNDLE_LOCK_UNSAFE_METADATA', `claimed stale bundle lock became unreadable: ${error?.code ?? 'unknown'}`);
  }
  if (claimedText !== observedText) {
    await restoreClaimedLock(quarantinePath, lockPath, claimedText);
    throw bundleLockError('BUNDLE_LOCK_UNSAFE_METADATA', 'bundle lock owner identity changed during stale recovery');
  }
  await rm(quarantinePath);
  return 'ready';
}

async function createBundleOwnerMarker(lockPath, token) {
  const ownerText = JSON.stringify({ pid: process.pid, root, token, created_at: new Date().toISOString() });
  try {
    await writeFile(lockPath, ownerText, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    throw bundleLockError(
      'BUNDLE_LOCK_UNSAFE_METADATA',
      `bundle lock path was replaced before ownership could be published safely: ${error?.code ?? 'unknown'}`,
    );
  }
  return ownerText;
}

async function removeOwnedBundleMarker(lockPath, ownerText, token) {
  const quarantinePath = `${lockPath}.recovery-${token}`;
  try {
    await rename(lockPath, quarantinePath);
  } catch (error) {
    throw bundleLockError(
      'BUNDLE_LOCK_UNSAFE_METADATA',
      `bundle lock owner marker could not be claimed for release: ${error?.code ?? 'unknown'}`,
    );
  }
  let claimedText;
  try {
    claimedText = await readFile(quarantinePath, 'utf8');
  } catch (error) {
    await restoreClaimedLock(quarantinePath, lockPath, ownerText);
    throw bundleLockError('BUNDLE_LOCK_UNSAFE_METADATA', `claimed bundle lock owner marker became unreadable: ${error?.code ?? 'unknown'}`);
  }
  if (claimedText !== ownerText) {
    await restoreClaimedLock(quarantinePath, lockPath, claimedText);
    throw bundleLockError('BUNDLE_LOCK_UNSAFE_METADATA', 'bundle lock release rejected because the owner identity changed');
  }
  await rm(quarantinePath);
}

const leaseStates = new WeakMap();

export async function acquireBundleLease(options = {}) {
  const lockPath = options.lockPath ?? bundleLockPath;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const retryMs = options.retryMs ?? 50;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const server = await listenForBundleLease(lockPath);
    if (!server) {
      await delay(retryMs);
      continue;
    }
    try {
      const legacyState = await recoverLegacyLockWhileEndpointHeld(lockPath);
      if (legacyState === 'busy') {
        await closeBundleEndpoint(server);
        await delay(retryMs);
        continue;
      }
      const token = randomUUID();
      const ownerText = await createBundleOwnerMarker(lockPath, token);
      const lease = Object.freeze({ token, endpoint: endpointForLockPath(lockPath) });
      leaseStates.set(lease, { server, lockPath, ownerText });
      return lease;
    } catch (error) {
      await closeBundleEndpoint(server);
      throw error;
    }
  }
  throw bundleLockError('BUNDLE_LOCK_TIMEOUT', `bundle lock remained busy for ${timeoutMs}ms: ${lockPath}`);
}

export async function releaseBundleLease(lease) {
  const state = lease && typeof lease === 'object' ? leaseStates.get(lease) : undefined;
  if (!state) throw bundleLockError('BUNDLE_LOCK_NOT_OWNER', 'bundle lock release rejected because the lease is not owned by this caller');
  leaseStates.delete(lease);
  try {
    await removeOwnedBundleMarker(state.lockPath, state.ownerText, lease.token);
  } finally {
    await closeBundleEndpoint(state.server);
  }
}

export async function withBundleLock(action, options = {}) {
  const lease = await acquireBundleLease(options);
  try {
    return await action();
  } finally {
    await releaseBundleLease(lease);
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
