// System Test: 情報の階層に基づく自動配置（FR-243 AC-584）と、ペルソナ別の主役・補助・詳細の分類（FR-244 AC-587）
// 期待値は要求定義書の受入基準（docs/requirements/app-experience.md の FR-243・FR-244）だけから決める。
// 画面の探し方は tests/system/CONTRACT.md §23。PARAM-034=240（CSS px。コンポーネントの最小の幅）。
import type { Page, Locator } from '@playwright/test';
import { test, expect, component, selectPersona, PERSONAS } from '../support/fixtures';
import { examplePack } from '../support/packs';

const mono = examplePack('mono');
const MIN_WIDTH = 240; // PARAM-034

/** §7 の表の既定の情報表現（ペルソナ → 主役。標準の検証条件はモノ） */
const DEFAULT_PRIMARY: Record<string, string> = {
  経営層: 'matrix',
  事業部門: 'issue-solution',
  IT: 'architecture',
  現場: 'twin-view', // 画面 view3d は廃止。中核オブジェクトの 3D は Twin ビュー（Q-062 A）
};

type Box = { x: number; y: number; width: number; height: number };
const TOP = '[data-testid^="component-"]:not([data-testid="component-menu"]):not([data-testid="component-actions"])';

async function layout(page: Page): Promise<Record<string, Box>> {
  return page.getByTestId('workspace').evaluate((ws, sel) => {
    const out: Record<string, Box> = {};
    ws.querySelectorAll(sel).forEach((el) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      if (!el.parentElement?.closest(sel) && r.width > 0 && r.height > 0) {
        out[(el.getAttribute('data-testid') ?? '').replace('component-', '')] = { x: r.x, y: r.y, width: r.width, height: r.height };
      }
    });
    return out;
  }, TOP);
}

const overlap = (a: Box, b: Box) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
const area = (b: Box) => b.width * b.height;

function expectNoOverlapAndMinWidth(boxes: Record<string, Box>) {
  const names = Object.keys(boxes);
  for (let i = 0; i < names.length; i++) {
    expect(boxes[names[i]].width, `${names[i]} が最小の幅（${MIN_WIDTH}px）未満`).toBeGreaterThanOrEqual(MIN_WIDTH - 1);
    for (let j = i + 1; j < names.length; j++) {
      expect(overlap(boxes[names[i]], boxes[names[j]]), `${names[i]} と ${names[j]} が重なる`).toBeLessThanOrEqual(4);
    }
  }
}

const tierOf = (c: Locator) => c.getAttribute('data-tier');

test.describe('FR-243 コンポーネントの配置時の、情報の階層に基づく自動配置', () => {
  // FR-243 AC-584
  test('FR-243 AC-584 保存済みのレイアウトがない状態で 4 つ以上のコンポーネントを置くと、主役が最大・補助と詳細が主役の右か下・重ならず最小の幅以上で、同じ操作は同じ配置', async ({ page, start }) => {
    const app = await start();
    for (const p of PERSONAS) {
      await selectPersona(page, p);
      const boxes = await layout(page);
      const keys = Object.keys(boxes);
      expect(keys.length, `${p}: コンポーネントが 4 つ以上必要`).toBeGreaterThanOrEqual(4);
      const primary = DEFAULT_PRIMARY[p];
      expect(boxes[primary], `${p}: 主役 ${primary} が表示されている`).toBeTruthy();
      // 主役が最大の領域
      for (const k of keys) if (k !== primary) expect(area(boxes[primary]), `${p}: 主役が ${k} より大きい`).toBeGreaterThan(area(boxes[k]));
      // 補助・詳細は主役の読む順序の後ろ（右か下）。主役より左上へは出ない
      for (const k of keys) {
        if (k === primary) continue;
        const b = boxes[k];
        const pb = boxes[primary];
        const after = b.x >= pb.x + pb.width - 4 || b.y >= pb.y + pb.height - 4 || b.x >= pb.x - 4 && b.y >= pb.y - 4;
        expect(after, `${p}: ${k} が主役の前（左上）に置かれている`).toBe(true);
      }
      expectNoOverlapAndMinWidth(boxes);
      // 同じ操作を繰り返すと同じ配置（再読込後に同じペルソナを選び直す）
      await app.reload();
      await selectPersona(page, p);
      const again = await layout(page);
      expect(Object.keys(again).sort()).toEqual(keys.sort());
      for (const k of keys) {
        expect(Math.abs(again[k].x - boxes[k].x), `${p}: ${k} の x`).toBeLessThanOrEqual(2);
        expect(Math.abs(again[k].y - boxes[k].y), `${p}: ${k} の y`).toBeLessThanOrEqual(2);
        expect(Math.abs(again[k].width - boxes[k].width), `${p}: ${k} の幅`).toBeLessThanOrEqual(2);
        expect(Math.abs(again[k].height - boxes[k].height), `${p}: ${k} の高さ`).toBeLessThanOrEqual(2);
      }
    }
  });

  // FR-243 AC-584（異常系: 非表示にしてから再表示した（追加した）コンポーネントも、重ならず最小の幅以上で置かれる）
  test('FR-243 AC-584 異常系: コンポーネントを非表示にして再表示しても、重ならず最小の幅以上で、主役は最大のまま', async ({ page, start }) => {
    await start();
    await selectPersona(page, '事業部門');
    const before = await layout(page);
    const hideKey = Object.keys(before).find((k) => k !== DEFAULT_PRIMARY['事業部門'])!;
    const target = component(page, hideKey);
    await target.focus();
    await page.keyboard.press('h');
    await expect(target).toBeHidden();
    await page.getByTestId('dock').getByRole('button').first().click();
    await expect.poll(async () => Object.keys(await layout(page)).length, { timeout: 5_000 }).toBeGreaterThanOrEqual(Object.keys(before).length);
    const after = await layout(page);
    expectNoOverlapAndMinWidth(after);
    for (const k of Object.keys(after)) if (k !== DEFAULT_PRIMARY['事業部門']) expect(area(after[DEFAULT_PRIMARY['事業部門']])).toBeGreaterThan(area(after[k]));
  });
});

test.describe('FR-244 情報の階層（主役・補助・詳細）の分類', () => {
  // FR-244 AC-587（AC-138 と同じ件数の不変を含む）
  test('FR-244 AC-587 各ペルソナで既定の情報表現が「主役」、ほかが「補助」か「詳細」と示され、理由を見出しのメニューで確かめられ、検索の件数は変わらない', async ({ page, start }) => {
    await start();
    const term = mono.issues()[0].title.slice(0, 1);
    const counts: number[] = [];
    for (const p of PERSONAS) {
      await selectPersona(page, p);
      const boxes = await layout(page);
      const primary = DEFAULT_PRIMARY[p];
      expect(await tierOf(component(page, primary)), `${p}: ${primary} の階層`).toBe('primary');
      const others = Object.keys(boxes).filter((k) => k !== primary);
      expect(others.length).toBeGreaterThan(0);
      for (const k of others) expect(['supporting', 'detail'], `${p}: ${k} の階層`).toContain(await tierOf(component(page, k)));
      // 理由つきで見出しのメニューから確かめられる
      const c = component(page, primary);
      await c.getByRole('heading').first().click({ button: 'right' });
      const menu = page.getByRole('menu').first();
      await expect(menu).toBeVisible();
      await menu.getByRole('menuitem', { name: /情報の階層/ }).click();
      const reason = page.getByTestId('tier-reason');
      await expect(reason).toBeVisible();
      await expect(reason).toContainText('主役');
      await expect(reason).toContainText(/理由|ため|から/);
      await page.keyboard.press('Escape');
      // 件数は変わらない
      await page.getByRole('searchbox', { name: /検索/ }).fill(term);
      const results = page.getByTestId('search-results');
      await expect(results).toBeVisible();
      counts.push(await results.getByRole('option').count());
      await page.getByRole('searchbox', { name: /検索/ }).fill('');
    }
    expect(counts[0]).toBeGreaterThan(0);
    expect(new Set(counts).size, `件数: ${counts.join(',')}`).toBe(1);
  });

  // FR-244 AC-587（異常系: 主役は 1 つだけ。主役が複数・0 にならない）
  test('FR-244 AC-587 異常系: どのペルソナでも「主役」はちょうど 1 つで、どのコンポーネントも階層が示される', async ({ page, start }) => {
    await start();
    for (const p of PERSONAS) {
      await selectPersona(page, p);
      const keys = Object.keys(await layout(page));
      const tiers: string[] = [];
      for (const k of keys) {
        const t = await tierOf(component(page, k));
        expect(['primary', 'supporting', 'detail'], `${p}: ${k} の階層が示されない`).toContain(t);
        tiers.push(t!);
      }
      expect(tiers.filter((t) => t === 'primary').length, `${p}: 主役の数`).toBe(1);
    }
  });
});

// ---- 以下: 検証レベル integration の AC（台帳のケースのみで足りるが、画面から確かめられる範囲を E2E でも置く）----
import { pinButton } from '../support/screens';

async function selectedText(page: Page): Promise<string> {
  return (await page.getByTestId('selection-indicator').textContent()) ?? '';
}
async function openMenu(page: Page, c: Locator) {
  await c.getByRole('heading').first().click({ button: 'right' });
  const m = page.getByRole('menu').first();
  await expect(m).toBeVisible();
  return m;
}

test.describe('FR-243 手で動かした・ピン止めの配置の保持と、自動配置の実行・停止・取消', () => {
  // FR-243 AC-585
  test('FR-243 AC-585 手で動かした A とピン止めした B は、別のコンポーネントを追加して自動配置が働いても位置・大きさが変わらず、追加分は重ならない', async ({ page, start }) => {
    await start();
    await selectPersona(page, '事業部門');
    const keys = Object.keys(await layout(page));
    const [a, b, hidden] = keys.filter((k) => k !== DEFAULT_PRIMARY['事業部門']);
    const h = component(page, hidden);
    await h.focus();
    await page.keyboard.press('h');
    await expect(h).toBeHidden();
    // 自由な移動は重なりを許す（Q-066 B）。A は作業領域の中央へ向けて縦にだけ 60px 動かす
    const ha = await component(page, a).getByRole('heading').first().boundingBox();
    const wsb = await page.getByTestId('workspace').boundingBox();
    // FR-296 の既定（2 列×2 行）では、縦 60px だと隣の主役の下辺領域に落ちて分割配置（実質 no-op）になる。主役から離れる横方向へ、領域の外に出る距離だけ動かす。
    const cx = ha!.x + ha!.width / 2;
    const dx = cx < wsb!.x + wsb!.width / 2 ? -300 : 300;
    const dy = ha!.y + ha!.height / 2 < wsb!.y + wsb!.height / 2 ? 60 : -60;
    await page.mouse.move(ha!.x + ha!.width / 2, ha!.y + ha!.height / 2);
    await page.mouse.down();
    await page.mouse.move(ha!.x + ha!.width / 2 + dx, ha!.y + ha!.height / 2 + dy, { steps: 8 });
    await page.mouse.up();
    await component(page, b).focus();
    await pinButton(component(page, b)).click();
    const before = await layout(page);
    await page.getByTestId('dock').getByRole('button').first().click();
    await expect(h).toBeVisible();
    const after = await layout(page);
    for (const k of [a, b]) for (const f of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(after[k][f] - before[k][f]), `${k}.${f} が変わった`).toBeLessThanOrEqual(2);
    expect(overlap(after[hidden], after[a])).toBeLessThanOrEqual(4);
    expect(overlap(after[hidden], after[b])).toBeLessThanOrEqual(4);
  });

  // FR-243 AC-586
  test('FR-243 AC-586 自動配置をメニューで実行・停止・取消でき、停止後の追加で既存の配置が動かず、既定に戻すと FR-112 の配置になり、選択中の対象は変わらない', async ({ page, start }) => {
    await start();
    await selectPersona(page, '事業部門');
    const issue = mono.issues()[0];
    await page.getByTestId('selection-indicator').waitFor({ state: 'attached' }).catch(() => {});
    const keys = Object.keys(await layout(page));
    const initial = await layout(page);
    const sel = await selectedText(page);
    const c = component(page, keys[1]);
    // 停止
    let m = await openMenu(page, c);
    await m.getByRole('menuitem', { name: /自動配置を停止/ }).click();
    const hideKey = keys.find((k) => k !== DEFAULT_PRIMARY['事業部門'] && k !== keys[1])!;
    const hk = component(page, hideKey);
    await hk.focus();
    await page.keyboard.press('h');
    const stopped = await layout(page);
    await page.getByTestId('dock').getByRole('button').first().click();
    await expect(hk).toBeVisible();
    const afterAdd = await layout(page);
    for (const k of Object.keys(stopped)) for (const f of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(afterAdd[k][f] - stopped[k][f]), `停止後に ${k}.${f} が動いた`).toBeLessThanOrEqual(2);
    // 実行して取消（キーボード: コマンドパレット）
    await page.keyboard.press('Control+k');
    await page.getByRole('combobox').fill('自動配置を実行');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Control+k');
    await page.getByRole('combobox').fill('自動配置を取り消す');
    await page.keyboard.press('Enter');
    const undone = await layout(page);
    for (const k of Object.keys(afterAdd)) expect(Math.abs(undone[k].x - afterAdd[k].x) + Math.abs(undone[k].y - afterAdd[k].y), `取消後に ${k} が戻らない`).toBeLessThanOrEqual(4);
    // 既定のレイアウトに戻す
    await page.getByRole('button', { name: /レイアウトを既定に戻す|既定のレイアウトに戻す/ }).click();
    const dflt = await layout(page);
    expect(Object.keys(dflt).sort()).toEqual(Object.keys(initial).sort());
    expect(await selectedText(page), '選択中の対象が変わった').toBe(sel);
    void issue;
  });

  // FR-243 AC-586（動きの軽減）
  test('FR-243 AC-586 動きの軽減が有効なとき、自動配置は途中の動きを省いて結果を直接示す', async ({ page, start }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await start();
    await selectPersona(page, '事業部門');
    const keys = Object.keys(await layout(page));
    const m = await openMenu(page, component(page, keys[1]));
    await m.getByRole('menuitem', { name: /自動配置を実行/ }).click();
    const frames = await page.evaluate(async () => {
      const seen = new Set<string>();
      const t0 = performance.now();
      while (performance.now() - t0 < 600) {
        await new Promise((r) => requestAnimationFrame(r));
        const s = Array.from(document.querySelectorAll('[data-testid^="component-"]')).map((e) => { const r = e.getBoundingClientRect(); return `${e.getAttribute('data-testid')}:${Math.round(r.x)},${Math.round(r.y)}`; }).join('|');
        seen.add(s);
      }
      return seen.size;
    });
    expect(frames, '途中の配置が何段階も出ている').toBeLessThanOrEqual(2);
  });
});

test.describe('FR-244 同じ対象の隣り合わせ・階層の変更・未分類・色だけに頼らない表示', () => {
  // FR-244 AC-588
  test('FR-244 AC-588 同じ対象を示す同じ階層のコンポーネントが隣り合い、階層の表示と変更がキーボードでもでき、再読込後も保たれる', async ({ page, start }) => {
    const app = await start();
    await selectPersona(page, '事業部門');
    const boxes = await layout(page);
    const groups = new Map<string, string[]>();
    for (const k of Object.keys(boxes)) {
      const g = await component(page, k).getAttribute('data-group');
      const t = await tierOf(component(page, k));
      if (g) groups.set(`${t}/${g}`, [...(groups.get(`${t}/${g}`) ?? []), k]);
    }
    for (const [g, ks] of groups) {
      if (ks.length < 2) continue;
      // 同じグループの外のコンポーネントが、グループの外接矩形の中に入らない
      const xs = ks.map((k) => boxes[k]);
      const bb = { x: Math.min(...xs.map((b) => b.x)), y: Math.min(...xs.map((b) => b.y)), width: 0, height: 0 };
      bb.width = Math.max(...xs.map((b) => b.x + b.width)) - bb.x;
      bb.height = Math.max(...xs.map((b) => b.y + b.height)) - bb.y;
      for (const k of Object.keys(boxes)) if (!ks.includes(k)) expect(overlap(boxes[k], bb), `${g}: 無関係な ${k} がグループの間に入る`).toBeLessThanOrEqual(4);
    }
    // キーボードで階層を変更（メニューは Shift+F10）
    const target = Object.keys(boxes).find((k) => k !== DEFAULT_PRIMARY['事業部門'])!;
    const c = component(page, target);
    await c.getByRole('heading').first().focus();
    await page.keyboard.press('Shift+F10');
    await page.getByRole('menuitemradio', { name: '詳細' }).press('Enter');
    await expect(c).toHaveAttribute('data-tier', 'detail');
    await app.reload();
    await selectPersona(page, '事業部門');
    await expect(component(page, target)).toHaveAttribute('data-tier', 'detail');
  });

  // FR-244 AC-589
  test('FR-244 AC-589 役割のないコンポーネントは「補助」で、見出しのメニューで階層を選べ、階層の違いは色だけでなく文字か形でも分かる', async ({ page, start }) => {
    await start();
    await selectPersona(page, '事業部門');
    const keys = Object.keys(await layout(page));
    // 階層ごとに文字ラベルが出ている（色だけに頼らない）
    const expected: Record<string, string> = { primary: '主役', supporting: '補助', detail: '詳細' };
    for (const k of keys) {
      const c = component(page, k);
      const t = (await tierOf(c))!;
      await expect(c.getByTestId('tier-label'), `${k}: 階層の文字`).toHaveText(expected[t]);
    }
    // 異常系: 未分類（data-role なし）のコンポーネントは補助
    const unclassified = page.locator('[data-testid^="component-"]:not([data-role])');
    for (let i = 0; i < (await unclassified.count()); i++) {
      const u = unclassified.nth(i);
      if (!(await u.isVisible())) continue;
      if ((await u.getAttribute('data-testid')) === 'component-menu' || (await u.getAttribute('data-testid')) === 'component-actions') continue;
      expect(await tierOf(u), '未分類は補助').toBe('supporting');
    }
    const k0 = keys.find((k) => k !== DEFAULT_PRIMARY['事業部門'])!;
    const m = await openMenu(page, component(page, k0));
    await expect(m.getByRole('menuitemradio', { name: '主役' })).toBeVisible();
    await expect(m.getByRole('menuitemradio', { name: '補助' })).toBeVisible();
    await expect(m.getByRole('menuitemradio', { name: '詳細' })).toBeVisible();
  });
});
