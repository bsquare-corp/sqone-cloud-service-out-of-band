import {
  BadRequestError,
  getLogger,
  LongObjectId,
  NotFoundError,
  Validator,
} from '@bsquare/base-service';
import {
  EventIdTypes,
  EventTypes,
  getSchemaPath,
  OobEdgeOperation,
  OobEdgeOperationReboot,
  OobEdgeOperationRestartServices,
  OobEdgeOperationRestartServicesParameters,
  OobEdgeOperationSendFiles,
  OobEdgeOperationSendFilesParameters,
  OobEdgeOperationUpdate,
  OobOperationName,
  OobOperationStatusCode,
} from '@bsquare/companion-common';
import { EventSource } from '@bsquare/companion-service-common';
import { Router } from 'express';
import { LRUCache } from 'lru-cache';
import { MAX_OPERATION_TRIES, TOKEN_CACHE_MAX, TOKEN_CACHE_TTL_MS } from '../config';
import {
  IN_PROGRESS_OPERATION_STATUSES,
  OobAssetDb,
  OobOperationDb,
  OperationUpdateDb,
  OutOfBandDb,
} from '../database';
import { parseOobHeader } from '../oob-header-parser';
import { handle, RaiseEventCallback } from './handle';

const logger = getLogger('companion-common-service-out-of-band.router');

const SCHEMA_PATH = getSchemaPath();
const EDGE_UPDATE_OPERATION_VALIDATOR = Validator.loadSync<OobEdgeOperationUpdate>(
  'OobEdgeOperationUpdate',
  SCHEMA_PATH,
);

export const outOfBandEdgeRouter = Router();

interface AssetLocals {
  tenantId: string;
  asset: OobAssetDb;
  eventSource: EventSource;
  bootId?: string;
}

const tokenCache = new LRUCache<string, { tenantId: string; assetId: string }>({
  max: TOKEN_CACHE_MAX,
  ttl: TOKEN_CACHE_TTL_MS,
});

const authenticateAsset = handle<AssetLocals>(async ({ req, res, next, db }) => {
  if (typeof req.headers.authorization !== 'string') {
    throw new BadRequestError('Missing Authorization header');
  }
  const [headerType, token] = req.headers.authorization.split(' ').map((el) => el.trim());
  if (!headerType || headerType.toLowerCase() !== 'bearer') {
    throw new BadRequestError('Expected Authorization Bearer type');
  }
  if (!token) {
    throw new BadRequestError('Missing token after bearer');
  }
  const tokenCacheResult = tokenCache.get(token);
  // Even when cached need to re-fetch the asset to get the latest bootId.
  const asset = tokenCacheResult
    ? await db
        .getAssets(tokenCacheResult.tenantId, { assetId: tokenCacheResult.assetId })
        .then((assets) => assets[0])
    : await db.authenticateAsset(token);
  if (!asset) {
    throw new NotFoundError('Asset not found for session');
  }
  if (!tokenCacheResult) {
    tokenCache.set(token, { tenantId: asset.tenantId, assetId: asset.assetId });
  }
  // Don't block requests for this.
  db.updateAssetActivity(asset.tenantId, asset.assetId).catch((err) => {
    logger.warn('Failed to update asset activity', err);
  });

  const oobHeader = req.headers['x-oob'];
  if (typeof oobHeader === 'string') {
    const keyValuePairs = parseOobHeader(oobHeader);
    res.locals.bootId = keyValuePairs.uuid;
  }

  res.locals.tenantId = asset.tenantId;
  res.locals.asset = asset;
  res.locals.eventSource = {
    sourceType: EventIdTypes.Asset,
    sourceId: asset.assetId,
  };

  next();
});

async function updateOperation(options: {
  db: OutOfBandDb;
  dispatchEvent: RaiseEventCallback;
  operation: OobOperationDb;
  update: OperationUpdateDb;
  eventSource: EventSource;
}): Promise<void> {
  const updated = await options.db.updateOperation(
    options.operation.tenantId,
    options.operation.assetId,
    options.operation.id.toHexString(),
    options.update,
    IN_PROGRESS_OPERATION_STATUSES,
  );
  // Ignore if operation already complete in DB, then don't raise event.
  if (updated) {
    await options.dispatchEvent({
      id: new LongObjectId().toHexString(),
      tenantId: options.operation.tenantId,
      type: EventTypes.OobOperationUpdate,
      ...options.eventSource,
      targetType: EventIdTypes.Asset,
      targetId: options.operation.assetId,
      data: options.update,
    });
  } else {
    if (IN_PROGRESS_OPERATION_STATUSES.includes(options.update.status)) {
      logger.info(
        'In progress status update received for completed operation',
        options.operation,
        options.update,
      );
    } else {
      logger.warn(
        'Second completion update for completed operation',
        options.operation,
        options.update,
      );
    }
  }
}

outOfBandEdgeRouter.patch(
  '/operations/:operationId',
  authenticateAsset,
  handle<AssetLocals>(async ({ res, req, db, locals, dispatchEvent }) => {
    const update = EDGE_UPDATE_OPERATION_VALIDATOR.validate(req.body);
    const operationId = req.params.operationId;
    if (!operationId) {
      throw new BadRequestError('operationId not set in route');
    }
    const [operation] = await db.getOperations(locals.tenantId, {
      assetId: locals.asset.assetId,
      id: operationId,
    });
    if (!operation) {
      throw new NotFoundError('Operation not found');
    }
    await updateOperation({
      db,
      dispatchEvent,
      operation,
      eventSource: locals.eventSource,
      update: {
        ...update,
        ...(operation.status === OobOperationStatusCode.Created ? { tries: 1 } : {}),
      },
    });
    res.sendStatus(204);
  }),
);

outOfBandEdgeRouter.get(
  '/operations',
  authenticateAsset,
  handle<AssetLocals>(async ({ res, db, locals, fileApi, dispatchEvent }) => {
    let operations = await db.getOperations(locals.tenantId, {
      assetId: locals.asset.assetId,
      sortBy: 'id',
      // Oldest first
      sortDirection: 'ASC',
      status: {
        equals: [
          OobOperationStatusCode.Created,
          OobOperationStatusCode.Pending,
          OobOperationStatusCode.InProgress,
        ],
      },
    });

    // If the bootId is specified then update the asset with the new bootId.
    if (locals.bootId) {
      await db.updateAsset(locals.asset.tenantId, locals.asset.assetId, { bootId: locals.bootId });
      // If there was a bootId before and it has changed then mark pending reboot operations as succesful and remove them from the list of operations.
      if (locals.asset.bootId && locals.asset.bootId !== locals.bootId) {
        const pendingRebootOperations = operations.filter(
          (operation) =>
            operation.name === OobOperationName.Reboot &&
            operation.status !== OobOperationStatusCode.Created,
        );

        if (pendingRebootOperations.length > 0) {
          await Promise.all(
            pendingRebootOperations.map((operation) =>
              updateOperation({
                db,
                dispatchEvent,
                operation,
                eventSource: locals.eventSource,
                update: {
                  status: OobOperationStatusCode.Success,
                },
              }),
            ),
          );
          // Remove pending reboot operations for operations list.
          operations = operations.filter(
            (operation) =>
              !pendingRebootOperations.find((rebootOperation) => rebootOperation === operation),
          );
        }
      }
    }

    // For each expired operation mark it as failed and remove it from the list of pending operations.
    const expiredOperations = operations.filter(
      (operation) => operation.tries >= MAX_OPERATION_TRIES,
    );
    if (expiredOperations.length > 0) {
      operations = operations.filter(
        (operation) =>
          !expiredOperations.find((expiredOperation) => expiredOperation === operation),
      );
      await Promise.all(
        expiredOperations.map((operation) =>
          updateOperation({
            db,
            dispatchEvent,
            operation,
            eventSource: locals.eventSource,
            update: {
              status: OobOperationStatusCode.Failed,
              additionalDetails: `Device failed to complete operation after ${MAX_OPERATION_TRIES} tries`,
            },
          }),
        ),
      );
    }

    // Increase retries if an operation has previously been started
    await db.increaseOperationTries(
      operations
        .filter((operation) => operation.status !== OobOperationStatusCode.Created)
        .map((operation) => operation.id),
    );

    // Map each raw database operation to an operation structure the device is expecting.
    // Allow it to return promises for generating an upload link.
    const edgeOperationPromises: Array<Promise<OobEdgeOperation | undefined>> = operations.map(
      async (operation) => {
        const base = {
          id: operation.id.toHexString(),
          name: operation.name,
          // If the status is created then do not send it to the device. It doesn't understand this status, its equivalent is no status.
          ...(operation.status === OobOperationStatusCode.Created
            ? {}
            : { status: operation.status }),
        };

        switch (operation.name) {
          case OobOperationName.SendFiles: {
            // This should never be the case because the service should exit on startup.
            if (!fileApi.getFileUploadLink) {
              logger.error('getFileUploadLink not defined');
              return undefined;
            }
            return {
              ...base,
              parameters: {
                ...(operation.parameters as Pick<
                  OobEdgeOperationSendFilesParameters,
                  'paths' | 'knownPaths'
                >),
                method: 'PUT',
                destination: await fileApi.getFileUploadLink(`${operation.tenantId}/${base.id}`),
              },
            } as OobEdgeOperationSendFiles;
          }
          case OobOperationName.RestartServices:
            return {
              ...base,
              parameters: operation.parameters as OobEdgeOperationRestartServicesParameters,
            } as OobEdgeOperationRestartServices;
          case OobOperationName.Reboot:
            return base as OobEdgeOperationReboot;
          default:
            logger.warn('Unhandled operation type for device', operation);
            return undefined;
        }
      },
    );

    const edgeOperations = await Promise.all(edgeOperationPromises);
    res.json(edgeOperations.filter((edgeOperation) => edgeOperation !== undefined));
  }),
);
