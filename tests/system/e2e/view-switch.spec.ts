// System Test: 全画面・全コンポーネントでの 2D/3D の切替と、現実世界／デジタル世界／両方の表示の切替・ツイン関係の表示
// 期待値は要求定義書の受入基準（docs/requirements/app-experience.md の FR-217 AC-499・FR-218 AC-503）と、お手本パックの内容から決める。
// 3D の表現を持つ画面（FR-217 の本文）: 地図・ナレッジグラフ・アーキテクチャ図・データカタログのデータビュアー・ガントチャート（2.5D）。
// 画面の探し方は CONTRACT.md §21（見出しの「ビュー」ボタン、menuitemradio「2D」「3D」「現実世界」「デジタル世界」「両方」、フック t.view.state(key)）。
// 顧客パックの世界区分・ツイン関係の項目名は CONTRACT.md §3（entities[].world = "real"|"digital"、entities.json の twins[]）。
import type { Page } from '@playwright/test';
import { test, expect, component, selectPersona, openScreen, hook, scene, tableRows, entity } from '../support/fixtures';
import { examplePack, makeVariant, PACK_FILES, type Pack, type PackKind } from '../support/packs';
import { listScreenKeys, gotoScreen, openViewMenu, chooseView, viewButton, type ViewState } from '../support/screens';

/** FR-217 の本文で 3D の表現を持つと書かれた画面（2D と 3D の両方を持つもの） */
const REQUIRED_3D = ['map', 'knowledge-graph', 'architecture', 'data-catalog', 'gantt'];

/** FR-217 AC-501（Q-035 C）で 3D の表現を新しく作る画面（画面の登録の key） */
const NEW_3D = ['table', 'matrix', 'ranking', 'issue-solution', 'discussion-tree', 'kpi-okr'];

const viewState = (page: Page, key: string) => hook<ViewState>(page, 't.view.state(a)', key);

/**
 * 一覧表の絞り込みの値を読む。FR-296 の同時表示の上限で、一覧表が最小化（FR-295 の一覧に残る）されて中身が描かれていないときは、
 * 一覧表を再表示して読み、元の画面へ戻る（絞り込みの値の一致の判定は緩めない）。
 */
async function readFilter(page: Page): Promise<string> {
  const field = () => component(page, 'table').getByRole('textbox', { name: /絞り込み/, includeHidden: true });
  if ((await field().count()) > 0) return field().inputValue();
  const prev = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.closest('[data-testid^="component-"]:not([data-testid="component-menu"]):not([data-testid="component-actions"]):not([data-testid="component-data"])')?.getAttribute('data-testid')?.replace('component-', '') ?? null);
  await gotoScreen(page, 'table');
  const v = await field().inputValue();
  if (prev && prev !== 'table') await gotoScreen(page, prev);
  return v;
}

/** 選択・絞り込み・時刻・期間（NFR-UX-001 の保持の対象）を読む */
async function keptState(page: Page) {
  // 期間・時刻の操作も裏のタブに回ることがあるため、隠れた要素も含めて読む（表示の有無で値が変わったと誤判定しない）
  const period = page
    .getByRole('combobox', { name: /期間/, includeHidden: true })
    .or(page.getByRole('slider', { name: /期間/, includeHidden: true }))
    .first();
  return {
    selection: await page.getByTestId('selection-indicator').innerText(),
    // 一覧表は最小の幅の規則（FR-150 など）でほかの画面と同じタブにまとまり裏のタブに回ることがある。
    // 裏のタブでも絞り込みの値は保たれているべきなので、隠れた要素も含めて読む（値の一致の判定は緩めない）。
    filter: await readFilter(page),
    time: await page.getByRole('slider', { name: '時間軸' }).first().getAttribute('aria-valuenow'),
    period: (await period.count()) ? ((await period.getAttribute('aria-valuenow')) ?? (await period.inputValue().catch(() => ''))) : null,
  };
}

/** 一覧表で項目を選び、絞り込みを入れ、時刻を動かす */
async function prepareSelection(page: Page): Promise<void> {
  const table = await openScreen(page, 'table');
  const row = table.locator('[role="row"][data-entity-id]').first();
  await row.click();
  // 絞り込みの対象は名称・ID・種別。選択後の行の先頭は状態の「選択中」になるため、行の文字ではなく ID（選択状態に影響されない）で絞る。
  const id = await row.getAttribute('data-entity-id');
  expect(id, '選んだ行に data-entity-id がない').toBeTruthy();
  await table.getByRole('textbox', { name: /絞り込み/ }).fill(id!);
  const slider = page.getByRole('slider', { name: '時間軸' }).first();
  await slider.focus();
  await page.keyboard.press('ArrowRight');
}

/** 2D・3D の両方が選べる（どちらの選択肢も有効な）画面の一覧を、画面の登録を走査して求める */
async function switchableScreens(page: Page): Promise<string[]> {
  const out: string[] = [];
  for (const key of await listScreenKeys(page)) {
    if (key === 'settings') continue; // 設定はモーダルの dialog で「ビュー」を持たない（FR-223）
    const c = await gotoScreen(page, key);
    const menu = await openViewMenu(page, c);
    const two = menu.getByRole('menuitemradio', { name: '2D', exact: true });
    const three = menu.getByRole('menuitemradio', { name: '3D', exact: true });
    if ((await two.isEnabled()) && (await three.isEnabled())) out.push(key);
    await page.keyboard.press('Escape');
  }
  return out;
}

test.describe('FR-217 全画面での 2D/3D の切替', () => {
  // FR-217 AC-499
  test('FR-217 AC-499 3D の表現を持つ各画面で、選択・絞り込みのまま 2D→3D→2D と切り替えても選択・絞り込み・期間・時刻と項目の件数が変わらず、再読込で最後の表示モードが復元される', async ({ page, start }) => {
    test.setTimeout(300_000);
    const app = await start();
    await selectPersona(page, '事業部門');
    const screens = await switchableScreens(page);
    for (const k of REQUIRED_3D) expect(screens, `3D の表現を持つ画面「${k}」で 2D/3D が選べない`).toContain(k);
    await prepareSelection(page);
    const kept = await keptState(page);
    for (const key of screens) {
      const c = await gotoScreen(page, key);
      await chooseView(page, c, '2D');
      const s2 = await viewState(page, key);
      expect(s2.mode, `${key}: 2D にならない`).toBe('2d');
      await chooseView(page, c, '3D');
      const s3 = await viewState(page, key);
      expect(s3.mode, `${key}: 3D にならない`).toBe('3d');
      expect(s3.itemIds.length, `${key}: 3D で項目の件数が変わる`).toBe(s2.itemIds.length);
      expect([...s3.selectedIds].sort(), `${key}: 3D で選択中の項目が変わる`).toEqual([...s2.selectedIds].sort());
      expect(await keptState(page), `${key}: 3D で選択・絞り込み・期間・時刻が変わる`).toEqual(kept);
      await chooseView(page, c, '2D');
      const back = await viewState(page, key);
      expect(back.itemIds.length, `${key}: 2D に戻して項目の件数が変わる`).toBe(s2.itemIds.length);
      expect([...back.selectedIds].sort()).toEqual([...s2.selectedIds].sort());
      expect(await keptState(page), `${key}: 2D に戻して状態が変わる`).toEqual(kept);
      // 最後の表示モードを 3D にしておく
      await chooseView(page, c, '3D');
    }
    await app.reload();
    for (const key of screens) {
      const c = await gotoScreen(page, key);
      await c.focus();
      await expect(viewButton(c), `${key}: 再読込後に 3D で復元されない`).toContainText('3D');
      expect((await viewState(page, key)).mode).toBe('3d');
    }
  });

  // FR-217 AC-499（異常系: メニューを Esc で閉じると表示モードは変わらず、件数・選択も変わらない）
  test('FR-217 AC-499 異常系: 「ビュー」のメニューを選ばずに Esc で閉じると、表示モード・項目の件数・選択が変わらない', async ({ page, start }) => {
    await start();
    await prepareSelection(page);
    const kept = await keptState(page);
    for (const key of REQUIRED_3D) {
      const c = await gotoScreen(page, key);
      const before = await viewState(page, key);
      const menu = await openViewMenu(page, c);
      await menu.getByRole('menuitemradio', { name: before.mode === '2d' ? '3D' : '2D', exact: true }).hover();
      await page.keyboard.press('Escape');
      await expect(menu).toBeHidden();
      const after = await viewState(page, key);
      expect(after.mode, `${key}: Esc で表示モードが変わった`).toBe(before.mode);
      expect(after.itemIds.length).toBe(before.itemIds.length);
      expect(await keptState(page)).toEqual(kept);
    }
  });

  // FR-217 AC-501
  test('FR-217 AC-501 3D の表現を新しく作る 6 画面（一覧表・2×2 マトリクス・ランキング表・課題-解決策分析・議論ツリー・KPI/OKR）で、3D に切り替えると項目が 3D 空間に表示され、選択・絞り込み・期間・時刻・件数が保たれ、再読込で復元され、表の代替が残る', async ({ page, start }) => {
    test.setTimeout(300_000);
    const app = await start();
    await selectPersona(page, '事業部門');
    await prepareSelection(page);
    const kept = await keptState(page);
    for (const key of NEW_3D) {
      const c = await gotoScreen(page, key);
      await chooseView(page, c, '2D');
      const s2 = await viewState(page, key);
      expect(s2.itemIds.length, `${key}: 2D で項目がない（検証条件が成り立たない）`).toBeGreaterThan(0);
      await chooseView(page, c, '3D'); // 3D が選べない（disabled）と、ここで失敗する
      const s3 = await viewState(page, key);
      expect(s3.mode, `${key}: 3D にならない`).toBe('3d');
      await expect(c.locator('[data-zoom-surface="3d"]').first(), `${key}: 3D の面が表示されない`).toBeVisible();
      expect([...(s3.items3d ?? [])].sort(), `${key}: 3D 空間に描かれた項目が 2D の項目と一致しない`).toEqual([...s2.itemIds].sort());
      expect(s3.itemIds.length, `${key}: 3D で項目の件数が変わる`).toBe(s2.itemIds.length);
      expect([...s3.selectedIds].sort(), `${key}: 3D で選択中の項目が変わる`).toEqual([...s2.selectedIds].sort());
      expect(await keptState(page), `${key}: 3D で選択・絞り込み・期間・時刻が変わる`).toEqual(kept);
      await expect(c.getByRole('button', { name: '表で見る' }).first(), `${key}: 3D の表示中に表の代替がない`).toBeAttached();
      await chooseView(page, c, '2D');
      const back = await viewState(page, key);
      expect(back.itemIds.length, `${key}: 2D に戻して項目の件数が変わる`).toBe(s2.itemIds.length);
      expect(await keptState(page), `${key}: 2D に戻して状態が変わる`).toEqual(kept);
      await chooseView(page, c, '3D');
    }
    await app.reload();
    for (const key of NEW_3D) {
      const c = await gotoScreen(page, key);
      await c.focus();
      await expect(viewButton(c), `${key}: 再読込後に 3D で復元されない`).toContainText('3D');
      expect((await viewState(page, key)).mode).toBe('3d');
    }
  });

  // FR-217 AC-501（異常系: 6 画面とも 2D に戻した状態で再読込すると 2D で復元され、3D の面が残らない）
  test('FR-217 AC-501 異常系: 6 画面を 2D に戻して再読込すると 2D で復元され、3D の面が表示されず、項目の件数が変わらない', async ({ page, start }) => {
    test.setTimeout(300_000);
    const app = await start();
    await selectPersona(page, '事業部門');
    const counts: Record<string, number> = {};
    for (const key of NEW_3D) {
      const c = await gotoScreen(page, key);
      await chooseView(page, c, '3D');
      await chooseView(page, c, '2D');
      counts[key] = (await viewState(page, key)).itemIds.length;
    }
    await app.reload();
    for (const key of NEW_3D) {
      const c = await gotoScreen(page, key);
      await c.focus();
      await expect(viewButton(c), `${key}: 再読込後に 2D で復元されない`).toContainText('2D');
      const s = await viewState(page, key);
      expect(s.mode).toBe('2d');
      expect(s.itemIds.length, `${key}: 再読込で項目の件数が変わる`).toBe(counts[key]);
      await expect(c.locator('[data-zoom-surface="3d"]'), `${key}: 2D なのに 3D の面が残る`).toHaveCount(0);
    }
  });
});

// ---- FR-218 ----

type World = 'real' | 'digital' | 'none';

/**
 * 顧客パックのうち、スキーマに世界区分の項目を持たないデータの世界区分（FR-218・A-57）。
 * §3.7 のエンティティの分類表の世界区分に従う（パックのファイル名と JSON の位置 → 分類表の行）。
 * 分類表に対応する行が一意に決まらないもの（customer.coreObject.criteria・plan.tasks・mocks）は載せず、件数の判定に使わない。
 */
const TABLE_WORLDS: Record<string, World> = {
  'entities:.flows[]': 'real', // 流れ（現実世界・業務）
  'issues:.issues[]': 'real', // 課題（現実世界・コト）
  'issues:.issues[].causes[]': 'real', // 原因（現実世界・コト）
  'issues:.solutions[]': 'real', // 解決策（現実世界・コト）
  'issues:.solutions[].effects[]': 'real', // 効果（現実世界・コト）
  'customer:.coreObject.candidates[]': 'real', // 中核オブジェクト（Q-038 A: 顧客パックの種別（モノ/コト）に従う。モノもコトも現実世界なので mono・koto とも現実世界。改善要望はデジタル世界のデータだが、顧客パックのファイルに行がなく、この表には載せない）
  'customer:.useCases[]': 'real', // ユースケース（現実世界・業務）
  'customer:.okr.objectives[].keyResults[]': 'digital', // OKR（デジタル世界・センサー/指標）
  'architecture:.nodes[]': 'digital', // アーキテクチャ（デジタル世界・モデル）
  'architecture:.edges[]': 'digital',
  'architecture:.asis.elements[]': 'digital',
  'architecture:.tobe.elements[]': 'digital',
  'plan:.features[]': 'digital', // Feature（デジタル世界・システム）
  'products:.products[]': 'digital', // Microsoft 製品（デジタル世界・システム）
  'sources:.sources[]': 'digital', // 出典（デジタル世界・データ）
  'show:.chapters[]': 'digital', // チャプター（デジタル世界・画面コンポーネント）
  'show:.chapters[].topics[]': 'real', // 論点（現実世界・コト）
  'show:.chapters[].topics[].quiz.questions[]': 'digital', // ショー（クイズ）→ ショー（デジタル世界・画面コンポーネント）
};

/**
 * お手本パックの全ファイルから、ID ごとの世界区分を集める（FR-218・A-57）。
 * - 世界区分の項目を持つエンティティ（entities.json の entities[]）: world の値。書かれていなければ「区分なし」。
 * - スキーマに世界区分の項目を持たないデータ（課題・原因・解決策など）: §3.7 の分類表の世界区分（TABLE_WORLDS）。「区分なし」にはしない。
 */
function worldsOf(pack: Pack): Map<string, World> {
  const m = new Map<string, World>();
  const walk = (f: string, v: any, p: string) => {
    if (Array.isArray(v)) v.forEach((x) => walk(f, x, `${p}[]`));
    else if (v && typeof v === 'object') {
      if (typeof v.id === 'string') {
        if (f === 'entities' && p === '.entities[]') m.set(v.id, v.world === 'real' || v.world === 'digital' ? v.world : 'none');
        else if (TABLE_WORLDS[`${f}:${p}`] && !m.has(v.id)) m.set(v.id, TABLE_WORLDS[`${f}:${p}`]);
      }
      for (const [k, x] of Object.entries(v)) walk(f, x, `${p}.${k}`);
    }
  };
  for (const f of PACK_FILES) {
    let j: any;
    try { j = pack.json(f); } catch { continue; /* ないファイルは数えない */ }
    walk(f, j, '');
  }
  return m;
}
function twinsOf(pack: Pack): Array<{ realId: string; digitalId: string; relation: string }> {
  return (pack.json('entities').twins ?? []) as any[];
}

/** 現実世界の設備（エンティティの階層で「設備」のレベル）のうち、ツイン関係を持つもの */
function equipmentWithTwins(pack: Pack): any {
  const j = pack.json('entities');
  const ents: any[] = j.entities;
  const byId = new Map(ents.map((e) => [e.id, e]));
  const depth = (e: any): number => { let d = 0; for (let p = e; p?.parentId && byId.has(p.parentId); p = byId.get(p.parentId)) d++; return d; };
  const level = (e: any) => (j.levels ?? [])[depth(e)]?.name;
  const twins = twinsOf(pack);
  return ents.find((e) => e.world === 'real' && level(e) === '設備' && twins.some((t) => t.realId === e.id));
}

/** 表示している項目の ID（一覧表は行、ナレッジグラフはノード、Twin ビューの 3D はオブジェクト。画面 view3d は廃止。Q-062 A） */
async function shownIds(page: Page, key: 'table' | 'knowledge-graph' | 'twin-view'): Promise<string[]> {
  if (key === 'table') return tableRows(component(page, 'table')).evaluateAll((els) => els.map((e) => e.getAttribute('data-entity-id')!).filter(Boolean));
  if (key === 'knowledge-graph') return (await hook<Array<{ id: string; visible: boolean }>>(page, 't.graph.nodes()')).filter((n) => n.visible).map((n) => n.id);
  return (await scene.objects(page)).filter((o) => o.visible).map((o) => o.entityId);
}

async function checkWorlds(page: Page, pack: Pack, key: 'table' | 'knowledge-graph' | 'twin-view'): Promise<void> {
  const worlds = worldsOf(pack);
  const twins = twinsOf(pack);
  const c = await gotoScreen(page, key);
  const inPack = (ids: string[]) => [...new Set(ids)].filter((i) => worlds.has(i));
  const of = (ids: string[], w: World) => inPack(ids).filter((i) => worlds.get(i) === w).sort();

  await chooseView(page, c, '両方');
  const both = inPack(await shownIds(page, key));
  expect(of(both, 'real').length, `${key}: 「両方」に現実世界の項目がない`).toBeGreaterThan(0);
  expect(of(both, 'digital').length, `${key}: 「両方」にデジタル世界の項目がない`).toBeGreaterThan(0);
  const links = (await viewState(page, key)).twinLinks;
  expect(links.length, `${key}: 「両方」でツイン関係の線か印がない`).toBeGreaterThan(0);
  for (const [r, d] of links) {
    expect(twins.some((t) => t.realId === r && t.digitalId === d), `${key}: パックにないツイン関係 ${r}→${d}`).toBe(true);
  }

  await chooseView(page, c, '現実世界');
  const real = inPack(await shownIds(page, key));
  expect(real.sort(), `${key}: 「現実世界」で現実世界の項目だけにならない`).toEqual(of(both, 'real'));
  // A-57: 世界区分の項目を持たない課題は、どの画面でも §3.7 の分類表どおり現実世界として出る（「区分なし」として「両方」だけに出さない）
  const issueIds = new Set(pack.issues().map((i: any) => i.id));
  for (const id of both.filter((i) => issueIds.has(i))) expect(real, `${key}: 課題 ${id} が「現実世界」に出ない（A-57）`).toContain(id);
  expect((await viewState(page, key)).twinLinks, `${key}: 「現実世界」でツイン関係が出る`).toEqual([]);

  await chooseView(page, c, 'デジタル世界');
  const digital = inPack(await shownIds(page, key));
  expect(digital.sort(), `${key}: 「デジタル世界」でデジタル世界の項目だけにならない`).toEqual(of(both, 'digital'));

  expect(both.length, `${key}: 「両方」の件数が現実世界・デジタル世界・区分なしの和でない`).toBe(real.length + digital.length + of(both, 'none').length);
  await chooseView(page, c, '両方');
}

test.describe('FR-218 現実世界／デジタル世界／両方の表示の切替', () => {
  for (const kind of ['mono', 'koto'] as PackKind[]) {
    // FR-218 AC-503
    test(`FR-218 AC-503 ${kind}: 一覧表・ナレッジグラフ・Twin ビューで「現実世界」「デジタル世界」はその世界の項目だけ、「両方」は和（区分なしを含む）とツイン関係の線か印を表示する`, async ({ page, start }) => {
      test.setTimeout(180_000);
      const pack = examplePack(kind);
      await start({ pack: kind });
      for (const key of ['table', 'knowledge-graph', 'twin-view'] as const) await checkWorlds(page, pack, key);
    });
  }

  // FR-218 AC-503（ツインの強調の連動）
  test('FR-218 AC-503 「両方」で現実世界の設備を 1 件選ぶと、ツイン関係にあるデジタル世界の項目（3D モデル・指標を含む）が、開いているほかの画面でも強調される', async ({ page, start }) => {
    test.setTimeout(120_000);
    const pack = examplePack('mono');
    await start({ pack: 'mono' });
    const eq = equipmentWithTwins(pack);
    expect(eq, 'お手本パックにツイン関係を持つ現実世界の設備がない').toBeTruthy();
    const twinIds = twinsOf(pack).filter((t) => t.realId === eq.id).map((t) => t.digitalId);
    for (const key of ['twin-view', 'knowledge-graph', 'table'] as const) await chooseView(page, await gotoScreen(page, key), '両方');
    const table = component(page, 'table');
    await entity(table, eq.id).first().click();
    // Twin ビューの 3D（別の画面）
    const objs = await scene.objects(page);
    const in3d = twinIds.filter((id) => objs.some((o) => o.entityId === id));
    const graphNodes = await hook<Array<{ id: string; visible: boolean }>>(page, 't.graph.nodes()');
    const inGraph = twinIds.filter((id) => graphNodes.some((n) => n.id === id && n.visible));
    expect(in3d.length + inGraph.length, 'ツイン関係のデジタル世界の項目が、ほかの画面に 1 件も表示されていない').toBeGreaterThan(0);
    for (const id of in3d) {
      await expect.poll(async () => (await scene.objects(page)).find((o) => o.entityId === id)?.highlighted, { message: `3D ビューで ${id} が強調されない` }).toBe(true);
    }
    const graph = component(page, 'knowledge-graph');
    for (const id of inGraph) {
      await expect(entity(graph, id).first(), `ナレッジグラフで ${id} が強調されない`).toHaveAttribute('data-highlight', /selected|related/);
    }
    // 同じ画面（一覧表）でも強調される
    for (const id of twinIds) {
      if ((await entity(table, id).count()) > 0) await expect(entity(table, id).first()).toHaveAttribute('data-highlight', /selected|related/);
    }
  });

  // FR-218 AC-503（異常系: エンティティに世界区分のないパックでは、そのエンティティは「現実世界」「デジタル世界」に出ず、「両方」で「区分なし」として出る。
  // 世界区分の項目を持たない課題などは A-57 のとおり §3.7 の分類表の世界区分（課題は現実世界）に従う）
  test('FR-218 AC-503 異常系: エンティティに世界区分とツイン関係のない顧客パックでは、そのエンティティは「現実世界」「デジタル世界」に 0 件で「両方」に「区分なし」として出てツイン関係の線は出ず、課題は「現実世界」に出る', async ({ page, start }) => {
    const plain = makeVariant('mono', 'no-world', (p) => {
      p.edit('entities', (j) => {
        delete j.twins;
        for (const e of j.entities) { delete e.world; delete e.kind; }
      });
    });
    await start({ pack: plain });
    const c = await gotoScreen(page, 'table');
    await chooseView(page, c, '両方');
    const both = await shownIds(page, 'table');
    expect(both.length).toBeGreaterThan(0);
    await expect(c, '区分なしの項目に「区分なし」の表示がない').toContainText('区分なし');
    expect((await viewState(page, 'table')).twinLinks).toEqual([]);
    const entIds = new Set((plain.json('entities').entities as any[]).map((e) => e.id));
    expect(both.filter((i) => entIds.has(i)).length, '「両方」に区分なしのエンティティが出ない').toBeGreaterThan(0);
    const issueIds = new Set(plain.issues().map((i: any) => i.id));
    const issuesInBoth = both.filter((i) => issueIds.has(i));
    for (const w of ['現実世界', 'デジタル世界'] as const) {
      await chooseView(page, c, w);
      const shownAll = await shownIds(page, 'table');
      const shown = shownAll.filter((i) => entIds.has(i));
      expect(shown, `「${w}」に区分なしのエンティティが出る`).toEqual([]);
      // A-57: 課題は世界区分の項目を持たないが「区分なし」ではなく現実世界
      if (w === '現実世界') for (const id of issuesInBoth) expect(shownAll, `「現実世界」に課題 ${id} が出ない（A-57）`).toContain(id);
      else expect(shownAll.filter((i) => issueIds.has(i)), '「デジタル世界」に課題が出る（A-57）').toEqual([]);
    }
  });
});
