// 複数ウィンドウの既定の構成と最小サイズ（FR-296。PARAM-134・PARAM-135・PARAM-136）。React に依存しない純粋な計算。
// 共通部品「ワークスペース」の一部。一覧（FR-295）・スナップ・自動のサイズ調整・再表示が同じ下限を使う。
import { clone, keysOf, normalizeSizes, type Layout, type LayoutNode } from './layoutModel';

/** PARAM-134: 自由配置のコンポーネントの最小の幅（CSS px。読める大きさの下限。PARAM-034 の 240px はタブにまとめる境界として別に残す） */
export const MIN_WINDOW_W = 360;
/** PARAM-135: 自由配置のコンポーネントの最小の高さ（CSS px） */
export const MIN_WINDOW_H = 240;
/** PARAM-136: 各画面の既定のレイアウトで同時に表示するコンポーネントの上限 */
export const MAX_DEFAULT_VISIBLE = 4;
/** 分割の境界の太さ（CSS px。Workspace の境界と同じ） */
export const SEPARATOR_PX = 8;

/** 木に必要な最小の幅（各葉が PARAM-134 以上になる）。横の分割は子の和、縦の分割は子の最大 */
export function needWidth(node: LayoutNode, min = MIN_WINDOW_W): number {
  if (node.kind === 'tabs') return min;
  const kids = node.children.map((c) => needWidth(c, min));
  return node.dir === 'row' ? kids.reduce((a, b) => a + b, 0) + (kids.length - 1) * SEPARATOR_PX : Math.max(...kids);
}

/** 木に必要な最小の高さ（各葉が PARAM-135 以上になる） */
export function needHeight(node: LayoutNode, min = MIN_WINDOW_H): number {
  if (node.kind === 'tabs') return min;
  const kids = node.children.map((c) => needHeight(c, min));
  return node.dir === 'col' ? kids.reduce((a, b) => a + b, 0) + (kids.length - 1) * SEPARATOR_PX : Math.max(...kids);
}

/**
 * 各葉が最小の幅・高さ以上になるよう、分割の比率を直す（元は変えない）。足りない分は、余りの大きい側から取らず、
 * 最小に必要な分を先に確保し、余りだけを元の比率で分ける。領域が必要な大きさに満たない軸は、そのまま（比例）にする。
 * 領域が最小の幅より狭いときは、領域の幅いっぱいで表示する（比率は変えない）。
 */
export function enforceMin(layout: Layout, width: number, height: number, minW = MIN_WINDOW_W, minH = MIN_WINDOW_H): Layout {
  if (!layout || !(width > 0) || !(height > 0)) return layout;
  const walk = (n: LayoutNode, w: number, h: number): LayoutNode => {
    if (n.kind === 'tabs') return n;
    const horizontal = n.dir === 'row';
    const extent = horizontal ? w : h;
    const avail = extent - (n.children.length - 1) * SEPARATOR_PX;
    const needs = n.children.map((c) => (horizontal ? needWidth(c, minW) : needHeight(c, minH)));
    const total = needs.reduce((a, b) => a + b, 0);
    // 子の need は子自身の区切りを含む。足りている（どの子も必要な大きさ以上）なら、比率は変えない
    let sizes = n.sizes;
    const violated = n.children.some((_, i) => (n.sizes[i] ?? 0) * avail < (needs[i] ?? 0) - 0.5);
    if (violated && avail > 0 && total <= avail + 0.5) {
      const surplus = avail - total;
      const base = normalizeSizes(n.sizes, n.children.length);
      sizes = normalizeSizes(needs.map((need, i) => (need + surplus * (base[i] ?? 0)) / avail), n.children.length);
    }
    const children = n.children.map((c, i) => {
      const share = sizes[i] ?? 0;
      return horizontal ? walk(c, avail * share, h) : walk(c, w, avail * share);
    });
    return { kind: 'split', dir: n.dir, sizes, children };
  };
  return walk(layout, width, height);
}

/** 木を領域に当てはめたときの、各葉（タブのまとまり）の大きさ（px）。区切りの太さを除く */
export function leafSizes(layout: Layout, width: number, height: number): Array<{ keys: string[]; w: number; h: number }> {
  const out: Array<{ keys: string[]; w: number; h: number }> = [];
  const walk = (n: LayoutNode, w: number, h: number): void => {
    if (n.kind === 'tabs') { out.push({ keys: [...n.tabs], w, h }); return; }
    const horizontal = n.dir === 'row';
    const avail = (horizontal ? w : h) - (n.children.length - 1) * SEPARATOR_PX;
    n.children.forEach((c, i) => {
      const share = n.sizes[i] ?? 0;
      if (horizontal) walk(c, avail * share, h); else walk(c, w, avail * share);
    });
  };
  if (layout) walk(layout, width, height);
  return out;
}

/** 木の幅が領域に収まるか（各葉が最小の幅以上になる並べ方ができるか） */
export function fitsWidth(layout: Layout, width: number, minW = MIN_WINDOW_W): boolean {
  if (!layout) return true;
  return width < minW || needWidth(layout, minW) <= width + 0.5;
}

/**
 * 領域が足りないとき、最も長く使っていない（ピン止めしていない）コンポーネントを順に外して、収まるようにする（FR-296 AC-801）。
 * `protect` は外さない（いま見せたもの）。`usedAt` は大きいほど最近（なければ 0）。外したものは最小化として一覧に残す（閉じない）。
 * 戻り値は、収まった木と、外したコンポーネントのキー（外した順）。
 */
export function makeRoom(layout: Layout, width: number, opts: { protect?: readonly string[]; pinned?: ReadonlySet<string>; usedAt?: Readonly<Record<string, number>>; minW?: number } = {}): { layout: Layout; dropped: string[] } {
  const minW = opts.minW ?? MIN_WINDOW_W;
  let cur: Layout = layout ? clone(layout) : layout;
  const dropped: string[] = [];
  const protect = new Set(opts.protect ?? []);
  const pinned = opts.pinned ?? new Set<string>();
  const usedAt = opts.usedAt ?? {};
  while (cur && !fitsWidth(cur, width, minW)) {
    const keys = keysOf(cur);
    const victims = keys.filter((k) => !protect.has(k) && !pinned.has(k));
    if (victims.length === 0) break;
    // 最も長く使っていないもの（同じなら、並びの後ろのもの）
    let victim = victims[0]!;
    for (const k of victims) if ((usedAt[k] ?? 0) <= (usedAt[victim] ?? 0)) victim = k;
    dropped.push(victim);
    cur = removeKey(cur, victim);
  }
  return { layout: cur, dropped };
}

function removeKey(layout: LayoutNode, key: string): Layout {
  const walk = (n: LayoutNode): LayoutNode | null => {
    if (n.kind === 'tabs') {
      const tabs = n.tabs.filter((k) => k !== key);
      if (tabs.length === 0) return null;
      return { kind: 'tabs', tabs, active: tabs.includes(n.active) ? n.active : tabs[0]! };
    }
    const kept: Array<{ n: LayoutNode; s: number }> = [];
    n.children.forEach((c, i) => { const r = walk(c); if (r) kept.push({ n: r, s: n.sizes[i] ?? 1 }); });
    if (kept.length === 0) return null;
    if (kept.length === 1) return kept[0]!.n;
    return { kind: 'split', dir: n.dir, children: kept.map((k) => k.n), sizes: normalizeSizes(kept.map((k) => k.s), kept.length) };
  };
  return walk(layout);
}

/** 自由配置の矩形（作業領域に対する割合）を、最小の幅・高さ以上に直し、領域の外へ出さない。領域が最小より狭いときは領域いっぱい */
export function floorFloat(r: { x: number; y: number; w: number; h: number }, width: number, height: number, minW = MIN_WINDOW_W, minH = MIN_WINDOW_H): { x: number; y: number; w: number; h: number } {
  if (!(width > 0) || !(height > 0)) return r;
  const w = Math.min(1, Math.max(r.w, minW / width));
  const h = Math.min(1, Math.max(r.h, minH / height));
  return { x: Math.min(1 - w, Math.max(0, r.x)), y: Math.min(1 - h, Math.max(0, r.y)), w, h };
}
