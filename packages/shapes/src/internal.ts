/** Positive modulo, for walking a closed polygon's vertices without going negative. */
export const clampIndexSafe = (i: number, n: number): number => ((i % n) + n) % n;
