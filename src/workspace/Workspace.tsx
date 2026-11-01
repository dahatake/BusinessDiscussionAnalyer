// ワークスペース: レイアウトの木（分割とタブ）を描く。境界はドラッグでもキーボードでも動かせる（FR-109、NFR-A11Y-004）。
import { createPortal, flushSync } from 'react-dom';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType, type CSSProperties, type FocusEvent, type KeyboardEvent, type PointerEvent } from 'react';
import { Button, Tab, TabList, Text, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { MOTION, followDurationOverride } from '../theme/tokens';
import { useSnapMotion, motionAllowed } from '../motion/useFoldMotion';
import { prefersReducedMotion, useAnimation } from '../store/animation';
import { SNAP_LABEL, defaultSnapKind, nearestCorner, snapKindsFor, snapRect, type Edge, type SnapKind, type SnapOpts } from './snap';
import type { ScreenDefinition } from '../screens/types';
import { effectiveLayout, personaKeys, useLayout, clampFloat, isPinned, setWorkspaceArea, type FloatRect } from '../store/layout';
import { EXPAND_RATIO, useSettings, type ExpandPosition } from '../store/settings';
import { keysOf, prune, type DropZone, type LayoutNode, type Path, type SplitNode } from './layoutModel';
import { MIN_COMPONENT_WIDTH, applyAutoSize, fitMinWidth } from './autosize';
import { enforceMin, floorFloat, needHeight } from './windowLimits';
import { WindowList } from './WindowList';
import { IMMERSIVE_DIM_PERCENT, windowStates } from './windowStates';
import { withOpacity } from '../theme/frameMaterial';
import { PERSONA_PRIMARY } from './persona';
import { areaPanDelta } from './areaPan';
import { useAreaViewport } from './useAreaViewport';
import { PresentationInkLayer } from './PresentationInkLayer';
import { WorkspaceOverview } from './WorkspaceOverview';
import { PaneContext, type PaneInfo } from './PaneContext';
import { COMPACT_CELL_HEIGHT, isCompactWidth, stackedLeaves } from './compact';
import { clampInto, nearestFree, overlapArea, placeNew, resizeRect, resolveAround, resolveOverlaps, type PxMap, type PxRect, type ResizeEdge } from './freeLayout';
import { minBorderSize, moveBorder, planSnap, remainingRegion, sharedBorders, type Border } from './snapFloat';
import { PIN_MOVE_REASON, PIN_NO_ROOM_REASON, PIN_RESIZE_REASON, PIN_TABS_REASON, NO_RESIZE_REASON } from './paneActions';
import { paneCommands } from './paneCommands';
import { autoCommands, AUTO_DONE, AUTO_STOPPED, AUTO_UNDONE, AUTO_NO_UNDO, AUTO_NO_ROOM } from './autoCommands';
import { autoTree, treeRects } from './autoLayout';
import { classify } from './tiers';
import { registerCommands } from '../commands/registry';
import { useStepper } from '../store/stepper';
import { useStepFlow } from '../store/stepFlow';
import { planStepFlow, stepRelevance } from '../stepper/flow';
import { useActiveWorkspace, useTaskWorkspaces } from '../store/taskWorkspaces';
import { ZONE_META, hostRect, implicitRoles, placeByRole, zoneLayout, type ZoneName } from './zones';
import { useImmersion } from '../store/immersion';
import { isLetterChord, matchZoneOp } from './os';
import { runZoneOp } from './zoneOps';
import { stepZone } from './immersive';
import { isEditableTarget } from '../components/panelKeys';
import { tr, useLang, useT } from '../i18n';
import { FLIP_PREPARE_EVENT, SPATIAL_MOTION_EASING, SPATIAL_MOTION_MS } from './spatialMotion';

const useStyles = makeStyles({
  // ドラッグ中に、置ける場所をドロップの前に示す（FR-142）。Fluent 2 のブランドの色トークンと 4px グリッド
  drop: {
    position: 'fixed',
    zIndex: 1000,
    pointerEvents: 'none',
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'flex-end',
    justifyContent: 'center',
    backgroundColor: tokens.colorBrandBackground2,
    border: `${tokens.strokeWidthThick} dashed ${tokens.colorBrandStroke1}`,
    borderRadius: tokens.borderRadiusMedium,
  },
  // 画面端のスナップの候補（FR-152）。端のすぐ内側に出し、配置後の見た目は snap-preview で示す
  snapPanel: {
    position: 'fixed', zIndex: 1001, display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalXS,
    padding: tokens.spacingHorizontalS, borderRadius: tokens.borderRadiusLarge, boxShadow: tokens.shadow16,
    backgroundColor: tokens.colorNeutralBackground1, border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke1}`,
  },
  // 上端・下端のときは、候補を横に並べる（縦に並べると作業領域の中ほどまで届いて、範囲外へ戻したあとも候補が残るため）
  snapPanelRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', maxWidth: '90vw' },
  snapButton: { justifyContent: 'flex-start', minWidth: '96px', minHeight: '32px' },
  // スナップした直後に、残った領域を埋めるコンポーネントを選ぶ候補（Snap Assist 相当。FR-152 AC-794）。作業領域の下端に出し、見出しを覆わない
  snapAssist: {
    position: 'absolute', zIndex: 1002, bottom: tokens.spacingVerticalS, display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center',
    columnGap: tokens.spacingHorizontalS, rowGap: tokens.spacingVerticalXS, padding: tokens.spacingHorizontalS, borderRadius: tokens.borderRadiusLarge,
    boxShadow: tokens.shadow16, backgroundColor: tokens.colorNeutralBackground1, border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke1}`,
    transform: 'translateX(-50%)',
  },
  // 隣り合って配置されたコンポーネントの共有する境界のつまみ（FR-152 AC-796）。両側が同時にリサイズされる
  floatSep: { position: 'absolute', zIndex: 700, backgroundColor: 'transparent' },
  snapPreview: {
    position: 'fixed', zIndex: 1000, pointerEvents: 'none', boxSizing: 'border-box', opacity: 0.6, // 配置後の領域を半透明で示す（FR-152 AC-793）
    backgroundColor: tokens.colorBrandBackground2, border: `${tokens.strokeWidthThick} solid ${tokens.colorBrandStroke1}`, borderRadius: tokens.borderRadiusMedium,
  },
  dropLabel: {
    margin: tokens.spacingVerticalS,
    paddingBlock: tokens.spacingVerticalXXS,
    paddingInline: tokens.spacingHorizontalS,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke1}`,
  },
  root: { position: 'relative', display: 'flex', flexDirection: 'column', flex: '1 1 0', minHeight: 0, minWidth: 0 },
  // 操作の結果・できない理由の通知（ピン止めの切替・ピン止め中の移動など。FR-215 AC-494・FR-216 AC-496/505）。支援技術には role=status で伝える
  notice: {
    position: 'absolute', zIndex: 1100, top: tokens.spacingVerticalS, left: '50%', transform: 'translateX(-50%)', maxWidth: '90%',
    paddingBlock: tokens.spacingVerticalXS, paddingInline: tokens.spacingHorizontalM, borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackgroundInverted, color: tokens.colorNeutralForegroundInverted, boxShadow: tokens.shadow8,
    pointerEvents: 'none',
  },
  noticeIdle: { position: 'absolute', width: '1px', height: '1px', overflow: 'hidden', clipPath: 'inset(50%)', whiteSpace: 'nowrap' },
  // 分割の木を入れる箱。拡大表示中は、余白で残りの領域に収める（FR-174）
  // 没入表示の覆い（FR-297）。最大化したコンポーネント（zIndex 900・1000）のすぐ下
  immersiveBackdrop: { position: 'absolute', inset: 0, zIndex: 800 },
  treeBox: { display: 'flex', flexDirection: 'column', flex: '1 1 0', minHeight: 'min(240px, 30vh)', minWidth: 0, boxSizing: 'border-box' },
  // 自由配置・拡大表示のコンポーネントの置き場（作業領域に対する絶対配置。重なりを許す。FR-173）
  floatBox: { position: 'absolute', display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, boxSizing: 'border-box', boxShadow: tokens.shadow16, borderRadius: tokens.borderRadiusMedium, overflow: 'hidden' },
  // 移動中・直後の滑らかな動き（FR-185）。OS の「動きの軽減」が有効なときは途中の動きを省く（AC-394）
  floatAnimated: {
    transitionProperty: 'left, top, width, height',
    transitionDuration: tokens.durationNormal,
    transitionTimingFunction: tokens.curveDecelerateMid,
    '@media (prefers-reduced-motion: reduce)': { transitionDuration: '0s' },
  },
  // 動かしているコンポーネントは、ポインターに短い遅れでつながって動く（フレームごとに動きが見える速さ。FR-185 AC-392）
  floatFollow: {
    ...followDurationOverride,
    transitionProperty: 'left, top, width, height',
    // ポインターへの追従: 等速・短時間（Q-039 A）
    transitionDuration: MOTION.follow.duration,
    transitionTimingFunction: MOTION.follow.easing,
    '@media (prefers-reduced-motion: reduce)': { transitionDuration: '0s' },
  },
  // 境界のドラッグ中は、大きさの変化を滑らかにつなぐ（FR-185 AC-393）
  resizing: {
    '& [data-cell="true"]': {
      ...followDurationOverride,
      transitionProperty: 'flex-grow',
      // ポインターへの追従: 等速・短時間（Q-039 A。遷移のアニメーションの対象外）
      transitionDuration: MOTION.follow.duration,
      transitionTimingFunction: MOTION.follow.easing,
      '@media (prefers-reduced-motion: reduce)': { transitionDuration: '0s' },
    },
  },
  split: { display: 'flex', flex: '1 1 0', minWidth: 0, minHeight: 0 },
  row: { flexDirection: 'row' },
  col: { flexDirection: 'column' },
  cell: { display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 },
  // 最小化したコンポーネントのセル: 見出しだけの高さ（4px グリッド）。空いた領域はほかのセルが使う（FR-151）
  cellMin: { overflow: 'hidden' },
  sep: {
    flex: '0 0 auto',
    backgroundColor: tokens.colorNeutralStroke2,
    ':hover': { backgroundColor: tokens.colorBrandStroke1 },
    ':focus-visible': { outline: `${tokens.strokeWidthThick} solid ${tokens.colorStrokeFocus2}` },
    touchAction: 'none',
  },
  sepV: { width: '8px', cursor: 'col-resize' },
  sepH: { height: '8px', cursor: 'row-resize' },
  tabs: { display: 'flex', flexDirection: 'column', flex: '1 1 0', minWidth: 0, minHeight: 0 },
  tabBody: { display: 'flex', flexDirection: 'column', flex: '1 1 0', minHeight: 0, minWidth: 0 },
  empty: { padding: tokens.spacingHorizontalXXL },
  // 狭い画面・高い拡大率: 分割を縦に積み、全体を縦にスクロールする（NFR-UX-002、NFR-UX-005）
  rootCompact: { flex: '1 0 auto' },
  stack: { display: 'flex', flexDirection: 'column', flex: '0 0 auto', minWidth: 0, rowGap: tokens.spacingVerticalS },
  stackCell: { display: 'flex', flexDirection: 'column', flex: '0 0 auto', minWidth: 0, height: COMPACT_CELL_HEIGHT },
});

const KEY_STEP = 0.02;

/** 最小化したコンポーネントの見出しだけの高さと、横に並べたときの幅（4px グリッド。FR-151） */
export const MINIMIZED_HEIGHT = 64;
/** 木の高さに足す余裕（px）。下限ぎりぎりで主役と詳細が同じ大きさにならず、主役が最大のままになる（FR-296・FR-244） */
const TREE_SLACK = 40;
export const MINIMIZED_WIDTH = 240;

const DRAG_THRESHOLD_PX = 4;
/** マウスで押したコンポーネントを「操作中」にするまでの待ち（ダブルクリックの間隔より長く） */
const POINTER_FOCUS_DELAY_MS = 500;
/** 分割線の上に放したときに、近くのコンポーネントへ寄せる距離（分割線の太さ 8px より少し大きく） */
const SNAP_PX = 12;

/** 画面端に近づけたときの、スナップの候補の状態（FR-152） */
interface SnapState {
  edges: Edge[];
  /** 選んでいる（または既定の）候補 */
  kind: SnapKind;
  opts: SnapOpts;
  /** ポインターの位置（候補の出す位置） */
  px: number;
  py: number;
}

interface DragState {
  key: string;
  target: { key: string; zone: DropZone; rect: DOMRect } | null;
  snap?: SnapState | null;
  /** 自由配置で動かしている間の、すべてのコンポーネントの位置と大きさ（作業領域に対する割合。押し出し済み。ドロップで保存する。FR-173・FR-184） */
  live?: Record<string, FloatRect> | null;
  /** ポインターがピン止めしたコンポーネントの上にある（置き先にならない。FR-216 AC-496） */
  overPinned?: boolean;
}

/** 拡大表示の位置と大きさ（作業領域に対する割合。FR-174・FR-175） */
export function expandRect(pos: ExpandPosition): FloatRect {
  const r = EXPAND_RATIO;
  switch (pos) {
    case 'left': return { x: 0, y: 0, w: r, h: 1 };
    case 'right': return { x: 1 - r, y: 0, w: r, h: 1 };
    case 'bottom': return { x: 0, y: 1 - r, w: 1, h: r };
    default: return { x: 0, y: 0, w: 1, h: r };
  }
}

/** 拡大表示の分だけ、残りのコンポーネントを置く領域を狭める余白（px） */
function expandInset(pos: ExpandPosition, w: number, h: number, treeTop = 0): CSSProperties {
  const r = EXPAND_RATIO;
  switch (pos) {
    case 'left': return { paddingLeft: w * r };
    case 'right': return { paddingRight: w * r };
    case 'bottom': return { paddingBottom: h * r };
    // 木の枠は、領域の上端から treeTop だけ下にある。拡大表示の下端（領域の上から h*r）までを、その分だけ詰めた余白にする
    default: return { paddingTop: Math.max(0, h * r - treeTop) };
  }
}

/** 端からこの距離以内でスナップの候補を出す（PARAM-042） */
const SNAP_EDGE_PX = 32;
/** 候補の表示の周りで、候補を出し続ける余白 */
const SNAP_KEEP_PX = 24;

/** 置き場所の説明（ドロップ先の表示と、読み上げに使う） */
const ZONE_LABEL: Record<DropZone, string> = { left: '左', right: '右', top: '上', bottom: '下', tabs: 'タブへ移動します' };

/** コンポーネントの中の位置（0〜1）から、置き場所を決める。中央はタブにまとめ、それ以外はいちばん近い辺。 */
export function zoneOf(fx: number, fy: number): DropZone {
  if (fx > 0.3 && fx < 0.7 && fy > 0.3 && fy < 0.7) return 'tabs';
  const d = { left: fx, right: 1 - fx, top: fy, bottom: 1 - fy };
  return (Object.keys(d) as Array<'left' | 'right' | 'top' | 'bottom'>).reduce((a, b) => (d[b] < d[a] ? b : a));
}

/** ドロップ先の表示の位置と大きさ（置く側の半分。タブは全体）。 */
function dropRect(r: DOMRect, zone: DropZone): CSSProperties {
  const half = { w: r.width / 2, h: r.height / 2 };
  switch (zone) {
    case 'left': return { left: r.left, top: r.top, width: half.w, height: r.height };
    case 'right': return { left: r.left + half.w, top: r.top, width: half.w, height: r.height };
    case 'top': return { left: r.left, top: r.top, width: r.width, height: half.h };
    case 'bottom': return { left: r.left, top: r.top + half.h, width: r.width, height: half.h };
    default: return { left: r.left, top: r.top, width: r.width, height: r.height };
  }
}

const FILL: CSSProperties = { display: 'flex', flexDirection: 'column', flex: '1 1 0', minWidth: 0, minHeight: 0 };

/**
 * 画面の描画先。画面ごとに 1 つの「ホスト」要素を持ち、画面はそこへポータルで描く（Workspace が所有）。
 * 木の中の位置（スロット）が変わっても、ホストを差し替えるだけなので、画面は再マウントされず useState の状態が残る。
 */
function Slot({ host, hidden }: { host: HTMLElement; hidden?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && host.parentElement !== el) el.appendChild(host);
  });
  return <div ref={ref} style={hidden ? { display: 'none' } : FILL} />;
}

/** 画面の本体を、PaneInfo と画面が変わらない限り再描画しない箱（境界のドラッグ中の再描画を減らす。FR-185 AC-393） */
const PanePortalBody = memo(function PanePortalBody({ Screen, info }: { Screen: ComponentType; info: PaneInfo }) {
  return <PaneContext.Provider value={info}><Screen /></PaneContext.Provider>;
});

/** 境界の両側のコンポーネント（それぞれの先頭のキー）で、動かす分割を決める。自動の調整・最小の幅でタブにまとめた見た目でも、保存した木の正しい境界を動かす。 */
function Separator({ a, b, dir, size, onActive }: { a: string; b: string; dir: 'row' | 'col'; size: number; onActive: (on: boolean) => void }) {
  const s = useStyles();
  const t = useT();
  const resizeAt = useLayout((st) => st.resizeByKeys);
  const start = useRef<{ pos: number; total: number; last: number } | null>(null);
  const vertical = dir === 'row';

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    const parent = e.currentTarget.parentElement;
    if (!parent) return;
    const r = parent.getBoundingClientRect();
    start.current = { pos: vertical ? e.clientX : e.clientY, total: vertical ? r.width : r.height, last: 0 };
    e.currentTarget.setPointerCapture(e.pointerId);
    onActive(true);
    e.preventDefault();
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const st = start.current;
    if (!st || st.total <= 0) return;
    const moved = ((vertical ? e.clientX : e.clientY) - st.pos) / st.total;
    const delta = moved - st.last;
    st.last = moved;
    if (delta !== 0) resizeAt(a, b, delta);
  };
  const end = (e: PointerEvent<HTMLDivElement>) => {
    start.current = null;
    onActive(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const dec = vertical ? 'ArrowLeft' : 'ArrowUp';
    const inc = vertical ? 'ArrowRight' : 'ArrowDown';
    if (e.key === dec) { e.preventDefault(); resizeAt(a, b, -KEY_STEP); }
    else if (e.key === inc) { e.preventDefault(); resizeAt(a, b, KEY_STEP); }
  };

  return (
    <div
      role="separator"
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      aria-label={t('コンポーネントの境界（矢印キーで大きさを変える）')}
      aria-valuemin={10}
      aria-valuemax={90}
      aria-valuenow={Math.round(size * 100)}
      tabIndex={0}
      className={mergeClasses(s.sep, vertical ? s.sepV : s.sepH)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={onKeyDown}
    />
  );
}

export function Workspace({ screens }: { screens: readonly ScreenDefinition[] }) {
  const s = useStyles();
  const t = useT();
  const lang = useLang((st) => st.lang);
  const persona = useLayout((st) => st.persona);
  const stored = useLayout((st) => st.layouts);
  const tierOverrides = useLayout((st) => st.tiers[st.persona]);
  const autoOffMap = useLayout((st) => st.autoOff);
  const autoUndoState = useLayout((st) => st.autoUndo);
  const allTiers = useLayout((st) => st.tiers);
  const base = useMemo(() => effectiveLayout({ persona, layouts: stored, tiers: allTiers, autoOff: autoOffMap }), [persona, stored, allTiers, autoOffMap]);
  const floatMap = useLayout((st) => st.floats[st.persona]);
  const zOrder = useLayout((st) => st.zOrder);
  const expandedKey = useLayout((st) => st.expanded);
  const expandPos = useSettings((st) => st.expandPosition);
  const autoSize = useLayout((st) => st.autoSize);
  const manualKeys = useLayout((st) => st.manual[st.persona]);
  const maximized = useLayout((st) => st.maximized);
  const usedAt = useLayout((st) => st.usedAt);
  const snapMotion = useSnapMotion();
  const minimizedKeys = useLayout((st) => st.minimized[st.persona]);
  const minSet = useMemo(() => new Set(minimizedKeys ?? []), [minimizedKeys]);
  // 前面のコンポーネント（FR-295 の一覧と同じ求め方。FR-297 AC-803: 前面の見出しの強調に使う）
  const frontKey = useMemo(() => {
    const st = windowStates({ keys: screens.filter((sc) => !!sc.component && !sc.modal).map((sc) => sc.key), layout: base, minimized: minSet, closed: new Set(), usedAt });
    return Object.keys(st).find((k) => st[k] === 'front') ?? null;
  }, [screens, base, minSet, usedAt]);
  // 没入表示（FR-297 AC-802）: 最大化中の Esc は、ほかの処理（切替の取消・ドラッグの中止・コンポーネント内の Esc）が先に使わなかったときだけ通常表示に戻す
  useEffect(() => {
    if (maximized === null) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (e.target instanceof Element && e.target.closest('[role="dialog"], [role="menu"], [role="listbox"]')) return;
      useLayout.getState().setMaximized(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [maximized]);
  // ピン止めしたコンポーネントと、ピン止めした位置と大きさ（作業領域に対する割合。FR-215・FR-216）
  const pinnedMap = useLayout((st) => st.pinned[st.persona]);
  const pinSet = useMemo(() => new Set(Object.keys(pinnedMap ?? {})), [pinnedMap]);
  // 操作の結果・できない理由の通知（role=status）
  const [notice, setNotice] = useState<{ text: string; n: number } | null>(null);
  const noticeTimer = useRef<number | null>(null);
  const announce = useCallback((text: string) => {
    setNotice((cur) => ({ text: tr(text), n: (cur?.n ?? 0) + 1 }));
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 4000);
  }, []);
  useEffect(() => () => { if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current); }, []);
  const actions = useLayout.getState;
  const stepIdx = useStepper((st) => st.current);
  const flowSeq = useStepFlow((st) => st.seq);
  const byKey = useCallback((k: string) => screens.find((sc) => sc.key === k), [screens]);
  /** 操作中（フォーカスのある）コンポーネント、最後に選んだタブ、ワークスペースの幅 */
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  // ナビなどで見せると指示されたコンポーネントは、最小幅でタブにまとめた中でも前面にする（非表示のタブにはフォーカスできないため）
  const revealed = useLayout((st) => st.revealed);
  useEffect(() => { if (revealed) setPicked(revealed.key); }, [revealed]);
  // 既定のレイアウトに戻した直後は、操作中の扱いを解く（次にコンポーネントを操作するまで既定の寸法。FR-110 AC-135 / FR-143）
  const resetCount = useLayout((st) => st.resetCount);
  useEffect(() => { if (resetCount > 0) { setFocusKey(null); setPicked(null); snapMem.current.clear(); setAssist(null); } }, [resetCount]);
  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(0);
  const treeRef = useRef<HTMLDivElement>(null);
  const [treeTop, setTreeTop] = useState(0);
  useLayoutEffect(() => {
    const t = treeRef.current;
    const root = rootRef.current;
    if (!t || !root) return;
    const top = Math.round(t.getBoundingClientRect().top - root.getBoundingClientRect().top);
    if (top !== treeTop) setTreeTop(top);
  });
  // 最大化したコンポーネントが作業領域全体を覆うよう、スクロールを先頭へ戻す（FR-296 で木が高くなり、作業領域がスクロールするため。FR-013 AC-592）。
  // 通常表示へ戻るときは、最大化の前のスクロール位置へ戻す（FR-297 AC-802: 最大化の前後で見た目の位置を変えない）
  const maxNowRef = useRef<string | null>(maximized);
  maxNowRef.current = maximized;
  const savedScroll = useRef(0);
  useEffect(() => {
    const ws = rootRef.current?.closest('[data-testid="workspace"]');
    if (!ws) return;
    const onScroll = () => { if (maxNowRef.current === null) savedScroll.current = ws.scrollTop; };
    ws.addEventListener('scroll', onScroll, { passive: true });
    return () => ws.removeEventListener('scroll', onScroll);
  }, []);
  const wasMaximized = useRef(false);
  useEffect(() => {
    const ws = rootRef.current?.closest('[data-testid="workspace"]');
    if (maximized === null) {
      if (wasMaximized.current && ws) ws.scrollTop = savedScroll.current;
      // 操作中の自動の拡大（FR-143）は一時的なものなので、没入表示から戻るときは外し、保存した位置・大きさ（AC-591）へ戻す（FR-297 AC-802）
      if (wasMaximized.current && !compact) setFocusKey(null);
      wasMaximized.current = false;
      return;
    }
    wasMaximized.current = true;
    if (ws) ws.scrollTop = 0;
  }, [maximized]);
  const [drag, setDrag] = useState<DragState | null>(null);
  /** スナップ前の大きさ（作業領域に対する割合。保存しない）。端から引き離したとき、この大きさへ戻す。スナップしたものは、ほかのスナップで動かさない（FR-152 AC-795） */
  const snapMem = useRef(new Map<string, { w: number; h: number }>());
  /** スナップした直後に、残った領域を埋めるコンポーネントを選ぶ候補（FR-152 AC-794） */
  const [assist, setAssist] = useState<{ key: string; rect: FloatRect } | null>(null);
  // 残った領域の候補は、選ばずに閉じても配置は変わらない。Esc・候補の外の操作で閉じる（FR-152 AC-794）
  useEffect(() => {
    if (!assist) return;
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') setAssist(null); };
    const onDown = (e: globalThis.PointerEvent) => { if (!(e.target as Element | null)?.closest?.('[data-testid="snap-assist"]')) setAssist(null); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown, true);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('pointerdown', onDown, true); };
  }, [assist]);
  const dragRef = useRef<DragState | null>(null);
  dragRef.current = drag;
  // 幅が狭い（または拡大率が高い）ときは、分割を縦に積む。レイアウトの木は変えず、描き方だけを替える。
  const rootRef = useRef<HTMLDivElement>(null);
  const { view: areaView, panByKey } = useAreaViewport(rootRef);
  const [narrowWs, setCompact] = useState(false);
  // 木の外に出して描くコンポーネント: 拡大表示中はそれ 1 つだけ（ほかは残りの領域に収める）、それ以外は自由配置したもの（FR-173・FR-174）。
  // 狭い画面（縦積み）では自由配置を使わない。
  const baseKeys = useMemo(() => new Set(keysOf(base)), [base]);
  // ゾーン（FR-298）: ロール（コンポーネント → ゾーン）から求めた各コンポーネントの矩形。出していないゾーンのコンポーネントは描かない（状態は保つ）
  const taskWs = useActiveWorkspace();
  const recalled = useImmersion((st) => st.recalled);
  const zoneSelectedKey = useImmersion((st) => st.selectedKey);
  const zones = useMemo(() => zoneLayout(taskWs.mode, taskWs.ratios, taskWs.merged, recalled), [taskWs.mode, taskWs.ratios, taskWs.merged, recalled]);
  // コンポーネントの役割による分類と階層（主役→補助→詳細。FR-244）。ペルソナの構成と、いま表示中のものを対象にする
  const tierInfo = useMemo(() => classify(persona, [...new Set([...personaKeys(persona), ...baseKeys])], tierOverrides), [persona, baseKeys, tierOverrides, lang]);
  // モード（Research 以外）では、ロールを割り当てていないコンポーネントも、モードの構成で出しているゾーンへ置く（FR-300 AC-815。連続して動く）
  const effectiveRoles = useMemo(() => {
    if (taskWs.mode === 'research') return taskWs.roles;
    return { ...implicitRoles(zones, [...baseKeys], (k) => tierInfo[k]?.tier ?? 'supporting', taskWs.roles), ...taskWs.roles };
  }, [taskWs.mode, taskWs.roles, zones, baseKeys, tierInfo]);
  const zonePlan = useMemo(() => placeByRole(zones, effectiveRoles, [...baseKeys]), [zones, effectiveRoles, baseKeys]);
  const zoneHidden = useMemo(() => new Set(zonePlan.hidden), [zonePlan]);
  // 縮退: 幅が狭いとき、または、ピン止めの比率から求めた幅が最小の幅（PARAM-034）を下回るときは、縦積みにする（FR-216 AC-497）
  const pinTooNarrow = width > 0 && Object.entries(pinnedMap ?? {}).some(([k, r]) => baseKeys.has(k) && r.w * width < MIN_COMPONENT_WIDTH);
  const compact = narrowWs || pinTooNarrow;
  const expandedOut = expandedKey !== null && baseKeys.has(expandedKey) ? expandedKey : null;
  const live = drag?.live ?? null;
  const floatKeys = useMemo(
    () => {
      if (compact || expandedOut) return [];
      const usable = (k: string) => baseKeys.has(k) && !!byKey(k)?.component;
      return [...new Set([...Object.keys(live ?? floatMap ?? {}), ...pinSet])].filter(usable);
    },
    [compact, expandedOut, floatMap, live, baseKeys, byKey, pinSet],
  );
  // 境界のドラッグ中と、移動の直後（押し出された動きが終わるまで）だけ、動きをつなぐ（FR-185）
  const [resizing, setResizing] = useState(false);
  const resizeTimer = useRef<number | null>(null);
  /** 境界のドラッグの間と、放した直後（動きが終わるまで）だけ、大きさの変化をつなぐ（FR-185） */
  const onResizeActive = (on: boolean) => {
    if (resizeTimer.current !== null) { window.clearTimeout(resizeTimer.current); resizeTimer.current = null; }
    if (on) setResizing(true);
    else resizeTimer.current = window.setTimeout(() => setResizing(false), 320);
  };
  const [settling, setSettling] = useState<string | null>(null);
  const playing = useAnimation((st) => st.playing);
  // OS の「動きの軽減」またはアニメーションの停止のときは、途中の動きを省いて結果を直接示す（FR-185 AC-394）
  const motionOn = motionAllowed(playing, prefersReducedMotion());
  const animated = motionOn && (!!live || settling !== null);
  const outKeys = useMemo(() => (expandedOut ? [expandedOut] : floatKeys), [expandedOut, floatKeys]);
  // 隣り合って配置されたコンポーネントの共有する境界（つまみ）。最大化中・移動中は出さない（FR-152 AC-796）
  const floatBorders = useMemo<Border[]>(() => {
    if (expandedOut || maximized !== null || drag || floatKeys.length < 2) return [];
    const rects: Record<string, FloatRect> = {};
    for (const k of floatKeys) { const r = pinnedMap?.[k] ?? floatMap?.[k]; if (r) rects[k] = r; }
    return sharedBorders(rects);
  }, [expandedOut, maximized, drag, floatKeys, floatMap, pinnedMap]);
  const treeBase = useMemo(() => (outKeys.length === 0 ? base : prune(base, new Set([...baseKeys].filter((k) => !outKeys.includes(k))))), [base, baseKeys, outKeys]);
  const inset = expandedOut ? expandInset(expandPos, width, height, treeTop) : undefined;
  // 拡大表示中は「操作中」の更新を止める（復帰したとき、拡大前と同じ大きさに戻すため。FR-174）
  const expandedRef = useRef<string | null>(null);
  expandedRef.current = expandedOut;
  const treeWidth = expandedOut ? (expandPos === 'left' || expandPos === 'right' ? width * (1 - EXPAND_RATIO) : width) : width;
  // 自動のサイズ調整と最小の幅を、描くときだけ適用する。保存するレイアウト（base）は変えない（FR-143、AC-227）。拡大表示中は自動の調整を止める（A-41）。
  const layout = useMemo(() => {
    if (compact) return treeBase;
    const sized = applyAutoSize(treeBase, {
      enabled: autoSize && !expandedOut, focus: focusKey, primary: PERSONA_PRIMARY[persona], manual: new Set(manualKeys ?? []), width: treeWidth,
    });
    const fitted = fitMinWidth(sized, treeWidth, [picked, focusKey]);
    // 自動のサイズ調整・境界の操作・スナップのどれでも、各コンポーネントの幅・高さが PARAM-134・PARAM-135 を下回らないようにする（FR-296 AC-801）
    return fitted && treeWidth > 0 ? enforceMin(fitted, treeWidth, Math.max(height - treeTop, needHeight(fitted) + TREE_SLACK)) : fitted;
  }, [treeBase, compact, autoSize, expandedOut, focusKey, persona, manualKeys, treeWidth, picked, height, treeTop]);

  // FR-299: ゾーンの操作（Snap・Group・Move）の補助。Snap・Group は、割り当て済みのコンポーネントの位置も、ゾーンの矩形へ置き直す
  const [snapNonce, setSnapNonce] = useState(0);
  /** コンポーネントのいるゾーン: ロール、なければ画面上の中心があるゾーン（なければ、出している最初のゾーン） */
  const zoneOfKey = (key: string): ZoneName => {
    const explicit = effectiveRoles[key];
    if (explicit && zones[explicit].rect) return zones[explicit].host;
    const el = rootRef.current?.querySelector(`[data-testid="component-${key}"]`);
    const main = rootRef.current?.closest('[data-testid="workspace"]');
    const shown = (['main', 'reference', 'communication', 'monitor'] as const).filter((n) => zones[n].rect && zones[n].host === n);
    if (el && main) {
      const r = el.getBoundingClientRect();
      const mr = main.getBoundingClientRect();
      const c = mr.width > 0 ? (r.left + r.width / 2 - mr.left) / mr.width : 0;
      const hit = shown.find((n) => { const z = zones[n].rect!; return c >= z.x && c < z.x + z.w; });
      if (hit) return hit;
    }
    return shown.includes('main') ? 'main' : (shown[0] ?? 'main');
  };
  /** 配置の変更でコンポーネントの DOM が移っても、フォーカスをそのコンポーネントに残す */
  const refocus = (key: string): void => {
    const f = (): void => {
      const el = rootRef.current?.querySelector<HTMLElement>(`[data-testid="component-${key}"]`);
      const cur = document.activeElement;
      if (el && el !== cur && (cur === null || cur === document.body || !el.contains(cur))) el.focus({ preventScroll: true });
    };
    for (const ms of [0, 60, 200, 450]) window.setTimeout(f, ms);
  };

  const pane = (key: string, group: string[], active: string): PaneInfo => {
    const a = actions();
    const isMax = maximized === key;
    const isFloat = floatKeys.includes(key);
    const zRank = zOrder.indexOf(key);
    const pinned = pinSet.has(key);
    const label = byKey(key)?.label ?? key;
    const ti = tierInfo[key] ?? { tier: 'supporting' as const, reason: tr('補助: 役割が決まっていない（未分類の）ため、補助として扱い、主役の近く（右）に置きます。'), overridden: false };
    return {
      key,
      pinned,
      tier: ti.tier,
      tierReason: ti.reason,
      tierOverridden: ti.overridden,
      ...(ti.role ? { role: ti.role } : {}),
      ...(ti.group ? { group: ti.group } : {}),
      setTier: (t) => { actions().setTier(key, t); announce(t ? tr('{label}の階層を変更しました', { label }) : tr('{label}の階層を既定に戻しました', { label })); },
      autoOn: !autoOffMap[persona],
      canUndoAuto: autoUndoState?.persona === persona,
      autoRun: () => autoRef.current.run(),
      autoStop: () => autoRef.current.stop(),
      autoUndo: () => autoRef.current.undo(),
      step: stepRelevance(stepIdx, key, screens.map((sc) => sc.key)),
      togglePin: () => {
        // ピン止めを外す: すぐに動かせる（FR-216。一時的な固定）
        if (isPinned(actions(), key)) { actions().setPinned(key, null); announce(tr('{label}のピン止めを外しました', { label })); return; }
        // ピン止めする: いまの位置と大きさを、作業領域に対する比率で保持する。ほかは自由配置にして、重ならない位置に置く（FR-216）
        // 操作中のコンポーネントを大きくする自動の調整（FR-143）は、利用者が置いた配置ではないので、外した配置で測る（ピン止め中は大きさを変えない。FR-143 の例外）
        if (focusKey !== null && !compact) flushSync(() => setFocusKey(null));
        const m = measureAll();
        if (m && m.rects[key]) {
          const next = resolveAround(m.rects, key, m.bounds, pinSet) ?? m.rects;
          const fr = toFractions(next, m.bounds);
          actions().setFloats(fr);
          actions().setPinned(key, fr[key]!);
        } else {
          actions().setPinned(key, floatMap?.[key] ?? { x: 0, y: 0, w: 0.5, h: 0.5 });
        }
        announce(tr('{label}をピン止めしました', { label }));
      },
      maximized: isMax,
      front: frontKey === key,
      expanded: expandedOut === key,
      toggleExpand: () => actions().toggleExpanded(key),
      floating: isFloat,
      toggleFloat: () => {
        if (pinned) { announce(PIN_MOVE_REASON); return; }
        // 自由配置は、すべてのコンポーネントを重ならない位置に置く配置。戻すときは分割の配置にまとめて戻す（FR-173・FR-184）
        if (isFloat || (floatMap && key in floatMap)) { actions().clearFloats(); return; }
        const m = measureAll();
        const r = m?.rects[key];
        if (m && r) commitFree(key, r, m);
      },
      // 重なるのは自由配置のコンポーネントだけ。分割の配置では、手前に出す操作で見た目の位置の基準を変えない（クリックの途中で作業領域のスクロールが動かないように）
      z: isFloat && zRank >= 0 ? 3 + zRank : undefined,
      minimized: minSet.has(key),
      toggleMinimize: () => a.setMinimized(key, !minSet.has(key)),
      visible: group.length === 1 || active === key,
      inTabs: group.length > 1,
      peers: keysOf(layout).filter((k) => !group.includes(k) && !pinSet.has(k)).map((k) => ({ key: k, label: byKey(k)?.label ?? k })),
      toggleMaximize: () => actions().setMaximized(actions().maximized === key ? null : key),
      restore: () => actions().setMaximized(null),
      hide: () => a.hideComponent(key),
      move: (d) => {
        if (pinned) { announce(PIN_MOVE_REASON); return; }
        // 自由配置のコンポーネントは、同じ向きに作業領域の 5% ずつ動かす（ドラッグなしの手段。FR-173 AC-349）。ぶつかるものは押し出す（FR-184）
        const cur = isFloat ? floatMap?.[key] : undefined;
        const m = cur ? measureAll() : null;
        if (!cur || !m) { a.moveComponent(key, d); return; }
        const step = 0.05;
        const next = clampFloat({ ...cur, x: cur.x + (d === 'right' ? step : d === 'left' ? -step : 0), y: cur.y + (d === 'down' ? step : d === 'up' ? -step : 0) });
        commitFree(key, { x: next.x * m.bounds.w, y: next.y * m.bounds.h, w: next.w * m.bounds.w, h: next.h * m.bounds.h }, m, false);
      },
      toggleDirection: () => (pinned ? announce(PIN_MOVE_REASON) : a.toggleDirection(key)),
      snapTo: (kind) => applySnap(key, kind, { tabTarget: keysOf(layout).find((k) => !group.includes(k) && !pinSet.has(k)) }),
      snapKinds: snapKindsFor(compact),
      mergeInto: (t) => (pinned || pinSet.has(t) ? announce(PIN_TABS_REASON) : a.mergeTabs(key, t)),
      untab: () => (pinned ? announce(PIN_TABS_REASON) : a.untab(key)),
      startDrag: (e) => startDrag(key, e),
      resizeBy: (axis, dir) => resizeByStep(key, axis, dir),
      startResize: (edge, e) => startResize(key, edge, e),
      ...(taskWs.roles[key] ? { zone: taskWs.roles[key] } : {}),
      assignZone: (z) => { useTaskWorkspaces.getState().assign(key, z); announce(z ? tr('{label}を {zone} のロールへ割り当てました', { label, zone: ZONE_META[z].label }) : tr('{label}のロールの割り当てを外しました', { label })); },
      zoneSelected: zoneSelectedKey === key,
      // FR-299: ゾーン間の移動（Move）。ロールを変えるだけで座標は指定しない。ゾーンの選択とフォーカスは保つ
      moveZone: (dir) => {
        if (pinned) { announce(PIN_MOVE_REASON); return; }
        const to = stepZone(zones, zoneOfKey(key), dir);
        if (!to) { announce(tr('移動できるゾーンがありません')); return; }
        useTaskWorkspaces.getState().assign(key, to);
        useImmersion.getState().select(key);
        announce(tr('{label}を {zone} へ移動しました', { label, zone: ZONE_META[to].label }));
        refocus(key);
      },
      // FR-299: ゾーンへ吸着（Snap）。いるゾーンの矩形へ置き直す
      snapZone: () => {
        if (pinned) { announce(PIN_MOVE_REASON); return; }
        const z = zoneOfKey(key);
        useTaskWorkspaces.getState().assign(key, z);
        setSnapNonce((n) => n + 1);
        useImmersion.getState().select(key);
        announce(tr('{label}を {zone} へスナップしました', { label, zone: ZONE_META[z].label }));
        refocus(key);
      },
      // FR-299: 同じグループのコンポーネントを、同じゾーンへまとめる（Group）
      groupZone: () => {
        const z = zoneOfKey(key);
        const g = ti.group;
        const mates = g ? [...baseKeys].filter((k) => k !== key && tierInfo[k]?.group === g && !pinSet.has(k)) : [];
        if (mates.length === 0) { announce(tr('同じグループのコンポーネントがありません')); return; }
        const st = useTaskWorkspaces.getState();
        st.assign(key, z);
        for (const k of mates) st.assign(k, z);
        setSnapNonce((n) => n + 1);
        useImmersion.getState().select(key);
        announce(tr('{n} 個のコンポーネントを {zone} へまとめました', { n: mates.length + 1, zone: ZONE_META[z].label }));
        refocus(key);
      },
    };
  };

  /**
   * 各コンポーネントへ渡す PaneInfo を、値が変わらない限り同じ参照にする。境界のドラッグ中などに作業領域が再描画されても、
   * 中身の画面（重い）を再描画しないため（FR-185 AC-393）。操作の関数は、呼ばれた時点の最新の関数に委ねる（古い状態を掴まない）。
   */
  const paneCache = useRef(new Map<string, { sig: string; info: PaneInfo; latest: PaneInfo }>());
  const stablePane = (key: string, group: string[], active: string): PaneInfo => {
    const fresh = pane(key, group, active);
    const data: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fresh)) if (typeof v !== 'function') data[k] = v;
    const sig = JSON.stringify(data);
    const hit = paneCache.current.get(key);
    if (hit && hit.sig === sig) { hit.latest = fresh; return hit.info; }
    const entry: { sig: string; info: PaneInfo; latest: PaneInfo } = { sig, info: fresh, latest: fresh };
    const info: Record<string, unknown> = { ...data };
    for (const [k, v] of Object.entries(fresh)) {
      if (typeof v === 'function') info[k] = (...args: unknown[]) => (entry.latest as unknown as Record<string, (...a: unknown[]) => unknown>)[k]!(...args);
    }
    entry.info = info as unknown as PaneInfo;
    paneCache.current.set(key, entry);
    return entry.info;
  };

  /** 作業領域の中のすべてのコンポーネントの位置と大きさ（px。作業領域の左上が原点）と、作業領域の大きさ。測れなければ null（FR-184） */
  const measureAll = (): { rects: PxMap; bounds: { w: number; h: number }; viewport: Record<string, DOMRect> } | null => {
    const root = rootRef.current;
    if (!root || compact) return null;
    const a = root.getBoundingClientRect();
    if (a.width <= 0 || a.height <= 0) return null;
    const rects: PxMap = {};
    const viewport: Record<string, DOMRect> = {};
    const elOf = (k: string) => root.querySelector(`[data-testid="component-${k}"]`);
    for (const k of baseKeys) {
      if (!byKey(k)?.component) continue;
      let r = elOf(k)?.getBoundingClientRect();
      // 非表示のタブは、同じまとまりの前面のコンポーネントと同じ場所にある扱い（置いたあと、押し出しで分かれる）
      if (!r || r.width <= 0 || r.height <= 0) { const act = groups.get(k)?.active; r = act ? elOf(act)?.getBoundingClientRect() : undefined; }
      if (!r || r.width <= 0 || r.height <= 0) continue;
      viewport[k] = r;
      // ピン止めしたものは、保持している比率の位置と大きさ（測った値の丸め誤差を持ち込まない）
      const pr = floatKeys.includes(k) ? pinnedMap?.[k] : undefined;
      rects[k] = pr
        ? { x: pr.x * a.width, y: pr.y * a.height, w: pr.w * a.width, h: pr.h * a.height }
        : clampInto({ x: r.left - a.left, y: r.top - a.top, w: r.width, h: r.height }, { w: a.width, h: a.height });
    }
    return { rects, bounds: { w: a.width, h: a.height }, viewport };
  };
  const toFractions = (m: PxMap, b: { w: number; h: number }): Record<string, FloatRect> =>
    Object.fromEntries(Object.entries(m).map(([k, r]) => [k, { x: r.x / b.w, y: r.y / b.h, w: r.w / b.w, h: r.h / b.h }]));
  /** `key` を `target` に置き、すべてを自由配置として保存する（FR-173・FR-184）。`push` のときは、ぶつかるものを押し出す。
   * 自由な移動（`push` なし）は、Windows のウィンドウと同様に重なりを許し、掴んだものを手前に出す（Q-066 B 2026-10-27）。 */
  const commitFree = (key: string, target: PxRect, m: NonNullable<ReturnType<typeof measureAll>>, push = true): boolean => {
    if (!push) {
      // ピン止めしたものには重ねない（FR-216 AC-496・AC-505）。置き場所がなければ、元の位置のまま理由を示す
      const fixedRects = [...pinSet].filter((k) => k !== key && m.rects[k]).map((k) => m.rects[k]!);
      const placed = fixedRects.length > 0 ? nearestFree(clampInto(target, m.bounds), fixedRects, m.bounds) : clampInto(target, m.bounds);
      if (!placed) { announce(PIN_NO_ROOM_REASON); return false; }
      actions().setFloats(toFractions({ ...m.rects, [key]: placed }, m.bounds));
      actions().raise(key);
      actions().markMoved(key);
      snapMem.current.delete(key);
      return true;
    }
    // ピン止めしたものは動かさない。置き場所が残っていなければ、元の位置のまま理由を示す（FR-216 AC-496・AC-505）
    const next = resolveAround({ ...m.rects, [key]: target }, key, m.bounds, pinSet, manualSet());
    if (!next) { announce(PIN_NO_ROOM_REASON); return false; }
    actions().setFloats(toFractions(next, m.bounds));
    actions().markMoved(key);
    return true;
  };

  /** スナップ先の領域（px）へ `key` を置き、ほかを重ならない位置へ動かす（FR-152・FR-184）。置けなければ false */
  const placeSnapped = (key: string, target: PxRect, m: NonNullable<ReturnType<typeof measureAll>>): boolean => {
    const cur = m.rects[key];
    if (!cur) return false;
    const anchors = new Set([...snapMem.current.keys()].filter((k) => k !== key && k in m.rects));
    const next = planSnap(m.rects, key, target, m.bounds, { fixed: pinSet, anchors, keep: manualSet() });
    if (!next) { announce(PIN_NO_ROOM_REASON); return false; }
    if (!snapMem.current.has(key)) snapMem.current.set(key, { w: cur.w / m.bounds.w, h: cur.h / m.bounds.h });
    actions().setFloats(toFractions(next, m.bounds));
    actions().markMoved(key);
    markManual(key);
    return true;
  };

  /** 候補（左半分・右半分・上半分・下半分・4 分割・3 分割・タブ化・最大化）の配置を行う。ドラッグ・メニュー・キーボード・コマンドで共通（FR-152 AC-265・AC-266） */
  const applySnap = (key: string, kind: SnapKind, opts: SnapOpts, from?: NonNullable<ReturnType<typeof measureAll>> | null): void => {
    if (pinSet.has(key)) { announce(PIN_MOVE_REASON); return; }
    const st = actions();
    setAssist(null);
    // 最大化: ほかのコンポーネントは元の配置のまま背面へ回る（解除・引き離しで元の配置に戻る。A-75）
    if (kind === 'maximize') {
      // 最大化するものを自由配置の置き場に移し、作業領域いっぱいに最前面で示す。ほかは元の位置のまま背面に残る（解除すると元の配置で見える）
      const m0 = compact ? null : (from ?? measureAll());
      if (m0 && m0.rects[key] && !(floatMap && key in floatMap)) st.setFloats(toFractions(m0.rects, m0.bounds));
      st.setMaximized(key);
      return;
    }
    if (st.maximized) st.setMaximized(null);
    const m = compact || kind === 'tabs' ? null : (from ?? measureAll());
    if (!m || !m.rects[key]) { st.snapTo(key, kind, opts); return; }
    const t = snapRect({ left: 0, top: 0, width: m.bounds.w, height: m.bounds.h }, kind, opts, null);
    if (!placeSnapped(key, { x: t.left, y: t.top, w: t.width, h: t.height }, m)) return;
    const rem = remainingRegion(kind, opts);
    if (rem && Object.keys(m.rects).some((k) => k !== key && !pinSet.has(k))) setAssist({ key, rect: rem });
  };
  /** 残った領域を埋めるコンポーネントを選ぶ（Snap Assist）。その領域いっぱいに配置される（FR-152 AC-794） */
  const fillRemaining = (key: string): void => {
    const a = assist;
    setAssist(null);
    const m = measureAll();
    if (!a || !m || !m.rects[key]) return;
    placeSnapped(key, { x: a.rect.x * m.bounds.w, y: a.rect.y * m.bounds.h, w: a.rect.w * m.bounds.w, h: a.rect.h * m.bounds.h }, m);
  };

  /** 共有する境界のドラッグ・キーボードでの移動。境界の両側が同時に変わり、隙間も重なりも生じない（FR-152 AC-796） */
  const shiftBorder = (bd: Border, base: Record<string, FloatRect>, deltaPx: number, bounds: { w: number; h: number }): void => {
    const unit = bd.dir === 'v' ? bounds.w : bounds.h;
    if (unit <= 0) return;
    actions().setFloats(moveBorder(base, bd, deltaPx / unit, minBorderSize(bd.dir, bounds)));
  };
  const startBorder = (bd: Border, e: PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    if ([...bd.before, ...bd.after].some((k) => pinSet.has(k))) { announce(PIN_RESIZE_REASON); return; }
    const area = rootRef.current?.getBoundingClientRect();
    const base: Record<string, FloatRect> = {};
    for (const k of [...bd.before, ...bd.after]) { const r = pinnedMap?.[k] ?? floatMap?.[k]; if (r) base[k] = { ...r }; }
    if (!area || Object.keys(base).length === 0) return;
    const bounds = { w: area.width, h: area.height };
    const sx = e.clientX;
    const sy = e.clientY;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    e.preventDefault();
    for (const k of [...bd.before, ...bd.after]) markManual(k);
    const move = (ev: globalThis.PointerEvent) => shiftBorder(bd, base, bd.dir === 'v' ? ev.clientX - sx : ev.clientY - sy, bounds);
    const end = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', end);
      el.removeEventListener('pointercancel', end);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  };
  const keyBorder = (bd: Border, e: KeyboardEvent<HTMLDivElement>): void => {
    const dec = bd.dir === 'v' ? 'ArrowLeft' : 'ArrowUp';
    const inc = bd.dir === 'v' ? 'ArrowRight' : 'ArrowDown';
    if (e.key !== dec && e.key !== inc) return;
    e.preventDefault();
    if ([...bd.before, ...bd.after].some((k) => pinSet.has(k))) { announce(PIN_RESIZE_REASON); return; }
    const area = rootRef.current?.getBoundingClientRect();
    if (!area) return;
    const base: Record<string, FloatRect> = {};
    for (const k of [...bd.before, ...bd.after]) { const r = pinnedMap?.[k] ?? floatMap?.[k]; if (r) base[k] = { ...r }; }
    const unit = bd.dir === 'v' ? area.width : area.height;
    shiftBorder(bd, base, (e.key === inc ? KEY_STEP : -KEY_STEP) * unit, { w: area.width, h: area.height });
  };

  /** 自動配置の実行（FR-243）。優先は ①ピン止め ②手で動かした・大きさを変えた配置 ③自動配置。自動配置はそれ以外だけを対象にする */
  const runAuto = () => {
    const st = actions();
    if (focusKey !== null && !compact) flushSync(() => setFocusKey(null));
    st.saveAutoUndo();
    const m = measureAll();
    const fixedKeys = new Set([...pinSet, ...(st.moved[st.persona] ?? []), ...(st.manual[st.persona] ?? [])].filter((k) => baseKeys.has(k)));
    if (fixedKeys.size === 0 || !m) {
      // 固定するものがない（またはコンパクト表示）: 配置全体を階層に合わせて組み直す
      st.runAutoTree();
      announce(AUTO_DONE);
      return;
    }
    // 固定するものがある: それらはいまの位置と大きさのまま、ほかを階層に合わせて並べ、固定したものに重なるときは押し出す
    const free = Object.keys(m.rects).filter((k) => !fixedKeys.has(k));
    const info = classify(st.persona, [...new Set([...personaKeys(st.persona), ...Object.keys(m.rects)])], st.tiers[st.persona]);
    const auto = treeRects(autoTree(free, info), m.bounds);
    let rects: PxMap = { ...auto };
    for (const k of fixedKeys) if (m.rects[k]) rects[k] = m.rects[k]!;
    for (const k of fixedKeys) {
      const next = resolveAround(rects, k, m.bounds, fixedKeys);
      if (!next) { st.undoAuto(); announce(AUTO_NO_ROOM); return; }
      rects = next;
    }
    st.setAutoOff(false);
    st.setFloats(toFractions(rects, m.bounds));
    // 動いた分だけ、動きをつなぐ（FR-185。動きの軽減が有効なときは途中を省く）
    setSettling(null);
    announce(AUTO_DONE);
  };
  /** 自動配置の停止: いまの配置をそのまま保ち（自由配置として固定）、以後の追加で既存の配置を動かさない */
  const stopAuto = () => {
    const st = actions();
    if (focusKey !== null && !compact) flushSync(() => setFocusKey(null));
    const m = measureAll();
    if (m && Object.keys(floatMap ?? {}).length === 0) st.setFloats(toFractions(m.rects, m.bounds));
    st.setAutoOff(true);
    announce(AUTO_STOPPED);
  };
  const undoAuto = () => announce(actions().undoAuto() ? AUTO_UNDONE : AUTO_NO_UNDO);
  const autoRef = useRef({ run: runAuto, stop: stopAuto, undo: undoAuto });
  autoRef.current = { run: runAuto, stop: stopAuto, undo: undoAuto };
  useEffect(() => registerCommands(() => autoCommands({ run: () => autoRef.current.run(), stop: () => autoRef.current.stop(), undo: () => autoRef.current.undo() })), []);

  // 業務分析のステップのクリック: 関連するコンポーネントを工程の順に左上から右下へ、重要度に応じた大きさで並べ、関連しないものはその後ろに最小の大きさで並べる（FR-228）。
  // ピン止めしたものは動かさず、手で変えた大きさは上書きしない。直前の配置は「元に戻す」のために覚える。
  const flowRun = useRef<() => void>(() => undefined);
  flowRun.current = () => {
    const m = measureAll();
    if (!m) { announce(tr('この画面の幅では、ステップに合わせた再配置はできません')); return; }
    const L = actions();
    const keys = Object.keys(m.rects).sort((p, q) => (m.rects[p]!.y - m.rects[q]!.y) || (m.rects[p]!.x - m.rects[q]!.x));
    const pinned: Record<string, PxRect> = {};
    for (const k of keys) if (pinSet.has(k)) pinned[k] = m.rects[k]!;
    const manual: Record<string, { w: number; h: number }> = {};
    for (const k of manualKeys ?? []) if (m.rects[k] && !pinSet.has(k)) manual[k] = { w: m.rects[k]!.w, h: m.rects[k]!.h };
    const plan = planStepFlow({ step: useStepFlow.getState().step, keys, bounds: m.bounds, pinned, manual });
    if (L.expanded) L.setExpanded(null);
    L.setFloats(toFractions(plan, m.bounds));
  };
  const flowSeen = useRef(flowSeq);
  useEffect(() => {
    if (flowSeq === flowSeen.current) return;
    flowSeen.current = flowSeq;
    const id = window.requestAnimationFrame(() => flowRun.current());
    return () => window.cancelAnimationFrame(id);
  }, [flowSeq]);

  // 自由配置があるとき、あとから分割の木へ入ったコンポーネント（再表示など）は、空いた場所へ置く。木のものが自由配置と重ならないようにする（FR-184）
  // ピン止めしたもので、自由配置に位置がないもの（非表示から再表示したものなど）も、ピン止めした位置へ置き直す（FR-216 AC-505）
  const treeFree = useMemo(() => {
    if (compact || expandedOut || floatKeys.length === 0) return [];
    const pending = [...pinSet].filter((k) => baseKeys.has(k) && !!byKey(k)?.component && !(floatMap && k in floatMap));
    return [...pending, ...keysOf(treeBase).filter((k) => !!byKey(k)?.component)];
  }, [compact, expandedOut, floatKeys, treeBase, byKey, pinSet, baseKeys, floatMap]);
  useEffect(() => {
    if (drag || treeFree.length === 0 || width <= 0 || height <= 0) return;
    const b = { w: width, h: height };
    let rects: PxMap = {};
    for (const [k, r] of Object.entries(floatMap ?? {})) if (baseKeys.has(k)) rects[k] = clampInto({ x: r.x * b.w, y: r.y * b.h, w: r.w * b.w, h: r.h * b.h }, b);
    for (const k of treeFree) {
      const pr = pinnedMap?.[k];
      if (pr) {
        // ピン止めしたものが再表示されたとき: ピン止めした比率の位置に戻し、そこにあるものを押し出す（FR-216 AC-505）
        const others = new Set([...pinSet].filter((p) => p !== k && p in rects));
        const at = { x: pr.x * b.w, y: pr.y * b.h, w: pr.w * b.w, h: pr.h * b.h };
        rects = resolveAround({ ...rects, [k]: at }, k, b, others) ?? resolveOverlaps({ ...rects, [k]: at }, k, b);
      } else {
        const fixed = new Set([...pinSet].filter((p) => p in rects));
        // 非表示にする前の場所が空いていれば、そこへ戻す（ほかを動かさない。FR-243）。空いていなければ空きを探す
        const prev = useLayout.getState().hiddenRects[useLayout.getState().persona]?.[k];
        const back = prev ? clampInto({ x: prev.x * b.w, y: prev.y * b.h, w: prev.w * b.w, h: prev.h * b.h }, b) : null;
        if (back && Object.values(rects).every((o) => overlapArea(back, o) <= 4)) { rects = { ...rects, [k]: back }; continue; }
        const placed = placeNew(rects, k, { w: b.w * 0.3, h: b.h * 0.4 }, b);
        // 新しく置いたものがピン止めしたものを動かしたときは、ピン止めしたものを動かさずに置き直す
        const moved = [...fixed].some((p) => placed[p]!.x !== rects[p]!.x || placed[p]!.y !== rects[p]!.y || placed[p]!.w !== rects[p]!.w || placed[p]!.h !== rects[p]!.h);
        rects = moved ? (resolveAround({ ...rects, [k]: placed[k]! }, k, b, fixed) ?? placed) : placed;
      }
    }
    actions().setFloats(toFractions(rects, b));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [treeFree, width, height]);

  // ゾーンのロールを割り当てたコンポーネントを、ゾーンの矩形へ置く（FR-298 AC-805〜807）。ゾーンの割合・モード・結合・ロールが変わったときだけ。
  // 置くのは自由配置（FR-173）と同じ手段（setFloats）で、重ならない配置になる（FR-109）。ほかのコンポーネントは、スナップ（FR-152）と同じく重ならない位置へ押し出す。
  const zoneApplied = useRef('');
  /** 直前に適用したモード（Research から出るとき、出る前の自由配置を覚え、Research へ戻るとき復元する。FR-300: 解除すると直前の配置に戻る） */
  const zoneMode = useRef<{ id: string; mode: string } | null>(null);
  const preFloats = useRef<{ id: string; map: Record<string, FloatRect> } | null>(null);
  /** 切替の前のコンポーネントの位置・大きさ。切替の後に、元の位置から連続して動かす（FLIP。FR-300 AC-815） */
  const flipFrom = useRef<{ at: number; rects: Map<string, DOMRect> } | null>(null);
  const recordFlip = (): void => {
    const root = rootRef.current;
    if (!root) return;
    const rects = new Map<string, DOMRect>();
    for (const k of baseKeys) {
      const el = root.querySelector(`[data-testid="component-${k}"]`);
      const r = el?.getBoundingClientRect();
      if (r && r.width > 1 && r.height > 1) rects.set(k, r);
    }
    flipFrom.current = { at: performance.now(), rects };
  };
  const zoneSig = JSON.stringify([taskWs.id, persona, taskWs.mode, taskWs.ratios, taskWs.merged, effectiveRoles, recalled, snapNonce, [...baseKeys].sort()]);
  useEffect(() => {
    if (compact || expandedOut || width <= 0 || height <= 0) return;
    const assigned = Object.keys(zonePlan.rects).filter((k) => baseKeys.has(k) && !!byKey(k)?.component);
    const lost = zonePlan.hidden.filter((k) => baseKeys.has(k) && !!byKey(k)?.component && !(floatMap && k in floatMap));
    if (zoneApplied.current === zoneSig) return;
    const root = rootRef.current;
    const main = root?.closest('[data-testid="workspace"]');
    if (!root || !main) return;
    const prevMode = zoneMode.current && zoneMode.current.id === taskWs.id ? zoneMode.current.mode : null;
    zoneMode.current = { id: taskWs.id, mode: taskWs.mode };
    if (prevMode === 'research' && taskWs.mode !== 'research') preFloats.current = { id: taskWs.id, map: JSON.parse(JSON.stringify(floatMap ?? {})) as Record<string, FloatRect> };
    const restore = taskWs.mode === 'research' && prevMode !== null && prevMode !== 'research' && preFloats.current?.id === taskWs.id ? preFloats.current.map : null;
    if (restore) preFloats.current = null;
    if (assigned.length === 0 && lost.length === 0 && !restore) { zoneApplied.current = zoneSig; return; }
    const rr = root.getBoundingClientRect();
    const mr = main.getBoundingClientRect();
    const bounds = { w: rr.width, h: rr.height };
    // ゾーンの矩形（main に対する割合）を、作業領域（root）の px にする。root の外へ出る分は切る
    const toPx = (z: { x: number; y: number; w: number; h: number }): PxRect | null => {
      const x0 = Math.max(0, mr.left - rr.left + z.x * mr.width);
      const y0 = Math.max(0, mr.top - rr.top + z.y * mr.height);
      const x1 = Math.min(bounds.w, mr.left - rr.left + (z.x + z.w) * mr.width);
      const y1 = Math.min(bounds.h, mr.top - rr.top + (z.y + z.h) * mr.height);
      return x1 - x0 > 1 && y1 - y0 > 1 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
    };
    const targets: PxMap = {};
    for (const k of assigned) { const p = toPx(zonePlan.rects[k]!); if (p) targets[k] = p; }
    // すでにその位置にあれば（再読込・別のウィンドウで開いたとき）、何もしない
    const near = (k: string): boolean => {
      const f = floatMap?.[k]; const t0 = targets[k];
      return !!f && !!t0 && Math.abs(f.x * bounds.w - t0.x) < 3 && Math.abs(f.y * bounds.h - t0.y) < 3 && Math.abs(f.w * bounds.w - t0.w) < 3 && Math.abs(f.h * bounds.h - t0.h) < 3;
    };
    if (Object.keys(targets).every(near) && lost.length === 0 && !restore) { zoneApplied.current = zoneSig; return; }
    const m = measureAll();
    let rects: PxMap = restore ? {} : { ...(m?.rects ?? {}) };
    for (const [k, f] of Object.entries(restore ?? floatMap ?? {})) if (!(k in rects) && baseKeys.has(k)) rects[k] = clampInto({ x: f.x * bounds.w, y: f.y * bounds.h, w: f.w * bounds.w, h: f.h * bounds.h }, bounds);
    const fixed = new Set(pinSet);
    for (const k of Object.keys(targets)) {
      const next = planSnap(rects, k, targets[k]!, bounds, { fixed: new Set(fixed), anchors: new Set(), keep: manualSet() });
      rects = next ?? { ...rects, [k]: clampInto(targets[k]!, bounds) };
      rects[k] = clampInto(targets[k]!, bounds);
      fixed.add(k);
    }
    // 出していないゾーンのコンポーネントは、既定の割合のときの自分のゾーンの位置を持たせる（描かない。出すと同じ場所へ戻る）
    const base0 = zoneLayout('research', taskWs.ratios, []);
    for (const k of lost) {
      const r0 = hostRect(base0, effectiveRoles[k]!);
      const p = r0 ? toPx(r0) : null;
      if (p) rects[k] = p;
    }
    zoneApplied.current = zoneSig;
    recordFlip();
    if (restore) actions().clearFloats();
    if (Object.keys(rects).length > 0) actions().setFloats(toFractions(rects, bounds));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoneSig, width, height, compact, expandedOut]);

  // 切替の前の位置・大きさから、切替の後の位置・大きさへ、連続して動かす（モード・ゾーン・タスクワークスペースの切替。FR-300 AC-815）。
  // 動きの軽減・アニメーション停止中は、動かさずに最終の配置を示す（FR-071）。要素の transform だけを動かし、配置の計算（保存する値）は変えない
  useLayoutEffect(() => {
    const f = flipFrom.current;
    if (!f) return;
    if (performance.now() - f.at > 700) { flipFrom.current = null; return; }
    const root = rootRef.current;
    if (!root) return;
    let moved = false;
    for (const [k, from] of f.rects) {
      const el = root.querySelector<HTMLElement>(`[data-testid="component-${k}"]`);
      if (!el) continue;
      const to = el.getBoundingClientRect();
      if (to.width < 1 || to.height < 1) continue;
      const dx = from.left - to.left; const dy = from.top - to.top;
      const sx = from.width / to.width; const sy = from.height / to.height;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01) continue;
      moved = true;
      if (!motionAllowed(useAnimation.getState().playing, prefersReducedMotion()) || typeof el.animate !== 'function') continue;
      el.animate(
        [{ transformOrigin: '0 0', transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` }, { transformOrigin: '0 0', transform: 'none' }],
        { duration: SPATIAL_MOTION_MS, easing: SPATIAL_MOTION_EASING },
      );
    }
    if (moved) flipFrom.current = null;
  });
  // タスクワークスペースの切替の前に、いまの位置を記録する（taskContext.ts が通知する）
  useEffect(() => {
    const on = (): void => recordFlip();
    window.addEventListener(FLIP_PREPARE_EVENT, on);
    return () => window.removeEventListener(FLIP_PREPARE_EVENT, on);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // FR-299: Ctrl+Alt+キー（macOS の表示は ⌃⌥）の 5 つの操作と Focus の切替。Win キー・⌘ + 方向キーは使わない（ブラウザーが横取りできない）。
  // 押下は物理キーで判別する（macOS の Option は文字を変える）。ダイアログ・メニューの中、入力欄の中の文字のキーでは動かさない（AltGr との衝突を避ける）。
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      const op = matchZoneOp(e);
      if (!op || e.defaultPrevented || e.repeat) return;
      const t0 = e.target as Element | null;
      if (t0?.closest?.('[role="dialog"], [role="menu"], [role="listbox"], [role="alertdialog"]')) return;
      if (isLetterChord(op) && isEditableTarget(e.target)) return;
      e.preventDefault();
      runZoneOp(op, currentPane.current(), announce);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [announce]);

  const hosts = useRef(new Map<string, HTMLElement>());
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const measure = () => { const r = el.getBoundingClientRect(); setWidth(r.width); setHeight(r.height); setCompact(isCompactWidth(r.width)); setWorkspaceArea(r.width, r.height); };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const hostOf = (key: string): HTMLElement => {
    let h = hosts.current.get(key);
    if (!h) {
      h = document.createElement('div');
      h.dataset.host = key;
      Object.assign(h.style, { display: 'flex', flexDirection: 'column', flex: '1 1 0', minWidth: '0', minHeight: '0' });
      hosts.current.set(key, h);
    }
    return h;
  };
  /** 画面のキー → 同じタブのまとまり（portal に渡す文脈用） */
  const groups = new Map<string, { tabs: string[]; active: string }>();
  const collect = (n: LayoutNode): void => {
    if (n.kind === 'tabs') n.tabs.forEach((k) => groups.set(k, { tabs: n.tabs, active: n.active }));
    else n.children.forEach(collect);
  };
  if (layout) collect(layout);
  outKeys.forEach((k) => groups.set(k, { tabs: [k], active: k }));

  // 見出しのメニューの操作を、コマンドパレットからも実行できるようにする（操作中のコンポーネントが対象。NFR-UX-018 AC-481・FR-215 AC-494）
  const lastPaneKey = useRef<string | null>(null);
  const currentPane = useRef<() => PaneInfo | null>(() => null);
  currentPane.current = () => {
    const k = focusKey ?? lastPaneKey.current;
    const g = k ? groups.get(k) : undefined;
    return k && g ? pane(k, g.tabs, g.active) : null;
  };
  useEffect(() => registerCommands(() => paneCommands(() => currentPane.current(), announce)), [announce]);

  const renderLeaf = (key: string, hidden = false) => {
    if (!byKey(key)?.component) return null;
    return <Slot key={key} host={hostOf(key)} hidden={hidden} />;
  };

  const render = (node: LayoutNode, path: Path): JSX.Element => {
    if (node.kind === 'tabs') {
      if (node.tabs.length === 1) return <div className={s.tabs} key={path.join('.')}>{renderLeaf(node.tabs[0]!)}</div>;
      return (
        <div className={s.tabs} key={path.join('.')}>
          <TabList
            size="small"
            selectedValue={node.active}
            onTabSelect={(_, d) => { setPicked(String(d.value)); useLayout.getState().activateTab(String(d.value)); }}
          >
            {node.tabs.map((k) => <Tab key={k} value={k}>{byKey(k)?.label ?? k}</Tab>)}
          </TabList>
          {/* 非表示のタブも描画したまま display で隠し、タブを切り替えても状態を保つ */}
          <div className={s.tabBody}>{node.tabs.map((k) => renderLeaf(k, k !== node.active))}</div>
        </div>
      );
    }
    return renderSplit(node, path);
  };

  const renderSplit = (node: SplitNode, path: Path): JSX.Element => {
    const isFolded = (child: LayoutNode): boolean => keysOf(child).every((k) => minSet.has(k)) && maximized === null;
    // 畳んだセルがあるとき、残りのセルの伸びる割合の合計を 1 にそろえる（合計が 1 未満だと、空いた領域を使い切らない）
    const open = node.children.reduce((sum, c, i) => (isFolded(c) ? sum : sum + (node.sizes[i] ?? 0)), 0);
    const anyFolded = node.children.some(isFolded);
    return (
    <div className={mergeClasses(s.split, node.dir === 'row' ? s.row : s.col)} key={path.join('.')}>
      {node.children.flatMap((child, i) => {
        const folded = isFolded(child);
        const cellStyle: CSSProperties = folded
          ? (node.dir === 'row'
            ? { flex: `0 0 ${MINIMIZED_WIDTH}px`, alignSelf: 'flex-start', height: MINIMIZED_HEIGHT }
            : { flex: `0 0 ${MINIMIZED_HEIGHT}px` })
          : { flex: `${anyFolded && open > 0 ? (node.sizes[i] ?? 0) / open : node.sizes[i]} 1 0` };
        const cell = (
          <div key={`c${i}`} data-cell="true" className={mergeClasses(s.cell, folded ? s.cellMin : undefined)} style={cellStyle} data-folded={folded ? 'true' : undefined}>
            {render(child, [...path, i])}
          </div>
        );
        return i < node.children.length - 1
          ? [cell, <Separator key={`s${i}`} a={keysOf(child)[0]!} b={keysOf(node.children[i + 1]!)[0]!} dir={node.dir} size={node.sizes[i]!} onActive={onResizeActive} />]
          : [cell];
      })}
    </div>
    );
  };

  const renderStack = (root: LayoutNode): JSX.Element => (
    <div className={s.stack}>
      {/* ピン止めしたものを先頭に置く（FR-216 AC-497） */}
      {[...stackedLeaves(root)].sort((x, y) => Number(y.tabs.some((k) => pinSet.has(k))) - Number(x.tabs.some((k) => pinSet.has(k)))).map((leafNode, i) => (
        <div key={`k${leafNode.tabs.join('+')}`} className={s.stackCell} data-stacked={i} style={leafNode.tabs.every((k) => minSet.has(k)) && maximized === null ? { height: MINIMIZED_HEIGHT } : undefined}>
          {render(leafNode, [i])}
        </div>
      ))}
    </div>
  );

  /** 動かし始めたときの、表示中（分割の木の中）のコンポーネントの位置（画面上の座標） */
  const snapshotRects = (): Record<string, DOMRect> => {
    const out: Record<string, DOMRect> = {};
    const root = rootRef.current;
    if (!root) return out;
    for (const k of keysOf(layout)) {
      // ピン止めしたものは置き先（分割・タブへの入れ先）にしない。上へ置いたものは自由配置で重ならない最寄りの位置へ（FR-216 AC-496）
      if (pinSet.has(k)) continue;
      const r = root.querySelector(`[data-testid="component-${k}"]`)?.getBoundingClientRect();
      if (r && r.width > 0 && r.height > 0) out[k] = r;
    }
    return out;
  };

  /** 画面上の位置にあるコンポーネント（動かし始めの位置。`except` を除く）と、その中のどこに当たるか */
  const hitTest = (x: number, y: number, except: string, rects: Record<string, DOMRect>): { key: string; zone: DropZone; rect: DOMRect } | null => {
    for (const [k, rect] of Object.entries(rects)) {
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
        if (k === except) return null;
        return { key: k, zone: zoneOf((x - rect.left) / rect.width, (y - rect.top) / rect.height), rect };
      }
    }
    // 境界（分割線）の上など、コンポーネントの外でも、すぐ近く（分割線の太さ程度）なら、いちばん近いコンポーネントに寄せる
    let best: { key: string; rect: DOMRect; dist: number } | null = null;
    for (const [k, rect] of Object.entries(rects)) {
      const dist = Math.hypot(Math.max(rect.left - x, 0, x - rect.right), Math.max(rect.top - y, 0, y - rect.bottom));
      if (!best || dist < best.dist) best = { key: k, rect, dist };
    }
    if (!best || best.dist > SNAP_PX || best.key === except) return null;
    const cx = Math.min(Math.max(x, best.rect.left), best.rect.right);
    const cy = Math.min(Math.max(y, best.rect.top), best.rect.bottom);
    return { key: best.key, zone: zoneOf((cx - best.rect.left) / best.rect.width, (cy - best.rect.top) / best.rect.height), rect: best.rect };
  };

  /** 作業領域の端（PARAM-042 以内）に近づけたときのスナップの候補。候補の上にいる間は、その候補を選ぶ（FR-152）。
   * `skip`: 動かし始めの位置がすでに端の近く（最上段のコンポーネントのハンドルなど）のときは、その端からいったん離れるまで候補を出さない。 */
  const edgesAtPoint = (x: number, y: number): Edge[] => {
    const area = rootRef.current?.getBoundingClientRect();
    const out: Edge[] = [];
    if (!area || area.width <= 0 || area.height <= 0) return out;
    if (x >= area.left && x <= area.right && y >= area.top && y <= area.bottom) {
      if (x - area.left <= SNAP_EDGE_PX) out.push('left');
      else if (area.right - x <= SNAP_EDGE_PX) out.push('right');
      if (y - area.top <= SNAP_EDGE_PX) out.push('top');
      else if (area.bottom - y <= SNAP_EDGE_PX) out.push('bottom');
    }
    return out;
  };
  const snapAt = (x: number, y: number, key: string, hitKey: string | null, skip: Set<Edge>): SnapState | null => {
    const root = rootRef.current;
    if (!root) return null;
    const area = root.getBoundingClientRect();
    if (area.width <= 0 || area.height <= 0) return null;
    const prev = dragRef.current?.snap ?? null;
    const raw = edgesAtPoint(x, y);
    for (const e of [...skip]) if (!raw.includes(e)) skip.delete(e);
    const edges: Edge[] = raw.filter((e) => !skip.has(e));
    const panel = document.querySelector('[data-testid="snap-candidates"]')?.getBoundingClientRect();
    const inPanel = !!panel && x >= panel.left - SNAP_KEEP_PX && x <= panel.right + SNAP_KEEP_PX && y >= panel.top - SNAP_KEEP_PX && y <= panel.bottom + SNAP_KEEP_PX;
    if (edges.length === 0 && !(prev && inPanel)) return null;
    const useEdges = edges.length > 0 ? edges : prev!.edges;
    const kinds = snapKindsFor(compact);
    const over = document.elementsFromPoint(x, y).find((el) => el.hasAttribute('data-snap-kind'))?.getAttribute('data-snap-kind') as SnapKind | null | undefined;
    const kind = over && kinds.includes(over) ? over : edges.length > 0 ? defaultSnapKind(useEdges, compact) : prev!.kind;
    const horizontal = useEdges.find((e) => e === 'left' || e === 'right');
    const vertical = useEdges.find((e) => e === 'top' || e === 'bottom');
    const opts: SnapOpts = {
      edge: horizontal ?? vertical,
      corner: edges.length > 0
        ? (horizontal && vertical ? (`${vertical === 'top' ? 't' : 'b'}${horizontal === 'left' ? 'l' : 'r'}` as SnapOpts['corner']) : nearestCorner((x - area.left) / area.width, (y - area.top) / area.height))
        : prev!.opts.corner,
      tabTarget: (edges.length > 0 ? hitKey : null) ?? prev?.opts.tabTarget ?? keysOf(layout).find((k) => k !== key && !pinSet.has(k)),
    };
    // タブ化の相手にピン止めしたものを選ばない（FR-216 AC-496・AC-505）
    if (opts.tabTarget === key || (opts.tabTarget && pinSet.has(opts.tabTarget))) opts.tabTarget = keysOf(layout).find((k) => k !== key && !pinSet.has(k));
    return { edges: useEdges, kind, opts, px: edges.length > 0 ? x : prev!.px, py: edges.length > 0 ? y : prev!.py };
  };

  /** キーボード・コマンドでの大きさの変更（FR-224 AC-522）。縦・横を独立に、作業領域の 5% ずつ変える */
  const resizeByStep = (key: string, axis: 'w' | 'h', dir: 1 | -1) => {
    if (pinSet.has(key)) { announce(PIN_RESIZE_REASON); return; }
    const m = measureAll();
    const r = m?.rects[key];
    if (!m || !r) { announce(NO_RESIZE_REASON); return; }
    const step = (axis === 'w' ? m.bounds.w : m.bounds.h) * 0.05 * dir;
    const target = resizeRect(r, axis === 'w' ? 'e' : 's', axis === 'w' ? step : 0, axis === 'h' ? step : 0, m.bounds);
    markManual(key);
    commitFree(key, target, m);
  };

  /** 手で大きさを変えたコンポーネント。押し出し・並べ直しでも、できる限り大きさを保つ（FR-224・FR-228 AC-529） */
  const manualSet = (): ReadonlySet<string> => { const st = useLayout.getState(); return new Set(st.manual[st.persona] ?? []); };
  /** 手で大きさを変えたコンポーネントとして覚える（自動の調整・ステップでの再配置で上書きしない。FR-143・FR-228） */
  const markManual = (key: string) => useLayout.setState((st) => {
    const cur = st.manual[st.persona] ?? [];
    return cur.includes(key) ? {} : { manual: { ...st.manual, [st.persona]: [...cur, key] } };
  });

  /** 縁・角のドラッグで、縦横を独立に大きさを変える（FR-224 AC-521）。ぶつかるものは押し出す（FR-184） */
  const startResize = (key: string, edge: ResizeEdge, e: { button: number; clientX: number; clientY: number }) => {
    if (e.button !== 0) return;
    if (pinSet.has(key)) { announce(PIN_RESIZE_REASON); return; }
    const start = measureAll();
    const self = start?.rects[key];
    if (!start || !self) { announce(NO_RESIZE_REASON); return; }
    const sx = e.clientX;
    const sy = e.clientY;
    useLayout.getState().raise(key);
    const stop = () => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', stop, true);
      window.removeEventListener('pointercancel', stop, true);
      document.body.style.userSelect = '';
      onResizeActive(false);
    };
    const onMove = (ev: globalThis.PointerEvent) => {
      const target = resizeRect(self, edge, ev.clientX - sx, ev.clientY - sy, start.bounds);
      const next = resolveAround({ ...start.rects, [key]: target }, key, start.bounds, pinSet, manualSet());
      if (next) { markManual(key); actions().setFloats(toFractions(next, start.bounds)); }
    };
    document.body.style.userSelect = 'none';
    onResizeActive(true);
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', stop, true);
    window.addEventListener('pointercancel', stop, true);
  };

  /** 見出しのドラッグでコンポーネントを動かす。置ける場所を移動中に示し、Esc で中止する（FR-142 AC-224）。 */
  const startDrag = (key: string, e: { button: number; clientX: number; clientY: number }) => {
    if (e.button !== 0) return;
    const sx = e.clientX;
    const sy = e.clientY;
    if (pinSet.has(key)) {
      // ピン止め中は動かさず、理由を示す（FR-216 AC-496）。外した後は同じドラッグで動かせる
      const off = () => { window.removeEventListener('pointermove', mv, true); window.removeEventListener('pointerup', off, true); window.removeEventListener('pointercancel', off, true); };
      const mv = (ev: globalThis.PointerEvent) => { if (Math.hypot(ev.clientX - sx, ev.clientY - sy) >= DRAG_THRESHOLD_PX) { off(); announce(PIN_MOVE_REASON); } };
      window.addEventListener('pointermove', mv, true);
      window.addEventListener('pointerup', off, true);
      window.addEventListener('pointercancel', off, true);
      return;
    }
    let active = false;
    // 動かし始めの配置（画面上の座標）。置き場所の判定と、押し出しの計算の元にする（FR-173・FR-184）
    let start = measureAll();
    let hitRects = snapshotRects();
    // 最大化したコンポーネントを掴んだ: 動かし始めたときに最大化を解き、スナップ前の大きさでポインターに追従させる（FR-152 AC-795）
    const wasMax = maximized === key;
    // ピン止めしたものは置き先の一覧に入らないので、その上にいるかの判定用に、位置を別に控える
    const pinRects: DOMRect[] = [...pinSet].filter((k) => k !== key).flatMap((k) => {
      const r = rootRef.current?.querySelector(`[data-testid="component-${k}"]`)?.getBoundingClientRect();
      return r && r.width > 0 && r.height > 0 ? [r] : [];
    });
    const skipEdges = new Set<Edge>(edgesAtPoint(sx, sy));
    // つかんだ位置（コンポーネントの左上からの差）。置いた位置の計算に使う（FR-173）
    const grabRect = rootRef.current?.querySelector(`[data-testid="component-${key}"]`)?.getBoundingClientRect() ?? null;
    /** つかんだ位置の、コンポーネントの幅に対する割合。大きさが変わっても（最大化・スナップを引き離したとき）同じ相対位置を掴んだままにする */
    const grabFx = grabRect && grabRect.width > 0 ? (sx - grabRect.left) / grabRect.width : 0;
    const offY0 = grabRect ? sy - grabRect.top : 0;
    useLayout.getState().raise(key);
    /** ポインターの位置に動かしているコンポーネントを置いた配置（作業領域に対する割合）を求める。自由な移動は、Windows のウィンドウと同様に重なりを許し、
     * ほかを押し出さない（掴んだものが手前に出る。FR-173・Q-066 B）。スナップ・最大化したものは、スナップ前の大きさへ戻る（FR-152 AC-795） */
    const liveAt = (px: number, py: number): DragState['live'] => {
      const area = rootRef.current?.getBoundingClientRect();
      const st0 = start;
      const self = st0?.rects[key];
      if (compact || !st0 || !area || !self) return null;
      const mem = snapMem.current.get(key);
      const w = mem ? mem.w * st0.bounds.w : self.w;
      const h = mem ? mem.h * st0.bounds.h : self.h;
      const target = clampInto({ x: px - grabFx * w - area.left, y: py - Math.min(offY0, h / 2) - area.top, w, h }, st0.bounds);
      // ピン止めしたものには重ねない（固定。FR-216）。重なるときは、重ならない最寄りの位置へ。置き場所がなければ動かし始めの配置のまま
      const fixedRects = [...pinSet].filter((k) => k !== key && st0.rects[k]).map((k) => st0.rects[k]!);
      const placed = fixedRects.length > 0 ? nearestFree(target, fixedRects, st0.bounds) : target;
      noRoom = placed === null;
      return toFractions(placed ? { ...st0.rects, [key]: placed } : st0.rects, st0.bounds);
    };
    let noRoom = false;
    let lastLive: DragState['live'] = null;
    let lastDrag: DragState | null = null;
    const stop = () => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onCancel, true);
      window.removeEventListener('keydown', onKey, true);
      document.body.style.userSelect = '';
    };
    const onMove = (ev: globalThis.PointerEvent) => {
      if (!active) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < DRAG_THRESHOLD_PX) return;
        active = true;
        document.body.style.userSelect = 'none';
        if (wasMax) {
          flushSync(() => actions().setMaximized(null));
          start = measureAll();
          hitRects = snapshotRects();
        }
      }
      const hitAny = hitTest(ev.clientX, ev.clientY, key, hitRects);
      // ピン止めしたコンポーネントの上は置き先にならない（置き先の表示も出さない。FR-216 AC-496）
      const hitPinned = pinRects.some((r) => ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom);
      const overPinned = hitPinned;
      const hit = overPinned ? null : hitAny;
      const snap = snapAt(ev.clientX, ev.clientY, key, hit?.key ?? null, skipEdges);
      // 分割へ入れる置き場所（上下左右の辺）でなければ、ポインターに追従して置く（端のスナップの候補を示している間も追従する。自由配置は重なりを許す。FR-152・FR-173）
      const docking = !!snap || (hit !== null && (hit.zone !== 'tabs' || compact));
      lastLive = docking && !snap ? null : liveAt(ev.clientX, ev.clientY);
      lastDrag = { key, target: hit && !snap && docking ? { key: hit.key, zone: hit.zone, rect: hit.rect } : null, snap, live: lastLive, overPinned };
      setDrag(lastDrag);
    };
    const onUp = () => {
      const d = lastDrag;
      stop();
      // 放した時点で、置いた位置を画面に反映する（flushSync）。動かしていたものは遅れなく最終の位置になり、押し出されたものだけが動き続ける
      flushSync(() => {
        setDrag(null);
        if (active && d?.snap) applySnap(key, d.snap.kind, d.snap.opts, start);
        else if (active && d?.target) useLayout.getState().dropMove(key, d.target.key, d.target.zone);
        else if (active && lastLive && noRoom) {
          // 重ならない位置が作業領域に残っていない: ドラッグ前の位置に戻し、理由を示す（FR-216 AC-505）
          announce(PIN_NO_ROOM_REASON);
        }
        else if (active && lastLive) {
          useLayout.getState().setFloats(lastLive);
          useLayout.getState().markMoved(key);
          snapMem.current.delete(key);
          // 押し出されたものが動き終わるまで、動きをつなぐ（FR-185）
          setSettling(key);
        }
      });
      if (active && lastLive && !d?.target) window.setTimeout(() => setSettling(null), 420);
    };
    const onCancel = () => { stop(); setDrag(null); };
    const onKey = (ev: globalThis.KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation();
      stop();
      setDrag(null);
    };
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onCancel, true);
    window.addEventListener('keydown', onKey, true);
  };

  /** フォーカスが入ったコンポーネントを「操作中」にする（FR-143）。ドラッグ中は変えない。
   * マウスで押している間は大きさを変えない: 押した位置のボタンが動いて、クリックが成立しなくなるため。放したときに反映する。 */
  const pointerDown = useRef(false);
  /** 直前にフォーカスのあった要素。自動のサイズ調整でコンポーネントの置き場所（DOM の親）が変わると、フォーカスが body に落ちるので戻す */
  const lastFocused = useRef<HTMLElement | null>(null);
  const refocusing = useRef(false);
  useLayoutEffect(() => {
    const el = lastFocused.current;
    if (!el || !el.isConnected) return;
    const a = document.activeElement;
    if (a && a !== document.body) return;
    if (!rootRef.current?.contains(el) || el.getClientRects().length === 0) return;
    refocusing.current = true;
    el.focus({ preventScroll: true });
    refocusing.current = false;
  }, [layout]);
  const pendingFocus = useRef<string | null>(null);
  const focusTimer = useRef<number | null>(null);
  const focusTimerKey = useRef<string | null>(null);
  useEffect(() => {
    const down = () => { pointerDown.current = true; };
    const up = () => {
      pointerDown.current = false;
      const k = pendingFocus.current;
      pendingFocus.current = null;
      // click は pointerup の直後に届くので、その後で反映する
      // ダブルクリック（ヘッダーの拡大表示・復帰など）の途中で、1 回目のクリックのあとにレイアウトが動いて 2 回目が外れたり、
      // 拡大・復帰の前後で大きさが変わったりしないよう、マウスで操作した場合は、ダブルクリックの間隔が過ぎてから反映する（FR-174）。
      if (focusTimer.current !== null) window.clearTimeout(focusTimer.current);
      focusTimer.current = null;
      if (k) {
        focusTimer.current = window.setTimeout(() => {
          focusTimer.current = null;
          if (!expandedRef.current) setFocusKey(k);
        }, POINTER_FOCUS_DELAY_MS);
        focusTimerKey.current = k;
      }
    };
    // 予約のあいだにほかの手段（ナビ・キーボードなど）でフォーカスが別の場所へ移ったら、予約を捨てる（FR-143・FR-216）。
    // 捨てないと、画面を切り替えた直後に配置が動き、操作中のコンポーネントの位置が変わる。
    const focusIn = (e: Event) => {
      if (focusTimer.current === null) return;
      const t = e.target as Element | null;
      const holder = t?.closest?.(`[data-testid="component-${focusTimerKey.current}"]`);
      if (holder) return;
      window.clearTimeout(focusTimer.current);
      focusTimer.current = null;
    };
    window.addEventListener('focusin', focusIn, true);
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    return () => {
      window.removeEventListener('focusin', focusIn, true);
      if (focusTimer.current !== null) window.clearTimeout(focusTimer.current);
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
    };
  }, []);
  const onFocusCapture = (e: FocusEvent<HTMLDivElement>) => {
    lastFocused.current = e.target as HTMLElement;
    for (let n: Element | null = e.target as Element; n && n !== e.currentTarget; n = n.parentElement) {
      const id = n.getAttribute('data-testid') ?? '';
      if (id.startsWith('component-') && id !== 'component-menu' && id !== 'component-actions') { lastPaneKey.current = id.slice('component-'.length); break; }
    }
    if (dragRef.current || expandedRef.current || refocusing.current) return;
    const visible = new Set(keysOf(base));
    for (let n: Element | null = e.target as Element; n && n !== e.currentTarget; n = n.parentElement) {
      const id = n.getAttribute('data-testid') ?? '';
      const k = id.startsWith('component-') ? id.slice('component-'.length) : '';
      if (k && visible.has(k)) {
        if (pointerDown.current) pendingFocus.current = k;
        else setFocusKey(k);
        return;
      }
    }
  };

  /** 操作した（押した）コンポーネントを手前に出す（FR-173。重なったときは直近に操作したものが手前） */
  const onPointerDownRaise = (e: PointerEvent<HTMLDivElement>) => {
    for (let n: Element | null = e.target as Element; n && n !== e.currentTarget; n = n.parentElement) {
      const id = n.getAttribute('data-testid') ?? '';
      if (id.startsWith('component-') && id !== 'component-menu' && id !== 'component-actions') { actions().raise(id.slice('component-'.length)); return; }
    }
  };

  // FR-016 AC-192: 作業領域にフォーカスがあるとき、矢印キーでパンする（入力欄・コンポーネント内の操作は妨げない）
  const onAreaKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.defaultPrevented || e.target !== e.currentTarget) return;
    const d = areaPanDelta(e);
    if (!d) return;
    e.preventDefault();
    panByKey(e);
    e.currentTarget.scrollBy({ left: d.dx, top: d.dy });
  };

  return (
    <div
      ref={rootRef}
      onFocusCapture={onFocusCapture}
      onPointerDownCapture={onPointerDownRaise}
      onKeyDown={onAreaKeyDown}
      data-testid="canvas-surface"
      data-view-x={areaView.x}
      data-view-y={areaView.y}
      className={mergeClasses(s.root, compact ? s.rootCompact : undefined, resizing && motionOn ? s.resizing : undefined)}
      data-layout={compact ? 'stacked' : 'split'}
      data-drag-active={drag || resizing ? 'true' : undefined}
      tabIndex={0}
    >
      <WorkspaceOverview />
      <PresentationInkLayer />
      {drag?.target ? (
        <div
          data-testid="drop-indicator"
          aria-hidden
          className={s.drop}
          style={dropRect(drag.target.rect, drag.target.zone)}
        >
          <Text size={200} weight="semibold" className={s.dropLabel}>
            {t('{a}を{b}の{zone}', { a: byKey(drag.key)?.label ?? drag.key, b: byKey(drag.target.key)?.label ?? drag.target.key, zone: t(ZONE_LABEL[drag.target.zone]) })}
          </Text>
        </div>
      ) : null}
      {drag && !drag.target && !drag.snap && !drag.overPinned && drag.live?.[drag.key] ? (() => {
        const area = rootRef.current?.getBoundingClientRect();
        const lr = drag.live![drag.key]!;
        if (!area) return null;
        return (
          <div
            data-testid="drop-indicator"
            aria-hidden
            className={s.drop}
            style={{ left: area.left + lr.x * area.width, top: area.top + lr.y * area.height, width: lr.w * area.width, height: lr.h * area.height }}
          />
        );
      })() : null}
      {drag?.snap ? (() => {
        const sn = drag.snap;
        const area = rootRef.current?.getBoundingClientRect();
        if (!area) return null;
        const tabEl = sn.opts.tabTarget ? rootRef.current?.querySelector(`[data-testid="component-${sn.opts.tabTarget}"]`) : null;
        const pr = snapRect(area, sn.kind, sn.opts, tabEl?.getBoundingClientRect() ?? null);
        const h = sn.edges.find((e) => e === 'left' || e === 'right');
        const panelPos: CSSProperties = h
          ? { top: Math.min(Math.max(sn.py, area.top + 120), area.bottom - 120), transform: 'translateY(-50%)', ...(h === 'left' ? { left: area.left + 40 } : { right: window.innerWidth - area.right + 40 }) }
          : { left: Math.min(Math.max(sn.px, area.left + 80), area.right - 80), transform: 'translateX(-50%)', ...(sn.edges[0] === 'top' ? { top: area.top + 40 } : { bottom: window.innerHeight - area.bottom + 40 }) };
        return (
          <>
            <div data-testid="snap-preview" aria-hidden className={s.snapPreview} style={{ left: pr.left, top: pr.top, width: pr.width, height: pr.height }} />
            <div data-testid="snap-candidates" role="group" aria-label={t('配置の候補')} className={mergeClasses(s.snapPanel, h ? undefined : s.snapPanelRow, snapMotion.appear)} style={panelPos}>
              {snapKindsFor(compact).map((k) => (
                <Button
                  key={k}
                  data-snap-kind={k}
                  className={s.snapButton}
                  size="small"
                  appearance={k === sn.kind ? 'primary' : 'secondary'}
                  aria-pressed={k === sn.kind}
                >
                  {t(SNAP_LABEL[k])}
                </Button>
              ))}
            </div>
          </>
        );
      })() : null}
      {/* 通知の表示領域。Focus では通知の表示を抑える（見た目の表示を止め、支援技術への読み上げは残す。情報は欠けない。FR-300） */}
      <div data-testid="notifications" data-suppressed={taskWs.mode === 'focus' ? 'true' : 'false'}>
        <div data-testid="workspace-notice" role="status" aria-live="polite" className={notice && taskWs.mode !== 'focus' ? s.notice : s.noticeIdle}>{notice?.text ?? ''}</div>
      </div>
      <WindowList screens={screens} layout={base} minimized={minSet} />
      <div ref={treeRef} className={s.treeBox} style={inset ? { ...inset, minHeight: 0 } : (base && !compact ? { minHeight: needHeight(base) + TREE_SLACK } : undefined)}>
        {layout ? (compact ? renderStack(layout) : render(layout, [])) : (
          <Text className={s.empty} size={400}>{outKeys.length > 0 ? '' : t('表示中のコンポーネントがありません。左のドックから再表示してください。')}</Text>
        )}
      </div>
      {outKeys.map((k) => {
        // FR-013 AC-591/592: Panel fills its containing block, so maximize the
        // floating host too. Derive only the display rectangle; never persist it.
        const isMax = maximized === k;
        const r0 = isMax ? { x: 0, y: 0, w: 1, h: 1 } : expandedOut === k ? expandRect(expandPos) : (pinnedMap?.[k] ?? live?.[k] ?? floatMap?.[k]);
        if (!r0 || !byKey(k)?.component) return null;
        // 以前に保存された小さい大きさ・操作の結果の小さい大きさは、下限（PARAM-134・PARAM-135）へ補正して描く（FR-296 AC-801）
        const r = isMax || expandedOut === k ? r0 : floorFloat(r0, width, height);
        const rank = zOrder.indexOf(k);
        const dragged = drag?.key === k && !!live;
        return (
          <div
            key={`float-${k}`}
            className={mergeClasses(s.floatBox, animated && !isMax && expandedOut !== k && settling !== k ? (dragged ? s.floatFollow : s.floatAnimated) : undefined)}
            data-float={k}
            data-pinned={pinSet.has(k) ? 'true' : undefined}
            style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%`, zIndex: isMax ? 1000 : expandedOut === k ? 500 : dragged ? 600 : rank >= 0 ? 3 + rank : 2, ...(settling !== null ? { transition: 'none' } : {}), ...(maximized !== null && !isMax && outKeys.includes(maximized) ? { display: 'none' } : {}), ...(zoneHidden.has(k) && !isMax ? { display: 'none' } : {}) }}
          >
            <Slot host={hostOf(k)} />
          </div>
        );
      })}
      {maximized !== null ? (
        // 没入表示（FR-297 AC-802）: 最大化したコンポーネントの背面を PARAM-137 % 暗くし、背面への操作を通さない
        <div
          data-testid="immersive-backdrop"
          aria-hidden
          className={s.immersiveBackdrop}
          style={{ backgroundColor: withOpacity([0, 0, 0], IMMERSIVE_DIM_PERCENT / 100) }}
        />
      ) : null}
      {floatBorders.map((bd) => (
        <div
          key={`border-${bd.dir}-${bd.before.join('+')}|${bd.after.join('+')}`}
          role="separator"
          data-testid="float-border"
          aria-orientation={bd.dir === 'v' ? 'vertical' : 'horizontal'}
          aria-label={t('コンポーネントの境界（矢印キーで大きさを変える）')}
          aria-valuemin={10}
          aria-valuemax={90}
          aria-valuenow={Math.round(bd.pos * 100)}
          tabIndex={0}
          className={mergeClasses(s.sep, s.floatSep, bd.dir === 'v' ? s.sepV : s.sepH)}
          style={bd.dir === 'v'
            ? { left: `calc(${bd.pos * 100}% - 4px)`, top: `calc(${bd.from * 100}%)`, height: `calc(${(bd.to - bd.from) * 100}%)` }
            : { top: `calc(${bd.pos * 100}% - 4px)`, left: `calc(${bd.from * 100}%)`, width: `calc(${(bd.to - bd.from) * 100}%)` }}
          onPointerDown={(e) => startBorder(bd, e)}
          onKeyDown={(e) => keyBorder(bd, e)}
        />
      ))}
      {assist && !drag ? (
        <div
          data-testid="snap-assist"
          role="group"
          aria-label={t('残った領域に置くコンポーネントを選ぶ')}
          className={s.snapAssist}
          style={{ left: `calc(${(assist.rect.x + assist.rect.w / 2) * 100}%)`, maxWidth: `calc(${assist.rect.w * 100}% - 16px)` }}
        >
          <Text size={200}>{t('残った領域に置く:')}</Text>
          {[...baseKeys].filter((k) => k !== assist.key && !pinSet.has(k) && !!byKey(k)?.component).map((k) => (
            <Button key={k} size="small" onClick={() => fillRemaining(k)}>{byKey(k)?.label ?? k}</Button>
          ))}
          <Button size="small" appearance="subtle" onClick={() => setAssist(null)}>{t('閉じる')}</Button>
        </div>
      ) : null}
      {[...groups.entries()].map(([key, g]) => {
        const Screen = byKey(key)?.component;
        if (!Screen) return null;
        return createPortal(<PanePortalBody Screen={Screen} info={stablePane(key, g.tabs, g.active)} />, hostOf(key), key);
      })}
    </div>
  );
}

