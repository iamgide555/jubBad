import { Injectable, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { RosterService } from './roster.service';
import type { CourtState, MatchRecord } from './live-session.model';

@Injectable()
export class LiveSessionService {
  private readonly sessionCode: string;
  protected readonly rosterPlayerIds: string[];
  readonly courts = signal<CourtState[]>([]);
  readonly matches = signal<MatchRecord[]>([]);

  constructor(
    route: ActivatedRoute,
    private rosterService: RosterService
  ) {
    this.sessionCode = route.snapshot.paramMap.get('sessionCode')!;
    const session = this.rosterService.getSession(this.sessionCode);
    this.rosterPlayerIds = session?.rosterPlayerIds ?? [];
    const courtCount = session?.courtCount ?? 0;

    const stored = this.load();
    this.courts.set(
      stored?.courts ?? Array.from({ length: courtCount }, () => ({ status: 'idle' as const }))
    );
    this.matches.set(stored?.matches ?? []);
  }

  private load(): { courts: CourtState[]; matches: MatchRecord[] } | null {
    const raw = localStorage.getItem(`live:${this.sessionCode}`);
    return raw ? JSON.parse(raw) : null;
  }

  protected persist(): void {
    localStorage.setItem(
      `live:${this.sessionCode}`,
      JSON.stringify({ courts: this.courts(), matches: this.matches() })
    );
  }
}
