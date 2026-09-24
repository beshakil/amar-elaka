import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

// A hash of a value nobody will ever type, used to keep verify() at a
// constant time whether or not an account was found — see verify() below.
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$C5exSNhO0dU9WoAiUEIrKQ2c1r1PS+CQjs9jd9fF2FE';

@Injectable()
export class PasswordService {
  hash(plain: string): Promise<string> {
    return argon2.hash(plain, {
      type: argon2.argon2id,
      // settings-exempt: OWASP-recommended argon2id memory cost, a crypto tuning constant, not a business threshold.
      memoryCost: 19456,
      // settings-exempt: OWASP-recommended argon2id time cost, a crypto tuning constant, not a business threshold.
      timeCost: 2,
      parallelism: 1,
    });
  }

  /**
   * Verifies against `hash`, or against a fixed dummy hash when `hash` is
   * undefined (no account, or an account with no password set) — so a
   * missing account and a wrong password take the same time and the caller
   * never has to branch on "does this email exist" before hashing.
   */
  async verify(hash: string | null | undefined, plain: string): Promise<boolean> {
    const target = hash ?? DUMMY_HASH;
    const matches = await argon2.verify(target, plain);
    return matches && hash != null;
  }
}
