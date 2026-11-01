// System Test: Windows 風のスナップ（上端=最大化・左右端=半分・角=4分の1のプレビュー、共有境界のリサイズ）（FR-152 AC-793・AC-796）
// 期待値は要求定義書の受入基準（docs/requirements/app-experience.md の FR-152）だけから決める。
// 画面の探し方は tests/system/CONTRACT.md §10・§15。PARAM-042=32 CSS px。
import type { Page, Locator } from '@playwright/test';
import { test, expect, component, selectPersona } from '../support/fixtures';

const SNAP_EDGE = 32; // PARAM-042
const TOL = 0.06;

type Box = { x: number; y: number; width: number; height: number };
async function box(loc: Locator): Promise<Box> {
  const b = await loc.boundingBox();
  expect(b, '要素が表示されていない').not.toBeNull();
  return b!;
}
const workspace = (page: Page) => page.getByTestId('workspace');
const heading = (c: Locator) => c.getByRole('heading').first();
const overlap = (a: Box, b: Box) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
const SEL = '[data-testid^="component-"]:not([data-testid="component-menu"]):not([data-testid="component-actions"])';

async function topKeys(page: Page): Promise<string[]> {
  return workspace(page).evaluate((ws, sel) => {
    const out: string[] = [];
    ws.querySelectorAll(sel).forEach((el) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      if (!el.parentElement?.closest(sel) && r.width > 0 && r.height > 0) out.push((el.getAttribute('data-testid') ?? '').replace('component-', ''));
    });
    return out;
  }, SEL);
}

/** 見出しを掴んで (toX, toY) へ運ぶ。release=false なら離さない。 */
async function grabTo(page: Page, c: Locator, toX: number, toY: number, release: boolean): Promise<void> {
  const h = await box(heading(c));
  const x = h.x + h.width / 2;
  const y = h.y + h.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move((x + toX) / 2, (y + toY) / 2, { steps: 6 });
  await page.mouse.move(toX, toY, { steps: 6 });
  if (release) await page.mouse.up();
}

function near(actual: Box, expected: Box, ws: Box, msg: string) {
  expect(Math.abs(actual.x - expected.x), `${msg}: x`).toBeLessThanOrEqual(ws.width * TOL);
  expect(Math.abs(actual.y - expected.y), `${msg}: y`).toBeLessThanOrEqual(ws.height * TOL);
  expect(Math.abs(actual.width - expected.width), `${msg}: 幅`).toBeLessThanOrEqual(ws.width * TOL);
  expect(Math.abs(actual.height - expected.height), `${msg}: 高さ`).toBeLessThanOrEqual(ws.height * TOL);
}

test.describe('FR-152 Windows 風スナップのプレビューと最大化・共有境界のリサイズ', () => {
  // FR-296 AC-800/801: 既定の構成の下限（360x240）と作業領域のゾーンにより、1600x900 では 2 行目が画面外になるため、画面の高さを広げて前提を揃える（検証内容は変えない）。
  test.use({ viewport: { width: 1600, height: 1400 } });
  // FR-152 AC-793（上端=最大化。ほかのコンポーネントは重ならず背面か非表示）
  test('FR-152 AC-793 上端へ近づけると最大化のプレビューが半透明で出て、離すと作業領域いっぱいに最大化され、ほかのものは重ならず背面か非表示', async ({ page, start }) => {
    await start();
    await selectPersona(page, '事業部門');
    const ks = await topKeys(page);
    expect(ks.length, 'コンポーネントが 2 つ以上必要').toBeGreaterThanOrEqual(2);
    const [a, b] = ks;
    const ws = await box(workspace(page));
    await grabTo(page, component(page, a), ws.x + ws.width / 2, ws.y + SNAP_EDGE / 2, false);
    const preview = page.getByTestId('snap-preview');
    await expect(preview, '最大化のプレビューが出ない').toBeVisible();
    near(await box(preview), ws, ws, '最大化のプレビュー');
    const opacity = await preview.evaluate((el) => parseFloat(getComputedStyle(el).opacity) * (parseFloat(getComputedStyle(el).backgroundColor.split(',')[3] ?? '1') || 1));
    expect(opacity, 'プレビューが半透明でない').toBeLessThan(1);
    await page.mouse.up();
    await expect(preview).toBeHidden();
    await expect(component(page, a)).toHaveAttribute('data-maximized', 'true');
    near(await box(component(page, a)), ws, ws, '最大化した a');
    // ほかのコンポーネントは重ならない（非表示、または背面で a が手前）
    const visibleOthers = (await topKeys(page)).filter((k) => k !== a);
    for (const k of visibleOthers) {
      const bb = await box(component(page, k));
      const cx = bb.x + bb.width / 2;
      const cy = bb.y + bb.height / 2;
      const front = await page.evaluate(([x, y, sel]) => document.elementFromPoint(x as number, y as number)?.closest(sel as string)?.getAttribute('data-testid') ?? null, [cx, cy, SEL]);
      expect(front, `${k} が最大化した a の上に重なっている`).toBe(`component-${a}`);
    }
    expect(b, 'b が必要').toBeTruthy();
  });

  // FR-152 AC-793（左右端=半分、角=4分の1。離すと領域いっぱい）
  test('FR-152 AC-793 右端は右半分・左上の角は 4 分の 1 のプレビューが出て、離すとその領域いっぱいに配置される', async ({ page, start }) => {
    await start();
    await selectPersona(page, '事業部門');
    const [a] = await topKeys(page);
    const ws = await box(workspace(page));
    const cy = ws.y + ws.height / 2;
    await grabTo(page, component(page, a), ws.x + ws.width - SNAP_EDGE / 2, cy, false);
    const preview = page.getByTestId('snap-preview');
    await expect(preview).toBeVisible();
    const right: Box = { x: ws.x + ws.width / 2, y: ws.y, width: ws.width / 2, height: ws.height };
    near(await box(preview), right, ws, '右半分のプレビュー');
    await page.mouse.up();
    near(await box(component(page, a)), right, ws, '右半分に配置');
    // 左上の角
    await grabTo(page, component(page, a), ws.x + SNAP_EDGE / 2, ws.y + SNAP_EDGE / 2, false);
    await expect(preview).toBeVisible();
    const quarter: Box = { x: ws.x, y: ws.y, width: ws.width / 2, height: ws.height / 2 };
    near(await box(preview), quarter, ws, '4 分の 1 のプレビュー');
    await page.mouse.up();
    near(await box(component(page, a)), quarter, ws, '左上 4 分の 1 に配置');
  });

  // FR-152 AC-793（異常系: 候補の範囲外へ戻すとプレビューが消え、離しても配置は変わらない）
  test('FR-152 AC-793 異常系: 端へ近づけたあと候補の範囲外へ戻すとプレビューが消え、離しても配置が変わらない（最大化にもならない）', async ({ page, start }) => {
    await start();
    await selectPersona(page, '事業部門');
    const [a] = await topKeys(page);
    const ws = await box(workspace(page));
    const c = component(page, a);
    const before = await box(c);
    await grabTo(page, c, ws.x + ws.width / 2, ws.y + SNAP_EDGE / 2, false);
    await expect(page.getByTestId('snap-preview')).toBeVisible();
    await page.mouse.move(ws.x + ws.width / 2, ws.y + ws.height / 2, { steps: 8 });
    await expect(page.getByTestId('snap-preview'), '範囲外でプレビューが消えない').toBeHidden();
    await page.mouse.up();
    expect(await c.getAttribute('data-maximized'), '範囲外で離したのに最大化された').not.toBe('true');
    const after = await box(c);
    expect(Math.abs(after.width - before.width) + Math.abs(after.height - before.height), '離したら配置が変わった').toBeLessThanOrEqual(ws.width * TOL);
  });

  // FR-152 AC-796（共有境界のリサイズ: 両側が同時に変わり、隙間も重なりも生じない）
  test('FR-152 AC-796 左半分・右半分に並べた 2 つの共有境界をドラッグすると両側が同時にリサイズされ、操作中も後も隙間と重なりが生じない', async ({ page, start }) => {
    await start();
    await selectPersona(page, '事業部門');
    const ks = await topKeys(page);
    expect(ks.length, 'コンポーネントが 2 つ以上必要').toBeGreaterThanOrEqual(2);
    const [a, b] = ks;
    const ws = await box(workspace(page));
    const cy = ws.y + ws.height / 2;
    const cand = page.getByTestId('snap-candidates');
    await grabTo(page, component(page, a), ws.x + 8, cy, false);
    await expect(cand).toBeVisible();
    await cand.getByRole('button', { name: '左半分' }).hover();
    await page.mouse.up();
    await page.waitForTimeout(600);
    await grabTo(page, component(page, b), ws.x + ws.width - 8, cy, false);
    await expect(cand).toBeVisible();
    await cand.getByRole('button', { name: '右半分' }).hover();
    await page.mouse.up();
    await page.waitForTimeout(600);
    const a0 = await box(component(page, a));
    const b0 = await box(component(page, b));
    expect(a0.x + a0.width, '左右に隣り合っていない').toBeLessThanOrEqual(b0.x + 6);
    // 2 つの間にある境界（separator）を探す
    const seps = page.getByRole('separator');
    const n = await seps.count();
    let grip: Locator | null = null;
    for (let i = 0; i < n; i++) {
      const sb = await seps.nth(i).boundingBox();
      if (sb && sb.x + sb.width >= a0.x + a0.width - 12 && sb.x <= b0.x + 12 && sb.y < cy && sb.y + sb.height > cy - 1) { grip = seps.nth(i); break; }
    }
    expect(grip, '共有する境界（separator）が見つからない').not.toBeNull();
    const gb = await box(grip!);
    const x0 = gb.x + gb.width / 2;
    await page.mouse.move(x0, cy);
    await page.mouse.down();
    const check = async (label: string) => {
      const pa = await box(component(page, a));
      const pb = await box(component(page, b));
      expect(overlap(pa, pb), `${label}: 重なり`).toBeLessThanOrEqual(4);
      expect(Math.abs(pb.x - (pa.x + pa.width)), `${label}: 隙間`).toBeLessThanOrEqual(6);
    };
    for (let i = 1; i <= 10; i++) {
      await page.mouse.move(x0 + 12 * i, cy);
      await page.waitForTimeout(30);
    }
    await check('操作中');
    await page.mouse.up();
    await page.waitForTimeout(400);
    const a1 = await box(component(page, a));
    const b1 = await box(component(page, b));
    expect(a1.width - a0.width, 'a が広がっていない').toBeGreaterThan(20);
    expect(b0.width - b1.width, 'b が同時に狭まっていない').toBeGreaterThan(20);
    await check('操作後');
  });

  // FR-152 AC-796（異常系: 大きく動かしても隙間・重なりが生じない）
  test('FR-152 AC-796 異常系: 共有境界を端まで大きく動かしても、隙間も重なりも生じない', async ({ page, start }) => {
    await start();
    await selectPersona(page, '事業部門');
    const [a, b] = await topKeys(page);
    const ws = await box(workspace(page));
    const cy = ws.y + ws.height / 2;
    const cand = page.getByTestId('snap-candidates');
    await grabTo(page, component(page, a), ws.x + 8, cy, false);
    await expect(cand).toBeVisible();
    await cand.getByRole('button', { name: '左半分' }).hover();
    await page.mouse.up();
    await page.waitForTimeout(600);
    await grabTo(page, component(page, b), ws.x + ws.width - 8, cy, false);
    await expect(cand).toBeVisible();
    await cand.getByRole('button', { name: '右半分' }).hover();
    await page.mouse.up();
    await page.waitForTimeout(600);
    const a0 = await box(component(page, a));
    const seps = page.getByRole('separator');
    let grip: Locator | null = null;
    for (let i = 0; i < await seps.count(); i++) {
      const sb = await seps.nth(i).boundingBox();
      if (sb && Math.abs(sb.x + sb.width / 2 - (a0.x + a0.width)) <= 16) { grip = seps.nth(i); break; }
    }
    expect(grip, '共有する境界（separator）が見つからない').not.toBeNull();
    const gb = await box(grip!);
    await page.mouse.move(gb.x + gb.width / 2, cy);
    await page.mouse.down();
    await page.mouse.move(ws.x + ws.width + 200 > (page.viewportSize()?.width ?? 0) ? (page.viewportSize()!.width - 1) : ws.x + ws.width + 200, cy, { steps: 20 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    const pa = await box(component(page, a));
    const pb = await box(component(page, b));
    expect(overlap(pa, pb), '重なり').toBeLessThanOrEqual(4);
    expect(Math.abs(pb.x - (pa.x + pa.width)), '隙間').toBeLessThanOrEqual(6);
    expect(pb.x + pb.width, 'b がキャンバスの外').toBeLessThanOrEqual(ws.x + ws.width + 2);
  });
});
