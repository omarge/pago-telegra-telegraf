'use strict';

// F05e UAT-only, no automatic retry for any ambiguous Telegram send.
// The unique send claim is durably IN_FLIGHT before entering sendMessage().
class OutboxDispatchError extends Error {
  constructor(code) { super(code); this.name='OutboxDispatchError'; this.code=code; }
}
class TelegramOutboxDispatcher {
  constructor({outbox,sendMessage}={}) {
    if (!outbox || typeof outbox.claimForSend !== 'function' ||
        typeof outbox.markSent !== 'function' ||
        typeof outbox.finishUnknown !== 'function' ||
        typeof sendMessage !== 'function') {
      throw new OutboxDispatchError('OUTBOX_DISPATCH_NOT_CONFIGURED');
    }
    this.outbox=outbox;
    this.sendMessage=sendMessage;
  }

  async dispatchOnce() {
    let claimed;
    try { claimed=await this.outbox.claimForSend(); }
    catch (_) { throw new OutboxDispatchError('OUTBOX_CLAIM_FAILED'); }
    if (!claimed) return false;
    // No second attempt regardless of remote result, timeout or DB failure.
    let response;
    try {
      response=await this.sendMessage(claimed.message.chatId,claimed.message.text);
    } catch (_) {
      try {
        const sealed=await this.outbox.finishUnknown(
          claimed.updateId,claimed.actionKey,claimed.dispatchId);
        if (!sealed) throw Error('stale dispatch authority');
      } catch (_) {
        // Remains IN_FLIGHT; do not issue another send.
        throw new OutboxDispatchError('OUTBOX_REMOTE_UNKNOWN_UNRECORDED');
      }
      throw new OutboxDispatchError('OUTBOX_REMOTE_UNKNOWN');
    }
    try {
      // Invalid/mismatched response also remains ambiguous, never success.
      await this.outbox.markSent(claimed,response);
    } catch (_) {
      try {
        await this.outbox.finishUnknown(
          claimed.updateId,claimed.actionKey,claimed.dispatchId);
      } catch (_) {
        // Crash may leave IN_FLIGHT, which is never automatically retried.
      }
      throw new OutboxDispatchError('OUTBOX_CONFIRMATION_UNKNOWN');
    }
    return true;
  }
}

async function runOutboxDispatcher({outbox,sendMessage,signal}={}) {
  const dispatcher=new TelegramOutboxDispatcher({outbox,sendMessage});
  while(!signal?.aborted) {
    const delivered=await dispatcher.dispatchOnce();
    if (!delivered) {
      await new Promise(resolve=>{
        const timer=setTimeout(done,250);
        function done() {clearTimeout(timer);signal?.removeEventListener('abort',done);resolve();}
        signal?.addEventListener('abort',done,{once:true});
      });
    }
  }
}

module.exports={TelegramOutboxDispatcher,OutboxDispatchError,runOutboxDispatcher};
