// 開いているコンポーネントの一覧（FR-295。契約: tests/system/CONTRACT.md §34）。
// 登録済みのコンポーネントを、状態（前面・表示中・最小化・閉じた）つきで 1 つずつ並べる。項目を押すと、最小化・閉じたものは前面に出し、表示中は前面にし、前面のものは最小化する。
// FR-296: 既定のレイアウトに収まらないものは、閉じずに最小化として一覧に残す。
import { useMemo } from 'react';
import { Button, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { Checkmark16Regular, Eye16Regular, Subtract16Regular, Dismiss16Regular } from '@fluentui/react-icons';
import type { ScreenDefinition } from '../screens/types';
import { useLayout } from '../store/layout';
import { keysOf, type Layout } from './layoutModel';
import { WINDOW_STATE_LABEL, windowStates, type WindowState } from './windowStates';
import { useT } from '../i18n';

const useStyles = makeStyles({
  bar: {
    display: 'flex', flexWrap: 'nowrap', alignItems: 'center', columnGap: tokens.spacingHorizontalXS, overflowX: 'auto', flex: '0 0 auto',
    minHeight: '32px', paddingBlock: tokens.spacingVerticalXXS, paddingInline: tokens.spacingHorizontalS,
    borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
  },
  item: { flex: '0 0 auto', minHeight: '24px', whiteSpace: 'nowrap' },
  front: { fontWeight: tokens.fontWeightSemibold },
  dim: { color: tokens.colorNeutralForeground3 },
});

const ICON: Record<WindowState, JSX.Element> = {
  front: <Checkmark16Regular aria-hidden />,
  visible: <Eye16Regular aria-hidden />,
  minimized: <Subtract16Regular aria-hidden />,
  closed: <Dismiss16Regular aria-hidden />,
};

export function WindowList({ screens, layout, minimized }: { screens: readonly ScreenDefinition[]; layout: Layout; minimized: ReadonlySet<string> }) {
  const s = useStyles();
  const t = useT();
  const closedKeys = useLayout((st) => st.closed[st.persona]);
  const usedAt = useLayout((st) => st.usedAt);
  const items = useMemo(() => screens.filter((sc) => !!sc.component && !sc.modal), [screens]);
  const states = useMemo(
    () => windowStates({ keys: items.map((i) => i.key), layout, minimized, closed: new Set(closedKeys ?? []), usedAt }),
    [items, layout, minimized, closedKeys, usedAt],
  );
  const inTree = useMemo(() => new Set(keysOf(layout)), [layout]);
  const press = (key: string, state: WindowState) => {
    const a = useLayout.getState();
    if (state === 'front') {
      if (inTree.has(key)) a.setMinimized(key, true);
    } else if (state === 'visible') {
      a.touch(key);
    } else if (inTree.has(key)) {
      a.setMinimized(key, false);
      a.touch(key);
    } else {
      a.showComponent(key);
    }
  };
  return (
    <div role="toolbar" aria-label={t('開いているコンポーネント')} data-testid="window-list" className={s.bar}>
      {items.map((it) => {
        const st = states[it.key] ?? 'closed';
        const name = `${t(it.label)} ${t(WINDOW_STATE_LABEL[st])}`;
        return (
          <Button
            key={it.key}
            size="small"
            appearance="outline"
            data-testid="window-list-item"
            data-component-key={it.key}
            data-state={st}
            aria-label={name}
            icon={ICON[st]}
            className={mergeClasses(s.item, st === 'front' ? s.front : undefined, st === 'minimized' || st === 'closed' ? s.dim : undefined)}
            onClick={() => press(it.key, st)}
          >
            {t(it.label)}（{t(WINDOW_STATE_LABEL[st])}）
          </Button>
        );
      })}
    </div>
  );
}
