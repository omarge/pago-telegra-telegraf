require('dotenv').config();

module.exports = {
  token: process.env.TELEGRAM_BOT_TOKEN,
  publicBase: (process.env.PUBLIC_BASE_URL || 'https://pagos.kashbit.bond').replace(/\/$/, ''),
  pinPepper: process.env.KASHBIT_PIN_PEPPER || 'dev-pepper-32-chars-minimum-here',
};
