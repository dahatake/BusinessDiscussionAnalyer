// ビジネス関係グラフ（FR-236）。FR-235 で「向く」と判定された関係を、意味ラベル付きの有向グラフで見る画面。
// 配置・集約・束ね・ラベルの出し分けは src/graphmodel（純粋なモジュール）、意味的ズームは src/semanticzoom（FR-237）、選択は FR-024 の共通の選択状態。
// DOM の契約は tests/system/CONTRACT.md §23。ノードは HTML、エッジは SVG（矢印つき）で描く。
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { useT } from '../i18n';
import { lifeOpacity, lifeScale, usePresenceItems } from '../motion';
import { Badge, Button, Text, makeStyles, tokens } from '@fluentui/react-components';
import { Panel } from '../components/Panel';
import { GraphAlt } from '../components/GraphAlt';
import { clipOf } from '../components/graphShape';
import { Items3DSurface } from '../three/Items3DSurface';
import { spread, type Item3D, type Link3D } from '../view/items3d';
import { EmptyView, LoadingView } from '../components/StateViews';
import { HOP_DEFAULT, HOP_MAX, HOP_MIN, clampHop } from '../analysis/graphView';
import {
  BUNDLE_MIN, MAX_LABELS, MAX_NODES, MEANING_DASH, NODE_H, NODE_W, aggregateNodes, bizGraphOf, bundleEdges, labelBudget,
  layoutGraph, meaningName, neighborhood, selectLabels, shapeAssignment, type LabelCandidate, type Pt,
} from '../graphmodel';
import { MEANINGS, readMeaning, type Meaning } from '../schema/graph';
import { useEntityBinding, useSelection } from '../selection/hooks';
import { usePackStore } from '../store/pack';
import { MIN_TARGET_PX } from '../theme/tokens';
import { useComponentView, usePublishViewItems } from '../view/useView';
import { isShownInWorld } from '../view/viewModel';
import {
  ZoomBreadcrumb, ZOOM_KIND_LABELS, canZoomIn, canZoomOut, clampDepth, kindOfDepth, scaleOfDepth, stepDepth, zoomAttrs, zoomDepthCount,
} from '../semanticzoom';

const ORIGIN = 'business-graph';
const SCREEN_TESTID = 'component-business-graph';
/** 要素の段の数 D（全体 → 要素 → 詳細 の 3 階層） */
const ELEMENT_DEPTH = 1;

const useStyles = makeStyles({
  toolbar: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: tokens.spacingHorizontalM, rowGap: tokens.spacingVerticalS },
  group: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: tokens.spacingHorizontalM, rowGap: tokens.spacingVerticalXS, border: 'none', margin: 0, padding: 0 },
  check: { display: 'inline-flex', alignItems: 'center', columnGap: tokens.spacingHorizontalXS, minHeight: `${MIN_TARGET_PX}px` },
  box: { width: `${MIN_TARGET_PX}px`, height: `${MIN_TARGET_PX}px`, margin: 0 },
  scroll: { overflow: 'auto', maxHeight: '70vh', borderRadius: tokens.borderRadiusMedium, border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground2 },
  canvas: { position: 'relative' },
  node: {
    position: 'absolute', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', rowGap: tokens.spacingVerticalXXS,
    cursor: 'pointer', backgroundColor: tokens.colorNeutralBackground1, border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke1}`, borderRadius: tokens.borderRadiusMedium,
    color: tokens.colorNeutralForeground1, fontSize: tokens.fontSizeBase200, lineHeight: tokens.lineHeightBase200, outlineOffset: '2px',
    ':focus-visible': { outline: `${tokens.strokeWidthThick} solid ${tokens.colorStrokeFocus2}` },
  },
  marker: { width: '22px', height: '22px', backgroundColor: tokens.colorBrandForeground1, display: 'inline-block' },
  name: { position: 'absolute', top: '100%', left: '50%', transform: 'translateX(-50%)', whiteSpace: 'nowrap', fontSize: tokens.fontSizeBase300, lineHeight: tokens.lineHeightBase300, backgroundColor: tokens.colorNeutralBackground1, paddingInline: tokens.spacingHorizontalXXS },
  srOnly: { position: 'absolute', width: '1px', height: '1px', overflow: 'hidden', clipPath: 'inset(50%)', whiteSpace: 'nowrap', opacity: 0 },
  clusters: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalM, padding: tokens.spacingHorizontalM },
  cluster: {
    display: 'flex', flexDirection: 'column', alignItems: 'flex-start', minWidth: '140px', minHeight: `${MIN_TARGET_PX}px`, padding: tokens.spacingHorizontalM, cursor: 'pointer',
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke1}`, borderRadius: tokens.borderRadiusLarge, backgroundColor: tokens.colorNeutralBackground1, color: tokens.colorNeutralForeground1,
  },
  detail: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalS, padding: tokens.spacingHorizontalM },
  table: { borderCollapse: 'collapse', width: '100%', textAlign: 'left', fontSize: tokens.fontSizeBase300, lineHeight: tokens.lineHeightBase300 },
  trow: { cursor: 'pointer', borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`, ':focus-visible': { outline: `${tokens.strokeWidthThick} solid ${tokens.colorStrokeFocus2}` } },
  edgeText: { fontSize: tokens.fontSizeBase200, fill: tokens.colorNeutralForeground1, paintOrder: 'stroke', stroke: tokens.colorNeutralBackground1, strokeWidth: '3px' },
});


const textW = (s: string): number => Math.min(280, s.length * 13 + 8);

/** 箱の境界上の、相手の向きの点（矢印を箱の外に出す） */
function edgePoint(c: Pt, to: Pt, pad = 0): Pt {
  const dx = to.x - c.x; const dy = to.y - c.y;
  if (dx === 0 && dy === 0) return c;
  const sx = (NODE_W / 2 + pad) / Math.abs(dx || 1e-9); const sy = (NODE_H / 2 + pad) / Math.abs(dy || 1e-9);
  const t = Math.min(sx, sy, 1);
  return { x: c.x + dx * t, y: c.y + dy * t };
}

function BusinessGraphScreen() {
  const t = useT();
  const s = useStyles();
  const bind = useEntityBinding(ORIGIN);
  const state = usePackStore((st) => st.state);
  const { selectedIds, primaryId, select } = useSelection();
  const cv = useComponentView(ORIGIN);
  const worldView = cv.world;
  const mode = cv.mode;
  const rootRef = useRef<HTMLDivElement>(null);
  const lastNav = useRef(new Map<string, string>());

  const [hop, setHop] = useState(HOP_DEFAULT);
  const [hiddenTypes, setHiddenTypes] = useState<ReadonlySet<string>>(new Set());
  const [hiddenMeanings, setHiddenMeanings] = useState<ReadonlySet<string>>(new Set());
  // 既定は「要素」（個々のノードが見える階層）。全体は塊の名前と件数、詳細は選んだ項目の属性・出典・関係
  const [depth, setDepth] = useState(1);
  const [focusCluster, setFocusCluster] = useState<string | undefined>();
  const [detailId, setDetailId] = useState<string | undefined>();
  const [expandedClusters, setExpandedClusters] = useState<ReadonlySet<string>>(new Set());
  const [expandedBundles, setExpandedBundles] = useState<ReadonlySet<string>>(new Set());

  const data = state.status === 'ready' ? state.pack.data : undefined;
  const biz = useMemo(() => (data ? bizGraphOf(data) : { nodes: [], edges: [] }), [data]);
  const shapes = useMemo(() => shapeAssignment(biz.nodes.map((n) => n.type)), [biz]);
  const types = useMemo(() => [...new Set(biz.nodes.map((n) => n.type))].sort(), [biz]);
  const meaningsPresent = useMemo(() => MEANINGS.filter((m) => biz.edges.some((e) => e.meaning === m)), [biz]);
  const nodeById = useMemo(() => new Map(biz.nodes.map((n) => [n.id, n])), [biz]);

  // 種別・意味の種類・世界の表示（FR-218）で絞ったあと、選択中のノードから hop ホップ以内に絞る（FR-236）
  const filtered = useMemo(() => {
    const okNode = (id: string): boolean => {
      const n = nodeById.get(id);
      return !!n && !hiddenTypes.has(n.type) && (worldView === 'both' || isShownInWorld(n.world, worldView));
    };
    const edges = biz.edges.filter((e) => !hiddenMeanings.has(e.meaning) && okNode(e.from) && okNode(e.to));
    let ids = new Set(biz.nodes.filter((n) => okNode(n.id)).map((n) => n.id));
    const centers = selectedIds.filter((id) => ids.has(id));
    const near = neighborhood(centers, edges, hop);
    if (near) ids = new Set([...ids].filter((id) => near.has(id)));
    return { ids, edges: edges.filter((e) => ids.has(e.from) && ids.has(e.to)) };
  }, [biz, nodeById, hiddenTypes, hiddenMeanings, worldView, selectedIds, hop]);

  const visibleNodes = useMemo(() => biz.nodes.filter((n) => filtered.ids.has(n.id) && (depth === 0 || !focusCluster || n.cluster === focusCluster)), [biz, filtered, depth, focusCluster]);
  const visibleEdges = useMemo(() => {
    const ids = new Set(visibleNodes.map((n) => n.id));
    return filtered.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  }, [filtered, visibleNodes]);

  // 上限を超える分は塊に集約（PARAM-077）
  const agg = useMemo(() => {
    const degree = new Map<string, number>();
    for (const e of visibleEdges) { degree.set(e.from, (degree.get(e.from) ?? 0) + 1); degree.set(e.to, (degree.get(e.to) ?? 0) + 1); }
    return aggregateNodes(visibleNodes, degree, expandedClusters, MAX_NODES);
  }, [visibleNodes, visibleEdges, expandedClusters]);
  const shownSet = useMemo(() => new Set(agg.shown), [agg]);
  const shownNodes = useMemo(() => visibleNodes.filter((n) => shownSet.has(n.id)), [visibleNodes, shownSet]);
  const repOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const id of agg.shown) m.set(id, id);
    for (const [c, ids] of agg.collapsed) for (const id of ids) m.set(id, `cluster:${c}`);
    return m;
  }, [agg]);

  const clusterOf = useMemo(() => new Map(visibleNodes.map((n) => [n.id, n.cluster])), [visibleNodes]);
  const shownEdges = useMemo(() => visibleEdges.filter((e) => shownSet.has(e.from) && shownSet.has(e.to)), [visibleEdges, shownSet]);
  const bundled = useMemo(() => bundleEdges(shownEdges, clusterOf, expandedBundles, BUNDLE_MIN), [shownEdges, clusterOf, expandedBundles]);
  // 集約した塊につながるエッジは、塊と塊（または個別のノード）の間の線に件数を添える
  const collapsedLinks = useMemo(() => {
    const m = new Map<string, { from: string; to: string; n: number }>();
    for (const e of visibleEdges) {
      const a = repOf.get(e.from); const b = repOf.get(e.to);
      if (!a || !b || a === b || (a === e.from && b === e.to)) continue;
      const k = `${a}\u0000${b}`;
      const v = m.get(k) ?? { from: a, to: b, n: 0 };
      v.n++; m.set(k, v);
    }
    return [...m.values()];
  }, [visibleEdges, repOf]);

  const layoutNodes = useMemo(() => [
    ...shownNodes.map((n) => ({ id: n.id, cluster: n.cluster })),
    ...[...agg.collapsed.keys()].map((c) => ({ id: `cluster:${c}`, cluster: c })),
  ], [shownNodes, agg]);
  const layoutEdges = useMemo(() => [
    ...shownEdges.map((e) => ({ from: e.from, to: e.to })),
    ...collapsedLinks.map((l) => ({ from: l.from, to: l.to })),
  ], [shownEdges, collapsedLinks]);
  const pos = useMemo(() => layoutGraph(layoutNodes, layoutEdges), [layoutNodes, layoutEdges]);
  const size = useMemo(() => {
    let w = 400; let h = 300;
    for (const p of pos.values()) { w = Math.max(w, p.x + NODE_W); h = Math.max(h, p.y + NODE_H + 40); }
    return { w, h };
  }, [pos]);
  const centroids = useMemo(() => {
    const acc = new Map<string, { x: number; y: number; n: number }>();
    for (const n of shownNodes) { const p = pos.get(n.id); if (!p) continue; const a = acc.get(n.cluster) ?? { x: 0, y: 0, n: 0 }; a.x += p.x; a.y += p.y; a.n++; acc.set(n.cluster, a); }
    return new Map([...acc].map(([c, a]) => [c, { x: a.x / a.n, y: a.y / a.n }]));
  }, [shownNodes, pos]);

  // ラベルの出し分け（PARAM-078。選択中と近傍が優先。倍率＝階層で増える）
  const selSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const scale = depth === 0 ? 1 : scaleOfDepth(depth, ELEMENT_DEPTH);
  const labelIds = useMemo(() => {
    const near = new Set<string>();
    for (const e of shownEdges) { if (selSet.has(e.from)) near.add(e.to); if (selSet.has(e.to)) near.add(e.from); }
    const deg = new Map<string, number>();
    for (const e of shownEdges) { deg.set(e.from, (deg.get(e.from) ?? 0) + 1); deg.set(e.to, (deg.get(e.to) ?? 0) + 1); }
    const cands: LabelCandidate[] = [];
    for (const n of shownNodes) {
      const p = pos.get(n.id); if (!p) continue;
      const pr = selSet.has(n.id) ? 0 : near.has(n.id) ? 1 : 2 + 1 / (1 + (deg.get(n.id) ?? 0));
      cands.push({ id: `n:${n.id}`, x: p.x, y: p.y + NODE_H / 2 + 11, w: textW(n.name), h: 18, priority: pr });
    }
    for (const e of bundled.single) {
      const a = pos.get(e.from); const b = pos.get(e.to);
      if (!a || !b || !e.label) continue;
      const pr = selSet.has(e.from) || selSet.has(e.to) ? 1 : 3;
      cands.push({ id: `e:${e.id}`, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, w: textW(e.label), h: 16, priority: pr });
    }
    return new Set(selectLabels(cands, labelBudget(scale, MAX_LABELS)));
  }, [shownEdges, shownNodes, bundled, pos, selSet, scale]);

  usePublishViewItems(ORIGIN, shownNodes.map((n) => n.id));
  // 出入り・遷移（FR-070 AC-086）: 節・線は同じ ID のまま動き、追加は現れ、削除は薄れて消える（停止中・動きの軽減中は即時に最終状態）
  const nodePresence = usePresenceItems(shownNodes, (n) => n.id, (n) => { const p = pos.get(n.id); return p ? [p.x, p.y] : [0, 0]; });
  const edgePresence = usePresenceItems(bundled.single, (e) => e.id, (e) => {
    const a = pos.get(e.from); const b = pos.get(e.to);
    if (!a || !b) return [0, 0, 0, 0, 0, 0];
    const p1 = edgePoint(a, b, 2); const p2 = edgePoint(b, a, 6);
    return [p1.x, p1.y, p2.x, p2.y, (a.x + b.x) / 2, (a.y + b.y) / 2];
  });

  // 3D（FR-238。FR-037 と同じ立体のグラフ）: 平面の配置を横・奥行きに、種別を高さの層に置く。つながり＝エッジ（2D・Graph と同じ項目・同じ関係）
  const items3d = useMemo<Item3D[]>(() => {
    const kinds = [...new Set(shownNodes.map((n) => n.type))].sort();
    return shownNodes.map((n) => {
      const p = pos.get(n.id) ?? { x: 0, y: 0 };
      return { id: n.id, label: n.name, group: n.type, x: p.x / size.w, y: spread(kinds.indexOf(n.type), kinds.length), z: p.y / size.h, size: 0.3 };
    });
  }, [shownNodes, pos, size]);
  const links3d = useMemo<Link3D[]>(() => shownEdges.map((e) => ({ from: e.from, to: e.to })), [shownEdges]);
  const nameOfId = (id: string): string => nodeById.get(id)?.name ?? id;

  // ズームの対象の面（component-business-graph）に、階層の属性を付ける（CONTRACT §23。Panel の共通の外枠は変えない）
  const za = zoomAttrs(depth, ELEMENT_DEPTH);
  useEffect(() => {
    const el = rootRef.current?.closest<HTMLElement>(`[data-testid="${SCREEN_TESTID}"]`);
    if (!el) return;
    for (const [k, v] of Object.entries(za)) el.setAttribute(k, String(v));
  }, [za['data-zoom-level'], za['data-depth'], za['data-depth-count']]); // eslint-disable-line react-hooks/exhaustive-deps

  if (state.status !== 'ready') return <LoadingView label={t('ビジネス関係グラフを読み込み中')} />;

  const goDepth = (d: number): void => {
    const k = clampDepth(d, ELEMENT_DEPTH);
    if (k === 0) setFocusCluster(undefined);
    if (k === 2) {
      const target = detailId && filtered.ids.has(detailId) ? detailId : (primaryId && filtered.ids.has(primaryId) ? primaryId : visibleNodes[0]?.id);
      if (!target) return;
      setDetailId(target);
      if (!selSet.has(target)) select(target, { origin: ORIGIN });
    }
    setDepth(k);
  };
  const openNode = (id: string): void => { select(id, { origin: ORIGIN }); setDetailId(id); setDepth(2); };
  const openCluster = (name: string): void => { setFocusCluster(name); setDepth(1); };
  const toggle = (set: ReadonlySet<string>, v: string, on: boolean): Set<string> => { const n = new Set(set); if (on) n.delete(v); else n.add(v); return n; };

  const clusterCounts = new Map<string, number>();
  for (const n of visibleNodes) clusterCounts.set(n.cluster, (clusterCounts.get(n.cluster) ?? 0) + 1);

  const detailNode = detailId ? nodeById.get(detailId) : undefined;
  const detailEdges = detailNode ? biz.edges.filter((e) => e.from === detailNode.id || e.to === detailNode.id) : [];

  const keyOnNode = (e: KeyboardEvent<HTMLElement>, id: string): void => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter') { e.preventDefault(); openNode(id); }
    else if (e.key === ' ') { e.preventDefault(); select(id, { origin: ORIGIN, additive: e.ctrlKey || e.metaKey || e.shiftKey }); }
    else if (['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(e.key)) {
      // 隣接するノードへ移動する（NFR-A11Y-010 AC-581。ドラッグの代わり）。進む＝次の隣接ノード、戻る＝前の隣接ノード
      const adj = [...new Set(shownEdges.flatMap((x) => (x.from === id ? [x.to] : x.to === id ? [x.from] : [])))].sort();
      if (adj.length === 0) return;
      e.preventDefault();
      const fwd = e.key === 'ArrowRight' || e.key === 'ArrowDown';
      const prev = lastNav.current.get(id);
      const i = prev === undefined ? -1 : adj.indexOf(prev);
      const next = adj[(fwd ? i + 1 : (i < 0 ? adj.length : i) - 1 + adj.length) % adj.length]!;
      lastNav.current.set(id, next);
      [...(rootRef.current?.querySelectorAll<HTMLElement>('[data-testid="graph-node"]') ?? [])].find((el) => el.getAttribute('data-entity-id') === next)?.focus();
    }
  };

  const kind = kindOfDepth(depth, ELEMENT_DEPTH);

  return (
    <Panel
      testId={SCREEN_TESTID}
      title={t('ビジネス関係グラフ')}
      description={t('エンティティの関係を、意味ラベル付きの向きのある線で見ます。ノードを選ぶと、そのホップ数以内だけを表示します。')}
      maxWidth="1200px"
    >
      <div ref={rootRef} style={{ display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalM }}>
        <div className={s.toolbar} role="toolbar" aria-label={t('ビジネス関係グラフの操作')}>
          <Button size="small" disabled={!canZoomIn(depth, ELEMENT_DEPTH)} onClick={() => goDepth(stepDepth(depth, 1, ELEMENT_DEPTH))}>{t('拡大')}</Button>
          <Button size="small" disabled={!canZoomOut(depth)} onClick={() => goDepth(stepDepth(depth, -1, ELEMENT_DEPTH))}>{t('縮小')}</Button>
          <Button size="small" onClick={() => goDepth(0)}>{t('全体表示に戻す')}</Button>
          <Button size="small" disabled={depth === 0} onClick={() => goDepth(depth - 1)}>{t('一つ上の階層へ')}</Button>
          <span data-testid="zoom-level" data-depth={za['data-depth']} data-depth-count={zoomDepthCount(ELEMENT_DEPTH)}>
            <Badge appearance="tint">{ZOOM_KIND_LABELS[kind]}</Badge>
          </span>
          <label className={s.check}>
            <Text>{t('ホップ数（{min}〜{max}）', { min: HOP_MIN, max: HOP_MAX })}</Text>
            <input type="range" style={{ height: 24, cursor: 'pointer' }} aria-label={t('ホップ数')} min={HOP_MIN} max={HOP_MAX} step={1} value={hop} onChange={(e) => setHop(clampHop(Number(e.target.value)))} />
            <Text>{hop}</Text>
          </label>
        </div>
        <ZoomBreadcrumb depth={depth} elementDepth={ELEMENT_DEPTH} elementLabels={focusCluster ? [focusCluster] : []} detailLabel={detailNode?.name} onGo={goDepth} />

        <fieldset className={s.group} role="group" aria-label={t('種別')}>
          {types.map((t) => (
            <label key={t} className={s.check}>
              <input type="checkbox" className={s.box} data-filter-value={t} checked={!hiddenTypes.has(t)} onChange={(e) => setHiddenTypes((h) => toggle(h, t, e.target.checked))} />
              <Text>{t}</Text>
            </label>
          ))}
        </fieldset>
        <fieldset className={s.group} role="group" aria-label={t('意味の種類')}>
          {meaningsPresent.map((m: Meaning) => (
            <label key={m} className={s.check}>
              <input type="checkbox" className={s.box} data-filter-value={m} checked={!hiddenMeanings.has(m)} onChange={(e) => setHiddenMeanings((h) => toggle(h, m, e.target.checked))} />
              <Text>{meaningName(m)}</Text>
            </label>
          ))}
        </fieldset>

        {biz.nodes.length === 0 ? <EmptyView message={t('関係を持つ項目がありません')} /> : null}

        {mode === '3d' && biz.nodes.length > 0 ? (
          <Items3DSurface viewKey={ORIGIN} origin={ORIGIN} label={t('ビジネス関係グラフ')} items={items3d} links={links3d} axes={{ y: t('種別') }} />
        ) : null}

        <div data-zoom-surface={mode === 'graph' ? 'graph' : undefined} style={{ display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalM }}>
        {depth === 0 ? (
          <div className={s.clusters} role="group" aria-label={t('塊')}>
            {[...clusterCounts].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([name, n]) => (
              <div
                key={name} role="button" tabIndex={0} className={s.cluster} data-zoom-cluster={name}
                aria-label={t('{name} {n} 件。ダブルクリックか Enter で要素へ', { name, n })}
                onDoubleClick={() => openCluster(name)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); openCluster(name); } }}
              >
                <Text weight="semibold">{name}</Text>
                <Text>{t('{n} 件', { n })}</Text>
              </div>
            ))}
          </div>
        ) : null}

        {depth === 1 && mode === '2d' && biz.nodes.length > 0 ? (
          <div data-testid="biz-2d" style={{ display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalM }}>
            <Text as="h3" weight="semibold">{t('関係表（起点・意味ラベル・終点）')}</Text>
            <table aria-label={t('関係表')} data-testid="biz-relation-table" className={s.table}>
              <thead><tr><th scope="col">{t('起点')}</th><th scope="col">{t('意味ラベル')}</th><th scope="col">{t('終点')}</th><th scope="col">{t('意味の種類')}</th></tr></thead>
              <tbody>
                {shownEdges.length === 0 ? <tr><td colSpan={4}>{t('関係はありません')}</td></tr> : null}
                {shownEdges.map((e) => (
                  <tr key={e.id} data-relation-id={e.id} className={s.trow} onClick={() => select(e.from, { origin: ORIGIN })}>
                    <td>{nameOfId(e.from)}</td><td>{e.label ?? t('（ラベルなし）')}</td><td>{nameOfId(e.to)}</td><td>{meaningName(e.meaning)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Text as="h3" weight="semibold">{t('隣接表（種別ごと）')}</Text>
            {types.filter((k) => nodePresence.some((p) => p.item.type === k)).map((k) => (
              <table key={k} aria-label={`${t('隣接表:')} ${k}`} data-testid="biz-adjacency-table" data-kind-table={k} className={s.table}>
                <caption>{k}</caption>
                <thead><tr><th scope="col">{t('名称')}</th><th scope="col">{t('つながり（→ 向かう先／← 向かってくる元）')}</th></tr></thead>
                <tbody>
                  {nodePresence.filter((p) => p.item.type === k).map(({ item: n, life, exiting }) => exiting ? (
                    <tr key={n.id} aria-hidden className={s.trow} style={{ opacity: lifeOpacity(life), pointerEvents: 'none' }}>
                      <td>{n.name}</td><td />
                    </tr>
                  ) : (
                    <tr
                      key={n.id} {...bind(n.id)} tabIndex={0} className={s.trow} data-zoom-node="" data-kind={n.type} data-entity-name={n.name} aria-selected={selSet.has(n.id)}
                      style={life < 1 ? { opacity: lifeOpacity(life) } : undefined}
                      onDoubleClick={() => openNode(n.id)} onKeyDown={(e) => keyOnNode(e, n.id)}
                    >
                      <td>{n.name}</td>
                      <td>{[
                        ...shownEdges.filter((e) => e.from === n.id).map((e) => `→ ${nameOfId(e.to)}${e.label ? `（${e.label}）` : ''}`),
                        ...shownEdges.filter((e) => e.to === n.id).map((e) => `← ${nameOfId(e.from)}${e.label ? `（${e.label}）` : ''}`),
                      ].join('、') || t('（つながりなし）')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ))}
          </div>
        ) : null}

        {depth === 1 && mode === 'graph' && biz.nodes.length > 0 ? (
          <div className={s.scroll}>
            <div className={s.canvas} style={{ width: size.w, height: size.h }} data-testid="graph-canvas">
              <svg width={size.w} height={size.h} style={{ position: 'absolute', inset: 0 }} aria-hidden={false} role="img" aria-label={t('関係の線')}>
                <defs>
                  <marker id="bg-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
                    <path d="M0,0 L10,5 L0,10 z" fill="currentColor" />
                  </marker>
                </defs>
                <g style={{ color: tokens.colorNeutralForeground2 }}>
                  {edgePresence.map(({ item: e, vec, life, exiting }) => {
                    const [x1, y1, x2, y2, mx, my] = vec as [number, number, number, number, number, number];
                    const text = labelIds.has(`e:${e.id}`) ? e.label : undefined;
                    return (
                      <g key={e.id} data-testid={exiting ? 'graph-edge-exiting' : 'graph-edge'} data-from={e.from} data-to={e.to} data-meaning={e.meaning} data-direction="forward" role="img" opacity={lifeOpacity(life)} aria-hidden={exiting || undefined} aria-label={t('{from} から {to} へ {label}', { from: nodeById.get(e.from)?.name ?? e.from, to: nodeById.get(e.to)?.name ?? e.to, label: e.label ?? t('（ラベルなし）') })}>
                        {e.label ? <title>{`${e.label}（${readMeaning(e.meaning, nodeById.get(e.from)?.name ?? e.from, nodeById.get(e.to)?.name ?? e.to)}）`}</title> : null}
                        <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="currentColor" strokeWidth={1.5} strokeDasharray={MEANING_DASH[e.meaning]} markerEnd="url(#bg-arrow)" />
                        {text ? <text className={s.edgeText} x={mx} y={my} textAnchor="middle">{text}</text> : null}
                      </g>
                    );
                  })}
                  {bundled.bundles.map((g) => {
                    const a = centroids.get(g.fromCluster); const b = centroids.get(g.toCluster);
                    if (!a || !b) return null;
                    return (
                      <g key={g.key} data-testid="graph-bundle" data-count={g.edges.length} role="button" tabIndex={0} style={{ cursor: 'pointer' }}
                        aria-label={t('{a} と {b} の間の {n} 本をまとめた線。押すと個別に展開', { a: g.fromCluster, b: g.toCluster, n: g.edges.length })}
                        onClick={() => setExpandedBundles((x) => new Set(x).add(g.key))}
                        onKeyDown={(e) => { if (e.key === 'Enter') setExpandedBundles((x) => new Set(x).add(g.key)); }}>
                        <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="currentColor" strokeWidth={4} markerEnd="url(#bg-arrow)" />
                        <text className={s.edgeText} x={(a.x + b.x) / 2} y={(a.y + b.y) / 2} textAnchor="middle">{t('{n} 本', { n: g.edges.length })}</text>
                      </g>
                    );
                  })}
                  {collapsedLinks.map((l) => {
                    const a = pos.get(l.from); const b = pos.get(l.to);
                    if (!a || !b) return null;
                    return (
                      <g key={`${l.from}>${l.to}`} data-testid="graph-bundle" data-count={l.n}>
                        <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="currentColor" strokeWidth={3} markerEnd="url(#bg-arrow)" />
                        <text className={s.edgeText} x={(a.x + b.x) / 2} y={(a.y + b.y) / 2} textAnchor="middle">{t('{n} 本', { n: l.n })}</text>
                      </g>
                    );
                  })}
                </g>
              </svg>

              {nodePresence.map(({ item: n, vec, life, exiting }) => {
                const shape = shapes.get(n.type) ?? 'circle';
                const showName = labelIds.has(`n:${n.id}`);
                const st: CSSProperties = {
                  left: vec[0]! - NODE_W / 2, top: vec[1]! - NODE_H / 2, width: NODE_W, height: NODE_H,
                  ...(life < 1 || exiting ? { opacity: lifeOpacity(life), transform: `scale(${lifeScale(life).toFixed(3)})`, ...(exiting ? { pointerEvents: 'none' as const } : {}) } : {}),
                };
                return (
                  <div
                    key={n.id} {...bind(n.id)} role="button" tabIndex={exiting ? -1 : 0} className={s.node} style={st}
                    data-testid={exiting ? 'graph-node-exiting' : 'graph-node'} data-zoom-node="" data-kind={n.type} data-node-type={n.type} data-shape={shape} data-entity-name={n.name}
                    aria-hidden={exiting || undefined}
                    aria-pressed={selSet.has(n.id)} aria-label={`${n.name}（${n.type}）`}
                    onDoubleClick={() => openNode(n.id)} onKeyDown={(e) => keyOnNode(e, n.id)}
                  >
                    <span className={s.marker} aria-hidden style={{ clipPath: clipOf(shape) }} />
                    <span>{n.type}</span>
                    <span className={showName ? s.name : s.srOnly}>{n.name}</span>
                  </div>
                );
              })}

              {[...agg.collapsed].map(([c, ids]) => {
                const p = pos.get(`cluster:${c}`); if (!p) return null;
                return (
                  <button
                    key={c} type="button" className={s.node} data-testid="graph-cluster" data-cluster={c} data-count={ids.length}
                    style={{ left: p.x - NODE_W / 2, top: p.y - NODE_H / 2, width: NODE_W, height: NODE_H }}
                    aria-label={t('{c} に集約した {n} 件。押すと個別に展開', { c, n: ids.length })}
                    onClick={() => setExpandedClusters((x) => new Set(x).add(c))}
                  >
                    <span>{c}</span><span>{t('{n} 件', { n: ids.length })}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}

        {depth === 1 && agg.collapsed.size > 0 ? (
          <Text role="status" data-testid="graph-aggregate-note">
            {t('ノードが {max} 件を超えるため、{n} 件を {m} 個の塊に集約しています（全 {total} 件）。', { max: MAX_NODES, n: [...agg.collapsed.values()].reduce((a, v) => a + v.length, 0), m: agg.collapsed.size, total: visibleNodes.length })}
          </Text>
        ) : null}

        {depth === 2 && detailNode ? (
          <section className={s.detail} data-testid="zoom-detail" aria-label={t('詳細')}>
            <Text as="h2" size={500} weight="semibold" data-entity-id={detailNode.id}>{detailNode.name}</Text>
            <Text as="h3" weight="semibold">{t('属性')}</Text>
            <dl style={{ margin: 0 }}>
              <dt>{t('種別')}</dt><dd>{detailNode.type}</dd>
              <dt>ID</dt><dd>{detailNode.id}</dd>
              <dt>{t('塊')}</dt><dd>{detailNode.cluster}</dd>
              <dt>{t('世界区分')}</dt><dd>{detailNode.world === 'real' ? t('現実世界') : detailNode.world === 'digital' ? t('デジタル世界') : t('区分なし')}</dd>
            </dl>
            <Text as="h3" weight="semibold">{t('出典')}</Text>
            <ul style={{ margin: 0 }}>{detailNode.sourceIds.length ? detailNode.sourceIds.map((x) => <li key={x}>{x}</li>) : <li>{t('出典なし')}</li>}</ul>
            <Text as="h3" weight="semibold">{t('関係')}</Text>
            <ul style={{ margin: 0 }}>
              {detailEdges.length
                ? detailEdges.map((e) => <li key={e.id}>{e.label ? `${e.label}: ` : ''}{readMeaning(e.meaning, nodeById.get(e.from)?.name ?? e.from, nodeById.get(e.to)?.name ?? e.to)}</li>)
                : <li>{t('関係なし')}</li>}
            </ul>
          </section>
        ) : null}
        </div>

        {mode !== '2d' && biz.nodes.length > 0 ? (
          <GraphAlt
            origin={ORIGIN} label={t('ビジネス関係グラフ')} showTableButton={false}
            nodes={shownNodes.map((n) => ({ id: n.id, name: n.name, kind: n.type }))}
            relations={shownEdges.map((e) => ({ id: e.id, from: e.from, to: e.to, label: e.label, kind: meaningName(e.meaning) }))}
            summary={t('階層は {kind}（全体・要素・詳細の 3 階層）', { kind: t(ZOOM_KIND_LABELS[kind]) })}
          />
        ) : null}
      </div>
    </Panel>
  );
}

export { BusinessGraphScreen };

