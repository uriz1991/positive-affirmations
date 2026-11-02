#!/usr/bin/env node
// Run: node scripts/play-build.test.js
const assert = require('assert');
const { evaluatePlayBuild } = require('../shared/play-build');

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

check('plain website visit is not the Play build', () => {
  const result = evaluatePlayBuild({ stored: '', source: null, play: null, referrer: '' });
  assert.strictEqual(result.active, false);
  assert.strictEqual(result.persist, false);
});

check('source=play is the Play build and is persisted', () => {
  const result = evaluatePlayBuild({ stored: '', source: 'play', play: null, referrer: '' });
  assert.strictEqual(result.active, true);
  assert.strictEqual(result.persist, true);
});

check('play=1 is accepted as well', () => {
  const result = evaluatePlayBuild({ stored: '', source: null, play: '1', referrer: 'https://uriz1991.github.io/' });
  assert.strictEqual(result.active, true);
  assert.strictEqual(result.persist, true);
});

check('a saved session flag stays active without rewriting it', () => {
  const result = evaluatePlayBuild({ stored: '1', source: null, play: null, referrer: '' });
  assert.strictEqual(result.active, true);
  assert.strictEqual(result.persist, false);
});

check('android-app referrer counts only at the start of the string', () => {
  const hit = evaluatePlayBuild({
    stored: '',
    source: null,
    play: null,
    referrer: 'android-app://io.github.uriz1991.positiveaffirmations/'
  });
  assert.strictEqual(hit.active, true);
  assert.strictEqual(hit.persist, true);
  const miss = evaluatePlayBuild({
    stored: '',
    source: null,
    play: null,
    referrer: 'https://example.com/?next=android-app://evil'
  });
  assert.strictEqual(miss.active, false);
  assert.strictEqual(miss.persist, false);
});

check('unrelated query values do not opt the website into Play mode', () => {
  const result = evaluatePlayBuild({ stored: '', source: 'web', play: '0', referrer: '' });
  assert.strictEqual(result.active, false);
});

if (failures) {
  console.log(failures + ' failed');
  process.exit(1);
}
console.log('play-build checks passed');
