import { Injectable } from '@nestjs/common';

/** Builds the reply to `/bill` in one LINE group, or null for silence. */
export type BillReplyHandler = (lineGroupId: string, now: Date) => Promise<unknown[] | null>;

/**
 * The bridge for commands typed in a LINE group whose answer lives in a module LineModule cannot import
 * (SessionsModule imports LineModule, not the other way round). The owning service registers its handler when it
 * starts; until then every command is answered with silence.
 */
@Injectable()
export class LineGroupCommands {
  private billHandler: BillReplyHandler | null = null;

  setBillHandler(handler: BillReplyHandler): void {
    this.billHandler = handler;
  }

  async bill(lineGroupId: string, now: Date): Promise<unknown[] | null> {
    return this.billHandler === null ? null : this.billHandler(lineGroupId, now);
  }
}
