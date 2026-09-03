import { Injectable, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { generateRound } from '../../../../pairing.ts';
import { RosterService } from './roster.service';
import { deriveHistory } from './history-derivation';
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

  proposeMatch(courtNumber: number, random: () => number = Math.random): void {
    const index = courtNumber - 1;
    const reservedByOtherCourts = new Set<string>();
    this.courts().forEach((court, i) => {
      if (i === index || court.status === 'idle') return;
      reservedByOtherCourts.add(court.teamA[0]);
      reservedByOtherCourts.add(court.teamA[1]);
      reservedByOtherCourts.add(court.teamB[0]);
      reservedByOtherCourts.add(court.teamB[1]);
    });
    const available = this.rosterPlayerIds.filter((id) => !reservedByOtherCourts.has(id));

    const history = deriveHistory(this.matches());
    const result = generateRound(available, 1, history, random);
    if (result.courts.length === 0) return;

    const [proposed] = result.courts;
    this.courts.update((courts) => {
      const next = [...courts];
      next[index] = { status: 'pending', teamA: proposed.teamA, teamB: proposed.teamB };
      return next;
    });
    this.persist();
  }
}
