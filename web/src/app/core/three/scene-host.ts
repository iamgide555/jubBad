import { Component, DestroyRef, ElementRef, inject, input, signal, viewChild } from '@angular/core';
import { Icon } from '../../shared/icon/icon';
import { prefersReducedMotion } from '../motion/motion';
import type { FeatherScene, FeatherSceneOptions } from './feather-scene';

/**
 * The one gate every 3D mount point in the app goes through — login/landing,
 * the venue display, and the summary/profile hero. `three` (~130 KB gzip) is
 * dynamically imported here and only here, so it never touches the eagerly-
 * loaded app shell or the session-dashboard chunk, which explicitly gets no
 * WebGL at all (see PressDirective's own doc comment on why: a three-hour
 * one-handed session is the wrong place to spend battery and thermal budget
 * on a decorative scene).
 *
 * Falls back to a flat feather-mark poster — never a fabricated "photo" of
 * the scene, since PRODUCT.md rules out presenting synthetic material as
 * real — whenever any of these hold: reduced-motion is requested, the device
 * reports 4 cores or fewer, the connection is in data-saver mode, WebGL
 * fails to initialise, or (via IntersectionObserver) the host is currently
 * off-screen — in which case the render loop simply doesn't start until it
 * scrolls into view, rather than spending a frame budget nobody sees.
 */
@Component({
  selector: 'app-scene-host',
  imports: [Icon],
  template: `
    <div #container class="scene-host" [class.is-live]="renderStarted()">
      @if (!renderStarted()) {
        <div class="scene-poster" role="img" aria-label="">
          <app-icon name="feather" [size]="posterIconSize()" />
        </div>
      }
      <canvas #canvas class="scene-canvas" [class.is-visible]="renderStarted()"></canvas>
    </div>
  `,
  styleUrl: './scene-host.css',
})
export class SceneHost {
  /** 'hero' = closer camera, ground shadow, faster settle — the login/
   *  landing and summary/profile mounts. 'ambient' = further camera, no
   *  ground shadow, slower drift — the TV display's backdrop, where the
   *  emblem is a detail in the scene rather than the subject of it. */
  readonly variant = input<'hero' | 'ambient'>('hero');
  readonly transparent = input(true);

  protected readonly renderStarted = signal(false);
  protected readonly posterIconSize = signal(64);

  private readonly containerRef = viewChild.required<ElementRef<HTMLDivElement>>('container');
  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');

  private scene: FeatherScene | null = null;
  private rafId: number | null = null;
  private lastTime = 0;
  private intersectionObserver?: IntersectionObserver;
  private resizeObserver?: ResizeObserver;
  private isVisible = false;

  constructor() {
    const destroyRef = inject(DestroyRef);
    destroyRef.onDestroy(() => this.teardown());

    queueMicrotask(() => this.init());
  }

  private async init(): Promise<void> {
    if (!this.shouldAttemptRender()) return;

    const container = this.containerRef().nativeElement;
    this.intersectionObserver = new IntersectionObserver(
      (entries) => {
        const wasVisible = this.isVisible;
        this.isVisible = entries[0]?.isIntersecting ?? false;
        if (this.isVisible && !wasVisible) this.startIfReady();
        if (!this.isVisible && this.rafId !== null) this.pause();
      },
      { threshold: 0.1 }
    );
    this.intersectionObserver.observe(container);
  }

  private shouldAttemptRender(): boolean {
    // A test environment (jsdom/happy-dom) has neither observer — the same
    // absence a very old or locked-down real browser would present, and the
    // same answer applies: stay on the static poster.
    if (typeof IntersectionObserver === 'undefined' || typeof ResizeObserver === 'undefined') {
      return false;
    }
    if (prefersReducedMotion()) return false;
    if ((navigator.hardwareConcurrency ?? 8) <= 4) return false;
    const connection = (navigator as { connection?: { saveData?: boolean } }).connection;
    if (connection?.saveData) return false;
    return true;
  }

  private started = false;

  private async startIfReady(): Promise<void> {
    if (this.started) {
      this.resume();
      return;
    }
    this.started = true;

    const canvas = this.canvasRef().nativeElement;
    const container = this.containerRef().nativeElement;
    const { width, height } = container.getBoundingClientRect();
    if (width === 0 || height === 0) return;

    let createFeatherScene: typeof import('./feather-scene').createFeatherScene;
    try {
      ({ createFeatherScene } = await import('./feather-scene'));
    } catch {
      return; // Stays on the poster — a failed chunk load is not the user's problem.
    }

    try {
      const options: FeatherSceneOptions =
        this.variant() === 'hero'
          ? { groundShadow: true, cameraDistance: 6.5, spinSpeed: 0.3 }
          : { groundShadow: false, cameraDistance: 9, spinSpeed: 0.12 };
      this.scene = createFeatherScene(canvas, width, height, {
        ...options,
        background: this.transparent() ? null : 0x0a0e0b,
      });
    } catch {
      // getContext('webgl2'/'webgl') threw — an old device or a locked-down
      // browser. Stays on the poster.
      return;
    }

    this.renderStarted.set(true);
    this.resizeObserver = new ResizeObserver(([entry]) => {
      const box = entry?.contentRect;
      if (box && box.width > 0 && box.height > 0) this.scene?.resize(box.width, box.height);
    });
    this.resizeObserver.observe(container);

    container.addEventListener('pointermove', this.onPointerMove);
    this.resume();
  }

  private onPointerMove = (event: PointerEvent): void => {
    const rect = this.containerRef().nativeElement.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    const y = ((event.clientY - rect.top) / rect.height) * 2 - 1;
    this.scene?.setPointer(x, y);
  };

  private resume(): void {
    if (this.rafId !== null || !this.scene) return;
    this.lastTime = performance.now();
    const loop = (time: number) => {
      const delta = Math.min((time - this.lastTime) / 1000, 0.1);
      this.lastTime = time;
      this.scene?.tick(delta);
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  private pause(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private teardown(): void {
    this.pause();
    this.intersectionObserver?.disconnect();
    this.resizeObserver?.disconnect();
    this.containerRef()?.nativeElement.removeEventListener('pointermove', this.onPointerMove);
    this.scene?.dispose();
    this.scene = null;
  }
}
