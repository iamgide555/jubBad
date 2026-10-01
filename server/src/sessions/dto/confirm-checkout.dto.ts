import { IsIn, IsString, Length, MaxLength, MinLength } from 'class-validator';
import type { CheckoutModel } from '../../../../engines/bill.ts';
import { CHECKOUT_MODELS } from './checkout-preview.dto.js';

export class ConfirmCheckoutDto {
  @IsIn(CHECKOUT_MODELS) model!: CheckoutModel;
  /** The hash the preview returned: the server re-prices and refuses if anything priced has moved. */
  @IsString() @Length(64, 64) snapshotHash!: string;
  /** Minted by the client per attempt and reused on a network retry, so a retry can never settle twice. */
  @IsString() @MinLength(1) @MaxLength(100) idempotencyKey!: string;
}
