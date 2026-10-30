import { Injectable, NestMiddleware } from '@nestjs/common';
import { raw } from 'express';
import type { NextFunction, Request, Response } from 'express';

/** The largest slip image accepted; a phone screenshot is well under this. */
export const SLIP_UPLOAD_LIMIT = '8mb';

/**
 * Reads the pay page's upload as a raw `image/*` body, 8 MB at most (413 beyond that). Any other content type is left
 * unparsed, so the controller sees no body and answers 400. A caller with no LINE access token is not read at all:
 * the controller answers it with the bare 404, so an anonymous caller cannot make the server buffer 8 MB.
 */
@Injectable()
export class SlipUploadMiddleware implements NestMiddleware {
  private readonly parse = raw({ type: 'image/*', limit: SLIP_UPLOAD_LIMIT });

  use(req: Request, res: Response, next: NextFunction): void {
    if (!req.headers['x-line-access-token']) return next();
    this.parse(req, res, next);
  }
}
