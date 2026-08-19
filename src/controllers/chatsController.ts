import {Controller, Get, Response, Route, SuccessResponse, Tags} from 'tsoa';
import {injectable} from 'tsyringe';
import {WhatsappService} from '../services/whatsappService';
import {ChatListResponse} from '../dtos/chat.dto';
import {ErrorResponse} from '../dtos/sendMessage.dto';

/**
 * Reading the chats the linked account can see. Unauthenticated like the message endpoints
 * (see the `@Security` note on MessagesController) — the listing exposes chat ids and display
 * names, so keep the gateway on the internal network.
 */
@injectable()
@Route('chats')
@Tags('Chats')
@Response<ErrorResponse>(503, 'WhatsApp client not connected')
export class ChatsController extends Controller {
    constructor(private readonly whatsapp: WhatsappService) {
        super();
    }

    /**
     * List every chat with the id the forward allowlist keys on, newest activity first.
     *
     * This is how you fill `RABBITMQ_CHAT_IDS`: take the `id` of each chat you want forwarded,
     * and the same id is what `POST /messages/chat/send` addresses. `forwarded` shows what the
     * current allowlist does with the chat, and chats WhatsApp would not let us read are
     * returned as bare ids under `unreadableChatIds`.
     *
     * Each chat is described as fully as WhatsApp will allow: the group subject and description
     * for a group, the saved contact name / business name / push name and the phone number for
     * a one-to-one chat. `displayName` is always filled, and `nameSource` says which of those
     * the name came from, so `fallback` marks a chat WhatsApp itself holds no name for.
     */
    @Get()
    @SuccessResponse(200, 'Chats listed')
    public async list(): Promise<ChatListResponse> {
        return this.whatsapp.listChatSummaries();
    }
}
