const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

const dataDir = path.join(__dirname, 'data');
const dbFile = path.join(dataDir, 'store.json');

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

function now() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function load() {
  if (!fs.existsSync(dbFile)) {
    return { api_keys: [], uids: [], nextId: 1 };
  }
  return JSON.parse(fs.readFileSync(dbFile, 'utf8'));
}

function save(data) {
  fs.writeFileSync(dbFile, JSON.stringify(data, null, 2));
}

function hashKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

function generateApiKey() {
  const raw = `uk_${crypto.randomBytes(24).toString('hex')}`;
  return {
    raw,
    hash: hashKey(raw),
    prefix: raw.slice(0, 12) + '...'
  };
}

function ensureDefaultApiKey() {
  const data = load();
  if (data.api_keys.length === 0) {
    const { raw, hash, prefix } = generateApiKey();
    data.api_keys.push({
      id: uuidv4(),
      name: 'Chave padrão',
      key_hash: hash,
      key_prefix: prefix,
      active: 1,
      created_at: now()
    });
    save(data);
    console.log('\n========================================');
    console.log('API Key padrão criada (guarde agora!):');
    console.log(raw);
    console.log('========================================\n');
  }
}

ensureDefaultApiKey();

function addDays(days) {
  const d = new Date();
  d.setDate(d.getDate() + Number(days));
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function isExpiredRow(row) {
  if (!row?.expires_at) return false;
  return new Date(row.expires_at.replace(' ', 'T') + 'Z') < new Date();
}

function validateApiKey(key) {
  if (!key) return false;
  const data = load();
  return data.api_keys.some((k) => k.key_hash === hashKey(key) && k.active === 1);
}

function listApiKeys() {
  return load().api_keys
    .map(({ id, name, key_prefix, active, created_at }) => ({ id, name, key_prefix, active, created_at }))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

function createApiKey(name) {
  const data = load();
  const { raw, hash, prefix } = generateApiKey();
  const id = uuidv4();
  data.api_keys.push({ id, name, key_hash: hash, key_prefix: prefix, active: 1, created_at: now() });
  save(data);
  return { id, name, key: raw, prefix };
}

function toggleApiKey(id, active) {
  const data = load();
  const key = data.api_keys.find((k) => k.id === id);
  if (key) key.active = active ? 1 : 0;
  save(data);
}

function deleteApiKey(id) {
  const data = load();
  data.api_keys = data.api_keys.filter((k) => k.id !== id);
  save(data);
}

function filterUids(uids, { search = '', status = '' } = {}) {
  const ts = now();
  return uids.filter((row) => {
    if (search) {
      const q = search.toLowerCase();
      const match = row.uid.toLowerCase().includes(q)
        || (row.client_name || '').toLowerCase().includes(q)
        || (row.notes || '').toLowerCase().includes(q);
      if (!match) return false;
    }
    if (status === 'active') {
      return row.status === 'active' && (!row.expires_at || row.expires_at > ts);
    }
    if (status === 'expired') {
      return row.expires_at && row.expires_at <= ts;
    }
    if (status === 'inactive') {
      return row.status === 'inactive';
    }
    return true;
  });
}

function listUids({ search = '', status = '', page = 1, limit = 100 } = {}) {
  const data = load();
  const filtered = filterUids(data.uids, { search, status })
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  const offset = (page - 1) * limit;
  return {
    rows: filtered.slice(offset, offset + limit),
    total: filtered.length,
    page,
    limit
  };
}

function getUid(uid) {
  return load().uids.find((u) => u.uid === uid) || null;
}

function createAccount(uid, clientName = '', expiryDays = 14) {
  if (getUid(uid)) throw new Error('Account ID já existe');
  const data = load();
  const row = {
    id: data.nextId++,
    uid,
    client_name: clientName,
    status: 'active',
    notes: null,
    activated_at: now(),
    expires_at: addDays(expiryDays),
    created_at: now(),
    updated_at: now()
  };
  data.uids.push(row);
  save(data);
  return row;
}

function createUid(uid, clientName = '', expiresAt = null) {
  if (getUid(uid)) throw new Error('UID já existe');
  const data = load();
  const row = {
    id: data.nextId++,
    uid,
    client_name: clientName,
    status: 'inactive',
    notes: null,
    activated_at: null,
    expires_at: expiresAt,
    created_at: now(),
    updated_at: now()
  };
  data.uids.push(row);
  save(data);
  return row;
}

function activateUid(uid) {
  const data = load();
  const row = data.uids.find((u) => u.uid === uid);
  if (!row) throw new Error('UID não encontrado');
  row.status = 'active';
  row.activated_at = now();
  row.updated_at = now();
  save(data);
  return row;
}

function deactivateUid(uid) {
  const data = load();
  const row = data.uids.find((u) => u.uid === uid);
  if (!row) throw new Error('UID não encontrado');
  row.status = 'inactive';
  row.updated_at = now();
  save(data);
  return row;
}

function deleteUid(uid) {
  const data = load();
  data.uids = data.uids.filter((u) => u.uid !== uid);
  save(data);
}

function deleteUids(uids) {
  const data = load();
  const set = new Set(uids.map(String));
  const before = data.uids.length;
  data.uids = data.uids.filter((u) => !set.has(u.uid));
  save(data);
  return before - data.uids.length;
}

function getStats() {
  const data = load();
  const ts = now();
  const total = data.uids.length;
  const active = data.uids.filter((u) => u.status === 'active' && (!u.expires_at || u.expires_at > ts)).length;
  const expired = data.uids.filter((u) => u.expires_at && u.expires_at <= ts).length;
  const keys = data.api_keys.filter((k) => k.active === 1).length;
  return { total, active, expired, keys };
}

module.exports = {
  validateApiKey,
  listApiKeys,
  createApiKey,
  toggleApiKey,
  deleteApiKey,
  listUids,
  getUid,
  createUid,
  createAccount,
  activateUid,
  deactivateUid,
  deleteUid,
  deleteUids,
  getStats,
  isExpiredRow
};
