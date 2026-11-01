// 開いているコンポーネントの一覧（FR-295）の状態の求め方。React に依存しない純粋な計算。
// 一覧の状態: front（前面）／visible（表示中）／minimized（最小化）／closed（閉じた＝非表示にした）。
// FR-296: 既定のレイアウトに収まらない・領域が足りなくなって外したコンポーネントは、閉じずに最小化として一覧に残す。
import { keysOf, type Layout } from './layoutModel';

export type WindowState = 'front' | 'visible' | 'minimized' | 'closed';
export const WINDOW_STATE_LABEL: Readonly<Record<WindowState, string>> = { front: '前面', visible: '表示中', minimized: '最小化', closed: '閉じた' };

/** 没入表示（FR-297）で、最大化したコンポーネントの背面を暗くする割合（%）。PARAM-137 */
export const IMMERSIVE_DIM_PERCENT = 60;

export interface WindowStateInput {
  /** 一覧に載せるコンポーネントのキー（登録済みのもの）。並びはそのまま */
  keys: readonly string[];
  /** 表示するレイアウト */
  layout: Layout;
  /** 見出しだけに畳んだもの */
  minimized: ReadonlySet<string>;
  /** 利用者が閉じた（非表示にした）もの */
  closed: ReadonlySet<string>;
  /** 最後に使った順の目印（大きいほど最近） */
  usedAt: Readonly<Record<string, number>>;
}

/** コンポーネントごとの状態。前面は、表示中のうち最も最近使ったもの 1 つだけ（使った記録がなければ、並びの先頭の表示中） */
export function windowStates(input: WindowStateInput): Record<string, WindowState> {
  const inTree = new Set(keysOf(input.layout));
  const out: Record<string, WindowState> = {};
  const shown: string[] = [];
  for (const k of input.keys) {
    if (inTree.has(k)) {
      if (input.minimized.has(k)) out[k] = 'minimized';
      else { out[k] = 'visible'; shown.push(k); }
    } else {
      out[k] = input.closed.has(k) ? 'closed' : 'minimized';
    }
  }
  let front: string | undefined;
  for (const k of shown) if (front === undefined || (input.usedAt[k] ?? 0) > (input.usedAt[front] ?? 0)) front = k;
  if (front !== undefined) out[front] = 'front';
  return out;
}

/** 切替（Ctrl+Alt+PageDown／PageUp。FR-295 AC-798）の候補。閉じたものを除き、前面に近い順（前面が先頭） */
export function switchOrder(states: Readonly<Record<string, WindowState>>, usedAt: Readonly<Record<string, number>>): string[] {
  const keys = Object.keys(states).filter((k) => states[k] !== 'closed');
  const rank = (k: string) => (states[k] === 'front' ? Infinity : usedAt[k] ?? 0);
  return keys.map((k, i) => ({ k, i })).sort((a, b) => (rank(b.k) - rank(a.k)) || a.i - b.i).map((x) => x.k);
}

/** 切替の次の位置（PageDown＝奥へ進む、PageUp＝手前へ戻る。端で循環する） */
export function nextSwitchIndex(index: number, count: number, dir: 'down' | 'up'): number {
  if (count <= 0) return 0;
  return (index + (dir === 'down' ? 1 : -1) + count) % count;
}

/** 切替のキー（Ctrl+Alt+PageDown／PageUp。macOS は ⌃⌥）。ほかのキー（Ctrl+Alt+方向・Enter）とは重ならない */
export function switchKey(e: { key: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }): 'down' | 'up' | null {
  if (!e.ctrlKey || !e.altKey || e.shiftKey || e.metaKey) return null;
  return e.key === 'PageDown' ? 'down' : e.key === 'PageUp' ? 'up' : null;
}

/** 表示中（前面・表示中）のコンポーネントの数 */
export function shownCount(states: Readonly<Record<string, WindowState>>): number {
  return Object.values(states).filter((s) => s === 'front' || s === 'visible').length;
}
