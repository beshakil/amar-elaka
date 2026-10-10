import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../common/exceptions/domain-exception';

/**
 * Chat's typed errors (ADR 058). The same classes answer over REST (the
 * global filter) and over the socket (the ack's `error`, chat-socket.ts):
 * `code` and `issues` only, never SQL or a stack. Clients show the Bengali
 * text for the code; the English message is for logs and API explorers.
 */

/** No such conversation, or not one of the caller's: the two look the same. */
export class ConversationNotFoundException extends DomainException {
  readonly code = 'CHAT_CONVERSATION_NOT_FOUND';
  readonly httpStatus = HttpStatus.NOT_FOUND;

  constructor() {
    super('Conversation not found.');
  }
}

/** The post isn't live (or the store isn't active) any more: no new conversation about it. */
export class ChatTargetUnavailableException extends DomainException {
  readonly code = 'CHAT_TARGET_UNAVAILABLE';
  readonly httpStatus = HttpStatus.NOT_FOUND;

  constructor() {
    super('This listing cannot be messaged.');
  }
}

export class ChatOwnListingException extends DomainException {
  readonly code = 'CHAT_OWN_LISTING';
  readonly httpStatus = HttpStatus.UNPROCESSABLE_ENTITY;

  constructor() {
    super('You cannot message your own listing.');
  }
}

/** Either side blocked the other; the caller isn't told which. */
export class ChatBlockedException extends DomainException {
  readonly code = 'CHAT_BLOCKED';
  readonly httpStatus = HttpStatus.FORBIDDEN;

  constructor() {
    super('You cannot send messages in this conversation.');
  }
}

/** A moderator locked the conversation. */
export class ChatLockedException extends DomainException {
  readonly code = 'CHAT_LOCKED';
  readonly httpStatus = HttpStatus.FORBIDDEN;

  constructor() {
    super('This conversation has been closed by a moderator.');
  }
}

/**
 * The gentle soft block (ADR 058): a phone number or a link in the
 * conversation's first messages is held back, not stored, not delivered.
 * The client keeps the text in the composer and points to the contact
 * button (a tracked lead). `remaining` is how many more messages until the
 * check stops.
 */
export class ChatContactInfoBlockedException extends DomainException {
  readonly code = 'CHAT_CONTACT_INFO_BLOCKED';
  readonly httpStatus = HttpStatus.UNPROCESSABLE_ENTITY;
  readonly issues: { found: 'phone' | 'link'; remaining: number };

  constructor(found: 'phone' | 'link', remaining: number) {
    super('Share contact details through the contact button for now.');
    this.issues = { found, remaining };
  }
}

export class ChatRateLimitedException extends DomainException {
  readonly code = 'CHAT_RATE_LIMITED';
  readonly httpStatus = HttpStatus.TOO_MANY_REQUESTS;
  readonly issues: { limit: number; window: 'minute' | 'day' };

  constructor(limit: number, window: 'minute' | 'day') {
    super('You are sending too fast. Please wait a moment.');
    this.issues = { limit, window };
  }
}

export class ChatMessageTooLongException extends DomainException {
  readonly code = 'CHAT_MESSAGE_TOO_LONG';
  readonly httpStatus = HttpStatus.UNPROCESSABLE_ENTITY;
  readonly issues: { max: number };

  constructor(max: number) {
    super(`A message can be at most ${max} characters.`);
    this.issues = { max };
  }
}

/** The image isn't the sender's own ready chat image in this conversation's area. */
export class ChatImageInvalidException extends DomainException {
  readonly code = 'CHAT_IMAGE_INVALID';
  readonly httpStatus = HttpStatus.UNPROCESSABLE_ENTITY;

  constructor() {
    super('Upload the photo for this conversation first and wait until it is ready.');
  }
}

/** A listing card for a post that isn't publicly visible. */
export class ChatListingUnavailableException extends DomainException {
  readonly code = 'CHAT_LISTING_UNAVAILABLE';
  readonly httpStatus = HttpStatus.UNPROCESSABLE_ENTITY;

  constructor() {
    super('That listing cannot be shared.');
  }
}

/** The message to mark read/delivered isn't in this conversation. */
export class ChatMessageNotFoundException extends DomainException {
  readonly code = 'CHAT_MESSAGE_NOT_FOUND';
  readonly httpStatus = HttpStatus.NOT_FOUND;

  constructor() {
    super('Message not found.');
  }
}

/** The socket event or its payload isn't one the server knows. */
export class ChatEventInvalidException extends DomainException {
  readonly code = 'CHAT_EVENT_INVALID';
  readonly httpStatus = HttpStatus.BAD_REQUEST;
  readonly issues: { path: string; message: string }[];

  constructor(issues: { path: string; message: string }[]) {
    super('Invalid chat event.');
    this.issues = issues;
  }
}

export class ChatReportDetailsTooLongException extends DomainException {
  readonly code = 'CHAT_REPORT_DETAILS_TOO_LONG';
  readonly httpStatus = HttpStatus.UNPROCESSABLE_ENTITY;
  readonly issues: { max: number };

  constructor(max: number) {
    super(`Report details can be at most ${max} characters.`);
    this.issues = { max };
  }
}

export class ChatReportNotFoundException extends DomainException {
  readonly code = 'CHAT_REPORT_NOT_FOUND';
  readonly httpStatus = HttpStatus.NOT_FOUND;

  constructor() {
    super('No open report with that id.');
  }
}

/** Only a store's owner and managers keep its quick replies. */
export class QuickRepliesForbiddenException extends DomainException {
  readonly code = 'CHAT_QUICK_REPLIES_FORBIDDEN';
  readonly httpStatus = HttpStatus.FORBIDDEN;

  constructor() {
    super('Only the store owner and managers manage quick replies.');
  }
}

export class QuickReplyLimitReachedException extends DomainException {
  readonly code = 'CHAT_QUICK_REPLY_LIMIT_REACHED';
  readonly httpStatus = HttpStatus.UNPROCESSABLE_ENTITY;
  readonly issues: { max: number };

  constructor(max: number) {
    super(`A store can keep at most ${max} quick replies.`);
    this.issues = { max };
  }
}

export class QuickReplyTooLongException extends DomainException {
  readonly code = 'CHAT_QUICK_REPLY_TOO_LONG';
  readonly httpStatus = HttpStatus.UNPROCESSABLE_ENTITY;
  readonly issues: { max: number };

  constructor(max: number) {
    super(`A quick reply can be at most ${max} characters.`);
    this.issues = { max };
  }
}

export class QuickReplyNotFoundException extends DomainException {
  readonly code = 'CHAT_QUICK_REPLY_NOT_FOUND';
  readonly httpStatus = HttpStatus.NOT_FOUND;

  constructor() {
    super('Quick reply not found.');
  }
}
