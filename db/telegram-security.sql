BEGIN;
CREATE SCHEMA IF NOT EXISTS telegram_channel;
CREATE TABLE IF NOT EXISTS telegram_channel.message_inbox (
 tenant_id text NOT NULL, channel text NOT NULL, actor_id text NOT NULL,
 message_id text NOT NULL, origin_key text NOT NULL,
 payload_digest text NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,channel,actor_id,message_id),
 UNIQUE(tenant_id,origin_key),
 UNIQUE(tenant_id,origin_key,actor_id)
);
CREATE TABLE IF NOT EXISTS telegram_channel.payment_consent (
 tenant_id text NOT NULL, operation_id text NOT NULL, actor_id text NOT NULL,
 origin_key text,
 card_reference text NOT NULL, amount_minor bigint NOT NULL CHECK(amount_minor>0),
 currency char(3) NOT NULL, expires_at timestamptz NOT NULL,
 state text NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','AUTHORIZED','CONSUMED')),
 authorized_at timestamptz, consumed_at timestamptz,
 PRIMARY KEY(tenant_id,operation_id),
 UNIQUE(tenant_id,operation_id,actor_id,origin_key),
 FOREIGN KEY(tenant_id,origin_key,actor_id) REFERENCES telegram_channel.message_inbox(tenant_id,origin_key,actor_id)
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
 origin_key text NOT NULL,
 card_reference text NOT NULL,
 amount_minor bigint NOT NULL CHECK(amount_minor > 0),
 currency char(3) NOT NULL,
 status text NOT NULL DEFAULT 'HELD' CHECK (status = 'HELD'),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id, operation_id),
 FOREIGN KEY (tenant_id, operation_id)
 REFERENCES telegram_channel.payment_consent(tenant_id, operation_id),
 FOREIGN KEY(tenant_id, operation_id, actor_id, origin_key) REFERENCES telegram_channel.payment_consent(tenant_id,operation_id,actor_id,origin_key)
);
CREATE OR REPLACE FUNCTION telegram_channel.prevent_origin_rewrite()
RETURNS trigger LANGUAGE plpgsql AS $
BEGIN
 IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR
    NEW.operation_id IS DISTINCT FROM OLD.operation_id OR
    NEW.actor_id IS DISTINCT FROM OLD.actor_id OR
    NEW.origin_key IS DISTINCT FROM OLD.origin_key THEN
   RAISE EXCEPTION 'IMMUTABLE_FINANCIAL_ORIGIN' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $;
DROP TRIGGER IF EXISTS payment_consent_immutable_origin ON telegram_channel.payment_consent;
CREATE TRIGGER payment_consent_immutable_origin BEFORE UPDATE ON telegram_channel.payment_consent
FOR EACH ROW EXECUTE FUNCTION telegram_channel.prevent_origin_rewrite();
DROP TRIGGER IF EXISTS financial_handoff_immutable_origin ON telegram_channel.financial_handoff;
CREATE TRIGGER financial_handoff_immutable_origin BEFORE UPDATE ON telegram_channel.financial_handoff
FOR EACH ROW EXECUTE FUNCTION telegram_channel.prevent_origin_rewrite();
CREATE OR REPLACE FUNCTION telegram_channel.prevent_inbox_origin_rewrite()
RETURNS trigger LANGUAGE plpgsql AS $
BEGIN
 IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.actor_id IS DISTINCT FROM OLD.actor_id OR
    NEW.channel IS DISTINCT FROM OLD.channel OR NEW.message_id IS DISTINCT FROM OLD.message_id OR
    NEW.origin_key IS DISTINCT FROM OLD.origin_key OR NEW.payload_digest IS DISTINCT FROM OLD.payload_digest THEN
    RAISE EXCEPTION 'IMMUTABLE_MESSAGE_ORIGIN' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $;
DROP TRIGGER IF EXISTS message_inbox_immutable_origin ON telegram_channel.message_inbox;
CREATE TRIGGER message_inbox_immutable_origin BEFORE UPDATE ON telegram_channel.message_inbox
FOR EACH ROW EXECUTE FUNCTION telegram_channel.prevent_inbox_origin_rewrite();
COMMIT;
