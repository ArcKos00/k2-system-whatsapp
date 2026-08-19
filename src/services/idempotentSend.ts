import { DuplicateSendInFlightError } from '../errors/appErrors';
import type { SendMessageResponse } from '../dtos/sendMessage.dto';
import type { IdempotencyStore } from './idempotencyStore';

export interface IdempotentSendOutcome {
  /** 202 for a message that was actually dispatched, 200 when an earlier result is replayed. */
  status: 200 | 202;
  body: SendMessageResponse;
}

/**
 * Runs `send` under the caller's idempotency key: an unseen key dispatches, a key that already
 * succeeded replays its result, and a key still in flight is rejected so the caller backs off.
 * A key whose send throws is released, because only a completed send may block a retry.
 *
 * Shared by every send endpoint — the by-number ones and the by-chat-id ones — so all of them
 * honour a key the same way and a caller can retry any of them the same way.
 */
export async function runIdempotentSend(
  idempotency: IdempotencyStore,
  rawKey: string | undefined,
  send: () => Promise<{ success: boolean; chatId: string; sentMessages: number }>,
): Promise<IdempotentSendOutcome> {
  const key = rawKey?.trim();

  if (!key) {
    return { status: 202, body: await send() };
  }

  const claim = await idempotency.claim(key);

  if (claim === 'in-flight') {
    throw new DuplicateSendInFlightError(key);
  }

  if (claim) {
    return {
      status: 200,
      body: {
        success: true,
        chatId: claim.chatId,
        sentMessages: claim.sentMessages,
        deduplicated: true,
      },
    };
  }

  try {
    const result = await send();
    await idempotency.complete(key, {
      chatId: result.chatId,
      sentMessages: result.sentMessages,
    });
    return { status: 202, body: result };
  } catch (err) {
    // The send did not complete, so the key must not block the caller's retry.
    idempotency.release(key);
    throw err;
  }
}
