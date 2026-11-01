// 「Copilot で分析実行」（FR-278）の 1 回分の流れと、Foundry 依頼の口（中継の POST /foundry/review）。
// 判定の順: 対象あり → 了承の記録（FR-181）→ 設定済み・実接続が有効（FR-275）→ 回数・予算の上限（FR-276）→ 送信前の確認（取り消しで 0 回）→ 種別「人」の確認（FR-219）→ 呼ぶ。
// どの失敗でも別の送信先へは切り替えない。呼んだ分（失敗も）は利用量に数える。
import { isLoopbackUrl } from '../ai/client';
import { estimateTokens, foundryReasonText, MAX_INPUT_TOKENS } from '../ai/foundryChat';
import { tr } from '../i18n';
import type { FoundryUnavailableReason, FoundryView } from '../ai/foundryClient';
import type { UsageGate } from '../ai/foundryUsage';

export interface ReviewTarget { id: string; label: string; data: string }

export type ReviewReply =
  | { ok: true; reviews: Array<{ id: string; proposal: string }>; usage?: { inputTokens: number; outputTokens: number } }
  | { ok: false; reason: FoundryUnavailableReason };

const PROMPT_OVERHEAD_CHARS = 2000;

/** 送る文字数の上限（PARAM-114 の入力の上限を、1 トークン 4 文字で換算）に収まるよう、コンポーネントごとのデータを切る */
export function fitTargets(targets: readonly ReviewTarget[], maxTokens: number = MAX_INPUT_TOKENS): ReviewTarget[] {
  if (targets.length === 0) return [];
  const per = Math.max(200, Math.floor((maxTokens * 4 - PROMPT_OVERHEAD_CHARS) / targets.length));
  return targets.map((t) => ({ ...t, data: t.data.length > per ? t.data.slice(0, per) : t.data }));
}

export function reviewTokens(targets: readonly ReviewTarget[]): number {
  return estimateTokens(targets.map((t) => `${t.id}\n${t.data}`).join('\n')) + PROMPT_OVERHEAD_CHARS / 4;
}

type F = typeof fetch;

export async function requestReview(
  relayUrl: string | undefined,
  req: { packId: string; consent: boolean; includesPerson?: boolean; personConfirmed?: boolean; components: Array<{ id: string; data: string }> },
  f: F = (u, i) => fetch(u, i),
): Promise<ReviewReply> {
  if (!relayUrl || !isLoopbackUrl(relayUrl)) return { ok: false, reason: 'relay' };
  try {
    const r = await f(`${relayUrl}/foundry/review`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req) });
    const j = (await r.json()) as { reviews?: unknown; mode?: string; reason?: FoundryUnavailableReason; usage?: { inputTokens?: unknown; outputTokens?: unknown } };
    if (j.mode === 'unavailable') return { ok: false, reason: j.reason ?? 'error' };
    if (!r.ok || !Array.isArray(j.reviews)) return { ok: false, reason: 'error' };
    const reviews: Array<{ id: string; proposal: string }> = [];
    for (const x of j.reviews as Array<{ id?: unknown; proposal?: unknown }>) {
      if (typeof x?.id === 'string' && typeof x.proposal === 'string') reviews.push({ id: x.id, proposal: x.proposal });
    }
    const u = j.usage;
    const usage = u && Number.isFinite(u.inputTokens) && Number.isFinite(u.outputTokens) && (u.inputTokens as number) >= 0 && (u.outputTokens as number) >= 0
      ? { inputTokens: u.inputTokens as number, outputTokens: u.outputTokens as number } : undefined;
    return { ok: true, reviews, ...(usage ? { usage } : {}) };
  } catch {
    return { ok: false, reason: 'relay' };
  }
}

export interface ReviewDeps {
  relayUrl: string | undefined;
  packId: string;
  consent: boolean;
  includesPerson: boolean;
  /** 設定済み・実接続の有効を中継から読む。届かないときは null */
  view: () => Promise<FoundryView | null>;
  usage: { check: () => UsageGate; count: (tokensIn: number, tokensOut?: number) => void };
  /** 送信前の確認（送る情報の種類と対象の一覧を示す）。取り消しで false */
  confirmSend: (targets: readonly ReviewTarget[]) => Promise<boolean>;
  /** 実行できないと分かったとき、出していた確認を答えなしで閉じる */
  dismissConfirm?: () => void;
  /** 種別「人」の確認（FR-219）。含まないときは呼ばれない */
  confirmPerson: () => Promise<{ allowed: boolean; reason?: string }>;
  request?: typeof requestReview;
}

export type ReviewOutcome =
  | { kind: 'done'; targets: string[]; proposals: Record<string, string>; warning?: string }
  | { kind: 'blocked'; text: string }
  | { kind: 'cancelled' }
  | { kind: 'failed'; reason: FoundryUnavailableReason; text: string };

export const notConfiguredText = (): string => tr('Microsoft Foundry が未設定のため、送信しませんでした。設定画面で、接続（エンドポイント・デプロイ名・API キー）を設定してください。');

export async function runReview(deps: ReviewDeps, all: readonly ReviewTarget[]): Promise<ReviewOutcome> {
  // データを持たないコンポーネントは送らない（「案なし」になる）
  const targets = fitTargets(all.filter((t) => t.data.trim() !== ''));
  if (targets.length === 0) return { kind: 'blocked', text: tr('レビューの対象になるデータを持つコンポーネントがありません。') };
  if (!deps.consent) return { kind: 'blocked', text: foundryReasonText('consent') };
  // 押下の直後に確認を同期的に出す（中継の設定の取得はそのあと。操作の前には要求しない）。実行できない状態なら確認を閉じて案内を出す
  const pending = deps.confirmSend(targets);
  const block = (text: string): ReviewOutcome => { deps.dismissConfirm?.(); return { kind: 'blocked', text }; };
  const v = await deps.view();
  if (!v) return block(foundryReasonText('relay'));
  if (!v.configured) return block(notConfiguredText());
  if (!v.enabled) return block(`${foundryReasonText('disabled')}${tr('設定画面で「実接続を有効にする」をオンにしてください。')}`);
  const gate = deps.usage.check();
  if (!gate.allowed) return block(gate.reason);
  if (!(await pending)) return { kind: 'cancelled' };
  if (deps.includesPerson) {
    const g = await deps.confirmPerson();
    if (!g.allowed) return { kind: 'blocked', text: g.reason ?? foundryReasonText('person-unconfirmed') };
  }
  const r = await (deps.request ?? requestReview)(deps.relayUrl, {
    packId: deps.packId, consent: deps.consent,
    ...(deps.includesPerson ? { includesPerson: true, personConfirmed: true } : {}),
    components: targets.map((t) => ({ id: t.id, data: t.data })),
  });
  // 応答が利用量を示すときはそれを数える（NFR-COST-001）。示さない・失敗のときは送った量の見積り
  if (r.ok && r.usage) deps.usage.count(r.usage.inputTokens, r.usage.outputTokens);
  else deps.usage.count(reviewTokens(targets));
  if (!r.ok) return { kind: 'failed', reason: r.reason, text: foundryReasonText(r.reason) };
  // 結果は、依頼した id のコンポーネントの案としてだけ使う（AC-717）
  const sent = new Set(targets.map((t) => t.id));
  const proposals: Record<string, string> = {};
  for (const x of r.reviews) if (sent.has(x.id) && x.proposal.trim() !== '') proposals[x.id] = x.proposal;
  return { kind: 'done', targets: all.map((t) => t.id), proposals, ...(gate.warning ? { warning: gate.warning } : {}) };
}
