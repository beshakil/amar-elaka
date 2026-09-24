import { Inject, Injectable } from '@nestjs/common';
import { OAuth2Client } from 'google-auth-library';
import { APP_CONFIG } from '../../config/config.module';
import type { Env } from '../../config/env.schema';
import { GoogleTokenInvalidException } from '../exceptions/auth.exceptions';

export interface GoogleIdentity {
  googleId: string;
  email: string | undefined;
  emailVerified: boolean;
}

@Injectable()
export class GoogleTokenVerifierService {
  private readonly client: OAuth2Client;
  private readonly audience: string;

  constructor(@Inject(APP_CONFIG) env: Pick<Env, 'GOOGLE_CLIENT_ID'>) {
    this.audience = env.GOOGLE_CLIENT_ID;
    this.client = new OAuth2Client(this.audience);
  }

  async verify(idToken: string): Promise<GoogleIdentity> {
    try {
      const ticket = await this.client.verifyIdToken({
        idToken,
        audience: this.audience,
      });
      const payload = ticket.getPayload();
      if (!payload?.sub) {
        throw new GoogleTokenInvalidException();
      }
      return {
        googleId: payload.sub,
        email: payload.email,
        emailVerified: payload.email_verified ?? false,
      };
    } catch (error) {
      if (error instanceof GoogleTokenInvalidException) throw error;
      throw new GoogleTokenInvalidException();
    }
  }
}
