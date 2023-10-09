import BodyParser from 'body-parser';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { EventEmitter } from 'events';
import Express, { Request, Response } from 'express';
import { Server } from 'http';
import { createProxyMiddleware } from 'http-proxy-middleware';
import * as MySQL from 'mysql2/promise';
import Fetch from 'node-fetch';
import { RDS_DATABASE, RDS_HOSTNAME, RDS_PASSWORD, RDS_PORT, RDS_USERNAME } from '../config';

const API_HOST = 'http://localhost:4468';

export const MOCK_PORT = 4468;

export const mockServicesEmitter = new EventEmitter();
const app = Express();

let server: Server;

export interface RegisterMock {
  req: Request;
  res: Response;
}

app.use(BodyParser.json());

app.use(
  '/v1/api/auth',
  createProxyMiddleware({ target: 'http://localhost:3310', changeOrigin: true }),
);

app.use((req, res) => {
  const id = `${req.url.split('?')[0]}:${req.method.toLowerCase()}`;
  const listenerCount = mockServicesEmitter.listenerCount(id);
  if (listenerCount === 0) {
    res.status(400).json({ message: 'Not implemeneted', id });
  } else if (listenerCount > 1) {
    res.status(400).json({ message: 'Multiple listeners registered', id });
  } else {
    mockServicesEmitter.emit(id, { req, res });
  }
});

// 2 minutes in milliseconds. Got to pull the image sometimes.
const START_TIMEOUT = 120000;

let servicesProcess: ChildProcessWithoutNullStreams;

export function createConnection(): Promise<MySQL.Connection> {
  return MySQL.createConnection({
    multipleStatements: true,
    timezone: 'Z',
    host: RDS_HOSTNAME,
    user: RDS_USERNAME,
    password: RDS_PASSWORD,
    port: RDS_PORT,
    database: RDS_DATABASE,
  });
}

export async function startServices(): Promise<void> {
  await new Promise<void>((resolve) => {
    server = app.listen(MOCK_PORT, resolve);
  });

  await new Promise((resolve, reject) => {
    let stderr = '';
    servicesProcess = spawn('docker-compose', [
      '-f',
      'dev/test/docker-compose.yml',
      'up',
      '--remove-orphans',
    ]);
    servicesProcess.stderr.on('data', (data) => (stderr += data.toString()));

    // Print during startup.
    servicesProcess.stderr.on('data', (data) => process.stderr.write(data));
    servicesProcess.stdout.on('data', (data) => process.stdout.write(data));

    console.log('Docker process spawned');

    const stopStreams = (): void => {
      servicesProcess.stdout.removeAllListeners('data');
      servicesProcess.stderr.removeAllListeners('data');
      servicesProcess.removeAllListeners('exit');
    };

    servicesProcess.on('exit', (code) => {
      console.log('Docker process exit', code);
      stopStreams();
      reject(new Error(`Failed to start services (${code}): ${stderr}`));
    });

    const timeout = setTimeout(() => {
      stopStreams();
      servicesProcess.kill('SIGKILL');
      reject(new Error('Services failed to start within a reasonable time'));
    }, START_TIMEOUT);

    const listener = (data: Buffer): void => {
      if (
        data.toString().includes('Ready to accept connections') ||
        data.toString().includes('ready for connections')
      ) {
        console.log('SQL server ready to accept connections');
        clearTimeout(timeout);
        stopStreams();
        // Delay an extra second because ready for connections is a lie.
        setTimeout(resolve, 1000);
      }
    };

    console.log('Waiting for SQL to be ready');
    servicesProcess.stdout.on('data', listener);
    servicesProcess.stderr.on('data', listener);
  });

  console.log('Waiting for API_HOST');
  for (let i = 0; i < 20; i++) {
    try {
      // Throws an error on ECONNREFUSED.
      await Fetch(API_HOST);
      console.log('API_HOST responded');
      return;
    } catch (err) {
      console.warn(
        'Failed to connect to api host. Retrying in 5s.',
        API_HOST,
        err instanceof Error ? err.message : err,
      );
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
  throw new Error('API_HOST did not respond in time');
}

export async function stopServices(): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  return new Promise((resolve) => {
    servicesProcess.once('exit', () => {
      resolve();
    });
    servicesProcess.kill('SIGTERM');
  });
}
