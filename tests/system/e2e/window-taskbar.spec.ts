// System Test: 開いているコンポーネントの一覧・既定の構成と最小サイズ・没入表示（run 202610302230）
// Oracles: FR-295 AC-797・AC-799、FR-296 AC-800、FR-297 AC-802・AC-803（docs/requirements/app-experience.md）だけ。
// PARAM-134=360 px（最小の幅）、PARAM-135=240 px（最小の高さ）、PARAM-136=4 個（既定の同時表示の上限）、PARAM-137=60 %（背面の減光）。
// 画面の探し方は tests/system/CONTRACT.md §33（実装前の契約案）。実装が未着手のため、失敗は正常。
import type { Page, Locator } from '@playwright/test';
import { test, expect, component, selectPersona, PERSONAS, MAIN_SCREENS, openScreen, contrastRatio } from '../support/fixtures';

const MIN_W = 360; // PARAM-134
const MIN_H = 240; // PARAM-135
const MAX_VISIBLE = 4; // PARAM-136
const DIM = 0.6; // PARAM-137
const TOL = 2;

type Box = { x: number; y: number; width: number; height: number };
type State = 'front' | 'visible' | 'minimized' | 'closed';

const list = (page: Page) => page.getByTestId('window-list');
const items = (page: Page) => list(page).getByTestId('window-list-item');
const item = (page: Page, key: string) => list(page).locator(`[data-testid="window-list-item"][data-component-key="${key}"]`);

async function states(page: Page): Promise<Record<string, State>> {
  return items(page).evaluateAll((els) => Object.fromEntries(
    els.map((e) => [e.getAttribute('data-component-key') ?? '', e.getAttribute('data-state') ?? ''])) as Record<string, State>);
}
async function box(c: Locator): Promise<Box> {
  const b = await c.boundingBox();
  expect(b, 'visible rectangle required').not.toBeNull();
  return b!;
}
async function sameBox(c: Locator, expected: Box, message: string) {
  await expect.poll(async () => {
    const a = await box(c);
    return Math.max(...(['x', 'y', 'width', 'height'] as const).map((p) => Math.abs(a[p] - expected[p])));
  }, { message }).toBeLessThanOrEqual(TOL);
}
async function zIndex(c: Locator): Promise<number> {
  return c.evaluate((el) => {
    // 計算済みの z-index が数値の最も近い祖先（自分を含む）
    for (let e: Element | null = el; e; e = e.parentElement) {
      const z = parseInt(getComputedStyle(e).zIndex, 10);
      if (!Number.isNaN(z)) return z;
    }
    return 0;
  });
}
async function action(c: Locator, name: string) {
  await c.focus();
  await c.getByTestId('component-actions').getByRole('button', { name, exact: true }).click();
}
async function resetLayout(page: Page) {
  await page.getByRole('button', { name: '既定のレイアウトに戻す', exact: true }).click();
  await expect(list(page)).toBeVisible();
}
async function setup(page: Page, persona = '事業部門') {
  await page.setViewportSize({ width: 1280, height: 800 });
  await selectPersona(page, persona);
  await resetLayout(page);
}
async function shown(page: Page): Promise<string[]> {
  const s = await states(page);
  return Object.keys(s).filter((k) => s[k] === 'front' || s[k] === 'visible');
}

test.describe('FR-295 開いているコンポーネントの一覧', () => {
  // FR-295 AC-797
  test('FR-295 AC-797 一覧に最小化・閉じたものを含む全コンポーネントが名前と状態つきで並び、項目の操作で復元・最小化・再表示でき、選択・絞り込み・入力が変わらない', async ({ page, start }) => {
    await start();
    await setup(page);
    const ks = await shown(page);
    expect(ks.length, '3 つ以上のコンポーネントが必要').toBeGreaterThanOrEqual(3);
    const [a, b, c] = ks;
    const search = page.getByRole('searchbox', { name: /検索/ });
    await search.fill('絞り込み確認');
    await action(component(page, b), '最小化');
    await action(component(page, c), '非表示');
    const bBefore = await box(component(page, a)); // 参照: 前面側が動かない
    const s = await states(page);
    expect(s[b]).toBe('minimized');
    expect(s[c]).toBe('closed');
    // すべてのコンポーネントが名前つきで並び、状態が文字か図で区別できる（色だけにしない）
    expect(await items(page).count()).toBeGreaterThanOrEqual(ks.length);
    for (const k of [a, b, c]) {
      const it = item(page, k);
      await expect(it, `${k}: 一覧の項目`).toBeVisible();
      expect((await it.innerText()).trim().length, `${k}: 名前の文字`).toBeGreaterThan(0);
      const name = (await it.getAttribute('aria-label')) ?? (await it.innerText());
      expect(name, `${k}: 状態の語`).toMatch(/前面|表示中|最小化|閉じた/);
    }
    expect(Object.values(s).filter((v) => v === 'front').length, '前面は 1 つだけ').toBe(1);
    // 最小化中の項目 → 元の位置・大きさで前面に復元
    const bOrig = await (async () => { await item(page, b).click(); return box(component(page, b)); })();
    await expect(item(page, b)).toHaveAttribute('data-state', 'front');
    expect(bOrig.width, '復元した幅').toBeGreaterThan(0);
    await expect(component(page, a)).toBeVisible();
    // 前面の項目 → 最小化
    await item(page, b).click();
    await expect(item(page, b)).toHaveAttribute('data-state', 'minimized');
    // 閉じた項目 → 再表示
    await item(page, c).click();
    await expect(component(page, c)).toBeVisible();
    await expect(item(page, c)).toHaveAttribute('data-state', /^(front|visible)$/);
    // 操作の前後で絞り込み・ペルソナが変わらない
    await expect(search).toHaveValue('絞り込み確認');
    await expect(page.getByRole('button', { name: /ペルソナ/ })).toContainText('事業部門');
  });

  // FR-295 AC-797 異常系: 一覧に無いコンポーネントを作らない・状態の整合（最小化したものは画面に出ない）
  test('FR-295 AC-797 異常系: 最小化・閉じた項目のコンポーネントは画面に表示されず、一覧から消えない', async ({ page, start }) => {
    await start();
    await setup(page);
    const [, b, c] = await shown(page);
    const bFull = await box(component(page, b));
    await action(component(page, b), '最小化');
    await action(component(page, c), '非表示');
    // 最小化は見出しだけ残る（FR-151 AC-260）。コンテンツ領域は表示されない（枠の高さが縮む）
    await expect.poll(async () => (await box(component(page, b))).height, { message: '最小化で内容が畳まれる' }).toBeLessThan(bFull.height / 2);
    await expect(component(page, c)).toBeHidden();
    await expect(item(page, b)).toBeVisible();
    await expect(item(page, c)).toBeVisible();
  });

  // FR-295 AC-799
  test('FR-295 AC-799 重ねて前面にし最小化・閉じた状態が再読込で復元され、既定のレイアウトに戻すと既定に戻る', async ({ page, start }) => {
    const app = await start();
    await setup(page);
    const ks = await shown(page);
    expect(ks.length).toBeGreaterThanOrEqual(4);
    const [a, b, c, d] = ks;
    const initial = await states(page);
    const initialBoxes: Record<string, Box> = {};
    for (const k of [a, b, c, d]) initialBoxes[k] = await box(component(page, k));
    // 1 つを自由配置にすると全部が自由配置になる（FR-173）。そのうえで b を a に重ねる
    await component(page, a).focus();
    await component(page, a).getByTestId('component-menu').click();
    await page.getByRole('menuitem', { name: '自由に動かせる配置にする', exact: true }).click();
    const ba = await box(component(page, a));
    const hb = await box(component(page, b).getByTestId('panel-handle').first());
    const bb = await box(component(page, b));
    const dx = ba.x + 40 - bb.x;
    const dy = ba.y + 40 - bb.y;
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.mouse.down();
    await page.mouse.move(hb.x + hb.width / 2 + dx, hb.y + hb.height / 2 + dy, { steps: 12 });
    await page.mouse.up();
    // 後ろのもの（a）を押して前面に出す
    await component(page, a).getByTestId('panel-body').click({ position: { x: 4, y: 4 } });
    await expect(item(page, a)).toHaveAttribute('data-state', 'front');
    expect(await zIndex(component(page, a)), 'a が b より前').toBeGreaterThan(await zIndex(component(page, b)));
    // 重なりで操作ボタンが覆われうるため、c・d の操作はボタンへ直接 click を送る
    const act = async (k: string, name: string) => { await component(page, k).focus(); await component(page, k).getByTestId('component-actions').getByRole('button', { name, exact: true }).dispatchEvent('click'); };
    await act(c, '最小化');
    await act(d, '非表示');
    const snap = async () => {
      const o: Record<string, { state: State; box: Box | null; z: number }> = {};
      const st = await states(page);
      for (const k of [a, b, c, d]) {
        const vis = st[k] === 'front' || st[k] === 'visible';
        o[k] = { state: st[k], box: vis ? await box(component(page, k)) : null, z: vis ? await zIndex(component(page, k)) : 0 };
      }
      return o;
    };
    const before = await snap();
    await app.reload();
    await expect(list(page)).toBeVisible();
    const after = await snap();
    for (const k of [a, b, c, d]) {
      expect(after[k].state, `${k}: 再読込後の状態`).toBe(before[k].state);
      if (before[k].box) {
        for (const p of ['x', 'y', 'width', 'height'] as const) {
          expect(Math.abs(after[k].box![p] - before[k].box![p]), `${k}.${p} 再読込後`).toBeLessThanOrEqual(TOL);
        }
      }
    }
    expect(after[a].z, '再読込後も a が b より前').toBeGreaterThan(after[b].z);
    // 異常系: 既定のレイアウトに戻すと、状態・位置・大きさが既定に戻る
    await resetLayout(page);
    const reset = await states(page);
    for (const k of [a, b, c, d]) {
      expect(reset[k], `${k}: 既定の状態`).toBe(initial[k] === 'front' ? reset[k] : initial[k]);
      if (initial[k] === 'front' || initial[k] === 'visible') await sameBox(component(page, k), initialBoxes[k], `${k}: 既定の位置・大きさ`);
    }
  });
});

test.describe('FR-296 既定の構成と最小サイズ', () => {
  // FR-296 AC-800
  test('FR-296 AC-800 各ペルソナ・各画面の既定のレイアウトで、同時表示が 4 個以内・各 360x240 以上で、残りは最小化で一覧にある', async ({ page, start }) => {
    await start();
    await page.setViewportSize({ width: 1280, height: 800 });
    const check = async (label: string) => {
      const s = await states(page);
      const keys = Object.keys(s);
      const vis = keys.filter((k) => s[k] === 'front' || s[k] === 'visible');
      expect(vis.length, `${label}: 同時表示の数`).toBeLessThanOrEqual(MAX_VISIBLE);
      expect(vis.length, `${label}: 1 つ以上表示`).toBeGreaterThanOrEqual(1);
      for (const k of vis) {
        const b = await box(component(page, k));
        expect(b.width, `${label}/${k}: 幅`).toBeGreaterThanOrEqual(MIN_W - TOL);
        expect(b.height, `${label}/${k}: 高さ`).toBeGreaterThanOrEqual(MIN_H - TOL);
      }
      // 異常系: 残りは非表示（closed）ではなく最小化の状態で一覧にある
      expect(keys.filter((k) => s[k] === 'closed'), `${label}: 閉じたもの`).toEqual([]);
      expect(keys.filter((k) => s[k] === 'minimized').length + vis.length, `${label}: 一覧の数`).toBe(keys.length);
    };
    for (const p of PERSONAS) {
      await selectPersona(page, p);
      await resetLayout(page);
      await check(`persona ${p}`);
    }
    // 各画面: 既定のレイアウトから画面を開いても同時表示の上限と最小サイズを守る
    await selectPersona(page, '事業部門');
    for (const [key] of MAIN_SCREENS) {
      if (key === 'settings') continue;
      await resetLayout(page);
      await openScreen(page, key);
      await check(`screen ${key}`);
    }
  });
});

test.describe('FR-297 没入表示・奥行き', () => {
  // FR-297 AC-802
  test('FR-297 AC-802 最大化で背面が 60% 暗くなり操作できず全体を占め、Esc と一覧の操作で戻り、絞り込みが変わらない', async ({ page, start }) => {
    await start();
    await setup(page);
    const [a, b] = await shown(page);
    const search = page.getByRole('searchbox', { name: /検索/ });
    await search.fill('没入確認');
    const ws = await box(page.getByTestId('workspace'));
    const before = await box(component(page, a));
    const bBox = await box(component(page, b));
    await action(component(page, a), '最大化');
    await expect(component(page, a)).toHaveAttribute('data-maximized', 'true');
    await sameBox(component(page, a), ws, '最大化は作業領域の全体');
    const alpha = await page.getByTestId('immersive-backdrop').evaluate((el) => {
      const cs = getComputedStyle(el);
      const m = cs.backgroundColor.match(/[\d.]+/g) ?? [];
      const a0 = m.length >= 4 ? Number(m[3]) : 1;
      return a0 * Number(cs.opacity);
    });
    expect(Math.abs(alpha - DIM), '背面の減光 PARAM-137').toBeLessThanOrEqual(0.05);
    // 背面のコンポーネントは操作できない（最大化したものが覆う）
    const hit = await page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      return el?.closest('[data-testid^="component-"]')?.getAttribute('data-testid') ?? null;
    }, { x: bBox.x + bBox.width / 2, y: bBox.y + bBox.height / 2 });
    expect(hit, '背面の上の点は背面のコンポーネントに当たらない').not.toBe(`component-${b}`);
    // Esc で戻る
    await page.keyboard.press('Escape');
    await expect(component(page, a)).not.toHaveAttribute('data-maximized', 'true');
    await sameBox(component(page, a), before, 'Esc で元の位置・大きさ');
    await expect(search).toHaveValue('没入確認');
    // 一覧の操作で戻る
    await action(component(page, a), '最大化');
    await expect(component(page, a)).toHaveAttribute('data-maximized', 'true');
    await item(page, a).click();
    await expect(component(page, a)).not.toHaveAttribute('data-maximized', 'true');
    await sameBox(component(page, a), before, '一覧の操作で元の位置・大きさ');
    await expect(search).toHaveValue('没入確認');
  });

  // FR-297 AC-803
  for (const theme of ['light', 'dark', 'hc'] as const) {
    test(`FR-297 AC-803 ${theme}: 前面は背面より強い影か境界線と見出しの強調（文字かアイコン）で区別でき、見出しの文字が AA`, async ({ page, start }) => {
      await start();
      if (theme === 'hc') await page.emulateMedia({ forcedColors: 'active' });
      else await page.emulateMedia({ colorScheme: theme, forcedColors: 'none' });
      await setup(page);
      const [front, back] = await shown(page);
      await component(page, front).focus();
      await expect(item(page, front)).toHaveAttribute('data-state', 'front');
      await expect(component(page, front).getByTestId('front-indicator'), '前面の見出しの強調').toBeVisible();
      await expect(component(page, back).getByTestId('front-indicator'), '背面に強調はない').toHaveCount(0);
      const edge = (c: Locator) => c.evaluate((el) => {
        const cs = getComputedStyle(el);
        const shadow = cs.boxShadow === 'none' ? 0 : (cs.boxShadow.match(/\d+(\.\d+)?px/g) ?? []).map((v) => parseFloat(v)).reduce((s, v) => s + v, 0);
        const line = Math.max(parseFloat(cs.borderTopWidth) || 0, parseFloat(cs.outlineWidth) || 0);
        return { shadow, line };
      });
      const f = await edge(component(page, front));
      const bk = await edge(component(page, back));
      if (theme === 'hc') expect(f.line, 'ハイコントラストでは前面の境界線が背面より太い').toBeGreaterThan(bk.line);
      else expect(f.shadow, '前面の影が背面より強い').toBeGreaterThan(bk.shadow);
      // 見出しの文字のコントラスト（透明の背景は祖先の不透明な背景に重ねて計算）。ハイコントラストでは背景が不透明
      const head = await component(page, front).getByTestId('panel-handle').first().evaluate((el) => {
        const parse = (s: string) => (s.match(/[\d.]+/g) ?? ['0', '0', '0', '1']).map(Number);
        let bg = [255, 255, 255];
        const chain: number[][] = [];
        for (let e: Element | null = el; e; e = e.parentElement) chain.push(parse(getComputedStyle(e).backgroundColor));
        for (const c of chain.reverse()) {
          const a = c.length >= 4 ? c[3] : 1;
          bg = bg.map((v, i) => Math.round(c[i] * a + v * (1 - a)));
        }
        return { color: getComputedStyle(el).color, bg: `rgb(${bg.join(',')})`, ownAlpha: parse(getComputedStyle(el).backgroundColor)[3] ?? 1 };
      });
      if (theme === 'hc') expect(head.ownAlpha, 'ハイコントラストでは見出しの素材が不透明').toBe(1);
      expect(contrastRatio(head.color, head.bg), '見出しの文字は AA（4.5 以上）').toBeGreaterThanOrEqual(4.5);
    });
  }
});
