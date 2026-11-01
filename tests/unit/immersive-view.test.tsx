// @vitest-environment jsdom
// FR-297 没入（Immersive）表示・奥行き・動きの単体・結合テスト
// AC-802: 背面の減光（PARAM-137 = 60%）、一覧の前面の項目の操作で最大化から戻る
// AC-804: 出入りの動きは、動きの軽減（prefers-reduced-motion）・アニメ停止のとき付かない
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { WindowList } from '../../src/workspace/WindowList';
import { useLayout } from '../../src/store/layout';
import { defaultLayout, keysOf } from '../../src/workspace/layoutModel';
import { IMMERSIVE_DIM_PERCENT, windowStates } from '../../src/workspace/windowStates';
import { motionAllowed } from '../../src/motion/useFoldMotion';
import type { ScreenDefinition } from '../../src/screens/types';

afterEach(() => cleanup());

describe('FR-297 AC-802 没入表示', () => {
  beforeEach(() => {
    useLayout.setState({ usedAt: {}, zOrder: [], minimized: {}, closed: {}, maximized: null });
  });

  // FR-297 AC-802
  it('FR-297 AC-802 背面の減光は PARAM-137 の 60%', () => {
    expect(IMMERSIVE_DIM_PERCENT).toBe(60);
  });

  // FR-297 AC-802
  it('FR-297 AC-802 最大化中に一覧の前面の項目を押すと、最小化せず通常表示に戻る', () => {
    const l = defaultLayout('事業部門');
    const ks = keysOf(l).slice(0, 3);
    const scr = ks.map((key) => ({ key, label: `部品${key}`, component: () => null })) as unknown as ScreenDefinition[];
    useLayout.getState().raise(ks[0]!);
    useLayout.getState().setMaximized(ks[0]!);
    render(
      <FluentProvider theme={webLightTheme}>
        <WindowList screens={scr} layout={l} minimized={new Set()} />
      </FluentProvider>,
    );
    const front = screen.getAllByTestId('window-list-item').find((e) => e.getAttribute('data-state') === 'front')!;
    expect(front.getAttribute('data-component-key')).toBe(ks[0]);
    fireEvent.click(front);
    expect(useLayout.getState().maximized).toBeNull();
    expect(useLayout.getState().minimized[useLayout.getState().persona] ?? []).not.toContain(ks[0]);
  });

  // FR-297 AC-803: 前面は 1 つだけ（見出しの強調の根拠）
  it('FR-297 AC-803 前面は表示中のうち最も最近使った 1 つだけ', () => {
    const l = defaultLayout('事業部門');
    const ks = keysOf(l).slice(0, 3);
    const st = windowStates({ keys: ks, layout: l, minimized: new Set(), closed: new Set(), usedAt: { [ks[1]!]: 5 } });
    expect(Object.values(st).filter((s) => s === 'front')).toHaveLength(1);
    expect(st[ks[1]!]).toBe('front');
  });
});

describe('FR-297 AC-804 動き', () => {
  // FR-297 AC-804
  it('FR-297 AC-804 動きの軽減が有効、またはアニメが停止中なら動きを付けない', () => {
    expect(motionAllowed(true, false)).toBe(true);
    expect(motionAllowed(true, true)).toBe(false);
    expect(motionAllowed(false, false)).toBe(false);
  });
});
