import {
  Body,
  Controller,
  FormField,
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
import { ErrorResponse, SendMessageDto, SendMessageResponse } from '../dtos/sendMessage.dto';

/**
 * Sending WhatsApp messages. All endpoints require a valid Keycloak token.
 *
 * The optional `scopes` argument of `@Security` maps to Keycloak roles, e.g.
 * `@Security('keycloak', ['whatsapp:send'])` — enable once the role exists.
 */
@injectable()
@Route('messages')
@Tags('Messages')
//@Security('keycloak')
@Response<ErrorResponse>(401, 'Unauthorized')
@Response<ErrorResponse>(404, 'Phone number not registered on WhatsApp')
@Response<ErrorResponse>(503, 'WhatsApp client not connected')
export class MessagesController extends Controller {
  constructor(private readonly whatsapp: WhatsappService) {
    super();
  }

  /**
   * Send a text message and/or base64-encoded attachments as JSON.
   * Best for small payloads; use the multipart endpoint for larger files.
   */
  @Post('send')
  @SuccessResponse(202, 'Accepted — message dispatched')
  @Response<ErrorResponse>(422, 'Validation failed')
  public async send(@Body() body: SendMessageDto): Promise<SendMessageResponse> {
    const files: MediaAttachment[] = (body.files ?? []).map((f) => ({
      base64: f.base64,
      mimetype: f.mimetype,
      filename: f.filename,
    }));

    const result = await this.whatsapp.sendMessage(body.phoneNumber, body.message, files);
    this.setStatus(202);
    return result;
  }

  /**
   * Send a message with one or more uploaded files (multipart/form-data).
   * Files are received in memory and forwarded as WhatsApp MessageMedia.
   */
  @Post('send-with-files')
  @SuccessResponse(202, 'Accepted — message dispatched')
  @Response<ErrorResponse>(400, 'Invalid attachment')
  public async sendWithFiles(
    @FormField() phoneNumber: string,
    @UploadedFiles() files: Express.Multer.File[],
    @FormField() message?: string,
  ): Promise<SendMessageResponse> {
    const attachments: MediaAttachment[] = (files ?? []).map((f) => ({
      buffer: f.buffer,
      mimetype: f.mimetype,
      filename: f.originalname,
    }));

    const result = await this.whatsapp.sendMessage(phoneNumber, message, attachments);
    this.setStatus(202);
    return result;
  }
}
