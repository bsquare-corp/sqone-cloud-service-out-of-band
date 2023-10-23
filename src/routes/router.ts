import { BadRequestError, getLogger, LongObjectId } from '@bsquare/base-service';
import {
  EventIdTypes,
  EventTypes,
  OobEdgeOperation,
  OobEdgeOperationReboot,
  OobEdgeOperationRestartServices,
  OobEdgeOperationRestartServicesParameters,
  OobOperationName,
  OobOperationStatusCode,
} from '@bsquare/companion-common';
import { authenticate, AuthenticateLocals } from '@bsquare/companion-service-common';
import { Router } from 'express';
import type { OobAssetDb } from '../database';
import { handle } from './handle';

const logger = getLogger('companion-common-service-out-of-band.router');

export const outOfBandRouter = Router();

interface AssetLocals {
  tenantId: string;
  asset: OobAssetDb;
}

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
  const asset = await db.authenticateAsset(token);
  await db.updateAssetActivity(asset.tenantId, asset.assetId);

  res.locals.tenantId = asset.tenantId;
  res.locals.asset = asset;

  next();
});

outOfBandRouter.put(
  '/assets/:assetId',
  authenticate(['OutOfBand.Register']),
  handle<AuthenticateLocals>(async ({ res, req, dispatchEvent, db, locals }) => {
    // This is only called from central which ensures the asset already exists.
    const assetId = req.params.assetId;
    if (!assetId) {
      throw new BadRequestError('assetId not valid in route');
    }
    const token = await db.createAsset(locals.tenantId, assetId);
    await dispatchEvent({
      id: new LongObjectId().toHexString(),
      tenantId: locals.tenantId,
      type: EventTypes.OobTokenGenerate,
      ...locals.eventSource,
      targetType: EventIdTypes.Asset,
      targetId: assetId,
    });
    res.status(201).json(token);
  }),
);

outOfBandRouter.get(
  '/edge/operations',
  authenticateAsset,
  handle<AssetLocals>(async ({ res, db, locals }) => {
    // TODO First mark any reboot operations as complete if boot ID is different.
    // TODO Update bootId.
    const operations = await db.getOperations(locals.tenantId, {
      assetId: locals.asset.assetId,
      sortBy: 'id',
      // Oldest first
      sortDirection: 'DESC',
      // TODO Check which states are right.
      status: {
        equals: [
          OobOperationStatusCode.Created,
          OobOperationStatusCode.Pending,
          OobOperationStatusCode.InProgress,
        ],
      },
    });

    // Allow it to return promises for generating an upload link.
    const edgeOperationPromises: Array<
      Promise<OobEdgeOperation | undefined> | OobEdgeOperation | undefined
    > = operations.map((operation) => {
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
          // TODO Set response parameters to include pre-signed link for upload.
          throw new Error('Not implemented');
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
    });

    const edgeOperations = await Promise.all(edgeOperationPromises);
    res.json(edgeOperations.filter((edgeOperation) => edgeOperation !== undefined));
  }),
);
