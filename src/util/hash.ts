import { createHash, randomUUID } from 'node:crypto';

export const sha256Hex = (s: string): string =>
  createHash('sha256').update(s, 'utf8').digest('hex');

export const uuid = (): string => randomUUID();

/** Compare a claimed content hash against sha256(payload), tolerant of 0x prefix and case. */
export function contentHashMatches(claimed: string, payload: string): boolean {
  const norm = (h: string) => h.trim().toLowerCase().replace(/^0x/, '');
  if (!claimed) return false;
  return norm(claimed) === sha256Hex(payload);
}

/** Deterministic JSON with sorted object keys — the canonical form we sign. */
export function stableStringify(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'bigint') return v.toString();
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        out[k] = walk((v as Record<string, unknown>)[k]);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(value));
}
