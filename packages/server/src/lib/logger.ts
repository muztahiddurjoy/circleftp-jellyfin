import pino from 'pino';

import { env, isProduction, isTest } from '../env.js';

/**
 * Pretty output is deliberately not used: in production this runs under
 * systemd, where structured JSON in the journal is more useful than colour.
 */
export const logger = pino({
  level: isTest ? 'silent' : env.LOG_LEVEL,
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: ['req.headers.cookie', 'req.headers.authorization', 'password', '*.password'],
    remove: true,
  },
  ...(isProduction ? {} : { transport: undefined }),
});

export type Logger = typeof logger;
