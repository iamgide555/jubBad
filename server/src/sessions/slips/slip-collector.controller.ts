import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '../../auth/public.decorator.js';
import { CloseCollectionDto } from '../dto/close-collection.dto.js';
import { ResolveWaitingSlipDto } from '../dto/resolve-waiting-slip.dto.js';
import { SlipPlayerDto } from '../dto/slip-player.dto.js';
import { SlipImagesService } from './slip-images.service.js';
import {
  SlipPaymentsService,
  type DuplicateSlip,
  type PaidRow,
  type WaitingSlip,
} from './slip-payments.service.js';
import { SlipViewerGate, payToken } from './slip-viewer-gate.js';

/** The bill screen as the collector sees it: the host's review data without anyone's LINE user id, and no links. */
export interface CollectorPanel {
  groupName: string;
  date: string;
  accountName: string;
  rows: {
    playerId: string;
    name: string;
    amountSatang: number;
    absent: boolean;
  }[];
  paid: PaidRow[];
  waiting: Omit<WaitingSlip, 'lineUserId'>[];
  duplicates: Omit<DuplicateSlip, 'lineUserId'>[];
  /** Always empty: linking accounts stays with the host. */
  links: [];
  collection: {
    closedAt: string | null;
    canClose: boolean;
    imageCount: number;
  };
}

/**
 * The bill's collector manages payments from LINE, with no JubBad login. All @Public: the caller is the collector only
 * when the card token is tonight's, the plan gate holds, LINE verifies the access token, and the verified user is the
 * live LINE account of the bill's collector (`SlipPaymentsService.collectorAccess`). Anything else is the pay page's
 * bare 404, counted against the viewer: only a collector's own page calls these, so a refusal is never routine.
 *
 * Each write is the host's own service call, so every rule the host is held to holds here. Not exposed: linking a LINE
 * account to a player (set-link, or naming a slip's sender on resolve) and update-name.
 */
@Controller('sessions')
export class SlipCollectorController {
  constructor(
    private readonly slips: SlipPaymentsService,
    private readonly images: SlipImagesService,
    private readonly gate: SlipViewerGate,
  ) {}

  @Public()
  @Get(':code/slip-pay/manage')
  @Header('Cache-Control', 'no-store')
  async panel(
    @Param('code') code: string,
    @Query('token') token: unknown,
    @Req() req: Request,
  ): Promise<CollectorPanel> {
    const { panel } = await this.collector(code, token, req);
    const [paid, waiting, duplicates, collection] = await Promise.all([
      this.slips.getPaid(code),
      this.slips.listWaiting(code),
      this.slips.listDuplicates(code),
      this.slips.collection(code),
    ]);
    return {
      groupName: panel.groupName,
      date: panel.date,
      accountName: panel.account?.name ?? panel.groupAccount?.name ?? '',
      rows: panel.rows.map((r) => ({
        playerId: r.playerId,
        name: r.name,
        amountSatang: r.amountSatang,
        absent: r.absent,
      })),
      paid,
      waiting: waiting.map(collectorWaiting),
      duplicates: duplicates.map(collectorDuplicate),
      links: [],
      collection,
    };
  }

  /** The private slip image, with the host route's headers. A slip that is gone is a plain 404, not a failure. */
  @Public()
  @Get(':code/slip-pay/manage/images/:id')
  async image(
    @Param('code') code: string,
    @Param('id') id: string,
    @Query('token') token: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    await this.collector(code, token, req);
    const file = await this.images.read(code, id);
    if (!file) throw new NotFoundException();
    res.set({
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'",
    });
    return new StreamableFile(file.image, {
      type: file.contentType,
      disposition: 'inline',
    });
  }

  @Public()
  @Post(':code/slip-pay/manage/tick')
  @HttpCode(200)
  async tick(
    @Param('code') code: string,
    @Query('token') token: unknown,
    @Req() req: Request,
    @Body() dto: SlipPlayerDto,
  ): Promise<{ ok: true }> {
    await this.collector(code, token, req);
    await this.slips.tick(code, dto.playerId, 'collector');
    return { ok: true };
  }

  @Public()
  @Post(':code/slip-pay/manage/untick')
  @HttpCode(200)
  async untick(
    @Param('code') code: string,
    @Query('token') token: unknown,
    @Req() req: Request,
    @Body() dto: SlipPlayerDto,
  ): Promise<{ ok: true }> {
    await this.collector(code, token, req);
    await this.slips.untick(code, dto.playerId);
    return { ok: true };
  }

  @Public()
  @Post(':code/slip-pay/manage/waiting/:id/resolve')
  @HttpCode(200)
  async resolve(
    @Param('code') code: string,
    @Param('id') id: string,
    @Query('token') token: unknown,
    @Req() req: Request,
    @Body() dto: ResolveWaitingSlipDto,
  ): Promise<{ ok: true }> {
    await this.collector(code, token, req);
    // Never a sender: linking someone's LINE account to a player is the host's call alone.
    await this.slips.resolveWaiting(code, id, {
      coversPlayerIds: dto.coversPlayerIds,
      senderPlayerId: null,
      reviewedAmountSatang: dto.reviewedAmountSatang,
    });
    return { ok: true };
  }

  @Public()
  @Post(':code/slip-pay/manage/waiting/:id/dismiss')
  @HttpCode(200)
  async dismissWaiting(
    @Param('code') code: string,
    @Param('id') id: string,
    @Query('token') token: unknown,
    @Req() req: Request,
  ): Promise<{ ok: true }> {
    await this.collector(code, token, req);
    await this.slips.dismissWaiting(code, id);
    return { ok: true };
  }

  @Public()
  @Post(':code/slip-pay/manage/duplicates/:id/dismiss')
  @HttpCode(200)
  async dismissDuplicate(
    @Param('code') code: string,
    @Param('id') id: string,
    @Query('token') token: unknown,
    @Req() req: Request,
  ): Promise<{ ok: true }> {
    await this.collector(code, token, req);
    await this.slips.dismissDuplicate(code, id);
    return { ok: true };
  }

  /** Also the retry after a failed image purge, as for the host. */
  @Public()
  @Post(':code/slip-pay/manage/close')
  @HttpCode(200)
  async close(
    @Param('code') code: string,
    @Query('token') token: unknown,
    @Req() req: Request,
    @Body() _dto: CloseCollectionDto,
  ): Promise<{ ok: true }> {
    await this.collector(code, token, req);
    await this.slips.closeCollection(code);
    return { ok: true };
  }

  /** The bill's collector, or the uniform 404 counted against the viewer (429 once their budget is spent). */
  private async collector(code: string, token: unknown, req: Request) {
    const { user, key } = await this.gate.viewer(req, code);
    const access = await this.slips.collectorAccess(
      code,
      payToken(token),
      user,
    );
    if (!access) this.gate.fail(key);
    return access;
  }
}

/**
 * Field by field, so a field added to the host's types later is not shipped to LINE by default. A sender's LINE user
 * id identifies someone else's account: the collector gets the name and picture only.
 */
function collectorWaiting(s: WaitingSlip): Omit<WaitingSlip, 'lineUserId'> {
  return {
    id: s.id,
    imageId: s.imageId,
    linkedPlayerId: s.linkedPlayerId,
    reason: s.reason,
    displayName: s.displayName,
    pictureUrl: s.pictureUrl,
    amountSatang: s.amountSatang,
    receiverName: s.receiverName,
    receiverTail: s.receiverTail,
    createdAt: s.createdAt,
    candidatePlayerIds: s.candidatePlayerIds,
  };
}

function collectorDuplicate(
  d: DuplicateSlip,
): Omit<DuplicateSlip, 'lineUserId'> {
  return {
    id: d.id,
    displayName: d.displayName,
    referenceTail: d.referenceTail,
    originalPlayerIds: d.originalPlayerIds,
    createdAt: d.createdAt,
  };
}
