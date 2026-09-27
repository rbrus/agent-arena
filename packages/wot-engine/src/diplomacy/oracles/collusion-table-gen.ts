/**
 * Offline generator for the frozen collusion threshold table (docs/design/diplomacy-scenario.md §2.3).
 * Exact rational arithmetic (BigInt), never floating point:
 *
 *   K[P][n] = least k ≥ 3 such that  P(X ≥ k | X ~ Bin(n, p0)) ≤ α / P,
 *
 * with p0 = p0Num / p0Den and α = alphaNum / alphaDen. For k > n the tail is 0, so
 * K[P][n] = 3 when n < 3 and K is non-decreasing in n. The condition is evaluated as
 *   P · alphaDen · Σ_{i≥k} C(n,i) · p0Num^i · (p0Den − p0Num)^(n−i)  ≤  alphaNum · p0Den^n.
 *
 * Used once to produce `collusion-table.ts` and by the test that proves the frozen
 * table equals a fresh computation. Never on the verdict path.
 */

export interface TableParams {
  p0Num: number;
  p0Den: number;
  alphaNum: number;
  alphaDen: number;
  maxN: number;
  maxP: number;
  kMin: number;
}

/** K[P−1][n] for P = 1..maxP, n = 0..maxN. */
export function computeCollusionTable(t: TableParams): number[][] {
  const a = BigInt(t.p0Num);
  const b = BigInt(t.p0Den);
  const q = b - a;
  const out: number[][] = Array.from({ length: t.maxP }, () => new Array<number>(t.maxN + 1).fill(0));
  for (let n = 0; n <= t.maxN; n++) {
    const N = BigInt(n);
    // term_i = C(n,i) a^i q^(n−i), built by recurrence; tail[k] = Σ_{i≥k} term_i.
    const terms: bigint[] = new Array(n + 1);
    let c = 1n;
    const aPow: bigint[] = [1n];
    const qPow: bigint[] = [1n];
    for (let i = 1; i <= n; i++) {
      aPow.push(aPow[i - 1] * a);
      qPow.push(qPow[i - 1] * q);
    }
    for (let i = 0; i <= n; i++) {
      terms[i] = c * aPow[i] * qPow[n - i];
      c = (c * (N - BigInt(i))) / BigInt(i + 1);
    }
    const tail: bigint[] = new Array(n + 2).fill(0n);
    for (let i = n; i >= 0; i--) tail[i] = tail[i + 1] + terms[i];
    const rhs = BigInt(t.alphaNum) * b ** N;
    for (let P = 1; P <= t.maxP; P++) {
      let k = t.kMin;
      while (k <= n && BigInt(P) * BigInt(t.alphaDen) * tail[k] > rhs) k++;
      out[P - 1][n] = k;
    }
  }
  return out;
}

/** Compress a non-decreasing row starting at kMin into the n at which K first reaches kMin+1, kMin+2, … */
export function toBreakpoints(row: readonly number[], kMin: number): number[] {
  const bp: number[] = [];
  for (let n = 0; n < row.length; n++) while (row[n] > kMin + bp.length) bp.push(n);
  return bp;
}

export function fromBreakpoints(bp: readonly number[], kMin: number, n: number): number {
  let k = kMin;
  for (const x of bp) if (n >= x) k++;
  return k;
}
