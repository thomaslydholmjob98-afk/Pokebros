CREATE TABLE IF NOT EXISTS users (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, phone TEXT DEFAULT '', password_hash TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), membership_active BOOLEAN NOT NULL DEFAULT FALSE,
 membership_plan TEXT, membership_started_at TIMESTAMPTZ, membership_ended_at TIMESTAMPTZ,
 stripe_customer_id TEXT, stripe_subscription_id TEXT UNIQUE
);
CREATE TABLE IF NOT EXISTS sessions (
 token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
CREATE TABLE IF NOT EXISTS orders (
 order_id TEXT PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
 qty INTEGER NOT NULL CHECK(qty BETWEEN 1 AND 100), tier TEXT NOT NULL, unit_price_dkk INTEGER NOT NULL,
 member_price_applied BOOLEAN NOT NULL DEFAULT FALSE, grading_dkk INTEGER NOT NULL, return_shipping_dkk INTEGER NOT NULL,
 total_dkk INTEGER NOT NULL, customer_name TEXT NOT NULL, customer_email TEXT NOT NULL, customer_phone TEXT DEFAULT '',
 customer_address TEXT NOT NULL, customer_postal TEXT NOT NULL, customer_city TEXT NOT NULL, notes TEXT DEFAULT '',
 payment_status TEXT NOT NULL DEFAULT 'pending', status TEXT NOT NULL DEFAULT 'payment_pending', batch TEXT, tracking_number TEXT,
 stripe_session_id TEXT UNIQUE
);
CREATE INDEX IF NOT EXISTS orders_email_idx ON orders(customer_email);
CREATE INDEX IF NOT EXISTS orders_user_idx ON orders(user_id);
CREATE TABLE IF NOT EXISTS order_timeline (
 id BIGSERIAL PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
 at TIMESTAMPTZ NOT NULL DEFAULT NOW(), status TEXT NOT NULL, label TEXT NOT NULL, note TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS timeline_order_idx ON order_timeline(order_id, at);
