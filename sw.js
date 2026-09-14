const CACHE = "verona-stone-v5";

self.addEventListener("install", event => {
  self.skipWaiting();

  event.waitUntil(
    caches.open(CACHE).then(cache => {
      return cache.addAll([
        "./",
        "./index.html",
        "./manifest.webmanifest",

        "./images/page-kabinet.jpg",
        "./images/pelleh.jpg",
        "./images/travertine.jpg",
        "./images/marmerit.jpg",
        "./images/farsh.jpg",
        "./images/crystal-granite.jpg",
        "./images/elamanzibasaazi.jpg"
      ]);
    })
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.map(key => {
          if (key !== CACHE) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => {
      return self.clients.claim();
    })
  );
});

self.addEventListener("fetch", event => {

  event.respondWith(

    fetch(event.request)
      .then(response => {

        if (response && response.status === 200) {

          const copy = response.clone();

          caches.open(CACHE).then(cache => {
            cache.put(event.request, copy);
          });

        }

        return response;

      })
      .catch(() => {

        return caches.match(event.request);

      })

  );

});
