const byId = (id) => document.getElementById(id);
const DEFAULT_PM_BASE_URL = 'http://127.0.0.1:4310';

function isLoopbackUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return url.protocol === 'http:'
      && ['127.0.0.1', 'localhost', '::1'].includes(host)
      && !url.username
      && !url.password
      && !url.search
      && !url.hash
      && (url.pathname === '' || url.pathname === '/');
  } catch {
    return false;
  }
}

function cindyHost() {
  return globalThis.cindy;
}

function configuredBaseUrl() {
  return byId('pmBaseUrl').value.trim() || DEFAULT_PM_BASE_URL;
}

async function restartPm() {
  const host = cindyHost();
  if (!host?.node || typeof host.node.request !== 'function') {
    throw new Error('当前宿主没有可用的本机任务库控制通道');
  }
  const baseUrl = configuredBaseUrl();
  if (!isLoopbackUrl(baseUrl)) throw new Error('本机任务库地址必须是本机 HTTP 回环地址');
  const restarted = await host.node.request({
    method: 'pm/restart',
    params: { baseUrl, scheduleExit: false },
    timeoutMs: 30000,
  });
  if (!restarted || restarted.ok !== true) throw new Error(restarted?.message || '本机任务库重启失败');
}

async function requestAutoScanState() {
  const host = cindyHost();
  if (!host?.node || typeof host.node.request !== 'function') {
    throw new Error('当前宿主没有可用的本机任务库控制通道');
  }
  const baseUrl = configuredBaseUrl();
  if (!isLoopbackUrl(baseUrl)) throw new Error('本机任务库地址必须是本机 HTTP 回环地址');
  const response = await host.node.request({
    method: 'pm/request',
    params: {
      baseUrl,
      method: 'GET',
      path: '/api/runtime/auto-scan',
    },
    timeoutMs: 30000,
  });
  if (!response || response.ok !== true) throw new Error(response?.message || '自动扫描状态读取失败');
  return response.result;
}

async function updateAutoScanState(enabled) {
  const host = cindyHost();
  if (!host?.node || typeof host.node.request !== 'function') {
    throw new Error('当前宿主没有可用的本机任务库控制通道');
  }
  const baseUrl = configuredBaseUrl();
  if (!isLoopbackUrl(baseUrl)) throw new Error('本机任务库地址必须是本机 HTTP 回环地址');
  const response = await host.node.request({
    method: 'pm/request',
    params: {
      baseUrl,
      method: 'PUT',
      path: '/api/runtime/auto-scan',
      body: { enabled },
    },
    timeoutMs: 30000,
  });
  if (!response || response.ok !== true) throw new Error(response?.message || '自动扫描开关保存失败');
  return response.result;
}

function progressModeValue() {
  return document.querySelector?.('input[name="progressMode"]:checked')?.value === 'automatic' ? 'automatic' : 'manual';
}

Promise.all([
  fetch('/kv').then((response) => response.json()),
  fetch('/secrets').then((response) => response.json()),
]).then(([config, secrets]) => {
  byId('pmBaseUrl').value = isLoopbackUrl(config.pmBaseUrl) ? config.pmBaseUrl : DEFAULT_PM_BASE_URL;
  byId('progressEnabled').checked = config.progressEnabled !== false;
  const progressMode = config.progressMode === 'automatic' ? 'automatic' : 'manual';
  const progressRadio = document.querySelector?.(`input[name="progressMode"][value="${progressMode}"]`);
  if (progressRadio) progressRadio.checked = true;
  const saved = Array.isArray(secrets) && secrets.some((item) => item.key === 'pm_token' && item.saved);
  byId('token').placeholder = saved ? '已保存；留空保持不变' : '请输入本机服务令牌';
  void requestAutoScanState().then((state) => {
    byId('autoScan').checked = state?.enabled === true;
  }).catch(() => undefined);
});

byId('save').onclick = async () => {
  const status = byId('status');
  status.textContent = '保存中…';
  const pmBaseUrl = configuredBaseUrl();
  if (!isLoopbackUrl(pmBaseUrl)) {
    status.textContent = '本机任务库地址必须是本机 HTTP 回环地址';
    return;
  }
  await fetch('/kv', {
    method: 'PUT',
    body: JSON.stringify({
      pmBaseUrl,
      progressEnabled: byId('progressEnabled').checked,
      progressMode: progressModeValue(),
    }),
  });
  const token = byId('token').value;
  if (token) {
    await fetch('/secrets/pm_token', { method: 'PUT', body: JSON.stringify({ value: token }) });
    byId('token').value = '';
    byId('token').placeholder = '已保存；留空保持不变';
  }
  new BroadcastChannel('cindy-pm-intake').postMessage({ type: 'settings-changed' });
  status.textContent = '已保存';
};

byId('restart').onclick = async () => {
  const status = byId('status');
  status.textContent = '重启本机任务库中…';
  try {
    await restartPm();
    status.textContent = '本机任务库已重启';
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : '本机任务库重启失败';
  }
};

byId('autoScan').onchange = async () => {
  const status = byId('status');
  const enabled = byId('autoScan').checked;
  status.textContent = enabled ? '正在启用常驻自动扫描…' : '正在关闭本产品自动扫描…';
  try {
    await updateAutoScanState(enabled);
    if (enabled) {
      status.textContent = '已启用：Cindy 保持运行且开关打开，每 10 分钟自动扫';
    } else {
      status.textContent = '已关闭本产品自动扫描；当前正在运行的扫描会自然收口';
    }
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : '自动扫描开关保存失败';
  }
};
