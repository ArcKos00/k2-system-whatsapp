import { Controller, Get, Post, Response, Route, SuccessResponse, Tags } from 'tsoa';
import { injectable } from 'tsyringe';
import { WhatsappService } from '../services/whatsappService';
import { LogoutResponse, SessionStateResponse } from '../dtos/session.dto';
import { ErrorResponse } from '../dtos/sendMessage.dto';
import { config } from '../config/env';
import { QrNotAvailableError } from '../errors/appErrors';

/**
 * Linking and unlinking the WhatsApp account. Unauthenticated like the message endpoints (see
 * the `@Security` note on MessagesController) — logout drops the session, so keep the gateway
 * on the internal network or enable `@Security('keycloak')` here.
 */
@injectable()
@Route('session')
@Tags('Session')
//@Security('keycloak')
export class SessionController extends Controller {
  constructor(private readonly whatsapp: WhatsappService) {
    super();
  }

  /** Current session state and, while one is pending, where to find the login QR. */
  @Get()
  public async state(): Promise<SessionStateResponse> {
    return this.whatsapp.getSessionState();
  }

  /**
   * Start a session if none is running (after a logout, or when the client gave up) and wait
   * until it shows a QR or is ready. Scan the QR at `qrUrl` (or follow `GET /session/qr`).
   * An already linked session is left as it is.
   */
  @Post('login')
  @SuccessResponse(200, 'Session started or already running')
  public async login(): Promise<SessionStateResponse> {
    return this.whatsapp.login();
  }

  /**
   * Unlink this device from the WhatsApp account and delete the local session. The service
   * stays logged out — it does not reconnect on its own — until `POST /session/login`.
   */
  @Post('logout')
  @SuccessResponse(200, 'Logged out')
  public async logout(): Promise<LogoutResponse> {
    return this.whatsapp.logout();
  }

  /** Redirect to the login QR PNG (`GET /qr`) while one is pending. */
  @Get('qr')
  @SuccessResponse(302, 'Redirect to the QR image')
  @Response<ErrorResponse>(404, 'No QR pending')
  public async qr(): Promise<void> {
    const state = this.whatsapp.getSessionState();
    if (!state.qrPending) {
      throw new QrNotAvailableError(state.status);
    }
    this.setStatus(302);
    this.setHeader('Location', `${config.pathBase}/qr`);
    this.setHeader('Cache-Control', 'no-store');
  }
}
