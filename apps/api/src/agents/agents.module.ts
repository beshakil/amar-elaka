import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PlacesModule } from '../places/places.module';
import { PostsModule } from '../posts/posts.module';
import { SettingsModule } from '../settings/settings.module';
import { StorageModule } from '../storage/storage.module';
import { AgentSubmissionsService } from './agent-submissions.service';
import { AgentWorkService } from './agent-work.service';
import { AgentController, AgentsAdminController } from './agents.controller';
import { AgentsAdminService } from './agents-admin.service';
import { AgentsRepository } from './agents.repository';

/**
 * Field agent mode (ADR 066): the phone's agent side (offline captures synced
 * exactly once, today's route, stats, shop phone checks) and the area team's
 * agent management. New shops reuse the places module — its rules, its
 * duplicate detection and its review queue.
 */
@Module({
  imports: [AuthModule, SettingsModule, StorageModule, PostsModule, PlacesModule],
  controllers: [AgentController, AgentsAdminController],
  providers: [AgentsRepository, AgentSubmissionsService, AgentWorkService, AgentsAdminService],
})
export class AgentsModule {}
