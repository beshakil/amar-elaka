'use client';

import { forgetWebPushToken, registerWebPushToken } from './actions';

/**
 * Web Push opt-in (ADR 060), through FCM like the app: the browser's push
 * subscription is made with our own service worker (/push-sw.js) and turned
 * into an FCM token, which the API stores as a `web` device. Firebase's
 * options are public by design and come from NEXT_PUBLIC_FIREBASE_*; without
 * them the site simply offers no push. Never asked on first visit — only
 * from the opt-in card, after the user did something push helps with.
 */

const config = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY ?? '',
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? '',
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID ?? '',
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID ?? '',
};
const vapidKey = process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY ?? '';

const SW_PATH = '/push-sw.js';
const TOKEN_KEY = 'ae.push.token';
const DISMISSED_KEY = 'ae.push.dismissedAt';

export type WebPushState = 'unavailable' | 'unsupported' | 'denied' | 'enabled' | 'off';

export function isWebPushConfigured(): boolean {
  return Boolean(
    config.apiKey && config.projectId && config.messagingSenderId && config.appId && vapidKey,
  );
}

function browserSupportsPush(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

export function webPushState(): WebPushState {
  if (!isWebPushConfigured()) return 'unavailable';
  if (!browserSupportsPush()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  return Notification.permission === 'granted' && storedToken() ? 'enabled' : 'off';
}

function storedToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

/** "এখন না": the card stays away for a while (the quiet period is the app's, 14 days). */
export function dismissWebPushOffer(): void {
  try {
    localStorage.setItem(DISMISSED_KEY, String(Date.now()));
  } catch {
    // Private mode: it just shows again next time.
  }
}

// Presentation, as in the app's PushRationaleGate: how long "not now" holds.
const QUIET_PERIOD_MS = 14 * 24 * 60 * 60 * 1000;

export function shouldOfferWebPush(): boolean {
  if (webPushState() !== 'off' || Notification.permission !== 'default') return false;
  try {
    const at = Number(localStorage.getItem(DISMISSED_KEY) ?? '0');
    return !at || Date.now() - at >= QUIET_PERIOD_MS;
  } catch {
    return true;
  }
}

async function messagingToken(): Promise<string> {
  const [{ initializeApp, getApps }, { getMessaging, getToken, isSupported }] = await Promise.all([
    import('firebase/app'),
    import('firebase/messaging'),
  ]);
  if (!(await isSupported())) throw new Error('unsupported');
  const app = getApps()[0] ?? initializeApp(config);
  const registration = await navigator.serviceWorker.register(SW_PATH, { scope: '/' });
  await navigator.serviceWorker.ready;
  return getToken(getMessaging(app), { vapidKey, serviceWorkerRegistration: registration });
}

/** The user said yes: the browser's own prompt, then the token to the API. */
export async function enableWebPush(): Promise<WebPushState> {
  if (webPushState() === 'unavailable' || webPushState() === 'unsupported') return webPushState();
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'off';
  const token = await messagingToken();
  const saved = await registerWebPushToken(token);
  if (!saved.ok) throw new Error(saved.code);
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Still registered; this browser just won't remember it is.
  }
  return 'enabled';
}

/** Re-register a granted browser's token (FCM rotates them), quietly. */
export async function refreshWebPush(): Promise<void> {
  if (webPushState() !== 'enabled') return;
  try {
    const token = await messagingToken();
    if (token !== storedToken()) {
      const saved = await registerWebPushToken(token);
      if (saved.ok) localStorage.setItem(TOKEN_KEY, token);
    }
  } catch {
    // Next visit tries again.
  }
}

export async function disableWebPush(): Promise<void> {
  const token = storedToken();
  if (token) await forgetWebPushToken(token);
  try {
    localStorage.removeItem(TOKEN_KEY);
    const registration = await navigator.serviceWorker.getRegistration(SW_PATH);
    const subscription = await registration?.pushManager.getSubscription();
    await subscription?.unsubscribe();
  } catch {
    // The API no longer sends to it either way.
  }
}
