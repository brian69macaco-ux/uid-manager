let token = localStorage.getItem('adminToken');
const selected = new Set();

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
const loginScreen = $('#login-screen');
const app = $('#app');
const modal = $('#modal');

function showToast(msg, isError = false) {
  const toast = $('#toast');
  toast.textContent = msg;
  toast.style.borderColor = isError ? 'var(--red)' : 'var(--green)';
  toast.classList.remove('hidden');
  setTimeout(() => toast.classList.add('hidden'), 3000);
}

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (token) headers['X-Admin-Token'] = token;
  const res = await fetch(path, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.includes('/login')) {
    logout();
    throw new Error('Sessão expirada');
  }
  if (!res.ok) throw new Error(data.message || 'Erro na requisição');
  return data;
}

function logout() {
  token = null;
  localStorage.removeItem('adminToken');
  app.classList.add('hidden');
  loginScreen.classList.remove('hidden');
}

function formatDateShort(d) {
  if (!d) return '—';
  const date = new Date(d.replace(' ', 'T') + 'Z');
  return date.toISOString().slice(0, 10);
}

function formatDateLong(d) {
  if (!d) return '—';
  const date = new Date(d);
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

function updateExpiryPreview() {
  const days = Number($('#expiry-days').value) || 14;
  const expires = new Date();
  expires.setDate(expires.getDate() + days);
  $('#preview-days').textContent = `${days} days`;
  $('#preview-date').textContent = `Expires on ${formatDateLong(expires)}`;
}

function statusCell(row) {
  const s = row.effective_status || row.status;
  if (s === 'active') {
    return `<span class="status-active">Active <span class="status-dots"><i></i><i></i></span></span>`;
  }
  if (s === 'expired') {
    return `<span class="status-expired">Expired</span>`;
  }
  return `<span class="status-expired">Inactive</span>`;
}

async function loadStats() {
  const { data } = await api('/api/admin/stats');
  $('#stat-total').textContent = data.total;
  $('#stat-active').textContent = data.active;
  $('#stat-expired').textContent = data.expired;
}

async function loadUids() {
  const search = $('#search-input').value;
  const params = new URLSearchParams({ search, limit: 200 });
  const { data } = await api(`/api/admin/uids?${params}`);

  const tbody = $('#uids-table');
  if (!data.rows.length) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:2rem">Nenhum Account ID registrado</td></tr>';
    return;
  }

  tbody.innerHTML = data.rows.map((row) => `
    <tr data-uid="${row.uid}">
      <td class="col-check">
        <input type="checkbox" class="row-check" value="${row.uid}" ${selected.has(row.uid) ? 'checked' : ''}>
      </td>
      <td class="account-cell">
        <strong>${row.uid}</strong>
        <span>${row.client_name || '—'}</span>
      </td>
      <td>${statusCell(row)}</td>
      <td>${formatDateShort(row.expires_at)}</td>
      <td>
        <button class="btn-icon" title="Excluir" onclick="deleteUid('${row.uid}')">🗑</button>
      </td>
    </tr>
  `).join('');

  $$('.row-check').forEach((cb) => {
    cb.addEventListener('change', () => {
      if (cb.checked) selected.add(cb.value);
      else selected.delete(cb.value);
    });
  });
}

async function loadKeys() {
  const { data } = await api('/api/admin/keys');
  const tbody = $('#keys-table');
  if (!data.length) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--muted)">Nenhuma API Key</td></tr>';
    return;
  }
  tbody.innerHTML = data.map((key) => `
    <tr>
      <td>${key.name}</td>
      <td><code>${key.key_prefix}</code></td>
      <td><span class="badge ${key.active ? 'enabled' : 'disabled'}">${key.active ? 'Ativa' : 'Desativada'}</span></td>
      <td>${formatDateShort(key.created_at)}</td>
      <td>
        <button class="tool-btn" onclick="toggleKey('${key.id}', ${!key.active})">${key.active ? 'Desativar' : 'Ativar'}</button>
        <button class="tool-btn danger" onclick="deleteKey('${key.id}')">Excluir</button>
      </td>
    </tr>
  `).join('');
}

async function refreshAll() {
  await Promise.all([loadStats(), loadUids(), loadKeys()]);
}

function showPage(name) {
  $$('.page').forEach((p) => p.classList.remove('active'));
  $$('.nav-item').forEach((n) => n.classList.remove('active'));
  const page = $(`#page-${name}`);
  const nav = $(`.nav-item[data-page="${name}"]`);
  if (page) page.classList.add('active');
  if (nav) nav.classList.add('active');
  if (name === 'settings') loadKeys();
}

function openModal(title, bodyHtml, onConfirm, confirmText = 'Confirmar') {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = bodyHtml;
  $('#modal-confirm').textContent = confirmText;
  modal.classList.remove('hidden');
  const confirmBtn = $('#modal-confirm');
  const newConfirm = confirmBtn.cloneNode(true);
  confirmBtn.parentNode.replaceChild(newConfirm, confirmBtn);
  newConfirm.onclick = async () => {
    await onConfirm();
    closeModal();
  };
}

function closeModal() {
  modal.classList.add('hidden');
}

window.deleteUid = async (uid) => {
  if (!confirm(`Excluir Account ID ${uid}?`)) return;
  await api(`/api/admin/uids/${uid}`, { method: 'DELETE' });
  selected.delete(uid);
  showToast('Account ID excluído');
  refreshAll();
};

window.toggleKey = async (id, active) => {
  await api(`/api/admin/keys/${id}`, { method: 'PATCH', body: JSON.stringify({ active }) });
  showToast(active ? 'API Key ativada' : 'API Key desativada');
  loadKeys();
};

window.deleteKey = async (id) => {
  if (!confirm('Excluir esta API Key?')) return;
  await api(`/api/admin/keys/${id}`, { method: 'DELETE' });
  showToast('API Key excluída');
  loadKeys();
};

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const { token: t } = await api('/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({ password: $('#password').value })
    });
    token = t;
    localStorage.setItem('adminToken', t);
    loginScreen.classList.add('hidden');
    app.classList.remove('hidden');
    updateExpiryPreview();
    await refreshAll();
  } catch (err) {
    $('#login-error').textContent = err.message;
    $('#login-error').classList.remove('hidden');
  }
});

$('#add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const uid = $('#account-id').value.trim();
    const client_name = $('#client-name').value.trim();
    const expiry_days = Number($('#expiry-days').value) || 14;
    await api('/api/admin/uids', {
      method: 'POST',
      body: JSON.stringify({ uid, client_name, expiry_days })
    });
    $('#account-id').value = '';
    $('#client-name').value = '';
    showToast('Account ID adicionado com sucesso');
    refreshAll();
  } catch (err) {
    showToast(err.message, true);
  }
});

$('#expiry-days').addEventListener('input', updateExpiryPreview);

$$('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => showPage(btn.dataset.page));
});

$('#search-input').addEventListener('input', () => loadUids());

$('#select-all-btn').onclick = () => {
  $$('.row-check').forEach((cb) => {
    cb.checked = true;
    selected.add(cb.value);
  });
};

$('#expand-btn').onclick = () => {
  $('#table-wrap').classList.toggle('expanded');
};

$('#clear-btn').onclick = async () => {
  if (selected.size === 0) {
    showToast('Nenhum item selecionado', true);
    return;
  }
  if (!confirm(`Excluir ${selected.size} Account ID(s)?`)) return;
  await api('/api/admin/uids/bulk-delete', {
    method: 'POST',
    body: JSON.stringify({ uids: [...selected] })
  });
  selected.clear();
  showToast('Selecionados excluídos');
  refreshAll();
};

$('#add-key-btn').onclick = () => {
  openModal('Nova API Key', `
    <div class="field"><label>Nome da chave</label><input id="key-name" placeholder="Ex: App Cliente"></div>
  `, async () => {
    const name = $('#key-name').value.trim();
    if (!name) throw new Error('Nome obrigatório');
    const { data } = await api('/api/admin/keys', {
      method: 'POST',
      body: JSON.stringify({ name })
    });
    openModal('API Key criada — copie agora!', `
      <p style="color:var(--red);margin-bottom:.5rem">Esta chave só aparece uma vez. Guarde em local seguro.</p>
      <div class="key-reveal">${data.key}</div>
    `, async () => {}, 'Fechar');
    loadKeys();
  });
};

$('#modal-cancel').onclick = closeModal;

if (token) {
  loginScreen.classList.add('hidden');
  app.classList.remove('hidden');
  updateExpiryPreview();
  refreshAll().catch(logout);
} else {
  updateExpiryPreview();
}
