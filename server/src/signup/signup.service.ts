import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma, type User } from '@prisma/client';
import { lineConfig } from '../line/line-config.js';
import { liffSignupUrl } from '../line/signup-links.js';
import { UsersService } from '../users/users.service.js';

export interface SignupInfo {
  liffId: string | null;
  lineSignupUrl: string | null;
  botAddUrl: string | null;
}

@Injectable()
export class SignupService {
  constructor(private readonly users: UsersService) {}

  /** A host who signed up on the website: free plan, no LINE link, no trial yet. */
  async registerWeb(email: string, password: string): Promise<User> {
    try {
      return await this.users.create(email, password, 'host', { plan: 'free', signupSource: 'web' });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException({ code: 'EMAIL_TAKEN' });
      }
      throw error;
    }
  }

  /** What the website's sign-up page needs; the LINE option is only offered when LIFF is fully configured. */
  info(): SignupInfo {
    const { liffId, loginChannelId, botAddUrl } = lineConfig();
    const liffReady = liffId !== null && loginChannelId !== null;
    return {
      liffId: liffReady ? liffId : null,
      lineSignupUrl: liffReady ? liffSignupUrl(liffId) : null,
      botAddUrl,
    };
  }
}
