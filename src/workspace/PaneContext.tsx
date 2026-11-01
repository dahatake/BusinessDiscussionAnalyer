// コンポーネント（パネル）がワークスペースの中にいるときの文脈と、見出しのメニュー（FR-013/FR-109）。
import { createContext, useContext, useEffect, useState } from 'react';
import { Button, Menu, MenuDivider, MenuItem, MenuItemRadio, MenuList, MenuPopover, MenuTrigger, Tooltip, makeStyles, tokens } from '@fluentui/react-components';
import { MoreHorizontal20Regular } from '@fluentui/react-icons';
import type { Move } from './layoutModel';
import { TIERS, TIER_LABEL, type Role, type Tier } from './tiers';
import { SNAP_LABEL, type SnapKind } from './snap';
import { PIN_MOVE_REASON, PIN_RESIZE_REASON, PIN_TABS_REASON, paneAction, type PaneActionId } from './paneActions';
import { ComponentViewButton, ComponentViewSubmenu } from '../view/ViewMenu';
import { ZONE_META, ZONE_NAMES, type ZoneName } from './zones';
import { chordLabel } from './os';
import { useOs } from '../store/osConvention';
import { useT } from '../i18n';

const useActionStyles = makeStyles({
  actions: { display: 'flex', alignItems: 'center', columnGap: tokens.spacingHorizontalXXS, flexShrink: 0 },
  group: { display: 'contents' },
  hint: { fontSize: tokens.fontSizeBase200, lineHeight: tokens.lineHeightBase200 },
  // macOS の慣習: 左端にウィンドウ操作、右端にそのほかの操作（FR-299）
  macBar: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', columnGap: tokens.spacingHorizontalS, width: '100%' },
  // 当たり判定は 24 CSS px 以上（WCAG 2.2 の 2.5.8。PARAM-040）
  icon: { minWidth: '24px', minHeight: '24px' },
});

export interface PaneInfo {
  key: string;
  maximized: boolean;
  /** 前面のコンポーネントか（FR-295 の一覧と同じ。FR-297 AC-803: 見出しの強調・強い影） */
  front?: boolean;
  /** 最小化しているか（見出しだけを残して畳む。FR-151） */
  minimized: boolean;
  toggleMinimize: () => void;
  /** 画面に見えているか（タブのまとまりで前面でないタブは false。描画は保つが隠している） */
  visible: boolean;
  /** 同じタブのまとまりに入っているか */
  inTabs: boolean;
  /** タブにまとめられる相手（表示中の別のコンポーネント） */
  peers: ReadonlyArray<{ key: string; label: string }>;
  toggleMaximize: () => void;
  /** ヘッダーのダブルクリックなどで拡大表示しているか（FR-174。最大化とは別） */
  expanded: boolean;
  toggleExpand: () => void;
  /** 自由に動かせる配置（浮動）にしているか（FR-173） */
  floating: boolean;
  /** 浮動にする／分割の配置へ戻す（ドラッグなしの手段。FR-173 AC-349） */
  toggleFloat: () => void;
  /** 手前に出す順の重なり（z-index）。操作したことのあるコンポーネントだけ持つ（FR-173） */
  z?: number;
  restore: () => void;
  hide: () => void;
  move: (dir: Move) => void;
  toggleDirection: () => void;
  /** 画面端のスナップの候補から配置する（ドラッグなしの手段。FR-152 AC-266） */
  snapTo: (kind: SnapKind) => void;
  /** いま成り立つ候補（狭い画面では縦積み・タブ化だけ） */
  snapKinds: readonly SnapKind[];
  mergeInto: (target: string) => void;
  untab: () => void;
  /** ピン止めしているか（FR-215） */
  pinned: boolean;
  /** 情報の階層（主役→補助→詳細）と、その理由・役割・グループ（FR-244）。役割のないものは補助 */
  tier: Tier;
  tierReason: string;
  /** 利用者が階層を変えたか */
  tierOverridden: boolean;
  role?: Role;
  group?: string;
  /** 階層を変える（null で既定に戻す）。レイアウトとして保存される */
  setTier: (tier: Tier | null) => void;
  /** 自動配置が働いているか（FR-243）。止めていると、追加しても既存の配置は動かない */
  autoOn: boolean;
  /** 取り消せる自動配置があるか */
  canUndoAuto: boolean;
  autoRun: () => void;
  autoStop: () => void;
  /** 自動配置を取り消す（FR-243） */
  autoUndo: () => void;
  /** いまのステップから見た関連・工程の順・重要度（FR-228。data-step-* に出す） */
  step?: { relevant: boolean; rank: number; importance: 'high' | 'normal' };
  /** ピン止めする／外す（FR-215） */
  togglePin: () => void;
  /** 見出しのポインター操作で移動を始める（FR-142）。キーボードの代わりはメニューと Alt+Shift+矢印キー（NFR-A11Y-004） */
  startDrag: (e: { button: number; clientX: number; clientY: number; pointerId?: number }) => void;
  /** 縦・横を独立に大きさを変える（キーボード・コマンド。FR-224 AC-522）。dir は +1 で大きく、-1 で小さく */
  resizeBy: (axis: 'w' | 'h', dir: 1 | -1) => void;
  /** 縁・角のドラッグで大きさを変え始める（FR-224 AC-521） */
  startResize: (edge: 'e' | 's' | 'se', e: { button: number; clientX: number; clientY: number }) => void;
  /** ロール（割り当て先のゾーン。FR-298 AC-805）。割り当てていなければ未設定 */
  zone?: ZoneName;
  /** ロールへ割り当てる（座標の指定なし）。null で外す */
  assignZone?: (zone: ZoneName | null) => void;
  /** ゾーン間の移動（FR-299 Move）。dir は +1 で次、-1 で前のゾーン。ゾーンの選択とフォーカスは保つ */
  moveZone?: (dir: 1 | -1) => void;
  /** いるゾーンへ吸着する（FR-299 Snap） */
  snapZone?: () => void;
  /** 同じグループのコンポーネントを、同じゾーンへまとめる（FR-299 Group） */
  groupZone?: () => void;
  /** 最後にゾーンの操作（Move・Snap・Group）をしたコンポーネントか（ゾーンの選択を保つ印） */
  zoneSelected?: boolean;
}

export const PaneContext = createContext<PaneInfo | null>(null);
export const usePane = (): PaneInfo | null => useContext(PaneContext);

export function ComponentMenu({ pane, title, open, onOpenChange, onShowTier }: {
  pane: PaneInfo; title: string;
  /** 見出しの右クリック・Shift+F10 で開くため、開閉を呼び出し側から制御できる（FR-244） */
  open?: boolean; onOpenChange?: (open: boolean) => void;
  /** 「情報の階層」を選んだとき（階層と理由を見出しの下に示す） */
  onShowTier?: () => void;
}) {
  const t = useT();
  const os = useOs();
  const hs = useActionStyles();
  // キーの表記は、文字の段（12px/16px）に合わせた 1 つの span で出す（NFR-UX-015）
  const hint = (text: string) => <span className={hs.hint}>{text}</span>;
  const pinNote = pane.pinned ? t(PIN_MOVE_REASON) : undefined;
  const resizeNote = pane.pinned ? t(PIN_RESIZE_REASON) : undefined;
  return (
    <Menu positioning={{ autoSize: 'height', overflowBoundary: 'window', flipBoundary: 'window' } as never} {...(open !== undefined ? { open, onOpenChange: (_: unknown, d: { open: boolean }) => onOpenChange?.(d.open) } : {})}>
      <MenuTrigger disableButtonEnhancement>
        <Button
          data-testid="component-menu"
          appearance="subtle"
          size="small"
          icon={<MoreHorizontal20Regular aria-hidden />}
          aria-label={t('その他の操作（{title}のメニュー）', { title })}
        />
      </MenuTrigger>
      <MenuPopover>
        <MenuList checkedValues={{ tier: [pane.tier] }} onCheckedValueChange={(_, d) => { if (d.name === 'tier') { const t = d.checkedItems[0] as Tier | undefined; if (t && (TIERS as readonly string[]).includes(t)) pane.setTier(t); } }}>
          <MenuItem onClick={pane.togglePin}>{paneAction('pin', pane.pinned).label}</MenuItem>
          <MenuItem onClick={pane.toggleMinimize}>{paneAction('minimize', pane.minimized).label}</MenuItem>
          {/* ピン止め中は動かす操作を無効にし、理由を示す（FR-216 AC-496） */}
          <MenuItem disabled={pane.pinned} secondaryContent={pinNote} onClick={() => pane.move('up')}>{t('上へ移動')}</MenuItem>
          <MenuItem disabled={pane.pinned} secondaryContent={pinNote} onClick={() => pane.move('down')}>{t('下へ移動')}</MenuItem>
          <MenuItem disabled={pane.pinned} secondaryContent={pinNote} onClick={() => pane.move('left')}>{t('左へ移動')}</MenuItem>
          <MenuItem disabled={pane.pinned} secondaryContent={pinNote} onClick={() => pane.move('right')}>{t('右へ移動')}</MenuItem>
          <MenuItem disabled={pane.pinned} secondaryContent={pinNote} onClick={pane.toggleDirection}>{t('並べる方向を変える（横/縦）')}</MenuItem>
          {pane.pinned ? <MenuItem disabled secondaryContent={t(PIN_MOVE_REASON)}>{t('画面に配置')}</MenuItem> : (
          <Menu>
            <MenuTrigger disableButtonEnhancement>
              <MenuItem>{t('画面に配置')}</MenuItem>
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                {pane.snapKinds.filter((k) => k !== 'tabs' || pane.peers.length > 0).map((k) => (
                  <MenuItem key={k} onClick={() => pane.snapTo(k)}>{t(SNAP_LABEL[k])}</MenuItem>
                ))}
              </MenuList>
            </MenuPopover>
          </Menu>
          )}
          <MenuItem disabled={pane.pinned} secondaryContent={resizeNote} onClick={() => pane.resizeBy('w', 1)}>{t('幅を広げる')}</MenuItem>
          <MenuItem disabled={pane.pinned} secondaryContent={resizeNote} onClick={() => pane.resizeBy('w', -1)}>{t('幅を狭める')}</MenuItem>
          <MenuItem disabled={pane.pinned} secondaryContent={resizeNote} onClick={() => pane.resizeBy('h', 1)}>{t('高さを広げる')}</MenuItem>
          <MenuItem disabled={pane.pinned} secondaryContent={resizeNote} onClick={() => pane.resizeBy('h', -1)}>{t('高さを狭める')}</MenuItem>
          <MenuItem onClick={pane.toggleMaximize}>{paneAction('maximize', pane.maximized).label}</MenuItem>
          <MenuItem secondaryContent={hint(chordLabel(os, 'expand'))} onClick={pane.toggleExpand}>{pane.expanded ? t('拡大表示を戻す') : t('拡大表示（75%）')}</MenuItem>
          {/* ゾーンの操作（FR-299）。キーは OS の慣習の表記（Windows は Ctrl+Alt+→、macOS は ⌃⌥→） */}
          {pane.moveZone ? <MenuItem secondaryContent={hint(chordLabel(os, 'snap'))} onClick={() => pane.snapZone?.()}>{t('ゾーンへスナップ')}</MenuItem> : null}
          {pane.moveZone ? <MenuItem secondaryContent={hint(chordLabel(os, 'group'))} onClick={() => pane.groupZone?.()}>{t('同じグループをこのゾーンへまとめる')}</MenuItem> : null}
          {pane.moveZone ? <MenuItem secondaryContent={hint(chordLabel(os, 'move'))} onClick={() => pane.moveZone?.(1)}>{t('次のゾーンへ移動')}</MenuItem> : null}
          <MenuItem disabled={pane.pinned} secondaryContent={pinNote} onClick={pane.toggleFloat}>{pane.floating ? t('分割の配置に戻す') : t('自由に動かせる配置にする')}</MenuItem>
          {pane.pinned ? <MenuItem disabled secondaryContent={t(PIN_TABS_REASON)}>{paneAction('tabs').label}</MenuItem> : pane.peers.length > 0 ? (
            <Menu>
              <MenuTrigger disableButtonEnhancement>
                <MenuItem>{t('タブにまとめる')}</MenuItem>
              </MenuTrigger>
              <MenuPopover>
                <MenuList>
                  {pane.peers.map((p) => (
                    <MenuItem key={p.key} onClick={() => pane.mergeInto(p.key)}>{p.label}</MenuItem>
                  ))}
                </MenuList>
              </MenuPopover>
            </Menu>
          ) : null}
          {pane.inTabs && !pane.pinned ? <MenuItem onClick={pane.untab}>{paneAction('untab').label}</MenuItem> : null}
          <MenuItem onClick={pane.hide}>{paneAction('hide').label}</MenuItem>
          {/* 情報の階層（主役→補助→詳細）の確認と変更（FR-244）。階層の違いは名前（文字）で示す */}
          <MenuDivider />
          <MenuItem onClick={onShowTier}>{t('情報の階層')}</MenuItem>
          {TIERS.map((tier) => (
            <MenuItemRadio key={tier} name="tier" value={tier}>{t(TIER_LABEL[tier])}</MenuItemRadio>
          ))}
          {pane.tierOverridden ? <MenuItem onClick={() => pane.setTier(null)}>{t('階層を既定に戻す')}</MenuItem> : null}
          {/* 自動配置（FR-243）。ドラッグなしで、実行・停止・取消ができる（NFR-A11Y-004） */}
          <MenuDivider />
          <MenuItem onClick={pane.autoRun}>{t('自動配置を実行')}</MenuItem>
          <MenuItem disabled={!pane.autoOn} onClick={pane.autoStop}>{t('自動配置を停止')}</MenuItem>
          <MenuItem disabled={!pane.canUndoAuto} onClick={pane.autoUndo}>{t('自動配置を取り消す')}</MenuItem>
          <MenuDivider />
          {/* ビューの切替（FR-217・FR-218）。見出しのボタンが隠れるときも、ここから操作できる */}
          <ComponentViewSubmenu paneKey={pane.key} />
        </MenuList>
      </MenuPopover>
    </Menu>
  );
}


/**
 * 見出しの操作のボタン。名前・アイコンは操作の定義（paneActions）から取る（NFR-UX-018 AC-482）。
 * `pressed` を渡すと切替のボタンになり、押下の状態（aria-pressed）を持つ。アイコンの種類（Regular／Filled）は data-icon-variant で示す。
 */
function ActionButton({ action, on = false, pressed, onClick, disabledReason }: { action: PaneActionId; on?: boolean; pressed?: boolean; onClick?: () => void; disabledReason?: string }) {
  const s = useActionStyles();
  const t = useT();
  const v = paneAction(action, on);
  const Icon = v.Icon;
  return (
    <Tooltip content={disabledReason ? t('{label}（{reason}）', { label: v.label, reason: t(disabledReason) }) : v.label} relationship="label" withArrow>
      <Button
        className={s.icon}
        appearance="subtle"
        size="small"
        icon={<Icon aria-hidden />}
        data-action={action}
        data-icon-variant={v.variant}
        aria-pressed={pressed}
        disabledFocusable={!!disabledReason}
        onClick={disabledReason ? undefined : onClick}
      />
    </Tooltip>
  );
}

/**
 * コンポーネントを、座標を指定せずにゾーンのロールへ割り当てる（FR-298 AC-805）。割り当て先のゾーンに配置される。
 * ポインターを重ねている間（フォーカス中は除く）だけ見出しに足す。常設のボタンは PARAM-073 個までのため。
 * キーボードからは、コマンドパレットの「ロールへ割り当て」（paneCommands）で同じ操作ができる。
 */
function AssignZoneButton({ pane, onEngage }: { pane: PaneInfo; onEngage: () => void }) {
  const s = useActionStyles();
  const t = useT();
  const assign = pane.assignZone;
  if (!assign) return null;
  const v = paneAction('zone');
  const Icon = v.Icon;
  return (
    <Menu checkedValues={{ zone: pane.zone ? [pane.zone] : [] }} onCheckedValueChange={(_, d) => { const z = d.checkedItems[0]; if (d.name === 'zone' && z) assign(z as ZoneName); }}>
      <Tooltip content={v.label} relationship="label" withArrow>
        <MenuTrigger disableButtonEnhancement>
          <Button className={s.icon} appearance="subtle" size="small" data-action="zone" data-icon-variant={v.variant} icon={<Icon aria-hidden />} onPointerDown={onEngage} onKeyDown={onEngage} />
        </MenuTrigger>
      </Tooltip>
      <MenuPopover>
        <MenuList>
          {ZONE_NAMES.map((n) => <MenuItemRadio key={n} name="zone" value={n}>{`${ZONE_META[n].label}（${t(ZONE_META[n].role)}）`}</MenuItemRadio>)}
          {pane.zone ? <MenuItem onClick={() => assign(null)}>{t('ロールの割り当てを外す')}</MenuItem> : null}
        </MenuList>
      </MenuPopover>
    </Menu>
  );
}

/**
 * 見出しの操作アイコン（FR-150）。フォーカス中（または最小化中）のコンポーネントだけ、主要な操作をメニューを開かずに押せる形で並べる。
 * 狭いとき（narrow）は、アイコンを出さず「…」メニューに任せる（操作は欠けない。FR-150 AC-259）。
 */
export function ComponentActions({ pane, title, active, narrow, hover = false, focused = false, menu }: { pane: PaneInfo; title: string; active: boolean; narrow: boolean; /** ポインターを重ねている（ロールへ割り当てを足す。フォーカス中は足さない） */ hover?: boolean; focused?: boolean; menu?: { open: boolean; onOpenChange: (open: boolean) => void; onShowTier: () => void } }) {
  // ロールへ割り当てを押した直後は、フォーカスが移っても消さない（メニューを開いている間は残す）
  const [engaged, setEngaged] = useState(false);
  useEffect(() => { if (!hover) setEngaged(false); }, [hover]);
  const showAssign = hover && (!focused || engaged) && !pane.minimized;
  const s = useActionStyles();
  useT(); // 言語の切替で、操作の名前（paneAction）を描き直す
  // アイコンは常に描き、フォーカスのないときは隠す。隠している間は押せず、Tab でも止まらない。
  // 広いときは visibility: hidden で場所を残す（フォーカスが入った瞬間に見出しの折り返しが変わり、押そうとしたボタンが動いてクリックが外れるのを防ぐ）。狭いときは display: none。
  // フォーカスが入ると現れ、操作できる（FR-150）。最小化中は復元のアイコンだけを、フォーカスに関わらず出す
  const shown = (active && !narrow) || pane.minimized;
  // 狭いときも、最小化・最大化（元に戻す）は見出しに残す（FR-222）。ピン止め・タブ化・非表示・ビューは「…」メニューに畳む（NFR-UX-018）
  const coreStyle = shown || narrow ? undefined : { visibility: 'hidden' as const };
  const extraStyle = shown && !narrow ? undefined : narrow ? { display: 'none' } : { visibility: 'hidden' as const };
  const TabsIcon = paneAction('tabs').Icon;
  const mac = useOs() === 'mac';
  // 幅 0 の枠に絞り、ボタンは枠の左へはみ出して重ねる。出入りで列の位置も、コンポーネントの最小の幅（ピン止めの左右並び・比率。FR-216）も変わらない（E2E-202・E2E-312）
  const assignEl = pane.assignZone && !pane.minimized ? (
    <span data-testid="assign-zone-slot" style={{ position: 'relative', display: 'inline-block', width: 0, height: '24px', flexShrink: 0, marginRight: `calc(-1 * ${tokens.spacingHorizontalXXS})` }}>
      {showAssign ? <span style={{ position: 'absolute', right: 0, top: 0, zIndex: 1 }}><AssignZoneButton pane={pane} onEngage={() => setEngaged(true)} /></span> : null}
    </span>
  ) : null;
  const pinEl = (
    <span className={s.group} style={extraStyle}>
      {/* ピン止めの切替（FR-215）: 現在の状態に応じたアイコンを 1 つだけ出す。固定なし＝「ピン止めする」Regular、固定中＝「ピン止めを外す」Filled */}
      <ActionButton action="pin" on={pane.pinned} pressed={pane.pinned} onClick={pane.togglePin} />
    </span>
  );
  const coreEl = (
    <span className={s.group} style={coreStyle}>
      {pane.minimized ? (
        // 最小化中は、フォーカスの有無に関わらず復元できる（見出しの操作で元の位置・大きさに戻る。FR-151）
        <ActionButton action="minimize" on onClick={pane.toggleMinimize} />
      ) : null}
      {!pane.minimized ? (
        <>
          <ActionButton action="maximize" on={pane.maximized} onClick={pane.toggleMaximize} />
          <ActionButton action="minimize" onClick={pane.toggleMinimize} />
        </>
      ) : null}
    </span>
  );
  const tabsEl = pane.minimized ? null : pane.pinned ? (
    // ピン止め中はタブにまとめない（FR-216 AC-505）。理由をツールチップと名前で示す
    <ActionButton action="tabs" disabledReason={PIN_TABS_REASON} />
  ) : pane.inTabs ? (
    <ActionButton action="untab" onClick={pane.untab} />
  ) : pane.peers.length > 0 ? (
    <Menu>
      <Tooltip content={paneAction('tabs').label} relationship="label" withArrow>
        <MenuTrigger disableButtonEnhancement>
          <Button className={s.icon} appearance="subtle" size="small" data-action="tabs" data-icon-variant="regular" icon={<TabsIcon aria-hidden />} />
        </MenuTrigger>
      </Tooltip>
      <MenuPopover>
        <MenuList>
          {pane.peers.map((p) => (
            <MenuItem key={p.key} onClick={() => pane.mergeInto(p.key)}>{p.label}</MenuItem>
          ))}
        </MenuList>
      </MenuPopover>
    </Menu>
  ) : null;
  const hideEl = pane.minimized ? null : <ActionButton action="hide" onClick={pane.hide} />;
  // 2D/3D と世界の表示の切替を 1 つにまとめた「ビュー」（FR-217・FR-218。PARAM-073 の 6 個目）
  const viewEl = pane.minimized ? null : <ComponentViewButton paneKey={pane.key} />;
  const menuEl = <ComponentMenu pane={pane} title={title} open={menu?.open} onOpenChange={menu?.onOpenChange} onShowTier={menu?.onShowTier} />;
  if (mac) {
    // macOS の慣習: ウィンドウの操作（最大化・最小化・非表示）は見出しの左端、そのほか（ピン止め・タブ・ビュー・メニュー）は右端（FR-299）。操作の名前・アイコンは Windows と同じ
    return (
      <div className={s.macBar}>
        <div className={s.actions} data-testid="component-actions" data-minimized={pane.minimized ? 'true' : undefined} data-os="mac">
          {assignEl}
          {coreEl}
          <span className={s.group} style={extraStyle}>{hideEl}</span>
        </div>
        <div className={s.actions} data-testid="component-actions-extra">
          {pinEl}
          <span className={s.group} style={extraStyle}>{tabsEl}{viewEl}</span>
          {menuEl}
        </div>
      </div>
    );
  }
  return (
    <div className={s.actions} data-testid="component-actions" data-minimized={pane.minimized ? 'true' : undefined}>
      {/* ロールへの割り当ては、見出しの右寄せの並びの左端に足す（現れる・消えるときに、ほかのアイコンの位置が動かない） */}
      {assignEl}
      {pinEl}
      {coreEl}
      <span className={s.group} style={extraStyle}>
        {tabsEl}
        {hideEl}
        {viewEl}
      </span>
      {menuEl}
    </div>
  );
}
