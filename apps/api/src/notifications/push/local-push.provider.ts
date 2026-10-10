import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { PushMessage, PushProvider, PushResult } from './push-provider';

// settings-exempt: how much of a token the log shows (enough to tell devices apart)
const TOKEN_PREVIEW = 6;

/**
 * PUSH_PROVIDER=local (dev, tests): logs the push instead of sending it.
 * Never the token in full — the log is not a place for device identifiers.
 */
@Injectable()
export class LocalPushProvider implements PushProvider {
  readonly name = 'local';

  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext(LocalPushProvider.name);
  }

  send(message: PushMessage): Promise<PushResult> {
    this.logger.info(
      {
        platform: message.platform,
        token: `${message.token.slice(0, TOKEN_PREVIEW)}…`,
        title: message.title,
        body: message.body,
        collapseKey: message.collapseKey,
      },
      'push (local provider, not sent)',
    );
    return Promise.resolve({ ok: true, messageId: 'local' });
  }
}
