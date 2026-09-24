import { Global, Module } from '@nestjs/common';
import { env } from './env';

export const APP_CONFIG = Symbol('APP_CONFIG');

/**
 * Exposes the already-validated env (see env.ts) via DI so services never
 * re-read process.env directly.
 */
@Global()
@Module({
  providers: [{ provide: APP_CONFIG, useValue: env }],
  exports: [APP_CONFIG],
})
export class ConfigModule {}
