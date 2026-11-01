// 課題・解決策の詳細パネルと出典カード（FR-003 評価属性、FR-004 出典、FR-005 Microsoft 製品と適合理由）。
// 編集モードが ON のときは、名前・評価属性の値をその場で編集でき、選んだ項目の追加・複製・削除ができる（FR-044・FR-046・FR-047）。
import { useEffect, useState } from 'react';
import { Badge, Button, Field, Link, Text, Textarea, makeStyles, tokens } from '@fluentui/react-components';
import { Edit16Regular } from '@fluentui/react-icons';
import { useT } from '../i18n';
import { InlineInput } from '../edit/InlineInput';
import { EditToolbar } from '../edit/EditControls';
import { NumericValue } from '../components/NumericValue';
import { KIND_LABELS, type NodeKind } from '../selection/graph';
import { useDetailHost } from '../store/detailHost';
import { usePane } from '../workspace/PaneContext';
import { useEditStore } from '../store/edit';
import { useRetainedState } from '../store/retained';
import {
  AUDIENCE_LABELS, causesOf, effectsOf, evaluationItems, genAiValueItems, productFits, safeHttpUrl, solutionsOfIssue,
  type Issue, type Product, type Solution, type Source,
} from './model';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalM,
    padding: tokens.spacingHorizontalL,
    backgroundColor: tokens.colorNeutralBackground2,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    minWidth: 0,
    // 詳細が親のコンポーネントより大きな領域を占めないよう高さに上限を設け、超えた分は内側でスクロールする（FR-110 AC-135: 最大の領域は主役のコンポーネント）
    maxHeight: 'min(40vh, 360px)',
    overflowY: 'auto',
  },
  section: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalXS },
  badges: { display: 'flex', flexWrap: 'wrap', columnGap: tokens.spacingHorizontalXS, rowGap: tokens.spacingVerticalXS },
  attr: {
    display: 'grid',
    gridTemplateColumns: 'minmax(80px, 120px) 1fr',
    columnGap: tokens.spacingHorizontalM,
    rowGap: tokens.spacingVerticalXXS,
    paddingBottom: tokens.spacingVerticalS,
    borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke3}`,
  },
  attrSources: { gridColumn: '2', display: 'flex', flexWrap: 'wrap', columnGap: tokens.spacingHorizontalM },
  attrValue: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: tokens.spacingHorizontalS, minWidth: 0 },
  titleRow: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: tokens.spacingHorizontalS, minWidth: 0 },
  list: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalS, margin: 0, padding: 0, listStyle: 'none' },
  product: {
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalXXS,
    padding: tokens.spacingHorizontalM,
    backgroundColor: tokens.colorNeutralBackground1,
    borderRadius: tokens.borderRadiusMedium,
  },
  card: {
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalXS,
    padding: tokens.spacingHorizontalM,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorBrandStroke1}`,
    borderRadius: tokens.borderRadiusMedium,
    overflowWrap: 'anywhere',
  },
});

export interface DetailProps {
  selection:
    | { kind: 'issue'; issue: Issue }
    | { kind: 'solution'; solution: Solution; issue?: Issue; issues?: readonly Issue[] }
    /** 課題・解決策以外の項目（製品・タスクなど）。名前の編集と追加・複製・削除だけを持つ */
    | { kind: 'entity'; id: string; nodeKind: NodeKind; label: string }
    | undefined;
  /** 課題を選んだときに、その課題の解決策・効果・製品を示すための、表示中の解決策 */
  solutions?: readonly Solution[];
  products: readonly Product[];
  sources: readonly Source[];
  sourceId: string | undefined;
  onOpenSource: (id: string) => void;
  onCloseSource: () => void;
  /**
   * この詳細パネルを置く画面の優先度（既定 1）。詳細パネルは同時に 1 つだけ出す。専用の置き場を持つ画面（課題-解決策分析）は 1、
   * 一覧表のように「その場で編集する」ために補う画面は 0（専用の置き場が出ているときは出さない）。
   */
  hostPriority?: number;
}

/** 名前（見出し）と、編集モードが ON のときの名前の編集 */
function EditableTitle({ id, title }: { id: string; title: string }) {
  const s = useStyles();
  const t = useT();
  const editMode = useEditStore((st) => st.editMode);
  const rename = useEditStore((st) => st.rename);
  const [editing, setEditing] = useState(false);
  useEffect(() => { if (!editMode) setEditing(false); }, [editMode]);
  if (editing) {
    return <InlineInput initial={title} label={t('名前')} onClose={() => setEditing(false)} onSubmit={(v) => { const r = rename(id, v); return r.ok ? undefined : r.message; }} />;
  }
  return (
    <div className={s.titleRow}>
      <Text as="h3" size={500} weight="semibold">{title}</Text>
      <Button size="small" appearance="subtle" icon={<Edit16Regular aria-hidden />} aria-label={t('名前を編集')} disabled={!editMode} onClick={() => setEditing(true)} />
    </div>
  );
}

export function DetailPanel({ hostPriority = 1, ...props }: DetailProps) {
  // タブで隠れている画面の詳細パネルは出さない（隠れた置き場が、見えている置き場の詳細を押しのけないように）
  const pane = usePane();
  const visible = !pane || (pane.visible && !pane.minimized);
  const active = useDetailHost(hostPriority + (pane?.compact && pane.front ? 100 : 0), visible);
  return visible && active ? <DetailBody {...props} /> : null;
}

/** 編集モードが ON のとき、未保存のメモ。入力中の内容は、画面の作り直し（ペルソナの切替など）をまたいで保つ（NFR-UX-001 AC-185）。保存はしない。 */
function DraftNote() {
  const editMode = useEditStore((st) => st.editMode);
  const t = useT();
  const [text, setText] = useRetainedState('detail.draftNote', '');
  if (!editMode) return null;
  return (
    <Field label={t('メモ（未保存）')}>
      <Textarea resize="vertical" rows={2} value={text} onChange={(_, d) => setText(d.value)} />
    </Field>
  );
}

function DetailBody({ selection, solutions = [], products, sources, sourceId, onOpenSource, onCloseSource }: DetailProps) {
  const s = useStyles();
  const t = useT();
  const sourceById = new Map(sources.map((x) => [x.id, x]));
  const source = sourceId ? sourceById.get(sourceId) : undefined;
  return (
    <aside className={s.root} data-testid="component-detail" data-tier="supporting" aria-label={t('詳細')}>
      <EditToolbar />
      <DraftNote />
      {!selection ? (
        <Text>{t('項目を選ぶと、詳細を表示します。')}</Text>
      ) : selection.kind === 'issue' ? (
        <IssueDetail issue={selection.issue} solutions={solutions} products={products} sourceById={sourceById} onOpenSource={onOpenSource} />
      ) : selection.kind === 'solution' ? (
        <SolutionDetail solution={selection.solution} issue={selection.issue} issues={selection.issues} products={products} sourceById={sourceById} onOpenSource={onOpenSource} />
      ) : (
        <div className={s.section}>
          <EditableTitle id={selection.id} title={selection.label} />
          <Badge appearance="tint" color="informative">{KIND_LABELS[selection.nodeKind]}</Badge>
        </div>
      )}
      {source ? <SourceCard source={source} onClose={onCloseSource} /> : null}
    </aside>
  );
}

type SourceMap = Map<string, Source>;

/** 評価属性 1 つ（ラベル・値・出典）。値が設定されていれば、編集モードが ON のときに数値・文字をその場で編集できる */
function EvaluationAttr({ issue, item, sourceById, onOpenSource }: {
  issue: Issue; item: ReturnType<typeof evaluationItems>[number]; sourceById: SourceMap; onOpenSource: (id: string) => void;
}) {
  const s = useStyles();
  const t = useT();
  const editMode = useEditStore((st) => st.editMode);
  const update = useEditStore((st) => st.update);
  const [editing, setEditing] = useState(false);
  useEffect(() => { if (!editMode) setEditing(false); }, [editMode]);
  const ev = (issue.evaluation ?? {})[item.key] as { value: number | string; unit?: string } | undefined;
  return (
    <div className={s.attr} data-testid={`attr-${item.key}`}>
      <Text weight="semibold">{item.label}</Text>
      {editing && ev ? (
        <div className={s.attrValue}>
          <InlineInput
            initial={String(ev.value)}
            label={t('{label}の値', { label: item.label })}
            numeric={typeof ev.value === 'number'}
            onClose={() => setEditing(false)}
            onSubmit={(v) => { const r = update(issue.id, ['evaluation', item.key, 'value'], v); return r.ok ? undefined : r.message; }}
          />
          {ev.unit ? <Text>{ev.unit}</Text> : null}
        </div>
      ) : (
        <div className={s.attrValue}>
          <Text data-testid="attr-value">
            {item.display ? <NumericValue sourceIds={item.sourceIds}>{item.display}</NumericValue> : t('未設定')}
          </Text>
          {ev ? <Button size="small" appearance="subtle" icon={<Edit16Regular aria-hidden />} disabled={!editMode} onClick={() => setEditing(true)}>{t('編集')}</Button> : null}
        </div>
      )}
      <div className={s.attrSources}>
        {item.sourceIds.map((id) => {
          const src = sourceById.get(id);
          return (
            <Link
              key={id}
              href={`#${id}`}
              onClick={(e) => { e.preventDefault(); onOpenSource(id); }}
            >
              {src ? src.title : id}
            </Link>
          );
        })}
      </div>
    </div>
  );
}

function IssueDetail({ issue, solutions, products, sourceById, onOpenSource }: {
  issue: Issue; solutions: readonly Solution[]; products: readonly Product[]; sourceById: SourceMap; onOpenSource: (id: string) => void;
}) {
  const s = useStyles();
  const t = useT();
  const causes = causesOf(issue);
  const mine = solutionsOfIssue(issue.id, solutions);
  const productName = new Map(products.map((p) => [p.id, p.name]));
  return (
    <>
      <div className={s.section}>
        <EditableTitle id={issue.id} title={issue.title} />
        <div className={s.badges}>
          <Badge appearance="tint" color={issue.audience === 'external' ? 'brand' : 'informative'}>{AUDIENCE_LABELS[issue.audience]}</Badge>
          {(issue.personas ?? []).map((p) => <Badge key={p} appearance="outline">{p}</Badge>)}
        </div>
        {issue.hypothesis ? <Text>{t('仮説: {v}', { v: issue.hypothesis })}</Text> : null}
      </div>
      <div className={s.section} data-testid="issue-causes">
        <Text as="h4" weight="semibold">{t('原因')}</Text>
        {causes.length === 0 ? <Text>{t('原因は未設定です')}</Text> : (
          <ul className={s.list}>{causes.map((c) => <li key={c.id}><Text>{c.title}</Text></li>)}</ul>
        )}
      </div>
      <div className={s.section} data-testid="issue-solutions">
        <Text as="h4" weight="semibold">{t('解決策・効果・Microsoft 製品')}</Text>
        {mine.length === 0 ? <Text>{t('解決策は未設定です')}</Text> : (
          <ul className={s.list}>
            {mine.map((sol) => (
              <li key={sol.id} className={s.product}>
                <Text weight="semibold">{sol.title}</Text>
                <Text size={200}>{t('効果: {v}', { v: effectsOf(sol).map((e) => e.title).join('、') || t('未設定') })}</Text>
                <Text size={200}>{t('製品: {v}', { v: (sol.productIds ?? []).map((id) => productName.get(id) ?? id).join('、') || t('製品の関連付けなし') })}</Text>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className={s.section}>
        <Text as="h4" weight="semibold">{t('評価属性')}</Text>
        {evaluationItems(issue).map((item) => (
          <EvaluationAttr key={item.key} issue={issue} item={item} sourceById={sourceById} onOpenSource={onOpenSource} />
        ))}
      </div>
    </>
  );
}

function SolutionDetail({ solution, issue, issues, products, sourceById, onOpenSource }: {
  solution: Solution; issue?: Issue; issues?: readonly Issue[]; products: readonly Product[]; sourceById: SourceMap; onOpenSource: (id: string) => void;
}) {
  const s = useStyles();
  const t = useT();
  const fits = productFits(solution, products);
  const effects = effectsOf(solution);
  const genAi = genAiValueItems(solution);
  const targets = issues && issues.length > 0 ? issues : issue ? [issue] : [];
  return (
    <>
      <div className={s.section}>
        <EditableTitle id={solution.id} title={solution.title} />
        {targets.length > 0 ? <Text>{t('対象の課題: {v}', { v: targets.map((i) => i.title).join('、') })}</Text> : null}
      </div>
      <div className={s.section}>
        <Text as="h4" weight="semibold">{t('効果')}</Text>
        {effects.length === 0 ? <Text>{t('効果は未設定です')}</Text> : (
          <ul className={s.list}>{effects.map((e) => <li key={e.id}><Text>{e.title}</Text></li>)}</ul>
        )}
      </div>
      <div className={s.section}>
        <Text as="h4" weight="semibold">{t('生成 AI の価値')}</Text>
        {genAi.length === 0 ? <Text>{t('生成 AI の価値の指定なし')}</Text> : (
          <ul className={s.list}>
            {genAi.map((v) => (
              <li key={v.key} className={s.product} data-testid="genai-value">
                <Text weight="semibold">{v.label}</Text>
                <Text>{v.description}</Text>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className={s.section}>
        <Text as="h4" weight="semibold">{t('出典')}</Text>
        {(solution.sourceIds ?? []).length === 0 ? <Text>{t('出典なし')}</Text> : (
          <div className={s.badges}>
            {(solution.sourceIds ?? []).map((id) => (
              <Button key={id} size="small" appearance="outline" onClick={() => onOpenSource(id)}>
                {sourceById.get(id)?.title ?? id}
              </Button>
            ))}
          </div>
        )}
      </div>
      <div className={s.section}>
        <Text as="h4" weight="semibold">{t('Microsoft 製品と適合理由')}</Text>
        {fits.length === 0 ? <Text>{t('製品の関連付けなし')}</Text> : (
          <ul className={s.list}>
            {fits.map(({ product, reason }) => (
              <li key={product.id} className={s.product} data-testid="product-fit">
                <Text weight="semibold">{product.name}</Text>
                {product.vendor ? <Text size={200}>{product.vendor}</Text> : null}
                <Text data-testid="product-fit-reason">{reason ?? t('適合理由が未設定です')}</Text>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

const CONFIDENCE_HINT: Record<string, string> = {
  高: '複数の確かな資料で裏付けられている',
  中: '一部の資料・聞き取りに基づく',
  低: '裏付けが弱い',
  推定: '資料に基づかない推定',
};

/** 出典カード: タイトル・URL・取得日・確度（FR-004）。URL は新しいタブで開く */
export function SourceCard({ source, onClose }: { source: Source; onClose: () => void }) {
  const s = useStyles();
  const t = useT();
  const href = safeHttpUrl(source.url);
  const hint = CONFIDENCE_HINT[source.confidence];
  return (
    <section className={s.card} data-testid="source-card" aria-label={t('出典: {title}', { title: source.title })}>
      <Text as="h4" weight="semibold">{source.title}</Text>
      <Text>
        URL:{' '}
        {href ? (
          <Link href={href} target="_blank" rel="noopener noreferrer">{href}</Link>
        ) : (
          source.url ?? t('なし')
        )}
      </Text>
      <Text>{t('取得日: {v}', { v: source.retrievedAt })}</Text>
      <Text>{t('確度: {c}（{hint}）', { c: source.confidence, hint: hint ? t(hint) : '' })}</Text>
      <div>
        <Button size="small" appearance="subtle" onClick={onClose}>{t('出典カードを閉じる')}</Button>
      </div>
    </section>
  );
}
