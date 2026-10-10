import { Injectable } from '@nestjs/common';
import { TenantDb } from '../database/tenant-db';
import { MediaService } from '../media/media.service';
import { MediaAssetNotFoundException } from '../storage/storage.exceptions';
import { ChatScope } from './chat-scope';
import { ChatRepository } from './chat.repository';
import type { ChatImagePresignInput, ChatImagePresigned, ChatImageStatus } from './dto/chat.dto';

/**
 * Photos in a chat (ADR 058). The upload is the media pipeline's own
 * (MediaService: rate limits, size and type checks, magic bytes, then the
 * worker strips every bit of metadata — GPS included — and writes the
 * variants), but as a private `chat_image` in the conversation's tenant:
 * the message's media FK is same-tenant, and the conversation's tenant
 * isn't necessarily the caller's. Participants see it only through the
 * signed, short-lived URLs in a message (ChatViews); nobody else ever does.
 */
@Injectable()
export class ChatImagesService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly scope: ChatScope,
    private readonly media: MediaService,
    private readonly repo: ChatRepository,
  ) {}

  presign(conversationId: string, input: ChatImagePresignInput): Promise<ChatImagePresigned> {
    return this.scope.inConversation(conversationId, async () => {
      const presigned = await this.media.presign({ ...input, kind: 'chat_image' });
      return { mediaId: presigned.id, upload: presigned.upload };
    });
  }

  confirm(conversationId: string, mediaId: string): Promise<ChatImageStatus> {
    return this.scope.inConversation(conversationId, async () => {
      await this.requireOwnChatImage(mediaId);
      const status = await this.media.confirm(mediaId);
      return { mediaId, status: status.status };
    });
  }

  status(conversationId: string, mediaId: string): Promise<ChatImageStatus> {
    return this.scope.inConversation(conversationId, async () => {
      const status = await this.requireOwnChatImage(mediaId);
      return { mediaId, status: status as ChatImageStatus['status'] };
    });
  }

  /** Only the caller's own chat images here: confirm can't be pointed at another kind of upload. */
  private async requireOwnChatImage(mediaId: string): Promise<string> {
    const status = await this.tenantDb.transaction(
      (tx) => this.repo.ownChatImageStatus(tx, mediaId),
      {
        accessMode: 'read only',
      },
    );
    if (!status) throw new MediaAssetNotFoundException();
    return status;
  }
}
