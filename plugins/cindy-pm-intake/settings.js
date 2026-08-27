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
    method: 'pm/request',
    params: {
      baseUrl,
      method: 'POST',
      path: '/api/runtime/restart',
      body: {},
    },
    timeoutMs: 30000,
  });
  if (!restarted || restarted.ok !== true) throw new Error(restarted?.message || '独立 TooManyTasks 重启失败');
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

async function putJson(url, body, message) {
  const response = await fetch(url, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
  if (!response || response.ok !== true) throw new Error(message);
  return response;
}

fetch('/kv').then((response) => response.json()).then((config) => {
  byId('pmBaseUrl').value = isLoopbackUrl(config.pmBaseUrl) ? config.pmBaseUrl : DEFAULT_PM_BASE_URL;
  byId('progressEnabled').checked = config.progressEnabled !== false;
  const progressMode = config.progressMode === 'automatic' ? 'automatic' : 'manual';
  const progressRadio = document.querySelector?.(`input[name="progressMode"][value="${progressMode}"]`);
  if (progressRadio) progressRadio.checked = true;
  void requestAutoScanState().then((state) => {
    byId('autoScan').checked = state?.enabled === true;
  }).catch(() => undefined);
});

byId('save').onclick = async () => {
  const status = byId('status');
  status.textContent = '保存中…';
  try {
    const pmBaseUrl = configuredBaseUrl();
    if (!isLoopbackUrl(pmBaseUrl)) {
      status.textContent = '本机任务库地址必须是本机 HTTP 回环地址';
      return;
    }
    await putJson('/kv', {
      pmBaseUrl,
      progressEnabled: byId('progressEnabled').checked,
      progressMode: progressModeValue(),
    }, '配置保存失败');
    new BroadcastChannel('cindy-pm-intake').postMessage({ type: 'settings-changed' });
    status.textContent = '已保存';
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : '配置保存失败';
  }
};

byId('restart').onclick = async () => {
  const status = byId('status');
  status.textContent = '重启独立 TooManyTasks 中…';
  try {
    await restartPm();
    status.textContent = '独立 TooManyTasks 已收到重启请求';
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : '独立 TooManyTasks 重启失败';
  }
};

byId('autoScan').onchange = async () => {
  const status = byId('status');
  const enabled = byId('autoScan').checked;
  status.textContent = enabled ? '正在启用 TooManyTasks 后台自动扫描…' : '正在关闭后台自动扫描…';
  try {
    await updateAutoScanState(enabled);
    if (enabled) {
      status.textContent = '已启用：TooManyTasks 每 20 分钟后台扫描，Cindy 每 5 分钟领取摘要';
    } else {
      status.textContent = '已关闭新摘要生成；已有摘要仍会由 Cindy 继续入库';
    }
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : '自动扫描开关保存失败';
  }
};
