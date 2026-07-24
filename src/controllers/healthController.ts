import { Controller, Get, Route, SuccessResponse, Tags } from 'tsoa';
import { injectable } from 'tsyringe';
import { WhatsappService, WhatsAppStatus } from '../services/whatsappService';

export interface HealthResponse {
  status: 'ok';
  whatsapp: WhatsAppStatus;
}

/**
 * Readiness, as opposed to liveness: the process is up either way, but it can only
 * actually deliver a message once the WhatsApp client is connected.
 */
export interface ReadinessResponse {
  status: 'ready' | 'not_ready';
  whatsapp: WhatsAppStatus;
}

/**
 * Liveness / readiness probe. Intentionally NOT secured so that
 * orchestrators (Docker, k8s) can poll it without a token.
 */
@injectable()
@Route('health')
@Tags('Health')
export class HealthController extends Controller {
  constructor(private readonly whatsapp: WhatsappService) {
    super();
  }

  @Get()
  public async health(): Promise<HealthResponse> {
    return { status: 'ok', whatsapp: this.whatsapp.getStatus() };
  }
}

/**
 * Readiness probe. Answers 503 while the WhatsApp client is not connected, so an
 * orchestrator stops sending traffic to a gateway that would only reject sends.
 */
@injectable()
@Route('ready')
@Tags('Health')
export class ReadinessController extends Controller {
  constructor(private readonly whatsapp: WhatsappService) {
    super();
  }

  @Get()
  @SuccessResponse(200, 'Ready to send')
  public async ready(): Promise<ReadinessResponse> {
    const whatsapp = this.whatsapp.getStatus();
    const ready = whatsapp === 'ready';

    this.setStatus(ready ? 200 : 503);

    return { status: ready ? 'ready' : 'not_ready', whatsapp };
  }
}
