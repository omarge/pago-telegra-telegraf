'use strict';

// Legacy polling safety gate. The caller advances its Telegram offset only
// AFTER the previous handler completes. This remains at-least-once, not
// exactly-once; financial idempotency requires the independent durable inbox
// and BusinessOS authorization gates before activation.
async function processTelegramUpdatesInOrder(updates, handleUpdate, initialOffset, onProgress) {
  if (!Array.isArray(updates) || typeof handleUpdate !== 'function' ||
      !Number.isSafeInteger(initialOffset) || initialOffset < 0 ||
      typeof onProgress !== 'function') {
    throw new Error('INVALID_TELEGRAM_BATCH');
  }
  let offset=initialOffset;
  for (const update of updates) {
    if (!update || !Number.isSafeInteger(update.update_id) ||
        update.update_id < 0) throw new Error('INVALID_TELEGRAM_UPDATE');
    if (update.update_id < offset) continue;
    await handleUpdate(update);
    offset=update.update_id+1;
    onProgress(offset);
  }
  return offset;
}

module.exports={processTelegramUpdatesInOrder};
