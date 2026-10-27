const { Markup } = require('telegraf');

const formBase = (process.env.FORM_PUBLIC_URL || 'https://pagos.kashbit.bond').replace(/\/$/, '');

function mainMenu(rid, amountText) {
  return {
    text:
      `<b>Menú principal – Cash With Pay</b>\n` +
      `Operación: <code>${rid}</code>\n` +
      `Importe: <b>${amountText}</b>\n\n` +
      `Elige una opción.`,
    markup: Markup.inlineKeyboard([
      [Markup.button.callback('💳 Pagar con nueva tarjeta', `menu:new:${rid}`)],
      [Markup.button.callback('💾 Guardar tarjeta', `menu:save:${rid}`)],
      [Markup.button.callback('📝 Pagar con tarjeta guardada', `menu:saved:${rid}`)],
      [Markup.button.callback('❌ Rechazar el pago', `menu:reject:${rid}`)],
      [Markup.button.callback('📊 Estado de cuenta', `menu:stmt:${rid}`)],
      [Markup.button.callback('⚙️ Configuración', `menu:cfg:${rid}`)],
    ]),
  };
}

function newCardMenu(rid) {
  const oneTime = `${formBase}/pay/one-time?rid=${encodeURIComponent(rid)}`;
  return {
    text:
      `<b>Tarjeta nueva</b>\n\n` +
      `1. Número de tarjeta\n` +
      `2. Fecha de vencimiento (MM/YY)\n` +
      `3. CVV\n` +
      `4. Nombre del titular\n\n` +
      `Los datos se tokenizan en el formulario seguro.`,
    markup: Markup.inlineKeyboard([
      [Markup.button.webApp('Abrir formulario de pago', oneTime)],
      [Markup.button.callback('Ya terminé – continuar', `menu:done:${rid}`)],
      [Markup.button.callback('← Menú', `menu:main:${rid}`)],
    ]),
  };
}

function saveCardMenu(rid) {
  const enroll = `${formBase}/cards/enroll?rid=${encodeURIComponent(rid)}`;
  return {
    text:
      `<b>Guardar tarjeta</b>\n\n` +
      `Se abrirá un formulario para registrar la tarjeta en Openpay.\n` +
      `Después podrás usarla en pagos futuros.`,
    markup: Markup.inlineKeyboard([
      [Markup.button.webApp('Abrir formulario de enrolamiento', enroll)],
      [Markup.button.callback('← Menú', `menu:main:${rid}`)],
    ]),
  };
}

function savedCardsMenu(rid) {
  const cards = [
    { last4: '4242', brand: 'Visa' },
    { last4: '4444', brand: 'Mastercard' },
  ];
  const buttons = cards.map((c) => [
    Markup.button.callback(`Pagar con ${c.brand} •••• ${c.last4}`, `pay:card:${c.last4}:${rid}`),
  ]);
  buttons.push([Markup.button.callback('← Menú', `menu:main:${rid}`)]);
  return {
    text: `<b>Tarjetas guardadas</b>\nSelecciona una:`,
    markup: Markup.inlineKeyboard(buttons),
  };
}

function configMenu(rid) {
  return {
    text: `<b>Configuración</b>\nNombre, correo y NIP (uno para todas las tarjetas).\nEl NIP no se puede consultar después.`,
    markup: Markup.inlineKeyboard([
      [Markup.button.callback('← Menú', `menu:main:${rid}`)],
    ]),
  };
}

function statementMenu(rid) {
  return {
    text: `<b>Estado de cuenta</b>\nCobros: 0\nPagos: 0\n(simulado)`,
    markup: Markup.inlineKeyboard([
      [Markup.button.callback('← Menú', `menu:main:${rid}`)],
    ]),
  };
}

module.exports = { mainMenu, newCardMenu, saveCardMenu, savedCardsMenu, configMenu, statementMenu };
