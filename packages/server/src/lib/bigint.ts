/**
 * Prisma maps SQLite INTEGER columns wide enough for file sizes to `BigInt`,
 * which `JSON.stringify` refuses to serialise. Every DTO boundary converts
 * through here rather than patching `BigInt.prototype.toJSON` globally.
 */

/** File sizes top out in the terabytes, far below Number.MAX_SAFE_INTEGER. */
export function bigIntToNumber(value: bigint | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return Number(value);
}

export function bigIntToNumberOr(value: bigint | null | undefined, fallback: number): number {
  return bigIntToNumber(value) ?? fallback;
}

export function toBigInt(value: number | null | undefined): bigint | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return BigInt(Math.max(0, Math.round(value)));
}
