#!/usr/bin/env node
// Rebuild functions/catalog-index.json from data/affirmations*.json.
// Cloud Functions deploy only the functions/ folder, so the allowlist has to
// live there. Run this after editing a catalog file.
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const OUT = path.join(__dirname, '..', 'functions', 'catalog-index.json');
const FILES = [
  'affirmations.json',
  'affirmations-en.json',
  'affirmations-fr.json',
  'affirmations-es.json'
];

function buildCatalogIndex(readFile) {
  const byId = {};
  const texts = {};
  FILES.forEach((file) => {
    const data = JSON.parse(readFile(file));
    (data.affirmations || []).forEach((row) => {
      if (!row || typeof row.text !== 'string' || !row.text) return;
      if (row.id && !byId[row.id]) byId[row.id] = row.text;
      if (!texts[row.text]) texts[row.text] = 1;
      if (typeof row.textF === 'string' && row.textF && !texts[row.textF]) texts[row.textF] = 1;
    });
  });
  return { byId, texts };
}

function readDataFile(file) {
  return fs.readFileSync(path.join(DATA_DIR, file), 'utf8');
}

if (require.main === module) {
  const index = buildCatalogIndex(readDataFile);
  fs.writeFileSync(OUT, JSON.stringify(index));
  console.log(
    'wrote ' + OUT +
    ' ids=' + Object.keys(index.byId).length +
    ' texts=' + Object.keys(index.texts).length
  );
}

module.exports = { buildCatalogIndex, FILES };
