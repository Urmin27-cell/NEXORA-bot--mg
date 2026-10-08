/* Service worker pour les notifications push (NEXORA) */
importScripts("https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js");

const config = Object.fromEntries(new URL(self.location).searchParams);
firebase.initializeApp(config);
const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const title = (payload.notification && payload.notification.title) || "NEXORA";
  const body = (payload.notification && payload.notification.body) || "";
  const link = (payload.data && payload.data.link) || "/";
  self.registration.showNotification(title, {
    body,
    icon: "/notification-logo.png",
    badge: "/notification-logo.png",
    tag: "nexora",
    data: { link },
  });
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const link = (event.notification.data && event.notification.data.link) || "/";
  event.waitUntil(clients.openWindow(link));
});
