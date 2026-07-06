const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(path.join(dataDir, 'uid-manager.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    key_prefix TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS uids (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uid TEXT NOT NULL UNIQUE,
    client_name TEXT,
    status TEXT NOT NULL DEFAULT 'inactive',
    notes TEXT,
    activated_at TEXT,
    expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_uids_status ON uids(status);
  CREATE INDEX IF NOT EXISTS idx_uids_uid ON uids(uid);
`);

const columns = db.prepare('PRAGMA table_info(uids)').all().map((c) => c.name);
if (!columns.includes('client_name')) {
  db.exec('ALTER TABLE uids ADD COLUMN client_name TEXT');
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
  const count = db.prepare('SELECT COUNT(*) AS total FROM api_keys').get().total;
  if (count === 0) {
    const { raw, hash, prefix } = generateApiKey();
    db.prepare(
      'INSERT INTO api_keys (id, name, key_hash, key_prefix) VALUES (?, ?, ?, ?)'
    ).run(uuidv4(), 'Chave padrão', hash, prefix);
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
  const row = db.prepare(
    'SELECT id FROM api_keys WHERE key_hash = ? AND active = 1'
  ).get(hashKey(key));
  return Boolean(row);
}

function listApiKeys() {
  return db.prepare(
    'SELECT id, name, key_prefix, active, created_at FROM api_keys ORDER BY created_at DESC'
  ).all();
}

function createApiKey(name) {
  const { raw, hash, prefix } = generateApiKey();
  const id = uuidv4();
  db.prepare(
    'INSERT INTO api_keys (id, name, key_hash, key_prefix) VALUES (?, ?, ?, ?)'
  ).run(id, name, hash, prefix);
  return { id, name, key: raw, prefix };
}

function toggleApiKey(id, active) {
  db.prepare('UPDATE api_keys SET active = ? WHERE id = ?').run(active ? 1 : 0, id);
}

function deleteApiKey(id) {
  db.prepare('DELETE FROM api_keys WHERE id = ?').run(id);
}

function listUids({ search = '', status = '', page = 1, limit = 100 } = {}) {
  const offset = (page - 1) * limit;
  let where = 'WHERE 1=1';
  const params = [];

  if (search) {
    where += ' AND (uid LIKE ? OR client_name LIKE ? OR notes LIKE ?)';
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (status === 'active') {
    where += " AND status = 'active' AND (expires_at IS NULL OR expires_at > datetime('now'))";
  } else if (status === 'expired') {
    where += " AND expires_at IS NOT NULL AND expires_at <= datetime('now')";
  } else if (status === 'inactive') {
    where += " AND status = 'inactive'";
  }

  const total = db.prepare(`SELECT COUNT(*) AS total FROM uids ${where}`).get(...params).total;
  const rows = db.prepare(
    `SELECT * FROM uids ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);

  return { rows, total, page, limit };
}

function getUid(uid) {
  return db.prepare('SELECT * FROM uids WHERE uid = ?').get(uid);
}

function createAccount(uid, clientName = '', expiryDays = 14) {
  const existing = getUid(uid);
  if (existing) {
    throw new Error('Account ID já existe');
  }
  const expiresAt = addDays(expiryDays);
  db.prepare(`
    INSERT INTO uids (uid, client_name, status, activated_at, expires_at)
    VALUES (?, ?, 'active', datetime('now'), ?)
  `).run(uid, clientName, expiresAt);
  return getUid(uid);
}

function createUid(uid, clientName = '', expiresAt = null) {
  const existing = getUid(uid);
  if (existing) {
    throw new Error('UID já existe');
  }
  db.prepare(
    'INSERT INTO uids (uid, client_name, expires_at) VALUES (?, ?, ?)'
  ).run(uid, clientName, expiresAt);
  return getUid(uid);
}

function activateUid(uid) {
  const row = getUid(uid);
  if (!row) {
    throw new Error('UID não encontrado');
  }
  db.prepare(`
    UPDATE uids
    SET status = 'active', activated_at = datetime('now'), updated_at = datetime('now')
    WHERE uid = ?
  `).run(uid);
  return getUid(uid);
}

function deactivateUid(uid) {
  const row = getUid(uid);
  if (!row) {
    throw new Error('UID não encontrado');
  }
  db.prepare(`
    UPDATE uids
    SET status = 'inactive', updated_at = datetime('now')
    WHERE uid = ?
  `).run(uid);
  return getUid(uid);
}

function deleteUid(uid) {
  db.prepare('DELETE FROM uids WHERE uid = ?').run(uid);
}

function deleteUids(uids) {
  const del = db.prepare('DELETE FROM uids WHERE uid = ?');
  const tx = db.transaction((items) => {
    let deleted = 0;
    for (const uid of items) {
      deleted += del.run(uid).changes;
    }
    return deleted;
  });
  return tx(uids);
}

function getStats() {
  const total = db.prepare('SELECT COUNT(*) AS c FROM uids').get().c;
  const active = db.prepare(`
    SELECT COUNT(*) AS c FROM uids
    WHERE status = 'active' AND (expires_at IS NULL OR expires_at > datetime('now'))
  `).get().c;
  const expired = db.prepare(`
    SELECT COUNT(*) AS c FROM uids
    WHERE expires_at IS NOT NULL AND expires_at <= datetime('now')
  `).get().c;
  const keys = db.prepare('SELECT COUNT(*) AS c FROM api_keys WHERE active = 1').get().c;
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
