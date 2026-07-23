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

/**
 * Liveness probe: reports that the process is up and serving. Intentionally NOT
 * secured so that orchestrators (Docker, k8s) can poll it without a token.
 *
 * This deliberately answers 200 for every WhatsApp status — restarting the pod
 * does not fix a session that is waiting on a QR scan. Use /ready to decide
 * whether the service can actually send.
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
 * Readiness probe: whether the WhatsApp session can actually serve traffic.
 *
 * Answers 503 unless the client is 'ready', because every other status —
 * including 'authenticated', where the session credentials are accepted but
 * WhatsApp Web has not finished loading — rejects sends with WA_NOT_READY.
 * Wiring this to the k8s readinessProbe takes the pod out of the Service while
 * it cannot send, instead of serving 503s from a pod that looks healthy.
 */
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
