-- F05 / KashBitPay Telegram: standalone request authority.
-- Apply only in an isolated UAT/test database after an authorized migration review.
-- This schema does NOT modify or touch BusinessOS Payment Engine tables.
CREATE TABLE IF NOT EXISTS kashbit_telegram_payment_requests (
    request_id varchar(128) PRIMARY KEY,
    tenant_id varchar(128) NOT NULL,
    merchant_id varchar(128) NOT NULL,
    payer_actor_id varchar(128) NOT NULL,
    amount_cents bigint NOT NULL
        CHECK (amount_cents > 0 AND amount_cents <= 9007199254740991),
    currency char(3) NOT NULL CHECK (currency = 'MXN'),
    occurred_at timestamptz NOT NULL,
    risk_idempotency_key varchar(128) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT kashbit_tg_request_risk_once
        UNIQUE (tenant_id, risk_idempotency_key),
    CONSTRAINT kashbit_tg_request_id_nonempty CHECK (length(btrim(request_id)) > 0),
    CONSTRAINT kashbit_tg_request_tenant_nonempty CHECK (length(btrim(tenant_id)) > 0),
    CONSTRAINT kashbit_tg_request_merchant_nonempty CHECK (length(btrim(merchant_id)) > 0),
    CONSTRAINT kashbit_tg_request_payer_nonempty CHECK (length(btrim(payer_actor_id)) > 0),
    CONSTRAINT kashbit_tg_request_risk_nonempty CHECK (length(btrim(risk_idempotency_key)) > 0)
);

-- An immutable economic request MUST NOT be repurposed after a charge attempt.
-- Any lifecycle/status belongs in a separate authoritative, versioned projection.
CREATE OR REPLACE FUNCTION kashbit_tg_reject_request_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'kashbit_payment_request_immutable'
        USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER IF EXISTS kashbit_tg_payment_requests_immutable
    ON kashbit_telegram_payment_requests;
CREATE TRIGGER kashbit_tg_payment_requests_immutable
BEFORE UPDATE OR DELETE ON kashbit_telegram_payment_requests
FOR EACH ROW EXECUTE FUNCTION kashbit_tg_reject_request_mutation();

COMMENT ON TABLE kashbit_telegram_payment_requests IS
    'KashBitPay Telegram immutable request identity, NOT a payment ledger or authorization';
