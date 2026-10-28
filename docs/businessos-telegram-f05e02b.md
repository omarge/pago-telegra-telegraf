# F05e-02B — Telegram demo deep link and one-use redemption

Status: DRAFT / NO_GO. Not deployed. No real Telegram API requests, PSP calls, or BusinessOS master changes.

## Implemented behavior

- An isolated durable-uat test bot may turn a private /solicitar 10.50 update into a deterministic 15-minute invite. It writes an encrypted outbox message with a `https://t.me/<configured-test-bot>?start=ki_<token>` link. This link is a **nonfinancial demo invitation only**.
- A recipient may forward/open that link, producing a private Telegram Bot API `/start ki_...` message. The authenticated transport update supplies `from.id` and private `chat.id`; if they disagree, no redemption occurs. The original requester cannot redeem.
- Redemption uses the existing PostgreSQL immutable one-time claim and live inbox lease. Second payer, unknown token, stale lease and expired token fail closed. A duplicate delivery of the same update returns the same claim and one outbox notice.
- The resulting response only says that a trial invite was received and no payment was started or authorized. There are no customer cards, charges, payment intents, settlement or financial events.
- The deep-link sender validates exact Telegram hostname, separately configured bot username, token syntax, current expiry, original requester chat and that the invite has not been redeemed **before** attempting one external send.
- A sender that lacks the deep-link enable flag rejects both link and redemption notices. Any disallowed or forged outbox action becomes UNKNOWN and is never sent or automatically retried.

## Explicit independent UAT gates (default OFF)

- `TELEGRAM_DELIVERY_MODE=durable-uat`, isolated database, existing UAT acknowledgement and dedicated encrypted inbox key.
- `TELEGRAM_DEMO_INVITES_ENABLED=true` and separately provisioned `TELEGRAM_DEMO_INVITE_KEY_HEX` (not committed).
- `TELEGRAM_OUTBOX_SENDER_ENABLED=true` and `KASHBIT_OUTBOX_UAT_ACK=YES_ISOLATED_UAT_TELEGRAM_SEND`.
- `TELEGRAM_DEMO_LINKS_ENABLED=true`, `KASHBIT_DEMO_LINKS_UAT_ACK=YES_DEMO_LINKS_NO_PAYMENT` and server-pinned `TELEGRAM_UAT_BOT_USERNAME`.
- `NODE_ENV=production` is forbidden for this mode; `KASHBIT_FINANCIAL_GO=true` is also forbidden. No runtime settings or credentials are changed by this PR.

## Evidence and limitations

- tests/telegramDemoDeepLinksPg.test.js performs end-to-end in-process inbox -> immutable invite -> encrypted outbox -> mocked Telegram link delivery -> private `/start` -> single redemption -> mocked acknowledgement, with disposable PostgreSQL 18.
- Also tests tampered URLs, wrong chatbot names, attacker chat substitution, self-redemption, rival payers, expired links and failure/replay after commit but before inbox acknowledgement.
- Telegram Bot API identity and URL ownership cannot be proven merely by unit tests. Explicit dedicated UAT bot provisioning and independent sandbox verification remain outstanding.
- The shareable token is a bearer capability until expiry. Anyone receiving it may claim once; the claim is bound to the Telegram actor **who first redeems**, not to a predetermined customer. It is not permission to pay.
- The sender remains at-most-one automatic attempt, not exactly-once guaranteed delivery. Timeout/UNKNOWN requires operator reconciliation. PostgreSQL records are immutable and require retention/key rotation planning.
- Do not connect this invitation to BusinessOS tenant/customer/Vault/payment authority until independent Security Engine bindings and payment acceptance policies are certified.
- Existing legacy bot mode remains unchanged, including its in-memory interactions. Only explicit isolated UAT can use the new path.

Production GO = NO_GO. No merge to Telegram main or Payment Engine master, no host access, no bank/PSP calls, no modifications to payment crypto or signatures.