#!/usr/bin/env node
// Builds the EN/FR/ES reminder pools bundled with Cloud Functions, and
// copies the shared picker into functions/. Hebrew stays in notification-pool.json.
const fs = require('fs');
const path = require('path');
const { buildLocalizedPool } = require('../shared/notification-select');

const root = path.join(__dirname, '..');

function localizedPoolDoc(lang) {
  const affirmations = JSON.parse(fs.readFileSync(path.join(root, 'data', `affirmations-${lang}.json`), 'utf8'));
  const locale = JSON.parse(fs.readFileSync(path.join(root, 'locales', `${lang}.json`), 'utf8'));
  const items = buildLocalizedPool(affirmations.affirmations, locale.journalDesc);
  const hebrew = items.filter((item) => /[\u0590-\u05FF]/.test(item.text));
  if (hebrew.length) throw new Error(lang + ' pool contains Hebrew: ' + hebrew[0].text);
  if (!items.some((item) => item.slot === 'evening' && item.text === locale.journalDesc)) {
    throw new Error(lang + ' pool is missing the evening question');
  }
  return { version: 1, language: lang, items };
}

function writeLocalizedPools() {
  for (const lang of ['en', 'fr', 'es']) {
    const doc = localizedPoolDoc(lang);
    fs.writeFileSync(
      path.join(root, 'functions', `notification-pool-${lang}.json`),
      JSON.stringify(doc, null, 2) + '\n'
    );
    console.log(lang, doc.items.length, 'items');
  }
  fs.copyFileSync(
    path.join(root, 'shared', 'notification-select.js'),
    path.join(root, 'functions', 'notification-select.js')
  );
  console.log('copied notification-select.js');
}

if (require.main === module) writeLocalizedPools();

module.exports = { localizedPoolDoc };
