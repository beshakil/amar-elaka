import { Module } from '@nestjs/common';
import { APP_CONFIG } from '../../../config/config.module';
import type { Env } from '../../../config/env.schema';
import { BdGatewaySmsProvider } from './bd-gateway-sms.provider';
import { LocalSmsProvider } from './local-sms.provider';
import { SMS_PROVIDER, type SmsProvider } from './sms-provider.interface';

@Module({
  providers: [
    LocalSmsProvider,
    BdGatewaySmsProvider,
    {
      provide: SMS_PROVIDER,
      inject: [APP_CONFIG, LocalSmsProvider, BdGatewaySmsProvider],
      useFactory: (
        env: Env,
        local: LocalSmsProvider,
        bdGateway: BdGatewaySmsProvider,
      ): SmsProvider => (env.SMS_PROVIDER === 'local' ? local : bdGateway),
    },
  ],
  exports: [SMS_PROVIDER],
})
export class SmsProviderModule {}
