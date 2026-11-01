// System Test: コンポーネントのドラッグ移動・自動サイズ調整・作業先（デモ／実 Project）の選択・Fluent 2 の適用
// 期待値は要求定義書の受入基準（docs/requirements/app-experience.md の FR-142〜144・NFR-UX-007）だけから決める。
// 画面の探し方は tests/system/CONTRACT.md §9。PARAM-033=1.5 倍、PARAM-034=240 CSS px、PARAM-035=12 CSS px。
import type { Page, Locator } from '@playwright/test';
import { test, expect, openScreen, component, selectPersona, pressOpeningEscape, closeSettings } from '../support/fixtures';
import { examplePack } from '../support/packs';

const mono = examplePack('mono');

const SCALE = 1.5; // PARAM-033
const MIN_WIDTH = 240; // PARAM-034
const MIN_FONT = 12; // PARAM-035

async function box(loc: Locator) {
  const b = await loc.boundingBox();
  expect(b, '要素が表示されていない').not.toBeNull();
  return b!;
}
const area = (b: { width: number; height: number }) => b.width * b.height;

function visibleComponents(page: Page): Locator {
  return page.getByTestId('workspace').locator('[data-testid^="component-"]:not([data-testid="component-menu"]):not([data-testid="component-actions"]):not([data-testid="component-data"])');
}
async function keys(page: Page): Promise<string[]> {
  const all = visibleComponents(page);
  const out: string[] = [];
  for (let i = 0; i < (await all.count()); i++) {
    if (await all.nth(i).isVisible()) out.push(((await all.nth(i).getAttribute('data-testid')) ?? '').replace('component-', ''));
  }
  return out;
}

/** 祖先に component-*（component-menu を除く）がある要素を除いた、直下のコンポーネントだけ。 */
async function topKeys(page: Page): Promise<string[]> {
  return page.getByTestId('workspace').evaluate((ws) => {
    const sel = '[data-testid^="component-"]:not([data-testid="component-menu"]):not([data-testid="component-actions"]):not([data-testid="component-data"])';
    const out: string[] = [];
    ws.querySelectorAll(sel).forEach((el) => {
      const parent = el.parentElement?.closest(sel);
      const r = (el as HTMLElement).getBoundingClientRect();
      if (!parent && r.width > 0 && r.height > 0) out.push((el.getAttribute('data-testid') ?? '').replace('component-', ''));
    });
    return out;
  });
}

/** 見出しをつかんで (dx, dy) だけ動かす。途中で drop-indicator が見えることを返す。 */
async function dragByHeading(page: Page, c: Locator, dx: number, dy: number): Promise<boolean> {
  const h = await box(c.getByRole('heading').first());
  const x = h.x + h.width / 2;
  const y = h.y + h.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 6 });
  await page.mouse.move(x + dx, y + dy, { steps: 6 });
  const shown = await page.getByTestId('drop-indicator').first().isVisible();
  await page.mouse.up();
  return shown;
}

test.describe('FR-142 すべてのコンポーネントのドラッグでの移動', () => {
  // FR-142 AC-224
  test('FR-142 AC-224 表示中のすべてのコンポーネントをドラッグで動かせ、ドロップ前に置き場所が示され、再読込後も同じ配置', async ({ page, start }) => {
    const app = await start();
    await selectPersona(page, '事業部門');
    const ks = await topKeys(page);
    expect(ks.length, 'コンポーネントが 2 つ以上必要').toBeGreaterThanOrEqual(2);
    for (const k of ks) {
      const c = component(page, k);
      const before = await box(c);
      const others = ks.filter((o) => o !== k);
      const target = await box(component(page, others[0]));
      // 移動先は、タブ化されない余白側（移動先の下端の余白）にする
      // dx/dy は、掴む見出しの中心を基準にする（コンポーネント中心ではない）
      const grab = await box(c.getByRole('heading').first());
      const dx = target.x + target.width / 2 - (grab.x + grab.width / 2);
      const dy = target.y + target.height + 6 - (grab.y + grab.height / 2);
      const shown = await dragByHeading(page, c, dx, dy);
      expect(shown, `${k}: ドロップ前に置ける場所が示されない`).toBe(true);
      const after = await box(component(page, k));
      expect(Math.abs(after.x - before.x) + Math.abs(after.y - before.y), `${k}: 位置が変わらない`).toBeGreaterThan(2);
    }
    const moved: Record<string, { x: number; y: number }> = {};
    for (const k of ks) { const b = await box(component(page, k)); moved[k] = { x: Math.round(b.x), y: Math.round(b.y) }; }
    await app.reload();
    for (const k of ks) {
      const b = await box(component(page, k));
      expect(Math.abs(b.x - moved[k].x), `${k}.x 再読込後`).toBeLessThanOrEqual(2);
      expect(Math.abs(b.y - moved[k].y), `${k}.y 再読込後`).toBeLessThanOrEqual(2);
    }
  });

  // FR-142 AC-224 / FR-216 AC-496（異常系: 置き先にならない場所では drop-indicator を出さない。ピン止めした辺の上）
  // AC-224: drop-indicator は置き先になれる場所の上にいるときだけ出る（どこでも常に出るわけではない）。
  // AC-496: ピン止めしたコンポーネントの辺の上は置き先にならず、drop-indicator は出ない（AC-224 より優先）。位置と大きさは変わらない。
  test('FR-142 AC-224 異常系: ピン止めしたコンポーネントの辺の上へドラッグしている間は drop-indicator が出ず、置き先になれる場所では出る', async ({ page, start }) => {
    await start();
    await selectPersona(page, '事業部門');
    const ks = await topKeys(page);
    expect(ks.length, 'コンポーネントが 2 つ以上必要').toBeGreaterThanOrEqual(2);
    const [mover, pinned] = ks;
    // pinned をピン止めする（フォーカス → component-actions の「ピン止めする」）
    await component(page, pinned).focus();
    await page.getByTestId('component-actions').getByRole('button', { name: 'ピン止めする' }).click();
    await expect(page.getByTestId('component-actions').getByRole('button', { name: 'ピン止めを外す' })).toHaveAttribute('aria-pressed', 'true');
    const pinBefore = await box(component(page, pinned));
    const c = component(page, mover);
    const grab = await box(c.getByRole('heading').first());
    const gx = grab.x + grab.width / 2;
    const gy = grab.y + grab.height / 2;
    // 1) ピン止めした辺の上（上辺の中央）へ動かす → drop-indicator は出ない
    await page.mouse.move(gx, gy);
    await page.mouse.down();
    await page.mouse.move((gx + pinBefore.x + pinBefore.width / 2) / 2, (gy + pinBefore.y + 2) / 2, { steps: 6 });
    await page.mouse.move(pinBefore.x + pinBefore.width / 2, pinBefore.y + 2, { steps: 6 });
    await expect(page.getByTestId('drop-indicator').first(), 'ピン止めした辺の上では drop-indicator を出さない').toBeHidden();
    await page.mouse.up();
    // ピン止めしたコンポーネントの位置と大きさは変わらず、置いたものはそれと重ならない
    const pinAfter = await box(component(page, pinned));
    expect(Math.abs(pinAfter.x - pinBefore.x) + Math.abs(pinAfter.y - pinBefore.y), 'ピン止めの位置').toBeLessThanOrEqual(2);
    expect(Math.abs(pinAfter.width - pinBefore.width) + Math.abs(pinAfter.height - pinBefore.height), 'ピン止めの大きさ').toBeLessThanOrEqual(2);
    const m = await box(component(page, mover));
    const overlapW = Math.min(m.x + m.width, pinAfter.x + pinAfter.width) - Math.max(m.x, pinAfter.x);
    const overlapH = Math.min(m.y + m.height, pinAfter.y + pinAfter.height) - Math.max(m.y, pinAfter.y);
    expect(overlapW > 1 && overlapH > 1, '置いたコンポーネントがピン止めした領域と重ならない').toBe(false);
    // 2) 置き先になれる場所（ピン止めしていないコンポーネントの下端の余白の側）では drop-indicator が出る
    const others = ks.filter((k) => k !== mover && k !== pinned);
    if (others.length > 0) {
      const t = await box(component(page, others[0]));
      const g2 = await box(component(page, mover).getByRole('heading').first());
      const shown = await dragByHeading(page, component(page, mover), t.x + t.width / 2 - (g2.x + g2.width / 2), t.y + t.height + 6 - (g2.y + g2.height / 2));
      expect(shown, '置き先になれる場所では drop-indicator が出る').toBe(true);
    }
  });

  // FR-142 AC-224（異常系: 置けない場所へ放す／Esc で中止）
  test('FR-142 AC-224 異常系: ドラッグ中に Esc を押すと元の位置に戻り、保存されたレイアウトも変わらない', async ({ page, start }) => {
    const app = await start();
    await selectPersona(page, '事業部門');
    const [k] = await keys(page);
    const c = component(page, k);
    const before = await box(c);
    const h = await box(c.getByRole('heading').first());
    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
    await page.mouse.down();
    await page.mouse.move(h.x + 200, h.y + 160, { steps: 8 });
    await page.keyboard.press('Escape');
    await page.mouse.up();
    const after = await box(c);
    expect(Math.abs(after.x - before.x) + Math.abs(after.y - before.y)).toBeLessThanOrEqual(2);
    await app.reload();
    const again = await box(component(page, k));
    expect(Math.abs(again.x - before.x) + Math.abs(again.y - before.y)).toBeLessThanOrEqual(2);
  });
});

test.describe('FR-143 操作中のコンポーネントを大きくする自動のサイズ調整', () => {
  // FR-296 AC-800/801: 既定の構成の各コンポーネントは 360x240 以上で、2 行目が 1600x900 の画面外になるため、画面の高さを広げて前提を揃える（検証内容は変えない）。
  test.use({ viewport: { width: 1600, height: 1400 } });
  // FR-143 AC-226
  test('FR-143 AC-226 操作したコンポーネントの面積が基準の 1.5 倍になり、別のコンポーネントを操作すると大きいものが移る', async ({ page, start }) => {
    await start();
    await selectPersona(page, '事業部門');
    const ks = await topKeys(page);
    expect(ks.length, '4 つ以上のコンポーネントが必要').toBeGreaterThanOrEqual(4);
    const base: Record<string, number> = {};
    for (const k of ks) base[k] = area(await box(component(page, k)));
    // FR-296: 既定の構成では、作業領域の幅の半分を超える左の列のコンポーネントは、列の幅の上限（PARAM-134 を割らない範囲）で
    // 面積を 1.5 倍にする余地が小さい。余地のある（幅が半分以下の）右の列の 2 つで、1.5 倍と「大きいものが移る」を検証する。
    const ws = await box(page.getByTestId('workspace'));
    const narrow: string[] = [];
    for (const k of ks) if ((await box(component(page, k))).width <= ws.width / 2 + 1) narrow.push(k);
    expect(narrow.length, '幅が半分以下のコンポーネントが 2 つ以上必要').toBeGreaterThanOrEqual(2);
    const [a, b] = narrow;
    await component(page, a).focus();
    await expect.poll(async () => area(await box(component(page, a))) / base[a], { timeout: 5_000 }).toBeCloseTo(SCALE, 1);
    await component(page, b).focus();
    await expect.poll(async () => area(await box(component(page, b))) / base[b], { timeout: 5_000 }).toBeCloseTo(SCALE, 1);
    await expect.poll(async () => area(await box(component(page, a))) / base[a]).toBeLessThan(SCALE - 0.2);
  });

  // FR-143 AC-226（ペルソナの既定の情報表現は標準より小さくならない）
  test('FR-143 AC-226 ペルソナの既定の情報表現のコンポーネントは、標準のコンポーネントより小さくならない', async ({ page, start }) => {
    await start();
    await selectPersona(page, '経営層');
    await expect(component(page, 'matrix')).toBeVisible();
    const ks = (await topKeys(page)).filter((k) => k !== 'matrix');
    expect(ks.length).toBeGreaterThanOrEqual(3);
    await component(page, ks[0]).focus();
    const primary = area(await box(component(page, 'matrix')));
    for (const k of ks.slice(1)) {
      expect(primary, `matrix が ${k} より小さい`).toBeGreaterThanOrEqual(area(await box(component(page, k))) - 1);
    }
  });

  // FR-143 AC-226（異常系: 自動調整を切ると変わらない。AC-228 の一部を system で確認）
  test('FR-143 AC-226 異常系: 自動の調整を切ると、操作しても大きさが変わらない', async ({ page, start }) => {
    await start();
    await selectPersona(page, '事業部門');
    const ks = await keys(page);
    await page.getByRole('switch', { name: 'サイズの自動調整' }).uncheck();
    const before = area(await box(component(page, ks[0])));
    await component(page, ks[0]).focus();
    await page.waitForTimeout(500);
    expect(Math.abs(area(await box(component(page, ks[0]))) - before)).toBeLessThanOrEqual(2);
  });
});

/** 実 Project を n 件登録する（企業 1 社に Project を n 件）。 */
async function seedProjects(page: Page, company: string, names: string[]): Promise<void> {
  await page.getByRole('button', { name: '企業を登録' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByRole('textbox', { name: '企業名' }).fill(company);
  await dlg.getByRole('button', { name: '登録' }).click();
  await expect(dlg).toBeHidden();
  for (const n of names) {
    await page.getByRole('region', { name: `企業 ${company}` }).getByRole('button', { name: 'Project を作成' }).click();
    await dlg.getByRole('textbox', { name: 'Project 名' }).fill(n);
    await dlg.getByRole('button', { name: '作成' }).click();
    await expect(dlg).toBeHidden();
  }
}

/**
 * 再起動（再読込）して起動直後のメイン画面（FR-186・AC-398）を出し、「Project を開く」で作業先の選択画面を開く。
 * 起動直後には選択画面が出ていないこと（AC-398）も確かめる。
 */
async function restartAndOpenPicker(page: Page, app: { reload(o?: { skipOpening?: boolean }): Promise<void> }): Promise<Locator> {
  await app.reload({ skipOpening: false });
  await pressOpeningEscape(page);
  const main = page.getByTestId('main-screen');
  await expect(main, '起動直後にメイン画面が出ない').toBeVisible();
  await expect(page.getByRole('dialog', { name: '作業先の選択' }), '起動直後に選択画面が出ている').toHaveCount(0);
  await main.getByRole('button', { name: 'Project を開く' }).click();
  const picker = page.getByRole('dialog', { name: '作業先の選択' });
  await expect(picker).toBeVisible();
  return picker;
}

test.describe('FR-144 起動後のデモ／実プロジェクトの選択', () => {
  // FR-144 AC-229（Q-026 で改訂: 起動直後はメイン画面。選択画面は「Project を開く」で出る）
  test('FR-144 AC-229 実 Project が 2 件以上ある端末で、メイン画面から Project を開くと選択画面が出て、デモと各 Project を選べ、作業先が常に示される', async ({ page, start }) => {
    const app = await start();
    await seedProjects(page, '合成株式会社A', ['業務改善 2026', '在庫最適化']);
    const picker = await restartAndOpenPicker(page, app);
    await expect(picker.getByRole('option', { name: /デモ/ })).toBeVisible();
    await expect(picker.getByRole('option', { name: /合成株式会社A.*業務改善 2026/ })).toBeVisible();
    await expect(picker.getByRole('option', { name: /合成株式会社A.*在庫最適化/ })).toBeVisible();
    // Project を選ぶと、その Project のステッパーで開く
    await picker.getByRole('option', { name: /合成株式会社A.*在庫最適化/ }).click();
    await expect(page.getByTestId('stepper')).toBeVisible();
    await expect(page.getByTestId('work-target')).toContainText('合成株式会社A');
    await expect(page.getByTestId('work-target')).toContainText('在庫最適化');
    // 開き直してデモを選ぶと、架空企業のお手本パックで開く
    const picker2 = await restartAndOpenPicker(page, app);
    await picker2.getByRole('option', { name: /デモ/ }).click();
    await expect(page.getByTestId('workspace')).toBeVisible();
    await expect(page.getByTestId('work-target')).toContainText('デモ');
    await expect(page.getByText('合成株式会社A')).toHaveCount(0);
  });

  // FR-144 AC-229（異常系: 作業先を選ばないまま選択画面を閉じても、作業先が未定のまま本編に入らない。AC-398: 閉じるとメイン画面に戻る）
  test('FR-144 AC-229 異常系: 作業先を選ばないまま選択画面を閉じると、メイン画面に戻り、作業先が未定のまま本編（分析画面）に入らない', async ({ page, start }) => {
    const app = await start();
    await seedProjects(page, '合成株式会社A', ['業務改善 2026', '在庫最適化']);
    const picker = await restartAndOpenPicker(page, app);
    await page.keyboard.press('Escape');
    await expect(picker).toBeHidden();
    await expect(page.getByTestId('main-screen')).toBeVisible();
    await expect(page.getByTestId('workspace')).toHaveCount(0);
  });

  // FR-144 AC-237（AC-230 を置き換える。Q-026 で改訂: 起動直後はメイン画面。選択画面はメイン画面から開く）
  test('FR-144 AC-237 実 Project が 0 件でも、メイン画面から Project を開くと選択画面が出て、デモと「実際の Project を登録」が選べ、デモを選ぶとお手本パックで起動したことが示される', async ({ page, start }) => {
    await start({ skipOpening: false });
    await pressOpeningEscape(page);
    await expect(page.getByTestId('main-screen')).toBeVisible();
    await page.getByTestId('main-screen').getByRole('button', { name: 'Project を開く' }).click();
    const picker = page.getByRole('dialog', { name: '作業先の選択' });
    await expect(picker).toBeVisible();
    await expect(picker.getByRole('option', { name: /デモ/ })).toBeVisible();
    await expect(picker.getByRole('option', { name: '実際の Project を登録' })).toBeVisible();
    await picker.getByRole('option', { name: /デモ/ }).click();
    await expect(picker).toBeHidden();
    await expect(page).toHaveTitle(new RegExp(mono.customerName));
    await expect(page.getByText('お手本パック').first()).toBeVisible();
    await expect(page.getByTestId('work-target')).toContainText('デモ');
  });

  // FR-144 AC-237（異常系: 0 件のとき、選択肢はデモと登録の 2 つだけで、企業名・Project 名の候補は出ない）
  // 注: AC-237 の「何も選ばずに閉じることはできない」は AC-398「選択画面を閉じるとメイン画面に戻れる」と競合する（CONFLICT。ケースの Esc の確認は AC-398 側に従い、メイン画面へ戻ることを確かめる）
  test('FR-144 AC-237 異常系: 0 件の選択画面には実 Project の候補が出ず（デモと登録の 2 つだけ）、閉じても作業先が未定のまま本編に入らない', async ({ page, start }) => {
    await start({ skipOpening: false });
    await pressOpeningEscape(page);
    await page.getByTestId('main-screen').getByRole('button', { name: 'Project を開く' }).click();
    const picker = page.getByRole('dialog', { name: '作業先の選択' });
    await expect(picker).toBeVisible();
    await expect(picker.getByRole('option')).toHaveCount(2);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('main-screen')).toBeVisible();
    await expect(page.getByTestId('workspace')).toHaveCount(0);
  });

  // FR-144 AC-239（Q-026 で改訂: メイン画面から Project を開くたびに選択画面が出る）
  test('FR-144 AC-239 実 Project が 2 件以上でも、再起動してメイン画面から Project を開くたびに選択画面が出る（前回の選択で省略されない）', async ({ page, start }) => {
    const app = await start();
    await seedProjects(page, '合成株式会社A', ['業務改善 2026', '在庫最適化']);
    for (const target of [/合成株式会社A.*在庫最適化/, /デモ/, /合成株式会社A.*業務改善 2026/]) {
      const picker = await restartAndOpenPicker(page, app);
      await picker.getByRole('option', { name: target }).click();
      await expect(picker).toBeHidden();
    }
    // 開いたまま、メイン画面へ戻って開き直しても、必ず選択画面が出る（分析画面の「メイン画面へ戻る」: FR-187）
    await page.getByRole('button', { name: 'メイン画面へ戻る' }).click();
    await page.getByTestId('main-screen').getByRole('button', { name: 'Project を開く' }).click();
    await expect(page.getByRole('dialog', { name: '作業先の選択' }), '戻って開き直しても選択画面が出ない').toBeVisible();
  });

  // FR-144 AC-239（例外 2026-10-31: タスクワークスペース操作後・URL の workspace= の再読込は分析画面に留まり、メイン画面へ戻ると解除）
  test('FR-144 AC-239 例外: タスクワークスペースを操作したタブの再読込と workspace= 付き URL は分析画面に留まり、メイン画面へ戻ると再読込はメイン画面になる', async ({ page, start }) => {
    const app = await start();
    // 通常: 新しいタブ・起動直後はメイン画面（例外の対象ではない）
    await restartAndOpenPicker(page, app);
    await page.keyboard.press('Escape');
    await page.getByTestId('main-screen').getByRole('button', { name: 'Project を開く' }).click();
    await page.getByRole('dialog', { name: '作業先の選択' }).getByRole('option', { name: /デモ/ }).click();
    // 例外 1: このタブでタスクワークスペースを操作したあとの再読込は分析画面に留まる
    await page.getByRole('button', { name: 'タスクワークスペースを追加' }).click();
    const id = await page.getByTestId('workspace').getAttribute('data-workspace-id');
    await app.reload({ skipOpening: false });
    await pressOpeningEscape(page);
    await expect(page.getByTestId('workspace'), '操作後の再読込で分析画面に留まらない').toBeVisible();
    await expect(page.getByTestId('main-screen')).toHaveCount(0);
    // 例外 2: 新しいタブでも URL に workspace= があれば分析画面に留まる（操作していないタブ）
    const tab = await page.context().newPage();
    const u = new URL(app.url);
    u.searchParams.set('workspace', id ?? '');
    await tab.goto(u.toString());
    await pressOpeningEscape(tab);
    await expect(tab.getByTestId('workspace'), 'workspace= 付き URL の再読込で分析画面に留まらない').toBeVisible();
    await tab.reload();
    await pressOpeningEscape(tab);
    await expect(tab.getByTestId('workspace')).toBeVisible();
    await tab.close();
    // メイン画面へ戻ると例外は解除され、以後の再読込はメイン画面
    await page.getByRole('button', { name: 'メイン画面へ戻る' }).click();
    await expect(page.getByTestId('main-screen')).toBeVisible();
    await app.reload({ skipOpening: false });
    await pressOpeningEscape(page);
    await expect(page.getByTestId('main-screen'), '戻った後の再読込でメイン画面にならない').toBeVisible();
    await expect(page.getByTestId('workspace')).toHaveCount(0);
  });

  // FR-144 AC-239（異常系: 0 件の端末でも毎回出る。選択を覚えて省略しない）
  test('FR-144 AC-239 異常系: 実 Project が 0 件の端末でも、デモを選んだ後に再起動して Project を開くと選択画面が省略されない', async ({ page, start }) => {
    const app = await start();
    await restartAndOpenPicker(page, app);
  });

  // FR-144 AC-240
  test('FR-144 AC-240 設定でデモを「表示しない」にすると選択画面にデモが出ず、再読込（再起動）後も維持される', async ({ page, start }) => {
    const app = await start();
    await seedProjects(page, '合成株式会社A', ['業務改善 2026']);
    const settings = await openScreen(page, 'settings');
    await settings.getByRole('switch', { name: '選択画面にデモを表示' }).uncheck();
        await closeSettings(page); // 設定はモーダル（FR-223）
        await page.getByRole('button', { name: '作業先' }).click();
    let picker = page.getByRole('dialog', { name: '作業先の選択' });
    await expect(picker.getByRole('option', { name: /合成株式会社A.*業務改善 2026/ })).toBeVisible();
    await expect(picker.getByRole('option', { name: /デモ/ })).toHaveCount(0);
    await page.keyboard.press('Escape');
    picker = await restartAndOpenPicker(page, app);
    await expect(picker.getByRole('option', { name: /デモ/ })).toHaveCount(0);
    await picker.getByRole('option', { name: /業務改善 2026/ }).click();
    const s2 = await openScreen(page, 'settings');
    await expect(s2.getByRole('switch', { name: '選択画面にデモを表示' })).not.toBeChecked();
  });

  // FR-144 AC-240（異常系: 設定は端末内。別の端末＝別の browser context には引き継がれない）
  test('FR-144 AC-240 異常系: デモを非表示にした設定は別の端末（別の文脈）には引き継がれず、そこでは既定どおりデモが出る', async ({ page, start, browser }) => {
    const app = await start();
    const settings = await openScreen(page, 'settings');
    await settings.getByRole('switch', { name: '選択画面にデモを表示' }).uncheck();
    const ctx2 = await browser.newContext();
    try {
      const p2 = await ctx2.newPage();
      await p2.goto(app.url);
      await pressOpeningEscape(p2);
      await p2.getByTestId('main-screen').getByRole('button', { name: 'Project を開く' }).click();
      const picker = p2.getByRole('dialog', { name: '作業先の選択' });
      await expect(picker).toBeVisible();
      await expect(picker.getByRole('option', { name: /デモ/ })).toBeVisible();
    } finally {
      await ctx2.close();
    }
  });
});

/** 検証対象の見出し・タブ・作業先の選択画面の要素 */
async function contrastFailures(page: Page, root: Locator): Promise<string[]> {
  return await root.evaluate((el: Element) => {
    const parse = (s: string) => (s.match(/[\d.]+/g) ?? []).map(Number);
    const lum = ([r, g, b]: number[]) => {
      const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const bgOf = (e: Element | null): number[] => {
      while (e) {
        const c = parse(getComputedStyle(e).backgroundColor);
        if (c.length >= 3 && (c.length === 3 || c[3] > 0.99)) return c;
        e = e.parentElement;
      }
      return [255, 255, 255];
    };
    const bad: string[] = [];
    for (const t of Array.from(el.querySelectorAll('h1,h2,h3,[role=tab],[role=option],button'))) {
      if (!(t as HTMLElement).offsetParent || !(t.textContent ?? '').trim()) continue;
      const fg = parse(getComputedStyle(t).color);
      const l1 = lum(fg), l2 = lum(bgOf(t));
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      if (ratio < 4.5) bad.push(`${(t.textContent ?? '').trim().slice(0, 20)}: ${ratio.toFixed(2)}`);
    }
    return bad;
  });
}

test.describe('NFR-UX-007 画面とレイアウト操作への Fluent 2 の適用と最小の読みやすさ', () => {
  // NFR-UX-007 AC-234
  for (const mode of ['light', 'dark', 'hc'] as const) {
    test(`NFR-UX-007 AC-234 ${mode}: 見出し・タブ・作業先の選択画面の文字が AA のコントラストで、キーボードフォーカスが見える`, async ({ page, start }) => {
      if (mode === 'hc') await page.emulateMedia({ forcedColors: 'active' });
      else await page.emulateMedia({ colorScheme: mode });
      await start();
      await selectPersona(page, '事業部門');
      const ws = page.getByTestId('workspace');
      expect(await contrastFailures(page, ws), '本編のコントラスト不足').toEqual([]);
      await page.getByRole('button', { name: '作業先' }).click();
      const picker = page.getByRole('dialog', { name: '作業先の選択' });
      expect(await contrastFailures(page, picker), '作業先の選択画面のコントラスト不足').toEqual([]);
      await page.keyboard.press('Tab');
      const outline = await page.evaluate(() => {
        const s = getComputedStyle(document.activeElement as Element);
        return { w: parseFloat(s.outlineWidth), style: s.outlineStyle, shadow: s.boxShadow };
      });
      expect(outline.style !== 'none' && outline.w > 0 || outline.shadow !== 'none', 'フォーカスが見えない').toBe(true);
    });
  }

  // NFR-UX-007 AC-234（動きの軽減）
  test('NFR-UX-007 AC-234 動きの軽減を有効にすると、移動・サイズ変更の動き（transition・animation）が省かれる', async ({ page, start }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await start();
    await selectPersona(page, '事業部門');
    const [k] = await keys(page);
    await component(page, k).focus();
    const dur = await component(page, k).evaluate((el) => {
      const s = getComputedStyle(el);
      const ms = (v: string) => Math.max(...v.split(',').map((x) => (x.trim().endsWith('ms') ? parseFloat(x) : parseFloat(x) * 1000)));
      return Math.max(ms(s.transitionDuration), ms(s.animationDuration));
    });
    expect(dur, '動きの軽減でも動きが残っている').toBeLessThanOrEqual(1);
  });

  // NFR-UX-007 AC-235
  test('NFR-UX-007 AC-235 コンポーネントを最小の幅（240px）近くまで縮めても、本文の文字は 12px 以上', async ({ page, start }) => {
    await start();
    await selectPersona(page, '事業部門');
    await page.setViewportSize({ width: MIN_WIDTH * 5, height: 900 }); // 並ぶ数が増え、各幅が最小に近づく
    const ks = await keys(page);
    for (const k of ks) {
      const c = component(page, k);
      const w = (await box(c)).width;
      expect(w, `${k} が最小の幅未満`).toBeGreaterThanOrEqual(MIN_WIDTH - 1);
    }
    const small = await visibleComponents(page).evaluateAll((els, min) => {
      const out: string[] = [];
      for (const el of els) {
        const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let n = w.nextNode(); n; n = w.nextNode()) {
          const p = n.parentElement;
          if (!p || !(n.textContent ?? '').trim() || !p.offsetParent) continue;
          const px = parseFloat(getComputedStyle(p).fontSize);
          if (px < (min as number)) out.push(`${(n.textContent ?? '').trim().slice(0, 16)}: ${px}px`);
        }
      }
      return out;
    }, MIN_FONT);
    expect(small, '12px 未満の本文がある').toEqual([]);
  });

  // NFR-UX-007 AC-235（異常系: 大きく縮めて増やした状態）
  test('NFR-UX-007 AC-235 異常系: 画面を狭くして収まらないコンポーネントがタブにまとめられても、本文は 12px 以上', async ({ page, start }) => {
    await start();
    await selectPersona(page, '事業部門');
    await page.setViewportSize({ width: MIN_WIDTH * 2, height: 800 });
    const sizes = await page.getByTestId('workspace').locator('h1,h2,h3,[role=tab],p,li,td,span').evaluateAll((els) =>
      els.filter((e) => (e as HTMLElement).offsetParent && (e.textContent ?? '').trim()).map((e) => parseFloat(getComputedStyle(e).fontSize)));
    expect(sizes.length).toBeGreaterThan(0);
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(MIN_FONT);
  });
});
