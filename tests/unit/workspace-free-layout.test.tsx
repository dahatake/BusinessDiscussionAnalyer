// @vitest-environment jsdom
// FR-173 AC-349（toggleFloat・キーボード移動・既定に戻す）、FR-174 AC-350/351（expandRect・Shift+E・ダブルクリック）、
// FR-175 AC-352/353（拡大位置の設定画面のラジオとリセット）。jsdom + testing-library。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { Panel } from '../../src/components/Panel';
import { Workspace, expandRect } from '../../src/workspace/Workspace';
import { SettingsScreen } from '../../src/screens/SettingsScreen';
import { setAvailableComponents, useLayout } from '../../src/store/layout';
import { DEFAULT_EXPAND_POSITION, EXPAND_RATIO, useSettings } from '../../src/store/settings';
import type { ScreenDefinition } from '../../src/screens/types';

const A = () => <Panel testId="component-a" title="パネルA"><input aria-label="入力A" /></Panel>;
const B = () => <Panel testId="component-b" title="パネルB"><p>b</p></Panel>;
const screens: ScreenDefinition[] = [
  { key: 'a', label: 'A', icon: (() => null) as never, component: A },
  { key: 'b', label: 'B', icon: (() => null) as never, component: B },
];
const st = () => useLayout.getState();
const persona = () => st().persona;

const rect = (x: number, y: number, w: number, h: number) => ({ x, y, left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, toJSON: () => ({}) }) as DOMRect;
let spy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  setAvailableComponents(['a', 'b']);
  useLayout.setState({
    floats: {}, zOrder: [], expanded: null, maximized: null,
    layouts: { [persona()]: { kind: 'split', dir: 'row', sizes: [0.5, 0.5], children: [{ kind: 'tabs', tabs: ['a'], active: 'a' }, { kind: 'tabs', tabs: ['b'], active: 'b' }] } },
  });
  // jsdom は寸法を持たないので、作業領域 1000x800 とコンポーネント 400x300 を返す
  spy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.hasAttribute('data-layout')) return rect(0, 0, 1000, 800);
    if ((this.getAttribute('data-testid') ?? '').startsWith('component-')) return rect(100, 100, 400, 300);
    return rect(0, 0, 0, 0);
  });
});
afterEach(() => { cleanup(); spy.mockRestore(); });

const wrap = (ui: JSX.Element) => <FluentProvider theme={webLightTheme}>{ui}</FluentProvider>;
const section = (k: string) => screen.getByTestId(`component-${k}`);

describe('FR-173 AC-349 ドラッグなしの手段', () => {
  // FR-173 AC-349
  it('FR-173 AC-349 メニューの「自由に動かせる配置にする」で浮動になり、Alt+Shift+矢印で同じ向きに動き、もう一度で分割に戻る', () => {
    render(wrap(<Workspace screens={screens} />));
    const menu = within(section('a')).getByTestId('component-menu');
    fireEvent.click(menu);
    fireEvent.click(screen.getByRole('menuitem', { name: '自由に動かせる配置にする' }));
    const f0 = st().floats[persona()]!.a!;
    expect(f0.w).toBeCloseTo(0.4);
    expect(f0.x).toBeCloseTo(0.1);
    fireEvent.keyDown(section('a'), { key: 'ArrowRight', altKey: true, shiftKey: true });
    fireEvent.keyDown(section('a'), { key: 'ArrowDown', altKey: true, shiftKey: true });
    const f1 = st().floats[persona()]!.a!;
    expect(f1.x).toBeCloseTo(f0.x + 0.05);
    expect(f1.y).toBeCloseTo(f0.y + 0.05);
    expect(document.querySelector('[data-float="a"]')).not.toBeNull();
    fireEvent.click(within(section('a')).getByTestId('component-menu'));
    fireEvent.click(screen.getByRole('menuitem', { name: '分割の配置に戻す' }));
    expect(st().floats[persona()]?.a).toBeUndefined();
    expect(document.querySelector('[data-float="a"]')).toBeNull();
  });

  // FR-173 AC-349
  it('FR-173 AC-349 移動しても入力中の内容が変わらず、既定のレイアウトに戻すと浮動が解ける', () => {
    render(wrap(<Workspace screens={screens} />));
    const input = screen.getByLabelText('入力A') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '入力中' } });
    act(() => st().setFloat('a', { x: 0.2, y: 0.2, w: 0.4, h: 0.4 }));
    expect((screen.getByLabelText('入力A') as HTMLInputElement).value).toBe('入力中');
    act(() => st().resetLayout());
    expect(st().floats[persona()]).toBeUndefined();
    expect((screen.getByLabelText('入力A') as HTMLInputElement).value).toBe('入力中');
  });
});

describe('FR-174 AC-350 AC-351 拡大表示', () => {
  // FR-175 AC-352
  it('FR-175 AC-352 expandRect は上・左・右・下で PARAM-058 の割合になる', () => {
    expect(EXPAND_RATIO).toBe(0.75);
    expect(expandRect('top')).toEqual({ x: 0, y: 0, w: 1, h: 0.75 });
    expect(expandRect('left')).toEqual({ x: 0, y: 0, w: 0.75, h: 1 });
    expect(expandRect('right')).toEqual({ x: 0.25, y: 0, w: 0.75, h: 1 });
    expect(expandRect('bottom')).toEqual({ x: 0, y: 0.25, w: 1, h: 0.75 });
  });

  // FR-174 AC-350 AC-351
  it('FR-174 AC-350 AC-351 見出しのダブルクリックと Shift+E で拡大・復帰し、最大化にならず、入力中の内容が保たれる', () => {
    render(wrap(<Workspace screens={screens} />));
    fireEvent.change(screen.getByLabelText('入力A'), { target: { value: '保持' } });
    fireEvent.doubleClick(screen.getByRole('heading', { name: 'パネルA' }));
    expect(section('a').getAttribute('data-expanded')).toBe('true');
    expect(section('a').getAttribute('data-maximized')).toBeNull();
    const box = document.querySelector('[data-float="a"]') as HTMLElement;
    expect(box.style.height).toBe('75%');
    expect(box.style.width).toBe('100%');
    expect((screen.getByLabelText('入力A') as HTMLInputElement).value).toBe('保持');
    fireEvent.doubleClick(screen.getByRole('heading', { name: 'パネルA' }));
    expect(section('a').getAttribute('data-expanded')).toBeNull();
    fireEvent.keyDown(section('a'), { key: 'E', shiftKey: true });
    expect(st().expanded).toBe('a');
    fireEvent.keyDown(section('a'), { key: 'E', shiftKey: true });
    expect(st().expanded).toBeNull();
    expect((screen.getByLabelText('入力A') as HTMLInputElement).value).toBe('保持');
  });

  // FR-175 AC-352
  it('FR-175 AC-352 設定の位置が「左」なら、拡大は幅 75%×全高の左側になる', () => {
    useSettings.setState({ expandPosition: 'left' });
    render(wrap(<Workspace screens={screens} />));
    fireEvent.doubleClick(screen.getByRole('heading', { name: 'パネルA' }));
    const box = document.querySelector('[data-float="a"]') as HTMLElement;
    expect(box.style.width).toBe('75%');
    expect(box.style.height).toBe('100%');
    expect(box.style.left).toBe('0%');
  });
});

describe('FR-175 AC-353 設定画面', () => {
  beforeEach(() => useSettings.setState({ expandPosition: DEFAULT_EXPAND_POSITION }));

  // FR-175 AC-353
  it('FR-175 AC-353 上・左・右・下のラジオがあり、初期は上。選ぶと保存され、既定に戻すで上に戻る', () => {
    render(wrap(<SettingsScreen />));
    const group = screen.getByRole('radiogroup', { name: /拡大表示の位置/ });
    const radios = within(group).getAllByRole('radio');
    expect(radios.map((r) => r.getAttribute('value') ?? (r as HTMLInputElement).value)).toEqual(['top', 'left', 'right', 'bottom']);
    expect((within(group).getByRole('radio', { name: '上' }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(group).getByRole('radio', { name: '右' }));
    expect(useSettings.getState().expandPosition).toBe('right');
    expect((within(group).getByRole('radio', { name: '右' }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /既定（上）に戻す/ }));
    expect(useSettings.getState().expandPosition).toBe('top');
    expect((within(group).getByRole('radio', { name: '上' }) as HTMLInputElement).checked).toBe(true);
  });

  // FR-175 AC-353（異常系）
  it('FR-175 AC-353 既定のときは「既定に戻す」が押せない', () => {
    render(wrap(<SettingsScreen />));
    expect((screen.getByRole('button', { name: /既定（上）に戻す/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});

// FR-013 AC-591 AC-592: the floating host, not only the inner Panel, must
// fill the workspace temporarily. Browser System Tests verify actual geometry.
describe('FR-013 AC-591 AC-592 free maximize host and persisted restore', () => {
  for (const key of ['a', 'b']) {
    for (const restore of ['button', 'escape']) {
      it(`FR-013 AC-591 AC-592 ${key} maximizes its host and restores via ${restore}`, () => {
        const original = { x: 0.2, y: 0.25, w: 0.4, h: 0.3 }; // FR-296: 幅 0.4×1000=400px ≥ PARAM-134（360px）。保存の補正（0.35 → 0.36）の影響を受けない大きさ
        act(() => {
          st().setFloat(key, original);
          st().setFloat(key === 'a' ? 'b' : 'a', { x: 0.1, y: 0.1, w: 0.7, h: 0.7 });
        });
        render(wrap(<Workspace screens={screens} />));
        const host = document.querySelector(`[data-float="${key}"]`) as HTMLElement;
        const initialStyle = [host.style.left, host.style.top, host.style.width, host.style.height];
        const saved = () => JSON.parse(localStorage.getItem('edb.layout')!).state.floats;
        const stored = saved();
        const input = screen.getByLabelText('入力A');
        fireEvent.change(input, { target: { value: 'keep mounted' } });
        fireEvent.focus(section(key));
        fireEvent.click(within(section(key)).getByRole('button', { name: '最大化' }));
        expect([host.style.left, host.style.top, host.style.width, host.style.height]).toEqual(['0%', '0%', '100%', '100%']);
        const other = document.querySelector(`[data-float="${key === 'a' ? 'b' : 'a'}"]`) as HTMLElement;
        expect(Number(host.style.zIndex)).toBeGreaterThan(Number(other.style.zIndex));
        expect(st().floats[persona()]![key]).toEqual(original);
        expect(saved()).toEqual(stored);
        if (restore === 'button') fireEvent.click(within(section(key)).getByRole('button', { name: '通常表示' }));
        else fireEvent.keyDown(section(key), { key: 'Escape' });
        expect([host.style.left, host.style.top, host.style.width, host.style.height]).toEqual(initialStyle);
        expect(saved()).toEqual(stored);
        // FR-013 AC-016: repeated keyboard toggles retain the original placement.
        for (let n = 0; n < 3; n++) {
          fireEvent.keyDown(section(key), { key: 'F', shiftKey: true });
          expect(host.style.width).toBe('100%');
          fireEvent.keyDown(section(key), { key: 'Escape' });
          expect([host.style.left, host.style.top, host.style.width, host.style.height]).toEqual(initialStyle);
        }
        expect(saved()).toEqual(stored);
        expect(screen.getByLabelText('入力A')).toBe(input);
        expect((input as HTMLInputElement).value).toBe('keep mounted');
      });
    }
  }
});
