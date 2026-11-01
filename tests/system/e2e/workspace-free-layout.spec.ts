// System Test: コンポーネントの自由移動・ダブルクリック拡大・拡大位置の設定・作業先メニューの最上位配置（FR-173〜176）
// 期待値は要求定義書の受入基準（docs/requirements/app-experience.md の FR-173〜176）だけから決める。
// 画面の探し方は tests/system/CONTRACT.md §12。PARAM-058=75（%）、PARAM-059=上、PARAM-029=320（CSS px）。
import type { Page, Locator } from '@playwright/test';
import { test, expect, openScreen, component, selectPersona, MAIN_SCREENS, screenEntry } from '../support/fixtures';

const RATIO = 0.75; // PARAM-058
const TOL = 0.03; // 割合・位置の許容（キャンバスの寸法に対する比）

type Box = { x: number; y: number; width: number; height: number };
async function box(loc: Locator): Promise<Box> {
  const b = await loc.boundingBox();
  expect(b, '要素が表示されていない').not.toBeNull();
  return b!;
}
const workspace = (page: Page) => page.getByTestId('workspace');
const heading = (c: Locator) => c.getByRole('heading').first();

async function topKeys(page: Page): Promise<string[]> {
  return workspace(page).evaluate((ws) => {
    const sel = '[data-testid^="component-"]:not([data-testid="component-menu"]):not([data-testid="component-actions"])';
    const out: string[] = [];
    ws.querySelectorAll(sel).forEach((el) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      if (!el.parentElement?.closest(sel) && r.width > 0 && r.height > 0) out.push((el.getAttribute('data-testid') ?? '').replace('component-', ''));
    });
    return out;
  });
}

async function dragHeading(page: Page, c: Locator, toX: number, toY: number): Promise<void> {
  const h = await box(heading(c));
  const x = h.x + h.width / 2;
  const y = h.y + h.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move((x + toX) / 2, (y + toY) / 2, { steps: 6 });
  await page.mouse.move(toX, toY, { steps: 6 });
  await page.mouse.up();
}

const overlap = (a: Box, b: Box) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

test.describe('FR-173 コンポーネントのキャンバス内での自由な移動', () => {
  // FR-296 AC-800/801: 既定の構成の下限（360x240）と作業領域のゾーンにより、1600x900 では 2 行目が画面外になるため、画面の高さを広げて前提を揃える（検証内容は変えない）。
  test.use({ viewport: { width: 1600, height: 1400 } });
  // FR-173 AC-348（Q-066 B 2026-10-27 で改訂: 重なる位置へ置くと押し出さず、重なって表示され、掴んだものが手前に出る）
  test('FR-173 AC-348 ヘッダーのドラッグで別の位置に置け、再読込後も同じ位置。ほかのコンポーネントの上へ置くと押し出されず重なって表示され、掴んだものが手前に出る', async ({ page, start }) => {
    const app = await start();
    await selectPersona(page, '事業部門');
    const ks = await topKeys(page);
    expect(ks.length, 'コンポーネントが 2 つ以上必要').toBeGreaterThanOrEqual(2);
    const [a, b] = ks;
    const ba = await box(component(page, a));
    const bb = await box(component(page, b));
    // a を b の中央へ（重ねて置く。b は押し出されない）
    await dragHeading(page, component(page, a), bb.x + bb.width / 2, bb.y + bb.height / 2);
    await page.waitForTimeout(700); // 押し出しのアニメーションがあっても終わる時間
    const moved = await box(component(page, a));
    const bAfter = await box(component(page, b));
    expect(Math.abs(moved.x - ba.x) + Math.abs(moved.y - ba.y), '位置が変わらない').toBeGreaterThan(2);
    expect(overlap(moved, bAfter), '重なって表示されない（重なりを許す）').toBeGreaterThan(100);
    expect(Math.abs(bAfter.x - bb.x) + Math.abs(bAfter.y - bb.y), 'ぶつかられた b が押し出された（動いてはならない）').toBeLessThanOrEqual(4);
    // 重なった領域の中心では、掴んだ a が手前に表示される
    const cx = (Math.max(moved.x, bAfter.x) + Math.min(moved.x + moved.width, bAfter.x + bAfter.width)) / 2;
    const cy = (Math.max(moved.y, bAfter.y) + Math.min(moved.y + moved.height, bAfter.y + bAfter.height)) / 2;
    const frontKey = await page.evaluate(([x, y]) => {
      const el = document.elementFromPoint(x, y);
      const hit = el?.closest('[data-testid^="component-"]:not([data-testid="component-menu"]):not([data-testid="component-actions"]):not([data-testid="component-data"])');
      return hit?.getAttribute('data-testid') ?? null;
    }, [cx, cy]);
    expect(frontKey, '掴んだコンポーネントが手前に出ていない').toBe(`component-${a}`);
    const pos = await box(component(page, a));
    await app.reload();
    const again = await box(component(page, a));
    expect(Math.abs(again.x - pos.x), '再読込後の x').toBeLessThanOrEqual(2);
    expect(Math.abs(again.y - pos.y), '再読込後の y').toBeLessThanOrEqual(2);
  });

  // FR-173 AC-348（異常系: キャンバスの外へは出ない）
  test('FR-173 AC-348 異常系: キャンバスの外へドラッグしても、コンポーネントはキャンバスの外へ出ない', async ({ page, start }) => {
    await start();
    await selectPersona(page, '事業部門');
    const [k] = await topKeys(page);
    const ws = await box(workspace(page));
    const c = component(page, k);
    for (const [tx, ty] of [[ws.x + ws.width + 400, ws.y + ws.height + 400], [ws.x - 400, ws.y - 400]] as const) {
      const vp = page.viewportSize()!;
      await dragHeading(page, c, Math.min(Math.max(tx, 1), vp.width - 1), Math.min(Math.max(ty, 1), vp.height - 1));
      const b = await box(c);
      expect(b.x, `${k}: 左端が外`).toBeGreaterThanOrEqual(ws.x - 2);
      expect(b.y, `${k}: 上端が外`).toBeGreaterThanOrEqual(ws.y - 2);
      expect(b.x + b.width, `${k}: 右端が外`).toBeLessThanOrEqual(ws.x + ws.width + 2);
      expect(b.y + b.height, `${k}: 下端が外`).toBeLessThanOrEqual(ws.y + ws.height + 2);
    }
  });

  // FR-173 AC-348（異常系: 本文をつかんでも動かない）
  test('FR-173 AC-348 異常系: ヘッダー以外（本文）をドラッグしても位置は変わらない', async ({ page, start }) => {
    await start();
    await selectPersona(page, '事業部門');
    const [k] = await topKeys(page);
    const c = component(page, k);
    const before = await box(c);
    const hb = await box(heading(c));
    const x = before.x + before.width / 2;
    const y = Math.max(hb.y + hb.height + 20, before.y + before.height / 2);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 120, y + 80, { steps: 8 });
    await page.mouse.up();
    const after = await box(c);
    expect(Math.abs(after.x - before.x) + Math.abs(after.y - before.y)).toBeLessThanOrEqual(2);
  });
});

async function expectExpanded(page: Page, k: string, side: '上' | '左' | '右' | '下') {
  const ws = await box(workspace(page));
  const b = await box(component(page, k));
  const tolX = ws.width * TOL;
  const tolY = ws.height * TOL;
  const horizontal = side === '上' || side === '下';
  if (horizontal) {
    expect(Math.abs(b.width - ws.width), `${side}: 幅は全幅`).toBeLessThanOrEqual(tolX);
    expect(Math.abs(b.height - ws.height * RATIO), `${side}: 高さは 75%`).toBeLessThanOrEqual(tolY);
    const y = side === '上' ? ws.y : ws.y + ws.height - b.height;
    expect(Math.abs(b.y - y), `${side}: 位置`).toBeLessThanOrEqual(tolY);
    expect(Math.abs(b.x - ws.x), `${side}: x`).toBeLessThanOrEqual(tolX);
  } else {
    expect(Math.abs(b.height - ws.height), `${side}: 高さは全高`).toBeLessThanOrEqual(tolY);
    expect(Math.abs(b.width - ws.width * RATIO), `${side}: 幅は 75%`).toBeLessThanOrEqual(tolX);
    const x = side === '左' ? ws.x : ws.x + ws.width - b.width;
    expect(Math.abs(b.x - x), `${side}: 位置`).toBeLessThanOrEqual(tolX);
    expect(Math.abs(b.y - ws.y), `${side}: y`).toBeLessThanOrEqual(tolY);
  }
  return b;
}

test.describe('FR-174 ヘッダーのダブルクリックでの拡大表示と復帰', () => {
  // FR-174 AC-350
  test('FR-174 AC-350 ダブルクリックで上側に全幅×75% で拡大し、ほかは非表示にならず、再度で元の位置・大きさに戻る。最大化にならない', async ({ page, start }) => {
    await start();
    await selectPersona(page, '事業部門');
    const ks = await topKeys(page);
    expect(ks.length).toBeGreaterThanOrEqual(2);
    const [k, ...others] = ks;
    const before = await box(component(page, k));
    await heading(component(page, k)).dblclick();
    await expect(component(page, k)).toHaveAttribute('data-expanded', 'true');
    const exp = await expectExpanded(page, k, '上');
    expect(await component(page, k).getAttribute('data-maximized'), 'ダブルクリックで最大化になっている').not.toBe('true');
    const ws = await box(workspace(page));
    for (const o of others) {
      const ob = await box(component(page, o));
      expect(await component(page, o).isVisible(), `${o} が非表示`).toBe(true);
      expect(overlap(exp, ob), `${o} が拡大表示と重なる`).toBeLessThanOrEqual(4);
      expect(ob.y + ob.height, `${o} が領域の外`).toBeLessThanOrEqual(ws.y + ws.height + 2);
    }
    await heading(component(page, k)).dblclick();
    await expect(component(page, k)).not.toHaveAttribute('data-expanded', 'true');
    const back = await box(component(page, k));
    for (const p of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(back[p] - before[p]), `復帰後の ${p}`).toBeLessThanOrEqual(2);
  });

  // FR-174 AC-350（異常系: 本文のダブルクリックでは拡大しない）
  test('FR-174 AC-350 異常系: ヘッダー以外（本文）のダブルクリックでは拡大表示にならない', async ({ page, start }) => {
    await start();
    await selectPersona(page, '事業部門');
    const [k] = await topKeys(page);
    const c = component(page, k);
    const b = await box(c);
    const hb = await box(heading(c));
    await page.mouse.dblclick(b.x + b.width / 2, Math.max(hb.y + hb.height + 20, b.y + b.height / 2));
    await expect(c).not.toHaveAttribute('data-expanded', 'true');
    const after = await box(c);
    expect(Math.abs(after.width - b.width) + Math.abs(after.height - b.height)).toBeLessThanOrEqual(2);
  });
});

test.describe('FR-175 拡大表示の位置の設定', () => {
  // FR-175 AC-352
  test('FR-175 AC-352 設定画面で「左」にした利用者のダブルクリックで、キャンバスの左側（幅 75%×全高）に拡大表示される', async ({ page, start }) => {
    await start();
    await selectPersona(page, '事業部門');
    const settings = await openScreen(page, 'settings');
    const group = settings.getByRole('radiogroup', { name: '拡大表示の位置' });
    await group.getByRole('radio', { name: '左' }).check();
    await expect(group.getByRole('radio', { name: '左' })).toBeChecked();
    await openScreen(page, 'canvas');
    const [k] = await topKeys(page);
    await heading(component(page, k)).dblclick();
    await expect(component(page, k)).toHaveAttribute('data-expanded', 'true');
    await expectExpanded(page, k, '左');
  });

  // FR-175 AC-352（異常系: 既定のままなら左にならない。設定が拡大以外の位置に影響しない）
  test('FR-175 AC-352 異常系: 設定を変えていない利用者の拡大表示は左側ではなく上側になる', async ({ page, start }) => {
    await start();
    await selectPersona(page, '事業部門');
    const [k] = await topKeys(page);
    await heading(component(page, k)).dblclick();
    await expectExpanded(page, k, '上');
    const ws = await box(workspace(page));
    const b = await box(component(page, k));
    expect(b.width, '左 75% になっている').toBeGreaterThan(ws.width * 0.9);
  });
});

test.describe('FR-176 作業先・企業・Project のメニューを画面の最上位に置く', () => {
  // FR-176 AC-354
  for (const vp of [{ width: 1280, height: 800 }, { width: 1920, height: 1080 }]) {
    test(`FR-176 AC-354 ${vp.width}px 幅で、「作業先」と「企業を登録」の上端が、ほかのすべてのメニュー・操作の上端より上（同じ段か上）`, async ({ page, start }) => {
      await page.setViewportSize(vp);
      await start();
      const top = async (l: Locator) => (await box(l.first())).y;
      const wt = await top(page.getByTestId('work-target-menu'));
      const reg = await top(page.getByRole('button', { name: '企業を登録' }));
      const first = Math.max(wt, reg);
      const others: Array<[string, Locator]> = [
        ['ペルソナ', page.getByRole('button', { name: /ペルソナ/ })],
        ['編集モード', page.getByRole('switch', { name: '編集モード' })],
        // 設定は上部のボタン「設定」（FR-223 AC-774。作業先の段より上に置かない）
        ...MAIN_SCREENS.map(([k]): [string, Locator] => [k === 'settings' ? '設定' : `nav-${k}`, screenEntry(page, k)]),
      ];
      const stepper = page.getByTestId('stepper');
      if (await stepper.count()) others.push(['stepper', stepper]);
      // ほかのメニュー・操作（表示されているものすべて）の上端より、作業先と企業を登録の上端が上か同じ
      for (const [name, l] of others) {
        if (!(await l.first().isVisible())) continue;
        const y = await top(l);
        expect(first, `${name}（y=${y}）より下に作業先・企業を登録（y=${first}）がある`).toBeLessThanOrEqual(y + 1);
      }
      // 画面の上端から見て最初に現れる段は作業先・企業・Project の段
      const firstControl = await page.evaluate(() => {
        const els = Array.from(document.querySelectorAll('button,[role="switch"],[role="radio"],a[href],[role="menuitem"]')) as HTMLElement[];
        const vis = els.filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0; });
        vis.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
        const t = vis[0].getBoundingClientRect().top;
        return vis.filter((e) => Math.abs(e.getBoundingClientRect().top - t) <= 2).map((e) => (e.getAttribute('data-testid') ?? '') + '|' + (e.textContent ?? '') + '|' + (e.getAttribute('aria-label') ?? ''));
      });
      expect(firstControl.some((s) => /work-target|作業先|企業を登録/.test(s)), `最上段の操作: ${firstControl.join(', ')}`).toBe(true);
    });
  }

  // FR-176 AC-354（異常系: 別の作業先・別の画面でも最上段）
  test('FR-176 AC-354 異常系: 画面（分析画面など）を切り替えても作業先・企業の段は最上段のまま', async ({ page, start }) => {
    await start();
    for (const key of ['priority', 'settings']) {
      await openScreen(page, key);
      const wt = (await box(page.getByTestId('work-target-menu'))).y;
      const nav = (await box(screenEntry(page, key))).y; // 設定は上部のボタン「設定」（FR-223 AC-774）
      expect(wt, `${key} 表示中に作業先が nav より下`).toBeLessThanOrEqual(nav + 1);
    }
  });
});

