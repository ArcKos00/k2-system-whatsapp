import {
  Body,
  Controller,
  FormField,
  OperationId,
  Post,
  Response,
  Route,
  Security,
  SuccessResponse,
  Tags,
  UploadedFiles,
} from 'tsoa';
import { injectable } from 'tsyringe';
import { MediaAttachment, WhatsappService } from '../services/whatsappService';
import { IdempotencyStore } from '../services/idempotencyStore';
import { runIdempotentSend } from '../services/idempotentSend';
import { ErrorResponse, SendMessageResponse } from '../dtos/sendMessage.dto';
import { SendToChatDto } from '../dtos/sendToChat.dto';

/**
 * Sending to a chat addressed by its WhatsApp id instead of by phone number.
 *
 * This is the only way to reach a group — a group has no number to resolve — and it is also
 * the cheaper way to reach a one-to-one chat that already exists. Take the ids from
 * `GET /chats`; they are the same ids the forward allowlist keys on.
 *
 * Sends here behave exactly like the by-number ones: same throttle, same `idempotencyKey`
 * semantics, same error envelope.
 */
@injectable()
@Route('messages/chat')
@Tags('Messages')
//@Security('keycloak')
@Response<ErrorResponse>(401, 'Unauthorized')
@Response<ErrorResponse>(404, 'Chat not available to the linked account')
@Response<ErrorResponse>(503, 'WhatsApp client not connected')
export class ChatMessagesController extends Controller {
  constructor(
    private readonly whatsapp: WhatsappService,
    private readonly idempotency: IdempotencyStore,
  ) {
    super();
  }

  /**
   * Send a text message and/or base64-encoded attachments to a chat id, as JSON.
   *
   * Pass `idempotencyKey` to make the call safe to retry: the same key never delivers the
   * message twice, it replays the first result instead.
   */
  @Post('send')
  @OperationId('SendToChat')
  @SuccessResponse(202, 'Accepted — message dispatched')
  @Response<ErrorResponse>(409, 'A send with the same idempotency key is in flight')
  @Response<ErrorResponse>(422, 'Validation failed, or the chat id is malformed')
  public async send(@Body() body: SendToChatDto): Promise<SendMessageResponse> {
    const files: MediaAttachment[] = (body.files ?? []).map((f) => ({
      base64: f.base64,
      mimetype: f.mimetype,
      filename: f.filename,
    }));

    const outcome = await runIdempotentSend(this.idempotency, body.idempotencyKey, () =>
      this.whatsapp.sendMessageToChat(body.chatId, body.message, files),
    );

    this.setStatus(outcome.status);
    return outcome.body;
  }

  /**
   * Send to a chat id with one or more uploaded files (multipart/form-data).
   * Files are received in memory and forwarded as WhatsApp MessageMedia.
   */
  @Post('send-with-files')
  @OperationId('SendToChatWithFiles')
  @SuccessResponse(202, 'Accepted — message dispatched')
  @Response<ErrorResponse>(400, 'Invalid attachment')
  @Response<ErrorResponse>(409, 'A send with the same idempotency key is in flight')
  public async sendWithFiles(
    @FormField() chatId: string,
    @UploadedFiles() files: Express.Multer.File[],
    @FormField() message?: string,
    @FormField() idempotencyKey?: string,
  ): Promise<SendMessageResponse> {
    const attachments: MediaAttachment[] = (files ?? []).map((f) => ({
      buffer: f.buffer,
      mimetype: f.mimetype,
      filename: f.originalname,
    }));

    const outcome = await runIdempotentSend(this.idempotency, idempotencyKey, () =>
      this.whatsapp.sendMessageToChat(chatId, message, attachments),
    );

    this.setStatus(outcome.status);
    return outcome.body;
  }
}
