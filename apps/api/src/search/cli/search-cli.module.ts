import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { APP_CONFIG, ConfigModule } from '../../config/config.module';
import type { Env } from '../../config/env.schema';
import { DatabaseModule } from '../../database/database.module';
import { buildPinoHttpOptions } from '../../logging/pino-http-options';
import { SearchIndexingModule } from '../indexing/search-indexing.module';

/** Just enough of the app for `search:reindex`: config, database, settings, the indexer. */
@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    LoggerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (env: Env) => ({ pinoHttp: buildPinoHttpOptions(env) }),
    }),
    SearchIndexingModule,
  ],
})
export class SearchCliModule {}
