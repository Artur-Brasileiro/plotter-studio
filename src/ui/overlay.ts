import type { Canvas } from "fabric";
import { sceneToMachineMatrix } from "../core/coords";
import { multiply, type Mat2D } from "../core/geometry/mat2d";
import { dist, type Vec } from "../core/geometry/vec";
import type { FeedClass, JobPlan } from "../core/job/types";

const COLORS: Record<FeedClass, string> = { straight: "#2e7d32", curve: "#ef6c00", tight: "#c62828" };
const FIXED_COLOR = "#1565c0";
const TRAVEL_COLOR = "#8a8a8a";

interface StrokeTime {
  readonly start: number;
  readonly dur: number;
  readonly cum: number[]; // comprimento acumulado por ponto
}

interface Cache {
  readonly plan: JobPlan;
  readonly byClass: Map<string, Path2D>; // cor → caminho
  readonly travel: Path2D;
  readonly strokePaths: Path2D[];
  readonly colors: string[];
  readonly times: StrokeTime[];
}

/**
 * Canvas por cima do Fabric (pointer-events: none) com o caminho planejado, em mm da máquina:
 * traços coloridos pela classe de velocidade (ou numa cor só no modo fixo) e deslocamentos
 * tracejados. No "play", desenha até o tempo t, incrementalmente num canvas fora da tela.
 */
export class Overlay {
  private readonly el: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  /** camada só do cursor da máquina (atualiza 5×/s sem redesenhar o caminho) */
  private readonly cursorEl: HTMLCanvasElement;
  private readonly done: HTMLCanvasElement = document.createElement("canvas");
  private cache: Cache | undefined;
  private visible = false;
  private fixedMode = false;
  private playhead: number | undefined;
  private doneUpTo = 0; // traços já desenhados no canvas "done"
  private doneVpt = "";
  private lastVpt = "";
  private machinePos: Vec | undefined;
  private machinePen = false;
  /** durante o envio: a animação mostra o progresso real, sem a caneta simulada */
  private hidePlayheadPen = false;

  constructor(host: HTMLElement, private readonly canvas: Canvas, private readonly getHeight: () => number) {
    this.el = document.createElement("canvas");
    this.el.className = "overlay";
    this.cursorEl = document.createElement("canvas");
    this.cursorEl.className = "overlay";
    host.append(this.el, this.cursorEl);
    this.ctx = this.el.getContext("2d")!;
    // redesenha quando o zoom/pan muda (o Fabric renderiza o canvas de baixo)
    canvas.on("after:render", ({ ctx }) => {
      if (ctx !== canvas.getContext()) return;
      const v = canvas.viewportTransform.join(",");
      if (v !== this.lastVpt) {
        this.lastVpt = v;
        this.redraw();
      }
    });
  }

  resize(w: number, h: number): void {
    const dpr = window.devicePixelRatio || 1;
    for (const c of [this.el, this.done, this.cursorEl]) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    for (const c of [this.el, this.cursorEl]) {
      c.style.width = `${w}px`;
      c.style.height = `${h}px`;
    }
    this.doneVpt = "";
    this.redraw();
  }

  setPlan(plan: JobPlan | undefined, fixedMode: boolean): void {
    this.fixedMode = fixedMode;
    this.cache = plan ? this.build(plan) : undefined;
    this.doneVpt = "";
    this.redraw();
  }

  /** Chamado quando a pré-visualização liga/desliga (o main usa para clarear os desenhos). */
  onVisibilityChange: (visible: boolean) => void = () => {};

  setVisible(v: boolean): void {
    if (v === this.visible) return;
    this.visible = v;
    this.onVisibilityChange(v);
    this.redraw();
  }

  get isVisible(): boolean {
    return this.visible;
  }

  /** undefined = sem animação (caminho inteiro) */
  setPlayhead(t: number | undefined): void {
    if (t === undefined || this.playhead === undefined || t < this.playhead) this.doneVpt = "";
    this.playhead = t;
    this.redraw();
  }

  /** v2: posição da caneta (mm da máquina); `penDown` pinta o centro */
  setMachinePosition(p: Vec | undefined, penDown = false): void {
    const same = p && this.machinePos ? p.x === this.machinePos.x && p.y === this.machinePos.y : p === this.machinePos;
    if (same && penDown === this.machinePen) return;
    this.machinePos = p;
    this.machinePen = penDown;
    this.drawCursor();
  }

  /** v2: progresso real do envio (traço e ponto), no lugar da animação. undefined = volta ao normal. */
  setProgress(p: { strokeIndex: number; pointIndex: number } | undefined): void {
    const c = this.cache;
    if (!p || !c) {
      if (this.hidePlayheadPen) {
        this.hidePlayheadPen = false;
        this.setPlayhead(undefined);
      }
      return;
    }
    this.hidePlayheadPen = true;
    const k = Math.min(Math.max(p.strokeIndex, 0), c.times.length - 1);
    const st = c.times[k];
    if (!st) return;
    const total = st.cum[st.cum.length - 1] || 1;
    const along = st.cum[Math.min(p.pointIndex, st.cum.length - 1)] ?? 0;
    this.setPlayhead(st.start + (along / total) * st.dur);
  }

  private drawCursor(): void {
    const ctx = this.cursorEl.getContext("2d")!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.cursorEl.width, this.cursorEl.height);
    const p = this.machinePos;
    if (!p) return;
    const { m } = this.matrix();
    const dpr = window.devicePixelRatio || 1;
    // em pixels: a cruz tem o mesmo tamanho em qualquer zoom
    const x = m[0] * p.x + m[2] * p.y + m[4];
    const y = m[1] * p.x + m[3] * p.y + m[5];
    const r = 7 * dpr;
    const color = this.machinePen ? "#c62828" : "#0d47a1";
    ctx.lineWidth = 2 * dpr;
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(x - 2.2 * r, y);
    ctx.lineTo(x - r * 0.4, y);
    ctx.moveTo(x + r * 0.4, y);
    ctx.lineTo(x + 2.2 * r, y);
    ctx.moveTo(x, y - 2.2 * r);
    ctx.lineTo(x, y - r * 0.4);
    ctx.moveTo(x, y + r * 0.4);
    ctx.lineTo(x, y + 2.2 * r);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, 2 * Math.PI);
    ctx.stroke();
    if (this.machinePen) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, r * 0.45, 0, 2 * Math.PI);
      ctx.fill();
    }
  }

  get totalTime(): number {
    return this.cache?.plan.stats.estimate.totalS ?? 0;
  }

  private build(plan: JobPlan): Cache {
    const byClass = new Map<string, Path2D>();
    const travel = new Path2D();
    const strokePaths: Path2D[] = [];
    const colors: string[] = [];
    const times: StrokeTime[] = [];
    let cur = plan.start;
    plan.strokes.forEach((s, i) => {
      const pts = s.points;
      if (!s.joinedToPrevious) {
        travel.moveTo(cur.x, cur.y);
        travel.lineTo(pts[0].x, pts[0].y);
      }
      const sp = new Path2D();
      sp.moveTo(pts[0].x, pts[0].y);
      if (pts.length === 1) sp.arc(pts[0].x, pts[0].y, 0.3, 0, 2 * Math.PI);
      const cum = [0];
      let dur = 0;
      for (let j = 1; j < pts.length; j++) {
        const color = this.fixedMode ? FIXED_COLOR : COLORS[s.classes[j - 1]];
        let p = byClass.get(color);
        if (!p) byClass.set(color, (p = new Path2D()));
        p.moveTo(pts[j - 1].x, pts[j - 1].y);
        p.lineTo(pts[j].x, pts[j].y);
        sp.lineTo(pts[j].x, pts[j].y);
        const L = dist(pts[j - 1], pts[j]);
        cum.push(cum[j - 1] + L);
        dur += L / (s.feeds[j - 1] / 60);
      }
      strokePaths.push(sp);
      colors.push(this.fixedMode ? FIXED_COLOR : COLORS[s.classes[0] ?? "straight"]);
      times.push({ start: plan.stats.strokeStartTimesS[i] ?? 0, dur, cum });
      cur = pts[pts.length - 1];
    });
    travel.moveTo(cur.x, cur.y);
    travel.lineTo(plan.end.x, plan.end.y);
    return { plan, byClass, travel, strokePaths, colors, times };
  }

  /** mm da máquina → pixels do canvas (com devicePixelRatio) */
  private matrix(): { m: Mat2D; z: number } {
    const dpr = window.devicePixelRatio || 1;
    const v = this.canvas.viewportTransform;
    const vpt: Mat2D = [v[0], v[1], v[2], v[3], v[4], v[5]];
    const m = multiply([dpr, 0, 0, dpr, 0, 0], multiply(vpt, sceneToMachineMatrix(this.getHeight())));
    return { m, z: v[0] };
  }

  redraw(): void {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.el.width, this.el.height);
    const { m, z } = this.matrix();
    const c = this.cache;
    if (this.visible && c) {
      ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      const animating = this.playhead !== undefined;
      ctx.globalAlpha = animating ? 0.18 : 1;
      this.strokeAll(ctx, c, z);
      ctx.globalAlpha = 1;
      if (animating) this.drawProgress(ctx, c, z, m);
    }
    this.drawCursor();
  }

  private strokeAll(ctx: CanvasRenderingContext2D, c: Cache, z: number) {
    ctx.lineWidth = 1.6 / z;
    for (const [color, p] of c.byClass) {
      ctx.strokeStyle = color;
      ctx.stroke(p);
    }
    ctx.setLineDash([4 / z, 3 / z]);
    ctx.lineWidth = 1 / z;
    ctx.strokeStyle = TRAVEL_COLOR;
    ctx.stroke(c.travel);
    ctx.setLineDash([]);
  }

  private drawProgress(ctx: CanvasRenderingContext2D, c: Cache, z: number, m: Mat2D) {
    const t = this.playhead!;
    const times = c.times;
    // traços completos até t: desenhados incrementalmente no canvas "done"
    let k = 0;
    while (k < times.length && times[k].start + times[k].dur <= t) k++;
    const vkey = m.join(",");
    const dctx = this.done.getContext("2d")!;
    if (this.doneVpt !== vkey) {
      dctx.setTransform(1, 0, 0, 1, 0, 0);
      dctx.clearRect(0, 0, this.done.width, this.done.height);
      this.doneUpTo = 0;
      this.doneVpt = vkey;
    }
    if (k > this.doneUpTo) {
      dctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
      dctx.lineWidth = 1.8 / z;
      dctx.lineJoin = dctx.lineCap = "round";
      for (let i = this.doneUpTo; i < k; i++) {
        dctx.strokeStyle = c.colors[i];
        dctx.stroke(c.strokePaths[i]);
      }
      this.doneUpTo = k;
    }
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.done, 0, 0);
    ctx.restore();

    // traço em andamento (parcial) e a caneta
    const s = c.plan.strokes;
    let pen: Vec;
    let down = false;
    if (k < times.length && t >= times[k].start) {
      const st = times[k];
      const pts = s[k].points;
      const target = st.dur > 0 ? ((t - st.start) / st.dur) * st.cum[st.cum.length - 1] : 0;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      let j = 1;
      while (j < pts.length && st.cum[j] <= target) ctx.lineTo(pts[j].x, pts[j].y), j++;
      pen = pts[j - 1];
      if (j < pts.length) {
        const f = (target - st.cum[j - 1]) / (st.cum[j] - st.cum[j - 1] || 1);
        pen = { x: pts[j - 1].x + (pts[j].x - pts[j - 1].x) * f, y: pts[j - 1].y + (pts[j].y - pts[j - 1].y) * f };
        ctx.lineTo(pen.x, pen.y);
      }
      ctx.lineWidth = 1.8 / z;
      ctx.strokeStyle = c.colors[k];
      ctx.stroke();
      down = true;
    } else {
      // caneta levantada entre o traço k−1 e o k
      const from = k === 0 ? c.plan.start : s[k - 1].points[s[k - 1].points.length - 1];
      const to = k < s.length ? s[k].points[0] : c.plan.end;
      const t0 = k === 0 ? 0 : times[k - 1].start + times[k - 1].dur;
      const t1 = k < times.length ? times[k].start : this.totalTime;
      const f = t1 > t0 ? Math.min(1, Math.max(0, (t - t0) / (t1 - t0))) : 1;
      pen = { x: from.x + (to.x - from.x) * f, y: from.y + (to.y - from.y) * f };
    }
    if (!this.hidePlayheadPen) this.drawPen(ctx, m, z, pen, down, down ? "#c62828" : "#555");
  }

  private drawPen(ctx: CanvasRenderingContext2D, m: Mat2D, z: number, p: Vec, filled: boolean, color: string) {
    ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 5 / z, 0, 2 * Math.PI);
    ctx.lineWidth = 2 / z;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    if (filled) ctx.fill();
    else ctx.stroke();
  }
}

/** Anima o playhead do Overlay com requestAnimationFrame, na velocidade escolhida (×1 = tempo real). */
export class Player {
  private raf = 0;
  private last = 0;
  private t = 0;
  speed = 20;
  onTick: (t: number, total: number, playing: boolean) => void = () => {};

  constructor(private readonly overlay: Overlay) {}

  get playing(): boolean {
    return this.raf !== 0;
  }

  play(): void {
    if (this.playing) return;
    if (this.t >= this.overlay.totalTime) this.t = 0;
    if (!this.overlay.isVisible) this.overlay.setVisible(true);
    this.last = performance.now();
    const step = (now: number) => {
      this.t = Math.min(this.overlay.totalTime, this.t + ((now - this.last) / 1000) * this.speed);
      this.last = now;
      this.overlay.setPlayhead(this.t);
      const end = this.t >= this.overlay.totalTime;
      this.onTick(this.t, this.overlay.totalTime, !end);
      if (end) this.raf = 0;
      else this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }

  pause(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.onTick(this.t, this.overlay.totalTime, false);
  }

  stop(): void {
    this.pause();
    this.t = 0;
    this.overlay.setPlayhead(undefined);
    this.onTick(0, this.overlay.totalTime, false);
  }
}
