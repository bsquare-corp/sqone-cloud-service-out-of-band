import {
  BadRequestError,
  LongObjectId,
  NotFoundError,
  UnauthorizedError,
} from '@bsquare/base-service';
import {
  OobEdgeOperationUpdate,
  OobOperationCreateRequest,
  OobOperationRequest,
  OobOperationStatusCode,
  OobOperationUpdateRequest,
} from '@bsquare/companion-common';
import {
  bufferToString,
  createSqlWrapper,
  Database,
  generateRandomBytes,
  makeInsert,
  makeUpdate,
  makeUpsert,
  SqlFilterMap,
} from '@bsquare/companion-service-common';
import * as Argon2 from 'argon2';
import Path from 'path';

const TOKEN_SECRET_LENGTH_BYTES = 32;

export interface OobAssetDb {
  tenantId: string;
  assetId: string;
  bootId?: string;
  lastActive: Date;
  secretHash: string;
}

type OperationUpdateDb = OobEdgeOperationUpdate & OobOperationUpdateRequest;

// This will be used when there's operations on the table.
export interface OobOperationDb<T = unknown> {
  tenantId: string;
  assetId: string;
  id: LongObjectId;
  name: string;
  status: OobOperationStatusCode;
  additionalDetails?: string | null;
  parameters?: T;
  progress?: { position: number; size?: number } | null;
}

const OPERATION_FILTER_MAP: SqlFilterMap = {
  id: { type: 'id' },
  asset_id: { type: 'string', name: 'assetId' },
  name: { type: 'string' },
  status: { type: 'string' },
};

export class OutOfBandDb extends Database {
  public override async connect(): Promise<void> {
    await super.connect([]);
    await this.applyUpdate('oob_001_init', '001_init.sql');
  }

  public override async applyUpdate(patchName: string, file: string): Promise<void> {
    // Makes the paths relative
    await super.applyUpdate(patchName, Path.resolve(Path.dirname(__filename), 'updates', file));
  }

  public async getOperations(
    tenantId: string,
    options: OobOperationRequest,
  ): Promise<OobOperationDb[]> {
    const filter = createSqlWrapper(
      {
        query: 'SELECT * FROM `oob_operations` WHERE `tenant_id` = ?',
      },
      OPERATION_FILTER_MAP,
      options,
    );

    interface OobOperationDbRaw extends Omit<OobOperationDb, 'id'> {
      id: Buffer | number[];
    }

    const operations = await this.query<OobOperationDbRaw[]>(
      filter.query,
      // If null, which it shouldn't be, it should be an empty array.
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
      [tenantId, ...(filter.values || [])],
      { transaction: false, removeNulls: true },
    );
    return operations.map((operation) => ({
      ...operation,
      id: new LongObjectId(bufferToString(operation.id)),
    }));
  }

  public async createOperation(
    tenantId: string,
    assetId: string,
    request: OobOperationCreateRequest,
  ): Promise<string> {
    const id = new LongObjectId();

    const { query, values } = makeInsert('oob_operations', [
      { name: 'tenant_id', value: tenantId },
      { name: 'asset_id', value: assetId },
      { name: 'id', value: id.toBSON() },
      { name: 'name', value: request.name },
      { name: 'status', value: OobOperationStatusCode.Created },
      ...(request.parameters !== undefined
        ? [{ name: 'parameters', value: JSON.stringify(request.parameters) }]
        : []),
    ]);

    await this.query(query, values, { transaction: false });

    return id.toHexString();
  }

  public async updateOperation(
    tenantId: string,
    assetId: string,
    operationId: string,
    request: OperationUpdateDb,
  ): Promise<void> {
    const { query, values } = makeUpdate(
      'oob_operations',
      'WHERE `tenant_id` = ? AND `asset_id` = ? AND `operation_id` = ?',
      [
        { name: 'status', value: request.status },
        { name: 'additional_details', value: request.additionalDetails },
        {
          name: 'progress',
          value: request.progress ? JSON.stringify(request.progress) : request.progress,
        },
      ],
    );

    await this.query(
      query,
      // If null, which it shouldn't be, it should be an empty array.
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
      [...(values || []), tenantId, assetId, new LongObjectId(operationId).toBSON()],
      { transaction: false },
    );
  }

  public async createAsset(tenantId: string, assetId: string): Promise<string> {
    const secretBytes = await generateRandomBytes(TOKEN_SECRET_LENGTH_BYTES);
    const secret = secretBytes.toString('base64');
    const token = Buffer.from(`${assetId}:${secret}`).toString('base64');
    const secretHash = await Argon2.hash(secret);

    const { query, values } = makeUpsert(
      'oob_assets',
      [
        { name: 'last_active', value: new Date() },
        { name: 'secret_hash', value: secretHash },
      ],
      [
        { name: 'tenant_id', value: tenantId },
        { name: 'asset_id', value: assetId },
      ],
    );

    await super.query(query, values, { transaction: false });

    return token;
  }

  public async updateAssetActivity(tenantId: string, assetId: string): Promise<void> {
    await super.query(
      'UPDATE `oob_assets` SET `last_active` = CURRENT_TIMESTAMP WHERE `tenant_id` = ? AND `asset_id` = ?',
      [tenantId, assetId],
      { transaction: false },
    );
  }

  public async authenticateAsset(token: string): Promise<OobAssetDb> {
    const [assetId, secret] = Buffer.from(token, 'base64').toString('utf8').split(':');
    if (!assetId || !secret) {
      throw new BadRequestError('Invalid token format');
    }
    const [asset] = await super.query<OobAssetDb[]>(
      'SELECT * FROM `oob_assets` WHERE `asset_id` = ?',
      [assetId],
      { transaction: false, checkTenant: false, removeNulls: true },
    );
    if (!asset) {
      throw new NotFoundError('Asset not found');
    }
    const match = await Argon2.verify(asset.secretHash, secret);
    if (!match) {
      throw new UnauthorizedError();
    }

    if (Argon2.needsRehash(asset.secretHash)) {
      const newHash = await Argon2.hash(secret);
      await super.query(
        'UPDATE `oob_assets` SET `secret_hash` = ? WHERE `asset_id` = ?',
        [newHash, assetId],
        { transaction: false, checkTenant: false },
      );
    }

    return asset;
  }
}
