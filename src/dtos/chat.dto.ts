/**
 * One chat the linked WhatsApp account can see. This is how you find the ids to put in
 * `RABBITMQ_CHAT_IDS`: read the list, take the `id` of the chats you want forwarded.
 */
export interface ChatSummaryDto {
  /**
   * The chat id, exactly as the forward allowlist expects it. Groups end in `@g.us`,
   * one-to-one chats in `@c.us`, and linked-identity threads in `@lid`.
   * @example "120363412778233770@g.us"
   */
  id: string;

  /** Display name of the chat or contact, when WhatsApp exposes one. */
  name?: string;

  /** True for group chats. */
  isGroup?: boolean;

  /** Unix time (seconds) of the last activity in the chat. */
  timestamp?: number;

  /** Unread messages WhatsApp reports for this chat. */
  unreadCount?: number;

  /**
   * Whether messages from this chat are currently forwarded, i.e. the id is in
   * `RABBITMQ_CHAT_IDS` (or the allowlist is empty, which forwards everything).
   */
  forwarded: boolean;
}

/**
 * The chat list plus what could not be read. WhatsApp occasionally serves a chat the client
 * library cannot model; those are reported here by id instead of failing the whole listing.
 */
export interface ChatListResponse {
  chats: ChatSummaryDto[];

  /** Ids that could not be loaded. Their messages are also skipped by reconcile. */
  unreadableChatIds: string[];

  /**
   * The configured forward allowlist. Empty means every chat is forwarded.
   */
  allowlist: string[];
}
