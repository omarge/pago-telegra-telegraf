-- F05d: Telegram outbound intents, isolated from BusinessOS financial tables.
-- Separate migration, NOT executed by current runtime; apply only to disposable CI/UAT.
-- READY -> IN_FLIGHT -> SENT/UNKNOWN.  IN_FLIGHT is never automatically retried.
CREATE TABLE IF NOT EXISTS kashbit_telegram_outbox (
    update_id bigint NOT NULL REFERENCES kashbit_telegram_inbox(update_id),
    action_key varchar(96) NOT NULL CHECK (action_key ~ '^[a-zA-Z][a-zA-Z0-9_-]{0,95}$'),
    digest char(64) NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
    iv bytea NOT NULL CHECK (octet_length(iv)=12),
    tag bytea NOT NULL CHECK (octet_length(tag)=16),
    ciphertext bytea NOT NULL CHECK (octet_length(ciphertext)>0),
    state varchar(16) NOT NULL DEFAULT 'READY'
      CHECK (state IN ('READY','IN_FLIGHT','SENT','UNKNOWN')),
    attempts smallint NOT NULL DEFAULT 0 CHECK (attempts IN (0,1)),
    dispatch_id uuid,
    started_at timestamptz,
    finished_at timestamptz,
    telegram_message_id bigint,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (update_id, action_key),
    CONSTRAINT kashbit_tg_outbox_state_valid CHECK (
      (state='READY' AND attempts=0 AND dispatch_id IS NULL AND
       started_at IS NULL AND finished_at IS NULL AND telegram_message_id IS NULL)
      OR
      (state='IN_FLIGHT' AND attempts=1 AND dispatch_id IS NOT NULL AND
       started_at IS NOT NULL AND finished_at IS NULL AND telegram_message_id IS NULL)
      OR
      (state='SENT' AND attempts=1 AND dispatch_id IS NOT NULL AND
       started_at IS NOT NULL AND finished_at IS NOT NULL AND telegram_message_id > 0)
      OR
      (state='UNKNOWN' AND attempts=1 AND dispatch_id IS NOT NULL AND
       started_at IS NOT NULL AND finished_at IS NOT NULL AND telegram_message_id IS NULL)
    )
);
CREATE INDEX IF NOT EXISTS kashbit_tg_outbox_ready_idx
  ON kashbit_telegram_outbox(update_id, action_key) WHERE state='READY';
CREATE INDEX IF NOT EXISTS kashbit_tg_outbox_uncertain_idx
  ON kashbit_telegram_outbox(started_at) WHERE state IN ('IN_FLIGHT','UNKNOWN');

-- Enforce immutable effect identity/payload and strictly monotonic statuses.
CREATE OR REPLACE FUNCTION kashbit_tg_outbox_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'telegram_outbox_immutable' USING ERRCODE='P0001';
  END IF;
  IF OLD.update_id IS DISTINCT FROM NEW.update_id OR
     OLD.action_key IS DISTINCT FROM NEW.action_key OR
     OLD.digest IS DISTINCT FROM NEW.digest OR
     OLD.iv IS DISTINCT FROM NEW.iv OR
     OLD.tag IS DISTINCT FROM NEW.tag OR
     OLD.ciphertext IS DISTINCT FROM NEW.ciphertext OR
     OLD.created_at IS DISTINCT FROM NEW.created_at OR
     (OLD.state='READY' AND NEW.state <> 'IN_FLIGHT') OR
     (OLD.state='IN_FLIGHT' AND NEW.state NOT IN ('SENT','UNKNOWN')) OR
     OLD.state IN ('SENT','UNKNOWN') THEN
    RAISE EXCEPTION 'telegram_outbox_immutable' USING ERRCODE='P0001';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS kashbit_tg_outbox_immutable
  ON kashbit_telegram_outbox;
CREATE TRIGGER kashbit_tg_outbox_immutable
BEFORE UPDATE OR DELETE ON kashbit_telegram_outbox
FOR EACH ROW EXECUTE FUNCTION kashbit_tg_outbox_guard();

COMMENT ON TABLE kashbit_telegram_outbox IS
  'Conservative single-send Telegram intents; UNKNOWN requires manual reconciliation and never automatic re-send.';
