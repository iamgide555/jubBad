import { IsOptional, IsString, MaxLength } from 'class-validator';

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
}
