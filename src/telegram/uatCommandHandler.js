'use strict';

// F05e pilot: precisely one stateless, informational command is safe to
// project into an outbox intent. Unmigrated Telegram handlers are NOT
// executed by durable-uat mode: they still mutate process-local Maps and
// perform side effects outside an atomic PostgreSQL command transaction.
class UatCommandError extends Error {
  constructor(code) { super(code); this.name='UatCommandError'; this.code=code; }
}

const COMMAND = '/estado_cuenta';
const MESSAGE = 'Estado de cuenta aún no disponible: pendiente de Financial Subledger de BusinessOS. No se ha ejecutado ningún pago.';

function eligibleInformationalUpdate(update) {
  if (!update || !Number.isSafeInteger(update.update_id) ||
      update.update_id < 0 || !update.message ||
      update.message.text !== COMMAND ||
      !update.message.chat || update.message.chat.type !== 'private' ||
      !update.message.from || update.message.from.is_bot !== false ||
      !Number.isSafeInteger(update.message.from.id) ||
      !Number.isSafeInteger(update.message.chat.id) ||
      update.message.from.id <= 0 ||
      update.message.from.id !== update.message.chat.id) {
    throw new UatCommandError('UAT_COMMAND_NOT_MIGRATED');
  }
  return update.message.chat.id;
}

function createUatCommandHandler({outbox}={}) {
  if (!outbox || typeof outbox.enqueueForClaim !== 'function') {
    throw new UatCommandError('UAT_OUTBOX_NOT_CONFIGURED');
  }
  return async (update, claim) => {
    const chatId = eligibleInformationalUpdate(update);
    if (!claim || claim.updateId !== update.update_id ||
        typeof claim.inboxLeaseId !== 'string') {
      throw new UatCommandError('UAT_INBOX_CLAIM_REQUIRED');
    }
    // Enqueue is committed with a verified, unexpired inbox lease.
    // No Telegram send, no financial mutation and no local Map write.
    return outbox.enqueueForClaim({
      updateId:claim.updateId,
      inboxLeaseId:claim.inboxLeaseId,
      actionKey:'statement-unavailable-v1',
      message:{chatId,text:MESSAGE},
    });
  };
}

module.exports={createUatCommandHandler,eligibleInformationalUpdate,UatCommandError};
