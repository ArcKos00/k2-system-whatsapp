import type {ConsoleMessage, Frame, Page} from 'puppeteer';
import {logger} from '../utils/logger';

/** Name of the binding the page script reports through. Survives navigations. */
const BINDING = '__k2Diag';
/** How many recent page events are kept for the dump that follows a logout or a reload. */
const TRAIL_SIZE = 60;
/** Console lines worth surfacing; WhatsApp Web's console is otherwise pure noise. */
const INTERESTING_CONSOLE = /logout|log out|stream|socket|conflict|replaced|unpaired|device.?removed|401|403|banned|restrict/i;

interface TrailEntry {
    at: string;
    kind: string;
    [key: string]: unknown;
}

/**
 * Runs in every document the page loads, the one WhatsApp Web reloads into on its own included,
 * so the moments before our injected code is back are covered too. It only listens: it reports
 * socket state changes, the logout commands with the stack that issued them, and unloads.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
function pageScript(binding: string): void {
    const w = globalThis as any;
    // Only the WhatsApp Web window itself. The script is also injected into WhatsApp's helper
    // iframes (flows.whatsapp.net/…/cache_management right after a QR scan), where the modules
    // below do not exist and asking for them makes WhatsApp's ErrorUtils report errors.
    try {
        if (w.top !== w || w.location?.hostname !== 'web.whatsapp.com') return;
    } catch {
        return;
    }
    const send = (event: Record<string, unknown>): void => {
        try {
            w[binding]?.(JSON.stringify({...event, url: w.location?.href}));
        } catch {
            // the binding is not there yet or the page is going away
        }
    };
    const describe = (args: unknown[]): string[] =>
        args.slice(0, 4).map((arg) => {
            try {
                return typeof arg === 'object' ? JSON.stringify(arg)?.slice(0, 300) ?? String(arg) : String(arg);
            } catch {
                return Object.prototype.toString.call(arg);
            }
        });

    send({kind: 'document'});
    w.addEventListener('beforeunload', () => send({kind: 'beforeunload'}));
    w.addEventListener('pagehide', (event: any) => send({kind: 'pagehide', persisted: event?.persisted}));

    let tries = 0;
    const timer = setInterval(() => {
        tries += 1;
        if (tries > 600) {
            clearInterval(timer);
            return;
        }
        try {
            // Same gate the library uses before it touches any module: until the bundle has set
            // Debug.VERSION, require() of a module that is not registered yet throws and is
            // logged by WhatsApp itself.
            if (typeof w.require !== 'function' || w.Debug?.VERSION === undefined) return;
            const Socket = w.require('WAWebSocketModel')?.Socket;
            const Cmd = w.require('WAWebCmd')?.Cmd;
            if (!Socket || !Cmd) return;
            clearInterval(timer);
            if (w.__k2DiagHooked) return;
            w.__k2DiagHooked = true;

            send({kind: 'hooked', state: Socket.state, stream: Socket.stream, hasSynced: Socket.hasSynced});
            Socket.on('change:state', (_model: unknown, state: unknown) => send({kind: 'socket.state', state}));
            Socket.on('change:stream', (_model: unknown, stream: unknown) => send({kind: 'socket.stream', stream}));
            for (const name of ['logout', 'logout_from_bridge']) {
                Cmd.on(name, (...args: unknown[]) =>
                    send({
                        kind: `cmd.${name}`,
                        args: describe(args),
                        state: Socket.state,
                        stream: Socket.stream,
                        stack: String(new Error().stack ?? '').slice(0, 2000),
                    }),
                );
            }
        } catch (err) {
            send({kind: 'hook-failed', error: String((err as any)?.message ?? err)});
            clearInterval(timer);
        }
    }, 500);
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Watches the WhatsApp Web page for what happens around an unexpected reload or logout, which
 * the library itself only reports as a bare `LOGOUT`. Everything is logged as it happens and
 * also kept in a short trail that is dumped in one piece when the session is lost.
 */
export class PageDiagnostics {
    private readonly instrumented = new WeakSet<Page>();
    private readonly trail: TrailEntry[] = [];
    private readyAt: number | null = null;

    public markReady(): void {
        this.readyAt = Date.now();
    }

    /** Hooks a page once; safe to call on every lifecycle event. */
    public async instrument(page: Page | undefined): Promise<void> {
        if (!page || this.instrumented.has(page) || page.isClosed()) {
            return;
        }
        this.instrumented.add(page);

        try {
            await page.exposeFunction(BINDING, (raw: string) => this.onPageEvent(raw));
        } catch (err) {
            logger.debug('Page diagnostics: binding already present', err);
        }

        page.on('framenavigated', (frame: Frame) => {
            if (frame === page.mainFrame()) {
                this.note('navigated', {url: frame.url()}, 'info');
            }
        });
        page.on('error', (err: Error) => this.note('page-crashed', {error: err.message}, 'error'));
        page.on('close', () => this.note('page-closed', {}, 'info'));
        page.on('pageerror', (err: unknown) =>
            this.note('page-error', {error: String((err as Error)?.message ?? err).slice(0, 300)}, 'debug'),
        );
        page.on('console', (message: ConsoleMessage) => {
            const text = message.text();
            if ((message.type() === 'error' || message.type() === 'warn') && INTERESTING_CONSOLE.test(text)) {
                this.note('console', {type: message.type(), text: text.slice(0, 500)}, 'info');
            }
        });

        try {
            await page.evaluateOnNewDocument(pageScript, BINDING);
            await page.evaluate(pageScript, BINDING);
        } catch (err) {
            logger.warn('Page diagnostics: could not install the page script', err);
        }
        logger.info('Page diagnostics installed');
    }

    /** Logs the trail of page events that led up to a lost session. */
    public dump(reason: string): void {
        logger.warn(`Page events leading up to: ${reason}`, {
            secondsSinceReady: this.secondsSinceReady(),
            events: [...this.trail],
        });
    }

    private onPageEvent(raw: string): void {
        let event: Record<string, unknown>;
        try {
            event = JSON.parse(raw) as Record<string, unknown>;
        } catch {
            event = {kind: 'unparsable', raw: String(raw).slice(0, 300)};
        }
        const {kind, ...rest} = event;
        const name = String(kind ?? 'unknown');
        const loud = name.startsWith('cmd.') || name === 'hook-failed';
        this.note(name, rest, loud ? 'warn' : 'info');
        if (name.startsWith('cmd.logout')) {
            this.dump(`WhatsApp Web ${name}`);
        }
    }

    private note(kind: string, data: Record<string, unknown>, level: 'debug' | 'info' | 'warn' | 'error'): void {
        const entry: TrailEntry = {at: new Date().toISOString(), kind, ...data};
        this.trail.push(entry);
        if (this.trail.length > TRAIL_SIZE) {
            this.trail.shift();
        }
        logger[level](`WA page: ${kind}`, {...data, secondsSinceReady: this.secondsSinceReady()});
    }

    private secondsSinceReady(): number | undefined {
        return this.readyAt === null ? undefined : Math.round((Date.now() - this.readyAt) / 1000);
    }
}
