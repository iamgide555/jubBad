import { HttpErrorResponse } from '@angular/common/http';
import { ReplaySubject } from 'rxjs';
import type { GroupPlan, Plan } from './plan';
import { PlanService } from './plan.service';

/**
 * Test-only: a PlanService that never touches HTTP. An open plan request would keep
 * `whenStable()` waiting in every spec that is not about plans, so the stub stays silent until a
 * test calls `answer` / `fail`. An unanswered plan means "unknown", which locks nothing.
 */
export function stubPlanService() {
  const reply = new ReplaySubject<GroupPlan>(1);
  const calls: string[] = [];
  return {
    calls,
    provider: {
      provide: PlanService,
      useValue: {
        forGroup: (groupCode: string) => {
          calls.push(groupCode);
          return reply;
        },
      },
    },
    answer: (plan: Plan) => reply.next({ plan, renewsAt: null }),
    fail: () => reply.error(new HttpErrorResponse({ status: 500 })),
  };
}
