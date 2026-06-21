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
   * MIME type of the file.
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
   * Text body of the message. Optional when at least one file is attached.
   * @example "Вітаємо! Ваше замовлення прийнято."
   */
  message?: string;

  /**
   * Optional attachments, base64-encoded.
   */
  files?: MediaFileDto[];
}

/**
 * Result of a send operation.
 */
export interface SendMessageResponse {
  success: boolean;
  /** Resolved WhatsApp chat id, e.g. `380501234567@c.us`. */
  chatId: string;
  /** Number of individual WhatsApp messages dispatched (text + each file). */
  sentMessages: number;
}

/**
 * Standard error envelope returned by the API.
 */
export interface ErrorResponse {
  message: string;
  code: string;
  details?: unknown;
}
