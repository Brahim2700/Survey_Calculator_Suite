/**
 * Safe wrappers around localStorage that guard against:
 * - Corrupted / unparseable stored JSON
 * - Private-browsing quota errors
 * - SecurityError in sandboxed iframes
 */

/**
 * Read and JSON-parse a localStorage key.
 * Returns `fallback` on any error.
 * @template T
 * @param {string} key
 * @param {T} fallback
 * @returns {T}
 */
export function safeGetJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * JSON-stringify and write a value to localStorage.
 * Silently swallows quota-exceeded and security errors.
 * @param {string} key
 * @param {unknown} value
 */
export function safeSetJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Quota exceeded, private mode, or sandboxed iframe — non-fatal.
  }
}

/**
 * Read a raw string from localStorage.
 * Returns `fallback` if the key is missing or on any error.
 * @param {string} key
 * @param {string} fallback
 * @returns {string}
 */
export function safeGetString(key, fallback = '') {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * Write a raw string to localStorage.
 * Silently swallows quota-exceeded and security errors.
 * @param {string} key
 * @param {string} value
 */
export function safeSetString(key, value) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // Non-fatal.
  }
}

/**
 * Remove a key from localStorage.
 * Silently swallows any errors.
 * @param {string} key
 */
export function safeRemove(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    // Non-fatal.
  }
}
