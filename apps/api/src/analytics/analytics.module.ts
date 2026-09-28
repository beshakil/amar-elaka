import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RbacModule } from '../rbac/rbac.module';
import { SettingsModule } from '../settings/settings.module';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';
import { UnmetDemandController } from './unmet-demand.controller';
import { UnmetDemandService } from './unmet-demand.service';

/** Tenant analytics read endpoints (ADR 037, ADR 041). */
@Module({
  imports: [AuthModule, RbacModule, SettingsModule],
  controllers: [AnalyticsController, UnmetDemandController],
  providers: [AnalyticsService, UnmetDemandService],
})
export class AnalyticsModule {}
