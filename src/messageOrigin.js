'use strict';
const crypto = require('node:crypto');
// Stable origin payment message; replies to the PIN challenge are NOT new origins.
function messageOriginKey({tenant,channel,actorId,messageId}) {
  const fields=[tenant,channel,actorId,messageId];
  if(fields.some(x=>typeof x!=='string'||!x||x.trim()!==x)) throw Error('INVALID_ORIGIN');
  const canonical=['MESSAGE-ORIGIN-CHARGE-V1',...fields.map(x=>x.length+':'+x)].join('|');
  return 'msgv1_'+crypto.createHash('sha256').update(canonical).digest('hex');
}
module.exports={messageOriginKey};
