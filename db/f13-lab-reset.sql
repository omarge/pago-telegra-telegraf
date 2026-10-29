-- F13: DESTRUCTIVE LAB-ONLY reset. Do not execute against production.
-- Recreate only the isolated telegram_channel schema, never other schemas.
BEGIN;
DROP SCHEMA IF EXISTS telegram_channel CASCADE;
COMMIT;
\i db/telegram-security.sql
