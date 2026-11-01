// ボードの描画面（無限キャンバス）。FR-086〜FR-089 / NFR-PERF-004
// 入力は Pointer Events で統一し、振り分けは input.ts の PointerRouter（ペン=描画、指=パン/ズーム、手のひらは無視）。
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ClipboardEvent, DragEvent as ReactDragEvent, KeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { makeStyles, tokens } from '@fluentui/react-components';
import { hitTest, lassoSelect, nodeAt, pointInBounds, selectionBounds, type Pt } from './geometry';
import { PointerRouter, effectivePressure, pinchDelta } from './input';
import {
  ENTITY_DRAG_MIME, boardContentBounds, isShapeTool, makeShape, makeStroke, newId,
  type Board, type BoardItem, type InkPoint, type ShapeKind, type ToolId, type ViewState,
} from './model';
import { recognizeShape } from './recognize';
import { newFadeState, sampleGhosts, syncFade } from './fade';
import { DURATION } from '../motion/fluent';
import { presenceDuration } from '../motion/presence';
import { useMotionAllowed } from '../motion/transitions';
import { useMotionProfile } from '../motion/useMotion';
import { TEXT_FONT_SIZE, drawBoard, drawItem, drawLiveStroke, fontFor, setImageLoadListener, STICKY_COLOR, STICKY_TEXT, textHeight } from './render';
import { selectBoard, useInk } from './store';
import { useT } from '../i18n';
import { centerOn, panView, screenToWorld, worldToScreen, zoomView } from './viewport';
import { connect, expandGroups, voteItem } from '../whiteboard/ops';

const HOLD_MS = 600;
const HOLD_SLOP = 4;
const TEXT_W = 240;
const TEXT_H = 40;
const STICKY_W = 180;
const STICKY_H = 140;

const useStyles = makeStyles({
  root: {
    position: 'relative',
    width: '100%',
    height: '100%',
    minHeight: 0,
    overflow: 'hidden',
    touchAction: 'none',
    userSelect: 'none',
    color: tokens.colorNeutralForeground1,
    ':focus-visible': { outline: `${tokens.strokeWidthThick} solid ${tokens.colorStrokeFocus2}`, outlineOffset: '-2px' },
  },
  plate: { backgroundColor: tokens.colorNeutralBackground1, border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium },
  layer: { position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', pointerEvents: 'none' },
  editor: {
    position: 'absolute',
    boxSizing: 'border-box',
    resize: 'none',
    overflow: 'hidden',
    border: `${tokens.strokeWidthThin} dashed ${tokens.colorBrandStroke1}`,
    outline: 'none',
    margin: 0,
    lineHeight: 1.4,
    fontFamily: 'inherit',
  },
});

type Gesture =
  | { kind: 'ink'; pointerId: number; tool: 'pen' | 'highlighter'; points: InkPoint[]; anchor: Pt; timer: number; done: boolean }
  | { kind: 'shape'; pointerId: number; shape: ShapeKind; from: Pt; to: Pt }
  | { kind: 'lasso'; pointerId: number; points: Pt[] }
  | { kind: 'move'; pointerId: number; from: Pt; dx: number; dy: number }
  | { kind: 'eraseStroke'; pointerId: number; first: boolean }
  | { kind: 'erasePixel'; pointerId: number; at: Pt }
  | { kind: 'place'; pointerId: number; tool: 'text' | 'sticky'; at: Pt; down: Pt }
  | { kind: 'connect'; pointerId: number; node: string }
  | { kind: 'pan'; pointerId: number; last: Pt }
  | { kind: 'pinch' };

export interface BoardSurfaceProps {
  boardId: string;
  testId?: string;
  ariaLabel: string;
  /** 他のビューの上に重ねる注釈。背景は描かず、視点は固定（100%）。 */
  overlay?: boolean;
  /** overlay のとき、入力を受けるか（false なら下のビューに操作を通す） */
  active?: boolean;
  /** 一時的な注釈（プレゼン中。チャプター移動で消える）として描く */
  temporary?: boolean;
  minimap?: boolean;
  /** アプリのデータ（エンティティ）をドロップされたとき。at はワールド座標。指定がなければドロップを受けない（FR-098） */
  onEntityDrop?: (entityId: string, at: Pt) => void;
  /** データのカードのクリック・ダブルクリック（クリックで元データを選び、ダブルクリックで名前を編集する）。FR-098 */
  onItemActivate?: (item: BoardItem, how: 'click' | 'dblclick') => void;
  /** 描画面の上に重ねる部品（文字・付箋の読み上げ用の層など）。 */
  children?: ReactNode;
}

export function BoardSurface({ boardId, testId = 'board-surface', ariaLabel, overlay = false, active = true, temporary = false, minimap = false, onEntityDrop, onItemActivate, children }: BoardSurfaceProps) {
  const s = useStyles();
  const t = useT();
  const board = useInk(useMemo(() => selectBoard(boardId), [boardId]));
  const selection = useInk((st) => st.selection);
  const connectFrom = useInk((st) => st.connectFrom);
  const rootRef = useRef<HTMLDivElement>(null);
  const staticRef = useRef<HTMLCanvasElement>(null);
  const liveRef = useRef<HTMLCanvasElement>(null);
  const routerRef = useRef(new PointerRouter());
  const gestureRef = useRef<Gesture | null>(null);
  const touchesRef = useRef(new Map<number, Pt>());
  const spaceRef = useRef(false);
  const offsetRef = useRef<{ ids: Set<string>; dx: number; dy: number } | null>(null);
  const hoverRef = useRef<Pt | null>(null);
  const clickRef = useRef<{ x: number; y: number; id: string } | null>(null);
  const boardRef = useRef<Board | undefined>(board);
  boardRef.current = board;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const [editing, setEditing] = useState<string | null>(null);
  const editingRef = useRef<string | null>(null);
  editingRef.current = editing;

  const fixed = overlay;
  const view: ViewState = fixed ? { x: 0, y: 0, zoom: 1 } : (board?.view ?? { x: 0, y: 0, zoom: 1 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const fgRef = useRef('#000');

  // ---- 描画（静的な層は内容と視点が変わったとき、動的な層は操作中の毎フレーム） ----
  const rafStatic = useRef(0);
  const rafLive = useRef(0);
  const rafFade = useRef(0);
  const fadeRef = useRef(newFadeState(boardId, board));
  // 削除・undo の出入りの長さ（動き停止・視差効果の軽減は 0 = 即時）
  const motionOn = useMotionAllowed();
  const tempo = useMotionProfile().tempo;
  const fadeMsRef = useRef(0);
  fadeMsRef.current = presenceDuration(DURATION.ultraSlow, tempo, motionOn);
  const paintStatic = useCallback(() => {
    const cv = staticRef.current, b = boardRef.current, root = rootRef.current;
    if (!cv || !b || !root) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    fgRef.current = getComputedStyle(root).color || '#000';
    const dpr = window.devicePixelRatio || 1;
    const opts = {
      view: viewRef.current, width: b.size.w, height: b.size.h, dpr, fg: fgRef.current,
      hideIds: editingRef.current ? new Set([editingRef.current]) : undefined,
      offset: offsetRef.current,
      background: !overlay,
    };
    drawBoard(ctx, b, opts);
    // 削除・undo で消えた項目は、薄れて消えるまで重ねて描く（FR-070 AC-086。動き停止・reduce は即時に消す）
    const nowMs = performance.now();
    let fade = fadeRef.current;
    if (fade.boardId !== b.id) fade = fadeRef.current = newFadeState(b.id, b);
    syncFade(fade, b, nowMs, fadeMsRef.current);
    const groups = sampleGhosts(fade, nowMs, fadeMsRef.current);
    if (groups.length > 0) {
      const tmp = document.createElement('canvas');
      tmp.width = cv.width; tmp.height = cv.height;
      const tctx = tmp.getContext('2d');
      if (tctx) {
        for (const g of groups) {
          drawBoard(tctx, { strokes: g.strokes, items: g.items, background: b.background }, { ...opts, background: false, offset: null, hideIds: undefined });
          ctx.save();
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.globalAlpha = g.life;
          ctx.drawImage(tmp, 0, 0);
          ctx.restore();
        }
      }
      rafFade.current = requestAnimationFrame(() => { rafFade.current = 0; paintStatic(); });
    }
  }, [overlay]);

  const scheduleStatic = useCallback(() => {
    if (rafStatic.current) return;
    rafStatic.current = requestAnimationFrame(() => { rafStatic.current = 0; paintStatic(); });
  }, [paintStatic]);

  const paintLive = useCallback(() => {
    const cv = liveRef.current, b = boardRef.current;
    if (!cv || !b) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const v = viewRef.current;
    const fg = fgRef.current;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    const g = gestureRef.current;
    const lineScreen = (pts: Pt[], close: boolean) => {
      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = brandColor(rootRef.current);
      ctx.beginPath();
      pts.forEach((p, i) => { const q = worldToScreen(v, p.x, p.y); if (i === 0) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y); });
      if (close) ctx.closePath();
      ctx.stroke();
      ctx.restore();
    };
    if (g?.kind === 'ink') {
      const st = useInk.getState();
      drawLiveStroke(ctx, { id: 'live', tool: g.tool, color: st.color, size: st.size, points: g.points, bounds: { x: 0, y: 0, w: 0, h: 0 } }, v, dpr, fg);
    } else if (g?.kind === 'shape') {
      const st = useInk.getState();
      ctx.setTransform(dpr * v.zoom, 0, 0, dpr * v.zoom, -v.x * v.zoom * dpr, -v.y * v.zoom * dpr);
      drawItem(ctx, makeShape(g.shape, g.from.x, g.from.y, g.to.x, g.to.y, st.color, st.size), fg);
    } else if (g?.kind === 'lasso') {
      lineScreen(g.points, false);
    } else if (g?.kind === 'erasePixel' || (hoverRef.current && useInk.getState().tool === 'eraser-pixel' && !g)) {
      const at = g?.kind === 'erasePixel' ? g.at : hoverRef.current!;
      const q = worldToScreen(v, at.x, at.y);
      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.strokeStyle = fg;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(q.x, q.y, ERASER_RADIUS_PX, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    // 選択（投げ縄）の枠
    const sel = selectionRef.current;
    if (sel && sel.boardId === b.id) {
      const bb = selectionBounds(b, new Set(sel.ids));
      if (bb) {
        const o = offsetRef.current;
        const a = worldToScreen(v, bb.x + (o?.dx ?? 0), bb.y + (o?.dy ?? 0));
        ctx.save();
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.setLineDash([6, 4]);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = brandColor(rootRef.current);
        ctx.strokeRect(a.x - 4, a.y - 4, bb.w * v.zoom + 8, bb.h * v.zoom + 8);
        ctx.restore();
      }
    }
    // コネクターの接続元に選んだ項目の枠
    const from = useInk.getState().connectFrom;
    const fromItem = from ? b.items.find((i) => i.id === from) : undefined;
    if (fromItem) {
      const a = worldToScreen(v, fromItem.x, fromItem.y);
      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = brandColor(rootRef.current);
      ctx.strokeRect(a.x - 3, a.y - 3, fromItem.w * v.zoom + 6, fromItem.h * v.zoom + 6);
      ctx.restore();
    }
  }, []);
  const scheduleLive = useCallback(() => {
    if (rafLive.current) return;
    rafLive.current = requestAnimationFrame(() => { rafLive.current = 0; paintLive(); });
  }, [paintLive]);

  // 画像の読み込みが終わったら描き直す
  useEffect(() => {
    setImageLoadListener(scheduleStatic);
    return () => setImageLoadListener(null);
  }, [scheduleStatic]);

  // 大きさの追従（Canvas の解像度とボードの表示領域）
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const apply = () => {
      const w = Math.max(1, Math.round(root.clientWidth)), h = Math.max(1, Math.round(root.clientHeight));
      const dpr = window.devicePixelRatio || 1;
      for (const cv of [staticRef.current, liveRef.current]) {
        if (!cv) continue;
        const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
        if (cv.width !== pw) cv.width = pw;
        if (cv.height !== ph) cv.height = ph;
      }
      useInk.getState().setBoardSize(boardId, { w, h });
      scheduleStatic();
      scheduleLive();
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(root);
    return () => ro.disconnect();
  }, [boardId, scheduleStatic, scheduleLive]);

  useEffect(() => { scheduleStatic(); }, [board, view.x, view.y, view.zoom, editing, motionOn, scheduleStatic]);
  useEffect(() => { scheduleLive(); }, [selection, connectFrom, board, view.x, view.y, view.zoom, scheduleLive]);
  useEffect(() => () => { cancelAnimationFrame(rafStatic.current); cancelAnimationFrame(rafLive.current); cancelAnimationFrame(rafFade.current); }, []);

  // ---- 視点の操作 ----
  const setView = useCallback((v: ViewState) => { if (!fixed) useInk.getState().setView(boardId, v); }, [boardId, fixed]);

  // ホイール: そのままでパン、Ctrl（ピンチのジェスチャーを含む）で拡大縮小
  useEffect(() => {
    const root = rootRef.current;
    if (!root || fixed) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = root.getBoundingClientRect();
      const v = viewRef.current;
      const unit = e.deltaMode === 1 ? 16 : 1;
      if (e.ctrlKey || e.metaKey) {
        setView(zoomView(v, Math.exp(-e.deltaY * unit * 0.0015), e.clientX - rect.left, e.clientY - rect.top));
      } else {
        setView(panView(v, -e.deltaX * unit, -e.deltaY * unit));
      }
    };
    root.addEventListener('wheel', onWheel, { passive: false });
    return () => root.removeEventListener('wheel', onWheel);
  }, [fixed, setView]);

  // Space を押している間は、マウスのドラッグでパンする（描画面の上にポインターがあるときだけ）
  const overRef = useRef(false);
  useEffect(() => {
    if (fixed) return;
    const editable = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(t.tagName));
    const down = (e: globalThis.KeyboardEvent) => {
      if (e.key !== ' ' || !overRef.current || editable(e.target)) return;
      spaceRef.current = true;
      e.preventDefault();
    };
    const up = (e: globalThis.KeyboardEvent) => { if (e.key === ' ') spaceRef.current = false; };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, [fixed]);

  const local = (e: { clientX: number; clientY: number }): Pt => {
    const r = rootRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const world = (p: Pt): Pt => screenToWorld(viewRef.current, p.x, p.y);

  // ---- 編集（文字・付箋） ----
  const commitEdit = useCallback(() => {
    const id = editingRef.current;
    if (!id) return;
    const b = boardRef.current;
    const item = b?.items.find((i) => i.id === id);
    editingRef.current = null;
    setEditing(null);
    if (!item || !b) return;
    const text = item.text ?? '';
    if (item.type === 'text' && text.trim() === '') { useInk.getState().removeObjects(b.id, [id], false); return; }
    if (item.type === 'text') useInk.getState().patchItem(b.id, id, { h: Math.max(TEXT_H, textHeight(text, item.w)) }, false);
  }, []);

  const startEdit = (id: string) => { editingRef.current = id; setEditing(id); };

  const addAt = (tool: ToolId, at: Pt): string | null => {
    const st = useInk.getState();
    if (tool === 'text' || tool === 'sticky') {
      const item: BoardItem = tool === 'text'
        ? { id: newId('text'), type: 'text', x: at.x, y: at.y, w: TEXT_W, h: TEXT_H, text: '', color: st.color }
        : { id: newId('sticky'), type: 'sticky', x: at.x, y: at.y, w: STICKY_W, h: STICKY_H, text: '', color: STICKY_COLOR };
      st.addItem(boardId, item);
      return item.id;
    }
    if (isShapeTool(tool)) {
      const kind = tool as ShapeKind;
      const hw = 80, hh = kind === 'line' || kind === 'arrow' ? 0 : 50;
      st.addItem(boardId, makeShape(kind, at.x - hw, at.y - hh, at.x + hw, at.y + hh, st.color, st.size));
    }
    return null;
  };

  // ---- ポインター ----
  const cancelTouchGestures = () => {
    touchesRef.current.clear();
    const g = gestureRef.current;
    if (g && (g.kind === 'pan' || g.kind === 'pinch')) gestureRef.current = null;
  };

  const eraseAt = (g: { first: boolean }, p: Pt): void => {
    const b = boardRef.current;
    if (!b) return;
    const hit = hitTest(b, p, 6 / viewRef.current.zoom);
    if (!hit) return;
    useInk.getState().removeObjects(boardId, [hit.id], g.first);
    g.first = false;
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.target instanceof HTMLTextAreaElement) return;
    if (editingRef.current) commitEdit();
    const action = routerRef.current.down(e.nativeEvent, e.pointerId);
    if (e.pointerType === 'pen') cancelTouchGestures();
    if (action === 'ignore') return;
    rootRef.current?.focus({ preventScroll: true });
    try { rootRef.current?.setPointerCapture(e.pointerId); } catch { /* 合成イベントなど */ }
    const p = local(e);
    const st = useInk.getState();

    if (action === 'pan' && e.pointerType === 'touch') {
      if (fixed) return;
      touchesRef.current.set(e.pointerId, p);
      gestureRef.current = touchesRef.current.size >= 2 ? { kind: 'pinch' } : { kind: 'pan', pointerId: e.pointerId, last: p };
      return;
    }
    if (action === 'pan' || spaceRef.current) {
      if (fixed) return;
      gestureRef.current = { kind: 'pan', pointerId: e.pointerId, last: p };
      return;
    }

    const w = world(p);
    const under = boardRef.current ? nodeAt(boardRef.current, w) : null;
    clickRef.current = under && under.type === 'card' ? { x: p.x, y: p.y, id: under.id } : null;
    // ドット投票の最中: 付箋をクリックすると 1 票（Shift か Alt を押していれば 1 票戻す）。ほかの操作はしない
    if (st.voteMode && !fixed) {
      const hit = boardRef.current ? nodeAt(boardRef.current, w) : null;
      if (hit && hit.type === 'sticky') st.updateItems(boardId, (items) => voteItem(items, hit.id, e.shiftKey || e.altKey ? -1 : 1));
      return;
    }
    const tool: ToolId = action === 'erase' ? 'eraser-stroke' : st.tool;
    const pressure = effectivePressure(e.nativeEvent);
    switch (tool) {
      case 'pen':
      case 'highlighter': {
        const g: Gesture = { kind: 'ink', pointerId: e.pointerId, tool, points: [{ x: w.x, y: w.y, p: pressure }], anchor: p, timer: 0, done: false };
        if (tool === 'pen') g.timer = window.setTimeout(() => holdToShape(g), HOLD_MS);
        gestureRef.current = g;
        break;
      }
      case 'eraser-stroke': {
        const g = { kind: 'eraseStroke' as const, pointerId: e.pointerId, first: true };
        gestureRef.current = g;
        eraseAt(g, w);
        break;
      }
      case 'eraser-pixel':
        st.beginErase(boardId);
        gestureRef.current = { kind: 'erasePixel', pointerId: e.pointerId, at: w };
        st.erasePixelsAt(boardId, w, ERASER_RADIUS_PX / viewRef.current.zoom);
        break;
      case 'lasso': {
        const sel = selectionRef.current;
        const b = boardRef.current;
        const bb = sel && b && sel.boardId === b.id ? selectionBounds(b, new Set(sel.ids)) : null;
        if (bb && pointInBounds(w, bb, 6 / viewRef.current.zoom)) {
          offsetRef.current = { ids: new Set(sel!.ids), dx: 0, dy: 0 };
          gestureRef.current = { kind: 'move', pointerId: e.pointerId, from: w, dx: 0, dy: 0 };
        } else {
          // 付箋・カード・フレームの上で始めたら、それ（とグループの仲間、フレームの中身）を選んで動かす
          const hit = b ? hitTest(b, w, 4 / viewRef.current.zoom) : null;
          const it = hit?.kind === 'item' ? b!.items.find((i) => i.id === hit.id) : undefined;
          if (b && it && (it.type === 'sticky' || it.type === 'card' || it.type === 'frame')) {
            const base = it.type === 'frame' ? [it.id, ...b.items.filter((i) => i.frameId === it.id).map((i) => i.id)] : [it.id];
            const ids = expandGroups(b.items, base);
            st.setSelection(boardId, ids);
            selectionRef.current = { boardId, ids };
            offsetRef.current = { ids: new Set(ids), dx: 0, dy: 0 };
            gestureRef.current = { kind: 'move', pointerId: e.pointerId, from: w, dx: 0, dy: 0 };
          } else {
            st.clearSelection();
            gestureRef.current = { kind: 'lasso', pointerId: e.pointerId, points: [w] };
          }
        }
        break;
      }
      case 'connector': {
        const hit = boardRef.current ? nodeAt(boardRef.current, w) : null;
        if (hit) gestureRef.current = { kind: 'connect', pointerId: e.pointerId, node: hit.id };
        else st.setConnectFrom(null);
        break;
      }
      case 'text':
      case 'sticky':
        gestureRef.current = { kind: 'place', pointerId: e.pointerId, tool, at: w, down: p };
        break;
      default:
        if (isShapeTool(tool)) gestureRef.current = { kind: 'shape', pointerId: e.pointerId, shape: tool as ShapeKind, from: w, to: w };
    }
    scheduleLive();
  };

  // 長押し: 描いた線を整った図形に置き換える（FR-089）。ペンを止めたまま HOLD_MS 待つ。
  const holdToShape = (g: Extract<Gesture, { kind: 'ink' }>) => {
    if (gestureRef.current !== g || g.done) return;
    const r = recognizeShape(g.points);
    if (!r) return;
    const st = useInk.getState();
    st.addItem(boardId, makeShape(r.kind, r.x1, r.y1, r.x2, r.y2, st.color, st.size));
    g.done = true;
    scheduleLive();
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = local(e);
    const g = gestureRef.current;
    if (!g) {
      if (useInk.getState().tool === 'eraser-pixel' && e.pointerType !== 'touch') { hoverRef.current = world(p); scheduleLive(); }
      return;
    }
    if (g.kind === 'pinch' || (e.pointerType === 'touch' && touchesRef.current.has(e.pointerId))) {
      const prev = [...touchesRef.current.values()];
      touchesRef.current.set(e.pointerId, p);
      const next = [...touchesRef.current.values()];
      if (touchesRef.current.size >= 2 && !fixed) {
        const d = pinchDelta(prev, next);
        if (d) setView(panView(zoomView(viewRef.current, d.factor, d.cx, d.cy), d.dx, d.dy));
        gestureRef.current = { kind: 'pinch' };
      } else if (g.kind === 'pan' && g.pointerId === e.pointerId) {
        setView(panView(viewRef.current, p.x - g.last.x, p.y - g.last.y));
        g.last = p;
      }
      return;
    }
    if ('pointerId' in g && g.pointerId !== e.pointerId) return;
    const w = world(p);
    switch (g.kind) {
      case 'pan':
        setView(panView(viewRef.current, p.x - g.last.x, p.y - g.last.y));
        g.last = p;
        break;
      case 'ink': {
        // ペンはイベントの間引きが起きるので、結合された（coalesced）イベントを全部使う
        const evs = e.nativeEvent.getCoalescedEvents?.() ?? [];
        const list = evs.length > 0 ? evs : [e.nativeEvent];
        for (const ev of list) {
          const q = world(local(ev));
          g.points.push({ x: q.x, y: q.y, p: effectivePressure(ev) });
        }
        if (Math.hypot(p.x - g.anchor.x, p.y - g.anchor.y) > HOLD_SLOP) {
          g.anchor = p;
          if (g.tool === 'pen' && !g.done) { window.clearTimeout(g.timer); g.timer = window.setTimeout(() => holdToShape(g), HOLD_MS); }
        }
        break;
      }
      case 'shape': g.to = w; break;
      case 'lasso': g.points.push(w); break;
      case 'move':
        g.dx = w.x - g.from.x; g.dy = w.y - g.from.y;
        offsetRef.current = { ids: offsetRef.current?.ids ?? new Set(), dx: g.dx, dy: g.dy };
        scheduleStatic();
        break;
      case 'eraseStroke': eraseAt(g, w); break;
      case 'erasePixel':
        g.at = w;
        useInk.getState().erasePixelsAt(boardId, w, ERASER_RADIUS_PX / viewRef.current.zoom);
        break;
      case 'place': break;
    }
    scheduleLive();
  };

  const finish = (e: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) => {
    routerRef.current.up(e.nativeEvent, e.pointerId);
    const ck = clickRef.current;
    clickRef.current = null;
    if (ck && !cancelled && onItemActivate && Math.hypot(local(e).x - ck.x, local(e).y - ck.y) < 5) {
      const it = boardRef.current?.items.find((i) => i.id === ck.id);
      if (it) onItemActivate(it, 'click');
    }
    const wasTouch = touchesRef.current.delete(e.pointerId);
    const g = gestureRef.current;
    if (wasTouch && g?.kind === 'pinch') { if (touchesRef.current.size === 0) gestureRef.current = null; return; }
    if (!g || ('pointerId' in g && g.pointerId !== e.pointerId)) return;
    gestureRef.current = null;
    try { rootRef.current?.releasePointerCapture(e.pointerId); } catch { /* 取得していない */ }
    const st = useInk.getState();
    const b = boardRef.current;
    if (g.kind === 'ink') window.clearTimeout(g.timer);
    if (!cancelled && b) {
      const w = world(local(e));
      switch (g.kind) {
        case 'ink':
          if (!g.done) st.addStroke(boardId, makeStroke(g.tool, st.color, st.size, g.points.length === 1 ? [g.points[0]!, { ...g.points[0]! }] : g.points, temporary));
          break;
        case 'shape':
          if (Math.hypot(g.to.x - g.from.x, g.to.y - g.from.y) * viewRef.current.zoom >= 3) {
            st.addItem(boardId, makeShape(g.shape, g.from.x, g.from.y, g.to.x, g.to.y, st.color, st.size));
          }
          break;
        case 'lasso': st.setSelection(boardId, expandGroups(b.items, lassoSelect(b, g.points))); break;
        case 'connect': {
          const hit = nodeAt(b, w);
          const from = st.connectFrom;
          if (hit && hit.id !== g.node) {
            // 項目から項目へドラッグ、または接続元を選んだあとで別の項目をクリック
            st.updateItems(boardId, (items) => connect(items, g.node, hit.id, st.color).items);
            st.setConnectFrom(null);
          } else if (hit && hit.id === g.node) {
            if (from && from !== g.node) { st.updateItems(boardId, (items) => connect(items, from, g.node, st.color).items); st.setConnectFrom(null); }
            else st.setConnectFrom(from === g.node ? null : g.node);
          }
          break;
        }
        case 'move': {
          const o = offsetRef.current;
          if (o) st.moveObjects(boardId, [...o.ids], g.dx, g.dy);
          break;
        }
        case 'place':
          if (Math.hypot(local(e).x - g.down.x, local(e).y - g.down.y) < 6) {
            const id = addAt(g.tool, w);
            if (id) startEdit(id);
          }
          break;
        default: break;
      }
    }
    offsetRef.current = null;
    scheduleStatic();
    scheduleLive();
  };

  const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const b = boardRef.current;
    if (!b) return;
    const hit = hitTest(b, world(local(e)), 4 / viewRef.current.zoom);
    const item = hit?.kind === 'item' ? b.items.find((i) => i.id === hit.id) : undefined;
    if (item && (item.type === 'text' || item.type === 'sticky')) startEdit(item.id);
    else if (item && item.type === 'card') onItemActivate?.(item, 'dblclick');
  };

  // ---- キーボード ----
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target instanceof HTMLTextAreaElement) return;
    const st = useInk.getState();
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault(); e.stopPropagation();
      if (e.shiftKey) st.redo(boardId); else st.undo(boardId);
    } else if (mod && (e.key === 'y' || e.key === 'Y')) {
      e.preventDefault(); e.stopPropagation(); st.redo(boardId);
    } else if (e.key === ' ' && !fixed) {
      spaceRef.current = true; e.preventDefault();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectionRef.current?.boardId === boardId) {
      e.preventDefault(); e.stopPropagation();
      st.removeObjects(boardId, selectionRef.current.ids);
    } else if (e.key === 'Escape' && selectionRef.current) {
      e.stopPropagation(); st.clearSelection();
    } else if (e.key === 'Escape' && st.connectFrom) {
      e.stopPropagation(); st.setConnectFrom(null);
    } else if (e.key === 'Enter' && !mod && (st.tool === 'text' || st.tool === 'sticky' || isShapeTool(st.tool))) {
      // キーボードだけで、表示範囲の中央に追加する（FR-096）
      e.preventDefault(); e.stopPropagation();
      const bd = boardRef.current;
      if (!bd) return;
      const c = world({ x: bd.size.w / 2, y: bd.size.h / 2 });
      const id = addAt(st.tool, st.tool === 'text' || st.tool === 'sticky' ? { x: c.x - (st.tool === 'text' ? TEXT_W : STICKY_W) / 2, y: c.y - 20 } : c);
      if (id) startEdit(id);
    }
  };
  const onKeyUp = (e: KeyboardEvent<HTMLDivElement>) => { if (e.key === ' ') spaceRef.current = false; };

  // ---- 貼り付け（画像） ----
  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    if (e.target instanceof HTMLTextAreaElement) return;
    const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'));
    if (!file) return;
    e.preventDefault();
    const reader = new FileReader();
    reader.onload = () => {
      const src = String(reader.result);
      const img = new Image();
      img.onload = () => {
        const bd = boardRef.current;
        if (!bd) return;
        const scale = Math.min(1, 400 / Math.max(img.naturalWidth, img.naturalHeight, 1));
        const w = Math.max(8, img.naturalWidth * scale), h = Math.max(8, img.naturalHeight * scale);
        const c = world({ x: bd.size.w / 2, y: bd.size.h / 2 });
        useInk.getState().addItem(boardId, { id: newId('image'), type: 'image', x: c.x - w / 2, y: c.y - h / 2, w, h, src });
      };
      img.src = src;
    };
    reader.readAsDataURL(file);
  };

  const editItem = editing ? board?.items.find((i) => i.id === editing) : undefined;
  const cursor = 'crosshair';

  // アプリのデータ（エンティティ）のドロップ（FR-098）
  const onDragOver = (e: ReactDragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes(ENTITY_DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };
  const onDrop = (e: ReactDragEvent<HTMLDivElement>) => {
    const id = e.dataTransfer.getData(ENTITY_DRAG_MIME);
    if (!id) return;
    e.preventDefault();
    onEntityDrop?.(id, world(local(e)));
  };

  return (
    <div
      ref={rootRef}
      data-testid={testId}
      data-zoom-surface={overlay ? undefined : 'whiteboard'}
      className={`${s.root} ${overlay ? '' : s.plate}`}
      style={{ cursor, pointerEvents: overlay && !active ? 'none' : 'auto', position: overlay ? 'absolute' : 'relative', inset: overlay ? 0 : undefined, ...(overlay ? { zIndex: 50 } : {}) }}
      tabIndex={overlay && !active ? -1 : 0}
      role="application"
      aria-label={ariaLabel}
      aria-roledescription={t('描画面')}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => finish(e, false)}
      onPointerCancel={(e) => finish(e, true)}
      onPointerEnter={() => { overRef.current = true; }}
      onPointerLeave={() => { overRef.current = false; hoverRef.current = null; if (!gestureRef.current) scheduleLive(); }}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onPaste={onPaste}
      onDragOver={onEntityDrop ? onDragOver : undefined}
      onDrop={onEntityDrop ? onDrop : undefined}
    >
      <canvas ref={staticRef} className={s.layer} aria-hidden />
      <canvas ref={liveRef} className={s.layer} aria-hidden />
      {children}
      {editItem && (
        <textarea
          className={s.editor}
          aria-label={editItem.type === 'sticky' ? t('付箋の文字') : t('テキストの文字')}
          autoFocus
          ref={(el) => { if (el && document.activeElement !== el) el.focus({ preventScroll: true }); }}
          value={editItem.text ?? ''}
          style={{
            left: worldToScreen(view, editItem.x, editItem.y).x,
            top: worldToScreen(view, editItem.x, editItem.y).y,
            width: editItem.w * view.zoom,
            height: editItem.h * view.zoom,
            font: fontFor(TEXT_FONT_SIZE * view.zoom),
            lineHeight: 1.4,
            padding: 8 * view.zoom,
            color: editItem.type === 'sticky' ? STICKY_TEXT : undefined,
            backgroundColor: editItem.type === 'sticky' ? (editItem.color && editItem.color !== 'auto' ? editItem.color : STICKY_COLOR) : 'transparent',
          }}
          onChange={(e) => useInk.getState().patchItem(boardId, editItem.id, { text: e.target.value }, false)}
          onBlur={commitEdit}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
              e.preventDefault();
              commitEdit();
              rootRef.current?.focus({ preventScroll: true });
            }
          }}
        />
      )}
      {minimap && board && !fixed && (
        <Minimap board={board} onCenter={(wx, wy) => setView(centerOn(viewRef.current, wx, wy, board.size.w, board.size.h))} />
      )}
    </div>
  );
}

const ERASER_RADIUS_PX = 10;
/** Canvas は CSS 変数を直接使えないので、Fluent のトークン（--colorBrandStroke1）の現在の値を読む */
function brandColor(el: Element | null): string {
  const v = el ? getComputedStyle(el).getPropertyValue('--colorBrandStroke1').trim() : '';
  return v || '#0f6cbd';
}

// ---- ミニマップ ----
const MM_W = 168;
const MM_H = 108;

function Minimap({ board, onCenter }: { board: Board; onCenter: (wx: number, wy: number) => void }) {
  const t = useT();
  const ref = useRef<HTMLCanvasElement>(null);
  const mapRef = useRef({ x: 0, y: 0, k: 1 });
  const dragging = useRef(false);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const raf = requestAnimationFrame(() => {
      const ctx = cv.getContext('2d');
      if (!ctx) return;
      const dpr = window.devicePixelRatio || 1;
      cv.width = Math.round(MM_W * dpr); cv.height = Math.round(MM_H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, MM_W, MM_H);
      const v = board.view;
      const vis = { x: v.x, y: v.y, w: board.size.w / v.zoom, h: board.size.h / v.zoom };
      const c = boardContentBounds(board);
      const minX = Math.min(c ? c.x : vis.x, vis.x), minY = Math.min(c ? c.y : vis.y, vis.y);
      const maxX = Math.max(c ? c.x + c.w : vis.x + vis.w, vis.x + vis.w), maxY = Math.max(c ? c.y + c.h : vis.y + vis.h, vis.y + vis.h);
      const bw = Math.max(1, maxX - minX), bh = Math.max(1, maxY - minY);
      const k = Math.min((MM_W - 8) / bw, (MM_H - 8) / bh);
      const ox = (MM_W - bw * k) / 2 - minX * k, oy = (MM_H - bh * k) / 2 - minY * k;
      mapRef.current = { x: ox, y: oy, k };
      const fg = getComputedStyle(cv).color || '#000';
      ctx.fillStyle = fg;
      ctx.strokeStyle = fg;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 1;
      const step = Math.max(1, Math.ceil(board.strokes.length / 3000));
      ctx.beginPath();
      for (let i = 0; i < board.strokes.length; i += step) {
        const b = board.strokes[i]!.bounds;
        ctx.moveTo(b.x * k + ox, b.y * k + oy);
        ctx.lineTo((b.x + Math.max(b.w, 1)) * k + ox + 0.6, (b.y + b.h) * k + oy);
      }
      ctx.stroke();
      for (const it of board.items) ctx.fillRect(it.x * k + ox, it.y * k + oy, Math.max(2, it.w * k), Math.max(2, it.h * k));
      ctx.globalAlpha = 1;
      ctx.strokeStyle = brandColor(cv);
      ctx.lineWidth = 2;
      ctx.strokeRect(vis.x * k + ox, vis.y * k + oy, vis.w * k, vis.h * k);
    });
    return () => cancelAnimationFrame(raf);
  }, [board]);

  const move = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const m = mapRef.current;
    onCenter((e.clientX - r.left - m.x) / m.k, (e.clientY - r.top - m.y) / m.k);
  };
  return (
    <canvas
      ref={ref}
      data-testid="board-minimap"
      role="img"
      aria-label={t('ミニマップ（クリックで表示位置を移動）')}
      style={{
        position: 'absolute', right: 8, bottom: 8, width: MM_W, height: MM_H, cursor: 'pointer',
        backgroundColor: tokens.colorNeutralBackground2, border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke1}`, borderRadius: tokens.borderRadiusSmall,
      }}
      onPointerDown={(e) => { e.stopPropagation(); dragging.current = true; e.currentTarget.setPointerCapture(e.pointerId); move(e); }}
      onPointerMove={(e) => { e.stopPropagation(); if (dragging.current) move(e); }}
      onPointerUp={(e) => { e.stopPropagation(); dragging.current = false; }}
    />
  );
}
