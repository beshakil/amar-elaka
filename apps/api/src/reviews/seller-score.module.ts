import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { ReviewsRepository } from './reviews.repository';
import { SellerScoreService } from './seller-score.service';

/**
 * The seller score on its own (ADR 061), so the store page, the post detail
 * and the reviews module all read the one implementation without importing
 * each other.
 */
@Module({
  imports: [SettingsModule],
  providers: [ReviewsRepository, SellerScoreService],
  exports: [SellerScoreService, ReviewsRepository],
})
export class SellerScoreModule {}
