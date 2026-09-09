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
   * Optional attachments, base64-encoded.
   */
  files?: MediaFileDto[];

  /**
   * Caller-supplied key that makes this send idempotent. Retrying with the same key
   * returns the original result instead of delivering the message a second time.
   * @example "0f8b9d3a-2c4e-4f1a-9b7d-5e6c8a0d1f23"
   */
  idempotencyKey?: string;
}
