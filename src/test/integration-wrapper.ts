// eslint-disable-file import/order
export const API_HOST = 'http://localhost:4468';
export const API_TOKEN = 'system@test-token';

process.env.LOG_IN_COLOUR = 'true';
process.env.API_HOST = API_HOST;
process.env.API_TOKEN = API_TOKEN;

process.env.RDS_HOSTNAME = 'localhost';
process.env.RDS_USERNAME = 'root';
process.env.RDS_PASSWORD = 'password';
process.env.RDS_PORT = '3309';
process.env.RDS_DATABASE = 'companion';

import { PipelineEvent } from '@bsquare/companion-common';
import { EventEmitter } from 'events';
import { after, before } from 'mocha';

// eslint-disable-next-line import/order
import { OutOfBandServer } from '../';
import { startServices, stopServices } from './services-setup';

export const OOB_API_PORT = 4555;
export const OOB_API_URI = `http://localhost:${OOB_API_PORT}`;

export const serviceEvents = new EventEmitter();

export async function waitForEvents(count: number): Promise<Array<PipelineEvent<any>>> {
  return new Promise<PipelineEvent[]>((resolve) => {
    const events: PipelineEvent[] = [];
    serviceEvents.on('event', (event) => {
      events.push(event);
      if (events.length >= count) {
        serviceEvents.removeAllListeners('event');
        resolve(events);
      }
    });
  });
}

const originalPort = process.env.PORT;
process.env.PORT = String(OOB_API_PORT);
export const oobApi = OutOfBandServer.createDummy({
  write: (event) => {
    serviceEvents.emit('event', event);
    return Promise.resolve();
  },
  close: () => Promise.resolve(),
});
process.env.PORT = originalPort;

before(async () => {
  console.log('Starting temporary services...');
  await startServices();
  console.log('Starting plugins system...');
  await oobApi.start();
});

after(async () => {
  console.log('Stopping plugins system...');
  await oobApi.stop(false);
  console.log('Stopping services...');
  await stopServices();
  console.log('Shutdown complete.');
});
