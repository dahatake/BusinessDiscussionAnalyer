// タスク文脈（Task Context）の取り込み・復元と、タスクワークスペースの切替・別のウィンドウへの移動（FR-298 AC-808・AC-809）。
// タスク文脈 = 開いているコンポーネントの配置・選択・絞り込み・入力中の内容・ズームなど、作業の文脈。タスクワークスペースごとに独立に保存・復元する。
import { useLayout } from '../store/layout';
import { useRetainedStore } from '../store/retained';
import { useSelectionStore } from '../store/selection';
import { STORAGE_KEY, activeWorkspace, useTaskWorkspaces, type TaskContext } from '../store/taskWorkspaces';
import { WORKSPACE_PARAM } from '../store/workspaceEntry';
import { FLIP_PREPARE_EVENT } from './spatialMotion';

/** 切替の前に、いまの位置・大きさを作業領域に記録させる（切替の後に、そこから連続して動かす。FR-300） */
function prepareFlip(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(FLIP_PREPARE_EVENT));
}

/** ペルソナごとに持つ配置の項目（store/layout.ts）。タスク文脈として、利用中のペルソナの分を持つ */
const PER_PERSONA = ['layouts', 'floats', 'pinned', 'minimized', 'views', 'screenView', 'manual', 'moved', 'userLaid', 'tiers', 'autoOff'] as const;

let applying = false;

function jsonSafe(v: unknown): boolean {
  if (v === undefined || typeof v === 'function' || typeof v === 'symbol' || v instanceof Set || v instanceof Map) return false;
  try { return JSON.stringify(v) !== undefined; } catch { return false; }
}
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** いまの状態をタスク文脈として取り込む */
export function captureContext(): TaskContext {
  const L = useLayout.getState() as unknown as Record<string, unknown> & { persona: string };
  const layout: Record<string, unknown> = {};
  for (const k of PER_PERSONA) {
    const v = (L[k] as Record<string, unknown> | undefined)?.[L.persona];
    // 最小化なし（空の配列）は「項目なし」と同じ意味。最小化して戻しただけで保存データを変えない（FR-279 AC-719）
    if (k === 'minimized' && Array.isArray(v) && v.length === 0) continue;
    if (v !== undefined && jsonSafe(v)) layout[k] = clone(v);
  }
  const retained: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(useRetainedStore.getState().values)) if (jsonSafe(v)) retained[k] = clone(v);
  return { persona: L.persona, retained, selection: [...useSelectionStore.getState().selectedIds], layout };
}

/** タスク文脈を復元する。null は、まっさらな文脈（絞り込み・選択なし。配置は既定。ペルソナは変えない） */
export function applyContext(ctx: TaskContext | null, opts: { selection?: boolean } = {}): void {
  applying = true;
  try {
    useRetainedStore.setState({ values: ctx ? clone(ctx.retained) : {} });
    const L = useLayout.getState();
    if (ctx && ctx.persona !== L.persona) L.setPersona(ctx.persona as never);
    const persona = useLayout.getState().persona;
    useLayout.setState((s) => {
      const next: Record<string, unknown> = {};
      for (const k of PER_PERSONA) {
        const cur = { ...((s as unknown as Record<string, Record<string, unknown> | undefined>)[k] ?? {}) };
        if (ctx && k in ctx.layout) cur[persona] = clone(ctx.layout[k]); else delete cur[persona];
        next[k] = cur;
      }
      return next as never;
    });
    if (opts.selection !== false) useSelectionStore.getState().setSelection(ctx?.selection ?? [], { history: 'replace', origin: 'task-context' });
  } finally {
    applying = false;
  }
}

/** 利用中のタスクワークスペースへ、いまの文脈を保存する（変わっていなければ書かない） */
export function flushContext(): void {
  if (applying) return;
  const st = useTaskWorkspaces.getState();
  const w = activeWorkspace(st);
  const ctx = captureContext();
  if (w.context && JSON.stringify(w.context) === JSON.stringify(ctx)) return;
  st.saveContext(w.id, ctx);
}

/** 別のタスクワークスペースへ切り替える。切替前の文脈を保存し、切替先の文脈を復元する */
export function switchWorkspace(id: string): void {
  const st = useTaskWorkspaces.getState();
  if (id === st.active || !st.items.some((w) => w.id === id)) return;
  flushContext();
  prepareFlip();
  st.activate(id);
  applyContext(activeWorkspace(useTaskWorkspaces.getState()).context);
}

/** まっさらなタスクワークスペースを足して、そこへ切り替える */
export function addWorkspace(): string {
  flushContext();
  prepareFlip();
  const st = useTaskWorkspaces.getState();
  const id = st.add();
  st.activate(id);
  applyContext(null);
  return id;
}

/** タスクワークスペースを別のウィンドウ（別のディスプレイに置けるウィンドウ）へ移す。ゾーン構成・ロール・割合・文脈は保存を介してそのまま届く */
export function openInNewWindow(): Window | null {
  flushContext();
  const url = new URL(window.location.href);
  url.searchParams.set(WORKSPACE_PARAM, useTaskWorkspaces.getState().active);
  return window.open(url.toString(), '_blank');
}

let booted = false;
/** 起動時に 1 回: 見るタスクワークスペースの文脈を復元し、以後の変更を保存する */
export function bootTaskWorkspaces(): void {
  if (booted || typeof window === 'undefined') return;
  booted = true;
  const w = activeWorkspace(useTaskWorkspaces.getState());
  try { window.sessionStorage.setItem('eabk.workspace.active', w.id); } catch { /* 無視 */ }
  // 選択は、URL に指定があればそれを優先する（別のウィンドウへ移したとき、選択が URL で届く）
  if (w.context) applyContext(w.context, { selection: useSelectionStore.getState().selectedIds.length === 0 });
  let timer: number | null = null;
  const later = (): void => {
    if (applying) return;
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(() => { timer = null; flushContext(); }, 250);
  };
  useRetainedStore.subscribe(later);
  useSelectionStore.subscribe(later);
  // 配置の保存データ（edb.layout）は変更と同時に書かれる。文脈の中の配置も同時に書き、閲覧・操作の結果が遅れて別の保存データに現れないようにする（FR-279 AC-718・AC-719）。
  // 最後に使った順（usedAt）・最小化で隠した画面（parked）など、保存しない状態の変化では書かない
  useLayout.subscribe((s, prev) => {
    if (applying) return;
    const a = s as unknown as Record<string, unknown>;
    const b = prev as unknown as Record<string, unknown>;
    if (s.persona !== prev.persona || PER_PERSONA.some((k) => a[k] !== b[k])) flushContext();
  });
  window.addEventListener('pagehide', () => flushContext());
  // 別のウィンドウでの変更（ロール・割合・モード・文脈）をこのウィンドウへ反映する
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY) return;
    const before = JSON.stringify(activeWorkspace(useTaskWorkspaces.getState()).context);
    void Promise.resolve(useTaskWorkspaces.persist.rehydrate()).then(() => {
      const after = activeWorkspace(useTaskWorkspaces.getState());
      if (JSON.stringify(after.context) !== before) applyContext(after.context);
    });
  });
}
