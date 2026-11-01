// FR-296 複数ウィンドウの既定の構成と最小サイズ（PARAM-134 = 360px・PARAM-135 = 240px・PARAM-136 = 4 個）の単体・結合テスト
// AC-800（既定のレイアウトの同時表示数と大きさ）、AC-801（操作・再表示でも下限を割らない。領域が足りなければ最も長く使っていないものを最小化）
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PERSONAS, defaultLayout, keysOf, resize, show, split, leaf, type Layout, type SplitNode } from '../../src/workspace/layoutModel';
import {
  MAX_DEFAULT_VISIBLE, MIN_WINDOW_H, MIN_WINDOW_W, enforceMin, fitsWidth, floorFloat, leafSizes, makeRoom, needHeight, needWidth,
} from '../../src/workspace/windowLimits';
import { windowStates, shownCount } from '../../src/workspace/windowStates';

const W = 1060; // 標準の検証条件（1280x800）の作業領域の幅

class MemoryStorage {
  private m = new Map<string, string>();
  get length() { return this.m.size; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}
const ALL = ['summary', 'matrix', 'ranking', 'issue-solution', 'discussion-tree', 'gantt', 'architecture', 'knowledge-graph', 'products', 'twin-view', 'table', 'kpi-okr', 'priority', 'whiteboard'];
async function freshStore() {
  vi.resetModules();
  const storage = new MemoryStorage();
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('window', { localStorage: storage });
  const mod = await import('../../src/store/layout');
  mod.setAvailableComponents(ALL);
  return mod;
}
beforeEach(() => { vi.unstubAllGlobals(); });

describe('FR-296 AC-800 既定のレイアウト', () => {
  // FR-296 AC-800
  it('FR-296 AC-800 どのペルソナの既定も、同時表示は 4 個以内で、各コンポーネントが 360x240 以上になる', () => {
    expect(MAX_DEFAULT_VISIBLE).toBe(4);
    for (const p of PERSONAS) {
      const l = defaultLayout(p);
      expect(keysOf(l).length, `${p}: 同時表示の数`).toBeLessThanOrEqual(MAX_DEFAULT_VISIBLE);
      // 幅は作業領域 1060px で、高さは木が必要とする高さ（足りなければ作業領域が伸びて読める大きさを保つ）
      const sized = enforceMin(l, W, needHeight(l!));
      for (const leafSize of leafSizes(sized, W, needHeight(l!))) {
        expect(leafSize.w, `${p}/${leafSize.keys[0]}: 幅`).toBeGreaterThanOrEqual(MIN_WINDOW_W - 1);
        expect(leafSize.h, `${p}/${leafSize.keys[0]}: 高さ`).toBeGreaterThanOrEqual(MIN_WINDOW_H - 1);
      }
    }
  });

  // FR-296 AC-800（FR-112 の改訂: 経営層 4・事業部門 4・IT 3。主役は変わらず最大。FR-154 AC-273: 経営層は KPI/OKR を含む）
  it('FR-296 AC-800 経営層 4・事業部門 4・IT 3 個で、主役は左上の最大の領域のまま', () => {
    expect(keysOf(defaultLayout('経営層')).sort()).toEqual(['kpi-okr', 'matrix', 'ranking', 'summary']);
    expect(keysOf(defaultLayout('経営層'))[0]).toBe('matrix');
    expect(keysOf(defaultLayout('事業部門')).sort()).toEqual(['discussion-tree', 'gantt', 'issue-solution', 'table']);
    expect(keysOf(defaultLayout('IT')).length).toBe(3);
    expect(keysOf(defaultLayout('IT'))[0]).toBe('architecture');
  });

  // FR-296 AC-800 異常系: 幅 4 個分（3 列以上）は 1060px に収まらない
  it('FR-296 AC-800 3 列は作業領域 1060px に収まらず、2 列は収まる', () => {
    expect(fitsWidth(split('row', [leaf('a'), leaf('b'), leaf('c')]), W)).toBe(false);
    expect(fitsWidth(split('row', [leaf('a'), leaf('b')]), W)).toBe(true);
    expect(needWidth(split('row', [leaf('a'), leaf('b')]))).toBe(2 * MIN_WINDOW_W + 8);
  });
});

describe('FR-296 AC-801 操作しても下限を割らない', () => {
  // FR-296 AC-801（境界のドラッグ・キーで縮める）
  it('FR-296 AC-801 境界を大きく動かしても、描くときの各コンポーネントの幅は 360px 以上', () => {
    const base = defaultLayout('事業部門');
    const dragged = resize(base, [], 0, 0.3) as Layout; // 右の列を 0.08 まで縮める操作
    const sized = enforceMin(dragged, W, needHeight(dragged!));
    for (const leafSize of leafSizes(sized, W, needHeight(dragged!))) expect(leafSize.w).toBeGreaterThanOrEqual(MIN_WINDOW_W - 1);
    // 下限を満たしている木は変えない（余計な調整をしない）
    expect(enforceMin(base, W, 700)).toEqual(base);
  });

  // FR-296 AC-801 異常系: 領域が最小の幅より狭いとき
  it('FR-296 AC-801 領域が足りない軸は比率のまま（領域の幅いっぱいで表示）', () => {
    const base = split('row', [leaf('a'), leaf('b')], [0.7, 0.3]) as SplitNode;
    const narrow = enforceMin(base, 300, 500) as SplitNode;
    expect(narrow.sizes).toEqual(base.sizes);
  });

  // FR-296 AC-801（自由配置の保存値の補正）
  it('FR-296 AC-801 保存された小さい自由配置は、復元時に下限へ補正され、領域の外へ出ない', () => {
    const r = floorFloat({ x: 0.9, y: 0.9, w: 0.1, h: 0.1 }, 1000, 800);
    expect(r.w * 1000).toBeGreaterThanOrEqual(MIN_WINDOW_W);
    expect(r.h * 800).toBeGreaterThanOrEqual(MIN_WINDOW_H);
    expect(r.x + r.w).toBeLessThanOrEqual(1 + 1e-9);
    expect(r.y + r.h).toBeLessThanOrEqual(1 + 1e-9);
    // 領域が 360px より狭いときは領域いっぱい
    expect(floorFloat({ x: 0, y: 0, w: 0.5, h: 0.5 }, 300, 200).w).toBe(1);
  });

  // FR-296 AC-801（再表示で領域が足りなくなる）
  it('FR-296 AC-801 領域が足りなくなる再表示では、最も長く使っていない（ピン止めしていない）ものが外れ、いま見せたものは残る', () => {
    const two = split('row', [leaf('a'), leaf('b')]);
    const next = show(two, 'c');
    expect(fitsWidth(next, W)).toBe(false);
    const r = makeRoom(next, W, { protect: ['c'], pinned: new Set(['a']), usedAt: { a: 1, b: 5, c: 9 } });
    expect(r.dropped).toEqual(['b']); // a はピン止め、c はいま見せたもの
    expect(keysOf(r.layout).sort()).toEqual(['a', 'c']);
    expect(fitsWidth(r.layout, W)).toBe(true);
    // 最も長く使っていないもの
    const r2 = makeRoom(next, W, { protect: ['c'], usedAt: { a: 3, b: 5, c: 9 } });
    expect(r2.dropped).toEqual(['a']);
    // 全部がピン止め・見せたものなら、外せないので縮めない（そのまま）
    const r3 = makeRoom(next, W, { protect: ['c'], pinned: new Set(['a', 'b']) });
    expect(r3.dropped).toEqual([]);
    expect(keysOf(r3.layout).sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('FR-296 AC-800 AC-801 一覧（FR-295）の状態: 収まらないものは閉じず最小化', () => {
  // FR-296 AC-800
  it('FR-296 AC-800 木にないものは、閉じていなければ最小化として一覧に残り、前面は 1 つだけ', () => {
    const layout = defaultLayout('事業部門');
    const keys = ['issue-solution', 'discussion-tree', 'gantt', 'table', 'kpi-okr', 'priority'];
    const s = windowStates({ keys, layout, minimized: new Set(), closed: new Set(['priority']), usedAt: { gantt: 4, table: 2 } });
    expect(s['kpi-okr']).toBe('minimized');
    expect(s['priority']).toBe('closed');
    expect(Object.values(s).filter((x) => x === 'front')).toHaveLength(1);
    expect(s['gantt']).toBe('front');
    expect(shownCount(s)).toBe(4);
  });
});

describe('FR-296 AC-801 ストア: 再表示', () => {
  // FR-296 AC-801（結合: 作業領域 1060px で 4 個の既定に 5 つ目を再表示）
  it('FR-296 AC-801 5 つ目を表示すると、使っていないものが最小化され（閉じず）、表示は 2 列以内に収まる', async () => {
    const { useLayout, effectiveLayout, setWorkspaceArea } = await freshStore();
    setWorkspaceArea(W, 530);
    const st = () => useLayout.getState();
    st().setPersona('事業部門');
    st().touch('issue-solution');
    st().showComponent('priority');
    const l = effectiveLayout(st());
    expect(keysOf(l)).toContain('priority');
    expect(fitsWidth(l, W)).toBe(true);
    expect(keysOf(l).length).toBeLessThanOrEqual(MAX_DEFAULT_VISIBLE);
    expect(st().closed['事業部門'] ?? []).toEqual([]); // 閉じたのではなく最小化
  });

  // FR-296 AC-801（ピン止めしたものは外れない）
  it('FR-296 AC-801 ピン止めしたものは最小化されない', async () => {
    const { useLayout, effectiveLayout, setWorkspaceArea } = await freshStore();
    setWorkspaceArea(W, 530);
    const st = () => useLayout.getState();
    st().setPersona('事業部門');
    for (const k of ['discussion-tree', 'table', 'gantt']) st().setPinned(k, { x: 0, y: 0, w: 0.4, h: 0.4 });
    st().showComponent('priority');
    const keys = keysOf(effectiveLayout(st()));
    for (const k of ['discussion-tree', 'table', 'gantt']) expect(keys).toContain(k);
  });

  // FR-296 AC-801（自由配置の下限: 作業領域が分かるとき、小さい大きさは下限へ）
  it('FR-296 AC-801 自由配置の大きさは、作業領域の 360x240 以上へ補正される', async () => {
    const { useLayout, setWorkspaceArea } = await freshStore();
    setWorkspaceArea(1000, 800);
    useLayout.getState().setFloat('summary', { x: 0.5, y: 0.5, w: 0.1, h: 0.1 });
    const f = useLayout.getState().floats[useLayout.getState().persona]!['summary']!;
    expect(f.w * 1000).toBeGreaterThanOrEqual(MIN_WINDOW_W - 0.5);
    expect(f.h * 800).toBeGreaterThanOrEqual(MIN_WINDOW_H - 0.5);
  });
});
