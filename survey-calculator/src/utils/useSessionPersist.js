/**
 * useSessionPersist
 *
 * Saves and restores a named subset of app state to localStorage so users
 * don't lose their work on accidental page refresh.
 *
 * - Large CAD geometry is intentionally excluded (must re-import files).
 * - Writes are debounced to avoid thrashing localStorage on rapid state changes.
 * - A version key lets old persisted data be silently discarded after breaking changes.
 */
import { useEffect, useRef, useCallback } from 'react';

const SESSION_KEY = 'surveycalc:session:v1';
const DEBOUNCE_MS = 800;

/**
 * Attempts to read and JSON-parse the persisted session from localStorage.
 * Returns null if nothing is stored or the data is malformed.
 */
export function loadPersistedSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Immediately clears the persisted session from localStorage.
 */
export function clearPersistedSession() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    // Ignore storage errors (private/incognito mode, quota exceeded, etc.)
  }
}

/**
 * Hook: automatically persists a snapshot of the provided state object to
 * localStorage, debounced by DEBOUNCE_MS.
 *
 * @param {object} snapshot - Plain object containing the state to persist.
 *   Keys with undefined values are omitted; large arrays (>5 000 items) for
 *   converterPoints are trimmed to the most recent 5 000 to stay within
 *   typical 5 MB localStorage quotas.
 */
export function useSessionPersist(snapshot) {
  const timerRef = useRef(null);

  const persist = useCallback((data) => {
    try {
      // Trim very large point arrays to protect localStorage quota
      const safe = { ...data };
      if (Array.isArray(safe.converterPoints) && safe.converterPoints.length > 5000) {
        safe.converterPoints = safe.converterPoints.slice(-5000);
      }
      if (Array.isArray(safe.measurePoints) && safe.measurePoints.length > 500) {
        safe.measurePoints = safe.measurePoints.slice(-500);
      }
      localStorage.setItem(SESSION_KEY, JSON.stringify(safe));
    } catch {
      // Quota exceeded or storage unavailable — degrade silently
    }
  }, []);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => persist(snapshot), DEBOUNCE_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persist, JSON.stringify(snapshot)]);
}
