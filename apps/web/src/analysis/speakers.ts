// SPDX-License-Identifier: AGPL-3.0-only
import { cosine } from './audio';

/**
 * T19 round S: offline average-linkage clustering on cosine distance. Clusters merge while their mean
 * pairwise distance is at most `distance` (ties: lowest indices); labels are numbered by first appearance.
 */
export function averageLinkage(vectors: number[][], distance: number) {
  const n = vectors.length, d = vectors.map(a => vectors.map(b => 1 - cosine(a, b))), members = vectors.map((_, i) => [i]), alive = vectors.map(() => true);
  for (;;) {
    let best = Infinity, x = -1, y = -1;
    for (let i = 0; i < n; i++) if (alive[i]) for (let j = i + 1; j < n; j++) if (alive[j] && d[i][j] < best) { best = d[i][j]; x = i; y = j; }
    if (x < 0 || best > distance) break;
    // Lance-Williams update: the merged cluster's distance to any other is the size-weighted mean.
    for (let k = 0; k < n; k++) if (alive[k] && k !== x && k !== y) d[x][k] = d[k][x] = (members[x].length * d[x][k] + members[y].length * d[y][k]) / (members[x].length + members[y].length);
    members[x].push(...members[y]); alive[y] = false;
  }
  const labels = new Array<number>(n).fill(-1);
  let next = 0;
  for (let i = 0; i < n; i++) if (labels[i] < 0) { const label = next++; for (const m of members.find((c, k) => alive[k] && c.includes(i))!) labels[m] = label; }
  return labels;
}
