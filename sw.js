self.addEventListener("push", event => {
  let data = {};

  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = {
      title: "فروشگاه سنگ ورونا",
      body: event.data ? event.data.text() : "اعلان جدید"
    };
  }

  const title = data.title || "📝 فروشگاه سنگ ورونا";

  const options = {
    body: data.body || "یک اعلان جدید برای شما وجود دارد.",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    dir: "rtl",
    lang: "fa",
    vibrate: [300, 150, 300, 150, 500],
    data: {
      url: data.url || "/"
    },
    actions: [
      {
        action: "open",
        title: "مشاهده"
      }
    ]
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

self.addEventListener("notificationclick", event => {
  event.notification.close();

  const targetUrl =
    event.notification?.data?.url || "/";

  event.waitUntil(
    clients.matchAll({
      type: "window",
      includeUncontrolled: true
    }).then(clientList => {
      for (const client of clientList) {
        if ("focus" in client) {
          return client.focus();
        }
      }

      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});

self.addEventListener("install", event => {
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(self.clients.claim());
});
