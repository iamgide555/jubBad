import { Injectable } from '@angular/core';
import type { Player } from '../../../../fuzzy-match.ts';
import type { Session } from './session.model';

@Injectable({ providedIn: 'root' })
export class RosterService {
  getPlayers(groupCode: string): Player[] {
    const raw = localStorage.getItem(`players:${groupCode}`);
    return raw ? JSON.parse(raw) : [];
  }

  savePlayers(groupCode: string, players: Player[]): void {
    localStorage.setItem(`players:${groupCode}`, JSON.stringify(players));
  }

  createSession(session: Session): void {
    localStorage.setItem(`session:${session.code}`, JSON.stringify(session));
  }

  getSession(sessionCode: string): Session | null {
    const raw = localStorage.getItem(`session:${sessionCode}`);
    return raw ? JSON.parse(raw) : null;
  }
}
