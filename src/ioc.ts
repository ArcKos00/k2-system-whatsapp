import { IocContainer } from '@tsoa/runtime';
import { container } from 'tsyringe';

export const iocContainer: IocContainer = {
  get: <T>(controller: new (...args: never[]) => T): T => {
    return container.resolve<T>(controller as never);
  },
};
