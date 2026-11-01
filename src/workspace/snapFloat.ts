// スナップ・最大化・共有境界のリサイズの、自由配置（作業領域に対する絶対配置）での純粋なモデル（FR-152・FR-184）。React に依存しない。
// 重ならない配置（スナップ・分割・最大化・共有境界のリサイズ）は、ここで重ならないことを保証する。
// 自由な移動（FR-173）は重なりを許すので、ここは通らない（Q-066 B 2026-10-27）。
import { MIN_WINDOW_W as MIN_COMPONENT_WIDTH } from './windowLimits';
import { MIN_H, clampInto, hasOverlap, overlapArea, packGrid, repack, type Bounds, type PxMap, type PxRect } from './freeLayout';

const EPS = 1;
/** 押し出しで動かせなかったときの最後の手段で、ほかを並べる帯の高さの割合 */
const STRIP = 0.28;

const pairKey = (a: string, b: string): string => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);

/** 重なっている組（key を除く）。スナップに関係しない重なりを維持するための控え（A-75） */
function overlappingPairs(rects: PxMap, except: string): Set<string> {
  const out = new Set<string>();
  const ks = Object.keys(rects).filter((k) => k !== except);
  for (let i = 0; i < ks.length; i++) for (let j = i + 1; j < ks.length; j++) if (overlapArea(rects[ks[i]!]!, rects[ks[j]!]!) > EPS) out.add(pairKey(ks[i]!, ks[j]!));
  return out;
}

/** 格子に並べたセルの周りを、わずかに内側へ寄せる（隣と接して、描画の丸め誤差で重なって見えないように） */
const inset = (r: PxRect): PxRect => ({ x: r.x + GAP / 2, y: r.y + GAP / 2, w: r.w - GAP, h: r.h - GAP });

/** 押し出した先との間に空ける、ごくわずかな隙間（px）。描画の丸め誤差で重なって見えないようにする */
const GAP = 1;

/** `o` を `p` と重ならない位置へ平行移動する（最小の移動。作業領域の外へ出さない）。`blockers` とも重ならないこと。 */
function shift(o: PxRect, p: PxRect, blockers: PxRect[], b: Bounds): PxRect | null {
  const cands = [
    { ...o, x: p.x + p.w + GAP }, { ...o, x: p.x - o.w - GAP }, { ...o, y: p.y + p.h + GAP }, { ...o, y: p.y - o.h - GAP },
  ].filter((m) => m.x >= -0.01 && m.y >= -0.01 && m.x + m.w <= b.w + 0.01 && m.y + m.h <= b.h + 0.01 && blockers.every((k) => overlapArea(m, k) <= EPS));
  if (cands.length === 0) return null;
  return cands.reduce((a, c) => (Math.abs(c.x - o.x) + Math.abs(c.y - o.y) < Math.abs(a.x - o.x) + Math.abs(a.y - o.y) ? c : a));
}

/** 障害物（obs）のどれとも重ならない、いちばん面積の大きい長方形（作業領域の中）。なければ null */
function largestEmpty(obs: PxRect[], b: Bounds): PxRect | null {
  const xs = [...new Set([0, b.w, ...obs.flatMap((o) => [o.x, o.x + o.w])])].filter((v) => v >= 0 && v <= b.w).sort((p, q) => p - q);
  const ys = [...new Set([0, b.h, ...obs.flatMap((o) => [o.y, o.y + o.h])])].filter((v) => v >= 0 && v <= b.h).sort((p, q) => p - q);
  let best: PxRect | null = null;
  for (let i = 0; i < xs.length; i++) for (let j = i + 1; j < xs.length; j++) for (let k = 0; k < ys.length; k++) for (let l = k + 1; l < ys.length; l++) {
    const c = { x: xs[i]!, y: ys[k]!, w: xs[j]! - xs[i]!, h: ys[l]! - ys[k]! };
    if (c.w < 1 || c.h < 1 || obs.some((o) => overlapArea(c, o) > EPS)) continue;
    if (!best || c.w * c.h > best.w * best.h) best = c;
  }
  return best;
}

/** スナップしたもの（key・hold）を動かさず、残りを、いちばん広い空きに格子で並べる。各セルが最小の大きさを下回るときは null */
function packIntoEmpty(r0: PxMap, key: string, t: PxRect, hold: ReadonlySet<string>, b: Bounds): PxMap | null {
  const others = Object.keys(r0).filter((k) => k !== key && !hold.has(k));
  const out: PxMap = { [key]: t };
  for (const k of hold) out[k] = r0[k]!;
  if (others.length === 0) return out;
  const free = largestEmpty([t, ...[...hold].map((k) => r0[k]!)], b);
  if (!free || free.w < MIN_COMPONENT_WIDTH) return null;
  const grid = packGrid(Object.fromEntries(others.map((k) => [k, r0[k]!])), { w: free.w, h: free.h });
  for (const k of others) {
    const c = grid[k]!;
    if (c.w < MIN_COMPONENT_WIDTH - 1 || c.h < MIN_H - 1) return null;
    out[k] = inset({ x: free.x + c.x, y: free.y + c.y, w: c.w, h: c.h });
  }
  return out;
}

export interface SnapPlanOpts {
  /** ピン止めしたもの。動かさない */
  fixed?: ReadonlySet<string>;
  /** すでにスナップして置いたもの。できるだけ動かさない（残りを並べ直す空きを探すときの固定） */
  anchors?: ReadonlySet<string>;
  /** 手で大きさを変えたもの。できるだけ縮めない */
  keep?: ReadonlySet<string>;
}

/**
 * `key` を `target`（スナップ先の領域）へ置き、ほかを重ならないように動かした配置（px）を返す（FR-152・FR-184）。
 * 1) ぶつかるものだけを平行移動で押し出す（スナップに関係しない重なりは維持する。A-75）。
 * 2) 解けなければ、すでにスナップしたものを動かさず、残りを空きへ並べ直す。
 * 3) それも解けなければ、スナップしたものを縦に詰め、残りを下の帯に並べる（どれも非表示にしない）。
 * ピン止めしたものと重なる領域には置けない（null）。
 */
export function planSnap(input: PxMap, key: string, target: PxRect, b: Bounds, opts: SnapPlanOpts = {}): PxMap | null {
  const fixed = new Set([...(opts.fixed ?? [])].filter((k) => k !== key && input[k]));
  const keep = opts.keep ?? new Set<string>();
  const r0: PxMap = {};
  for (const [k, v] of Object.entries(input)) r0[k] = clampInto(v, b);
  const t = clampInto(target, b);
  r0[key] = t;
  for (const k of fixed) if (overlapArea(t, r0[k]!) > EPS) return null;

  // 1) 押し出し
  const before = overlappingPairs(input, key);
  const r: PxMap = { ...r0 };
  const keys = Object.keys(r).filter((k) => k !== key);
  const queue = [key];
  let guard = 0;
  while (queue.length > 0 && guard++ < 400) {
    const p = queue.shift()!;
    for (const o of keys) {
      if (o === p || fixed.has(o) || overlapArea(r[p]!, r[o]!) <= EPS) continue;
      if (p !== key && before.has(pairKey(p, o))) continue;
      const moved = shift(r[o]!, r[p]!, [t, ...[...fixed].map((f) => r[f]!)], b);
      if (!moved) continue;
      r[o] = moved;
      queue.push(o);
    }
  }
  const valid = (m: PxMap): boolean => {
    for (const o of keys) if (overlapArea(m[key]!, m[o]!) > EPS) return false;
    const now = overlappingPairs(m, key);
    for (const p of now) if (!before.has(p)) return false;
    return true;
  };
  if (valid(r)) return r;

  // 2) すでにスナップしたものを動かさず、残りを空いた領域へ（いちばん広い空きに格子で並べる。入らなければ空きを探して並べ直す）
  const anchors = new Set([...(opts.anchors ?? [])].filter((k) => k !== key && r0[k] && !fixed.has(k) && overlapArea(t, r0[k]!) <= EPS));
  const hold = new Set([...fixed, ...anchors]);
  const gridded = packIntoEmpty(r0, key, t, hold, b);
  if (gridded) return gridded;
  const packed = repack(r0, key, b, hold, keep) ?? repack(r0, key, b, hold);
  if (packed && !hasOverlap(packed)) return packed;

  // 3) スナップしたものを縦に詰め、残りを下の帯へ
  if (fixed.size > 0) return null;
  const others = Object.keys(r0).filter((k) => k !== key && !anchors.has(k));
  if (others.length === 0) return r0;
  const sh = Math.max(b.h * STRIP, MIN_H);
  const scale = Math.max(0.1, (b.h - sh) / b.h);
  const out: PxMap = {};
  for (const k of [key, ...anchors]) out[k] = { ...r0[k]!, y: r0[k]!.y * scale, h: r0[k]!.h * scale };
  const grid = packGrid(Object.fromEntries(others.map((k) => [k, r0[k]!])), { w: b.w, h: sh });
  for (const k of others) out[k] = inset({ ...grid[k]!, y: grid[k]!.y + (b.h - sh) });
  return out;
}

/** 配置後に残る領域（Snap Assist で埋める先。作業領域の割合 0〜1）。最大化・タブ化など、残る領域がないものは null（FR-152 AC-794）。 */
export function remainingRegion(kind: string, opts: { edge?: string; corner?: string } = {}): { x: number; y: number; w: number; h: number } | null {
  switch (kind) {
    case 'left': return { x: 0.5, y: 0, w: 0.5, h: 1 };
    case 'right': return { x: 0, y: 0, w: 0.5, h: 1 };
    case 'top': return { x: 0, y: 0.5, w: 1, h: 0.5 };
    case 'bottom': return { x: 0, y: 0, w: 1, h: 0.5 };
    case 'quad': {
      const c = opts.corner ?? 'tl';
      const right = c === 'tr' || c === 'br';
      const bottom = c === 'bl' || c === 'br';
      return { x: right ? 0 : 0.5, y: bottom ? 0 : 0.5, w: 0.5, h: 0.5 };
    }
    case 'third': {
      if (opts.edge === 'top') return { x: 0, y: 1 / 3, w: 1, h: 2 / 3 };
      if (opts.edge === 'bottom') return { x: 0, y: 0, w: 1, h: 2 / 3 };
      return opts.edge === 'right' ? { x: 0, y: 0, w: 2 / 3, h: 1 } : { x: 1 / 3, y: 0, w: 2 / 3, h: 1 };
    }
    default: return null;
  }
}

export interface UnitRect { x: number; y: number; w: number; h: number }

/** 隣り合って配置されたコンポーネントの共有する境界（FR-152 (4)）。作業領域に対する割合で表す。 */
export interface Border {
  /** 'v': 縦の境界（左右に隣り合う）、'h': 横の境界（上下に隣り合う） */
  dir: 'v' | 'h';
  pos: number;
  from: number;
  to: number;
  /** 境界の左（上）側と右（下）側のコンポーネント */
  before: string[];
  after: string[];
}

const TOL = 0.004;
const MIN_SPAN = 0.05;

/** 辺が接して並んでいる組から、共有する境界を求める。同じ位置の境界は 1 つにまとめる。 */
export function sharedBorders(rects: Readonly<Record<string, UnitRect>>): Border[] {
  const ks = Object.keys(rects);
  const found = new Map<string, Border>();
  const add = (dir: 'v' | 'h', pos: number, a: string, c: string, from: number, to: number): void => {
    const id = `${dir}${Math.round(pos / TOL)}`;
    const cur = found.get(id);
    if (!cur) { found.set(id, { dir, pos, from, to, before: [a], after: [c] }); return; }
    if (!cur.before.includes(a)) cur.before.push(a);
    if (!cur.after.includes(c)) cur.after.push(c);
    cur.from = Math.min(cur.from, from);
    cur.to = Math.max(cur.to, to);
  };
  for (const a of ks) for (const c of ks) {
    if (a === c) continue;
    const A = rects[a]!;
    const C = rects[c]!;
    const ySpan = Math.min(A.y + A.h, C.y + C.h) - Math.max(A.y, C.y);
    if (Math.abs(A.x + A.w - C.x) < TOL && ySpan > MIN_SPAN) add('v', (A.x + A.w + C.x) / 2, a, c, Math.max(A.y, C.y), Math.min(A.y + A.h, C.y + C.h));
    const xSpan = Math.min(A.x + A.w, C.x + C.w) - Math.max(A.x, C.x);
    if (Math.abs(A.y + A.h - C.y) < TOL && xSpan > MIN_SPAN) add('h', (A.y + A.h + C.y) / 2, a, c, Math.max(A.x, C.x), Math.min(A.x + A.w, C.x + C.w));
  }
  return [...found.values()];
}

/**
 * 共有する境界を `delta`（割合）だけ動かす。両側が同時に変わり、隙間も重なりも生じない。
 * 境界の両側のどのコンポーネントも、最小の大きさ（minSize。割合）を下回らない範囲に収める。変わったものだけを返す。
 */
export function moveBorder(rects: Readonly<Record<string, UnitRect>>, border: Border, delta: number, minSize: number): Record<string, UnitRect> {
  const horizontal = border.dir === 'h';
  const len = (r: UnitRect) => (horizontal ? r.h : r.w);
  const lo = -Math.min(...border.before.map((k) => len(rects[k]!) - minSize));
  const hi = Math.min(...border.after.map((k) => len(rects[k]!) - minSize));
  const d = Math.max(Math.min(lo, 0), Math.min(delta, Math.max(hi, 0)));
  const out: Record<string, UnitRect> = {};
  for (const k of border.before) out[k] = horizontal ? { ...rects[k]!, h: rects[k]!.h + d } : { ...rects[k]!, w: rects[k]!.w + d };
  for (const k of border.after) out[k] = horizontal ? { ...rects[k]!, y: rects[k]!.y + d, h: rects[k]!.h - d } : { ...rects[k]!, x: rects[k]!.x + d, w: rects[k]!.w - d };
  return out;
}

/** 境界の動かせる最小の大きさ（割合）: 幅は最小の幅（PARAM-034）、高さは MIN_H */
export function minBorderSize(dir: 'v' | 'h', bounds: Bounds): number {
  return dir === 'v' ? MIN_COMPONENT_WIDTH / Math.max(bounds.w, 1) : MIN_H / Math.max(bounds.h, 1);
}
