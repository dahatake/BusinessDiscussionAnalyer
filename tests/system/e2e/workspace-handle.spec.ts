// System Test: 掴み場所（ハンドル）・押し出し・移動中のアニメーション（FR-183〜185）
// 期待値は要求定義書の受入基準（docs/requirements/app-experience.md の FR-183〜185）だけから決める。
// 画面の探し方は tests/system/CONTRACT.md §15。PARAM-058=75（%）、PARAM-065=30（fps）。
import type { Page, Locator } from '@playwright/test';
import { test, expect, component, selectPersona, contrastRatio } from '../support/fixtures';

const RATIO = 0.75; // PARAM-058
const MIN_FPS = 30; // PARAM-065

type Box = { x: number; y: number; width: number; height: number };
async function box(loc: Locator): Promise<Box> {
  const b = await loc.boundingBox();
  expect(b, '要素が表示されていない').not.toBeNull();
  return b!;
}
const workspace = (page: Page) => page.getByTestId('workspace');
const handle = (c: Locator) => c.getByTestId('panel-handle').first();
const overlap = (a: Box, b: Box) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

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

async function dragHandle(page: Page, c: Locator, toX: number, toY: number): Promise<void> {
  const h = await box(handle(c));
  const x = h.x + h.width / 2;
  const y = h.y + h.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move((x + toX) / 2, (y + toY) / 2, { steps: 6 });
  await page.mouse.move(toX, toY, { steps: 6 });
  await page.mouse.up();
}

async function colors(c: Locator): Promise<{ handleBg: string; handleFg: string; bodyBg: string }> {
  return c.evaluate((el) => {
    const h = el.querySelector('[data-testid="panel-handle"]') as HTMLElement;
    const b = el.querySelector('[data-testid="panel-body"]') as HTMLElement;
    return { handleBg: getComputedStyle(h).backgroundColor, handleFg: getComputedStyle(h).color, bodyBg: getComputedStyle(b).backgroundColor };
  });
}

test.describe('FR-183 コンポーネント上部の掴み場所（ハンドル）', () => {
  // FR-183 AC-387
  for (const mode of ['light', 'dark', 'hc'] as const) {
    test(`FR-183 AC-387 ${mode}: すべてのコンポーネントの上部にハンドルが見え、本体の背景色と色が異なり、掴みの印が付いている`, async ({ page, start }) => {
      if (mode === 'hc') await page.emulateMedia({ forcedColors: 'active' });
      else await page.emulateMedia({ colorScheme: mode });
      await start();
      await selectPersona(page, '事業部門');
      const ks = await topKeys(page);
      expect(ks.length, 'コンポーネントが 1 つ以上必要').toBeGreaterThanOrEqual(1);
      for (const k of ks) {
        const c = component(page, k);
        await expect(handle(c), `${k}: ハンドルが見えない`).toBeVisible();
        const hb = await box(handle(c));
        const cb = await box(c);
        expect(hb.y - cb.y, `${k}: ハンドルがコンポーネントの上部にない`).toBeLessThanOrEqual(cb.height * 0.25);
        // 色以外の識別手段（掴みの印）
        const grip = handle(c).getByTestId('panel-handle-grip');
        await expect(grip, `${k}: 掴みの印がない`).toBeVisible();
        const gb = await box(grip);
        expect(gb.width * gb.height, `${k}: 掴みの印の大きさが 0`).toBeGreaterThan(0);
        // 色の違いと文字のコントラスト（ハイコントラストは OS が色を置き換えるので、色の差は Light/Dark だけで見る）
        const col = await colors(c);
        if (mode !== 'hc') {
          expect(col.handleBg, `${k}: ハンドルの背景色が本体と同じ`).not.toBe(col.bodyBg);
        }
        expect(contrastRatio(col.handleFg, col.handleBg), `${k}: ハンドルの文字のコントラスト`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }

  // FR-183 AC-387（異常系: 画面を切り替えても、追加で開いた別の画面のコンポーネントにもハンドルがある）
  test('FR-183 AC-387 異常系: ペルソナを切り替えて表示が変わっても、表示されたすべてのコンポーネントにハンドルがある', async ({ page, start }) => {
    await start();
    for (const persona of ['経営層', 'IT'] as const) {
      await selectPersona(page, persona);
      for (const k of await topKeys(page)) await expect(handle(component(page, k)), `${persona}/${k}: ハンドルがない`).toBeVisible();
    }
  });

  // FR-183 AC-388
  test('FR-183 AC-388 ハンドルを掴んでドラッグするとその位置に表示され、再読込後も同じ位置。メニューでも同じ移動ができる', async ({ page, start }) => {
    const app = await start();
    await selectPersona(page, '事業部門');
    const [k] = await topKeys(page);
    const c = component(page, k);
    const before = await box(c);
    const ws = await box(workspace(page));
    // キャンバス内の別の位置（右下寄りの余白側）へ
    const h = await box(handle(c));
    const dx = Math.min(160, ws.x + ws.width - (before.x + before.width) - 4);
    const dy = Math.min(120, ws.y + ws.height - (before.y + before.height) - 4);
    await dragHandle(page, c, h.x + h.width / 2 + dx, h.y + h.height / 2 + dy);
    const moved = await box(component(page, k));
    expect(Math.abs(moved.x - before.x) + Math.abs(moved.y - before.y), 'ドラッグで位置が変わらない').toBeGreaterThan(2);
    await app.reload();
    const again = await box(component(page, k));
    expect(Math.abs(again.x - moved.x), '再読込後の x').toBeLessThanOrEqual(2);
    expect(Math.abs(again.y - moved.y), '再読込後の y').toBeLessThanOrEqual(2);
    // ドラッグなし（メニュー）でも同じ移動ができる
    const p0 = await box(component(page, k));
    await component(page, k).getByTestId('component-menu').click();
    await page.getByRole('menuitem', { name: /移動/ }).first().click();
    await expect.poll(async () => { const b = await box(component(page, k)); return Math.abs(b.x - p0.x) + Math.abs(b.y - p0.y); }).toBeGreaterThan(2);
  });

  // FR-183 AC-388（異常系: 本文は掴めない）
  test('FR-183 AC-388 異常系: ハンドル以外の本体部分をドラッグしても移動は始まらない', async ({ page, start }) => {
    await start();
    await selectPersona(page, '事業部門');
    const [k] = await topKeys(page);
    const c = component(page, k);
    const before = await box(c);
    const hb = await box(handle(c));
    const x = before.x + before.width / 2;
    const y = Math.max(hb.y + hb.height + 24, before.y + before.height / 2);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 140, y + 90, { steps: 8 });
    await page.mouse.up();
    const after = await box(c);
    expect(Math.abs(after.x - before.x) + Math.abs(after.y - before.y)).toBeLessThanOrEqual(2);
  });

  // FR-183 AC-389
  test('FR-183 AC-389 ハンドルのダブルクリックで 75% に拡大し、もう一度で元の位置・大きさに戻る（最大化にならない）', async ({ page, start }) => {
    await start();
    await selectPersona(page, '事業部門');
    const [k] = await topKeys(page);
    const c = component(page, k);
    const before = await box(c);
    await handle(c).dblclick();
    await expect(c).toHaveAttribute('data-expanded', 'true');
    expect(await c.getAttribute('data-maximized'), 'ダブルクリックで最大化になっている').not.toBe('true');
    const ws = await box(workspace(page));
    const exp = await box(c);
    const horizontal = Math.abs(exp.width - ws.width) <= ws.width * 0.03; // 上・下: 全幅、左・右: 全高
    const ratio = horizontal ? exp.height / ws.height : exp.width / ws.width;
    expect(Math.abs(ratio - RATIO), `拡大の割合 ${ratio}`).toBeLessThanOrEqual(0.03);
    await handle(c).dblclick();
    await expect(c).not.toHaveAttribute('data-expanded', 'true');
    const back = await box(c);
    for (const p of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(back[p] - before[p]), `復帰後の ${p}`).toBeLessThanOrEqual(2);
  });

  // FR-183 AC-389（異常系: 本体のダブルクリックでは拡大しない）
  test('FR-183 AC-389 異常系: ハンドル以外（本体）のダブルクリックでは拡大表示にならない', async ({ page, start }) => {
    await start();
    await selectPersona(page, '事業部門');
    const [k] = await topKeys(page);
    const c = component(page, k);
    const b = await box(c);
    const hb = await box(handle(c));
    await page.mouse.dblclick(b.x + b.width / 2, Math.max(hb.y + hb.height + 24, b.y + b.height / 2));
    await expect(c).not.toHaveAttribute('data-expanded', 'true');
  });
});

test.describe('FR-184 移動中の他のコンポーネントの自動の押し出し・再配置（重ならない配置に限る）', () => {
  // FR-296 AC-800/801: 既定の構成の下限（360x240）と作業領域のゾーンにより、1600x900 では 2 行目が画面外になるため、画面の高さを広げて前提を揃える（検証内容は変えない）。
  test.use({ viewport: { width: 1600, height: 1400 } });
  /** ハンドルを掴んで端へ運び、候補（label）の上で離す（FR-152。候補は重ならない配置）。 */
  async function snapTo(page: Page, c: Locator, edge: 'left' | 'right', label: string): Promise<void> {
    const ws = await box(workspace(page));
    const h = await box(handle(c));
    const x = h.x + h.width / 2;
    const y = h.y + h.height / 2;
    const tx = edge === 'left' ? ws.x + 8 : ws.x + ws.width - 8;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move((x + tx) / 2, (y + ws.y + ws.height / 2) / 2, { steps: 6 });
    await page.mouse.move(tx, ws.y + ws.height / 2, { steps: 6 });
    const cand = page.getByTestId('snap-candidates');
    await expect(cand).toBeVisible();
    await cand.getByRole('button', { name: label }).hover();
    await page.mouse.up();
  }
  async function expectNoOverlap(page: Page): Promise<void> {
    const boxes: Record<string, Box> = {};
    for (const k of await topKeys(page)) boxes[k] = await box(component(page, k));
    const names = Object.keys(boxes);
    for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
      expect(overlap(boxes[names[i]], boxes[names[j]]), `${names[i]} と ${names[j]} が重なる`).toBeLessThanOrEqual(4);
    }
  }

  // FR-184 AC-390（Q-066 B 2026-10-27: スナップ・分割のときだけ押し出す）
  test('FR-184 AC-390 A を左半分へスナップすると、そこにあった B が重ならない位置へ移り、すべてのコンポーネントが重ならない', async ({ page, start }) => {
    await start();
    await selectPersona(page, '事業部門');
    const ks = await topKeys(page);
    expect(ks.length, 'コンポーネントが 2 つ以上必要').toBeGreaterThanOrEqual(2);
    const [a, b] = ks;
    await snapTo(page, component(page, a), 'left', '左半分');
    await expect.poll(async () => overlap(await box(component(page, a)), await box(component(page, b))), { timeout: 5_000, message: 'B が押し出されない' }).toBeLessThanOrEqual(4);
    await expectNoOverlap(page);
  });

  // FR-184 AC-390（異常系: 続けてスナップしても重なりが残らない）
  test('FR-184 AC-390 異常系: 続けて左半分・右半分へスナップしても、重なって表示されるものが 0 件', async ({ page, start }) => {
    await start();
    await selectPersona(page, '事業部門');
    const ks = await topKeys(page);
    expect(ks.length).toBeGreaterThanOrEqual(3);
    await snapTo(page, component(page, ks[0]), 'left', '左半分');
    await page.waitForTimeout(600);
    await snapTo(page, component(page, ks[1]), 'right', '右半分');
    await page.waitForTimeout(600);
    await expectNoOverlap(page);
  });

  // FR-184 AC-390（異常系: 自由な移動では押し出さず、掴んだものが手前。AC-348）
  test('FR-184 AC-390 異常系: 自由な移動（スナップ候補なし）で B の上へ置いても B は押し出されず、A が手前に表示される', async ({ page, start }) => {
    await start();
    await selectPersona(page, '事業部門');
    const [a, b] = await topKeys(page);
    const bBefore = await box(component(page, b));
    await dragHandle(page, component(page, a), bBefore.x + bBefore.width / 2, bBefore.y + bBefore.height / 2);
    await page.waitForTimeout(700);
    const bAfter = await box(component(page, b));
    expect(Math.abs(bAfter.x - bBefore.x) + Math.abs(bAfter.y - bBefore.y), '自由な移動で B が押し出された').toBeLessThanOrEqual(4);
    const aBox = await box(component(page, a));
    expect(overlap(aBox, bAfter), '重なりが許されていない').toBeGreaterThan(100);
    const cx = (Math.max(aBox.x, bAfter.x) + Math.min(aBox.x + aBox.width, bAfter.x + bAfter.width)) / 2;
    const cy = (Math.max(aBox.y, bAfter.y) + Math.min(aBox.y + aBox.height, bAfter.y + bAfter.height)) / 2;
    const frontKey = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('[data-testid^="component-"]:not([data-testid="component-menu"]):not([data-testid="component-actions"]):not([data-testid="component-data"])')?.getAttribute('data-testid') ?? null, [cx, cy]);
    expect(frontKey, 'A が手前に出ていない').toBe(`component-${a}`);
  });
});

/** ドラッグ中に、rAF ごとの位置を記録し、位置が変わったフレーム数から fps を求める。 */
async function sampleDrag(page: Page, c: Locator, act: () => Promise<void>): Promise<{ fps: number; maxJump: number; frames: number }> {
  await c.evaluate((el) => {
    const w = window as any;
    w.__stPos = [];
    w.__stRun = true;
    const tick = (t: number) => {
      const r = el.getBoundingClientRect();
      w.__stPos.push([t, r.x, r.y, r.width, r.height]);
      if (w.__stRun) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await act();
  const rows = await page.evaluate(() => { const w = window as any; w.__stRun = false; return w.__stPos as number[][]; });
  let changed = 0;
  let maxJump = 0;
  for (let i = 1; i < rows.length; i++) {
    const d = Math.abs(rows[i][1] - rows[i - 1][1]) + Math.abs(rows[i][2] - rows[i - 1][2]) + Math.abs(rows[i][3] - rows[i - 1][3]) + Math.abs(rows[i][4] - rows[i - 1][4]);
    if (d > 0.5) changed++;
    maxJump = Math.max(maxJump, d);
  }
  const seconds = (rows[rows.length - 1][0] - rows[0][0]) / 1000;
  return { fps: seconds > 0 ? changed / seconds : 0, maxJump, frames: rows.length };
}

test.describe('FR-185 移動中・リサイズ中の滑らかなアニメーション', () => {
  // FR-185 AC-392
  test('FR-185 AC-392 ハンドルのドラッグ中、ポインターに追従して連続して動き、操作中のフレームレートが 30fps 以上で、ドロップの瞬間に位置が飛ばない', async ({ page, start }) => {
    await start();
    await selectPersona(page, '事業部門');
    const [k] = await topKeys(page);
    const c = component(page, k);
    const ws = await box(workspace(page));
    const h = await box(handle(c));
    const x0 = h.x + h.width / 2;
    const y0 = h.y + h.height / 2;
    const tx = Math.min(x0 + 200, ws.x + ws.width - 10);
    const ty = Math.min(y0 + 140, ws.y + ws.height - 10);
    let beforeUp: Box | null = null;
    const r = await sampleDrag(page, c, async () => {
      await page.mouse.move(x0, y0);
      await page.mouse.down();
      for (let i = 1; i <= 40; i++) {
        await page.mouse.move(x0 + ((tx - x0) * i) / 40, y0 + ((ty - y0) * i) / 40);
        await page.waitForTimeout(25);
      }
      beforeUp = await box(c);
      await page.mouse.up();
      await page.waitForTimeout(100);
    });
    expect(r.fps, `ドラッグ中のフレームレート ${r.fps.toFixed(1)}fps`).toBeGreaterThanOrEqual(MIN_FPS);
    const after = await box(c);
    expect(Math.abs(after.x - beforeUp!.x) + Math.abs(after.y - beforeUp!.y), 'ドロップの瞬間に位置が飛んだ').toBeLessThanOrEqual(24);
  });

  // FR-185 AC-392（異常系: ポインターを止めた間は動き続けず、離しても位置が飛ばない）
  test('FR-185 AC-392 異常系: ポインターが止まっている間（動かさずに保持）は位置が動かず、離すとその位置に置かれる', async ({ page, start }) => {
    await start();
    await selectPersona(page, '事業部門');
    const [k] = await topKeys(page);
    const c = component(page, k);
    const h = await box(handle(c));
    const x0 = h.x + h.width / 2;
    const y0 = h.y + h.height / 2;
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    await page.mouse.move(x0 + 60, y0 + 40, { steps: 6 });
    await page.waitForTimeout(300);
    const held = await box(c);
    await page.waitForTimeout(300);
    const held2 = await box(c);
    expect(Math.abs(held2.x - held.x) + Math.abs(held2.y - held.y), '保持中に位置が動き続けている').toBeLessThanOrEqual(2);
    await page.mouse.up();
    const placed = await box(c);
    expect(Math.abs(placed.x - held2.x) + Math.abs(placed.y - held2.y), '離したときに位置が飛んだ').toBeLessThanOrEqual(24);
  });

  // FR-185 AC-393
  test('FR-185 AC-393 境界のドラッグで大きさが連続して変わり、フレームレートが 30fps 以上', async ({ page, start }) => {
    await start();
    await selectPersona(page, '事業部門');
    const [k] = await topKeys(page);
    const c = component(page, k);
    const b = await box(c);
    const grip = page.getByRole('separator').first();
    const gb = await box(grip);
    const x0 = gb.x + gb.width / 2;
    const y0 = gb.y + gb.height / 2;
    const r = await sampleDrag(page, c, async () => {
      await page.mouse.move(x0, y0);
      await page.mouse.down();
      for (let i = 1; i <= 40; i++) {
        await page.mouse.move(x0 + 3 * i, y0 + 2 * i);
        await page.waitForTimeout(25);
      }
      await page.mouse.up();
    });
    expect(r.fps, `リサイズ中のフレームレート ${r.fps.toFixed(1)}fps`).toBeGreaterThanOrEqual(MIN_FPS);
    const a = await box(c);
    expect(Math.abs(a.width - b.width) + Math.abs(a.height - b.height), '大きさが変わっていない').toBeGreaterThan(2);
  });

  // FR-185 AC-393（異常系: 最小の幅を下回って縮めても連続して動き、最小で止まる）
  test('FR-185 AC-393 異常系: 境界を大きく動かしても、コンポーネントがキャンバスの外へ出たり瞬間的に切り替わったりしない', async ({ page, start }) => {
    await start();
    await selectPersona(page, '事業部門');
    const [k] = await topKeys(page);
    const c = component(page, k);
    const grip = page.getByRole('separator').first();
    const gb = await box(grip);
    const ws = await box(workspace(page));
    const x0 = gb.x + gb.width / 2;
    const y0 = gb.y + gb.height / 2;
    const r = await sampleDrag(page, c, async () => {
      await page.mouse.move(x0, y0);
      await page.mouse.down();
      for (let i = 1; i <= 40; i++) {
        await page.mouse.move(x0 - 12 * i, y0 - 8 * i);
        await page.waitForTimeout(25);
      }
      await page.mouse.up();
    });
    const a = await box(c);
    expect(a.x + a.width, '右端がキャンバスの外').toBeLessThanOrEqual(ws.x + ws.width + 2);
    expect(r.frames, 'フレームが記録されていない').toBeGreaterThan(5);
  });
});
