import { IsIn } from 'class-validator';
import type { CheckoutModel } from '../../../../engines/bill.ts';

/** `fair` splits a whole night's cost and cannot be quoted mid-session. */
export const CHECKOUT_MODELS = ['perGame', 'perShuttle', 'buffet'] as const;

export class CheckoutPreviewDto {
  @IsIn(CHECKOUT_MODELS) model!: CheckoutModel;
}
