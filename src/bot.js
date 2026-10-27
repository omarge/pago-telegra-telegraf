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
  const text = ctx.message.text || '';
  const parts = text.split(' ');
  if (parts.length > 1) {
    const token = parts[1];
    const inv = store.consumeInvite(token);
    if (!inv) {
      return ctx.reply('Enlace inválido o expirado.');
    }
    const req = store.createRequest(inv.requesterId, ctx.from.id, inv.amount);
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
  await ctx.reply(
    '¿Cuánto quieres cobrar?\nEnvía el monto en centavos (1000 = $10.00 MXN)'
  );
});

bot.on('text', async (ctx) => {
  const text = (ctx.message.text || '').trim();
  if (text.startsWith('/')) return;
  const state = store.conv.get(ctx.chat.id);
  if (!state || state.step !== 'amount') return;
  const amount = parseInt(text, 10);
  if (!amount || amount <= 0) {
    return ctx.reply('Monto inválido. Envía un número (1000 = $10.00).');
  }
  const token = store.createInvite(ctx.from.id, amount);
  store.conv.delete(ctx.chat.id);
  const link = `https://t.me/${ctx.botInfo.username}?start=${token}`;
  await ctx.reply(
    `Enlace generado.\nEnvíaselo al pagador:\n\n${link}\n\nEl pagador debe abrirlo y tocar Start.`,
    Markup.inlineKeyboard([[Markup.button.url('Abrir enlace para el pagador', link)]])
  );
});

bot.action(/menu:(\w+):(.+)/, async (ctx) => {
  const action = ctx.match[1];
  const rid = ctx.match[2];
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

bot.action(/confirm:yes:(.+)/, async (ctx) => {
  const rid = ctx.match[1];
  await ctx.answerCbQuery();
  store.setState(rid, 'PROCESSING');
  await ctx.editMessageText('Procesando pago... (simulado)', { parse_mode: 'HTML' });
});

bot.catch((err, ctx) => {
  console.error('Bot error', err);
});

module.exports = bot;
