import { Component, input } from '@angular/core';

/** A muted inline hint shown beside a control the group's plan does not include. */
@Component({
  selector: 'app-plan-lock',
  templateUrl: './plan-lock.html',
  styleUrl: './plan-lock.css',
})
export class PlanLock {
  /**
   * Replaces the generic first line ("ใช้ได้ในแพ็กเกจโฮสต์") when the caller can say
   * exactly what is locked. The upgrade sub-line always stays.
   */
  readonly hint = input<string | null>(null);
}
