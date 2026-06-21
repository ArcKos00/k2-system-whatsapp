import { IocContainer } from '@tsoa/runtime';
import { container } from 'tsyringe';

/**
 * Bridges tsoa's controller instantiation to the tsyringe DI container,
 * so controllers receive their dependencies (e.g. WhatsappService) injected.
 * Referenced from tsoa.json -> routes.iocModule.
 */
export const iocContainer: IocContainer = {
  // tsoa passes the controller class; tsyringe resolves it (and its deps).
  get: <T>(controller: new (...args: never[]) => T): T => {
    return container.resolve<T>(controller as never);
  },
};
