import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Tonight's account, as the host confirms it. All blank (or no body) confirms the account already in effect:
 * tonight's earlier one, else the group default. The decorators are required, not decorative: the global
 * pipe's whitelist silently strips an undecorated field. The caps only bound the request size; the real
 * limits and the all-or-none rule live in validatePayAccount (400 PAY_ACCOUNT_INVALID).
 */
export class ConfirmPaymentCardDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  bank?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  number?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  /**
   * The panel's `contentHash` from the read the host is looking at (64 hex characters). Required: a confirm
   * freezes only the amounts the host saw, and a card that has moved since answers 409 PAYMENT_CHANGED.
   */
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  expectedHash!: string;
}
