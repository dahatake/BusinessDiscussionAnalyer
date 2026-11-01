// 開いているコンポーネントの一覧（FR-295）の状態の求め方。React に依存しない純粋な計算。
// 一覧の状態: front（前面）／visible（表示中）／minimized（最小化）／closed（閉じた＝非表示にした）。
// FR-296: 既定のレイアウトに収まらない・領域が足りなくなって外したコンポーネントは、閉じずに最小化として一覧に残す。
import { keysOf, type Layout } from './layoutModel';

export type WindowState = 'front' | 'visible' | 'minimized' | 'closed';
export const WINDOW_STATE_LABEL: Readonly<Record<WindowState, string>> = { front: '前面', visible: '表示中', minimized: '最小化', closed: '閉じた' };

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

/** 表示中（前面・表示中）のコンポーネントの数 */
export function shownCount(states: Readonly<Record<string, WindowState>>): number {
  return Object.values(states).filter((s) => s === 'front' || s === 'visible').length;
}
