export interface Session {
  code: string;
  groupCode: string;
  date: string | null;
  venue: string | null;
  courtCount: number | null;
  rawImportText: string;
  rosterPlayerIds: string[];
  waitlistPlayerIds: string[];
}
