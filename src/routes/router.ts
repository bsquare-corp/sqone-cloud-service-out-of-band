import { BadRequestError, LongObjectId, NotFoundError, Validator } from '@bsquare/base-service';
import {
  EventIdTypes,
  EventTypes,
  getSchemaPath,
  OobAsset,
  OobAssetRequest,
  OobOperation,
  OobOperationCreateRequest,
  OobOperationName,
  OobOperationRequest,
  OobOperationStatusCode,
  OobOperationUpdateRequest,
} from '@bsquare/companion-common';
import { authenticate, AuthenticateLocals } from '@bsquare/companion-service-common';
import { Router } from 'express';
import { MAX_PENDING_OPERATIONS_PER_ASSET } from '../config';
import { IN_PROGRESS_OPERATION_STATUSES } from '../database';
import { handle } from './handle';
import { outOfBandEdgeRouter } from './router-edge';

export const outOfBandRouter = Router();

const SCHEMA_PATH = getSchemaPath();
const ASSET_REQUEST_VALIDATOR = Validator.loadSync<OobAssetRequest>('OobAssetRequest', SCHEMA_PATH);
const OPERATION_REQUEST_VALIDATOR = Validator.loadSync<OobOperationRequest>(
  'OobOperationRequest',
  SCHEMA_PATH,
);
const OPERATION_CREATE_VALIDATOR = Validator.loadSync<OobOperationCreateRequest>(
  'OobOperationCreateRequest',
  SCHEMA_PATH,
);
const OPERATION_UPDATE_VALIDATOR = Validator.loadSync<OobOperationUpdateRequest>(
  'OobOperationUpdateRequest',
  SCHEMA_PATH,
);

outOfBandRouter.use('/edge', outOfBandEdgeRouter);

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
  '/assets',
  authenticate(),
  handle<AuthenticateLocals>(async ({ res, db, locals, params }) => {
    const options = ASSET_REQUEST_VALIDATOR.validate(params);
    const dbAssets = await db.getAssets(locals.tenantId, options);
    const assets: OobAsset[] = dbAssets.map((asset) => ({
      assetId: asset.assetId,
      ...(asset.bootId ? { bootId: asset.bootId } : {}),
      lastActive: asset.lastActive.toISOString(),
    }));
    res.json(assets);
  }),
);

outOfBandRouter.get(
  '/operations',
  authenticate(),
  handle<AuthenticateLocals>(async ({ res, db, locals, params }) => {
    const options = OPERATION_REQUEST_VALIDATOR.validate(params);
    const dbOperations = await db.getOperations(locals.tenantId, options);
    const operations: Array<OobOperation<unknown>> = dbOperations.map((operation) => ({
      id: operation.id.toHexString(),
      assetId: operation.assetId,
      name: operation.name as OobOperationName,
      status: operation.status,
      ...(operation.additionalDetails !== undefined
        ? { additionalDetails: operation.additionalDetails }
        : {}),
      ...(operation.progress !== undefined ? { progress: operation.progress } : {}),
      tries: operation.tries,
      parameters: operation.parameters,
    }));
    res.json(operations);
  }),
);

outOfBandRouter.post(
  '/assets/:assetId/operations',
  authenticate('OutOfBand.Manage'),
  handle<AuthenticateLocals>(async ({ req, res, db, locals, params, dispatchEvent }) => {
    const request = OPERATION_CREATE_VALIDATOR.validate(params);
    const assetId = req.params.assetId;
    if (!assetId) {
      throw new BadRequestError('assetId missing in route');
    }
    const [asset] = await db.getAssets(locals.tenantId, { assetId });
    if (!asset) {
      throw new NotFoundError('Out of band asset not found');
    }
    const pendingOperations = await db.getOperations(locals.tenantId, {
      assetId,
      status: IN_PROGRESS_OPERATION_STATUSES,
    });
    if (pendingOperations.length >= MAX_PENDING_OPERATIONS_PER_ASSET) {
      throw new BadRequestError('Device has too many pending operations');
    }
    const id = await db.createOperation(locals.tenantId, asset.assetId, request);
    await dispatchEvent({
      id: new LongObjectId().toHexString(),
      tenantId: locals.tenantId,
      type: EventTypes.OobOperationCreate,
      ...locals.eventSource,
      targetType: EventIdTypes.Asset,
      targetId: assetId,
      data: { id, request },
    });
    res.status(201).json(id);
  }),
);

outOfBandRouter.patch(
  '/assets/:assetId/operations/:operationId',
  authenticate('OutOfBand.Manage'),
  handle<AuthenticateLocals>(async ({ req, res, db, locals, params, dispatchEvent }) => {
    const request = OPERATION_UPDATE_VALIDATOR.validate(params);
    const assetId = req.params.assetId;
    if (!assetId) {
      throw new BadRequestError('assetId missing in route');
    }
    const operationId = req.params.operationId;
    if (!operationId) {
      throw new BadRequestError('operationId missing in route');
    }
    const [operation] = await db.getOperations(locals.tenantId, { assetId, id: operationId });
    if (!operation) {
      throw new NotFoundError('Operation not found');
    }

    const updated = await db.updateOperation(locals.tenantId, assetId, operationId, request, [
      OobOperationStatusCode.Created,
    ]);
    if (!updated) {
      throw new BadRequestError('Only operations not yet acknowledged can be cancelled');
    }

    await dispatchEvent({
      id: new LongObjectId().toHexString(),
      tenantId: locals.tenantId,
      type: EventTypes.OobOperationUpdate,
      ...locals.eventSource,
      targetType: EventIdTypes.Asset,
      targetId: assetId,
      data: { operation, request },
    });
    res.sendStatus(204);
  }),
);

outOfBandRouter.get(
  '/assets/:assetId/operations/:operationId/link',
  authenticate(),
  handle<AuthenticateLocals>(async ({ req, res, db, locals, fileApi }) => {
    const assetId = req.params.assetId;
    if (!assetId) {
      throw new BadRequestError('assetId missing in route');
    }
    const operationId = req.params.operationId;
    if (!operationId) {
      throw new BadRequestError('operationId missing in route');
    }
    const [operation] = await db.getOperations(locals.tenantId, { assetId, id: operationId });
    if (!operation) {
      throw new NotFoundError('Operation not found');
    }

    if (operation.name !== OobOperationName.SendFiles) {
      throw new BadRequestError('This operation does not support file transfer');
    }
    if (operation.status !== OobOperationStatusCode.Success) {
      throw new BadRequestError(
        'This operation has not completed successfully so there are no files',
      );
    }

    // Sanitise the date removing invalid characters for windows filenames.
    const date = operation.id.getTimestamp().toISOString().split(':').join('-').split('.')[0];
    // Currently only send files is supported and it always sends zips.
    const filename = `${operation.name}-${operation.assetId}-${date}.zip`;
    res.json(
      await fileApi.getFileLink(`${locals.tenantId}/${operation.id.toHexString()}`, filename),
    );
  }),
);
