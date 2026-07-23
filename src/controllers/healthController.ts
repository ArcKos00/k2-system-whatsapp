import { Controller, Get, Route, Tags } from 'tsoa';
import { injectable } from 'tsyringe';
import { WhatsappService, WhatsAppStatus } from '../services/whatsappService';

export interface HealthResponse {
  status: 'ok';
  whatsapp: WhatsAppStatus;
}

export interface ReadinessResponse {
  status: 'ready' | 'not_ready';
  whatsapp: WhatsAppStatus;
}

/** Liveness probe: the process is up, regardless of WhatsApp session state. */
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

/** Readiness probe: 503 unless the WhatsApp session can actually send. */
@injectable()
@Route('ready')
@Tags('Health')
export class ReadinessController extends Controller {
  constructor(private readonly whatsapp: WhatsappService) {
    super();
  }

  @Get()
  public async ready(): Promise<ReadinessResponse> {
    const whatsapp = this.whatsapp.getStatus();
    if (whatsapp !== 'ready') {
      this.setStatus(503);
      return { status: 'not_ready', whatsapp };
    }
    return { status: 'ready', whatsapp };
  }
}
