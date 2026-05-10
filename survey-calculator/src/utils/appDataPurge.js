const APP_STORAGE_PREFIXES = ['surveycalc:', 'survey_calc_'];

const hasWindow = () => typeof window !== 'undefined';
const hasNavigator = () => typeof navigator !== 'undefined';

function removePrefixedStorageEntries(storage, prefixes = APP_STORAGE_PREFIXES) {
  if (!storage) return;

  try {
    const keys = [];
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key) keys.push(key);
    }

    keys
      .filter((key) => prefixes.some((prefix) => key.startsWith(prefix)))
      .forEach((key) => storage.removeItem(key));
  } catch {
    // Ignore storage access errors.
  }
}

export function purgeAppStorage() {
  if (!hasWindow()) return;
  removePrefixedStorageEntries(window.localStorage);
  removePrefixedStorageEntries(window.sessionStorage);
}

export async function purgeAppClientData() {
  if (!hasWindow()) return;

  purgeAppStorage();

  try {
    if (window?.history?.replaceState) {
      const cleanUrl = `${window.location.pathname}${window.location.search}`;
      window.history.replaceState(null, document.title, cleanUrl);
    }
  } catch {
    // Ignore history API errors.
  }

  try {
    if ('caches' in window) {
      const names = await caches.keys();
      await Promise.all(names.map((name) => caches.delete(name)));
    }
  } catch {
    // Ignore cache storage errors.
  }

  try {
    if (hasNavigator() && 'serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((registration) => registration.unregister()));
    }
  } catch {
    // Ignore service worker errors.
  }
}
