import type { MediaFileDto } from './sendMessage.dto';

/**
 * Payload for sending to a chat that is already known by its WhatsApp id, which is the only
 * way to reach a group: a group has no phone number to resolve.
 */
export interface SendToChatDto {
  /**
   * Target chat id as `GET /chats` reports it — `<id>@g.us` for a group, `<id>@c.us` for a
   * one-to-one chat, `<id>@lid` for a linked identity, `<id>@newsletter` for a channel.
   * A bare number is accepted too and read as `<number>@c.us`, and `<a>-<b>` as `<a>-<b>@g.us`.
   * @example "120363412778233770@g.us"
   */
  chatId: string;

  /**
   * Text body of the message. Optional when at least one file is attached; when files are
   * attached it is delivered as the caption of the first file, in the same message.
   * @example "Вітаємо! Ваше замовлення прийнято."
   */
  message?: string;

  /**
   * Optional attachments, base64-encoded. Photos, videos and audio are delivered as inline
   * media (a picture or player in the chat) whenever WhatsApp accepts them that way, and fall
   * back to a document otherwise; every other file type is delivered as a document.
   */
  files?: MediaFileDto[];

  /**
   * Sends this as a reply to that message, by the `messageId` an earlier send answered with.
   * With several files, the first one is the reply. The message always goes out: one WhatsApp
   * can no longer find, or a chat that has no replies (a channel), gets it without the quote.
   * @example "true_120363412778233770@g.us_3EB0C767D26A8B0F1E2A_380501234567@c.us"
   */
  quotedMessageId?: string;

  /**
   * Caller-supplied key that makes this send idempotent. Retrying with the same key
   * returns the original result instead of delivering the message a second time.
   * @example "0f8b9d3a-2c4e-4f1a-9b7d-5e6c8a0d1f23"
   */
  idempotencyKey?: string;
}
