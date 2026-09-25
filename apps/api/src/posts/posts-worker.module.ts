import { Module } from '@nestjs/common';
import { PostExpiryService } from './post-expiry.service';
import { PostsRepository } from './posts.repository';
import { PostsSchedule } from './posts-schedule';
import { PostsProcessor } from './posts.processor';

/** The worker side of posts (WorkerModule only): the scheduled live → expired sweep. */
@Module({
  providers: [PostsRepository, PostExpiryService, PostsProcessor, PostsSchedule],
})
export class PostsWorkerModule {}
