// @vitest-environment jsdom
// FR-295 開いているコンポーネントの一覧（タスクバー相当）の切替・取消・一覧のキーボード操作の単体・結合テスト
// AC-798: Ctrl+Alt+PageDown／PageUp で前面に近い順に切替、Esc は切替の最中だけ切替を取り消す、一覧へ Tab で到達して Enter で操作
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { WindowList } from '../../src/workspace/WindowList';
import { useLayout } from '../../src/store/layout';
import { defaultLayout, keysOf } from '../../src/workspace/layoutModel';
import { nextSwitchIndex, switchKey, switchOrder, windowStates } from '../../src/workspace/windowStates';
import type { ScreenDefinition } from '../../src/screens/types';

afterEach(() => cleanup());

describe('FR-295 AC-798 切替の純粋な計算', () => {
  // FR-295 AC-798
  it('FR-295 AC-798 切替の順は前面が先頭で、近い順に並び、閉じたものを含まない', () => {
    const states = { a: 'visible', b: 'front', c: 'minimized', d: 'closed' } as const;
    expect(switchOrder(states, { a: 5, c: 9 })).toEqual(['b', 'c', 'a']);
  });
  // FR-295 AC-798
  it('FR-295 AC-798 PageDown は進み、PageUp は戻り、端で循環する', () => {
    expect(nextSwitchIndex(0, 3, 'down')).toBe(1);
    expect(nextSwitchIndex(2, 3, 'down')).toBe(0);
    expect(nextSwitchIndex(0, 3, 'up')).toBe(2);
    expect(nextSwitchIndex(0, 0, 'down')).toBe(0);
  });
  // FR-295 AC-798 異常系: ほかのキー（FR-299 の Ctrl+Alt+方向、FR-300 の Ctrl+Alt+Enter）と重ならない
  it('FR-295 AC-798 切替のキーは Ctrl+Alt+PageDown／PageUp だけで、Ctrl+Alt+方向・Enter・修飾なしの PageDown は切替ではない', () => {
    const k = (key: string, o: Partial<{ ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }> = {}) => switchKey({ key, ctrlKey: true, altKey: true, shiftKey: false, metaKey: false, ...o });
    expect(k('PageDown')).toBe('down');
    expect(k('PageUp')).toBe('up');
    for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter', 'Tab']) expect(k(key)).toBeNull();
    expect(k('PageDown', { ctrlKey: false })).toBeNull();
    expect(k('PageDown', { altKey: false })).toBeNull();
  });
});

describe('FR-295 AC-798 一覧のキーボード操作', () => {
  beforeEach(() => {
    useLayout.setState({ usedAt: {}, zOrder: [], minimized: {}, closed: {} });
    useLayout.getState().setPersona?.('事業部門');
  });

  const layoutOf = () => {
    const l = defaultLayout('事業部門');
    // 画面のキーを木のキーに置き換えるのではなく、木にあるキーで画面を作る
    return l;
  };

  function renderList() {
    const l = layoutOf();
    const ks = keysOf(l).slice(0, 3);
    const scr = ks.map((key) => ({ key, label: `部品${key}`, component: () => null })) as unknown as ScreenDefinition[];
    const view = render(
      <FluentProvider theme={webLightTheme}>
        <WindowList screens={scr} layout={l} minimized={new Set()} />
      </FluentProvider>,
    );
    return { ks, view };
  }
  const front = () => screen.getAllByTestId('window-list-item').find((e) => e.getAttribute('data-state') === 'front')?.getAttribute('data-component-key');

  // FR-295 AC-798
  it('FR-295 AC-798 Ctrl+Alt+PageDown で次のものが前面になり、PageUp で戻り、キーを離すと確定する', () => {
    const { ks } = renderList();
    const f0 = front();
    fireEvent.keyDown(window, { key: 'PageDown', ctrlKey: true, altKey: true });
    const f1 = front();
    expect(f1).not.toBe(f0);
    fireEvent.keyDown(window, { key: 'PageUp', ctrlKey: true, altKey: true });
    expect(front()).toBe(f0);
    fireEvent.keyDown(window, { key: 'PageDown', ctrlKey: true, altKey: true });
    fireEvent.keyUp(window, { key: 'Control' });
    expect(front()).toBe(f1);
    expect(ks).toContain(f1);
    expect(screen.getByTestId('window-list-front').textContent).toContain('前面');
  });

  // FR-295 AC-798
  it('FR-295 AC-798 切替の最中の Esc は切替だけを取り消して元の前面へ戻し、その Esc はほかへ渡らない', () => {
    renderList();
    const f0 = front();
    const other = vi.fn();
    window.addEventListener('keydown', other);
    fireEvent.keyDown(window, { key: 'PageDown', ctrlKey: true, altKey: true });
    expect(front()).not.toBe(f0);
    fireEvent.keyDown(window, { key: 'Escape', ctrlKey: true, altKey: true });
    expect(front()).toBe(f0);
    const escSeen = other.mock.calls.filter((c) => (c[0] as KeyboardEvent).key === 'Escape').length;
    expect(escSeen, '切替の取消の Esc は最大化の復帰などへ渡さない').toBe(0);
    window.removeEventListener('keydown', other);
  });

  // FR-295 AC-798 異常系: 切替の最中でない Esc は取り消さない（最大化・没入の復帰へ渡す）
  it('FR-295 AC-798 異常系: 切替の最中でない Esc は何も変えず、ほかへ渡る', () => {
    renderList();
    const f0 = front();
    const other = vi.fn();
    window.addEventListener('keydown', other);
    fireEvent.keyDown(window, { key: 'PageDown', ctrlKey: true, altKey: true });
    fireEvent.keyUp(window, { key: 'Alt' });
    const f1 = front();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(front(), '確定した後の Esc は前面を戻さない').toBe(f1);
    expect(f1).not.toBe(f0);
    expect(other.mock.calls.filter((c) => (c[0] as KeyboardEvent).key === 'Escape').length).toBe(1);
    window.removeEventListener('keydown', other);
  });

  // FR-295 AC-798
  it('FR-295 AC-798 切替で最小化中のものが前面に来て、Esc で最小化に戻る', () => {
    const l = layoutOf();
    const ks = keysOf(l).slice(0, 3);
    useLayout.getState().setMinimized(ks[2]!, true);
    const scr = ks.map((key) => ({ key, label: `部品${key}`, component: () => null })) as unknown as ScreenDefinition[];
    const Wrap = () => {
      const m = useLayout((s) => s.minimized[s.persona]);
      return <FluentProvider theme={webLightTheme}><WindowList screens={scr} layout={l} minimized={new Set(m ?? [])} /></FluentProvider>;
    };
    render(<Wrap />);
    const st = () => Object.fromEntries(screen.getAllByTestId('window-list-item').map((e) => [e.getAttribute('data-component-key'), e.getAttribute('data-state')]));
    expect(st()[ks[2]!]).toBe('minimized');
    fireEvent.keyDown(window, { key: 'PageUp', ctrlKey: true, altKey: true }); // 前面→最後（最小化中）へ
    expect(st()[ks[2]!]).toBe('front');
    fireEvent.keyDown(window, { key: 'Escape', ctrlKey: true, altKey: true });
    expect(st()[ks[2]!]).toBe('minimized');
  });

  // FR-295 AC-798
  it('FR-295 AC-798 一覧は Tab で到達できる button で、Enter 相当の押下で前面になる', () => {
    renderList();
    const btns = screen.getAllByTestId('window-list-item');
    for (const b of btns) { expect(b.tagName).toBe('BUTTON'); expect(b.getAttribute('tabindex')).not.toBe('-1'); expect(b.getAttribute('aria-label')).toMatch(/前面|表示中|最小化|閉じた/); }
    const target = btns.find((b) => b.getAttribute('data-state') === 'visible')!;
    target.focus();
    expect(document.activeElement).toBe(target);
    fireEvent.click(target); // Enter は button の click になる
    expect(screen.getAllByTestId('window-list-item').find((b) => b.getAttribute('data-component-key') === target.getAttribute('data-component-key'))!.getAttribute('data-state')).toBe('front');
  });

  it('windowStates は閉じたものを閉じたとして一覧に残す（AC-797 の前提）', () => {
    const l = defaultLayout('事業部門');
    const ks = keysOf(l);
    const s = windowStates({ keys: [...ks, 'zz'], layout: l, minimized: new Set(), closed: new Set(['zz']), usedAt: {} });
    expect(s.zz).toBe('closed');
  });
});

