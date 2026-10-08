import { initializeApp, getApp, getApps } from "firebase/app";
import { getMessaging, getToken, isSupported, onMessage } from "firebase/messaging";

const appId = import.meta.env["VITE_LOVABLE_CONNECTOR_FIREBASE_MESSAGING_APP_ID"] as
  string | undefined;
const vapidKey = import.meta.env["VITE_LOVABLE_CONNECTOR_FIREBASE_MESSAGING_VAPID_KEY"] as
  string | undefined;

const firebaseConfig = {
  apiKey: import.meta.env["VITE_LOVABLE_CONNECTOR_FIREBASE_MESSAGING_WEB_API_KEY"] as
    string | undefined,
  projectId: import.meta.env["VITE_LOVABLE_CONNECTOR_FIREBASE_MESSAGING_PROJECT_ID"] as
    string | undefined,
  appId,
  messagingSenderId: appId?.split(":")[1] ?? "",
};

export type PushResult =
  | { status: "registered"; token: string }
  | { status: "not-configured" | "unsupported" | "open-in-new-tab" | "denied" };

const PUSH_APP_NAME = "nexora-push";

/** À appeler depuis un clic utilisateur (les navigateurs exigent un geste). */
export async function enablePush(): Promise<PushResult> {
  if (
    !firebaseConfig.apiKey ||
    !firebaseConfig.projectId ||
    !appId ||
    !vapidKey ||
    !firebaseConfig.messagingSenderId
  ) {
    return { status: "not-configured" };
  }
  if (typeof window === "undefined" || !("Notification" in window) || !(await isSupported())) {
    return { status: "unsupported" };
  }
  if (window.top !== window.self) {
    return { status: "open-in-new-tab" };
  }

  const permission =
    Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  if (permission !== "granted") return { status: "denied" };

  const query = new URLSearchParams(firebaseConfig as Record<string, string>).toString();
  const registration = await navigator.serviceWorker.register(`/firebase-messaging-sw.js?${query}`);

  const app =
    getApps().find((a) => a.name === PUSH_APP_NAME) ??
    initializeApp(firebaseConfig as Record<string, string>, PUSH_APP_NAME);
  const messaging = getMessaging(app);
  const token = await getToken(messaging, { vapidKey, serviceWorkerRegistration: registration });
  return token ? { status: "registered", token } : { status: "denied" };
}

/** Affiche les notifications reçues quand l'onglet est ouvert. */
export async function listenForegroundPush(): Promise<void> {
  if (typeof window === "undefined" || !(await isSupported())) return;
  const app = getApps().find((a) => a.name === PUSH_APP_NAME) ?? getApp();
  onMessage(getMessaging(app), (payload) => {
    const title = payload.notification?.title ?? "NEXORA";
    const body = payload.notification?.body ?? "";
    if (Notification.permission === "granted") {
      new Notification(title, { body, icon: "/notification-logo.png" });
    }
  });
}

export type ForegroundPush = { title: string; body: string; link?: string };

/** Écoute les notifications reçues app ouverte, sans créer de doublon système. */
export async function subscribeForegroundPush(
  cb: (n: ForegroundPush) => void,
): Promise<() => void> {
  if (typeof window === "undefined" || !(await isSupported())) return () => {};
  if (!firebaseConfig.apiKey || !firebaseConfig.projectId || !appId) return () => {};
  const app =
    getApps().find((a) => a.name === PUSH_APP_NAME) ??
    initializeApp(firebaseConfig as Record<string, string>, PUSH_APP_NAME);
  return onMessage(getMessaging(app), (payload) => {
    cb({
      title: payload.notification?.title ?? "NEXORA",
      body: payload.notification?.body ?? "",
      link: (payload.data as Record<string, string> | undefined)?.["link"],
    });
  });
}

/** Statut actuel côté navigateur, sans demander d'autorisation. */
export function pushPermissionStatus(): "granted" | "denied" | "default" | "unavailable" {
  if (typeof window === "undefined" || !("Notification" in window)) return "unavailable";
  return Notification.permission;
}
