
self.addEventListener('install', function() {
  // Dummy service worker that does nothing. This is required to get
  // mobile browsers' "add to home screen" functionality to work, even
  // if we don't use it.
  //
  // In theory we could use this to cache static assets or something.
})
