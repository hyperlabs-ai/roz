import type { Logger } from 'pino';

export type RozContext = {
  Variables: {
    logger: Logger;
    requestId: string;
  };
};
