import { getEnv, getEnvBoolean, getNumberEnv } from '@bsquare/base-service';

export const RDS_HOSTNAME = getEnv('RDS_HOSTNAME');
export const RDS_USERNAME = getEnv('RDS_USERNAME');
export const RDS_PASSWORD = getEnv('RDS_PASSWORD');
export const RDS_PORT = getNumberEnv('RDS_PORT', 3306);
export const RDS_DATABASE = getEnv('RDS_DATABASE');

export const OOB_BUCKET = getEnv('OOB_BUCKET');

export const MAX_OPERATION_TRIES = getNumberEnv('MAX_OPERATION_TRIES', 3);

export const TOKEN_CACHE_MAX = getNumberEnv('TOKEN_CACHE_MAX', 1000);
export const TOKEN_CACHE_TTL_MS = getNumberEnv('TOKEN_CACHE_TTL_MS', 15 * 60 * 1000);

export const MAX_PENDING_OPERATIONS_PER_ASSET = getNumberEnv(
  'MAX_PENDING_OPERATIONS_PER_ASSET',
  10,
);

export const CRON_PREFIX = 'oob';
export const CRON_ENABLED = getEnvBoolean('CRON_ENABLED', true);

export const CRON_TENANT_AUGMENT_NAME = 'tenant_augment';
// Interval in seconds between expiring streams.
export const CRON_TENANT_AUGMENT_INTERVAL = 5 * 60;
// Timeout in seconds when the job can be considered unresponsive.
export const CRON_TENANT_AUGMENT_TIMEOUT = 2 * 60;

export const SERVICE_EVENT_ID = 'oob';

export const OOB_STREAM_ID = getEnv('OOB_STREAM_ID');
export const API_HOST = getEnv('API_HOST');
export const WAIT_FOR_EVENTS_SERVICE = getEnvBoolean('WAIT_FOR_EVENTS_SERVICE', true);
