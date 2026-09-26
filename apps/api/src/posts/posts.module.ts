import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CategoriesModule } from '../categories/categories.module';
import { LocationsModule } from '../locations/locations.module';
import { ModerationModule } from '../moderation/moderation.module';
import { RbacModule } from '../rbac/rbac.module';
import { SettingsModule } from '../settings/settings.module';
import { StorageModule } from '../storage/storage.module';
import { TrustModule } from '../trust/trust.module';
import { POST_IDEMPOTENCY_STORE, RedisPostIdempotencyStore } from './post-idempotency.store';
import { PostOwnershipService } from './post-ownership.service';
import { PostsController } from './posts.controller';
import { PostsRepository } from './posts.repository';
import { PostsService } from './posts.service';

/** The HTTP side of posts (/api/v1/posts). The expiry sweep lives in PostsWorkerModule. */
@Module({
  imports: [
    AuthModule,
    RbacModule,
    SettingsModule,
    StorageModule,
    CategoriesModule,
    LocationsModule,
    ModerationModule,
    TrustModule,
  ],
  controllers: [PostsController],
  providers: [
    PostsService,
    PostsRepository,
    PostOwnershipService,
    { provide: POST_IDEMPOTENCY_STORE, useClass: RedisPostIdempotencyStore },
  ],
})
export class PostsModule {}
