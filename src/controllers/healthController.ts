import { Controller, Get, Query, Route, Tags } from 'tsoa';
import { injectable } from 'tsyringe';
import { MediaPrepReport, WhatsappService, WhatsAppStatus } from '../services/whatsappService';

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

  /**
   * What WhatsApp Web's own media prep does with a file right now, without sending anything.
   *
   * Everything past the prep is keyed by the `filehash` it returns, and a build that stops
   * returning one takes every media send down with a minified page error that names nothing.
   * This preps an 8x8 JPEG and reports what came back, whether the hash could then be looked
   * up, and — with `chatId` — whether the send path's first call, resolving the chat, still
   * works. `pixels` preps a generated image of that edge length instead, which is what
   * reproduces a failure only full-size photos hit. It also returns what the prep had produced
   * the last time a real send found no hash.
   */
  @Get('media-prep')
  public async mediaPrep(@Query() chatId?: string, @Query() pixels?: number): Promise<MediaPrepReport> {
    return this.whatsapp.inspectMediaPrep(chatId, pixels);
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
