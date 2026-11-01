// 情報の階層に基づく自動配置（FR-243）と、役割による分類・階層（FR-244）の単体・結合テスト。
// FR-243 AC-585 AC-586 / FR-244 AC-588 AC-589
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { keysOf } from '../../src/workspace/layoutModel';
import { MAX_DETAIL, autoTree, treeRects } from '../../src/workspace/autoLayout';
import { classify, groupOf, orderByGroup, roleOf, TIER_LABEL } from '../../src/workspace/tiers';
import { overlapArea, resolveAround, type PxMap } from '../../src/workspace/freeLayout';

class MemoryStorage {
  private m = new Map<string, string>();
  get length() { return this.m.size; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}
const ALL = ['summary', 'matrix', 'ranking', 'issue-solution', 'discussion-tree', 'gantt', 'architecture', 'knowledge-graph', 'products', 'map', 'twin-view', 'table', 'kpi-okr'];

async function freshStore(saved?: unknown) {
  vi.resetModules();
  const storage = new MemoryStorage();
  if (saved !== undefined) storage.setItem('edb.layout', JSON.stringify(saved));
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('window', { localStorage: storage });
  const mod = await import('../../src/store/layout');
  mod.setAvailableComponents(ALL);
  return { ...mod, storage };
}
beforeEach(() => { vi.unstubAllGlobals(); });

const BOUNDS = { w: 1300, h: 760 };

describe('FR-243 AC-584 / FR-244 情報の階層に基づく配置の純粋な規則', () => {
  // FR-243 AC-584（階層ごとの配置: 主役が最大・補助は右・詳細は下・同じ入力は同じ配置）
  it('FR-243 AC-584 主役が最大の領域で、補助が右、詳細が下に置かれ、重ならず、同じ入力は同じ配置になる', () => {
    const keys = ['issue-solution', 'discussion-tree', 'gantt', 'table', 'kpi-okr'];
    const info = classify('事業部門', keys);
    const a = treeRects(autoTree(keys, info), BOUNDS);
    const b = treeRects(autoTree(keys, info), BOUNDS);
    expect(a).toEqual(b);
    const area = (r: { w: number; h: number }) => r.w * r.h;
    for (const k of keys) if (k !== 'issue-solution') expect(area(a['issue-solution']!)).toBeGreaterThan(area(a[k]!));
    expect(a['discussion-tree']!.x).toBeGreaterThanOrEqual(a['issue-solution']!.x + a['issue-solution']!.w - 1);
    expect(a['gantt']!.y).toBeGreaterThanOrEqual(a['issue-solution']!.y + a['issue-solution']!.h - 1);
    for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) expect(overlapArea(a[keys[i]!]!, a[keys[j]!]!)).toBeLessThanOrEqual(1);
  });

  // FR-243 AC-584（上限を超える詳細は次の行へ。タブにまとめない。最小の幅を守る）
  it('FR-243 AC-584 詳細が 1 行の上限を超えるときは次の行に並べ、タブにまとめず、すべてを配置する', () => {
    const keys = ['matrix', 'a1', 'a2', 'a3', 'a4', 'a5', 'gantt', 'table', 'products', 'canvas'];
    const info = classify('経営層', keys, { gantt: 'detail', table: 'detail', products: 'detail', canvas: 'detail' });
    const tree = autoTree(keys, info);
    expect(keysOf(tree).sort()).toEqual([...keys].sort());
    let tabs = 0;
    const walk = (n: NonNullable<typeof tree>): void => { if (n.kind === 'tabs') { if (n.tabs.length > 1) tabs++; } else n.children.forEach(walk); };
    walk(tree!);
    expect(tabs).toBe(0);
    expect(MAX_DETAIL).toBe(3);
    const rects = treeRects(tree, BOUNDS);
    for (const k of keys) expect(rects[k]!.w, `${k} の幅`).toBeGreaterThanOrEqual(240);
  });

  // FR-244 AC-588（同じ階層で同じ対象のものは隣り合う）
  it('FR-244 AC-588 同じ階層で同じ対象（同じ工程の表とガント）は隣り合わせに並ぶ', () => {
    const order = orderByGroup(['gantt', 'kpi-okr', 'table', 'canvas', 'ranking']);
    expect(Math.abs(order.indexOf('gantt') - order.indexOf('table'))).toBe(1);
    expect(groupOf('gantt')).toBe(groupOf('table'));
    const keys = ['issue-solution', 'discussion-tree', 'gantt', 'kpi-okr', 'table'];
    const rects = treeRects(autoTree(keys, classify('事業部門', keys)), BOUNDS);
    const g = rects['gantt']!, t = rects['table']!;
    const bb = { x: Math.min(g.x, t.x), y: Math.min(g.y, t.y), w: Math.max(g.x + g.w, t.x + t.w) - Math.min(g.x, t.x), h: Math.max(g.y + g.h, t.y + t.h) - Math.min(g.y, t.y) };
    for (const k of keys) if (k !== 'gantt' && k !== 'table') expect(overlapArea(bb, rects[k]!)).toBeLessThanOrEqual(1);
  });

  // FR-244 AC-589（未分類は補助。階層は文字でも示す。理由つき）
  it('FR-244 AC-589 役割のない（未分類の）コンポーネントは「補助」で、階層は文字の名前を持ち、理由が付く', () => {
    expect(roleOf('unknown-screen')).toBeUndefined();
    const info = classify('経営層', ['matrix', 'unknown-screen']);
    expect(info['unknown-screen']!.tier).toBe('supporting');
    expect(info['unknown-screen']!.reason).toContain('補助');
    expect(info['unknown-screen']!.reason).toContain('未分類');
    expect(info['matrix']!.tier).toBe('primary');
    expect(info['matrix']!.reason).toContain('主役');
    expect(Object.values(TIER_LABEL)).toEqual(['主役', '補助', '詳細']);
  });

  // FR-244 AC-587（主役はちょうど 1 つ。利用者が変えると入れ替わる）
  it('FR-244 AC-588 階層を変えると主役はちょうど 1 つのまま入れ替わる', () => {
    const keys = ['issue-solution', 'discussion-tree', 'gantt'];
    const swapped = classify('事業部門', keys, { 'discussion-tree': 'primary' });
    expect(Object.values(swapped).filter((i) => i.tier === 'primary').length).toBe(1);
    expect(swapped['discussion-tree']!.tier).toBe('primary');
    expect(swapped['issue-solution']!.tier).not.toBe('primary');
    expect(classify('事業部門', keys, { gantt: 'supporting' })['gantt']!.tier).toBe('supporting');
  });

  // FR-243 AC-585（ピン止め・手で動かしたものは動かさず、新しいものが重ならない）
  it('FR-243 AC-585 固定したもの A・B の位置・大きさは変わらず、追加したものは重ならない位置に置かれる', () => {
    const rects: PxMap = { a: { x: 100, y: 100, w: 400, h: 300 }, b: { x: 600, y: 100, w: 400, h: 300 }, n: { x: 150, y: 150, w: 400, h: 300 } };
    const out = resolveAround(rects, 'n', BOUNDS, new Set(['a', 'b']))!;
    expect(out['a']).toEqual(rects['a']);
    expect(out['b']).toEqual(rects['b']);
    expect(overlapArea(out['n']!, out['a']!)).toBeLessThanOrEqual(1);
    expect(overlapArea(out['n']!, out['b']!)).toBeLessThanOrEqual(1);
  });
});

describe('FR-243 AC-585 AC-586 / FR-244 AC-588 AC-589 ストア', () => {
  // FR-243 AC-584 AC-586（既定のレイアウト（FR-112）は情報の階層の配置と同じ形。既定に戻すと既定の配置）
  it('FR-243 AC-586 保存済みのレイアウトがなければ階層に基づく配置（既定と同じ形）で、既定に戻すと FR-112 の既定の配置になる', async () => {
    const { useLayout, effectiveLayout, autoLayoutFor } = await freshStore();
    const { defaultLayout, PERSONAS, tierTree } = await import('../../src/workspace/layoutModel');
    const st = useLayout.getState();
    // FR-296: 既定の同時表示は 4 個以内。経営層は 3 個（§7 の表）なので、FR-243 AC-584 の最低 4 つは一覧表で補う
    const supplemented = tierTree('matrix', ['summary', 'ranking'], ['table']);
    expect(JSON.stringify(effectiveLayout(st))).toBe(JSON.stringify(supplemented));
    // FR-043 AC-054: 廃止後の現場既定は3画面。FR-243 AC-584の最低4画面は一覧表で補う。
    for (const p of PERSONAS) {
      const expected = p === '現場' ? tierTree('twin-view', ['kpi-okr'], ['gantt', 'table']) : p === '経営層' ? supplemented : p === 'IT' ? tierTree('architecture', ['knowledge-graph'], ['products', 'table']) : defaultLayout(p);
      expect(JSON.stringify(autoLayoutFor(p, undefined))).toBe(JSON.stringify(expected));
    }
    st.setTier('summary', 'detail');
    expect(JSON.stringify(effectiveLayout(useLayout.getState()))).not.toBe(JSON.stringify(supplemented));
    useLayout.getState().resetLayout();
    expect(useLayout.getState().layouts['経営層']).toBeUndefined();
    expect(JSON.stringify(effectiveLayout(useLayout.getState()))).toBe(JSON.stringify(supplemented));
  });

  // FR-243 AC-584（登録済みの画面が足りないペルソナは、4 つ以上になるよう補う）
  it('FR-243 AC-584 登録済みの画面が少なく 4 つに満たないペルソナは、一覧表で補って 4 つ以上を配置する', async () => {
    vi.resetModules();
    vi.stubGlobal('localStorage', new MemoryStorage());
    vi.stubGlobal('window', { localStorage: new MemoryStorage() });
    const mod = await import('../../src/store/layout');
    mod.setAvailableComponents(ALL.filter((k) => k !== 'products'));
    mod.useLayout.getState().setPersona('IT');
    const keys = keysOf(mod.effectiveLayout(mod.useLayout.getState()));
    expect(keys.length).toBeGreaterThanOrEqual(4);
    expect(keys).toContain('table');
  });

  // FR-243 AC-586（停止・実行・取消）
  it('FR-243 AC-586 自動配置の実行・停止・取消ができ、取消で実行前の状態に戻る', async () => {
    const { useLayout, effectiveLayout } = await freshStore();
    const st = () => useLayout.getState();
    st().setPersona('事業部門');
    st().hideComponent('gantt');
    st().setAutoOff(true);
    expect(st().autoOff['事業部門']).toBe(true);
    // 停止中は、再表示しても配置全体を組み直さない（既存の配置に足すだけ）
    st().showComponent('gantt');
    expect(keysOf(effectiveLayout(st()))).toContain('gantt');
    // 実行して取り消す
    st().saveAutoUndo();
    const stoppedLayout = JSON.stringify(effectiveLayout(st()));
    st().runAutoTree();
    expect(st().autoOff['事業部門']).toBeUndefined();
    expect(JSON.stringify(effectiveLayout(st()))).not.toBe(stoppedLayout);
    expect(st().undoAuto()).toBe(true);
    expect(JSON.stringify(effectiveLayout(st()))).toBe(stoppedLayout);
    expect(st().autoOff['事業部門']).toBe(true);
    expect(st().undoAuto()).toBe(false);
  });

  // FR-243 AC-585（手で動かした・ピン止めがあるときは、再表示で配置全体を組み直さない）
  it('FR-243 AC-585 手で動かしたものがあるときは、追加しても自由配置の位置・大きさを書き換えない', async () => {
    const { useLayout } = await freshStore();
    const st = () => useLayout.getState();
    st().setPersona('事業部門');
    st().hideComponent('gantt');
    st().setFloats({ 'issue-solution': { x: 0.1, y: 0.1, w: 0.4, h: 0.4 } });
    st().markMoved('issue-solution');
    st().setPinned('table', { x: 0.6, y: 0.1, w: 0.3, h: 0.3 });
    st().showComponent('gantt');
    expect(st().floats['事業部門']!['issue-solution']).toEqual({ x: 0.1, y: 0.1, w: 0.4, h: 0.4 });
    expect(st().pinned['事業部門']!['table']).toEqual({ x: 0.6, y: 0.1, w: 0.3, h: 0.3 });
    expect(st().moved['事業部門']).toContain('issue-solution');
  });

  // FR-244 AC-588（階層の変更が保存され、再読込で保たれる。既定に戻すと既定の階層）
  it('FR-244 AC-588 階層の変更はレイアウトとして保存され、再読込で保たれ、既定に戻すと既定の階層になる', async () => {
    const { useLayout, storage } = await freshStore();
    useLayout.getState().setPersona('事業部門');
    useLayout.getState().setTier('gantt', 'primary');
    expect(useLayout.getState().tiers['事業部門']).toEqual({ gantt: 'primary' });
    const saved = JSON.parse(storage.getItem('edb.layout')!).state;
    const again = await freshStore({ state: saved, version: 1 });
    expect(again.useLayout.getState().tiers['事業部門']).toEqual({ gantt: 'primary' });
    again.useLayout.getState().resetLayout();
    expect(again.useLayout.getState().tiers['事業部門']).toBeUndefined();
  });

  // FR-244 AC-589（壊れた保存値は捨てる）
  it('FR-244 AC-589 階層の保存値のうち、不正な階層は読み込まない', async () => {
    const { useLayout } = await freshStore({ state: { persona: '経営層', tiers: { 経営層: { matrix: 'bogus', summary: 'detail' } } }, version: 1 });
    expect(useLayout.getState().tiers['経営層']).toEqual({ summary: 'detail' });
  });
});
