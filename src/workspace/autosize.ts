// 操作中のコンポーネントを大きくする自動のサイズ調整（FR-143）と、最小の幅の確保（PARAM-034、AC-227）。
// React に依存しない純粋な計算。保存するレイアウト（木）は変えず、描くときだけ大きさを組み替える。
import { clone, keysOf, normalizeSizes, type Layout, type LayoutNode, type SplitNode, type TabsNode } from './layoutModel';
import { MIN_WINDOW_W } from './windowLimits';

/** PARAM-033: 操作中のコンポーネントの面積を基準の何倍にするか */
export const FOCUS_SCALE = 1.5;
/** PARAM-034: コンポーネントの最小の幅（CSS px）。これ未満になるものはタブにまとめる */
export const MIN_COMPONENT_WIDTH = 240;
/** 分割の境界の太さ（CSS px。Workspace の境界と同じ） */
export const SEPARATOR_PX = 8;
/** 重要度が高いコンポーネント（ペルソナの既定の情報表現）は、操作中の標準のコンポーネントより少し大きく保つ */
const PRIMARY_MARGIN = 1.1;
/** 操作中のコンポーネントが、使える面積に占める割合の上限（ほかが潰れないように） */
const FOCUS_CAP = 0.8;
/** ほかのコンポーネントが基準の面積に対して残す割合の下限 */
const OTHERS_FLOOR = 0.2;
/** 操作中のコンポーネントの列が、横の分割の幅に占める割合の上限（最小の幅の確保で縮んだ分を戻すとき） */
const FOCUS_COLUMN_MAX = 0.5;

export interface AutoSizeInput {
  enabled: boolean;
  /** 操作中（フォーカスのある）コンポーネントのキー */
  focus: string | null;
  /** ペルソナの既定の情報表現のキー（重要度: 高） */
  primary: string | null;
  /** 利用者が手で大きさを変えたコンポーネントのキー（自動の調整で変えない） */
  manual: ReadonlySet<string>;
  /** ワークスペースの幅（CSS px）。分かれば、最小の幅を割らないように調整する */
  width?: number;
}

const isTabs = (n: LayoutNode): n is TabsNode => n.kind === 'tabs';

/** 葉（タブのまとまり）ごとの、全体に対する面積の割合。 */
export function leafShares(layout: Layout): Array<{ node: TabsNode; share: number }> {
  const out: Array<{ node: TabsNode; share: number }> = [];
  const walk = (n: LayoutNode, share: number): void => {
    if (isTabs(n)) out.push({ node: n, share });
    else n.children.forEach((c, i) => walk(c, share * (n.sizes[i] ?? 0)));
  };
  if (layout) walk(layout, 1);
  return out;
}

/** 葉ごとの面積の割合 → 分割の比率（子の面積の和の比）。葉の面積は、そのまま重みになる。 */
function rebuild(node: LayoutNode, weight: Map<TabsNode, number>): LayoutNode {
  if (isTabs(node)) return node;
  const children = node.children.map((c) => rebuild(c, weight));
  const sum = (n: LayoutNode): number => (isTabs(n) ? weight.get(n) ?? 0 : n.children.reduce((a, c) => a + sum(c), 0));
  // 元の木の葉の重みで合計する（children は元の葉をそのまま持つので、weight の参照が使える）
  return { kind: 'split', dir: node.dir, children, sizes: normalizeSizes(children.map(sum), children.length) } as SplitNode;
}

/**
 * 自動のサイズ調整を適用した木を返す（FR-143 AC-226）。
 * - 操作中のコンポーネントの面積を、基準（保存したレイアウトのとき）の FOCUS_SCALE 倍にする。
 * - 重要度が高いコンポーネントは、操作中の標準のコンポーネントより小さくしない。
 * - 手で大きさを変えたコンポーネントの面積は変えない（AC-228）。
 * 調整しない場合（無効・操作中なし・操作中が手動）は、同じ木を返す。
 */
function sizeWith(layout: Layout, input: AutoSizeInput, scaleF: number): Layout {
  if (!layout || !input.enabled || !input.focus) return layout;
  const root = clone(layout);
  const leaves = leafShares(root);
  const has = (n: TabsNode, k: string | null): boolean => k !== null && n.tabs.includes(k);
  const x = leaves.find((l) => has(l.node, input.focus));
  if (!x || x.node.tabs.some((k) => input.manual.has(k))) return layout;
  const fixed = leaves.filter((l) => l !== x && l.node.tabs.some((k) => input.manual.has(k)));
  const p = leaves.find((l) => l !== x && has(l.node, input.primary) && !fixed.includes(l));
  const rest = leaves.filter((l) => l !== x && l !== p && !fixed.includes(l));
  const budget = 1 - fixed.reduce((a, l) => a + l.share, 0);
  const restSum = rest.reduce((a, l) => a + l.share, 0);
  if (budget <= 0 || restSum + (p?.share ?? 0) <= 1e-9) return layout;

  let t = Math.min(scaleF * x.share, FOCUS_CAP * budget);
  let scale = 1; // ほかのコンポーネントへの縮小率
  let pArea = p?.share ?? 0;
  for (let i = 0; i < 30; i++) {
    if (p) {
      scale = (budget - t) / (restSum + p.share);
      pArea = p.share * scale;
      if (pArea < PRIMARY_MARGIN * t) {
        pArea = PRIMARY_MARGIN * t;
        scale = restSum > 1e-9 ? (budget - t - pArea) / restSum : 1;
      }
    } else {
      scale = (budget - t) / restSum;
    }
    if (scale >= OTHERS_FLOOR) break;
    t *= 0.9;
  }
  if (!(scale > 0)) return layout;

  const weight = new Map<TabsNode, number>();
  weight.set(x.node, t);
  if (p) weight.set(p.node, pArea);
  for (const l of fixed) weight.set(l.node, l.share);
  for (const l of rest) weight.set(l.node, l.share * scale);
  let out = rebuild(root, weight);
  // 最小の幅（PARAM-034）を割る列は、操作中のコンポーネントの面積を保ったまま、縦の比率で補う
  if (input.width && input.width > 0) {
    for (let i = 0; i < 3; i++) {
      const before = leafShares(out).find((l) => l.node === x.node)?.share ?? t;
      const floored = floorWidths(out, input.width, x.node);
      const now = leafShares(floored).find((l) => l.node === x.node)?.share ?? t;
      // 最小の幅を確保するために操作中のコンポーネントを小さくするくらいなら、押し出される列はタブにまとめる（fitMinWidth）。広げたものを縮めない
      if (now < before - 0.005) break;
      out = floored;
      const k = t / now;
      if (Math.abs(k - 1) < 0.01 || !scaleColumn(out, x.node, k)) break;
    }
  }
  return out;
}

/** 横の分割の各列を、最小の幅以上にする（収まる場合だけ）。 */
/** 葉ごとの幅（CSS px）。縦の分割は幅を分けない。 */
function leafWidths(node: LayoutNode, width: number): number[] {
  if (isTabs(node)) return [width];
  if (node.dir === 'col') return node.children.flatMap((c) => leafWidths(c, width));
  const usable = Math.max(0, width - SEPARATOR_PX * (node.children.length - 1));
  return node.children.flatMap((c, i) => leafWidths(c, node.sizes[i]! * usable));
}

/**
 * 自動のサイズ調整を適用する（FR-143 AC-226 AC-242）。
 * 幅が分かるとき、PARAM-033 倍で最小の幅（PARAM-034）を割る列ができる狭い画面では、最小の幅の保持を優先し、
 * 拡大率を PARAM-033 倍から 1 倍まで（1 倍を下限に）縮める。それでも収まらないものは fitMinWidth がタブにまとめる。
 */
export function applyAutoSize(layout: Layout, input: AutoSizeInput): Layout {
  const w = input.width;
  if (!w || w <= 0) return sizeWith(layout, input, FOCUS_SCALE);
  const STEP = 0.05;
  let last: Layout = layout;
  for (let s = FOCUS_SCALE; s >= 1 - 1e-9; s -= STEP) {
    last = sizeWith(layout, input, Math.max(1, s));
    if (!last || leafWidths(last, w).every((x) => x >= MIN_WINDOW_W - 0.5)) return last;
  }
  return last;
}

/** ノードが最小の幅を保つために必要な幅（横の分割は子の和＋境界、縦の分割は子の最大） */
function needWidth(node: LayoutNode, min: number): number {
  if (isTabs(node)) return min;
  if (node.dir === 'col') return Math.max(...node.children.map((c) => needWidth(c, min)));
  return node.children.reduce((a, c) => a + needWidth(c, min), 0) + SEPARATOR_PX * (node.children.length - 1);
}

function floorWidths(node: LayoutNode, width: number, protect: TabsNode | null = null, min = MIN_WINDOW_W): LayoutNode {
  if (isTabs(node)) return node;
  if (node.dir === 'col') return { ...node, children: node.children.map((c) => floorWidths(c, width, protect, min)) };
  const n = node.children.length;
  const usable = Math.max(0, width - SEPARATOR_PX * (n - 1));
  let sizes = node.sizes.slice();
  const needs = node.children.map((c) => needWidth(c, min));
  if (needs.reduce((a, v) => a + v, 0) <= usable) {
    const floors = needs.map((v) => v / usable);
    // 足りない分は、操作中のコンポーネントを含まない列の余りから先に取る。足りないときだけ、含む列からも取る
    const guarded = node.children.map((c) => protect !== null && leafShares(c).some((l) => l.node === protect));
    let deficit = 0;
    sizes = sizes.map((s, i) => { if (s < floors[i]!) { deficit += floors[i]! - s; return floors[i]!; } return s; });
    for (const pass of [false, true]) {
      if (deficit <= 1e-9) break;
      const donors = sizes.map((s, i) => (guarded[i] === pass && s > floors[i]! ? s - floors[i]! : 0));
      const room = donors.reduce((a, d) => a + d, 0);
      if (room <= 1e-9) continue;
      const take = Math.min(deficit, room);
      sizes = sizes.map((s, i) => s - take * (donors[i]! / room));
      deficit -= take;
    }
    // 操作中のコンポーネントの列は、ほかの列が最小の幅を超えて持っている分を、半分まで引き取る（最小の幅の確保で縮められた分を戻す）
    const gi = guarded.indexOf(true);
    if (gi >= 0 && guarded.filter(Boolean).length === 1) {
      const donors = sizes.map((s, i) => (i !== gi && s > floors[i]! ? s - floors[i]! : 0));
      const room = donors.reduce((a, d) => a + d, 0);
      const take = Math.min(room, Math.max(0, FOCUS_COLUMN_MAX - sizes[gi]!));
      if (take > 1e-9) sizes = sizes.map((s, i) => (i === gi ? s + take : s - take * (donors[i]! / room)));
    }
  }
  return { ...node, sizes, children: node.children.map((c, i) => floorWidths(c, sizes[i]! * usable, protect, min)) };
}

/** `target` を含む縦の分割のうち、いちばん内側のものの比率を k 倍にする（残りは按分）。できたら true。 */
function scaleColumn(root: LayoutNode, target: TabsNode, k: number): boolean {
  const trail: Array<{ node: SplitNode; index: number }> = [];
  const find = (n: LayoutNode): boolean => {
    if (n === target) return true;
    if (isTabs(n)) return false;
    for (let i = 0; i < n.children.length; i++) {
      trail.push({ node: n, index: i });
      if (find(n.children[i]!)) return true;
      trail.pop();
    }
    return false;
  };
  if (!find(root)) return false;
  for (let d = trail.length - 1; d >= 0; d--) {
    const { node, index } = trail[d]!;
    if (node.dir !== 'col') continue;
    const f = node.sizes[index]!;
    const nf = Math.min(0.9, Math.max(0.1, f * k));
    if (Math.abs(nf - f) < 1e-6) return false;
    node.sizes = node.sizes.map((s, i) => (i === index ? nf : s * ((1 - nf) / (1 - f))));
    return true;
  }
  return false;
}

/**
 * 幅が最小の幅（PARAM-034）未満になるコンポーネントを、隣のものとタブにまとめる（AC-227）。
 * `width` は木全体の幅（CSS px）。縦の分割は幅を分けないので、横の分割だけを見る。
 * タブにまとめたあとの前面は、`prefer`（操作中・最後に選んだタブ）があればそれ、なければ元の前面。
 */
export function fitMinWidth(layout: Layout, width: number, prefer: readonly (string | null)[] = [], min = MIN_COMPONENT_WIDTH): Layout {
  if (!layout || !(width > 0)) return layout;
  const keep = prefer.filter((k): k is string => k !== null);
  const flatten = (n: LayoutNode): TabsNode => {
    const keys = keysOf(n);
    const leaves = leafShares(n);
    const active = keep.find((k) => keys.includes(k)) ?? leaves[0]?.node.active ?? keys[0]!;
    return { kind: 'tabs', tabs: keys, active };
  };
  /** 子が 1 つだけの分割は、その子に置き換える */
  const collapse = (n: LayoutNode): LayoutNode => {
    if (isTabs(n)) return n;
    const children = n.children.map(collapse);
    return children.length === 1 ? children[0]! : { ...n, children };
  };
  // 全部が最小の幅で並ぶ間はタブにまとめない（まとめるのは収まらないときだけ。AC-227）。
  // 収まらないときは、操作中・最後に選んだものを含まない、隣り合う葉の組のうち幅の合計が小さいものから 1 組ずつまとめ、収まるまで繰り返す。
  let root = clone(layout) as LayoutNode;
  for (let guard = 0; guard < 64 && needWidth(root, min) > width + 0.5; guard++) {
    const cands: Array<{ parent: SplitNode; a: number; score: number; leafPair: boolean; prot: boolean }> = [];
    const walk = (n: LayoutNode, w: number): void => {
      if (isTabs(n)) return;
      if (n.dir === 'col') { n.children.forEach((c) => walk(c, w)); return; }
      const usable = Math.max(0, w - SEPARATOR_PX * (n.children.length - 1));
      for (let a = 0; a + 1 < n.children.length; a++) {
        const ca = n.children[a]!, cb = n.children[a + 1]!;
        const ks = [...keysOf(ca), ...keysOf(cb)];
        cands.push({ parent: n, a, score: (n.sizes[a]! + n.sizes[a + 1]!) * usable, leafPair: isTabs(ca) && isTabs(cb), prot: keep.some((k) => ks.includes(k)) });
      }
      n.children.forEach((c, i) => walk(c, n.sizes[i]! * usable));
    };
    walk(root, width);
    if (cands.length === 0) break;
    cands.sort((x, y) => Number(x.prot) - Number(y.prot) || Number(!x.leafPair) - Number(!y.leafPair) || x.score - y.score);
    const { parent, a } = cands[0]!;
    const merged = flatten({ kind: 'split', dir: 'row', sizes: [1, 1], children: [parent.children[a]!, parent.children[a + 1]!] });
    const size = parent.sizes[a]! + parent.sizes[a + 1]!;
    parent.children.splice(a, 2, merged);
    parent.sizes.splice(a, 2, size);
    parent.sizes = normalizeSizes(parent.sizes, parent.children.length);
    root = collapse(root);
  }
  return floorWidths(root, width, null, min);
}

/** 分割の境界を動かしたときに「手で大きさを変えた」ことになるコンポーネント（境界の両側のすべて）。 */
export function resizedKeys(node: LayoutNode | undefined, index: number): string[] {
  if (!node || node.kind !== 'split') return [];
  return [...keysOf(node.children[index] ?? null), ...keysOf(node.children[index + 1] ?? null)];
}
