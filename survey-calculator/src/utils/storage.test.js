import { describe, it, expect, beforeEach, vi } from 'vitest';
import { safeGetJSON, safeSetJSON, safeGetString, safeSetString, safeRemove } from './storage';

describe('safeGetJSON', () => {
  beforeEach(() => localStorage.clear());

  it('returns fallback when key is absent', () => {
    expect(safeGetJSON('missing', [])).toEqual([]);
  });

  it('parses and returns stored value', () => {
    localStorage.setItem('k', JSON.stringify({ a: 1 }));
    expect(safeGetJSON('k', null)).toEqual({ a: 1 });
  });

  it('returns fallback when stored value is corrupted JSON', () => {
    localStorage.setItem('bad', 'NOT_JSON{{{');
    expect(safeGetJSON('bad', 'DEFAULT')).toBe('DEFAULT');
  });

  it('returns fallback when stored value is null literal', () => {
    localStorage.setItem('nullkey', 'null');
    expect(safeGetJSON('nullkey', 42)).toBe(42);
  });

  it('returns fallback when localStorage throws', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('SecurityError');
    });
    expect(safeGetJSON('k', 'fb')).toBe('fb');
    spy.mockRestore();
  });
});

describe('safeSetJSON', () => {
  beforeEach(() => localStorage.clear());

  it('stores value as JSON', () => {
    safeSetJSON('k', [1, 2, 3]);
    expect(JSON.parse(localStorage.getItem('k'))).toEqual([1, 2, 3]);
  });

  it('does not throw when localStorage throws (quota exceeded)', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError');
    });
    expect(() => safeSetJSON('k', {})).not.toThrow();
    spy.mockRestore();
  });
});

describe('safeGetString', () => {
  beforeEach(() => localStorage.clear());

  it('returns stored string', () => {
    localStorage.setItem('sk', 'hello');
    expect(safeGetString('sk')).toBe('hello');
  });

  it('returns empty string fallback when missing', () => {
    expect(safeGetString('missing')).toBe('');
  });

  it('returns custom fallback when missing', () => {
    expect(safeGetString('missing', 'default')).toBe('default');
  });

  it('returns fallback when localStorage throws', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('SecurityError');
    });
    expect(safeGetString('k', 'fb')).toBe('fb');
    spy.mockRestore();
  });
});

describe('safeSetString', () => {
  beforeEach(() => localStorage.clear());

  it('writes the string value', () => {
    safeSetString('k', 'world');
    expect(localStorage.getItem('k')).toBe('world');
  });

  it('does not throw on storage errors', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError');
    });
    expect(() => safeSetString('k', 'v')).not.toThrow();
    spy.mockRestore();
  });
});

describe('safeRemove', () => {
  beforeEach(() => localStorage.clear());

  it('removes existing key', () => {
    localStorage.setItem('k', 'v');
    safeRemove('k');
    expect(localStorage.getItem('k')).toBeNull();
  });

  it('does not throw when key is absent', () => {
    expect(() => safeRemove('nonexistent')).not.toThrow();
  });

  it('does not throw when localStorage throws', () => {
    const spy = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('SecurityError');
    });
    expect(() => safeRemove('k')).not.toThrow();
    spy.mockRestore();
  });
});
