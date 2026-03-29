// Simple event bus for cross-component communication (browser-safe)
const bus = new EventTarget();

export const emit = (name, detail) => {
  try {
    bus.dispatchEvent(new CustomEvent(name, { detail }));
  } catch {
    // Fallback for very old environments
    const evt = document.createEvent('CustomEvent');
    evt.initCustomEvent(name, false, false, detail);
    bus.dispatchEvent(evt);
  }
};

export const on = (name, handler) => {
  const wrapped = (e) => handler(e.detail);
  bus.addEventListener(name, wrapped);
  // return unsubscribe
  return () => bus.removeEventListener(name, wrapped);
};

export default { emit, on };
