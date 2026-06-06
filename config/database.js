const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '../zapcoin.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    email       TEXT UNIQUE NOT NULL,
    phone       TEXT UNIQUE,
    password    TEXT NOT NULL,
    balance     INTEGER DEFAULT 0,
    streak      INTEGER DEFAULT 0,
    last_login  TEXT,
    referral_code TEXT UNIQUE,
    referred_by TEXT,
    role        TEXT DEFAULT 'user',
    created_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS coin_price (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    price_ngn   REAL NOT NULL,
    set_by      TEXT,
    created_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    type        TEXT NOT NULL,
    amount      INTEGER NOT NULL,
    naira_value REAL,
    description TEXT,
    ref         TEXT UNIQUE,
    status      TEXT DEFAULT 'pending',
    created_at  TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS payments (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL,
    provider     TEXT NOT NULL,
    ref          TEXT UNIQUE NOT NULL,
    amount_ngn   REAL NOT NULL,
    coins_bought INTEGER,
    status       TEXT DEFAULT 'pending',
    metadata     TEXT,
    created_at   TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS market_orders (
    id           TEXT PRIMARY KEY,
    seller_id    TEXT NOT NULL,
    buyer_id     TEXT,
    coins        INTEGER NOT NULL,
    price_ngn    REAL NOT NULL,
    total_ngn    REAL NOT NULL,
    fee_coins    INTEGER DEFAULT 0,
    status       TEXT DEFAULT 'open',
    created_at   TEXT DEFAULT (datetime('now')),
    filled_at    TEXT,
    FOREIGN KEY(seller_id) REFERENCES users(id),
    FOREIGN KEY(buyer_id)  REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS stakes (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL,
    coins        INTEGER NOT NULL,
    rate_pct     REAL NOT NULL,
    duration_days INTEGER NOT NULL,
    earned       INTEGER DEFAULT 0,
    status       TEXT DEFAULT 'active',
    started_at   TEXT DEFAULT (datetime('now')),
    ends_at      TEXT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS redemptions (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL,
    type         TEXT NOT NULL,
    phone        TEXT NOT NULL,
    network      TEXT DEFAULT 'MTN',
    coins        INTEGER NOT NULL,
    naira_value  REAL NOT NULL,
    plan         TEXT,
    status       TEXT DEFAULT 'pending',
    provider_ref TEXT,
    created_at   TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS platform_earnings (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    source     TEXT,
    amount_ngn REAL,
    coins      INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  INSERT OR IGNORE INTO coin_price (id, price_ngn, set_by) VALUES (1, 0.5, 'system');
`);

console.log('✅ Database initialized');
module.exports = db;
