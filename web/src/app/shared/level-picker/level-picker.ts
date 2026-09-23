import { Component, ElementRef, computed, input, output, viewChild } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { LEVELS, type Level } from '../../../../../engines/levels.ts';

interface LevelInfo {
  level: Level;
  definition: string;
}

/**
 * Definitions and the yes/no helper are grounded in the C1 design doc's
 * research (docs/superpowers/specs/2026-09-22-roadmap-c-series-design.md
 * §C1) — there is no single official Thai standard, so these are this app's
 * own working definitions, not a fixed authority.
 */
function definitionsOf(): LevelInfo[] {
  return [
    {
      level: 'BG',
      definition: $localize`:@@level.def.bg:มือเริ่มต้น เพิ่งเริ่มเล่น ตีโดนบ้างไม่โดนบ้าง ตีโต้พื้นฐานได้แต่ยังคุมทิศทางไม่ได้ เบสิคและการเคลื่อนที่ยังไม่ถูก`,
    },
    {
      level: 'N',
      definition: $localize`:@@level.def.n:รู้กติกา นับแต้มเป็น ตีโต้ได้ต่อเนื่อง กะจังหวะลูกได้ รับเสิร์ฟ/รับตบเบาๆ ได้ แต่ยังโยนไม่ถึงท้ายคอร์ท ยังไม่รู้การหมุนตำแหน่งเล่นคู่`,
    },
    {
      level: 'S',
      definition: $localize`:@@level.def.s:เล่นเกมเป็น ยืนตำแหน่งพื้นฐานได้ ตีลูกพื้นฐานได้ครบ (โยนถึงท้าย หยอด ตบ) แต่ยังไม่นิ่ง จุดอ่อนเยอะ`,
    },
    {
      level: 'P-',
      definition: $localize`:@@level.def.pminus:เบสิคครบ คุมลูกได้ เริ่มวางแผนการเล่น มีลูกหลอก แต่ยังเสียง่ายเมื่อโดนกดดัน`,
    },
    {
      level: 'P',
      definition: $localize`:@@level.def.p:ตีได้ทุกรูปแบบ เล่นคู่ลื่นไหล หมุนตำแหน่งเป็น ฟุตเวิร์กดี`,
    },
    {
      level: 'P+',
      definition: $localize`:@@level.def.pplus:ความแน่นอนสูง เล่นเกมเร็วได้ ตบหนัก อ่านเกมและหาจุดอ่อนคู่แข่งเป็น`,
    },
    {
      level: 'C',
      definition: $localize`:@@level.def.c:มือแข่งขัน ลงแข่งรายการสมัครเล่นเป็นประจำ มีประสบการณ์แข่ง`,
    },
    {
      level: 'B',
      definition: $localize`:@@level.def.b:ระดับตัวแทนมหาวิทยาลัย/จังหวัด หรืออดีตนักกีฬา`,
    },
  ];
}

@Component({
  selector: 'app-level-picker',
  imports: [NgTemplateOutlet],
  templateUrl: './level-picker.html',
  styleUrl: './level-picker.css',
  // Compact mode (a table cell, a dashboard panel row) keeps the old
  // inline-block sizing so the trigger button doesn't stretch full-width;
  // the default (roster review) is block, so the one-row chip strip below
  // gets the full width of its own line rather than squeezing next to a
  // player's name.
  host: { '[class.compact]': 'compact()' },
})
export class LevelPicker {
  readonly level = input<Level | null>(null);
  /**
   * Compact renders as a single small trigger chip that opens the picker in
   * a modal dialog (roster-manage table row, dashboard panel row) instead
   * of expanding in place — inline used to push every row below it down
   * the table, which read as broken in a list of many rows. The default
   * (roster review, one player per full-width row already) has no trigger
   * and stays inline, open, no dialog.
   */
  readonly compact = input(false);

  readonly levelChange = output<Level | null>();

  protected readonly levels = LEVELS;
  protected readonly definitions = definitionsOf();
  protected readonly unsetLabel = '-';

  private readonly dialogEl = viewChild<ElementRef<HTMLDialogElement>>('dialog');

  protected readonly currentDefinition = computed(() => {
    const level = this.level();
    return level ? this.definitions.find((d) => d.level === level)?.definition : undefined;
  });

  protected open(): void {
    this.dialogEl()?.nativeElement.showModal();
  }

  protected close(): void {
    this.dialogEl()?.nativeElement.close();
  }

  /**
   * Stays open after a choice: tapping a level is how the host sees its
   * definition (`currentDefinition` above), so closing immediately would
   * hide the very feedback that tells them they picked the right one.
   * Compact mode's own "ปิด" button (or Escape/backdrop, native to
   * `<dialog>`) is the explicit close; the non-compact inline picker has
   * nothing to close at all.
   */
  protected choose(level: Level | null): void {
    this.levelChange.emit(level);
  }
}
