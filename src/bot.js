const { Telegraf, Markup } = require('telegraf');
const config = require('./config');
const store = require('./store');
const menus = require('./menus');

if (!config.token) {
  console.error('Set TELEGRAM_BOT_TOKEN');
  process.exit(1);
}

const bot = new Telegraf(config.token);

bot.start(async (ctx) => {
  console.log('/start from', ctx.from.id, ctx.message.text);
  const text = ctx.message.text || '';
  const parts = text.split(' ');
  if (parts.length > 1) {
    const token = parts[1];
    const inv = store.consumeInvite(token);
    if (!inv) {
      console.log('invalid invite', token);
      return ctx.reply('Enlace inválido o expirado.');
    }
    const req = store.createRequest(inv.requesterId, ctx.from.id, inv.amount);
    console.log('request created', req.id, 'amount', inv.amount);
    const amountText = (inv.amount / 100).toFixed(2) + ' MXN';
    const m = menus.mainMenu(req.id, amountText);
    await ctx.reply(m.text, { parse_mode: 'HTML', ...m.markup });
    try {
      await ctx.telegram.sendMessage(
        inv.requesterId,
        `El pagador abrió el enlace.\nSolicitud: <code>${req.id}</code>`,
        { parse_mode: 'HTML' }
      );
    } catch (_) {}
    return;
  }
  store.conv.set(ctx.chat.id, { step: 'amount' });
  console.log('asking amount to', ctx.from.id);
  await ctx.reply(
    '¿Cuánto quieres cobrar?\nEnvía el monto en centavos (1000 = $10.00 MXN)'
  );
});

bot.on('text', async (ctx) => {
  const text = (ctx.message.text || '').trim();
  if (text.startsWith('/')) return;
  const state = store.conv.get(ctx.chat.id);
  if (!state || state.step !== 'amount') return;
  console.log('amount text', text, 'from', ctx.from.id);
  const amount = parseInt(text, 10);
  if (!amount || amount <= 0) {
    return ctx.reply('Monto inválido. Envía un número (1000 = $10.00).');
  }
  const token = store.createInvite(ctx.from.id, amount);
  store.conv.delete(ctx.chat.id);
  const link = `https://t.me/${ctx.botInfo.username}?start=${token}`;
  console.log('invite created', link);
  await ctx.reply(
    `Enlace generado.\nEnvíaselo al pagador:\n\n${link}\n\nEl pagador debe abrirlo y tocar Start.`,
    Markup.inlineKeyboard([[Markup.button.url('Abrir enlace para el pagador', link)]])
  );
});

bot.action(/menu:(\w+):(.+)/, async (ctx) => {
  const action = ctx.match[1];
  const rid = ctx.match[2];
  console.log('menu action', action, rid);
  const req = store.getRequest(rid) || { amount: 0 };
  await ctx.answerCbQuery();
  let view;
  if (action === 'new') view = menus.newCardMenu(rid);
  else if (action === 'saved') view = menus.savedCardsMenu(rid);
  else if (action === 'stmt') view = menus.statementMenu(rid);
  else if (action === 'cfg') view = menus.configMenu(rid);
  else if (action === 'reject') {
    store.setState(rid, 'DECLINED');
    await ctx.editMessageText('Pago rechazado.', { parse_mode: 'HTML' });
    try {
      await ctx.telegram.sendMessage(
        req.requesterId,
        `Pago rechazado.\n<code>${rid}</code>`,
        { parse_mode: 'HTML' }
      );
    } catch (_) {}
    return;
  } else if (action === 'done') {
    await ctx.editMessageText(
      '<b>Tarjeta capturada</b>\nListo para confirmar.',
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('✅ Confirmar pago', `confirm:yes:${rid}`)],
          [Markup.button.callback('← Menú', `menu:main:${rid}`)],
        ]),
      }
    );
    return;
  } else {
    const amountText = ((req.amount || 0) / 100).toFixed(2) + ' MXN';
    view = menus.mainMenu(rid, amountText);
  }
  await ctx.editMessageText(view.text, { parse_mode: 'HTML', ...view.markup });
});

bot.action(/pay:card:(\d+):(.+)/, async (ctx) => {
  const last4 = ctx.match[1];
  const rid = ctx.match[2];
  console.log('selected card', last4, rid);
  await ctx.answerCbQuery();
  const req = store.getRequest(rid);
  if (!req) return ctx.reply('Solicitud no encontrada.');
  store.setState(rid, 'CARD_SELECTED');
  await ctx.editMessageText(
    `<b>Tarjeta •••• ${last4} seleccionada</b>\n\n` +
    `Introduce tu NIP de seguridad (4 dígitos) para confirmar el cargo.`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✅ Confirmar pago', `confirm:yes:${rid}`)],
        [Markup.button.callback('← Menú', `menu:main:${rid}`)],
      ]),
    }
  );
});

bot.action(/confirm:yes:(.+)/, async (ctx) => {
  const rid = ctx.match[1];
  console.log('confirm', rid);
  await ctx.answerCbQuery();
  const req = store.getRequest(rid);
  store.setState(rid, 'PAID');
  const amountText = req ? (req.amount / 100).toFixed(2) + ' MXN' : '';
  const msg =
    `✅ <b>Pago completado</b>\n` +
    `Solicitud: <code>${rid}</code>\n` +
    (amountText ? `Importe: ${amountText}\n` : '') +
    `Rastreo: <code>SIM-${Date.now()}</code>`;
  await ctx.editMessageText(msg, { parse_mode: 'HTML' });
  if (req && req.requesterId) {
    try {
      await ctx.telegram.sendMessage(req.requesterId, msg, { parse_mode: 'HTML' });
    } catch (_) {}
  }
});

bot.catch((err, ctx) => {
  console.error('Bot error', err);
});

module.exports = bot;
