import { Component, computed, inject, input } from '@angular/core';
import {
  bangkokDisplayDate,
  expiresSoon,
  groupLimitFor,
  groupPausedMessage,
  LAPSE_NOTICE_DAYS,
  planExpiringNotice,
  planLabel,
  planLapsedNotice,
  renewLabel,
  seePlanLabel,
  type GroupPlan,
} from '../../core/plan';
import { UpgradeSheetService } from '../../core/upgrade-sheet.service';

/**
 * One calm line about the plan, for the planning screens (group home, roster entry), never the
 * live dashboard: it is not actionable courtside. Precedence is paused, then lapsed, then
 * ending soon; an unknown plan (still loading, or the read failed) says nothing.
 */
@Component({
  selector: 'app-plan-notice',
  templateUrl: './plan-notice.html',
  styleUrl: './plan-notice.css',
})
export class PlanNotice {
  readonly plan = input<GroupPlan | null>(null);

  private readonly sheet = inject(UpgradeSheetService);

  protected readonly notice = computed<{ kind: 'paused' | 'lapsed' | 'expiring'; text: string; action: string } | null>(() => {
    const p = this.plan();
    if (!p) return null;
    if (p.paused) return { kind: 'paused', text: groupPausedMessage(groupLimitFor(p.plan)), action: seePlanLabel() };
    if (p.lapsedAt && new Date().getTime() - new Date(p.lapsedAt).getTime() <= LAPSE_NOTICE_DAYS * 24 * 60 * 60 * 1000) {
      return { kind: 'lapsed', text: planLapsedNotice(bangkokDisplayDate(p.lapsedAt)), action: renewLabel() };
    }
    if (expiresSoon(p, new Date())) {
      return { kind: 'expiring', text: planExpiringNotice(planLabel(p.plan), bangkokDisplayDate(p.renewsAt)), action: renewLabel() };
    }
    return null;
  });

  protected open(): void {
    this.sheet.open();
  }
}
