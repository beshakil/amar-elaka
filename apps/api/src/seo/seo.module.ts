import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FeedModule } from '../feed/feed.module';
import { SettingsModule } from '../settings/settings.module';
import { StorageModule } from '../storage/storage.module';
import { OgImageController } from './og-image/og-image.controller';
import { OgImageService } from './og-image/og-image.service';
import { PublicStoresController, SeoController } from './seo.controller';
import { SeoRepository } from './seo.repository';
import { SeoService } from './seo.service';

/** What the public web pages need to answer crawlers (ADR 039): statuses, sitemaps, stores, share images. */
@Module({
  imports: [AuthModule, SettingsModule, StorageModule, FeedModule],
  controllers: [SeoController, PublicStoresController, OgImageController],
  providers: [SeoService, SeoRepository, OgImageService],
})
export class SeoModule {}
