/**
 * Temporary in-memory scratch storage.
 *
 * Deliberately schema-free: a key/value map plus an append-only list per key.
 * It stores whatever the solution puts in it and is lost on process exit, so a
 * restart always returns to the pure seed state.
 */

const state = new Map<string, unknown>();

export const set = (key: string, value: unknown): void => {
  state.set(key, value);
};

export const get = <T = unknown>(key: string): T | undefined => state.get(key) as T | undefined;

export const has = (key: string): boolean => state.has(key);

export const remove = (key: string): boolean => state.delete(key);

export const keys = (): string[] => [...state.keys()];

/** Push onto the list at `key`, creating it if absent. Returns the list. */
export const append = <T>(key: string, value: T): T[] => {
  const list = (state.get(key) as T[] | undefined) ?? [];
  list.push(value);
  state.set(key, list);
  return list;
};

/** Read the list at `key` (empty array if nothing was appended yet). */
export const list = <T>(key: string): T[] => (state.get(key) as T[] | undefined) ?? [];

/** Drop all temporary state. Seed files are untouched. */
export const clear = (): void => {
  state.clear();
};

export const size = (): number => state.size;
