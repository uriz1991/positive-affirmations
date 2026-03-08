// Set language direction before page renders to prevent RTL→LTR flash
(function () {
  var lang = localStorage.getItem('app-language') || 'he';
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'he' ? 'rtl' : 'ltr';
})();
