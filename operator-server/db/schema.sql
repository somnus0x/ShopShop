PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS inquiries (
  id TEXT PRIMARY KEY,
  recipient TEXT NOT NULL CHECK (recipient = 'supasonk'),
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'claimed', 'sent', 'failed', 'needs_attention')),
  claim_token TEXT,
  created_at TEXT NOT NULL,
  claimed_at TEXT,
  completed_at TEXT,
  evidence TEXT
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  event_name TEXT NOT NULL CHECK (event_name = 'inquiry.created'),
  recipient TEXT NOT NULL CHECK (recipient = 'supasonk'),
  callback_url TEXT NOT NULL,
  signing_secret TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

CREATE TABLE IF NOT EXISTS event_outbox (
  event_id TEXT PRIMARY KEY,
  inquiry_id TEXT NOT NULL UNIQUE REFERENCES inquiries(id),
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deliveries (
  event_id TEXT NOT NULL REFERENCES event_outbox(event_id),
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'delivered', 'failed', 'cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_http_status INTEGER,
  error_code TEXT,
  delivered_at TEXT,
  PRIMARY KEY (event_id, subscription_id)
);
CREATE INDEX IF NOT EXISTS deliveries_due ON deliveries(status, next_attempt_at);

CREATE TABLE IF NOT EXISTS product_inquiries (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  product_id TEXT NOT NULL,
  product_name TEXT NOT NULL,
  merchant TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'claimed', 'sent', 'needs_attention')),
  claim_token TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS merchant_replies (
  inquiry_id TEXT NOT NULL REFERENCES product_inquiries(id),
  message_id TEXT NOT NULL,
  text TEXT,
  qr_image_url TEXT,
  received_at TEXT NOT NULL,
  PRIMARY KEY (inquiry_id, message_id)
);
