export interface GroupSession {
  code: string;
  date: string | null;
  venue: string | null;
  courtCount: number | null;
  createdAt: string;
  endedAt: string | null;
  matchCount: number;
}
