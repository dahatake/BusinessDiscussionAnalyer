// ワークスペースのレイアウトの純粋なモデル（FR-013/FR-014/FR-109/FR-110）。
// React に依存しない。レイアウトは「分割（横/縦）」と「タブのまとまり」の木で、木にないコンポーネントは非表示（ドックに出る）。
export type Dir = 'row' | 'col';
export type Move = 'up' | 'down' | 'left' | 'right';

export interface SplitNode { kind: 'split'; dir: Dir; sizes: number[]; children: LayoutNode[] }
export interface TabsNode { kind: 'tabs'; tabs: string[]; active: string }
export type LayoutNode = SplitNode | TabsNode;
/** 木が空（全部非表示）のときは null */
export type Layout = LayoutNode | null;
export type Path = number[];

export const MIN_SIZE = 0.1;

export const leaf = (key: string): TabsNode => ({ kind: 'tabs', tabs: [key], active: key });

export function normalizeSizes(sizes: number[], n: number): number[] {
  const base = sizes.length === n && sizes.every((s) => Number.isFinite(s) && s > 0) ? sizes : Array.from({ length: n }, () => 1);
  const sum = base.reduce((a, b) => a + b, 0);
  return base.map((s) => s / sum);
}

export const split = (dir: Dir, children: LayoutNode[], sizes?: number[]): SplitNode => ({
  kind: 'split', dir, children, sizes: normalizeSizes(sizes ?? children.map(() => 1), children.length),
});

export const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export function keysOf(node: Layout): string[] {
  if (!node) return [];
  if (node.kind === 'tabs') return [...node.tabs];
  return node.children.flatMap((c) => keysOf(c));
}

/** 使えるコンポーネントだけに絞り、空の枝と 1 つだけの分割を畳む。重複キーは先のものだけ残す。 */
export function prune(node: Layout, available: ReadonlySet<string>): Layout {
  const seen = new Set<string>();
  const walk = (n: LayoutNode): LayoutNode | null => {
    if (n.kind === 'tabs') {
      const tabs = n.tabs.filter((k) => available.has(k) && !seen.has(k));
      tabs.forEach((k) => seen.add(k));
      if (tabs.length === 0) return null;
      return { kind: 'tabs', tabs, active: tabs.includes(n.active) ? n.active : tabs[0]! };
    }
    const kept: Array<{ n: LayoutNode; s: number }> = [];
    n.children.forEach((c, i) => {
      const r = walk(c);
      if (r) kept.push({ n: r, s: n.sizes[i] ?? 1 });
    });
    if (kept.length === 0) return null;
    if (kept.length === 1) return kept[0]!.n;
    return { kind: 'split', dir: n.dir, children: kept.map((k) => k.n), sizes: normalizeSizes(kept.map((k) => k.s), kept.length) };
  };
  return node ? walk(node) : null;
}

/** 木の検証（localStorage の壊れた値を捨てるため）。 */
export function isLayout(v: unknown): v is Layout {
  if (v === null) return true;
  const ok = (n: any): boolean => {
    if (!n || typeof n !== 'object') return false;
    if (n.kind === 'tabs') return Array.isArray(n.tabs) && n.tabs.length > 0 && n.tabs.every((t: unknown) => typeof t === 'string') && typeof n.active === 'string';
    if (n.kind === 'split') {
      return (n.dir === 'row' || n.dir === 'col') && Array.isArray(n.children) && n.children.length > 0
        && Array.isArray(n.sizes) && n.sizes.length === n.children.length && n.sizes.every((s: unknown) => typeof s === 'number') && n.children.every(ok);
    }
    return false;
  };
  return ok(v);
}

function findTabs(node: LayoutNode, key: string, path: Path = []): { path: Path; node: TabsNode } | null {
  if (node.kind === 'tabs') return node.tabs.includes(key) ? { path, node } : null;
  for (let i = 0; i < node.children.length; i++) {
    const r = findTabs(node.children[i]!, key, [...path, i]);
    if (r) return r;
  }
  return null;
}

export function getAt(root: LayoutNode, path: Path): LayoutNode {
  return path.reduce<LayoutNode>((n, i) => (n as SplitNode).children[i]!, root);
}

/** 木を複製して `fn` で書き換える（元は変えない）。 */
function edit(layout: Layout, fn: (root: LayoutNode) => Layout): Layout {
  return layout ? fn(clone(layout)) : null;
}

export function isVisible(layout: Layout, key: string): boolean {
  return keysOf(layout).includes(key);
}

/** 非表示にする（FR-013）。 */
export function hide(layout: Layout, key: string): Layout {
  return prune(layout, new Set(keysOf(layout).filter((k) => k !== key)));
}

/** 前面にするタブを選ぶ。 */
export function activate(layout: Layout, key: string): Layout {
  return edit(layout, (root) => {
    const f = findTabs(root, key);
    if (f) f.node.active = key;
    return root;
  });
}

/** 再表示する（FR-014）。横の分割の末尾に足す。すでに表示中ならそのタブを前面にする。 */
/** 画面を新しく表示するときに、全体に対して取る幅の割合。載せていない画面は既定（横に並ぶ分割へ足すとき 0.25、そうでなければ 0.3）。描く面のように広さがほしい画面は大きくする。 */
export const SHOW_SHARE: Readonly<Record<string, number>> = { whiteboard: 0.5 };
/** 横一列の列数がこれを超えたら、各列に平均の COLUMN_FLOOR 倍の幅を最低限残す */
const MANY_COLUMNS = 6;
const COLUMN_FLOOR = 0.8;

export function show(layout: Layout, key: string): Layout {
  if (!layout) return leaf(key);
  if (isVisible(layout, key)) return activate(layout, key);
  const share = SHOW_SHARE[key];
  if (layout.kind === 'split' && layout.dir === 'row') {
    const n = layout.children.length;
    const s = share ?? 0.25;
    // 列が増えても、先にあった列が見えない幅まで縮まないよう、1 列あたりの下限を設ける（NFR-LEGAL-002 AC-180: 多くの画面を開いたあとでも各画面を操作できる）
    const floor = n + 1 > MANY_COLUMNS ? COLUMN_FLOOR / (n + 1) : 0;
    return {
      kind: 'split', dir: 'row', children: [...clone(layout.children), leaf(key)],
      sizes: normalizeSizes([...layout.sizes.map((x) => Math.max(x * (1 - s), floor)), s], n + 1),
    };
  }
  const s = share ?? 0.3;
  return split('row', [clone(layout), leaf(key)], [1 - s, s]);
}

function removeNode(root: LayoutNode, target: LayoutNode): Layout {
  const walk = (n: LayoutNode): LayoutNode | null => {
    if (n === target) return null;
    if (n.kind === 'tabs') return n;
    const kids: LayoutNode[] = [];
    const sizes: number[] = [];
    n.children.forEach((c, i) => { const r = walk(c); if (r) { kids.push(r); sizes.push(n.sizes[i] ?? 1); } });
    if (kids.length === 0) return null;
    if (kids.length === 1) return kids[0]!;
    return { kind: 'split', dir: n.dir, children: kids, sizes: normalizeSizes(sizes, kids.length) };
  };
  return walk(root);
}

/** 位置の移動（FR-109）。同じ向きの分割の中で隣と入れ替える。動かせないときは、その向きの外側の端へ置き直す。 */
export function move(layout: Layout, key: string, dir: Move): Layout {
  return edit(layout, (root) => {
    const f = findTabs(root, key);
    if (!f) return root;
    const axis: Dir = dir === 'up' || dir === 'down' ? 'col' : 'row';
    const delta = dir === 'up' || dir === 'left' ? -1 : 1;
    for (let depth = f.path.length - 1; depth >= 0; depth--) {
      const parent = getAt(root, f.path.slice(0, depth)) as SplitNode;
      const idx = f.path[depth]!;
      const to = idx + delta;
      if (parent.dir !== axis || to < 0 || to >= parent.children.length) continue;
      [parent.children[idx], parent.children[to]] = [parent.children[to]!, parent.children[idx]!];
      [parent.sizes[idx], parent.sizes[to]] = [parent.sizes[to]!, parent.sizes[idx]!];
      return root;
    }
    if (root === f.node) return root;
    const moved: TabsNode = { kind: 'tabs', tabs: [...f.node.tabs], active: f.node.active };
    const rest = removeNode(root, f.node);
    if (!rest) return root;
    return split(axis, delta < 0 ? [moved, rest] : [rest, moved], delta < 0 ? [0.3, 0.7] : [0.7, 0.3]);
  });
}

export type DropZone = 'left' | 'right' | 'top' | 'bottom' | 'tabs';

/** `a` と `b` を含む子が初めて分かれる分割の位置と、その手前の子の番号（境界を動かす対象）。 */
export function splitBetween(layout: Layout, a: string, b: string): { path: Path; index: number } | null {
  if (!layout) return null;
  let node: LayoutNode = layout;
  const path: Path = [];
  for (;;) {
    if (node.kind !== 'split') return null;
    const ia = node.children.findIndex((c) => keysOf(c).includes(a));
    const ib = node.children.findIndex((c) => keysOf(c).includes(b));
    if (ia < 0 || ib < 0) return null;
    if (ia === ib) { path.push(ia); node = node.children[ia]!; continue; }
    return { path: [...path], index: Math.min(ia, ib) };
  }
}

/**
 * ドラッグでの移動（FR-142）。`key` を `target` の上下左右に置く。`tabs` なら `target` のタブにまとめる。
 * どのコンポーネントも、どこへでも動かせる。移動できない組み合わせ（自分自身・存在しない）は、木を変えない。
 */
export function dropAt(layout: Layout, key: string, target: string, zone: DropZone): Layout {
  if (!layout || key === target) return layout;
  if (zone === 'tabs') return mergeIntoTabs(layout, key, target);
  if (!isVisible(layout, key) || !isVisible(layout, target)) return layout;
  const root = clone(layout);
  const src = findTabs(root, key)!;
  let rest: Layout;
  if (src.node.tabs.length > 1) {
    src.node.tabs = src.node.tabs.filter((k) => k !== key);
    if (!src.node.tabs.includes(src.node.active)) src.node.active = src.node.tabs[0]!;
    rest = root;
  } else {
    rest = removeNode(root, src.node);
  }
  if (!rest) return layout;
  const dst = findTabs(rest, target);
  if (!dst) return layout;
  const dir: Dir = zone === 'left' || zone === 'right' ? 'row' : 'col';
  const before = zone === 'left' || zone === 'top';
  const moved = leaf(key);
  if (dst.path.length > 0) {
    const parent = getAt(rest, dst.path.slice(0, -1)) as SplitNode;
    if (parent.dir === dir) {
      // 同じ向きの分割には、並べて足す（入れ子を増やさない）
      const i = dst.path[dst.path.length - 1]!;
      const s = parent.sizes[i]!;
      parent.children.splice(before ? i : i + 1, 0, moved);
      parent.sizes.splice(i, 1, s / 2, s / 2);
      parent.sizes = normalizeSizes(parent.sizes, parent.children.length);
      return rest;
    }
    const pair = split(dir, before ? [moved, dst.node] : [dst.node, moved], [0.5, 0.5]);
    parent.children[dst.path[dst.path.length - 1]!] = pair;
    return rest;
  }
  return split(dir, before ? [moved, rest] : [rest, moved], before ? [0.4, 0.6] : [0.6, 0.4]);
}

/** 並べる方向（横/縦）を、そのコンポーネントを含む分割で入れ替える（FR-109）。 */
export function toggleDirection(layout: Layout, key: string): Layout {
  return edit(layout, (root) => {
    const f = findTabs(root, key);
    if (!f || f.path.length === 0) return root;
    const parent = getAt(root, f.path.slice(0, -1)) as SplitNode;
    parent.dir = parent.dir === 'row' ? 'col' : 'row';
    return root;
  });
}

/** `key` を `target` のタブにまとめる（FR-109）。 */
export function mergeIntoTabs(layout: Layout, key: string, target: string): Layout {
  if (key === target) return layout;
  return edit(layout, (root) => {
    const src = findTabs(root, key);
    const dst = findTabs(root, target);
    if (!src || !dst || src.node === dst.node) return root;
    src.node.tabs = src.node.tabs.filter((k) => k !== key);
    if (src.node.tabs.length > 0 && !src.node.tabs.includes(src.node.active)) src.node.active = src.node.tabs[0]!;
    dst.node.tabs.push(key);
    dst.node.active = key;
    return prune(root, new Set(keysOf(root))) ?? root;
  });
}

/** タブから出して、隣に並べる。 */
export function splitFromTabs(layout: Layout, key: string): Layout {
  return edit(layout, (root) => {
    const f = findTabs(root, key);
    if (!f || f.node.tabs.length < 2) return root;
    f.node.tabs = f.node.tabs.filter((k) => k !== key);
    if (!f.node.tabs.includes(f.node.active)) f.node.active = f.node.tabs[0]!;
    const rest: TabsNode = { kind: 'tabs', tabs: [...f.node.tabs], active: f.node.active };
    const pair = split('row', [rest, leaf(key)], [0.5, 0.5]);
    if (f.path.length === 0) return pair;
    const parent = getAt(root, f.path.slice(0, -1)) as SplitNode;
    parent.children[f.path[f.path.length - 1]!] = pair;
    return root;
  });
}

/** 分割の境界を動かす（FR-109）。`path` は分割ノードの位置、`index` は境界の手前の子の番号、`delta` は比率。 */
export function resize(layout: Layout, path: Path, index: number, delta: number): Layout {
  return edit(layout, (root) => {
    const node = getAt(root, path);
    if (node.kind !== 'split' || index < 0 || index >= node.children.length - 1) return root;
    const a = node.sizes[index]!;
    const b = node.sizes[index + 1]!;
    const total = a + b;
    const na = Math.min(total - MIN_SIZE, Math.max(MIN_SIZE, a + delta));
    node.sizes[index] = na;
    node.sizes[index + 1] = total - na;
    return root;
  });
}

export const PERSONAS = ['経営層', '事業部門', 'IT', '現場'] as const;
export type Persona = (typeof PERSONAS)[number];
export const DEFAULT_PERSONA: Persona = '経営層';

/** 1 つの行に並べる詳細の数の上限。超えた分は次の行に並べる（最小の幅 PARAM-034 を守るため。補助は 1 つの列に縦に並べる） */
export const MAX_DETAIL = 3;
/** 主役が占める幅の割合（主役の行の中）と、主役の行が占める高さの割合 */
const PRIMARY_WIDTH = 0.62;
const TOP_HEIGHT = 0.7;
/** 全体が少ないとき（主役 + 残り）の形に使う全体の数の上限と、主役と詳細だけのとき主役が占める高さの割合（FR-296） */
const COMPACT_MAX = 4;
const COMPACT_PRIMARY_HEIGHT = 0.55;

/** 描く面のように、広さがほしい画面（同じ列の中の高さ・同じ行の中の幅の比に使う重み。載せていない画面は 1。SHOW_SHARE と同じ考え方）。重みが 1 より大きい補助は、主役の右に専用の列を持つ */
export const STACK_WEIGHT: Readonly<Record<string, number>> = { whiteboard: 3 };

function stack(keys: readonly string[], dir: Dir): LayoutNode {
  if (keys.length === 1) return leaf(keys[0]!);
  return split(dir, keys.map((k) => leaf(k)), keys.map((k) => STACK_WEIGHT[k] ?? 1));
}

/** 詳細: 1 行に MAX_DETAIL 個まで並べ、超えたら次の行へ（タブにまとめない。タブにすると、狭い幅で見出し・操作が欠けて見えるため） */
function detailRows(keys: readonly string[]): LayoutNode {
  const rows: LayoutNode[] = [];
  for (let i = 0; i < keys.length; i += MAX_DETAIL) rows.push(stack(keys.slice(i, i + MAX_DETAIL), 'row'));
  return rows.length === 1 ? rows[0]! : split('col', rows);
}

/**
 * 階層（主役→補助→詳細）の配置の木（FR-243・FR-244）。読む順序（左上から右下、主役が先）で、主役を最大の領域の左上に、補助を主役の右の列に、詳細を下の行に置く。
 * 広さがほしい補助（STACK_WEIGHT が 1 より大きいもの）は、主役のすぐ右に専用の列を持ち、残りの補助はその右の列に縦に並べる。
 * ペルソナの既定のレイアウト（§7）と、自動配置（autoLayout.autoTree）が同じ形を使う。
 */
export function tierTree(primary: string, supporting: readonly string[], detail: readonly string[]): LayoutNode {
  // 全体が 4 つ以内で詳細を含むときは、主役を左の列の全体（最大の領域）に置き、残りを右の列に縦に並べる（FR-296: 各コンポーネントが最小の幅・高さ以上で読める。
  // 主役の右の列に積むので、必要な高さは 残りの数 × PARAM-135）。残りが 1 つ（主役と詳細だけ）のときは、主役の下に置く
  if (detail.length > 0 && 1 + supporting.length + detail.length <= COMPACT_MAX && [...supporting, ...detail].every((k) => (STACK_WEIGHT[k] ?? 1) <= 1)) {
    const others = [...supporting, ...detail];
    if (others.length === 1) return split('col', [leaf(primary), leaf(others[0]!)], [COMPACT_PRIMARY_HEIGHT, 1 - COMPACT_PRIMARY_HEIGHT]);
    if (others.length === 2) return split('row', [leaf(primary), split('col', others.map((k) => leaf(k)))], [PRIMARY_WIDTH, 1 - PRIMARY_WIDTH]);
    // 4 つ: 2 列 × 2 行。左の列に主役とその下の詳細、右の列に補助（足りなければ残りの詳細）を縦に置く。主役は左上で最大の領域のまま
    const left = split('col', [leaf(primary), leaf(detail[0]!)], [COMPACT_PRIMARY_HEIGHT, 1 - COMPACT_PRIMARY_HEIGHT]);
    const right = [...supporting, ...detail.slice(1)];
    return split('row', [left, split('col', right.map((k) => leaf(k)))], [PRIMARY_WIDTH, 1 - PRIMARY_WIDTH]);
  }
  const wide = supporting.filter((k) => (STACK_WEIGHT[k] ?? 1) > 1);
  const rest = supporting.filter((k) => !wide.includes(k));
  let top: LayoutNode;
  if (supporting.length === 0) top = leaf(primary);
  else if (wide.length === 0) top = split('row', [leaf(primary), stack(rest, 'col')], [PRIMARY_WIDTH, 1 - PRIMARY_WIDTH]);
  else {
    const cols: LayoutNode[] = [leaf(primary), ...wide.map((k) => leaf(k))];
    const wideShare = rest.length > 0 ? 0.3 : 0.45 / wide.length;
    const sizes = [rest.length > 0 ? 0.45 : 0.55, ...wide.map(() => wideShare)];
    if (rest.length > 0) { cols.push(stack(rest, 'col')); sizes.push(0.25); }
    top = split('row', cols, sizes);
  }
  if (detail.length === 0) return top;
  return split('col', [top, detailRows(detail)], [TOP_HEIGHT, 1 - TOP_HEIGHT]);
}

/** ペルソナ別の既定のレイアウト（要求定義書 §7）。情報の階層（FR-244）の配置と同じ形: 主役が左上で最大、補助が右、詳細が下。 */
export function defaultLayout(persona: Persona): Layout {
  // 同時に表示するコンポーネントは MAX_DEFAULT_VISIBLE（PARAM-136）個以内。収まらない分は最小化して一覧（FR-295）に残す（FR-296・FR-112 の改訂）
  switch (persona) {
    case '経営層': // 主領域に 2×2 マトリクス、右にサマリーと KPI/OKR（FR-154 AC-273）、主領域の下にランキング表（2 列 × 2 行。FR-296）
      return tierTree('matrix', ['summary', 'kpi-okr'], ['ranking']);
    case '事業部門': // 主領域に課題-解決策分析、右に議論ツリー、下にガントと一覧表（A-30。KPI/OKR は最小化して一覧に残す。FR-110 AC-135: リセット後も絞り込みの入力欄が残る）
      return tierTree('issue-solution', ['discussion-tree'], ['gantt', 'table']);
    case 'IT': // 主領域にアーキテクチャ図、右にナレッジグラフ、下に製品の一覧（KPI/OKR は、構成が少ないときの補いで加わる）
      return tierTree('architecture', ['knowledge-graph'], ['products']);
    case '現場': // 主領域に Twin ビュー（3D デジタルツイン。Q-062 A）、右に KPI/OKR、下にガント
      return tierTree('twin-view', ['kpi-okr'], ['gantt']);
  }
}

/**
 * 既定のレイアウトに登録済みの画面が 1 つも残らないときの退避（後続の画面が揃うまでの暫定）。
 * 登録済みのキーを 1 つのタブのまとまりに並べ、先頭を前面にする（登録が増えて §7 の既定が残れば、そちらが優先される）。
 * 全部を同時に分割して見せると、3D など常時動く画面が他の画面の表示を書き換え続けるため、タブにする。
 */
export function arrangeAll(keys: readonly string[]): Layout {
  const uniq = [...new Set(keys)];
  if (uniq.length === 0) return null;
  return { kind: 'tabs', tabs: uniq, active: uniq[0]! };
}
