import type { WhatsAppStatus } from '../services/whatsappService';

export interface SessionStateResponse {
  status: WhatsAppStatus;
  /** Whether a login QR is waiting to be scanned right now. */
  qrPending: boolean;
  /** Where the QR PNG is served while `qrPending` is true (includes `PATH_BASE`). */
  qrUrl?: string;
}

export interface LogoutResponse extends SessionStateResponse {
  /**
   * Whether WhatsApp confirmed that this device was unlinked from the account. `false` means
   * the local session was dropped anyway; the old device may still show under
   * "Linked devices" on the phone until it is removed there.
   */
  deviceUnlinked: boolean;
}
