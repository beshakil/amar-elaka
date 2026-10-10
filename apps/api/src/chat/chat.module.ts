import { Module } from '@nestjs/common';
import { AnalyticsCountersModule } from '../analytics/seller/analytics-counters.module';
import { AuthModule } from '../auth/auth.module';
import { EngagementModule } from '../engagement/engagement.module';
import { FeedModule } from '../feed/feed.module';
import { MediaModule } from '../media/media.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PostsModule } from '../posts/posts.module';
import { RbacModule } from '../rbac/rbac.module';
import { SettingsModule } from '../settings/settings.module';
import { StorageModule } from '../storage/storage.module';
import { ChatConversationsService } from './chat-conversations.service';
import { ChatImagesService } from './chat-images.service';
import { ChatMessagesService } from './chat-messages.service';
import { ChatNotifier } from './chat-notifier';
import { ChatReportsService } from './chat-reports.service';
import { ChatScope } from './chat-scope';
import { ChatViews } from './chat-views';
import {
  ChatController,
  ChatReportsController,
  StoreQuickRepliesController,
} from './chat.controller';
import { ChatRepository } from './chat.repository';
import { CHAT_STORE, RedisChatStore } from './chat.store';
import { QuickRepliesService } from './quick-replies.service';
import { ChatBroadcaster } from './realtime/chat-broadcaster';
import { ChatSocketServer } from './realtime/chat-socket.server';

/**
 * Chat (ADR 058): conversations about a post or a store, realtime over a
 * Socket.IO server shared across API instances through Redis, with REST for
 * history and for clients without a socket. Reuses, never re-implements:
 * the owning tenant switch (PostsModule), the pre-filter's phone and link
 * matchers, the contact leads' insertLead (EngagementModule), the feed's
 * post card, the media pipeline, and NotificationService.
 */
@Module({
  imports: [
    AuthModule,
    RbacModule,
    SettingsModule,
    StorageModule,
    MediaModule,
    PostsModule,
    FeedModule,
    EngagementModule,
    NotificationsModule,
    AnalyticsCountersModule,
  ],
  controllers: [ChatController, StoreQuickRepliesController, ChatReportsController],
  providers: [
    ChatRepository,
    ChatScope,
    ChatViews,
    ChatConversationsService,
    ChatMessagesService,
    ChatImagesService,
    ChatReportsService,
    QuickRepliesService,
    ChatNotifier,
    ChatBroadcaster,
    ChatSocketServer,
    { provide: CHAT_STORE, useClass: RedisChatStore },
  ],
})
export class ChatModule {}
