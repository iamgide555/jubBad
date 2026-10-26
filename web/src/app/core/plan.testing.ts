import { HttpErrorResponse } from '@angular/common/http';
import { ReplaySubject } from 'rxjs';
import type { GroupPlan, MyPlan, Plan } from './plan';
import { PlanService } from './plan.service';

/**
 * Test-only: a PlanService that never touches HTTP. An open plan request would keep
 * `whenStable()` waiting in every spec that is not about plans, so the stub stays silent until a
 * test calls `answer` / `fail`. An unanswered plan means "unknown", which locks nothing.
 */
export function stubPlanService() {
  const reply = new ReplaySubject<GroupPlan>(1);
  const mineReply = new ReplaySubject<MyPlan>(1);
  const calls: string[] = [];
  const mineCalls: number[] = [];
  return {
    calls,
    mineCalls,
    provider: {
      provide: PlanService,
      useValue: {
        forGroup: (groupCode: string) => {
          calls.push(groupCode);
          return reply;
        },
        mine: () => {
          mineCalls.push(1);
          return mineReply;
        },
      },
    },
    answer: (plan: Plan, renewsAt: string | null = null, extra: Partial<GroupPlan> = {}) =>
      reply.next({ plan, renewsAt, lapsedAt: null, paused: false, archiveHidden: 0, ...extra }),
    answerMine: (mine: Partial<MyPlan> = {}) =>
      mineReply.next({ plan: 'free', renewsAt: null, lapsedAt: null, groupCount: 0, groupLimit: 1, upgradeUrl: null, ...mine }),
    fail: () => reply.error(new HttpErrorResponse({ status: 500 })),
    failMine: () => mineReply.error(new HttpErrorResponse({ status: 500 })),
  };
}
