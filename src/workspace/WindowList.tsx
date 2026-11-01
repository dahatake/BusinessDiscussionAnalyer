// 開いているコンポーネントの一覧（FR-295。契約: tests/system/CONTRACT.md §34）。
// 登録済みのコンポーネントを、状態（前面・表示中・最小化・閉じた）つきで 1 つずつ並べる。項目を押すと、最小化・閉じたものは前面に出し、表示中は前面にし、前面のものは最小化する。
// FR-296: 既定のレイアウトに収まらないものは、閉じずに最小化として一覧に残す。
import { useEffect, useMemo, useRef } from 'react';
import { Button, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { Checkmark16Regular, Eye16Regular, Subtract16Regular, Dismiss16Regular } from '@fluentui/react-icons';
import type { ScreenDefinition } from '../screens/types';
import { useLayout } from '../store/layout';
import { keysOf, type Layout } from './layoutModel';
import { WINDOW_STATE_LABEL, nextSwitchIndex, switchKey, switchOrder, windowStates, type WindowState } from './windowStates';
import { useT } from '../i18n';

/** 没入表示中の一覧の高さ（px）。最大化したコンポーネントの上端をこの分だけ下げる */
export const WINDOW_LIST_HEIGHT_PX = 40;

const useStyles = makeStyles({
  bar: {
    display: 'flex', flexWrap: 'nowrap', alignItems: 'center', columnGap: tokens.spacingHorizontalXS, overflowX: 'auto', flex: '0 0 auto',
    minHeight: '32px', paddingBlock: tokens.spacingVerticalXXS, paddingInline: tokens.spacingHorizontalS,
    borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
  },
  // 没入表示（最大化）中も一覧を操作できるよう、最大化したコンポーネント（zIndex 900・1000）より手前に置く。最大化したコンポーネントは、この高さだけ内側に下げる（FR-297 AC-802）
  barOver: { position: 'relative', zIndex: 1100, height: WINDOW_LIST_HEIGHT_PX + 'px', boxSizing: 'border-box', backgroundColor: tokens.colorNeutralBackground1 },
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
  const immersive = useLayout((st) => st.maximized !== null);
  const items = useMemo(() => screens.filter((sc) => !!sc.component && !sc.modal), [screens]);
  const states = useMemo(
    () => windowStates({ keys: items.map((i) => i.key), layout, minimized, closed: new Set(closedKeys ?? []), usedAt }),
    [items, layout, minimized, closedKeys, usedAt],
  );
  const inTree = useMemo(() => new Set(keysOf(layout)), [layout]);
  const press = (key: string, state: WindowState) => {
    const a = useLayout.getState();
    if (state === 'front') {
      if (a.maximized === key) a.setMaximized(null); // 没入表示からの復帰（FR-297 AC-802）
      else if (inTree.has(key)) a.setMinimized(key, true);
    } else if (state === 'visible') {
      a.touch(key);
    } else if (inTree.has(key)) {
      a.setMinimized(key, false);
      a.touch(key);
    } else {
      a.showComponent(key);
    }
  };
  // 切替（Ctrl+Alt+PageDown／PageUp。FR-295 AC-798）。切替のキーを押している間だけ「切替の最中」で、その間の Esc は切替だけを取り消す
  const live = useRef({ states, items, inTree });
  live.current = { states, items, inTree };
  const sw = useRef<{ origin: string | undefined; order: string[]; index: number; restored: Set<string>; wasMin: Set<string> } | null>(null);
  useEffect(() => {
    const end = () => { sw.current = null; };
    const settle = (key: string) => { // 切替で一時的に復元したものは、通り過ぎるとき最小化に戻す
      const cur = sw.current;
      if (cur?.restored.has(key)) { useLayout.getState().setMinimized(key, true); cur.restored.delete(key); }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      const dir = switchKey(e);
      if (dir) {
        e.preventDefault(); e.stopPropagation();
        const a = useLayout.getState();
        if (!sw.current) {
          const { states: st } = live.current;
          const order = switchOrder(st, a.usedAt);
          if (order.length < 2) return;
          const origin = order.find((k) => st[k] === 'front');
          sw.current = { origin, order, index: Math.max(0, origin ? order.indexOf(origin) : 0), restored: new Set(), wasMin: new Set() };
        }
        const cur = sw.current;
        const prev = cur.order[cur.index];
        cur.index = nextSwitchIndex(cur.index, cur.order.length, dir);
        const key = cur.order[cur.index]!;
        if (prev !== key) settle(prev!);
        const st = live.current.states[key];
        if (st === 'minimized') {
          if (live.current.inTree.has(key)) { a.setMinimized(key, false); cur.restored.add(key); } else { a.showComponent(key); }
        }
        a.raise(key);
        return;
      }
      if (e.key === 'Escape' && sw.current) {
        e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
        const cur = sw.current;
        for (const k of [...cur.restored]) settle(k);
        if (cur.origin) { useLayout.getState().raise(cur.origin); }
        sw.current = null;
      }
    };
    const onKeyUp = (e: KeyboardEvent) => { if (e.key === 'Control' || e.key === 'Alt') end(); };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', end);
    return () => { window.removeEventListener('keydown', onKeyDown, true); window.removeEventListener('keyup', onKeyUp, true); window.removeEventListener('blur', end); };
  }, []);
  const frontKey = Object.keys(states).find((k) => states[k] === 'front');
  const frontLabel = items.find((i) => i.key === frontKey)?.label;
  return (
    <div role="toolbar" aria-label={t('開いているコンポーネント')} data-testid="window-list" className={mergeClasses(s.bar, immersive ? s.barOver : undefined)}>
      <span aria-live="polite" aria-atomic="true" data-testid="window-list-front" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' }}>{frontLabel ? `${t('前面')}: ${t(frontLabel)}` : ''}</span>
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
