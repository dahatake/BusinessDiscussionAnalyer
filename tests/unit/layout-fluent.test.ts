// FR-142（ドラッグでの移動）・FR-143（自動のサイズ調整）・NFR-UX-007（Fluent 2・最小の読みやすさ）の単体・結合テスト。
// FR-142 AC-225 / FR-143 AC-226 AC-227 AC-228 / NFR-UX-007 AC-233
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PERSONAS, arrangeAll, defaultLayout, dropAt, keysOf, type Layout, type DropZone } from '../../src/workspace/layoutModel';
import { FOCUS_SCALE, MIN_COMPONENT_WIDTH, applyAutoSize, fitMinWidth, leafShares } from '../../src/workspace/autosize';
import { PERSONA_PRIMARY } from '../../src/workspace/persona';
import { zoneOf } from '../../src/workspace/Workspace';

const share = (l: Layout, key: string) => leafShares(l).find((x) => x.node.tabs.includes(key))!.share;
const NONE = new Set<string>();

const registryKeys = [...readFileSync('src/screens/registry.ts', 'utf8').matchAll(/\{ key: '([^']+)'/g)].map((m) => m[1]!);

describe('FR-142 AC-225 すべてのコンポーネントが移動できる', () => {
  // FR-142 AC-225
  it('FR-142 AC-225 登録されたすべての画面が、どの相手のどの位置へも移動でき、移動で欠けも増えもしない', () => {
    expect(registryKeys.length).toBeGreaterThanOrEqual(19);
    const zones: DropZone[] = ['left', 'right', 'top', 'bottom', 'tabs'];
    // 全部を木に並べる（横に足していく）
    const tree = registryKeys.slice(1).reduce<Layout>(
      (t, k) => ({ kind: 'split', dir: 'row', sizes: [0.5, 0.5], children: [t!, { kind: 'tabs', tabs: [k], active: k }] }),
      arrangeAll(registryKeys.slice(0, 1)),
    );
    expect([...keysOf(tree)].sort()).toEqual([...registryKeys].sort());
    for (const key of registryKeys) {
      for (const zone of zones) {
        const target = registryKeys.find((k) => k !== key)!;
        const moved = dropAt(tree, key, target, zone);
        expect([...keysOf(moved)].sort(), `${key}→${target} ${zone}`).toEqual([...registryKeys].sort());
      }
    }
  });

  // FR-142 AC-224
  it('FR-142 AC-224 下へ置くと対象の下に、右へ置くと対象の右に並び、入れ子は増やさない', () => {
    const base = defaultLayout('事業部門');
    const moved = dropAt(base, 'table', 'issue-solution', 'bottom') as Exclude<Layout, null>;
    expect(keysOf(moved).sort()).toEqual(keysOf(base).sort());
    // issue-solution の直下に table（縦の並び）
    const find = (n: Exclude<Layout, null>): boolean => n.kind === 'split'
      && ((n.dir === 'col' && n.children.some((c, i) => keysOf(c).join() === 'issue-solution' && keysOf(n.children[i + 1] ?? null).join() === 'table')) || n.children.some(find));
    expect(find(moved)).toBe(true);
    const right = dropAt(base, 'gantt', 'discussion-tree', 'right');
    expect(keysOf(right)).toContain('gantt');
    // 自分自身・存在しない相手には何もしない
    expect(dropAt(base, 'gantt', 'gantt', 'left')).toBe(base);
    expect(dropAt(base, 'gantt', 'nothing', 'left')).toEqual(base);
  });

  // FR-142 AC-224（置き場所の判定）
  it('FR-142 AC-224 中央はタブ、辺に近いところはその辺', () => {
    expect(zoneOf(0.5, 0.5)).toBe('tabs');
    expect(zoneOf(0.05, 0.5)).toBe('left');
    expect(zoneOf(0.95, 0.5)).toBe('right');
    expect(zoneOf(0.5, 0.02)).toBe('top');
    expect(zoneOf(0.5, 0.98)).toBe('bottom');
  });

  // FR-142 AC-225（移動の前後で、選択・絞り込み・入力は別の状態＝木だけが変わる）
  it('FR-142 AC-225 移動はレイアウトの木だけを変える（元の木は書き換えない）', () => {
    const base = defaultLayout('IT');
    const snapshot = JSON.stringify(base);
    dropAt(base, 'products', 'architecture', 'left');
    expect(JSON.stringify(base)).toBe(snapshot);
  });
});

describe('FR-143 AC-226 操作中のコンポーネントを大きくする', () => {
  const on = (focus: string | null, persona: (typeof PERSONAS)[number], extra: Partial<Parameters<typeof applyAutoSize>[1]> = {}) => ({
    enabled: true, focus, primary: PERSONA_PRIMARY[persona], manual: NONE, ...extra,
  });

  // FR-143 AC-226 PARAM-033
  it('FR-143 AC-226 操作中の面積が基準の PARAM-033（1.5）倍になり、別のものを操作すると移る', () => {
    expect(FOCUS_SCALE).toBe(1.5);
    for (const p of PERSONAS) {
      const base = defaultLayout(p);
      const keys = keysOf(base);
      for (const k of keys) {
        const sized = applyAutoSize(base, on(k, p));
        const want = Math.min(1.5 * share(base, k), 0.8);
        expect(share(sized, k), `${p}/${k}`).toBeCloseTo(want, 6);
        const sum = leafShares(sized).reduce((a, l) => a + l.share, 0);
        expect(sum).toBeCloseTo(1, 6);
      }
    }
    const a = applyAutoSize(defaultLayout('事業部門'), on('issue-solution', '事業部門'));
    const b = applyAutoSize(defaultLayout('事業部門'), on('discussion-tree', '事業部門'));
    expect(share(a, 'issue-solution')).toBeGreaterThan(share(b, 'issue-solution'));
    expect(share(b, 'discussion-tree')).toBeGreaterThan(share(a, 'discussion-tree'));
  });

  // FR-143 AC-226 重要度
  it('FR-143 AC-226 ペルソナの既定の情報表現は、操作中の標準のコンポーネントより小さくならない', () => {
    for (const p of PERSONAS) {
      const base = defaultLayout(p);
      for (const k of keysOf(base).filter((x) => x !== PERSONA_PRIMARY[p])) {
        const sized = applyAutoSize(base, on(k, p));
        expect(share(sized, PERSONA_PRIMARY[p]), `${p}: ${k} を操作中`).toBeGreaterThanOrEqual(share(sized, k) - 1e-9);
      }
    }
  });

  // FR-143 AC-228
  it('FR-143 AC-228 自動の調整を切る・操作中がない・操作中が手動なら、木は変わらない', () => {
    const base = defaultLayout('事業部門');
    expect(applyAutoSize(base, on('gantt', '事業部門', { enabled: false }))).toBe(base);
    expect(applyAutoSize(base, on(null, '事業部門'))).toBe(base);
    expect(applyAutoSize(base, on('gantt', '事業部門', { manual: new Set(['gantt']) }))).toBe(base);
  });

  // FR-143 AC-228
  it('FR-143 AC-228 手で大きさを変えたコンポーネントの面積は、自動の調整で変わらない', () => {
    const base = defaultLayout('事業部門');
    const sized = applyAutoSize(base, on('issue-solution', '事業部門', { manual: new Set(['table']) }));
    expect(share(sized, 'table')).toBeCloseTo(share(base, 'table'), 6);
    expect(share(sized, 'issue-solution')).toBeCloseTo(1.5 * share(base, 'issue-solution'), 6);
  });

  // FR-143 AC-226 + AC-227（最小の幅を割る列は、面積を保ったまま縦で補う）
  it('FR-143 AC-226 最小の幅を割らないように調整しても、操作中の面積は 1.5 倍のまま', () => {
    const base = defaultLayout('事業部門');
    const sized = applyAutoSize(base, on('issue-solution', '事業部門', { width: 1380 }));
    expect(share(sized, 'issue-solution')).toBeCloseTo(1.5 * share(base, 'issue-solution'), 2);
    const row = (sized as Exclude<Layout, null>);
    expect(row.kind).toBe('split');
  });
});

describe('FR-143 AC-227 最小の幅（PARAM-034）とタブ', () => {
  const widthsOf = (l: Layout, w: number): Array<{ keys: string[]; width: number }> => {
    const out: Array<{ keys: string[]; width: number }> = [];
    const walk = (n: Exclude<Layout, null>, width: number): void => {
      if (n.kind === 'tabs') { out.push({ keys: n.tabs, width }); return; }
      if (n.dir === 'col') { n.children.forEach((c) => walk(c, width)); return; }
      const usable = width - 8 * (n.children.length - 1);
      n.children.forEach((c, i) => walk(c, n.sizes[i]! * usable));
    };
    if (l) walk(l, w);
    return out;
  };

  // FR-143 AC-227
  it('FR-143 AC-227 コンポーネントの数が増えても、どの幅も 240 未満にならず、収まらないものはタブから届く', () => {
    expect(MIN_COMPONENT_WIDTH).toBe(240);
    const keys = registryKeys.slice(0, 12);
    let row: Layout = { kind: 'tabs', tabs: [keys[0]!], active: keys[0]! };
    for (const k of keys.slice(1)) {
      row = { kind: 'split', dir: 'row', sizes: [0.5, 0.5], children: [row!, { kind: 'tabs', tabs: [k], active: k }] };
    }
    for (const width of [1380, 1000, 700, 500, 300]) {
      const fit = fitMinWidth(row, width);
      expect([...keysOf(fit)].sort(), `幅 ${width}: すべてのキーが残る`).toEqual([...keys].sort());
      for (const c of widthsOf(fit, width)) {
        expect(c.width, `幅 ${width} ${c.keys.join('+')}`).toBeGreaterThanOrEqual(Math.min(MIN_COMPONENT_WIDTH, width) - 0.5);
      }
    }
    // 収まらないものは同じタブのまとまりに入る（タブから届く）
    const narrow = fitMinWidth(row, 500);
    expect(leafShares(narrow).some((l) => l.node.tabs.length > 1)).toBe(true);
  });

  // FR-143 AC-227（前面のタブ）
  it('FR-143 AC-227 タブにまとめたとき、操作中のものを前面にする', () => {
    const base = defaultLayout('事業部門');
    const fit = fitMinWidth(base, 400, ['table']);
    const tabs = leafShares(fit).find((l) => l.node.tabs.includes('table'))!.node;
    if (tabs.tabs.length > 1) expect(tabs.active).toBe('table');
  });
});

describe('FR-143 AC-228 手動の大きさと既定へ戻す（ストア）', () => {
  class MemoryStorage {
    private m = new Map<string, string>();
    get length() { return this.m.size; }
    key(i: number) { return [...this.m.keys()][i] ?? null; }
    getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
    setItem(k: string, v: string) { this.m.set(k, String(v)); }
    removeItem(k: string) { this.m.delete(k); }
    clear() { this.m.clear(); }
  }
  async function fresh() {
    vi.resetModules();
    const storage = new MemoryStorage();
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('window', { localStorage: storage });
    const mod = await import('../../src/store/layout');
    mod.setAvailableComponents(['issue-solution', 'discussion-tree', 'gantt', 'table', 'kpi-okr']);
    return { ...mod, storage };
  }
  beforeEach(() => { vi.unstubAllGlobals(); });

  // FR-143 AC-228
  it('FR-143 AC-228 境界を動かすと両側が手動になり、再読込しても残り、「既定のレイアウトに戻す」で消える。自動の調整の切替は保存される', async () => {
    const { useLayout, storage } = await fresh();
    useLayout.getState().setPersona('事業部門');
    useLayout.getState().resizeByKeys('issue-solution', 'discussion-tree', 0.05);
    // 既定は情報の階層の配置（FR-244。FR-296 で 4 個以内の 2 列 × 2 行）: 左の列（主役とガント）と右の列（議論ツリーと一覧表）の境界で、両側の全体が手動になる
    expect(new Set(useLayout.getState().manual['事業部門'])).toEqual(new Set(['issue-solution', 'gantt', 'discussion-tree', 'table']));
    expect(useLayout.getState().manual['事業部門']).not.toContain('kpi-okr');
    useLayout.getState().setAutoSize(false);
    const saved = JSON.parse(storage.getItem('edb.layout')!);
    expect(saved.state.autoSize).toBe(false);
    expect(saved.state.manual['事業部門']).toContain('issue-solution');
    // 既定に戻す
    useLayout.getState().resetLayout();
    expect(useLayout.getState().manual['事業部門']).toBeUndefined();
    expect(useLayout.getState().layouts['事業部門']).toBeUndefined();
  });

  // FR-143 AC-228（ドラッグでの移動の保存）
  it('FR-142 AC-224 ドロップした結果は FR-014 のレイアウトとして保存され、既定に戻すと戻る', async () => {
    const { useLayout, storage, effectiveLayout } = await fresh();
    useLayout.getState().setPersona('事業部門');
    useLayout.getState().dropMove('table', 'issue-solution', 'bottom');
    const saved = JSON.parse(storage.getItem('edb.layout')!);
    expect(saved.state.layouts['事業部門']).toBeTruthy();
    useLayout.getState().resetLayout();
    expect(JSON.stringify(effectiveLayout(useLayout.getState()))).toBe(JSON.stringify(defaultLayout('事業部門')));
  });
});

describe('NFR-UX-007 AC-233 トークンと 4px グリッド（静的検査）', () => {
  const files = ['src/workspace/Workspace.tsx', 'src/workspace/Controls.tsx', 'src/workspace/PaneContext.tsx', 'src/components/Panel.tsx', 'src/workspace/autosize.ts', 'src/theme/a11y.css'];

  // NFR-UX-007 AC-233
  it('NFR-UX-007 AC-233 直書きの色の値が 0 件', () => {
    for (const f of files) {
      const text = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(text.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [], `${f}: 16 進の色`).toEqual([]);
      expect(text.match(/\b(rgb|rgba|hsl|hsla)\(/g) ?? [], `${f}: rgb/hsl`).toEqual([]);
    }
  });

  // NFR-UX-007 AC-233
  it('NFR-UX-007 AC-233 余白・文字サイズ・角丸の px は 4 の倍数か、トークンで指定する', () => {
    for (const f of files.filter((x) => x.endsWith('.tsx'))) {
      const text = readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '');
      const bad = [...text.matchAll(/(?:padding|margin|gap|Gap|borderRadius|fontSize)[A-Za-z]*:\s*'(\d+)px'/g)].filter((m) => Number(m[1]) % 4 !== 0);
      expect(bad.map((m) => m[0]), f).toEqual([]);
    }
  });
});

describe('FR-143 AC-242 狭い画面では最小の幅を優先し、拡大率を 1 倍まで縮めてからタブにまとめる', () => {
  const lf = (k: string) => ({ kind: 'tabs' as const, tabs: [k], active: k });
  const widths = (l: Layout, w: number): number[] => {
    const walk = (n: Exclude<Layout, null>, width: number): number[] => {
      if (n.kind === 'tabs') return [width];
      if (n.dir === 'col') return n.children.flatMap((c) => walk(c, width));
      const u = width - 8 * (n.children.length - 1);
      return n.children.flatMap((c, i) => walk(c, n.sizes[i]! * u));
    };
    return l ? walk(l, w) : [];
  };
  const input = (focus: string, width: number) => ({ enabled: true, focus, primary: null, manual: new Set<string>(), width });
  // FR-143 AC-242
  it('FR-143 AC-242 1.5 倍だと他が 240 未満になる幅では、拡大を 1.5 倍より小さく（1 倍以上で）縮め、どの幅も 240 以上', () => {
    const row: Layout = { kind: 'split', dir: 'row', sizes: [0.25, 0.25, 0.25, 0.25], children: ['a', 'b', 'c', 'd'].map(lf) };
    const w = 4 * 240 + 3 * 8 + 40; // 1 倍なら収まり、1.5 倍だと他が割る
    const sized = applyAutoSize(row, input('a', w));
    const ratio = share(sized, 'a') / 0.25;
    expect(ratio).toBeGreaterThanOrEqual(1 - 1e-6);
    expect(ratio).toBeLessThan(1.5 - 1e-6);
    for (const x of widths(fitMinWidth(sized, w, ['a']), w)) expect(x).toBeGreaterThanOrEqual(MIN_COMPONENT_WIDTH - 0.5);
    expect(leafShares(fitMinWidth(sized, w, ['a']))).toHaveLength(4);
  });
  // FR-143 AC-242
  it('FR-143 AC-242 1 倍でも収まらないときは、拡大せず（1 倍）、収まらないものだけがタブにまとめられ到達できる', () => {
    const row: Layout = { kind: 'split', dir: 'row', sizes: [0.25, 0.25, 0.25, 0.25], children: ['a', 'b', 'c', 'd'].map(lf) };
    const w = 600;
    const sized = applyAutoSize(row, input('a', w));
    expect(share(sized, 'a')).toBeCloseTo(0.25, 6);
    const fit = fitMinWidth(sized, w, ['a']);
    expect([...keysOf(fit)].sort()).toEqual(['a', 'b', 'c', 'd']);
    for (const x of widths(fit, w)) expect(x).toBeGreaterThanOrEqual(MIN_COMPONENT_WIDTH - 0.5);
    expect(leafShares(fit).find((l) => l.node.tabs.includes('a'))!.node.tabs).toEqual(['a']);
  });
});

describe('FR-143 AC-227 最小の幅の確保（収まるときはタブにまとめない）', () => {
  const lf = (k: string) => ({ kind: 'tabs' as const, tabs: [k], active: k });
  // FR-143 AC-227
  it('FR-143 AC-227 全部が最小の幅で並ぶなら、比率が偏っていてもタブにまとめず、すべて最小の幅以上にする', () => {
    const row: Layout = { kind: 'split', dir: 'row', sizes: [0.6, 0.1, 0.1, 0.2], children: ['a', 'b', 'c', 'd'].map(lf) };
    const fit = fitMinWidth(row, 1000);
    expect(leafShares(fit)).toHaveLength(4);
    for (const l of leafShares(fit)) expect(l.share * (1000 - 24)).toBeGreaterThanOrEqual(MIN_COMPONENT_WIDTH - 1);
  });
  // FR-143 AC-227
  it('FR-143 AC-227 収まらないときは、操作中のものを含まない隣り合う葉から 1 組ずつまとめ、操作中のものは単独で残す', () => {
    const inner: Layout = { kind: 'split', dir: 'row', sizes: [0.45, 0.2, 0.35], children: ['m', 'r', 'c'].map(lf) };
    const row: Layout = { kind: 'split', dir: 'row', sizes: [0.5, 0.17, 0.17, 0.16], children: [inner, lf('t'), lf('d'), lf('i')] };
    const fit = fitMinWidth(row, 1380, ['i']);
    expect(keysOf(fit).sort()).toEqual(['c', 'd', 'i', 'm', 'r', 't']);
    expect(leafShares(fit).find((l) => l.node.tabs.includes('d'))!.node.tabs).toEqual(['d']);
    expect(leafShares(fit).find((l) => l.node.tabs.includes('i'))!.node.tabs).toEqual(['i']);
    expect(leafShares(fit).length).toBe(5);
  });
});