import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { TrustScoreService } from './trust-score.service';
import { TrustRepository } from './trust.repository';

/** Member trust scores (ADR 030). */
@Module({
  imports: [SettingsModule],
  providers: [TrustScoreService, TrustRepository],
  exports: [TrustScoreService],
})
export class TrustModule {}
