import 'source-map-support/register';

import { getLogger, NodeServer } from '@bsquare/base-service';
import { PipelineEvent } from '@bsquare/companion-common';
import {
  CloudInterface,
  CloudQueueApi,
  verifyPermissions,
} from '@bsquare/companion-service-common';
import { RDS_DATABASE, RDS_HOSTNAME, RDS_PASSWORD, RDS_PORT, RDS_USERNAME } from './config';
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

  protected constructor(eventQueue: CloudQueueApi<PipelineEvent>) {
    super();
    this.eventQueue = eventQueue;

    this.useRouteFinder = true;
  }

  public static run(eventQueue: CloudQueueApi<PipelineEvent>): void {
    const server = new OutOfBandServer(eventQueue);

    NodeServer.runServer(server);
  }

  // Public to be used by tests.
  public readonly db = new OutOfBandDb(SQL_OPTIONS);

  public static createDummy(eventQueue: CloudQueueApi<PipelineEvent>): OutOfBandServer {
    return new OutOfBandServer(eventQueue);
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
    // TODO Cron to ensure all assets still exist.
    await this.db.connect();

    const dispatchEvent: RaiseEventCallback = (event) => this.eventQueue.write(event);
    this.express.use((_req, res, next) => {
      res.locals = {
        db: this.db,
        dispatchEvent,
      };
      next();
    });

    this.express.use('/v1/api/oob', outOfBandRouter);
    await verifyPermissions();
  }
}

export async function initService(cloudInterface: CloudInterface): Promise<void> {
  // TODO Consider listening for asset delete events.
  const eventQueue = await cloudInterface.initEventQueue();
  OutOfBandServer.run(eventQueue);
}
