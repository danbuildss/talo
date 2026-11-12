export const newId = () => crypto.randomUUID();
export const nowIso = (now: Date = new Date()) => now.toISOString();

/** Parse JSON stored by this app. Throws if the database holds something unexpected. */
export function fromJson<T>(value: string | null): T | null {
  return value === null ? null : (JSON.parse(value) as T);
}

export class NotFoundError extends Error {}
export class ConflictError extends Error {}
