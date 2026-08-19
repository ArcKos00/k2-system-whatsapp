/**
 * What kind of thread the id points at. Derived from the id's server part, so it is known
 * even for a chat WhatsApp would not let the library model.
 */
export type ChatKind = 'group' | 'private' | 'lid' | 'channel' | 'broadcast' | 'unknown';

/**
 * Where `name` came from. Useful when a listing looks wrong: `number` or `fallback` means
 * WhatsApp gave us nothing human-readable for that chat, not that the gateway dropped it.
 */
export type ChatNameSource =
  | 'title'
  | 'subject'
  | 'contact'
  | 'pushname'
  | 'verifiedName'
  | 'number'
  | 'fallback';

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

  /**
   * Best human-readable name WhatsApp exposes: the chat title, else the group subject,
   * else the contact's saved name / business name / public push name, else the phone
   * number. Absent only when the account genuinely has nothing to show.
   */
  name?: string;

  /**
   * Same as `name`, but never empty — it falls back to the id's own user part so every row
   * in the listing has something to display.
   */
  displayName: string;

  /** Which of the sources above `name` came from. */
  nameSource?: ChatNameSource;

  /** Group, one-to-one, linked identity, channel or broadcast list. */
  kind: ChatKind;

  /** True for group chats. */
  isGroup?: boolean;

  /**
   * Group subject / channel title as WhatsApp stores it, even when the chat title is
   * missing. This is what usually fills in for an unnamed group.
   */
  subject?: string;

  /** Group or channel description text ("Опис групи"), when one is set. */
  description?: string;

  /** How many members the group has, when the metadata is loaded. */
  participantCount?: number;

  /** Phone number behind a one-to-one chat, digits only. */
  phoneNumber?: string;

  /** Contact's public push name, kept separately from the resolved `name`. */
  pushName?: string;

  /** Verified business name, when the counterpart is a WhatsApp Business account. */
  verifiedName?: string;

  /** True when the number is saved in the linked phone's address book. */
  isMyContact?: boolean;

  /** True when the chat cannot be written to (announcement group, read-only channel). */
  isReadOnly?: boolean;

  /** True when the chat is archived. */
  archived?: boolean;

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

  /**
   * How many chats still have no human-readable name after every lookup. A non-zero count
   * means WhatsApp itself holds nothing for them, typically strangers who never set a push
   * name and groups whose metadata the account has not synced yet.
   */
  unnamedCount: number;
}
