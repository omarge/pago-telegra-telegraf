'use strict';

// F05e UAT-only command projection. Financial actions, legacy invites,
// card/PIN operations and simulated PAID states are not permitted here.
class UatCommandError extends Error {
  constructor(code) { super(code); this.name='UatCommandError'; this.code=code; }
}
const COMMAND='/estado_cuenta';
const OUTBOX_ACTION='statement-unavailable-v1';
const MESSAGE='Estado de cuenta aún no disponible: pendiente de Financial Subledger de BusinessOS. No se ha ejecutado ningún pago.';
const DEMO_INVITE_ACTION='demo-invite-registered-v1';
const DEMO_INVITE_MESSAGE='Solicitud de prueba registrada. El enlace para compartir y los cobros aún están deshabilitados. No se ha realizado ningún pago.';

function privateActor(update) {
  if(!update || !Number.isSafeInteger(update.update_id) || update.update_id<0 ||
     !update.message || !update.message.chat || update.message.chat.type!=='private' ||
     !update.message.from || update.message.from.is_bot!==false ||
     !Number.isSafeInteger(update.message.from.id) ||
     !Number.isSafeInteger(update.message.chat.id) ||
     update.message.from.id<=0 || update.message.from.id!==update.message.chat.id) {
    throw new UatCommandError('UAT_COMMAND_NOT_MIGRATED');
  }
  return update.message.chat.id;
}
function eligibleInformationalUpdate(update) {
  const chatId=privateActor(update);
  if(update.message.text!==COMMAND)throw new UatCommandError('UAT_COMMAND_NOT_MIGRATED');
  return chatId;
}
function parseDemoAmount(raw) {
  if(typeof raw!=='string')throw new UatCommandError('UAT_COMMAND_NOT_MIGRATED');
  const m=/^\/solicitar ([1-9][0-9]{0,3})\.([0-9]{2})$/.exec(raw);
  if(!m)throw new UatCommandError('UAT_COMMAND_NOT_MIGRATED');
  const cents=Number(m[1])*100+Number(m[2]);
  if(!Number.isSafeInteger(cents) || cents<=0 || cents>100000) {
    throw new UatCommandError('UAT_DEMO_AMOUNT_INVALID');
  }
  return cents;
}

function createUatCommandHandler({outbox,demoInvites=null}={}) {
  if(!outbox || typeof outbox.enqueueForClaim!=='function') {
    throw new UatCommandError('UAT_OUTBOX_NOT_CONFIGURED');
  }
  return async (update,claim)=>{
    const chatId=privateActor(update);
    if(!claim || claim.updateId!==update.update_id ||
       typeof claim.inboxLeaseId!=='string') {
      throw new UatCommandError('UAT_INBOX_CLAIM_REQUIRED');
    }
    if(update.message.text===COMMAND) {
      return outbox.enqueueForClaim({
        updateId:claim.updateId,inboxLeaseId:claim.inboxLeaseId,
        actionKey:OUTBOX_ACTION,message:{chatId,text:MESSAGE},
      });
    }
    if(typeof update.message.text==='string' &&
       update.message.text.startsWith('/solicitar')) {
      const amountCents=parseDemoAmount(update.message.text);
      if(!demoInvites || typeof demoInvites.createForClaim!=='function') {
        throw new UatCommandError('UAT_DEMO_INVITES_DISABLED');
      }
      // No financial authority, customer mapping, payment intent, link sharing
      // or token emission to Telegram. A repeated inbox event maps to the
      // same immutable invitation and same static outbound intent.
      await demoInvites.createForClaim({
        updateId:claim.updateId,inboxLeaseId:claim.inboxLeaseId,
        requesterTelegramId:chatId,amountCents,
      });
      return outbox.enqueueForClaim({
        updateId:claim.updateId,inboxLeaseId:claim.inboxLeaseId,
        actionKey:DEMO_INVITE_ACTION,
        message:{chatId,text:DEMO_INVITE_MESSAGE},
      });
    }
    throw new UatCommandError('UAT_COMMAND_NOT_MIGRATED');
  };
}
module.exports={
  createUatCommandHandler,eligibleInformationalUpdate,
  UatCommandError,OUTBOX_ACTION,MESSAGE,
  DEMO_INVITE_ACTION,DEMO_INVITE_MESSAGE,parseDemoAmount,
};
