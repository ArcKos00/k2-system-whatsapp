/**
 * A single attachment encoded as base64 inside a JSON request.
 * Prefer the multipart endpoint for large files.
 */
export interface MediaFileDto {
  /**
   * Base64-encoded file content WITHOUT the `data:<mime>;base64,` prefix.
   */
  base64: string;

  /**
   * MIME type of the file. Decides whether the file shows up inline (`image/jpeg`,
   * `image/png`, `video/mp4`, `audio/mpeg`, …) or as a document. A generic
   * `application/octet-stream` is replaced by the type the `filename` extension implies.
   * @example "image/png"
   */
  mimetype: string;

  /**
   * File name including extension.
   * @example "invoice.pdf"
   */
  filename: string;
}

/**
 * Payload for sending a WhatsApp message via the JSON endpoint.
 */
export interface SendMessageDto {
  /**
   * Recipient phone number in international format. Non-digit characters
   * (spaces, dashes, leading `+`) are stripped automatically.
   * @example "380501234567"
   */
  phoneNumber: string;

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
   * Caller-supplied key that makes this send idempotent. Retrying with the same key
   * returns the original result instead of delivering the message a second time,
   * which is what lets a caller retry safely after a timeout or a crash.
   * @example "0f8b9d3a-2c4e-4f1a-9b7d-5e6c8a0d1f23"
   */
  idempotencyKey?: string;
}

/**
 * Result of a send operation.
 */
export interface SendMessageResponse {
  success: boolean;
  /** Resolved WhatsApp chat id, e.g. `380501234567@c.us`. */
  chatId: string;
  /**
   * Number of individual WhatsApp messages dispatched. With attachments the text is sent
   * as the caption of the first file, so this equals the number of files; without
   * attachments it is 1.
   */
  sentMessages: number;
  /**
   * True when this response replays an earlier send matched by `idempotencyKey`,
   * i.e. nothing new was delivered to WhatsApp.
   */
  deduplicated?: boolean;
}

/**
 * Standard error envelope returned by the API.
 */
export interface ErrorResponse {
  message: string;
  code: string;
  details?: unknown;
}
