<!-- Not analytics, but this was an easy place to add some custom JS -->
var fixWidth = function() {
  if (window.location.pathname.indexOf("active-directory") !== -1) {
    document.getElementsByClassName("wy-nav-content")[0].style.maxWidth="10000px";
  }
};
document.addEventListener("DOMContentLoaded", fixWidth);
<!-- end Active Directory page styling -->

<!-- Piwik -->
  var _paq = _paq || [];
  _paq.push(['trackPageView']);
  _paq.push(['enableLinkTracking']);
  (function() {
    _paq.push(['setTrackerUrl',  'https://api.oasis.sandstorm.io']);
    _paq.push(['setSiteId', 1]);
    _paq.push(['setApiToken', '4akAkVvaYMQFctKr1Ckdr_FGs2GhqIj9va1owaT7jhi']);
    var d=document, g=d.createElement('script'), s=d.getElementsByTagName('script')[0];
    g.type='text/javascript'; g.async=true; g.defer=true; g.src='https://ys4rlfzozozaxjxzzvxm.oasis.sandstorm.io/embed.js'; s.parentNode.insertBefore(g,s);
  })();
<!-- End Piwik Code -->
