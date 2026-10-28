-- F05e-02: demo-only Telegram invite and one-time redemption.
-- NOT a BusinessOS PaymentIntent, CustomerVault card, authorization or charge.
-- Requires f05b_telegram_durable_inbox.sql; isolated UAT schema only.
CREATE TABLE IF NOT EXISTS kashbit_telegram_demo_invites (
  invite_id uuid PRIMARY KEY,
  source_update_id bigint NOT NULL UNIQUE REFERENCES kashbit_telegram_inbox(update_id),
  token_digest char(64) NOT NULL UNIQUE CHECK (token_digest ~ '^[0-9a-f]{64}$'),
  requester_telegram_id bigint NOT NULL CHECK (requester_telegram_id > 0),
  amount_cents bigint NOT NULL CHECK (amount_cents BETWEEN 1 AND 100000000),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '15 minutes'),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '15 minutes')
);
CREATE TABLE IF NOT EXISTS kashbit_telegram_demo_claims (
  invite_id uuid PRIMARY KEY REFERENCES kashbit_telegram_demo_invites(invite_id),
  redemption_update_id bigint NOT NULL UNIQUE REFERENCES kashbit_telegram_inbox(update_id),
  payer_telegram_id bigint NOT NULL CHECK (payer_telegram_id > 0),
  claimed_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION kashbit_tg_demo_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'kashbit_demo_immutable' USING ERRCODE='P0001';
END;
$$;
DROP TRIGGER IF EXISTS kashbit_tg_demo_invites_immutable ON kashbit_telegram_demo_invites;
CREATE TRIGGER kashbit_tg_demo_invites_immutable
BEFORE UPDATE OR DELETE ON kashbit_telegram_demo_invites
FOR EACH ROW EXECUTE FUNCTION kashbit_tg_demo_immutable();
DROP TRIGGER IF EXISTS kashbit_tg_demo_claims_immutable ON kashbit_telegram_demo_claims;
CREATE TRIGGER kashbit_tg_demo_claims_immutable
BEFORE UPDATE OR DELETE ON kashbit_telegram_demo_claims
FOR EACH ROW EXECUTE FUNCTION kashbit_tg_demo_immutable();
COMMENT ON TABLE kashbit_telegram_demo_invites IS
  'NON-FINANCIAL UAT invite metadata. Not a payment or authorization.';
COMMENT ON TABLE kashbit_telegram_demo_claims IS
  'At-most-one recipient claim per UAT invite. Never an economic completion.';
