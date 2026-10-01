import { HttpErrorResponse } from '@angular/common/http';
import { Component, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { centeredLevelSpecs, LEVELS } from '../../../../../engines/levels.ts';
import type { CanComponentDeactivate } from '../../core/can-deactivate.guard';
import {
  levelsErrorMessage,
  type GroupLevelsResponse,
  type LevelAction,
  type SaveGroupLevelsRequest,
} from '../../core/group-levels.model';
import { RosterService } from '../../core/roster.service';

/** One editable row. `id` exists only for a level already saved in a custom ladder. */
interface DraftRow {
  key: number;
  id?: string;
  name: string;
  /** Kept as text so a half-typed number is not rewritten under the host's cursor. */
  elo: string;
}

type PendingConfirm = { action: 'customize' | 'reset'; affected: number } | null;

const MAX_LEVELS = 16;
const MAX_NAME = 16;

/**
 * Owner-only editor for the group's own skill ladder (host feedback F). The
 * built-in BG..B ladder stays until the host explicitly switches; switching
 * either way clears player LABELS (never ratings), so it is confirmed with the
 * number of people affected. A seed edit only changes what future assignments
 * start from -- players keep the rating anchor they were given.
 */
@Component({
  selector: 'app-group-levels',
  imports: [RouterLink],
  templateUrl: './group-levels.html',
  styleUrl: './group-levels.css',
})
export class GroupLevels implements CanComponentDeactivate {
  private readonly roster = inject(RosterService);
  protected readonly groupCode = inject(ActivatedRoute).snapshot.paramMap.get('groupCode')!;

  protected readonly data = signal<GroupLevelsResponse | null>(null);
  protected readonly loadFailed = signal(false);
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly notice = signal<string | null>(null);
  protected readonly confirm = signal<PendingConfirm>(null);

  /** The draft being edited. Null in standard mode until the host starts customizing. */
  protected readonly draft = signal<DraftRow[] | null>(null);
  private nextKey = 1;
  private readonly confirmDialog = viewChild<ElementRef<HTMLDialogElement>>('confirmDialog');

  protected readonly builtIn = LEVELS;
  protected readonly isCustom = computed(() => this.data()?.mode === 'custom');
  protected readonly counts = computed(() => this.data()?.assignedCounts ?? {});
  protected readonly totalAssigned = computed(() => Object.values(this.counts()).reduce((a, b) => a + b, 0));

  /** True when the draft differs from what the server has (or a new custom ladder is being drafted). */
  protected readonly dirty = computed(() => {
    const d = this.draft();
    const data = this.data();
    if (!d || !data) return false;
    if (data.mode === 'standard') return true;
    if (d.length !== data.levels.length) return true;
    return d.some((row, i) => row.id !== data.levels[i].id || row.name !== data.levels[i].name || row.elo !== String(data.levels[i].startingElo));
  });
  protected readonly problem = computed(() => (this.draft() ? this.validate(this.draft()!) : null));

  constructor() {
    void this.load();
  }

  canDeactivate(): boolean {
    if (!this.dirty()) return true;
    return confirm($localize`:@@levels.confirmDiscard:ยังไม่ได้บันทึกการแก้ระดับ ออกจากหน้านี้โดยไม่บันทึกใช่หรือไม่?`);
  }

  private async load(keepDraft = false): Promise<void> {
    try {
      const data = await firstValueFrom(this.roster.getGroupLevels(this.groupCode));
      const modeChanged = this.data() !== null && this.data()!.mode !== data.mode;
      this.data.set(data);
      this.loadFailed.set(false);
      if (!keepDraft || modeChanged) this.draft.set(data.mode === 'custom' ? this.rowsOf(data) : null);
    } catch {
      this.loadFailed.set(true);
    }
  }

  private rowsOf(data: GroupLevelsResponse): DraftRow[] {
    return data.levels.map((l) => ({ key: this.nextKey++, id: l.id, name: l.name, elo: String(l.startingElo) }));
  }

  /** Standard mode: start a new ladder with three blank rungs spaced 100 apart around 1200. */
  protected startCustomizing(): void {
    this.error.set(null);
    this.notice.set(null);
    this.draft.set(centeredLevelSpecs(['', '', '']).map((l) => ({ key: this.nextKey++, name: l.name, elo: String(l.startingElo) })));
  }

  protected cancelDraft(): void {
    this.error.set(null);
    this.draft.set(this.data()?.mode === 'custom' ? this.rowsOf(this.data()!) : null);
  }

  protected setName(key: number, event: Event): void {
    const name = (event.target as HTMLInputElement).value;
    this.draft.update((rows) => rows!.map((r) => (r.key === key ? { ...r, name } : r)));
  }

  protected setElo(key: number, event: Event): void {
    const elo = (event.target as HTMLInputElement).value;
    this.draft.update((rows) => rows!.map((r) => (r.key === key ? { ...r, elo } : r)));
  }

  protected addRow(): void {
    const rows = this.draft()!;
    if (rows.length >= MAX_LEVELS) return;
    const last = Number(rows[rows.length - 1]?.elo);
    this.draft.set([...rows, { key: this.nextKey++, name: '', elo: String(Number.isFinite(last) ? last + 100 : 1200) }]);
  }

  protected canRemove(row: DraftRow): boolean {
    const rows = this.draft()!;
    return rows.length > 1 && (row.id === undefined || (this.counts()[row.id] ?? 0) === 0);
  }

  protected removeBlockedReason(row: DraftRow): string | null {
    const n = row.id === undefined ? 0 : (this.counts()[row.id] ?? 0);
    return n > 0 ? $localize`:@@levels.removeBlocked:มี ${n}:n: คนอยู่ในระดับนี้ — ย้ายหรือล้างระดับของเขาก่อนจึงจะลบได้` : null;
  }

  protected removeRow(key: number): void {
    this.draft.update((rows) => rows!.filter((r) => r.key !== key));
  }

  protected move(key: number, delta: -1 | 1): void {
    this.draft.update((rows) => {
      const i = rows!.findIndex((r) => r.key === key);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= rows!.length) return rows;
      const next = [...rows!];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }

  /** Respaces every seed 100 apart, centred on 1200 (the host can still override each). */
  protected suggestSeeds(): void {
    const rows = this.draft()!;
    const spaced = centeredLevelSpecs(rows.map((r) => r.name || String(r.key)));
    this.draft.set(rows.map((r, i) => ({ ...r, elo: String(spaced[i].startingElo) })));
  }

  /** Host-facing checks, in Thai/English; the server re-validates everything. */
  private validate(rows: DraftRow[]): string | null {
    if (rows.length < 1 || rows.length > MAX_LEVELS) return $localize`:@@levels.val.count:ต้องมี 1–16 ระดับ`;
    const seen = new Set<string>();
    let previous = -Infinity;
    for (const [i, r] of rows.entries()) {
      const n = i + 1;
      const name = r.name;
      if (name === '' || name !== name.trim()) return $localize`:@@levels.val.name:ระดับที่ ${n}:n: ต้องมีชื่อ และห้ามเว้นวรรคหน้า/หลัง`;
      if ([...name].length > MAX_NAME) return $localize`:@@levels.val.long:ชื่อระดับที่ ${n}:n: ยาวเกิน 16 ตัวอักษร`;
      if (/\p{Cc}/u.test(name)) return $localize`:@@levels.val.control:ชื่อระดับที่ ${n}:n: มีอักขระที่ใช้ไม่ได้`;
      const folded = name.normalize('NFC').toLowerCase();
      if (seen.has(folded)) return $localize`:@@levels.val.dup:ชื่อระดับซ้ำกัน: ${name}:name:`;
      seen.add(folded);
      const elo = Number(r.elo);
      if (r.elo.trim() === '' || !Number.isInteger(elo) || elo < 0) return $localize`:@@levels.val.elo:ค่า Elo ของระดับที่ ${n}:n: ต้องเป็นจำนวนเต็มไม่ติดลบ`;
      if (elo <= previous) return $localize`:@@levels.val.order:ค่า Elo ของระดับที่ ${n}:n: ต้องมากกว่าระดับก่อนหน้า`;
      previous = elo;
    }
    return null;
  }

  private requestOf(action: LevelAction): SaveGroupLevelsRequest {
    const base = { action, expectedRevision: this.data()!.revision };
    if (action === 'reset') return base;
    return {
      ...base,
      levels: this.draft()!.map((r) => ({ ...(r.id ? { id: r.id } : {}), name: r.name, startingElo: Number(r.elo) })),
    };
  }

  /** Save: an edit of a custom ladder goes straight through; the first switch asks first. */
  protected requestSave(): void {
    if (this.problem() || this.saving()) return;
    this.error.set(null);
    if (this.isCustom()) void this.submit('edit');
    else this.askConfirm('customize');
  }

  protected requestReset(): void {
    this.error.set(null);
    this.askConfirm('reset');
  }

  private askConfirm(action: 'customize' | 'reset'): void {
    this.confirm.set({ action, affected: this.totalAssigned() });
    this.confirmDialog()?.nativeElement.showModal();
  }

  protected cancelConfirm(): void {
    this.confirm.set(null);
    this.confirmDialog()?.nativeElement.close();
  }

  protected async confirmed(): Promise<void> {
    const pending = this.confirm();
    this.cancelConfirm();
    if (pending) await this.submit(pending.action);
  }

  private async submit(action: LevelAction): Promise<void> {
    this.saving.set(true);
    this.error.set(null);
    this.notice.set(null);
    try {
      const data = await firstValueFrom(this.roster.saveGroupLevels(this.groupCode, this.requestOf(action)));
      this.data.set(data);
      this.draft.set(data.mode === 'custom' ? this.rowsOf(data) : null);
      this.notice.set($localize`:@@levels.saved:บันทึกระดับแล้ว`);
    } catch (err) {
      const body = err instanceof HttpErrorResponse ? err.error : null;
      const code = typeof body?.code === 'string' ? body.code : null;
      this.error.set(levelsErrorMessage(code, body?.counts) ?? $localize`:@@levels.err.save:บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง`);
      // A stale answer reloads what the server has, without throwing away the host's edits.
      if (code === 'LEVEL_LADDER_STALE') await this.load(true);
    } finally {
      this.saving.set(false);
    }
  }

  protected countOf(id: string): number {
    return this.counts()[id] ?? 0;
  }
}
