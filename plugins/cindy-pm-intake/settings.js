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

Promise.all([
  fetch('/kv').then((response) => response.json()),
  fetch('/secrets').then((response) => response.json()),
]).then(([config, secrets]) => {
  byId('pmBaseUrl').value = isLoopbackUrl(config.pmBaseUrl) ? config.pmBaseUrl : DEFAULT_PM_BASE_URL;
  const saved = Array.isArray(secrets) && secrets.some((item) => item.key === 'pm_token' && item.saved);
  byId('token').placeholder = saved ? '已保存；留空保持不变' : '请输入本机服务令牌';
});

byId('save').onclick = async () => {
  const status = byId('status');
  status.textContent = '保存中…';
  const pmBaseUrl = byId('pmBaseUrl').value.trim() || DEFAULT_PM_BASE_URL;
  if (!isLoopbackUrl(pmBaseUrl)) {
    status.textContent = '本机任务库地址必须是本机 HTTP 回环地址';
    return;
  }
  await fetch('/kv', {
    method: 'PUT',
    body: JSON.stringify({
      pmBaseUrl,
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
