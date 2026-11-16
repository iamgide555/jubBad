import { Module } from '@nestjs/common';
import { LiffIdentity } from './liff-identity.js';

/** Who a LIFF access token belongs to, asked of LINE. Shared by the slip pay page and host sign-up. */
@Module({ providers: [LiffIdentity], exports: [LiffIdentity] })
export class LiffIdentityModule {}
