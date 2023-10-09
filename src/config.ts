import { getEnv, getNumberEnv } from '@bsquare/base-service';

export const RDS_HOSTNAME = getEnv('RDS_HOSTNAME');
export const RDS_USERNAME = getEnv('RDS_USERNAME');
export const RDS_PASSWORD = getEnv('RDS_PASSWORD');
export const RDS_PORT = getNumberEnv('RDS_PORT', 3306);
export const RDS_DATABASE = getEnv('RDS_DATABASE');
