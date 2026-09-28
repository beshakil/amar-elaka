import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { UnmetDemandService } from './unmet-demand.service';

/** The worker side of analytics: the unmet-demand refresh (ADR 041). */
@Module({
  imports: [SettingsModule],
  providers: [UnmetDemandService],
  exports: [UnmetDemandService],
})
export class AnalyticsWorkerModule {}
