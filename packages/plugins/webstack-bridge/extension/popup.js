/**
 * WebStack Bridge popup：状态显示 + 配对/解除配对。纯 DOM，无构建步骤。
 * 状态来源：打开时 get-state 拉一次，之后由 background 的 bridge-state
 * 广播与 storage 变化驱动刷新。
 */

const els = {
  status: document.getElementById('status'),
  port: document.getElementById('port'),
  ticket: document.getElementById('ticket'),
  pair: document.getElementById('pair'),
  unpair: document.getElementById('unpair'),
  message: document.getElementById('message'),
};

/** @param {{paired: boolean, connected: boolean, connecting: boolean, port: number|null}} state */
function renderStatus(state) {
  let text = '未配对';
  let cls = 'status unpaired';
  if (state.connected) {
    text = '已配对 · 已连接宿主';
    cls = 'status paired';
  } else if (state.connecting || state.paired) {
    text = state.paired ? '已配对 · 连接中…' : '连接中…';
    cls = 'status connecting';
  }
  if (state.port !== null && state.port !== undefined) {
    text += `（端口 ${state.port}）`;
    els.port.value = String(state.port);
  }
  els.status.textContent = text;
  els.status.className = cls;
  els.unpair.disabled = !state.paired && !state.connecting;
}

function showMessage(text) {
  els.message.textContent = text ?? '';
}

async function refresh() {
  try {
    const state = await chrome.runtime.sendMessage({ type: 'get-state' });
    if (state) renderStatus(state);
  } catch {
    showMessage('无法联系后台：请重开弹窗或检查扩展是否被浏览器挂起');
  }
}

els.pair.addEventListener('click', async () => {
  showMessage('');
  els.pair.disabled = true;
  try {
    // 先落端口（可编辑），再发起配对——首次使用时两者一步完成。
    const portRaw = Number(els.port.value);
    if (Number.isInteger(portRaw) && portRaw >= 1 && portRaw <= 65535) {
      await chrome.runtime.sendMessage({ type: 'set-port', port: portRaw });
    }
    const outcome = await chrome.runtime.sendMessage({ type: 'pair', ticket: els.ticket.value });
    if (!outcome?.ok) showMessage(outcome?.error ?? '配对失败');
    else {
      showMessage('配对成功：key 已保存到本机');
      els.ticket.value = '';
    }
  } catch (error) {
    showMessage(`配对失败：${String(error)}`);
  } finally {
    els.pair.disabled = false;
    await refresh();
  }
});

els.unpair.addEventListener('click', async () => {
  showMessage('');
  try {
    await chrome.runtime.sendMessage({ type: 'unpair' });
    showMessage('已解除配对');
  } catch (error) {
    showMessage(`解除失败：${String(error)}`);
  } finally {
    await refresh();
  }
});

chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === 'local') void refresh();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'bridge-state') renderStatus(message);
});

void refresh();
