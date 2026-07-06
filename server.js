require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 30022;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const sessions = new Map();

function createSession() {
  const token = require('crypto').randomBytes(32).toString('hex');
  sessions.set(token, { createdAt: Date.now() });
  return token;
}

function isAuthed(req) {
  const token = req.headers['x-admin-token'];
  return token && sessions.has(token);
}

function requireAdmin(req, res, next) {
  if (!isAuthed(req)) {
    return res.status(401).json({ success: false, message: 'Não autorizado' });
  }
  next();
}

function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.api_key || req.query.key;
  if (!db.validateApiKey(key)) {
    return res.status(403).json({ success: false, message: 'API Key inválida' });
  }
  next();
}

function formatUid(row) {
  if (!row) return null;
  const expired = db.isExpiredRow(row);
  let effectiveStatus = row.status;
  if (expired) effectiveStatus = 'expired';
  else if (row.status === 'active') effectiveStatus = 'active';
  return { ...row, effective_status: effectiveStatus };
}

async function syncToLegacyServer(uid, username = '') {
  const baseUrl = process.env.LEGACY_API_URL;
  const apiKey = process.env.LEGACY_API_KEY;

  if (!baseUrl || !apiKey) {
    return { synced: false, skipped: true, message: 'Servidor antigo não configurado' };
  }

  try {
    const url = new URL('/api/add_uid', baseUrl.replace(/\/$/, ''));
    url.searchParams.set('uid', uid);
    url.searchParams.set('username', username || '');
    url.searchParams.set('key', apiKey);

    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(20000) });
    const body = await res.json().catch(() => ({}));

    return {
      synced: Boolean(res.ok && body.success),
      message: body.message || (res.ok ? 'Ativado no servidor antigo' : 'Falha no servidor antigo'),
      status: res.status
    };
  } catch (err) {
    return { synced: false, message: `Erro ao sincronizar: ${err.message}` };
  }
}

// --- Auth ---
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ success: false, message: 'Senha incorreta' });
  }
  const token = createSession();
  res.json({ success: true, token });
});

app.post('/api/admin/logout', requireAdmin, (req, res) => {
  sessions.delete(req.headers['x-admin-token']);
  res.json({ success: true });
});

// --- Stats ---
app.get('/api/admin/stats', requireAdmin, (req, res) => {
  res.json({ success: true, data: db.getStats() });
});

// --- UIDs (admin) ---
app.get('/api/admin/uids', requireAdmin, (req, res) => {
  const { search = '', status = '', page = 1, limit = 50 } = req.query;
  const result = db.listUids({
    search,
    status,
    page: Number(page),
    limit: Number(limit)
  });
  result.rows = result.rows.map(formatUid);
  res.json({ success: true, data: result });
});

app.post('/api/admin/uids', requireAdmin, async (req, res) => {
  try {
    const { uid, client_name, expiry_days } = req.body;
    if (!uid) {
      return res.status(400).json({ success: false, message: 'Account ID é obrigatório' });
    }
    const trimmedUid = String(uid).trim();
    const row = db.createAccount(trimmedUid, client_name || '', expiry_days || 14);
    const legacy = await syncToLegacyServer(trimmedUid, client_name || '');
    res.json({
      success: true,
      data: formatUid(row),
      legacy_sync: legacy,
      message: legacy.synced
        ? 'Ativado no seu site e no servidor antigo'
        : legacy.skipped
          ? 'Ativado no seu site (servidor antigo não configurado)'
          : 'Ativado no seu site, mas falhou no servidor antigo'
    });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/uids/bulk-delete', requireAdmin, (req, res) => {
  const { uids } = req.body;
  if (!Array.isArray(uids) || uids.length === 0) {
    return res.status(400).json({ success: false, message: 'Lista de UIDs inválida' });
  }
  const deleted = db.deleteUids(uids.map(String));
  res.json({ success: true, data: { deleted } });
});

app.post('/api/admin/uids/:uid/activate', requireAdmin, async (req, res) => {
  try {
    const row = db.activateUid(req.params.uid);
    const legacy = await syncToLegacyServer(row.uid, row.client_name || '');
    res.json({
      success: true,
      data: formatUid(row),
      legacy_sync: legacy,
      message: legacy.synced
        ? 'Ativado nos dois servidores'
        : 'Ativado no seu site' + (legacy.skipped ? '' : ', falhou no servidor antigo')
    });
  } catch (err) {
    res.status(404).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/uids/:uid/deactivate', requireAdmin, (req, res) => {
  try {
    const row = db.deactivateUid(req.params.uid);
    res.json({ success: true, data: formatUid(row) });
  } catch (err) {
    res.status(404).json({ success: false, message: err.message });
  }
});

app.delete('/api/admin/uids/:uid', requireAdmin, (req, res) => {
  db.deleteUid(req.params.uid);
  res.json({ success: true });
});

// --- API Keys (admin) ---
app.get('/api/admin/keys', requireAdmin, (req, res) => {
  res.json({ success: true, data: db.listApiKeys() });
});

app.post('/api/admin/keys', requireAdmin, (req, res) => {
  const { name } = req.body;
  if (!name) {
    return res.status(400).json({ success: false, message: 'Nome é obrigatório' });
  }
  const key = db.createApiKey(name);
  res.json({ success: true, data: key });
});

app.patch('/api/admin/keys/:id', requireAdmin, (req, res) => {
  const { active } = req.body;
  db.toggleApiKey(req.params.id, Boolean(active));
  res.json({ success: true });
});

app.delete('/api/admin/keys/:id', requireAdmin, (req, res) => {
  db.deleteApiKey(req.params.id);
  res.json({ success: true });
});

// --- Public API (client activation) ---

// Compatível com apps C# antigos (GET /api/add_uid?uid=&username=&key=)
app.get('/api/add_uid', (req, res) => {
  const key = req.query.key || req.query.api_key;
  if (!db.validateApiKey(key)) {
    return res.status(403).json({ success: false, message: 'Invalid API key' });
  }

  const uid = String(req.query.uid || '').trim();
  const username = String(req.query.username || '').trim();
  const days = Number(req.query.days) || Number(process.env.DEFAULT_EXPIRY_DAYS) || 14;

  if (!uid) {
    return res.status(400).json({ success: false, message: 'Please enter UID!' });
  }

  try {
    let row = db.getUid(uid);
    if (row) {
      if (username) db.updateClientName(uid, username);
      if (db.isExpiredRow(row) || row.status !== 'active') {
        row = db.reactivateAccount(uid, days);
      } else {
        row = db.getUid(uid);
      }
      return res.json({
        success: true,
        message: `UID ${uid} activated successfully`,
        data: formatUid(row)
      });
    }

    row = db.createAccount(uid, username, days);
    res.json({
      success: true,
      message: `UID ${uid} added successfully`,
      data: formatUid(row)
    });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

app.post('/api/v1/activate', requireApiKey, (req, res) => {
  const { uid } = req.body;
  if (!uid) {
    return res.status(400).json({ success: false, message: 'UID é obrigatório' });
  }

  let row = db.getUid(String(uid).trim());
  if (!row) {
    row = db.createUid(String(uid).trim());
  }

  if (db.isExpiredRow(row)) {
    return res.status(403).json({ success: false, message: 'UID expirado', data: formatUid(row) });
  }

  if (row.status !== 'active') {
    row = db.activateUid(row.uid);
  }

  res.json({
    success: true,
    message: 'UID ativado com sucesso',
    data: formatUid(row)
  });
});

app.get('/api/v1/check/:uid', requireApiKey, (req, res) => {
  const row = db.getUid(req.params.uid);
  if (!row) {
    return res.status(404).json({ success: false, message: 'UID não encontrado', active: false });
  }

  const expired = db.isExpiredRow(row);
  const active = row.status === 'active' && !expired;

  res.json({
    success: true,
    active,
    data: formatUid(row)
  });
});

app.post('/api/v1/deactivate', requireApiKey, (req, res) => {
  const { uid } = req.body;
  if (!uid) {
    return res.status(400).json({ success: false, message: 'UID é obrigatório' });
  }
  try {
    const row = db.deactivateUid(String(uid).trim());
    res.json({ success: true, message: 'UID desativado', data: formatUid(row) });
  } catch (err) {
    res.status(404).json({ success: false, message: err.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`UID Manager rodando em http://0.0.0.0:${PORT}`);
  console.log(`Senha admin padrão: ${ADMIN_PASSWORD}`);
});
