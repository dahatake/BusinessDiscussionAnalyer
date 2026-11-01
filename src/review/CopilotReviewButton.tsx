// 画面上部の「Copilot で分析実行」ボタン（FR-278）。押すと、画面のすべてのコンポーネントが保持しているデータを Foundry に送って案を得る。
// 送信前の確認（送る情報の種類と対象の一覧。取り消しで 0 回）、進行中の表示（その間もほかを操作できる）、状態のメッセージ（role=status）を受け持つ。
import { useRef } from 'react';
import { tr, useT } from '../i18n';
import { Button, DialogActions, DialogBody, DialogContent, DialogTitle, Spinner, Text, makeStyles, tokens } from '@fluentui/react-components';
import { Dialog, DialogSurface } from '../components/Dialog';
import { useAi } from '../ai/useAi';
import { useConsent } from '../ai/useConsent';
import { fetchFoundryView } from '../ai/foundryClient';
import { useUsageStore } from '../ai/foundryUsage';
import { confirmViaUi, countPersons, gatePersonConfirm } from '../ai/personConfirm';
import { usePackStore } from '../store/pack';
import { getEntityGraph } from '../selection/hooks';
import { COMPONENT_SCREENS } from '../screens/registry';
import { answerSend, askSend, useReviewStore } from './reviewStore';
import { runReview } from './reviewFlow';
import { collectTargetsFor } from './reviewTargets';

const reviewScopeLabel = () => tr('画面の各コンポーネントのデータの Microsoft Foundry への送信（中継プロセス経由。Copilot の案を得るため）');

/** 対象のコンポーネント: 画面にあるもの（表示中の文字）と、まだ出ていない画面のもの（顧客パックの項目。A-70） */
export const collectTargets = () => collectTargetsFor(COMPONENT_SCREENS, getEntityGraph());

const useStyles = makeStyles({
  wrap: { display: 'inline-flex', alignItems: 'center', columnGap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  note: { color: tokens.colorNeutralForeground2, maxWidth: '360px' },
  list: { margin: 0, paddingInlineStart: tokens.spacingHorizontalXL },
});

export function CopilotReviewButton() {
  const t = useT();
  const s = useStyles();
  const { relayUrl, packId } = useAi();
  const { granted, record } = useConsent();
  const pack = usePackStore((st) => st.state);
  const run = useReviewStore((st) => st.run);
  const message = useReviewStore((st) => st.message);
  const notice = useReviewStore((st) => st.notice);
  const confirm = useReviewStore((st) => st.confirm);
  const busy = useRef(false);

  const start = async (): Promise<void> => {
    if (busy.current) return;
    busy.current = true;
    const st = useReviewStore.getState();
    try {
      const data = pack.status === 'ready' ? pack.pack.data : undefined;
      const usage = useUsageStore.getState();
      st.block(''); // 前回の案内を消す（確認の段階では「進行中」にしない）
      const out = await runReview({
        relayUrl, packId, consent: granted,
        includesPerson: !!data && countPersons(data) > 0,
        view: () => fetchFoundryView(relayUrl, packId),
        dismissConfirm: () => answerSend(false),
        usage: { check: () => usage.check(), count: (n, out) => usage.count(n, undefined, undefined, out) },
        confirmSend: async (targets) => { const ok = await askSend(targets); if (ok) useReviewStore.getState().start(); return ok; },
        confirmPerson: () => gatePersonConfirm({ destination: 'ai', scopeLabel: reviewScopeLabel(), data: data!, consent: record, confirm: confirmViaUi }),
      }, collectTargets());
      const store = useReviewStore.getState();
      if (out.kind === 'done') store.finish(out.targets, out.proposals, out.warning);
      else if (out.kind === 'cancelled') store.cancel();
      else if (out.kind === 'failed') store.fail(out.text);
      else store.block(out.text);
    } catch (e) {
      useReviewStore.getState().fail(e instanceof Error ? e.message : String(e));
    } finally {
      busy.current = false;
    }
  };

  return (
    <span className={s.wrap}>
      <Button appearance="primary" data-testid="copilot-run" disabledFocusable={run === 'running'} aria-busy={run === 'running'} onClick={() => void start()}>
        {t('Copilot で分析実行')}
      </Button>
      {/* 実行の開始・完了・失敗を支援技術へ伝える状態のメッセージ（WCAG 2.2 の 4.1.3）。常に存在させ、中身だけが変わる */}
      <span role="status" aria-live="polite" className={s.wrap}>
        {run === 'running' ? <span data-testid="copilot-running" className={s.wrap}><Spinner size="tiny" aria-hidden />{t('Copilot が分析中です…')}</span> : null}
        {run !== 'running' && notice ? <Text size={200} className={s.note} data-testid="copilot-notice">{notice}</Text> : null}
        {run !== 'running' && !notice && message ? <Text size={200} className={s.note}>{message}</Text> : null}
      </span>
      <Dialog open={!!confirm} modalType="alert" onOpenChange={(_, d) => { if (!d.open) answerSend(false); }}>
        <DialogSurface aria-label={t('Copilot への送信の確認')}>
          <DialogBody>
            <DialogTitle>{t('Copilot（Microsoft Foundry）へ送信します')}</DialogTitle>
            <DialogContent>
              <Text block>{t('送る情報の種類: 次のコンポーネントに表示されているデータ（文字）。中継プロセス経由で、設定した Microsoft Foundry へ送ります。呼び出しには費用がかかります。')}</Text>
              <Text block weight="semibold">{t('対象のコンポーネント（{n} 件）', { n: confirm?.targets.length ?? 0 })}</Text>
              <ul className={s.list} data-testid="copilot-targets">
                {(confirm?.targets ?? []).map((t) => <li key={t.id}>{t.label}</li>)}
              </ul>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => answerSend(false)}>{t('取り消し')}</Button>
              <Button appearance="primary" onClick={() => answerSend(true)}>{t('送信する')}</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </span>
  );
}
