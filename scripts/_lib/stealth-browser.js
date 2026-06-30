const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();

// Apply stealth plugin to chromium
chromium.use(stealth);

module.exports = { chromium };