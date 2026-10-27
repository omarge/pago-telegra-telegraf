const { describe, it } = require('node:test');
const assert = require('node:assert');
const menus = require('../src/menus');

describe('menus', () => {
  it('main menu has all options', () => {
    const m = menus.mainMenu('KPR-1', '10.00 MXN');
    assert.ok(m.text.includes('Menú principal'));
    assert.ok(m.markup);
    const buttons = m.markup.reply_markup.inline_keyboard.flat();
    const texts = buttons.map((b) => b.text);
    assert.ok(texts.some((t) => t.includes('nueva tarjeta')));
    assert.ok(texts.some((t) => t.includes('Guardar tarjeta')));
    assert.ok(texts.some((t) => t.includes('guardada')));
  });

  it('new card menu has webapp button', () => {
    const m = menus.newCardMenu('KPR-1');
    const buttons = m.markup.reply_markup.inline_keyboard.flat();
    assert.ok(buttons.some((b) => b.web_app && b.web_app.url.includes('/pay/one-time')));
  });

  it('saved cards menu shows empty when no cards', () => {
    const m = menus.savedCardsMenu('KPR-1', 999999);
    assert.ok(m.text.includes('No tienes tarjetas'));
  });
});
