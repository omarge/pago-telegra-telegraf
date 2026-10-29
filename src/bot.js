const { Telegraf, Markup } = require('telegraf');
const config = require('./config');
const store = require('./store');
const menus = require('./menus');

if (!config.token) {
  console.error('Set TELEGRAM_BOT_TOKEN');
  process.exit(1);
}

const bot = new Telegraf(config.token, {
  telegram: { agent: null, timeout: 120000 },
});

const lastStart = new Map();
const START_COOLDOWN = 10000;
const amountEntry = new Map();

function nipKeyboard(rid, digits) {
  const masked = digits.replace(/./g, '•');
  const rows = [
    [1, 2, 3],
    [4, 5, 6],
    [7, 8, 9],
    ['C', 0, '←'],
  ].map((row) =>
    row.map((d) => Markup.button.callback(String(d), `nip:${d}:${rid}`))
  );
  rows.push([Markup.button.callback('← Menú', `menu:main:${rid}`)]);
  return {
    text: `<b>NIP de seguridad</b>\n${masked || '(vacío)'}\n\nIntroduce 4 dígitos.`,
    markup: Markup.inlineKeyboard(rows),
  };
}

function amountKeyboard(digits) {
  const display = digits ? (parseInt(digits, 10) / 100).toFixed(2) : '0.00';
  const rows = [
    [1, 2, 3],
    [4, 5, 6],
    [7, 8, 9],
    ['C', 0, '←'],
  ].map((row) =>
    row.map((d) => Markup.button.callback(String(d), `amt:${d}`))
  );
  rows.push([
    Markup.button.callback('✓ Confirmar', 'amt:ok'),
    Markup.button.callback('✗ Cancelar', 'amt:cancel'),
  ]);
  return {
    text: `<b>¿Cuánto quieres cobrar?</b>\n\n$${display} MXN\n\nUsa el teclado. Ejemplo: 1000 = $10.00`,
    markup: Markup.inlineKeyboard(rows),
  };
}

function formatStatement(userId) {
  const stmt = store.getStatement(userId);
  const cards = store.getCards(userId);
  let text = `<b>Estado de cuenta</b>\n\n`;
  text += `Tarjetas guardadas: ${cards.length}\n`;
  text += `Total cobrado: $${(stmt.charged / 100).toFixed(2)} MXN\n`;
  text += `Total pagado: $${(stmt.paid / 100).toFixed(2)} MXN\n`;
  text += `Transacciones: ${stmt.count}\n`;
  if (stmt.recent.length > 0) {
    text += `\n<b>Recientes:</b>\n`;
    for (const tx of stmt.recent) {
      const sign = tx.type === 'charge' ? '+' : '-';
      const date = new Date(tx.date).toLocaleDateString('es-MX');
      text += `${date} ${sign}$${(tx.amount / 100).toFixed(2)} ${tx.desc || ''}\n`;
    }
  }
  return text;
}

async function iniciarHandler(ctx) {
  const userId = ctx.from.id;
  const updateId = ctx.update.update_id;
  const now = Date.now();
  const last = lastStart.get(userId) || 0;
  if (now - last < START_COOLDOWN) {
    console.log('/start ignored (cooldown)', userId, 'update', updateId);
    return;
  }
  lastStart.set(userId, now);

  console.log('/start from', userId, 'update', updateId, 'text:', ctx.message.text);
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
  amountEntry.set(userId, '');
  const k = amountKeyboard('');
  await ctx.reply(k.text, { parse_mode: 'HTML', ...k.markup });
}

bot.start(iniciarHandler);
bot.command('iniciar', iniciarHandler);

bot.action(/amt:(.+)/, async (ctx) => {
  const action = ctx.match[1];
  const userId = ctx.from.id;
  await ctx.answerCbQuery();
  let digits = amountEntry.get(userId) || '';
  if (action === 'cancel') {
    amountEntry.delete(userId);
    await ctx.editMessageText('Cancelado.');
    return;
  }
  if (action === 'ok') {
    if (!digits || parseInt(digits, 10) <= 0) {
      await ctx.answerCbQuery('Ingresa un monto');
      return;
    }
    const amount = parseInt(digits, 10);
    amountEntry.delete(userId);
    const token = store.createInvite(userId, amount);
    const link = `https://t.me/${ctx.botInfo.username}?start=${token}`;
    const display = (amount / 100).toFixed(2);
    console.log('invite created', link, 'amount', amount);
    await ctx.editMessageText(
      `<b>Enlace generado</b>\n\nMonto: $${display} MXN\n\n${link}\n\nEnvíaselo al pagador.`,
      { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.url('Abrir enlace', link)]]) }
    );
    return;
  }
  if (action === 'C') digits = '';
  else if (action === '←') digits = digits.slice(0, -1);
  else if (digits.length < 8) digits += action;
  amountEntry.set(userId, digits);
  const k = amountKeyboard(digits);
  try {
    await ctx.editMessageText(k.text, { parse_mode: 'HTML', ...k.markup });
  } catch (_) {}
});

bot.command('guardar_tarjeta', (ctx) => {
  const formBase = (process.env.FORM_PUBLIC_URL || 'https://pagos.kashbit.bond').replace(/\/$/, '');
  const url = `${formBase}/cards/enroll`;
  ctx.reply('Abre el formulario para guardar una tarjeta:',
    Markup.inlineKeyboard([[Markup.button.webApp('Abrir formulario de enrolamiento', url)]])
  );
});

bot.command('estado_cuenta', (ctx) => {
  const text = formatStatement(ctx.from.id);
  ctx.reply(text, { parse_mode: 'HTML' });
});

bot.command('configuracion', (ctx) => {
  const formBase = (process.env.FORM_PUBLIC_URL || 'https://pagos.kashbit.bond').replace(/\/$/, '');
  const url = `${formBase}/nip/change`;
  ctx.reply(
    `<b>Configuración</b>\n\n` +
    `• Nombre\n` +
    `• Correo electrónico\n` +
    `• NIP de seguridad`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.webApp('Cambiar NIP', url)]]),
    }
  );
});

bot.on('text', async (ctx) => {
  const text = (ctx.message.text || '').trim();
  if (text.startsWith('/')) return;
});

bot.action(/menu:(\w+):(.+)/, async (ctx) => {
  const action = ctx.match[1];
  const rid = ctx.match[2];
  console.log('menu action', action, rid);
  const req = store.getRequest(rid) || { amount: 0 };
  await ctx.answerCbQuery();
  let view;
  if (action === 'new') view = menus.newCardMenu(rid);
  else if (action === 'save') view = menus.saveCardMenu(rid);
  else if (action === 'saved') view = menus.savedCardsMenu(rid, ctx.from.id);
  else if (action === 'stmt') {
    const text = formatStatement(ctx.from.id);
    await ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('← Menú', `menu:main:${rid}`)]]) });
    return;
  }
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
  try {
    await ctx.editMessageText(view.text, { parse_mode: 'HTML', ...view.markup });
  } catch (e) {
    if (!String(e.message).includes('message is not modified')) throw e;
  }
});

bot.action(/pay:card:(\d+):(.+)/, async (ctx) => {
  const last4 = ctx.match[1];
  const rid = ctx.match[2];
  console.log('selected card', last4, rid);
  await ctx.answerCbQuery();
  const req = store.getRequest(rid);
  if (!req) return ctx.reply('Solicitud no encontrada.');
  store.setState(rid, 'NEED_NIP');
  store.setPinEntry(rid, '');
  const k = nipKeyboard(rid, '');
  await ctx.editMessageText(k.text, { parse_mode: 'HTML', ...k.markup });
});

// Legacy PIN callbacks are NOT an authenticated HTTPS PIN form.
bot.action(/nip:(.+):(.+)/, async (ctx) => {
  await ctx.answerCbQuery('Captura segura requerida', { show_alert: true });
  await ctx.editMessageText('El NIP solo se captura en la microaplicación HTTPS autenticada. No se realizó ningún cargo.');
});

// A confirmation click cannot produce a financial receipt.
bot.action(/confirm:yes:(.+)/, async (ctx) => {
  await ctx.answerCbQuery('Confirmación no disponible', { show_alert: true });
  await ctx.editMessageText('Pago pendiente: requiere autorización segura y resultado verificable de BusinessOS. No se realizó ningún cargo.');
});

bot.catch((err, ctx) => {
  console.error('Bot error', err);
});

module.exports = bot;
