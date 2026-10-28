'use strict';

// F05e-02B: Telegram deep links are DEMO invitations only. A bearer token
// does not confer BusinessOS customer, merchant, tenant or payment authority.
const ACTION='demo-invite-link-v1';
const REDEEM_ACTION='demo-invite-claimed-v1';
const REDEEM_MESSAGE='Invitación de prueba recibida. No se ha realizado, autorizado ni iniciado ningún pago.';
const USERNAME=/^[A-Za-z][A-Za-z0-9_]{4,31}$/;
const TOKEN=/^ki_[A-Za-z0-9_-]{43}$/;
const PREFIX='Invitación de prueba (sin pagos): https://t.me/';
const SUFFIX='\nCaduca en 15 minutos. No autoriza cobros.';

class DemoLinkError extends Error {
  constructor(){super('DEMO_LINK_INVALID');this.name='DemoLinkError';this.code='DEMO_LINK_INVALID';}
}
function usernameValid(username) {
  return typeof username==='string' && USERNAME.test(username) && /bot$/i.test(username);
}
function renderDemoLink(username,token) {
  if(!usernameValid(username) || typeof token!=='string' || !TOKEN.test(token))throw new DemoLinkError();
  return PREFIX+username+'?start='+token+SUFFIX;
}
function tokenFromDemoLink(text,username) {
  if(!usernameValid(username)||typeof text!=='string'||text.length>256)throw new DemoLinkError();
  const expected=PREFIX+username+'?start=';
  if(!text.startsWith(expected)||!text.endsWith(SUFFIX))throw new DemoLinkError();
  const token=text.slice(expected.length,-SUFFIX.length);
  if(!TOKEN.test(token)||renderDemoLink(username,token)!==text)throw new DemoLinkError();
  return token;
}
function startToken(text) {
  if(typeof text!=='string')return null;
  const match=/^\/start (ki_[A-Za-z0-9_-]{43})$/.exec(text);
  return match?match[1]:null;
}
module.exports={ACTION,REDEEM_ACTION,REDEEM_MESSAGE,renderDemoLink,tokenFromDemoLink,startToken,DemoLinkError};
