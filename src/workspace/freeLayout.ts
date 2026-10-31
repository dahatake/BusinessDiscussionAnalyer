// 自由配置の押し出し・再配置の純粋なモデル（FR-173・FR-184）。React に依存しない。
// 動かしているコンポーネント（pinned）に重なったものを、重ならない位置へ移す（動かせなければ縮める）。
// どうしても解けないときは、全体を格子に並べ直して、重なりが残らないことを保証する。
import { MIN_WINDOW_H, MIN_WINDOW_W } from './windowLimits';

export interface PxRect { x: number; y: number; w: number; h: number }
export type PxMap = Record<string, PxRect>;
export interface Bounds { w: number; h: number }

/** これ未満の重なり（面積 px²）は、重なりとして扱わない（描画の丸め誤差） */
const EPS = 1;
/** 縮めてよい最小の大きさ（px） */
export const MIN_W = MIN_WINDOW_W;
export const MIN_H = MIN_WINDOW_H;

export const overlapArea = (a: PxRect, b: PxRect): number =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

/** 作業領域の中に収める（大きさが領域より大きければ縮める） */
export function clampInto(r: PxRect, b: Bounds): PxRect {
  const w = Math.min(Math.max(r.w, 1), b.w);
  const h = Math.min(Math.max(r.h, 1), b.h);
  return { x: Math.min(Math.max(r.x, 0), b.w - w), y: Math.min(Math.max(r.y, 0), b.h - h), w, h };
}

export type ResizeEdge = 'e' | 's' | 'se';

/**
 * 縁・角のドラッグ量（dx, dy）で、左上を動かさずに大きさだけを変える（FR-224）。縦と横は独立（'e' は横だけ、's' は縦だけ、'se' は両方）。
 * 最小の大きさ（MIN_W × MIN_H）を下回らず、作業領域からはみ出さない。
 */
export function resizeRect(r: PxRect, edge: ResizeEdge, dx: number, dy: number, b: Bounds): PxRect {
  const w = edge === 's' ? r.w : Math.max(MIN_W, Math.min(r.w + dx, Math.max(MIN_W, b.w - r.x)));
  const h = edge === 'e' ? r.h : Math.max(MIN_H, Math.min(r.h + dy, Math.max(MIN_H, b.h - r.y)));
  return { ...r, w, h };
}

const NONE: ReadonlySet<string> = new Set();
const overlapsAny = (r: PxRect, others: PxRect[]): boolean => others.some((o) => overlapArea(r, o) > EPS);

/** `o` を、`p` と重ならない位置へ移す。まず平行移動（最小の距離）、できなければ縮める。移せなければ null。
 *  `keepSize` のもの（手で大きさを変えたもの。FR-224・FR-228 AC-529）は縮めず、平行移動だけを試す。 */
function pushAway(o: PxRect, p: PxRect, pinned: PxRect | PxRect[], b: Bounds, keepSize = false): PxRect | null {
  const blockers = Array.isArray(pinned) ? pinned : [pinned];
  const cands: Array<{ r: PxRect; cost: number }> = [];
  const moves: PxRect[] = [
    { ...o, x: p.x + p.w },
    { ...o, x: p.x - o.w },
    { ...o, y: p.y + p.h },
    { ...o, y: p.y - o.h },
  ];
  for (const m of moves) {
    if (m.x < -0.01 || m.y < -0.01 || m.x + m.w > b.w + 0.01 || m.y + m.h > b.h + 0.01) continue;
    if (overlapsAny(m, blockers)) continue;
    cands.push({ r: m, cost: Math.abs(m.x - o.x) + Math.abs(m.y - o.y) });
  }
  if (cands.length > 0) return cands.reduce((a, c) => (c.cost < a.cost ? c : a)).r;
  if (keepSize) return null;
  // 縮める: p と重ならない側だけを残す（残る面積が最大のもの）
  const cuts: PxRect[] = [
    { x: o.x, y: o.y, w: p.x - o.x, h: o.h },
    { x: p.x + p.w, y: o.y, w: o.x + o.w - (p.x + p.w), h: o.h },
    { x: o.x, y: o.y, w: o.w, h: p.y - o.y },
    { x: o.x, y: p.y + p.h, w: o.w, h: o.y + o.h - (p.y + p.h) },
  ].filter((c) => c.w >= MIN_W && c.h >= MIN_H && !overlapsAny(c, blockers));
  if (cuts.length === 0) return null;
  return cuts.reduce((a, c) => (c.w * c.h > a.w * a.h ? c : a));
}

/** 全体を格子に並べ直す（最後の手段）。いまの位置の順（上から下、左から右）を保つ。 */
export function packGrid(rects: PxMap, b: Bounds): PxMap {
  const keys = Object.keys(rects);
  const n = keys.length;
  if (n === 0) return {};
  // 列の幅は最小の幅（PARAM-034）を下回らない。下回ると見出しの操作（「ビュー」など）が隠れる「狭い」コンポーネントになる（FR-150 AC-259・FR-237 AC-557）
  const maxCols = Math.max(1, Math.floor(b.w / MIN_W));
  const cols = Math.min(maxCols, Math.max(1, Math.round(Math.sqrt((n * b.w) / Math.max(b.h, 1)))));
  const rows = Math.ceil(n / cols);
  const cy = (k: string) => rects[k]!.y + rects[k]!.h / 2;
  const cx = (k: string) => rects[k]!.x + rects[k]!.w / 2;
  const byY = [...keys].sort((a, c) => cy(a) - cy(c) || cx(a) - cx(c));
  const out: PxMap = {};
  for (let r = 0; r < rows; r++) {
    const line = byY.slice(r * cols, (r + 1) * cols).sort((a, c) => cx(a) - cx(c));
    const cw = b.w / line.length;
    const ch = b.h / rows;
    line.forEach((k, i) => { out[k] = { x: i * cw, y: r * ch, w: cw, h: ch }; });
  }
  return out;
}

export function hasOverlap(rects: PxMap): boolean {
  const ks = Object.keys(rects);
  for (let i = 0; i < ks.length; i++) for (let j = i + 1; j < ks.length; j++) if (overlapArea(rects[ks[i]!]!, rects[ks[j]!]!) > EPS) return true;
  return false;
}

/**
 * `pinned`（動かしている・置いたコンポーネント）に重なるものを押し出して、すべてが重ならない配置にする（FR-184）。
 * 押し出されたものがさらにほかと重なるときは、それも押し出す。入力は変えない。
 */
export function resolveOverlaps(input: PxMap, pinned: string, b: Bounds, keep: ReadonlySet<string> = NONE): PxMap {
  const r: PxMap = {};
  for (const [k, v] of Object.entries(input)) r[k] = clampInto(v, b);
  if (!r[pinned]) return r;
  const keys = Object.keys(r);
  const queue = [pinned];
  let guard = 0;
  while (queue.length > 0 && guard++ < 400) {
    const p = queue.shift()!;
    const hits = keys
      .filter((o) => o !== pinned && o !== p && overlapArea(r[p]!, r[o]!) > EPS)
      .sort((a, c) => overlapArea(r[p]!, r[c]!) - overlapArea(r[p]!, r[a]!));
    for (const o of hits) {
      if (overlapArea(r[p]!, r[o]!) <= EPS) continue;
      const moved = pushAway(r[o]!, r[p]!, r[pinned]!, b, keep.has(o));
      if (!moved) continue;
      r[o] = moved;
      queue.push(o);
    }
  }
  if (!hasOverlap(r)) return r;
  // 局所の押し出しで解けない: 置いたものを動かさずに、残りを空いた所へ（必要なら縮めて）並べ直す。それでも解けなければ、全体を格子に並べ直す（重ならないことを保証）
  // 手で大きさを変えたもの（keep）は、まず大きさを保ったまま並べ直す。保てないときだけ縮める
  return repack(input, pinned, b, NONE, keep) ?? (keep.size > 0 ? repack(input, pinned, b) : null) ?? packGrid(r, b);
}

/** 縮める倍率（大きい順）と、置く位置を探す格子の間隔（px） */
const SHRINK = [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4];
const STEP = 16;
/** 大きさを保つもの（縮めない） */
const KEEP = [1];

/** `pinned` を動かさず、ほかを元の位置にできるだけ近い空きへ置く。入らなければ縮める（`keep` のものは縮めない）。置けないものがあれば null。 */
export function repack(input: PxMap, pinned: string, b: Bounds, fixed: ReadonlySet<string> = NONE, keep: ReadonlySet<string> = NONE): PxMap | null {
  const out: PxMap = { [pinned]: clampInto(input[pinned]!, b) };
  for (const k of fixed) if (input[k] && k !== pinned) out[k] = clampInto(input[k]!, b);
  const placed: PxRect[] = Object.values(out);
  const order = Object.keys(input).filter((k) => k !== pinned && !(k in out)).sort((a, c) => input[a]!.y - input[c]!.y || input[a]!.x - input[c]!.x);
  for (const k of order) {
    const o = clampInto(input[k]!, b);
    let found: PxRect | null = null;
    for (const f of keep.has(k) ? KEEP : SHRINK) {
      const w = Math.min(b.w, Math.max(Math.min(MIN_W, o.w), o.w * f));
      const h = Math.min(b.h, Math.max(Math.min(MIN_H, o.h), o.h * f));
      let best: { r: PxRect; d: number } | null = null;
      for (let y = 0; y <= b.h - h + 0.5; y += STEP) {
        for (let x = 0; x <= b.w - w + 0.5; x += STEP) {
          const c = { x: Math.min(x, b.w - w), y: Math.min(y, b.h - h), w, h };
          if (overlapsAny(c, placed)) continue;
          const d = Math.abs(c.x - o.x) + Math.abs(c.y - o.y);
          if (!best || d < best.d) best = { r: c, d };
        }
      }
      if (best) { found = best.r; break; }
    }
    if (!found) return null;
    out[k] = found;
    placed.push(found);
  }
  return hasOverlap(out) ? null : out;
}

/** 新しく現れたコンポーネント（`key`）を、空いている所へ置く。空きがなければ押し出す。 */
export function placeNew(rects: PxMap, key: string, size: { w: number; h: number }, b: Bounds): PxMap {
  const w = Math.min(size.w, b.w);
  const h = Math.min(size.h, b.h);
  const others = Object.entries(rects).filter(([k]) => k !== key).map(([, v]) => v);
  const step = 16;
  let best: PxRect | null = null;
  for (let y = 0; y + h <= b.h + 0.5 && !best; y += step) {
    for (let x = 0; x + w <= b.w + 0.5; x += step) {
      const c = { x, y, w, h };
      if (!overlapsAny(c, others)) { best = c; break; }
    }
  }
  const at = best ?? { x: Math.max(0, (b.w - w) / 2), y: Math.max(0, (b.h - h) / 2), w, h };
  return resolveOverlaps({ ...rects, [key]: at }, key, b);
}

/**
 * `o` と同じ大きさで、`blockers` のどれとも重ならない、いちばん近い位置（FR-216）。同じ大きさで置けなければ縮める（最小 MIN_W×MIN_H）。
 * 置ける場所が作業領域に残っていなければ null。
 */
export function nearestFree(o: PxRect, blockers: readonly PxRect[], b: Bounds, keepSize = false): PxRect | null {
  const src = clampInto(o, b);
  if (!overlapsAny(src, blockers as PxRect[])) return src;
  for (const f of keepSize ? KEEP : SHRINK) {
    const w = Math.min(b.w, Math.max(Math.min(MIN_W, src.w), src.w * f));
    const h = Math.min(b.h, Math.max(Math.min(MIN_H, src.h), src.h * f));
    let best: { r: PxRect; d: number } | null = null;
    const xs = new Set<number>([0, b.w - w]);
    const ys = new Set<number>([0, b.h - h]);
    for (let x = 0; x <= b.w - w + 0.5; x += STEP / 2) xs.add(Math.min(x, b.w - w));
    for (let y = 0; y <= b.h - h + 0.5; y += STEP / 2) ys.add(Math.min(y, b.h - h));
    // 障害物の辺に接する位置も候補にする（格子の間隔に関わらず、すき間なく寄せられるように）
    for (const k of blockers) { xs.add(k.x + k.w); xs.add(k.x - w); ys.add(k.y + k.h); ys.add(k.y - h); }
    for (const y of ys) {
      if (y < -0.01 || y + h > b.h + 0.01) continue;
      for (const x of xs) {
        if (x < -0.01 || x + w > b.w + 0.01) continue;
        const c = { x, y, w, h };
        if (overlapsAny(c, blockers as PxRect[])) continue;
        const d = Math.hypot(c.x - src.x, c.y - src.y);
        if (!best || d < best.d) best = { r: c, d };
      }
    }
    if (best) return best.r;
  }
  return null;
}

/**
 * `key` を置き、ぶつかるものを押し出す。`fixed`（ピン止めしたもの）は動かさない（FR-216・FR-184）。
 * `key` が固定のものと重なるときは、`key` を重ならない最寄りの位置へ移す。置き場所が作業領域に残っていなければ null（呼び出し側は元に戻す）。
 * `fixed` が空なら resolveOverlaps と同じ。
 */
export function resolveAround(input: PxMap, key: string, b: Bounds, fixed: ReadonlySet<string> = NONE, keep: ReadonlySet<string> = NONE): PxMap | null {
  const fx = [...fixed].filter((k) => k !== key && input[k]);
  if (fx.length === 0) return resolveOverlaps(input, key, b, keep);
  const r: PxMap = {};
  for (const [k, v] of Object.entries(input)) r[k] = clampInto(v, b);
  if (!r[key]) return r;
  const fixedRects = fx.map((k) => r[k]!);
  const placedKey = nearestFree(r[key]!, fixedRects, b);
  if (!placedKey) return null;
  r[key] = placedKey;
  const movable = Object.keys(r).filter((k) => k !== key && !fixed.has(k));
  const queue = [key];
  let guard = 0;
  while (queue.length > 0 && guard++ < 400) {
    const p = queue.shift()!;
    const hits = movable.filter((o) => o !== p && overlapArea(r[p]!, r[o]!) > EPS);
    for (const o of hits) {
      if (overlapArea(r[p]!, r[o]!) <= EPS) continue;
      const moved = pushAway(r[o]!, r[p]!, [r[key]!, ...fixedRects], b, keep.has(o));
      if (!moved) continue;
      r[o] = moved;
      queue.push(o);
    }
  }
  // 固定のものと重なるものが残っていれば、それも重ならない最寄りの位置へ
  for (const o of movable) {
    if (!overlapsAny(r[o]!, fixedRects)) continue;
    const m = nearestFree(r[o]!, [r[key]!, ...fixedRects], b, keep.has(o));
    if (m) r[o] = m;
  }
  if (!hasOverlap(r)) return r;
  return repack(r, key, b, new Set(fx), keep) ?? (keep.size > 0 ? repack(r, key, b, new Set(fx)) : null);
}
