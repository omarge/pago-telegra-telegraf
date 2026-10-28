-- F05b Telegram durable ingress. Isolated KashBitPay schema (not BusinessOS).
-- The update envelope is AES-256-GCM encrypted in Node before insertion.
-- Deploy only after a reviewed migration to an isolated UAT/test database.
CREATE TABLE IF NOT EXISTS kashbit_telegram_inbox (
  update_id bigint PRIMARY KEY CHECK (update_id >= 0),
  digest char(64) NOT NULL,
  iv bytea NOT NULL CHECK (octet_length(iv) = 12),
  tag bytea NOT NULL CHECK (octet_length(tag) = 16),
  ciphertext bytea NOT NULL CHECK (octet_length(ciphertext) > 0),
  state varchar(16) NOT NULL DEFAULT 'PENDING'
    CHECK (state IN ('PENDING','PROCESSING','DONE','QUARANTINED')),
  lease_id uuid,
  leased_until timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 12),
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CHECK (
    (state = 'PROCESSING' AND lease_id IS NOT NULL AND leased_until IS NOT NULL)
    OR
    (state <> 'PROCESSING' AND lease_id IS NULL AND leased_until IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS kashbit_telegram_inbox_eligible_idx
  ON kashbit_telegram_inbox (update_id)
  WHERE state IN ('PENDING','PROCESSING');
COMMENT ON TABLE kashbit_telegram_inbox IS
  'Encrypted Telegram updates: at-least-once ingress; external side effects require separate idempotency/outbox.';
