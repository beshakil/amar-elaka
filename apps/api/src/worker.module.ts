import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { APP_CONFIG, ConfigModule } from './config/config.module';
import type { Env } from './config/env.schema';
import { DatabaseModule } from './database/database.module';
import { buildPinoHttpOptions } from './logging/pino-http-options';
import { MailModule } from './mail/mail.module';
import { GeoWorkerModule } from './locations/geocoding/geo-worker.module';
import { MaintenanceModule } from './maintenance/maintenance.module';
import { MediaWorkerModule } from './media/media-worker.module';
import { MapWorkerModule } from './map/offline/map-worker.module';
import { NotificationsWorkerModule } from './notifications/notifications-worker.module';
import { PlacesWorkerModule } from './places/places-worker.module';
import { PostsWorkerModule } from './posts/posts-worker.module';
import { QueueModule } from './queue/queue.module';
import { SavedSearchesWorkerModule } from './saved-searches/saved-searches-worker.module';
import { SearchWorkerModule } from './search/indexing/search-worker.module';
import { StoreImportWorkerModule } from './stores/import/store-import-worker.module';

/**
 * The standalone worker process (worker.ts) — no HTTP listener, just enough
 * modules to run BullMQ processors. Same image as the API (apps/api/Dockerfile),
 * run with a different CMD (`node dist/worker.js`).
 *
 * MailModule is ALSO imported by AppModule so `pnpm dev` alone still delivers
 * mail without this process running; MaintenanceModule is worker-only —
 * partition upkeep has no business being triggered by an HTTP request.
 */
@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    LoggerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (env: Env) => ({ pinoHttp: buildPinoHttpOptions(env) }),
    }),
    QueueModule,
    MailModule,
    MaintenanceModule,
    GeoWorkerModule,
    MediaWorkerModule,
    MapWorkerModule,
    NotificationsWorkerModule,
    PlacesWorkerModule,
    PostsWorkerModule,
    SavedSearchesWorkerModule,
    SearchWorkerModule,
    StoreImportWorkerModule,
  ],
})
export class WorkerModule {}
