import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { ChatConversationsService } from './chat-conversations.service';
import { ChatImagesService } from './chat-images.service';
import { ChatMessagesService } from './chat-messages.service';
import { ChatReportsService } from './chat-reports.service';
import {
  ChatImageParamDto,
  ChatImagePresignDto,
  ChatImagePresignedDto,
  ChatImageStatusDto,
  ChatReportDecisionDto,
  ChatReportDecisionResultDto,
  ChatReportDetailDto,
  ChatReportQueueDto,
  ChatReportQueueQueryDto,
  ConversationIdParamDto,
  ConversationViewDto,
  HistoryPageDto,
  HistoryQueryDto,
  ChatInboxPageDto,
  ChatInboxQueryDto,
  OpenConversationDto,
  OpenConversationResultDto,
  QuickReplyBodyDto,
  QuickReplyListDto,
  QuickReplyParamDto,
  QuickReplyViewDto,
  ReceiptDto,
  ReceiptResultDto,
  ReportConversationDto,
  ReportIdParamDto,
  ChatReportResultDto,
  SendMessageDto,
  SendResultDto,
  TargetIdParamDto,
  type ChatImagePresigned,
  type ChatImageStatus,
  type ChatReportDecisionResult,
  type ChatReportDetail,
  type ChatReportQueue,
  type ConversationView,
  type HistoryPage,
  type InboxPage,
  type OpenConversationResult,
  type QuickReplyList,
  type QuickReplyView,
  type ReceiptResult,
  type ReportResult,
  type SendResult,
} from './dto/chat.dto';
import { QuickRepliesService } from './quick-replies.service';

/**
 * Chat over REST (ADR 058): history and the inbox, and every action the
 * socket offers, for clients that can't hold a socket. A conversation may
 * live in another tenant than the caller's token (ChatScope switches); the
 * socket is wss://…/api/v1/chat/socket.io, namespace /chat.
 */
@Controller({ version: '1' })
@UseGuards(JwtAuthGuard)
export class ChatController {
  constructor(
    private readonly conversations: ChatConversationsService,
    private readonly messages: ChatMessagesService,
    private readonly images: ChatImagesService,
    private readonly quickReplies: QuickRepliesService,
  ) {}

  /** The caller's conversation about this post: opened, or the existing one returned. */
  @Post('posts/:id/conversations')
  @ApiCreatedResponse({ type: OpenConversationResultDto })
  openForPost(
    @Param() params: TargetIdParamDto,
    @Body() body: OpenConversationDto,
  ): Promise<OpenConversationResult> {
    return this.conversations.openForPost(params.id, body);
  }

  /** The caller's conversation with this store: opened, or the existing one returned. */
  @Post('stores/:id/conversations')
  @ApiCreatedResponse({ type: OpenConversationResultDto })
  openForStore(
    @Param() params: TargetIdParamDto,
    @Body() body: OpenConversationDto,
  ): Promise<OpenConversationResult> {
    return this.conversations.openForStore(params.id, body);
  }

  /** Every conversation the caller is in, in any tenant, newest activity first (`archived=true`: the archive). */
  @Get('conversations')
  @ApiOkResponse({ type: ChatInboxPageDto })
  inbox(@Query() query: ChatInboxQueryDto): Promise<InboxPage> {
    return this.conversations.inbox(query);
  }

  @Get('conversations/:id')
  @ApiOkResponse({ type: ConversationViewDto })
  get(@Param() params: ConversationIdParamDto): Promise<ConversationView> {
    return this.conversations.get(params.id);
  }

  /** Newest first (`before` to scroll up); `after` returns what was missed, oldest first. */
  @Get('conversations/:id/messages')
  @ApiOkResponse({ type: HistoryPageDto })
  history(
    @Param() params: ConversationIdParamDto,
    @Query() query: HistoryQueryDto,
  ): Promise<HistoryPage> {
    return this.conversations.history(params.id, query);
  }

  /** The same as the socket's message:send; resending a clientMessageId returns the stored message. */
  @Post('conversations/:id/messages')
  @ApiCreatedResponse({ type: SendResultDto })
  send(@Param() params: ConversationIdParamDto, @Body() body: SendMessageDto): Promise<SendResult> {
    return this.messages.send(params.id, body);
  }

  @Post('conversations/:id/delivered')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: ReceiptResultDto })
  delivered(
    @Param() params: ConversationIdParamDto,
    @Body() body: ReceiptDto,
  ): Promise<ReceiptResult> {
    return this.conversations.receipt(params.id, body.upToMessageId, 'delivered');
  }

  @Post('conversations/:id/read')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: ReceiptResultDto })
  read(@Param() params: ConversationIdParamDto, @Body() body: ReceiptDto): Promise<ReceiptResult> {
    return this.conversations.receipt(params.id, body.upToMessageId, 'read');
  }

  /** Out of the inbox for the caller (it comes back with the next message). */
  @Post('conversations/:id/archive')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: ConversationViewDto })
  archive(@Param() params: ConversationIdParamDto): Promise<ConversationView> {
    return this.conversations.setArchived(params.id, true);
  }

  @Delete('conversations/:id/archive')
  @ApiOkResponse({ type: ConversationViewDto })
  unarchive(@Param() params: ConversationIdParamDto): Promise<ConversationView> {
    return this.conversations.setArchived(params.id, false);
  }

  /** Block the other side (everywhere, not only here). */
  @Post('conversations/:id/block')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: ConversationViewDto })
  block(@Param() params: ConversationIdParamDto): Promise<ConversationView> {
    return this.conversations.block(params.id);
  }

  @Delete('conversations/:id/block')
  @ApiOkResponse({ type: ConversationViewDto })
  unblock(@Param() params: ConversationIdParamDto): Promise<ConversationView> {
    return this.conversations.unblock(params.id);
  }

  /** Report it to the area's moderators, with the conversation attached as evidence. */
  @Post('conversations/:id/report')
  @ApiCreatedResponse({ type: ChatReportResultDto })
  report(
    @Param() params: ConversationIdParamDto,
    @Body() body: ReportConversationDto,
  ): Promise<ReportResult> {
    return this.conversations.report(params.id, body);
  }

  /** Upload a photo for this conversation: PUT it to `upload.url`, then confirm. */
  @Post('conversations/:id/images')
  @ApiCreatedResponse({ type: ChatImagePresignedDto })
  presignImage(
    @Param() params: ConversationIdParamDto,
    @Body() body: ChatImagePresignDto,
  ): Promise<ChatImagePresigned> {
    return this.images.presign(params.id, body);
  }

  @Post('conversations/:id/images/:mediaId/confirm')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiAcceptedResponse({ type: ChatImageStatusDto })
  confirmImage(@Param() params: ChatImageParamDto): Promise<ChatImageStatus> {
    return this.images.confirm(params.id, params.mediaId);
  }

  /** Poll until `ready`, then send it as an image message. */
  @Get('conversations/:id/images/:mediaId')
  @ApiOkResponse({ type: ChatImageStatusDto })
  imageStatus(@Param() params: ChatImageParamDto): Promise<ChatImageStatus> {
    return this.images.status(params.id, params.mediaId);
  }

  /** The store's quick replies for the composer (seller side of a store conversation; else empty). */
  @Get('conversations/:id/quick-replies')
  @ApiOkResponse({ type: QuickReplyListDto })
  composerQuickReplies(@Param() params: ConversationIdParamDto): Promise<QuickReplyList> {
    return this.quickReplies.forConversation(params.id);
  }
}

/** A store's quick replies (ADR 058): its owner and managers. */
@Controller({ path: 'stores/:id/quick-replies', version: '1' })
@UseGuards(JwtAuthGuard)
export class StoreQuickRepliesController {
  constructor(private readonly quickReplies: QuickRepliesService) {}

  @Get()
  @ApiOkResponse({ type: QuickReplyListDto })
  list(@Param() params: TargetIdParamDto): Promise<QuickReplyList> {
    return this.quickReplies.list(params.id);
  }

  @Post()
  @ApiCreatedResponse({ type: QuickReplyViewDto })
  create(
    @Param() params: TargetIdParamDto,
    @Body() body: QuickReplyBodyDto,
  ): Promise<QuickReplyView> {
    return this.quickReplies.create(params.id, body);
  }

  @Patch(':replyId')
  @ApiOkResponse({ type: QuickReplyViewDto })
  update(
    @Param() params: QuickReplyParamDto,
    @Body() body: QuickReplyBodyDto,
  ): Promise<QuickReplyView> {
    return this.quickReplies.update(params.id, params.replyId, body);
  }

  @Delete(':replyId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  remove(@Param() params: QuickReplyParamDto): Promise<void> {
    return this.quickReplies.remove(params.id, params.replyId);
  }
}

/** Conversation reports for the area's moderators (ADR 058). */
@Controller({ path: 'chat-reports', version: '1' })
export class ChatReportsController {
  constructor(private readonly reports: ChatReportsService) {}

  /** Open conversation reports, oldest first. */
  @Get('queue')
  @RequirePermission('reports', 'read')
  @ApiOkResponse({ type: ChatReportQueueDto })
  queue(@Query() query: ChatReportQueueQueryDto): Promise<ChatReportQueue> {
    return this.reports.queue(query);
  }

  /** The report with its transcript snapshot — the evidence. */
  @Get(':id')
  @RequirePermission('reports', 'read')
  @ApiOkResponse({ type: ChatReportDetailDto })
  detail(@Param() params: ReportIdParamDto): Promise<ChatReportDetail> {
    return this.reports.detail(params.id);
  }

  /** lock (with a reason) or dismiss; either writes a moderation_actions row. */
  @Post(':id/decision')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('reports', 'approve')
  @ApiOkResponse({ type: ChatReportDecisionResultDto })
  decide(
    @Param() params: ReportIdParamDto,
    @Body() body: ChatReportDecisionDto,
  ): Promise<ChatReportDecisionResult> {
    return this.reports.decide(params.id, body.decision);
  }
}
