// 作業領域の上部に置く、中核オブジェクト（FR-018）とビジネス⇔IT のレンズ（FR-019）。
// 画面「キャンバス」の廃止（FR-012）に伴い、画面ではなく作業領域の帯に移した（機能は変えない）。
import { useState } from 'react';
import { Button, Text, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { usePackTopics } from '../presentation/PresentationMode';
import { currentTopic, usePresentationStore } from '../store/presentation';
import { CoreObjectPanel } from '../coreobject/CoreObjectPanel';
import { LensView } from '../lens/LensView';
import { useCoreObject } from '../store/coreObject';
import { useT } from '../i18n';

const useStyles = makeStyles({
  root: {
    // 案件を開いて上の帯（企業・Project・外部連携）が高いときは、この帯が縮んでスクロールし、下のコンポーネントの領域を潰さない
    display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalS, flex: '0 1 auto', minHeight: 0, maxHeight: '22vh', overflowY: 'auto',
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`,
    borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
  },
  row: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: tokens.spacingHorizontalM, rowGap: tokens.spacingVerticalS },
  topics: { display: 'flex', flexWrap: 'wrap', flexShrink: 0, columnGap: tokens.spacingHorizontalS, rowGap: tokens.spacingVerticalXS, maxHeight: '4.5rem', overflowY: 'auto' },
  topic: {
    display: 'inline-flex', alignItems: 'center', minHeight: '24px', minWidth: '24px', cursor: 'pointer',
    padding: `0 ${tokens.spacingHorizontalS}`, borderRadius: tokens.borderRadiusMedium, border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
  },
  topicOn: { backgroundColor: tokens.colorBrandBackground2, border: `${tokens.strokeWidthThick} solid ${tokens.colorBrandStroke1}` },
  core: {
    display: 'inline-flex', columnGap: tokens.spacingHorizontalS, alignItems: 'baseline', padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`,
    backgroundColor: tokens.colorBrandBackground2, border: `${tokens.strokeWidthThick} solid ${tokens.colorBrandStroke1}`, borderRadius: tokens.borderRadiusXLarge,
  },
});

/** 常設の論点の一覧。プレゼンテーション中は現在の論点を選択中で示し、選ぶとその論点へ移る */
function TopicList() {
  const s = useStyles();
  const t = useT();
  const topics = usePackTopics();
  const current = usePresentationStore((st) => currentTopic(st));
  if (topics.length === 0) return null;
  return (
    <div role="listbox" aria-label={t('論点')} className={s.topics}>
      {topics.map((tp) => {
        const selected = current?.id === tp.id;
        return (
          <div
            key={tp.id}
            role="option"
            aria-selected={selected}
            tabIndex={0}
            title={tp.title}
            className={mergeClasses(s.topic, selected ? s.topicOn : undefined)}
            onClick={() => { const st = usePresentationStore.getState(); const i = st.topics.findIndex((x) => x.id === tp.id); if (st.active && i >= 0) usePresentationStore.setState({ index: i }); }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click(); } }}
          >
            <Text size={200}>{selected ? t('現在: {title}', { title: tp.title }) : tp.title}</Text>
          </div>
        );
      })}
    </div>
  );
}

export function WorkspaceOverview() {
  const s = useStyles();
  const t = useT();
  const { selected: core } = useCoreObject();
  const [showReason, setShowReason] = useState(false);
  return (
    <section className={s.root} aria-label={t('中核オブジェクトとレンズ')}>
      <div className={s.row}>
        {core ? (
          <div data-testid="core-object" data-entity-id={core.id} className={s.core} role="group" aria-label={t('中核オブジェクト: {name}', { name: core.name })}>
            <Text size={200}>{t('中核オブジェクト')}</Text>
            <Text weight="semibold" size={400}>{core.name}</Text>
          </div>
        ) : <Text size={200}>{t('中核オブジェクト: 未設定')}</Text>}
        <Button aria-expanded={showReason} aria-controls="core-object-reason" onClick={() => setShowReason((v) => !v)}>{t('選定理由')}</Button>
      </div>
      <div id="core-object-reason">{showReason ? <CoreObjectPanel /> : null}</div>
      <TopicList />
      <LensView />
    </section>
  );
}
