import { Component, inject, input } from '@angular/core';
import { UpgradeSheetService } from '../../core/upgrade-sheet.service';

/** A muted inline hint shown beside a control the group's plan does not include. */
@Component({
  selector: 'app-plan-lock',
  templateUrl: './plan-lock.html',
  styleUrl: './plan-lock.css',
})
export class PlanLock {
  protected readonly sheet = inject(UpgradeSheetService);

  /**
   * Replaces the generic line ("ใช้ได้ในแพ็ก⁠เกจโฮสต์") when the caller can say
   * exactly what is locked. The "ดูแพ็ก⁠เกจ" button, which opens the upgrade sheet, always stays.
   */
  readonly hint = input<string | null>(null);
}
