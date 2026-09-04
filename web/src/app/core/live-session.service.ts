import { Injectable, computed, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { generateRound } from '../../../../pairing.ts';
import { RosterService } from './roster.service';
import { deriveHistory } from './history-derivation';
import type { CourtState, MatchRecord } from './live-session.model';

@Injectable()
export class LiveSessionService {
  private readonly sessionCode: string;
  private readonly courtCount: number;
  protected readonly rosterPlayerIds: string[];
  readonly courts = signal<CourtState[]>([]);
  readonly matches = signal<MatchRecord[]>([]);

  readonly waitingPlayerIds = computed(() => {
    const reserved = new Set<string>();
    for (const court of this.courts()) {
      if (court.status === 'idle') continue;
      reserved.add(court.teamA[0]);
      reserved.add(court.teamA[1]);
      reserved.add(court.teamB[0]);
      reserved.add(court.teamB[1]);
    }
    return this.rosterPlayerIds.filter((id) => !reserved.has(id));
  });

  constructor(
    route: ActivatedRoute,
    private rosterService: RosterService
  ) {
    this.sessionCode = route.snapshot.paramMap.get('sessionCode')!;
    const session = this.rosterService.getSession(this.sessionCode);
    this.rosterPlayerIds = session?.rosterPlayerIds ?? [];
    this.courtCount = session?.courtCount ?? 0;

    this.refresh();
  }

  refresh(): void {
    const stored = this.load();
    this.courts.set(
      stored?.courts ??
        Array.from({ length: this.courtCount }, () => ({ status: 'idle' as const }))
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

  proposeMatch(courtNumber: number, random: () => number = Math.random): boolean {
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
    if (result.courts.length === 0) return false;

    const [proposed] = result.courts;
    this.courts.update((courts) => {
      const next = [...courts];
      next[index] = { status: 'pending', teamA: proposed.teamA, teamB: proposed.teamB };
      return next;
    });
    this.persist();
    return true;
  }

  confirmMatch(courtNumber: number): void {
    const index = courtNumber - 1;
    const court = this.courts()[index];
    if (court.status !== 'pending') return;

    this.matches.update((matches) => [
      ...matches,
      { courtNumber, teamA: court.teamA, teamB: court.teamB, scoreA: null, scoreB: null },
    ]);
    this.courts.update((courts) => {
      const next = [...courts];
      next[index] = { status: 'active', teamA: court.teamA, teamB: court.teamB };
      return next;
    });
    this.persist();
  }

  finishMatch(courtNumber: number, scoreA: number | null, scoreB: number | null): void {
    const index = courtNumber - 1;
    const court = this.courts()[index];
    if (court.status !== 'active') return;

    this.matches.update((matches) => {
      const reversedIndex = [...matches].reverse().findIndex((m) => m.courtNumber === courtNumber);
      if (reversedIndex === -1) return matches;
      const actualIndex = matches.length - 1 - reversedIndex;
      const next = [...matches];
      next[actualIndex] = { ...next[actualIndex], scoreA, scoreB };
      return next;
    });
    this.courts.update((courts) => {
      const next = [...courts];
      next[index] = { status: 'idle' };
      return next;
    });
    this.persist();
  }
}
