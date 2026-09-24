import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { APP_CONFIG } from '../config/config.module';
import type { Env } from '../config/env.schema';
import { SettingsModule } from '../settings/settings.module';
import { AuthController } from './auth.controller';
import { AuthRepository } from './auth.repository';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from './guards/optional-jwt-auth.guard';
import { GoogleTokenVerifierService } from './google/google-token-verifier.service';
import { OTP_STORE } from './otp/otp-store.ports';
import { OtpService } from './otp/otp.service';
import { RedisOtpStore } from './otp/redis-otp.store';
import { SmsProviderModule } from './otp/sms/sms-provider.module';
import { PasswordService } from './password/password.service';
import { TokenService } from './tokens/token.service';

@Module({
  imports: [
    SettingsModule,
    SmsProviderModule,
    JwtModule.registerAsync({
      inject: [APP_CONFIG],
      useFactory: (env: Env) => ({
        secret: env.JWT_SECRET,
        signOptions: { expiresIn: env.JWT_ACCESS_TTL },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    AuthRepository,
    OtpService,
    { provide: OTP_STORE, useClass: RedisOtpStore },
    TokenService,
    PasswordService,
    GoogleTokenVerifierService,
    JwtAuthGuard,
    OptionalJwtAuthGuard,
  ],
  // JwtAuthGuard is reused outside this module (@UseGuards in RbacModule and
  // StorageModule, and by PlatformAdminGuard). A guard named in @UseGuards is
  // constructed in the *consuming* module's scope, so its own dependency —
  // TokenService — must be exported too, or that module cannot build it.
  exports: [JwtAuthGuard, TokenService],
})
export class AuthModule {}
