BEGIN;
CREATE SCHEMA IF NOT EXISTS telegram_channel;
CREATE TABLE IF NOT EXISTS telegram_channel.message_inbox (
 tenant_id text NOT NULL, channel text NOT NULL, actor_id text NOT NULL,
 message_id text NOT NULL, origin_key text NOT NULL,
 payload_digest text NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,channel,actor_id,message_id),
 UNIQUE(tenant_id,origin_key)
);
CREATE TABLE IF NOT EXISTS telegram_channel.payment_consent (
 tenant_id text NOT NULL, operation_id text NOT NULL, actor_id text NOT NULL,
 card_reference text NOT NULL, amount_minor bigint NOT NULL CHECK(amount_minor>0),
 currency char(3) NOT NULL, expires_at timestamptz NOT NULL,
 state text NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','AUTHORIZED','CONSUMED')),
 authorized_at timestamptz, consumed_at timestamptz,
 PRIMARY KEY(tenant_id,operation_id)
);
CREATE TABLE IF NOT EXISTS telegram_channel.pin_verifier (
 tenant_id text NOT NULL, actor_id text NOT NULL,
 verifier text NOT NULL, attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
 locked_until timestamptz, enrolled_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,actor_id)
);
CREATE TABLE IF NOT EXISTS telegram_channel.web_session (
 token_hash char(64) PRIMARY KEY,
 tenant_id text NOT NULL, actor_id text NOT NULL,
 expires_at timestamptz NOT NULL,
 revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS web_session_active_actor
 ON telegram_channel.web_session (tenant_id,actor_id,expires_at);
CREATE TABLE IF NOT EXISTS telegram_channel.financial_handoff (
 tenant_id text NOT NULL,
 operation_id text NOT NULL,
 actor_id text NOT NULL,
 card_reference text NOT NULL,
 amount_minor bigint NOT NULL CHECK(amount_minor > 0),
 currency char(3) NOT NULL,
 status text NOT NULL DEFAULT 'HELD' CHECK (status = 'HELD'),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id, operation_id),
 FOREIGN KEY (tenant_id, operation_id)
 REFERENCES telegram_channel.payment_consent(tenant_id, operation_id)
);
COMMIT;
