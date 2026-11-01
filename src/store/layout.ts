// ワークスペースのレイアウトの状態。ペルソナ別に localStorage へ保存し、再読込で復元する（FR-014）。
// 「選択中の対象」と「絞り込み」は別の状態で、ここでは持たない（FR-110: 既定に戻しても変わらない）。
import { create } from 'zustand';
import { createJSONStorage, persist, type PersistStorage, type StorageValue } from 'zustand/middleware';
import {
  DEFAULT_PERSONA, PERSONAS, activate, keysOf, arrangeAll, defaultLayout, hide, isLayout, isVisible, mergeIntoTabs, move, prune, resize, show,
  splitFromTabs, splitBetween, toggleDirection, dropAt, getAt, type DropZone, type Layout, type Move, type Path, type Persona,
} from '../workspace/layoutModel';
import { resizedKeys } from '../workspace/autosize';
import { snapLayout, type SnapKind, type SnapOpts } from '../workspace/snap';
import { autoTree } from '../workspace/autoLayout';
import { TIERS, classify, type Tier, type TierOverrides } from '../workspace/tiers';
import { VIEW_MODES, WORLD_VIEWS, type ViewMode, type WorldView } from '../view/viewModel';
import { MIN_WINDOW_H, MIN_WINDOW_W, makeRoom } from '../workspace/windowLimits';

/** コンポーネントごとのビューの切替の状態（FR-217・FR-218）。持たない項目は既定（表示モードは画面の既定、世界の表示は「両方」） */
export interface ViewSetting { mode?: ViewMode; world?: WorldView }
export type ViewMap = Record<string, ViewSetting>;
const isViewSetting = (v: unknown): v is ViewSetting => {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (o.mode === undefined || (VIEW_MODES as readonly unknown[]).includes(o.mode)) && (o.world === undefined || (WORLD_VIEWS as readonly unknown[]).includes(o.world));
};

/** 画面の registry に登録されたコンポーネントのキー。App が起動時に設定する。 */
let available: ReadonlySet<string> = new Set();
export function setAvailableComponents(keys: readonly string[]): void {
  available = new Set(keys);
}

/** 自由配置（浮動）したコンポーネントの位置と大きさ。作業領域に対する割合（0〜1）。FR-173 */
export interface FloatRect { x: number; y: number; w: number; h: number }
export type FloatMap = Record<string, FloatRect>;
const MIN_FLOAT = 0.1;
/** 作業領域の大きさ（CSS px。Workspace が測って伝える）。自由配置の下限（PARAM-134・PARAM-135）を割合へ直すのに使う。0 なら不明 */
let areaSize = { w: 0, h: 0 };
export function setWorkspaceArea(w: number, h: number): void {
  areaSize = { w: Math.max(0, w), h: Math.max(0, h) };
}
/** 作業領域の外へ出ないように収める。幅・高さは PARAM-134・PARAM-135 以上にする（領域がそれより狭いときは領域いっぱい） */
export function clampFloat(r: FloatRect): FloatRect {
  const minW = areaSize.w > 0 ? Math.min(1, Math.max(MIN_FLOAT, MIN_WINDOW_W / areaSize.w)) : MIN_FLOAT;
  const minH = areaSize.h > 0 ? Math.min(1, Math.max(MIN_FLOAT, MIN_WINDOW_H / areaSize.h)) : MIN_FLOAT;
  const w = Math.min(1, Math.max(minW, Number.isFinite(r.w) ? r.w : 0.5));
  const h = Math.min(1, Math.max(minH, Number.isFinite(r.h) ? r.h : 0.5));
  const x = Math.min(1 - w, Math.max(0, Number.isFinite(r.x) ? r.x : 0));
  const y = Math.min(1 - h, Math.max(0, Number.isFinite(r.y) ? r.y : 0));
  return { x, y, w, h };
}
const isFloatRect = (v: unknown): v is FloatRect => !!v && typeof v === 'object' && ['x', 'y', 'w', 'h'].every((k) => typeof (v as Record<string, unknown>)[k] === 'number');

interface LayoutState {
  persona: Persona;
  /** 自由配置したコンポーネント（ペルソナ別。保存する。FR-173） */
  floats: Partial<Record<Persona, FloatMap>>;
  /** 手前に出す順（後ろほど手前。保存しない。FR-173） */
  zOrder: string[];
  /** 最後に使った順の目印（大きいほど最近。保存しない）。領域が足りないとき、最も長く使っていないものから最小化する（FR-296） */
  usedAt: Record<string, number>;
  /** 領域が足りなくなって最小化した（木から外した）コンポーネント（ペルソナ別。保存しない）。画面は隠したまま残し、一覧から戻すとき状態を失わない（FR-296 AC-801） */
  parked: Record<string, string[]>;
  /** 使ったことを覚える（前面にする・再表示・操作） */
  touch: (key: string) => void;
  /** 閉じた（非表示にした）コンポーネント（ペルソナ別。保存する）。最小化と区別して一覧（FR-295）に出す */
  closed: Partial<Record<Persona, string[]>>;
  setFloat: (key: string, r: FloatRect) => void;
  /** 自由配置のコンポーネントをまとめて置く（押し出しの結果。FR-173・FR-184）。渡したもの以外の自由配置は変えない */
  setFloats: (rects: FloatMap) => void;
  /** 浮かせたコンポーネントを分割の配置へ戻す */
  unfloat: (key: string) => void;
  /** 自由配置をすべて解いて、分割の配置へ戻す */
  clearFloats: () => void;
  /** 直近に操作したものを手前に出す */
  raise: (key: string) => void;
  /** ピン止めしたコンポーネントと、ピン止めした時点の位置と大きさ（作業領域に対する割合。ペルソナ別。保存する。FR-215・FR-216） */
  pinned: Partial<Record<Persona, Record<string, FloatRect>>>;
  /** ピン止めする（`rect` を渡す）／外す（null）。ピン止めすると、その位置と大きさを自由配置にも置く */
  setPinned: (key: string, rect: FloatRect | null) => void;
  /** コンポーネントごとの表示モード・世界の表示（ペルソナ別。保存する。FR-217・FR-218）。「既定のレイアウトに戻す」で既定に戻る（AC-506） */
  views: Partial<Record<Persona, ViewMap>>;
  /** 画面の見出しの切替で最後に選んだ値（ペルソナ別。保存する）。画面の見出しの「ビュー」ボタンの文字に使う */
  screenView: Partial<Record<Persona, ViewSetting>>;
  /** コンポーネントの見出しの切替（そのコンポーネントだけに効く） */
  setView: (key: string, patch: ViewSetting) => void;
  /** 画面の見出しの切替（渡したコンポーネントにまとめて効く。値は対象ごとに求めたもの。undefined の項目は変えない） */
  setViews: (patches: Record<string, ViewSetting>, screen: ViewSetting) => void;
  /** ヘッダーのダブルクリックで拡大表示しているコンポーネント（保存しない。FR-174） */
  expanded: string | null;
  setExpanded: (key: string | null) => void;
  toggleExpanded: (key: string) => void;
  /** 利用者が変えたレイアウト。ないペルソナは既定のレイアウト */
  layouts: Partial<Record<Persona, Layout>>;
  /** 操作中のコンポーネントを大きくする自動のサイズ調整（FR-143）。保存する */
  autoSize: boolean;
  /** 利用者が手で大きさを変えたコンポーネント（ペルソナ別）。自動の調整で変えない */
  manual: Partial<Record<Persona, string[]>>;
  setAutoSize: (on: boolean) => void;
  /** 最小化したコンポーネント（ペルソナ別。見出しだけ残して畳む。保存する。FR-151） */
  minimized: Partial<Record<Persona, string[]>>;
  /** 左のメニューをアイコンだけにしているか（保存する。FR-151） */
  navMin: boolean;
  setMinimized: (key: string, on: boolean) => void;
  setNavMin: (on: boolean) => void;
  dropMove: (key: string, target: string, zone: DropZone) => void;
  /** 画面端のスナップの候補どおりに配置する（FR-152）。配置した大きさは自動のサイズ調整で変えない */
  snapTo: (key: string, kind: SnapKind, opts?: SnapOpts) => void;
  resizeByKeys: (a: string, b: string, delta: number) => void;
  /** 最大化中のコンポーネント（保存しない） */
  maximized: string | null;
  /** 直近に「見せたい」と指示されたコンポーネント（ナビ・再表示・タブ選択。保存しない）。最小幅でタブにまとめた中でも前面にするために使う */
  revealed: { key: string } | null;
  /** 「既定のレイアウトに戻す」を行った回数（保存しない）。戻した直後は操作中の扱いを解き、次の操作まで既定の寸法にする（FR-110 AC-135、FR-143） */
  resetCount: number;
  setPersona: (p: Persona) => void;
  hideComponent: (key: string) => void;
  showComponent: (key: string) => void;
  moveComponent: (key: string, dir: Move) => void;
  toggleDirection: (key: string) => void;
  mergeTabs: (key: string, target: string) => void;
  untab: (key: string) => void;
  resizeAt: (path: Path, index: number, delta: number) => void;
  activateTab: (key: string) => void;
  setMaximized: (key: string | null) => void;
  resetLayout: () => void;
  /** 利用者が変えた階層（ペルソナ別。コンポーネントのキー → 階層。保存する。FR-244） */
  tiers: Partial<Record<Persona, TierOverrides>>;
  /** 階層を変える（null で既定に戻す）。レイアウトとして保存する（FR-244）。自動配置が働く配置なら、配置も階層に合わせ直す */
  setTier: (key: string, tier: Tier | null) => void;
  /** 自動配置を止めているペルソナ（保存する。FR-243）。止めると、以後の追加で既存の配置は動かない */
  autoOff: Partial<Record<Persona, boolean>>;
  setAutoOff: (off: boolean) => void;
  /** 利用者が手で動かしたコンポーネント（ペルソナ別。保存する。自動配置の対象にしない。FR-243 の優先 ②） */
  moved: Partial<Record<Persona, string[]>>;
  markMoved: (key: string) => void;
  /** 利用者が分割の配置を手で変えたペルソナ（保存する）。変えていなければ、追加・再表示で配置全体を階層に合わせて組み直せる */
  userLaid: Partial<Record<Persona, boolean>>;
  /** 自動配置を実行する前の状態（保存しない）。取り消しに使う（FR-243 AC-586） */
  autoUndo: AutoSnapshot | null;
  /** 非表示にしたコンポーネントの、直前の自由配置の位置と大きさ（保存しない）。再表示したとき、ほかを動かさずに同じ場所へ戻す（FR-243） */
  hiddenRects: Partial<Record<Persona, Record<string, FloatRect>>>;
  /** 取り消し用に、いまの状態を覚える */
  saveAutoUndo: () => void;
  /** 自動配置を取り消し、実行前の状態へ戻す。戻せたら true */
  undoAuto: () => boolean;
  /** ピン止め・手で動かしたものがないとき、配置全体を階層に合わせて組み直す（自動配置の実行。FR-243）。自動配置を再開する */
  runAutoTree: () => void;
}

/** 自動配置の実行前に覚える状態（ペルソナ 1 つ分） */
export interface AutoSnapshot {
  persona: Persona;
  layout: Layout | undefined;
  floats: FloatMap | undefined;
  manual: string[] | undefined;
  moved: string[] | undefined;
  userLaid: boolean | undefined;
  autoOff: boolean | undefined;
}

/** そのペルソナのコンポーネント（§7 の既定の構成のうち、登録済みのもの） */
export function personaKeys(persona: Persona): string[] {
  return keysOf(prune(defaultLayout(persona), available));
}

/** 自動配置で最低限そろえるコンポーネントの数（FR-243 AC-584: 4 つ以上）。登録済みの画面が足りないとき、下の画面で補う（一覧表は製品の一覧を担う） */
const MIN_AUTO_COMPONENTS = 4;
/** 階層に基づいて配置全体を組み直すときの、コンポーネント数の上限（これを超えると各コンポーネントが小さくなりすぎるので、従来どおり末尾へ足す） */
const MAX_AUTO_COMPONENTS = 6;
const SUPPLEMENT = ['table', 'kpi-okr', 'summary'] as const;

/** 情報の階層に基づく自動配置の木（FR-243）。構成が少ないペルソナは、不足分を補う */
export function autoLayoutFor(persona: Persona, tiers: TierOverrides | undefined): Layout {
  const keys = personaKeys(persona);
  for (const k of SUPPLEMENT) if (keys.length < MIN_AUTO_COMPONENTS && available.has(k) && !keys.includes(k)) keys.push(k);
  return autoTree(keys, classify(persona, keys, tiers));
}

/** 表示するレイアウト（使えないコンポーネントを除く）。 */
export function effectiveLayout(s: Pick<LayoutState, 'persona' | 'layouts'> & Partial<Pick<LayoutState, 'tiers' | 'autoOff'>>): Layout {
  const stored = s.layouts[s.persona];
  if (stored === null) return null; // 利用者が全部を非表示にした状態はそのまま（ドックから再表示できる）
  // 既定、または保存値の画面が 1 つも残らないとき: §7 の既定、それも空なら登録済みの画面を並べる（暫定）
  const kept = stored !== undefined ? prune(stored, available) : null;
  if (kept) return kept;
  // 保存済みのレイアウトがない: §7 の既定（情報の階層の配置と同じ形）。構成が少ない（登録済みの画面が足りない）ときは、自動配置で不足分を補う（FR-243 AC-584: 4 つ以上）
  const dflt = prune(defaultLayout(s.persona), available);
  if (stored === undefined && !s.autoOff?.[s.persona] && dflt && keysOf(dflt).length < MIN_AUTO_COMPONENTS) return autoLayoutFor(s.persona, s.tiers?.[s.persona]) ?? dflt;
  return dflt ?? arrangeAll([...available]);
}

/** ピン止めしているか（いまのペルソナ。FR-215） */
export function isPinned(s: Pick<LayoutState, 'persona' | 'pinned'>, key: string): boolean {
  return !!s.pinned[s.persona]?.[key];
}

/** 使った順の目印の時計（保存しない） */
let useClock = 0;

/**
 * 境界のドラッグ中は、配置の保存（JSON 化と localStorage への書き込み）をポインター移動のたびに行わず、離したときに 1 度だけ書く（FR-185 AC-393: リサイズ中 30fps 以上）。
 * 保持を解くと、保留した保存を書き、登録された後処理（タスク文脈の保存など）を呼ぶ。
 */
let persistHeld = false;
let pendingWrite: { name: string; value: StorageValue<unknown> } | null = null;
const releaseHooks: Array<() => void> = [];
export const isLayoutPersistHeld = (): boolean => persistHeld;
export function onLayoutPersistRelease(fn: () => void): void { releaseHooks.push(fn); }
const baseStorage = createJSONStorage<unknown>(() => localStorage);
const layoutStorage: PersistStorage<unknown> = {
  getItem: (name) => baseStorage?.getItem(name) ?? null,
  removeItem: (name) => baseStorage?.removeItem(name),
  setItem: (name, value) => {
    if (persistHeld) { pendingWrite = { name, value }; return; }
    return baseStorage?.setItem(name, value);
  },
};
function flushLayoutWrite(): void {
  if (!pendingWrite) return;
  const p = pendingWrite;
  pendingWrite = null;
  void baseStorage?.setItem(p.name, p.value);
}
export function holdLayoutPersist(on: boolean): void {
  if (persistHeld === on) return;
  persistHeld = on;
  // 境界のドラッグ中は、影・背景のぼかしを止める（design.css の data-edb-resizing。毎フレームの再合成・ラスタライズを減らす。FR-185 AC-393）
  if (typeof document !== 'undefined') document.documentElement.toggleAttribute('data-edb-resizing', on);
  if (on) return;
  flushLayoutWrite();
  releaseHooks.forEach((f) => f());
}
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') window.addEventListener('pagehide', flushLayoutWrite);

export const useLayout = create<LayoutState>()(
  persist(
    (set, get) => {
      // user: 利用者が配置を手で変える操作か（表示・非表示・タブの前面の切替は含まない）。手で変えたら、自動での組み直しの対象から外す（FR-243）
      const apply = (fn: (l: Layout) => Layout, maximized?: string | null, user = true) =>
        set((s) => ({
          layouts: { ...s.layouts, [s.persona]: fn(effectiveLayout(s)) },
          ...(user ? { userLaid: { ...s.userLaid, [s.persona]: true } } : {}),
          ...(maximized !== undefined ? { maximized } : {}),
        }));
      /** ピン止め・手で動かした・手で大きさを変えた・手で並べ替えたものがあるか（優先 ①②。なければ、自動配置が配置全体を組み直せる） */
      const userArranged = (s: LayoutState): boolean => {
        const p = s.persona;
        return !!s.userLaid[p] || Object.keys(s.pinned[p] ?? {}).length > 0 || Object.keys(s.floats[p] ?? {}).length > 0
          || (s.manual[p]?.length ?? 0) > 0 || (s.moved[p]?.length ?? 0) > 0;
      };
      const dropFloat = (key: string) => set((s) => {
        const cur = s.floats[s.persona];
        if (!cur || !(key in cur)) return {};
        const { [key]: _drop, ...rest } = cur;
        return { floats: { ...s.floats, [s.persona]: rest } };
      });
      return {
        persona: DEFAULT_PERSONA,
        floats: {},
        zOrder: [],
        usedAt: {},
        parked: {},
        closed: {},
        touch: (key) => set((s) => ({ usedAt: { ...s.usedAt, [key]: ++useClock } })),
        expanded: null,
        setFloat: (key, r) => set((s) => ({
          floats: { ...s.floats, [s.persona]: { ...(s.floats[s.persona] ?? {}), [key]: clampFloat(r) } },
          zOrder: [...s.zOrder.filter((k) => k !== key), key],
        })),
        setFloats: (rects) => set((s) => {
          const next: FloatMap = { ...(s.floats[s.persona] ?? {}) };
          const pins = s.pinned[s.persona] ?? {};
          // ピン止めしたものは、ピン止めした位置と大きさのまま（FR-216）
          for (const [k, r] of Object.entries(rects)) next[k] = clampFloat(pins[k] ?? r);
          return { floats: { ...s.floats, [s.persona]: next } };
        }),
        unfloat: (key) => { if (!isPinned(get(), key)) dropFloat(key); },
        // ピン止めしたものは自由配置のまま残す（FR-216。外すまで固定）
        clearFloats: () => set((s) => {
          const floats = { ...s.floats };
          const pins = s.pinned[s.persona] ?? {};
          const keep = Object.fromEntries(Object.entries(floats[s.persona] ?? {}).filter(([k]) => k in pins));
          if (Object.keys(keep).length > 0) floats[s.persona] = keep;
          else delete floats[s.persona];
          return { floats };
        }),
        pinned: {},
        setPinned: (key, rect) => set((s) => {
          const cur = { ...(s.pinned[s.persona] ?? {}) };
          if (rect) cur[key] = clampFloat(rect);
          else delete cur[key];
          return {
            pinned: { ...s.pinned, [s.persona]: cur },
            ...(rect ? { floats: { ...s.floats, [s.persona]: { ...(s.floats[s.persona] ?? {}), [key]: clampFloat(rect) } } } : {}),
          };
        }),
        views: {},
        screenView: {},
        setView: (key, patch) => set((s) => {
          const cur = { ...(s.views[s.persona] ?? {}) };
          cur[key] = { ...(cur[key] ?? {}), ...patch };
          return { views: { ...s.views, [s.persona]: cur } };
        }),
        setViews: (patches, screen) => set((s) => {
          const cur = { ...(s.views[s.persona] ?? {}) };
          for (const [k, p] of Object.entries(patches)) {
            const clean: ViewSetting = {};
            if (p.mode !== undefined) clean.mode = p.mode;
            if (p.world !== undefined) clean.world = p.world;
            cur[k] = { ...(cur[k] ?? {}), ...clean };
          }
          return { views: { ...s.views, [s.persona]: cur }, screenView: { ...s.screenView, [s.persona]: { ...(s.screenView[s.persona] ?? {}), ...screen } } };
        }),
        raise: (key) => set((s) => (s.zOrder[s.zOrder.length - 1] === key ? { usedAt: { ...s.usedAt, [key]: ++useClock } } : { zOrder: [...s.zOrder.filter((k) => k !== key), key], usedAt: { ...s.usedAt, [key]: ++useClock } })),
        setExpanded: (key) => set((s) => ({
          expanded: key,
          ...(key ? { maximized: null, minimized: { ...s.minimized, [s.persona]: (s.minimized[s.persona] ?? []).filter((k) => k !== key) } } : {}),
        })),
        toggleExpanded: (key) => get().setExpanded(get().expanded === key ? null : key),
        layouts: {},
        maximized: null,
        revealed: null,
        resetCount: 0,
        autoSize: true,
        manual: {},
        setAutoSize: (autoSize) => set({ autoSize }),
        minimized: {},
        navMin: false,
        setMinimized: (key, on) => set((st) => {
          const cur = (st.minimized[st.persona] ?? []).filter((k) => k !== key);
          // 最小化は最大化と両立しない（最小化すると最大化を解く）
          return { minimized: { ...st.minimized, [st.persona]: on ? [...cur, key] : cur }, ...(on && st.maximized === key ? { maximized: null } : {}) };
        }),
        setNavMin: (navMin) => set({ navMin }),
        dropMove: (key, target, zone) => { if (isPinned(get(), key) || isPinned(get(), target)) return; dropFloat(key); apply((l) => dropAt(l, key, target, zone)); },
        snapTo: (key, kind, opts) => {
          if (isPinned(get(), key) || (kind === 'tabs' && opts?.tabTarget && isPinned(get(), opts.tabTarget))) return;
          set((st) => (kind === 'tabs' ? {} : { manual: { ...st.manual, [st.persona]: [...new Set([...(st.manual[st.persona] ?? []), ...keysOf(effectiveLayout(st))])] } }));
          dropFloat(key);
          apply((l) => snapLayout(l, key, kind, opts));
        },
        resizeByKeys: (a, b, delta) => {
          const l = effectiveLayout(get());
          const at = splitBetween(l, a, b);
          if (!at || !l) return;
          const keys = resizedKeys(getAt(l, at.path), at.index);
          // 1 回の set にまとめる（ポインター移動のたびの再描画・保存を 1 回にする）
          set((st) => {
            const manual = { ...st.manual, [st.persona]: [...new Set([...(st.manual[st.persona] ?? []), ...keys])] };
            return {
              manual,
              layouts: { ...st.layouts, [st.persona]: resize(effectiveLayout(st), at.path, at.index, delta) },
              userLaid: { ...st.userLaid, [st.persona]: true },
            };
          });
        },
        setPersona: (persona) => set({ persona, maximized: null, expanded: null }),
        hideComponent: (key) => {
          const r = get().floats[get().persona]?.[key];
          if (r) set((s) => ({ hiddenRects: { ...s.hiddenRects, [s.persona]: { ...(s.hiddenRects[s.persona] ?? {}), [key]: r } } }));
          set((s) => ({ closed: { ...s.closed, [s.persona]: [...new Set([...(s.closed[s.persona] ?? []), key])] }, parked: { ...s.parked, [s.persona]: (s.parked[s.persona] ?? []).filter((k) => k !== key) } }));
          dropFloat(key); if (get().expanded === key) set({ expanded: null }); apply((l) => hide(l, key), get().maximized === key ? null : get().maximized, false);
        },
        showComponent: (key) => {
          const s = get();
          set((st) => ({ closed: { ...st.closed, [st.persona]: (st.closed[st.persona] ?? []).filter((k) => k !== key) }, parked: { ...st.parked, [st.persona]: (st.parked[st.persona] ?? []).filter((k) => k !== key) }, usedAt: { ...st.usedAt, [key]: ++useClock } }));
          // 領域が足りなくなったら、最も長く使っていない（ピン止めしていない）ものを最小化して収める。閉じず、縮めない（FR-296 AC-801）
          const fit = () => {
            const st = get();
            if (areaSize.w <= 0) return;
            const cur = effectiveLayout(st);
            const { layout, dropped } = makeRoom(cur, areaSize.w, { protect: [key], pinned: new Set(Object.keys(st.pinned[st.persona] ?? {})), usedAt: st.usedAt });
            if (dropped.length === 0) return;
            for (const k of dropped) dropFloat(k);
            set({ layouts: { ...st.layouts, [st.persona]: layout }, parked: { ...st.parked, [st.persona]: [...new Set([...(st.parked[st.persona] ?? []), ...dropped])] } });
          };
          // 手で動かしたものも、ピン止めもなく、自動配置が働いているときは、新しく置くものを含めて階層に基づいて組み直す（FR-243）。それ以外は、既存の配置を動かさず足す。
          // 表示するコンポーネントが多くなりすぎる（各コンポーネントが小さくなる）ときと、このペルソナの構成にないコンポーネント（ナビなどで別に開いた画面）は、従来どおり末尾へ足す
          if (!s.autoOff[s.persona] && !userArranged(s) && !isVisible(effectiveLayout(s), key) && personaKeys(s.persona).includes(key)) {
            const cur = effectiveLayout(s);
            const keys = [...personaKeys(s.persona), ...keysOf(cur), key].filter((k, i, a) => a.indexOf(k) === i && (k === key || isVisible(cur, k)));
            const next = keys.length <= MAX_AUTO_COMPONENTS ? autoTree(keys, classify(s.persona, keys, s.tiers[s.persona])) : null;
            // 上限を超えてタブにまとめられたときも、いま見せるものを前面にする
            if (next) { set({ layouts: { ...s.layouts, [s.persona]: activate(next, key) }, revealed: { key } }); fit(); return; }
          }
          apply((l) => show(l, key), undefined, false);
          set({ revealed: { key } });
          fit();
        },
        moveComponent: (key, dir) => { if (!isPinned(get(), key)) apply((l) => move(l, key, dir)); },
        toggleDirection: (key) => { if (!isPinned(get(), key)) apply((l) => toggleDirection(l, key)); },
        mergeTabs: (key, target) => { if (isPinned(get(), key) || isPinned(get(), target)) return; dropFloat(key); apply((l) => mergeIntoTabs(l, key, target)); },
        untab: (key) => { if (isPinned(get(), key)) return; dropFloat(key); apply((l) => splitFromTabs(l, key)); },
        resizeAt: (path, index, delta) => {
          const l = effectiveLayout(get());
          const keys = l ? resizedKeys(getAt(l, path), index) : [];
          set((st) => ({ manual: { ...st.manual, [st.persona]: [...new Set([...(st.manual[st.persona] ?? []), ...keys])] } }));
          apply((x) => resize(x, path, index, delta));
        },
        activateTab: (key) => { get().touch(key); apply((l) => activate(l, key), undefined, false); },
        setMaximized: (maximized) => set((st) => ({
          maximized,
          ...(maximized ? { expanded: null } : {}),
          // 操作の対象にすると最小化は解ける（FR-151）
          ...(maximized ? { minimized: { ...st.minimized, [st.persona]: (st.minimized[st.persona] ?? []).filter((k) => k !== maximized) } } : {}),
        })),
        resetLayout: () => set((s) => {
          const layouts = { ...s.layouts };
          delete layouts[s.persona];
          const manual = { ...s.manual };
          delete manual[s.persona];
          const minimized = { ...s.minimized };
          delete minimized[s.persona];
          const closed = { ...s.closed };
          delete closed[s.persona];
          const floats = { ...s.floats };
          delete floats[s.persona];
          // 既定のレイアウトは固定なし（FR-215）
          const pinned = { ...s.pinned };
          delete pinned[s.persona];
          // 表示モード・世界の表示もレイアウトの一部として既定に戻す（FR-217 AC-506。選択・絞り込みは別の状態なので変わらない）
          const views = { ...s.views };
          delete views[s.persona];
          const screenView = { ...s.screenView };
          delete screenView[s.persona];
          // 既定のレイアウト（FR-112 の §7）に戻す。保存済みのレイアウトを消す。階層の変更・手で動かした記録も既定に戻す。自動配置の停止は利用者の設定なので変えない（FR-243 AC-586）
          const tiers = { ...s.tiers };
          delete tiers[s.persona];
          const moved = { ...s.moved };
          delete moved[s.persona];
          const userLaid = { ...s.userLaid };
          delete userLaid[s.persona];
          return { layouts, manual, minimized, closed, floats, pinned, views, screenView, tiers, moved, userLaid, navMin: false, maximized: null, expanded: null, resetCount: s.resetCount + 1 };
        }),
        tiers: {},
        setTier: (key, tier) => set((s) => {
          const cur: Record<string, Tier> = { ...(s.tiers[s.persona] ?? {}) };
          if (tier === null) delete cur[key];
          else cur[key] = tier;
          const tiers = { ...s.tiers, [s.persona]: cur };
          // 手で並べていなければ、配置も新しい階層に合わせて組み直す（レイアウトとして保存する）
          const stored = s.layouts[s.persona];
          if (!s.autoOff[s.persona] && !userArranged(s) && stored !== null) {
            const keys = keysOf(effectiveLayout(s));
            const tree = autoTree(keys, classify(s.persona, keys, cur));
            if (tree) return { tiers, layouts: { ...s.layouts, [s.persona]: tree } };
          }
          return { tiers };
        }),
        autoOff: {},
        setAutoOff: (off) => set((s) => ({ autoOff: { ...s.autoOff, [s.persona]: off } })),
        moved: {},
        markMoved: (key) => set((s) => ((s.moved[s.persona] ?? []).includes(key) ? {} : { moved: { ...s.moved, [s.persona]: [...(s.moved[s.persona] ?? []), key] } })),
        userLaid: {},
        autoUndo: null,
        hiddenRects: {},
        saveAutoUndo: () => set((s) => ({
          autoUndo: {
            persona: s.persona, layout: s.layouts[s.persona], floats: s.floats[s.persona], manual: s.manual[s.persona],
            moved: s.moved[s.persona], userLaid: s.userLaid[s.persona], autoOff: s.autoOff[s.persona],
          },
        })),
        undoAuto: () => {
          const u = get().autoUndo;
          if (!u) return false;
          set((s) => {
            const put = <T,>(m: Partial<Record<Persona, T>>, v: T | undefined): Partial<Record<Persona, T>> => {
              const r = { ...m };
              if (v === undefined) delete r[u.persona]; else r[u.persona] = v;
              return r;
            };
            return {
              layouts: put(s.layouts, u.layout), floats: put(s.floats, u.floats), manual: put(s.manual, u.manual),
              moved: put(s.moved, u.moved), userLaid: put(s.userLaid, u.userLaid), autoOff: put(s.autoOff, u.autoOff), autoUndo: null,
            };
          });
          return true;
        },
        runAutoTree: () => set((s) => {
          const keys = keysOf(effectiveLayout(s));
          const tree = autoTree(keys, classify(s.persona, keys, s.tiers[s.persona]));
          const floats = { ...s.floats };
          delete floats[s.persona];
          const manual = { ...s.manual };
          delete manual[s.persona];
          const moved = { ...s.moved };
          delete moved[s.persona];
          const userLaid = { ...s.userLaid };
          delete userLaid[s.persona];
          const autoOff = { ...s.autoOff };
          delete autoOff[s.persona];
          return { layouts: tree ? { ...s.layouts, [s.persona]: tree } : s.layouts, floats, manual, moved, userLaid, autoOff };
        }),
      };
    },
    {
      name: 'edb.layout',
      version: 1,
      storage: layoutStorage as never,
      partialize: (s) => ({ persona: s.persona, floats: s.floats, pinned: s.pinned, views: s.views, screenView: s.screenView, zOrder: s.zOrder, layouts: s.layouts, autoSize: s.autoSize, manual: s.manual, minimized: s.minimized, closed: s.closed, navMin: s.navMin, tiers: s.tiers, autoOff: s.autoOff, moved: s.moved, userLaid: s.userLaid }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<Pick<LayoutState, 'persona' | 'floats' | 'pinned' | 'views' | 'screenView' | 'zOrder' | 'layouts' | 'autoSize' | 'manual' |         'minimized' | 'navMin' | 'tiers' | 'autoOff' | 'moved' | 'userLaid'>>;
                const tiers: Partial<Record<Persona, TierOverrides>> = {};
                const autoOff: Partial<Record<Persona, boolean>> = {};
                const moved: Partial<Record<Persona, string[]>> = {};
                const userLaid: Partial<Record<Persona, boolean>> = {};
                for (const name of PERSONAS) {
                  const t = (p.tiers as Record<string, unknown> | undefined)?.[name];
                  if (t && typeof t === 'object') {
                    const m: Record<string, Tier> = {};
                    for (const [k, v] of Object.entries(t as Record<string, unknown>)) if ((TIERS as readonly unknown[]).includes(v)) m[k] = v as Tier;
                    tiers[name] = m;
                  }
                  if ((p.autoOff as Record<string, unknown> | undefined)?.[name] === true) autoOff[name] = true;
                  if ((p.userLaid as Record<string, unknown> | undefined)?.[name] === true) userLaid[name] = true;
                  const mv = (p.moved as Record<string, unknown> | undefined)?.[name];
                  if (Array.isArray(mv) && mv.every((k) => typeof k === 'string')) moved[name] = mv as string[];
                }
                const minimized: Partial<Record<Persona, string[]>> = {};
        for (const name of PERSONAS) {
          const v = (p.minimized as Record<string, unknown> | undefined)?.[name];
          if (Array.isArray(v) && v.every((k) => typeof k === 'string')) minimized[name] = v as string[];
        }
        const persona = PERSONAS.includes(p.persona as Persona) ? (p.persona as Persona) : current.persona;
        const closed: Partial<Record<Persona, string[]>> = {};
        for (const name of PERSONAS) {
          const v = ((p as { closed?: Record<string, unknown> }).closed)?.[name];
          if (Array.isArray(v) && v.every((k) => typeof k === 'string')) closed[name] = v as string[];
        }
        const layouts: Partial<Record<Persona, Layout>> = {};
        for (const name of PERSONAS) {
          const v = (p.layouts as Record<string, unknown> | undefined)?.[name];
          if (v !== undefined && isLayout(v)) layouts[name] = v;
        }
        const manual: Partial<Record<Persona, string[]>> = {};
        for (const name of PERSONAS) {
          const v = (p.manual as Record<string, unknown> | undefined)?.[name];
          if (Array.isArray(v) && v.every((k) => typeof k === 'string')) manual[name] = v as string[];
        }
        const floats: Partial<Record<Persona, FloatMap>> = {};
        for (const name of PERSONAS) {
          const v = (p.floats as Record<string, unknown> | undefined)?.[name];
          if (v && typeof v === 'object') {
            const m: FloatMap = {};
            for (const [k, r] of Object.entries(v as Record<string, unknown>)) if (isFloatRect(r)) m[k] = clampFloat(r);
            floats[name] = m;
          }
        }
        const pinned: Partial<Record<Persona, Record<string, FloatRect>>> = {};
        for (const name of PERSONAS) {
          const v = (p.pinned as Record<string, unknown> | undefined)?.[name];
          if (v && typeof v === 'object') {
            const m: Record<string, FloatRect> = {};
            for (const [k, r] of Object.entries(v as Record<string, unknown>)) if (isFloatRect(r)) m[k] = clampFloat(r);
            pinned[name] = m;
            // ピン止めしたものは、保存した自由配置がなくても、その位置に置く
            floats[name] = { ...(floats[name] ?? {}), ...m };
          }
        }
        const views: Partial<Record<Persona, ViewMap>> = {};
        const screenView: Partial<Record<Persona, ViewSetting>> = {};
        for (const name of PERSONAS) {
          const v = (p.views as Record<string, unknown> | undefined)?.[name];
          if (v && typeof v === 'object') {
            const m: ViewMap = {};
            for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (isViewSetting(x)) m[k] = x;
            views[name] = m;
          }
          const sv = (p.screenView as Record<string, unknown> | undefined)?.[name];
          if (isViewSetting(sv)) screenView[name] = sv;
        }
        const zOrder = Array.isArray(p.zOrder) && p.zOrder.every((k) => typeof k === 'string') ? p.zOrder : [];
        return { ...current, tiers, autoOff, moved, userLaid, floats, pinned, views, screenView, zOrder, persona, layouts, manual, minimized, closed, navMin: p.navMin === true, autoSize: typeof p.autoSize === 'boolean' ? p.autoSize : true };
      },
    },
  ),
);

/** 表示中か（テスト・コマンド用）。 */
export function isComponentVisible(key: string): boolean {
  return isVisible(effectiveLayout(useLayout.getState()), key);
}

/** 画面として登録されているか（表のように、後の項目で登録される画面の有無を見分けるため）。 */
export function isComponentAvailable(key: string): boolean {
  return available.has(key);
}
