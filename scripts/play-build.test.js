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

check('a saved session flag stays active only for our package name', () => {
  const { packageName } = require('../shared/play-build');
  const kept = evaluatePlayBuild({ stored: packageName, source: null, play: null, referrer: '' });
  assert.strictEqual(kept.active, true);
  assert.strictEqual(kept.persist, false);
  const stale = evaluatePlayBuild({ stored: '1', source: null, play: null, referrer: '' });
  assert.strictEqual(stale.active, false);
  assert.strictEqual(stale.persist, false);
});

check('only our package referrer turns Play mode on', () => {
  const { packageName } = require('../shared/play-build');
  ['', '/', '/https/uriz1991.github.io', '?source=play'].forEach((suffix) => {
    const hit = evaluatePlayBuild({
      stored: '',
      source: null,
      play: null,
      referrer: 'android-app://' + packageName + suffix
    });
    assert.strictEqual(hit.active, true, suffix);
    assert.strictEqual(hit.persist, true);
  });
  [
    'android-app://com.whatsapp/',
    'android-app://com.google.android.gm',
    'android-app://com.facebook.katana/',
    'android-app://' + packageName + '.evil/',
    'https://example.com/?next=android-app://' + packageName
  ].forEach((referrer) => {
    const miss = evaluatePlayBuild({ stored: '', source: null, play: null, referrer });
    assert.strictEqual(miss.active, false, referrer);
    assert.strictEqual(miss.persist, false, referrer);
  });
});

check('unrelated query values do not opt the website into Play mode', () => {
  const result = evaluatePlayBuild({ stored: '', source: 'web', play: '0', referrer: '' });
  assert.strictEqual(result.active, false);
});

check('Play package name matches the Android application id', () => {
  const fs = require('fs');
  const path = require('path');
  const { packageName } = require('../shared/play-build');
  const props = fs.readFileSync(path.join(__dirname, '../android/gradle.properties'), 'utf8');
  const match = props.match(/^TWA_APPLICATION_ID=(.+)$/m);
  assert.ok(match, 'TWA_APPLICATION_ID missing');
  assert.strictEqual(packageName, match[1].trim());
  const assetlinks = JSON.parse(fs.readFileSync(path.join(__dirname, '../android/assetlinks.template.json'), 'utf8'));
  assert.strictEqual(assetlinks[0].target.package_name, packageName);
});

if (failures) {
  console.log(failures + ' failed');
  process.exit(1);
}
console.log('play-build checks passed');
