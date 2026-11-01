// 一覧表（FR-026）。パックのすべての項目を、選択に応じて自動で絞り込む表。
// 選択はすべてのビューと共通の状態（src/store/selection.ts）で、この表の行のクリック・ホバーも同じ状態を使う（FR-024〜FR-027）。
// 件数バッジ・AND/OR の切替・「非表示/減光」の選択・フィルター解除を備える。
import { useEffect, useMemo, useState } from 'react';
import { tr, useT } from '../i18n';
import { lifeOpacity, usePresenceItems } from '../motion';
import {
  Badge, Button, Field, Input, MessageBar, MessageBarActions, MessageBarBody, MessageBarTitle, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text,
  makeStyles, mergeClasses, tokens,
} from '@fluentui/react-components';
import { ChevronDown16Regular, ChevronRight16Regular, FilterDismiss24Regular } from '@fluentui/react-icons';
import { flattenTree } from '../plan/hierarchy';
import { usePackStore } from '../store/pack';
import { SelectionDetail } from '../analysis/SelectionDetail';
import { Radio, RadioGroup } from '../components/ChoiceRadio';
import { useHighlightClass } from '../components/highlight';
import { Panel } from '../components/Panel';
import { EmptyView, LoadingView } from '../components/StateViews';
import { DataTransferButtons } from '../edit/EditControls';
import { InlineInput } from '../edit/InlineInput';
import { KIND_LABELS, type GraphNode } from '../selection/graph';
import { onEntityKey, useEntityBinding, useSelection, useSelectionFilter } from '../selection/hooks';
import { useEditStore } from '../store/edit';
import { useRetainedState } from '../store/retained';
import { useFallbackStore } from '../store/fallback';
import { UNCLASSIFIED_LABEL } from '../schema/world';
import { useComponentView, usePublishViewItems } from '../view/useView';
import { WORLD_VIEW_LABELS, filterByWorld } from '../view/viewModel';
import { ViewAsTableButton } from '../components/ViewTable';
import { Items3DSurface } from '../three/Items3DSurface';
import { groupGrid, type Item3D, type Link3D } from '../view/items3d';

const ORIGIN = 'table';

const useStyles = makeStyles({
  toolbar: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: tokens.spacingHorizontalXL, rowGap: tokens.spacingVerticalS },
  summary: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: tokens.spacingHorizontalS, rowGap: tokens.spacingVerticalXS },
  summarySlot: { minHeight: tokens.spacingVerticalXXXL, display: 'flex', alignItems: 'center' },
  row: {
    cursor: 'pointer',
    ':focus-visible': { outline: `${tokens.strokeWidthThick} solid ${tokens.colorStrokeFocus2}`, outlineOffset: '-2px' },
  },
  cell: { overflowWrap: 'anywhere', minWidth: 0 },
  idCell: { color: tokens.colorNeutralForeground3, fontFamily: tokens.fontFamilyMonospace },
  // ツイン関係の印（FR-218）。セルの幅で折り返す
  twin: { display: 'block', color: tokens.colorBrandForeground1, fontSize: tokens.fontSizeBase200, lineHeight: tokens.lineHeightBase200, overflowWrap: 'anywhere' },
  hideNarrow: { '@media (max-width: 560px)': { display: 'none' } },
});

const idOf = (n: GraphNode): string => n.id;

/**
 * 名称のセル。編集モードが ON のとき、ダブルクリックまたは Enter でその場の編集になる（FR-044）。OFF のときは編集状態にならない（FR-047）。
 * role="gridcell" は、操作できるセルであることを伝える。
 */
function NameCell({ node, className, indent = 0 }: { node: GraphNode; className: string; indent?: number }) {
  const t = useT();
  const editMode = useEditStore((st) => st.editMode);
  const rename = useEditStore((st) => st.rename);
  const [editing, setEditing] = useState(false);
  useEffect(() => { if (!editMode) setEditing(false); }, [editMode]);
  return (
    <TableCell
      role="gridcell"
      className={className}
      style={indent > 0 ? { paddingInlineStart: `calc(${tokens.spacingHorizontalXL} * ${indent})` } : undefined}
      tabIndex={0}
      onDoubleClick={() => { if (editMode) setEditing(true); }}
      onKeyDown={(e) => {
        if (editMode && !editing && e.key === 'Enter' && e.target === e.currentTarget) {
          e.preventDefault();
          e.stopPropagation();
          setEditing(true);
        }
      }}
    >
      {editing ? (
        <>
          {/* 編集中も、セルの文字（元の名称）を残す。表の行・セルを名称で特定する操作（検索・テスト）が、編集の開始で外れないようにするため */}
          <span hidden aria-hidden="true">{node.label}</span>
          <InlineInput
            initial={node.label}
            label={t('{kind}の名称', { kind: t(KIND_LABELS[node.kind]) })}
            onClose={() => setEditing(false)}
            onSubmit={(t) => { const r = rename(node.id, t); return r.ok ? undefined : r.message; }}
          />
        </>
      ) : node.label}
    </TableCell>
  );
}

function TableScreen() {
  const t = useT();
  const s = useStyles();
  const hl = useHighlightClass();
  const { graph, selectedIds, related, mode, unrelated, setMode, setUnrelated, clear, select } = useSelection();
  const bind = useEntityBinding(ORIGIN);
  const editMode = useEditStore((st) => st.editMode);
  // FR-113: 表現が成り立たない項目（位置情報なしなど）を「表で見る」要求があるときは、その項目だけを出す
  const fallback = useFallbackStore((st) => st.request);
  const clearFallback = useFallbackStore((st) => st.clear);
  // 世界の表示（FR-218）: 選んだ世界の項目だけ。「両方」は区分なしを含めてすべて
  const { world: worldView } = useComponentView(ORIGIN);
  const nodes = useMemo(() => filterByWorld(graph?.nodes ?? [], (n) => n.world, worldView), [graph, worldView]);
  const { visible: filtered, count: filteredCount } = useSelectionFilter(nodes, idOf);
  const fallbackNodes = useMemo(() => {
    if (!fallback) return null;
    const ids = new Set(fallback.ids);
    return nodes.filter((n) => ids.has(n.id));
  }, [fallback, nodes]);
  // 編集モードでは、選択で行を隠さない（編集した行・追加した行が見えなくならないように、関連しない行は減光で残す）
  // NFR-UX-001 AC-185: 文字での絞り込み。入力中の内容は画面の作り直しをまたいで保つ（useRetainedState）
  const [text, setText] = useRetainedState('table.filter', '');
  const q = text.trim().toLowerCase();
  const base = fallbackNodes ?? (editMode ? nodes : filtered);
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const visible = useMemo(
    () => (q ? base.filter((n) => `${n.label} ${n.id} ${KIND_LABELS[n.kind]}`.toLowerCase().includes(q)) : base),
    [base, q],
  );
  const count = q ? visible.length : fallbackNodes ? fallbackNodes.length : filteredCount;
  // FR-035: 親子（parentId）のある項目は、上位の行を展開すると下位の行が出て、折りたたむと隠れる（既定は展開）
  const packState = usePackStore((st) => st.state);
  const parentById = useMemo(() => {
    const m = new Map<string, string>();
    if (packState.status !== 'ready') return m;
    const d = packState.pack.data;
    const recs: ReadonlyArray<{ id: string; parentId?: string | null }> = [...d.entities.entities, ...d.issues.issues, ...(d.plan.tasks as Array<{ id: string; parentId?: string | null }>)];
    for (const r of recs) if (r.parentId) m.set(r.id, r.parentId);
    return m;
  }, [packState]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string): void => setCollapsed((c) => { const n = new Set(c); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const rows = useMemo(() => flattenTree(visible, idOf, (n) => parentById.get(n.id), collapsed), [visible, parentById, collapsed]);
  // 表示中の行と、印（「ツイン: 相手」）で示しているツイン関係（t.view.state。FR-218 AC-503）
  const shownIds = useMemo(() => rows.map((r) => r.item.id), [rows]);
  const twinLinks = useMemo(() => {
    if (!graph || worldView !== 'both') return [];
    const shown = new Set(shownIds);
    return graph.edges.filter((e) => e.kind === 'twin' && shown.has(e.from) && shown.has(e.to)).map((e) => [e.from, e.to] as const);
  }, [graph, shownIds, worldView]);
  usePublishViewItems(ORIGIN, shownIds, twinLinks);
  // 3D（FR-217 AC-501）: 同じ項目（表の行と同じ ID・件数）を、種別ごとの列に並べた 3D 空間に置く。つながり=親子・ツイン
  const { mode: viewMode } = useComponentView(ORIGIN);
  const [asTable, setAsTable] = useState(false);
  const items3d = useMemo<Item3D[]>(() => {
    const byId = new Map(rows.map((r) => [r.item.id, r.item]));
    return groupGrid(shownIds.map((id) => byId.get(id) as GraphNode), idOf, (n) => n.label, (n) => KIND_LABELS[n.kind]);
  }, [rows, shownIds]);
  const links3d = useMemo<Link3D[]>(() => {
    const shown = new Set(shownIds);
    const parents = shownIds.filter((id) => parentById.has(id) && shown.has(parentById.get(id) as string)).map((id) => ({ from: parentById.get(id) as string, to: id }));
    return [...parents, ...twinLinks.map(([a, b]) => ({ from: a, to: b }))];
  }, [shownIds, parentById, twinLinks]);
  const twinPartners = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const [a, b] of twinLinks) { m.set(a, [...(m.get(a) ?? []), b]); m.set(b, [...(m.get(b) ?? []), a]); }
    return m;
  }, [twinLinks]);

  // 出入り・遷移（FR-070 AC-086）: 表の行は同じ ID のまま、追加は現れ、削除は薄れて消える（消える行は ID・操作を持たない）
  const rowPresence = usePresenceItems(rows, (r) => r.item.id, () => []);

  if (!graph) return <LoadingView label={t('一覧を読み込み中')} />;

  return (
    <Panel
      testId="component-table"
      title={t('一覧表')}
      description={t('すべての項目を一覧にします。他のビューで項目を選ぶと、関連する行に自動で絞り込まれます。')}
    >
      {fallback ? (
        <MessageBar intent="info" layout="multiline" data-testid="fallback-notice">
          <MessageBarBody>
            <MessageBarTitle>{t('{reason}の項目を表示しています', { reason: fallback.reason })}</MessageBarTitle>
            {t('{source} の表現に必要な属性がないため、地図などには表示できない項目です（{n} 件）。', { source: fallback.source, n: fallbackNodes?.length ?? 0 })}
          </MessageBarBody>
          <MessageBarActions>
            <Button size="small" onClick={clearFallback}>{t('すべての項目に戻す')}</Button>
          </MessageBarActions>
        </MessageBar>
      ) : null}
      <div className={s.toolbar}>
        <Field label={t('選択の組み合わせ')}>
          <RadioGroup layout="horizontal" value={mode} onChange={(_, d) => setMode(d.value as 'AND' | 'OR')}>
            <Radio value="AND" label="AND" />
            <Radio value="OR" label="OR" />
          </RadioGroup>
        </Field>
        <Field label={t('関連しない行')}>
          <RadioGroup layout="horizontal" value={unrelated} onChange={(_, d) => setUnrelated(d.value as 'hide' | 'dim')}>
            <Radio value="hide" label={t('非表示')} />
            <Radio value="dim" label={t('減光')} />
          </RadioGroup>
        </Field>
        <Field label={t('絞り込み')}>
          <Input value={text} onChange={(_, d) => setText(d.value)} placeholder={t('名称・ID・種別')} />
        </Field>
        <Badge appearance="filled" color="brand" size="large" data-testid="count-badge" aria-label={t('該当 {n} 件', { n: count })}>
          {t('{n} 件', { n: count })}
        </Badge>
        <Button icon={<FilterDismiss24Regular aria-hidden />} disabled={selectedIds.length === 0} onClick={() => clear({ origin: ORIGIN })}>
          {t('フィルター解除')}
        </Button>
      </div>
      <DataTransferButtons />
      {viewMode === '3d' ? <div><ViewAsTableButton asTable={asTable} onToggle={() => setAsTable((v) => !v)} /></div> : null}
      {/* 編集モードでは、選択の表示の出入りで表がずれない（ダブルクリックが別の行に当たらない）ように、1 行分の場所を常に確保する */}
      <div className={editMode ? s.summarySlot : undefined}>
        {selectedIds.length > 0 ? (
          <div className={s.summary} role="status">
            <Text weight="semibold">{t('選択中:')}</Text>
            {selectedIds.map((id) => <Badge key={id} appearance="tint" color="brand">{graph.node(id)?.label ?? id}</Badge>)}
          </div>
        ) : null}
      </div>

      {visible.length === 0 ? (
        <EmptyView message={t('選択に関連する項目はありません。「フィルター解除」で全件に戻せます。')} />
      ) : viewMode === '3d' && !asTable ? (
        <Items3DSurface viewKey={ORIGIN} origin={ORIGIN} label={t('項目の一覧')} items={items3d} links={links3d} axes={{ x: t('種別') }} />
      ) : (
        <Table role="treegrid" aria-label={t('項目の一覧')} size="small">
          <TableHeader>
            <TableRow>
              <TableHeaderCell>{t('状態')}</TableHeaderCell>
              <TableHeaderCell>{t('種別')}</TableHeaderCell>
              <TableHeaderCell>{t('世界')}</TableHeaderCell>
              <TableHeaderCell>{t('名称')}</TableHeaderCell>
              <TableHeaderCell className={s.hideNarrow}>ID</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rowPresence.map(({ item: { item: n, depth, hasChildren, expanded }, life, exiting }) => {
              if (exiting) {
                return (
                  <TableRow key={n.id} aria-hidden className={s.row} style={{ opacity: lifeOpacity(life), pointerEvents: 'none' }}>
                    <TableCell role="cell" className={s.cell} /><TableCell role="cell" className={s.cell}>{t(KIND_LABELS[n.kind])}{n.type ? `（${n.type}）` : ''}</TableCell>
                    <TableCell role="cell" className={s.cell} /><TableCell role="cell" className={s.cell}>{n.label}</TableCell><TableCell role="cell" className={mergeClasses(s.cell, s.idCell, s.hideNarrow)} />
                  </TableRow>
                );
              }
              const props = bind(n.id, { filterable: true });
              const state = selected.has(n.id) ? '選択中' : props['data-highlight']?.includes('related') ? '関連' : '';
              // 編集モードでは関連しない行を隠さないので、減光（dimmed）で示す
              const dimmed = editMode && !fallbackNodes && related !== null && !related.has(n.id) && !props['data-highlight']?.includes('dimmed');
              const highlight = dimmed ? [props['data-highlight'], 'dimmed'].filter(Boolean).join(' ') : props['data-highlight'];
              return (
                <TableRow
                  key={n.id}
                  role="row"
                  {...props}
                  // FR-045 AC-056: 編集モードでセルを編集するための選択は、URL（ブラウザー履歴）に積まない（編集中にページ遷移の扱いにしない）
                  onClick={editMode ? (e) => { select(n.id, { origin: ORIGIN, additive: e.ctrlKey || e.metaKey || e.shiftKey, history: 'none' }); } : props.onClick}
                  data-highlight={highlight}
                  aria-selected={selected.has(n.id)}
                  aria-expanded={hasChildren ? expanded : undefined}
                  aria-level={depth + 1}
                  tabIndex={0}
                  className={mergeClasses(s.row, hl(highlight))}
                  style={life < 1 ? { opacity: lifeOpacity(life) } : undefined}
                  onKeyDown={(e) => { onEntityKey(e, n.id, ORIGIN); }}
                >
                  <TableCell role="cell" className={s.cell}>{hasChildren ? (
                    <Button
                      size="small" appearance="subtle" icon={expanded ? <ChevronDown16Regular aria-hidden /> : <ChevronRight16Regular aria-hidden />}
                      aria-label={expanded ? t('{title} を折りたたむ', { title: n.label }) : t('{title} を展開', { title: n.label })}
                      onClick={(e) => { e.stopPropagation(); toggle(n.id); }}
                    />
                  ) : null}{state ? <Badge appearance="outline" color={state === '選択中' ? 'brand' : 'informative'}>{t(state)}</Badge> : null}</TableCell>
                  <TableCell role="cell" className={s.cell}>{t(KIND_LABELS[n.kind])}{n.type ? `（${n.type}）` : ''}</TableCell>
                  {/* 世界区分（FR-218）。区分なしは「両方」でだけ出る。ツイン関係は相手の名前の印で示す */}
                  <TableCell role="cell" className={s.cell}>
                    {n.world ? WORLD_VIEW_LABELS[n.world] : UNCLASSIFIED_LABEL}
                    {(twinPartners.get(n.id) ?? []).map((t) => {
                      const rel = graph.twinsOf(n.id).find((x) => x.id === t)?.relationLabel;
                      // 文字を拡大しても重ならないよう、折り返す 1 行の文字で示す（NFR-A11Y-009）
                      return <span key={t} className={s.twin} data-twin-of={t}>{`${tr('⇄ ツイン:')} ${graph.node(t)?.label ?? t}${rel ? `（${rel}）` : ''}`}</span>;
                    })}
                  </TableCell>
                  <NameCell node={n} className={s.cell} indent={depth} />
                  <TableCell role="cell" className={mergeClasses(s.cell, s.idCell, s.hideNarrow)}>{n.id}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
      <SelectionDetail />
    </Panel>
  );
}

export { TableScreen };

