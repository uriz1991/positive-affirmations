// Detects the Google Play / Trusted Web Activity build.
// The website stays unchanged unless the TWA opened it with ?source=play
// (or ?play=1) or Chrome set a referrer for THIS app's package
// (android-app://io.github.uriz1991.positiveaffirmations). A link opened from
// WhatsApp, Gmail, or Facebook also uses android-app:// and must not hide
// upgrades. The flag is stored for the browser session so later navigations
// that drop the query still hide off-Play billing.
// Keep PLAY_PACKAGE identical to TWA_APPLICATION_ID in android/gradle.properties.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.PlayBuild = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var PLAY_PACKAGE = 'io.github.uriz1991.positiveaffirmations';

  function referrerPackageName(referrer) {
    var prefix = 'android-app://';
    if (!referrer || referrer.indexOf(prefix) !== 0) return '';
    var rest = referrer.slice(prefix.length);
    var cut = rest.search(/[\/?#]/);
    return cut === -1 ? rest : rest.slice(0, cut);
  }

  function evaluatePlayBuild(input) {
    var packageName = (input && input.packageName) || PLAY_PACKAGE;
    var source = input && input.source;
    var play = input && input.play;
    var fromQuery = source === 'play' || play === '1';
    var fromReferrer = referrerPackageName(input && input.referrer) === packageName;
    var stored = !!(input && input.stored === packageName);
    return {
      active: stored || fromQuery || fromReferrer,
      persist: fromQuery || fromReferrer,
      packageName: packageName
    };
  }

  return {
    packageName: PLAY_PACKAGE,
    referrerPackageName: referrerPackageName,
    evaluatePlayBuild: evaluatePlayBuild
  };
});
