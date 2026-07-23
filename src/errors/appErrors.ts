export class AppError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string,
  ) {
    super(message);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class WhatsAppNotReadyError extends AppError {
  constructor() {
    super('WhatsApp client is not connected. Scan the QR code or wait for reconnection.', 503, 'WA_NOT_READY');
  }
}

export class NumberNotFoundError extends AppError {
  constructor(phoneNumber: string) {
    super(`Phone number is not registered on WhatsApp: ${phoneNumber}`, 404, 'WA_NUMBER_NOT_FOUND');
  }
}

export class MessageSendError extends AppError {
  constructor(detail: string) {
    super(`Failed to send WhatsApp message: ${detail}`, 502, 'WA_SEND_FAILED');
  }
}

export class BadAttachmentError extends AppError {
  constructor(detail: string) {
    super(`Invalid attachment: ${detail}`, 400, 'BAD_ATTACHMENT');
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(message, 401, 'UNAUTHORIZED');
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(message, 403, 'FORBIDDEN');
  }
}
