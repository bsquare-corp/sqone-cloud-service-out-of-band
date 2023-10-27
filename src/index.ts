import 'source-map-support/register';

import { getLogger, NodeServer } from '@bsquare/base-service';
import { PipelineEvent } from '@bsquare/companion-common';
import {
  CloudFileApi,
  CloudInterface,
  CloudQueueApi,
  verifyPermissions,
} from '@bsquare/companion-service-common';
import {
  OOB_BUCKET,
  RDS_DATABASE,
  RDS_HOSTNAME,
  RDS_PASSWORD,
  RDS_PORT,
  RDS_USERNAME,
} from './config';
import { OutOfBandDb } from './database';
import { RaiseEventCallback } from './routes/handle';
import { outOfBandRouter } from './routes/router';

const logger = getLogger('companion-common-service-out-of-band.index');

const SQL_OPTIONS = {
  host: RDS_HOSTNAME,
  user: RDS_USERNAME,
  password: RDS_PASSWORD,
  port: RDS_PORT,
  database: RDS_DATABASE,
};

export class OutOfBandServer extends NodeServer {
  private eventQueue: CloudQueueApi<PipelineEvent>;
  private fileApi: CloudFileApi;

  protected constructor(eventQueue: CloudQueueApi<PipelineEvent>, fileApi: CloudFileApi) {
    super();
    this.eventQueue = eventQueue;
    this.fileApi = fileApi;

    this.useRouteFinder = true;
  }

  public static run(eventQueue: CloudQueueApi<PipelineEvent>, fileApi: CloudFileApi): void {
    const server = new OutOfBandServer(eventQueue, fileApi);

    NodeServer.runServer(server);
  }

  // Public to be used by tests.
  public readonly db = new OutOfBandDb(SQL_OPTIONS);

  public static createDummy(
    eventQueue: CloudQueueApi<PipelineEvent>,
    fileApi: CloudFileApi,
  ): OutOfBandServer {
    return new OutOfBandServer(eventQueue, fileApi);
  }

  public async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server.once('listening', resolve);

      NodeServer.runServer(this);
    });
  }

  public override async stop(quit = true): Promise<void> {
    try {
      logger.info('Stopping service');
      await this.eventQueue.close();
      await this.fileApi.close();

      logger.debug('Stopping rest');
      await super.stop();

      logger.debug('Closing sql');
      await this.db.close();

      logger.info('Shutdown complete');

      if (quit) {
        process.exit(0);
      }
    } catch (err) {
      logger.warn('Error during shutdown', err);
      process.exit(1);
    }
  }

  protected async configure(): Promise<void> {
    // TODO Cron to ensure all assets still exist and clean up ones that don't.
    // TODO Cron to delete and fail operations older than X.
    await this.db.connect();

    const dispatchEvent: RaiseEventCallback = (event) => this.eventQueue.write(event);
    this.express.use((_req, res, next) => {
      res.locals = {
        db: this.db,
        dispatchEvent,
        fileApi: this.fileApi,
      };
      next();
    });

    this.express.use('/v1/api/oob', outOfBandRouter);
    await verifyPermissions();
  }
}

export async function initService(cloudInterface: CloudInterface): Promise<void> {
  // TODO Listen for asset delete events and cleanup, maybe asset ban?
  const eventQueue = await cloudInterface.initEventQueue();
  const fileApi = await cloudInterface.initFileApi({ bucketName: OOB_BUCKET });
  if (!fileApi.getFileUploadLink) {
    throw new Error('getFileUploadLink not set');
  }
  OutOfBandServer.run(eventQueue, fileApi);
}
