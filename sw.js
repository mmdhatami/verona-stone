const CACHE = "verona-stone-v6";

const FILES = [
  "./",
  "./index.html",
  "./manifest.webmanifest",

  "./images/page-kabinet.jpg.jpg",
  "./images/pelleh.jpg.jpg",
  "./images/travertine.jpg.jpg",
  "./images/marmerit.jpg.jpg",
  "./images/farsh.jpg.jpg",
  "./images/crystal-granite.jpg.jpg",
  "./images/elamanzibasaazi.jpg.jpg"
];

self.addEventListener("install", event => {

  self.skipWaiting();

  event.waitUntil(
    caches.open(CACHE).then(cache => {
      return cache.addAll(FILES);
    })
  );

});


self.addEventListener("activate", event => {

  event.waitUntil(

    caches.keys().then(keys => {

      return Promise.all(

        keys.map(key => {

          if(key !== CACHE){
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

        if(
          response &&
          response.status === 200 &&
          event.request.method === "GET"
        ){

          const copy = response.clone();

          caches.open(CACHE).then(cache => {

            cache.put(event.request,copy);

          });

        }

        return response;

      })

      .catch(() => {

        return caches.match(event.request);

      })

  );

});
