// Detects the Google Play / Trusted Web Activity build.
// The website stays unchanged unless the TWA opened it with ?source=play
// (or ?play=1) or Chrome set an android-app:// referrer. The flag is stored
// for the browser session so later navigations that drop the query still hide
// off-Play billing.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.PlayBuild = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function evaluatePlayBuild(input) {
    var stored = input && input.stored === '1';
    var source = input && input.source;
    var play = input && input.play;
    var referrer = (input && input.referrer) || '';
    var fromQuery = source === 'play' || play === '1';
    var fromReferrer = referrer.indexOf('android-app://') === 0;
    return {
      active: stored || fromQuery || fromReferrer,
      persist: fromQuery || fromReferrer
    };
  }

  return { evaluatePlayBuild: evaluatePlayBuild };
});
