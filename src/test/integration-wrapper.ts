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
process.env.OOB_STREAM_ID = 'oob';
process.env.WAIT_FOR_EVENTS_SERVICE = 'false';
process.env.CRON_ENABLED = 'false';

process.env.OOB_BUCKET = 'oob';

import { createStreamPromise, PipeBuffer } from '@bsquare/base-service';
import { PipelineEvent } from '@bsquare/companion-common';
import { expect } from 'chai';
import { EventEmitter } from 'events';
import { after, before } from 'mocha';

// eslint-disable-next-line import/order
import type { Stream } from 'stream';
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
export const oobApi = OutOfBandServer.createDummy(
  {
    write: (event) => {
      serviceEvents.emit('event', event);
      return Promise.resolve();
    },
    close: () => Promise.resolve(),
  },
  {
    getFileLink: (fileId: string) => Promise.resolve(`https://s3/${fileId}`),
    startUpload: () => {
      throw new Error('not implemented');
    },
    createPart: () => {
      throw new Error('not implemented');
    },
    completeUpload: () => {
      throw new Error('not implemented');
    },
    abortUpload: () => {
      throw new Error('not implemented');
    },
    deleteFile: (fileId) => {
      serviceEvents.emit('deleteFile', fileId);
      return Promise.resolve();
    },
    uploadStream: async (fileId: string, stream: Stream) => {
      expect(fileId).to.be.a('string');
      const pipeBuffer = new PipeBuffer();
      await createStreamPromise(stream.pipe(pipeBuffer));
      const buffer = pipeBuffer.createBuffer();
      expect(buffer.toString('hex')).to.equal('01020304');
    },
    close: () => Promise.resolve(),
  },
  () => Promise.resolve({ close: () => Promise.resolve() }),
);
process.env.PORT = originalPort;

before(async () => {
  console.log('Starting temporary services...');
  await startServices();
  console.log('Starting oob system...');
  await oobApi.start();
});

after(async () => {
  console.log('Stopping oob system...');
  await oobApi.stop(false);
  console.log('Stopping services...');
  await stopServices();
  console.log('Shutdown complete.');
});
