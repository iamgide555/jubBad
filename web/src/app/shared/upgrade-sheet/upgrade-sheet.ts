import { Component, ElementRef, effect, inject, viewChild } from '@angular/core';
import { UpgradeSheetService } from '../../core/upgrade-sheet.service';

/** Mounted once in the app shell; opened by UpgradeSheetService from any plan lock. */
@Component({
  selector: 'app-upgrade-sheet',
  templateUrl: './upgrade-sheet.html',
  styleUrl: './upgrade-sheet.css',
})
export class UpgradeSheet {
  protected readonly sheet = inject(UpgradeSheetService);
  private readonly dialogEl = viewChild<ElementRef<HTMLDialogElement>>('dialog');

  constructor() {
    effect(() => {
      const open = this.sheet.isOpen();
      const dialog = this.dialogEl()?.nativeElement;
      if (!dialog) return;
      if (open && !dialog.open) dialog.showModal();
      else if (!open && dialog.open) dialog.close();
    });
  }

  /** A browser-initiated close (Escape) syncs back to the service. */
  protected onDialogClose(): void {
    if (this.sheet.isOpen()) this.sheet.close();
  }
}
