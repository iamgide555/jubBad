/** Owner-only group ladder (host feedback F). Never part of a public response. */
export interface LevelDef {
  id: string;
  name: string;
  startingElo: number;
}

export interface GroupLevelsResponse {
  mode: 'standard' | 'custom';
  revision: number;
  levels: LevelDef[];
  /** Players assigned to each level id, zeros included. */
  assignedCounts: Record<string, number>;
}

export type LevelAction = 'customize' | 'edit' | 'reset';

export interface SaveGroupLevelsRequest {
  action: LevelAction;
  expectedRevision: number;
  /** `id` only for an existing custom level; new levels omit it. */
  levels?: { id?: string; name: string; startingElo: number }[];
}

/** Host-facing text for a stable server code; null for one the page does not special-case. */
export function levelsErrorMessage(code: string | null, counts?: Record<string, number>): string | null {
  switch (code) {
    case 'LEVEL_LADDER_STALE':
      return $localize`:@@levels.err.stale:มีการแก้ระดับจากที่อื่นแล้ว โหลดข้อมูลล่าสุดให้แล้ว ตรวจก่อนบันทึกอีกครั้ง`;
    case 'LEVEL_LADDER_ACTIVE_SESSION':
      return $localize`:@@levels.err.activeSession:ยังมีก๊วนที่ไม่ได้จบ แก้ระดับไม่ได้ จบก๊วนก่อนแล้วค่อยแก้`;
    case 'LEVEL_IN_USE': {
      const n = counts ? Object.values(counts).reduce((a, b) => a + b, 0) : 0;
      return $localize`:@@levels.err.inUse:ลบระดับนี้ไม่ได้ เพราะยังมี ${n}:n: คนอยู่ในระดับนี้ ย้ายหรือล้างระดับของคนเหล่านั้นก่อน`;
    }
    case 'LEVEL_LADDER_INVALID':
      return $localize`:@@levels.err.invalid:รายการระดับไม่ถูกต้อง ตรวจชื่อและค่า Elo`;
    case 'LEVEL_DATA_INTEGRITY':
    case 'LEVEL_LADDER_CORRUPT':
      return $localize`:@@levels.err.corrupt:ข้อมูลระดับของก๊วนผิดปกติ กรุณาแจ้งผู้ดูแล`;
    default:
      return null;
  }
}
