#!/usr/bin/env node
// Fails if functions/ hardcodes a Gemini model other than GEMINI_MODEL.
// Run: node scripts/gemini-model.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const functionsDir = path.join(root, 'functions');
const EXPECTED_MODEL = 'gemini-3.8-flash';
const HEBREW_TOAST = 'שירות הבינה המלאכותית לא זמין כרגע. נסו שוב מאוחר יותר.';

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log('ok  ' + name);
  } catch (err) {
    failures++;
    console.log('FAIL ' + name);
    console.log('    ' + err.message);
  }
}

const sources = walk(functionsDir).map((file) => ({
  rel: path.relative(functionsDir, file),
  text: fs.readFileSync(file, 'utf8')
}));

function geminiModelConstant() {
  const hits = [];
  const re = /const\s+GEMINI_MODEL\s*=\s*['"]([^'"]+)['"]/g;
  for (const source of sources) {
    for (const match of source.text.matchAll(re)) {
      hits.push({ rel: source.rel, id: match[1] });
    }
  }
  return hits;
}

check('functions/ defines GEMINI_MODEL once', () => {
  const hits = geminiModelConstant();
  assert.strictEqual(hits.length, 1, 'expected exactly one GEMINI_MODEL constant');
  assert.strictEqual(hits[0].rel, 'index.js');
  assert.strictEqual(hits[0].id, EXPECTED_MODEL);
});

check('no model string other than GEMINI_MODEL appears in functions/', () => {
  const hits = geminiModelConstant();
  assert.strictEqual(hits.length, 1);
  const allowed = hits[0].id;
  const defRe = /const\s+GEMINI_MODEL\s*=\s*['"][^'"]+['"]/;
  const idRe = /gemini-[a-z0-9][a-z0-9._-]*/gi;
  const offenders = [];
  let allowedCopies = 0;
  for (const source of sources) {
    const text = source.text.replace(defRe, 'const GEMINI_MODEL = ""');
    for (const match of text.matchAll(idRe)) {
      if (match[0] === allowed) allowedCopies++;
      else offenders.push(source.rel + ': ' + match[0]);
    }
  }
  assert.deepStrictEqual(offenders, []);
  assert.strictEqual(allowedCopies, 0, 'model id is hardcoded outside GEMINI_MODEL');
});

check('all three Gemini calls use the GEMINI_MODEL constant', () => {
  const index = sources.find((source) => source.rel === 'index.js');
  assert.ok(index);
  const calls = [...index.text.matchAll(/getGenerativeModel\(\s*\{\s*model:\s*([^,}\s]+)/g)];
  assert.strictEqual(calls.length, 3, 'expected 3 getGenerativeModel calls');
  for (const call of calls) assert.strictEqual(call[1], 'GEMINI_MODEL');
  assert.deepStrictEqual(index.text.match(/model:\s*['"][^'"]+['"]/g) || [], []);
  for (const name of ['generateDailyAffirmations', 'generatePersonalPlan', 'sendWeeklyCoachInsight']) {
    assert.ok(
      index.text.includes("logGeminiFailure('" + name + "'"),
      'missing Gemini failure log for ' + name
    );
  }
  assert.match(index.text, /throw new HttpsError\('unavailable', 'AI service is temporarily unavailable\.'\)/);
});

check('AI-unavailable maps to the Hebrew toast and other errors stay generic', () => {
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  assert.match(app, /err\?\.code === 'functions\/unavailable'\) showToast\(t\('toastPlanAiUnavailable'\)\)/);
  assert.match(app, /else showToast\(t\('toastPlanError'\)\)/);
  const he = JSON.parse(fs.readFileSync(path.join(root, 'locales', 'he.json'), 'utf8'));
  assert.strictEqual(he.toastPlanAiUnavailable, HEBREW_TOAST);
});

if (failures) {
  console.log(failures + ' failed');
  process.exit(1);
}
console.log('gemini model checks passed');
