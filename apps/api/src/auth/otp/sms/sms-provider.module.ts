import { Module } from '@nestjs/common';
import { APP_CONFIG } from '../../../config/config.module';
import type { Env } from '../../../config/env.schema';
import { BulkSmsBdProvider } from './bulksmsbd-sms.provider';
import { LocalSmsProvider } from './local-sms.provider';
import { SMS_PROVIDER, type SmsProvider } from './sms-provider.interface';

@Module({
  providers: [
    LocalSmsProvider,
    BulkSmsBdProvider,
    {
      provide: SMS_PROVIDER,
      inject: [APP_CONFIG, LocalSmsProvider, BulkSmsBdProvider],
      // SMS_PROVIDER (env.schema.ts): local logs, bulksmsbd sends (ADR 053).
      useFactory: (env: Env, local: LocalSmsProvider, bulkSmsBd: BulkSmsBdProvider): SmsProvider =>
        env.SMS_PROVIDER === 'bulksmsbd' ? bulkSmsBd : local,
    },
  ],
  exports: [SMS_PROVIDER],
})
export class SmsProviderModule {}
