import { BadRequestError, LongObjectId, Validator } from '@bsquare/base-service';
import { EventIdTypes, EventTypes, getSchemaPath, OobAssetRequest, OobAsset } from '@bsquare/companion-common';
import { authenticate, AuthenticateLocals } from '@bsquare/companion-service-common';
import { Router } from 'express';
import { handle } from './handle';
import { outOfBandEdgeRouter } from './router-edge';

export const outOfBandRouter = Router();

const SCHEMA_PATH = getSchemaPath();
const ASSET_REQUEST_VALIDATOR = Validator.loadSync<OobAssetRequest>(
  'OobAssetRequest',
  SCHEMA_PATH,
);

// TODO When adding endpoint to create operations limit them to X per device.

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

outOfBandRouter.get('/assets', authenticate(), handle<AuthenticateLocals>(async ({ res, db, locals, params }) => {
  const options = ASSET_REQUEST_VALIDATOR.validate(params);
  const dbAssets = await db.getAssets(locals.tenantId, options);
  const assets: OobAsset[] = dbAssets.map(asset => ({
    assetId: asset.assetId,
    ...(asset.bootId ? { bootId: asset.bootId } : {}),
    lastActive: asset.lastActive.toISOString()
  }));
  res.json(assets);
}));
