import { Controller, Get, Route, Tags } from 'tsoa';
import { injectable } from 'tsyringe';
import { WhatsappService, WhatsAppStatus } from '../services/whatsappService';

export interface HealthResponse {
  status: 'ok';
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
