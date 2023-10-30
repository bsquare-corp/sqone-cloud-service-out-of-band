import 'source-map-support/register';

import { getLogger, LongObjectId, NodeServer } from '@bsquare/base-service';
import {
  EventIdTypes,
  EventSubscriptionCreateRequest,
  EventTypes,
  OobOperationName,
  OobOperationRequest,
  OobOperationStatusCode,
  PipelineEvent,
  ServiceEventIds,
} from '@bsquare/companion-common';
import {
  CheckpointCallback,
  CloudCloseableApi,
  CloudFileApi,
  CloudInterface,
  CloudQueueApi,
  CloudQueueFunction,
  CronDb,
  internalFetch,
  verifyPermissions,
} from '@bsquare/companion-service-common';
import Fetch from 'node-fetch';
import { execute } from 'proper-job';
import {
  API_HOST,
  CRON_ENABLED,
  CRON_OPERATION_CLEANUP_INTERVAL,
  CRON_OPERATION_CLEANUP_NAME,
  CRON_OPERATION_CLEANUP_TIMEOUT,
  CRON_PREFIX,
  CRON_TENANT_AUGMENT_INTERVAL,
  CRON_TENANT_AUGMENT_NAME,
  CRON_TENANT_AUGMENT_TIMEOUT,
  OOB_BUCKET,
  OOB_STREAM_ID,
  OPERATION_DELETE_MAX_AGE_DAYS,
  OPERATION_TIMEOUT_MAX_AGE_DAYS,
  RDS_DATABASE,
  RDS_HOSTNAME,
  RDS_PASSWORD,
  RDS_PORT,
  RDS_USERNAME,
  SERVICE_EVENT_ID,
  WAIT_FOR_EVENTS_SERVICE,
} from './config';
import { IN_PROGRESS_OPERATION_STATUSES, OobOperationDb, OutOfBandDb } from './database';
import { RaiseEventCallback } from './routes/handle';
import { outOfBandRouter } from './routes/router';

const logger = getLogger('companion-common-service-out-of-band.index');

const TENANT_AUGMENT_EXECUTION_OPTIONS = {
  parallel: 8,
  storeOutput: false,
  maxErrors: 8,
  throwOnError: false,
};

async function createSubscription(
  tenantId: string,
  subscriptionRequest: EventSubscriptionCreateRequest,
): Promise<void> {
  await internalFetch({
    method: 'POST',
    url: `/v1/api/events/streams/${OOB_STREAM_ID}/subscriptions`,
    tenantId,
    serviceId: SERVICE_EVENT_ID,
    body: subscriptionRequest,
  });
}

async function waitForEventsService(): Promise<void> {
  // Wait for the events service to be up
  for (let i = 0; i < 20; i++) {
    try {
      // Throws an error on ECONNREFUSED, EHOSTUNREACH etc.
      // However, if it's a 403, 401 does not throw.
      await Fetch(`${API_HOST}/v1/api/events/history?size=1`);
      return;
    } catch (err) {
      if (!(err instanceof Error)) {
        throw err;
      }
      logger.warn('Failed to connect to events service. Retrying in 5s.', API_HOST, err.message);
      await new Promise<void>((resolve) => setTimeout(resolve, 5000));
    }
  }
  throw new Error('Could not connect to events service within timeout');
}

const SQL_OPTIONS = {
  host: RDS_HOSTNAME,
  user: RDS_USERNAME,
  password: RDS_PASSWORD,
  port: RDS_PORT,
  database: RDS_DATABASE,
};

type InitInputQueueCallback = (
  callback: CloudQueueFunction<PipelineEvent>,
) => Promise<CloudCloseableApi>;

export class OutOfBandServer extends NodeServer {
  private eventQueue: CloudQueueApi<PipelineEvent>;
  private fileApi: CloudFileApi;
  private initInputQueue: InitInputQueueCallback;
  private inputQueue?: CloudCloseableApi;
  private readonly cron = new CronDb(SQL_OPTIONS, CRON_PREFIX);

  protected constructor(
    eventQueue: CloudQueueApi<PipelineEvent>,
    fileApi: CloudFileApi,
    initInputQueue: InitInputQueueCallback,
  ) {
    super();
    this.eventQueue = eventQueue;
    this.fileApi = fileApi;
    this.initInputQueue = initInputQueue;

    this.useRouteFinder = true;
  }

  public static run(
    eventQueue: CloudQueueApi<PipelineEvent>,
    fileApi: CloudFileApi,
    initInputQueue: InitInputQueueCallback,
  ): void {
    const server = new OutOfBandServer(eventQueue, fileApi, initInputQueue);

    NodeServer.runServer(server);
  }

  // Public to be used by tests.
  public readonly db = new OutOfBandDb(SQL_OPTIONS);

  public static createDummy(
    eventQueue: CloudQueueApi<PipelineEvent>,
    fileApi: CloudFileApi,
    initInputQueue: InitInputQueueCallback,
  ): OutOfBandServer {
    return new OutOfBandServer(eventQueue, fileApi, initInputQueue);
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
      if (this.inputQueue) {
        await this.inputQueue.close();
      }
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
    // TODO Cron to ensure all assets still exist and clean up ones that don't. Should be run rarely, weekly?
    // TODO Cron to delete and fail operations older than X (from config).
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

    if (WAIT_FOR_EVENTS_SERVICE) {
      await waitForEventsService();
    }

    this.inputQueue = await this.initInputQueue((event) => this.ingest(event));

    if (CRON_ENABLED) {
      await this.cron.connect();
      await this.cron.registerJob({
        name: CRON_TENANT_AUGMENT_NAME,
        // Both in seconds.
        interval: CRON_TENANT_AUGMENT_INTERVAL,
        timeout: CRON_TENANT_AUGMENT_TIMEOUT,
        callback: (checkpoint) => this.createDefaultSubscriptions(checkpoint),
      });
      await this.cron.registerJob({
        name: CRON_OPERATION_CLEANUP_NAME,
        interval: CRON_OPERATION_CLEANUP_INTERVAL,
        timeout: CRON_OPERATION_CLEANUP_TIMEOUT,
        callback: async (checkpoint) => {
          // First timeout any operations, deleting files if necessary.
          const timeoutDateCutoff = new Date();
          timeoutDateCutoff.setDate(timeoutDateCutoff.getDate() - OPERATION_TIMEOUT_MAX_AGE_DAYS);
          const timeoutIdCutoff = new LongObjectId(timeoutDateCutoff);
          await this.cleanupOperations(
            undefined,
            {
              id: { max: timeoutIdCutoff.toHexString() },
              status: IN_PROGRESS_OPERATION_STATUSES,
            },
            checkpoint,
          );

          // Now cleanup and delete any completed operations that are too old.
          const deleteDateCutoff = new Date();
          deleteDateCutoff.setDate(deleteDateCutoff.getDate() - OPERATION_DELETE_MAX_AGE_DAYS);
          const deleteIdCutoff = new LongObjectId(deleteDateCutoff);
          await this.cleanupOperations(
            undefined,
            {
              id: { max: deleteIdCutoff.toHexString() },
              status: [
                OobOperationStatusCode.Success,
                OobOperationStatusCode.Failed,
                OobOperationStatusCode.Cancelled,
              ],
            },
            checkpoint,
            true,
          );
        },
      });
    }
  }

  public async ingest(event: PipelineEvent): Promise<void> {
    if (event.type === EventTypes.TenantCreated) {
      // If it's this service that raised it then ignore it.
      if (event.sourceId !== ServiceEventIds.Auth) {
        return;
      }

      if (CRON_ENABLED) {
        try {
          while (!(await this.cron.runNow(CRON_TENANT_AUGMENT_NAME))) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        } catch (err) {
          logger.error('Failed to run tenant augment cron on tenant creation', err);
        }
      }
      return;
    } else if (event.type === EventTypes.AssetDelete) {
      // There is a cap on execution time but it doesn't seem likely this will be met.
      // If it were the event would be re-processed repeatedly until all the operations were gone
      // or the event times out then and the cron catches it.
      await this.deleteAsset(event.tenantId, event.targetId, () => Promise.resolve());
    }
  }

  public async deleteAsset(
    tenantId: string,
    assetId: string,
    checkpoint: CheckpointCallback,
  ): Promise<void> {
    await this.cleanupOperations(tenantId, { assetId }, checkpoint);
    await this.db.deleteAsset(tenantId, assetId);
    await checkpoint();
  }

  protected async cleanupOperations(
    tenantId: string | undefined,
    options: OobOperationRequest,
    checkpoint: CheckpointCallback,
    deleteOperation?: boolean,
  ): Promise<void> {
    // TODO Consider parallelisation of this if scalability becomes an issue.
    // As of the time of writing there's no plans to automate execution of out of band operations.
    for await (const operation of this.db.iterateOperations(tenantId, options)) {
      if (IN_PROGRESS_OPERATION_STATUSES.includes(operation.status)) {
        const request = {
          status: OobOperationStatusCode.Failed,
          additionalDetails: 'Operation has timed out',
        };
        await this.db.updateOperation(
          operation.tenantId,
          operation.assetId,
          operation.id.toHexString(),
          request,
        );
        await this.eventQueue.write({
          id: new LongObjectId().toHexString(),
          tenantId: operation.tenantId,
          type: EventTypes.OobOperationUpdate,
          sourceType: EventIdTypes.Service,
          sourceId: SERVICE_EVENT_ID,
          targetType: EventIdTypes.Asset,
          targetId: operation.assetId,
          data: { operation, request },
        });
      }
      await this.cleanupOperation(operation);
      if (deleteOperation) {
        await this.db.deleteOperation(operation.id);
      }
      await checkpoint();
    }
  }

  protected async cleanupOperation(operation: OobOperationDb): Promise<void> {
    if (
      operation.name === OobOperationName.SendFiles &&
      operation.status !== OobOperationStatusCode.Created
    ) {
      try {
        await this.fileApi.deleteFile(`${operation.tenantId}/${operation.id.toHexString()}`);
      } catch (err) {
        // May not have been uploaded, may have already been deleted.
        logger.warn('Failed to delete operation file', err, operation);
      }
    }
  }

  protected async createDefaultSubscriptions(checkpoint: CheckpointCallback): Promise<void> {
    const res = await execute(
      this.db.getTenants(),
      async (tenant) => {
        const newTenant = !tenant.version;
        switch (tenant.version) {
          case null: // Fallthrough
          case undefined: {
            await createSubscription(tenant.id, {
              topicType: EventTypes.AssetDelete,
              topicId: '#',
            });
            await this.db.updateTenantVersion(tenant.id, 1);
          }
          // Fallthrough
          default:
            break;
        }
        if (newTenant) {
          await this.eventQueue.write({
            id: new LongObjectId().toHexString(),
            tenantId: tenant.id,
            type: EventTypes.TenantCreated,
            sourceType: EventIdTypes.Service,
            sourceId: SERVICE_EVENT_ID,
            targetType: EventIdTypes.Tenant,
            targetId: tenant.id,
          });
        }
        await checkpoint();
      },
      TENANT_AUGMENT_EXECUTION_OPTIONS,
    );

    if (res.errors.length > 0) {
      // String message to be stored in the DB.
      logger.error('Create default subscription errors', res.errors);
      throw new Error(res.errors.map((err) => err.message).join(', '));
    }
  }
}

export async function initService(cloudInterface: CloudInterface<PipelineEvent>): Promise<void> {
  const eventQueue = await cloudInterface.initEventQueue();
  const fileApi = await cloudInterface.initFileApi({ bucketName: OOB_BUCKET });
  if (!fileApi.getFileUploadLink) {
    throw new Error('getFileUploadLink not set');
  }
  OutOfBandServer.run(eventQueue, fileApi, (callback) => cloudInterface.initInputQueue(callback));
}
