/* token-web 前端逻辑：登录 → 取 token → 复制 / 导出 / 验证 */

const $ = (sel) => document.querySelector(sel);

let currentToken = '';
let tokenVisible = false;

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.hidden = true), 2600);
}

function setBadge(text, kind) {
  $('#statusBadge').textContent = text;
  $('#statusBadge').className = `badge badge-${kind}`;
}

async function api(path, options) {
  const res = await fetch(path, options);
  return res.json();
}

/* ---------------- Token 展示 ---------------- */

function renderToken(token) {
  currentToken = token || '';
  $('#tokenBox').value = tokenVisible ? currentToken : currentToken ? mask(currentToken) : '';
  $('#tokenMask').textContent = currentToken ? mask(currentToken) : '未获取到 token';
  $('#tokenLen').textContent = currentToken ? `长度 ${currentToken.length}` : '';
  $('#qlSnippet').textContent = `export MT_TOKEN=${currentToken}`;
  setBadge(currentToken ? '已登录' : '未登录', currentToken ? 'ok' : 'no');
}

function mask(t) {
  return t.length > 12 ? `${t.slice(0, 8)}****${t.slice(-4)}` : '****';
}

async function refreshToken() {
  const r = await api('/api/token');
  renderToken(r.ok ? r.token : '');
}

/* ---------------- 登录 ---------------- */

async function startTask(cmd, argv = []) {
  const started = await api('/api/task', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cmd, argv }),
  });
  if (!started.ok) throw new Error(started.error || 'TASK_FAILED');

  const deadline = Date.now() + 15 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    const snap = await api(`/api/task/${started.taskId}`);
    if (snap.status === 'done') return snap.result;
  }
  throw new Error('等待超时');
}

async function startLogin() {
  const btn = $('#btnLogin');
  btn.disabled = true;
  $('#qrWrap').innerHTML = '<span class="empty">正在获取登录链接…</span>';
  $('#loginTip').textContent = '';

  try {
    const code = await api('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd: 'auth-get-code' }),
    });

    if (!code.ok) {
      $('#qrWrap').innerHTML = `<span class="empty">获取登录链接失败：${code.message || code.error}</span>`;
      return;
    }
    if (code.type === 'token') {
      $('#qrWrap').innerHTML = '<span class="empty">本机已有登录态</span>';
      await refreshToken();
      return;
    }

    $('#loginLink').innerHTML = `👉 <a href="${code.url}" target="_blank" rel="noreferrer">用美团 App 打开登录链接</a>`;
    const qr = await api('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd: 'qrcode', argv: [code.url] }),
    });
    if (qr.ok && qr.type === 'image') {
      $('#qrWrap').innerHTML = `<img src="${qr.imageUrl}" alt="登录二维码" />`;
    } else {
      $('#qrWrap').innerHTML = '<span class="empty">二维码生成失败，请点上方链接登录</span>';
    }

    $('#loginTip').textContent = '等待扫码中，登录完成后会自动刷新 token（最长等待 10 分钟）…';
    await startTask('auth-poll-token');
    $('#qrWrap').innerHTML = '<span class="empty">登录完成</span>';
    $('#loginTip').textContent = '';
    toast('登录成功');
    await refreshToken();
  } catch (e) {
    toast(String(e.message || e));
  } finally {
    btn.disabled = false;
  }
}

/* ---------------- 复制 / 导出 / 验证 ---------------- */

async function copyText(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${label} 已复制`);
  } catch (_) {
    toast('浏览器拒绝了复制，请手动选中复制');
  }
}

async function exportToken() {
  if (!currentToken) return toast('还没有 token');
  const r = await api('/api/export-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: currentToken }),
  });
  if (r.ok) $('#exportInfo').textContent = `已写入：${r.path}`;
  else toast(`导出失败：${r.error || r.message}`);
}

async function verifyToken() {
  if (!currentToken) return toast('还没有 token');
  $('#exportInfo').textContent = '正在验证 token…（会真实调用一次领券接口）';
  const r = await api('/api/verify-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: currentToken }),
  });
  $('#exportInfo').textContent = r.meaning || `未识别的返回：${JSON.stringify(r)}`;
}

/* ---------------- 事件 ---------------- */

$('#btnLogin').addEventListener('click', startLogin);
$('#btnLogout').addEventListener('click', async () => {
  await api('/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cmd: 'logout' }),
  });
  renderToken('');
  $('#exportInfo').textContent = '';
  $('#qrWrap').innerHTML = '<span class="empty">尚未开始登录</span>';
  toast('已退出登录');
});
$('#btnToggle').addEventListener('click', () => {
  tokenVisible = !tokenVisible;
  $('#tokenBox').value = tokenVisible ? currentToken : currentToken ? mask(currentToken) : '';
  $('#btnToggle').textContent = tokenVisible ? '隐藏 token' : '显示完整 token';
});
$('#btnCopy').addEventListener('click', () => currentToken && copyText(currentToken, 'token'));
$('#btnCopyEnv').addEventListener('click', () =>
  currentToken && copyText(`export MT_TOKEN=${currentToken}`, '青龙变量')
);
$('#btnExport').addEventListener('click', exportToken);
$('#btnVerify').addEventListener('click', verifyToken);

/* ---------------- 启动 ---------------- */

refreshToken();
