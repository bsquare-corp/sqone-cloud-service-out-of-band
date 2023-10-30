import {
  BadRequestError,
  LongObjectId,
  NotFoundError,
  UnauthorizedError,
} from '@bsquare/base-service';
import {
  OobAssetRequest,
  OobOperationCreateRequest,
  OobOperationRequest,
  OobOperationStatusCode,
} from '@bsquare/companion-common';
import {
  bufferToString,
  createSqlWrapper,
  Database,
  generateRandomBytes,
  GenericIterator,
  makeInsert,
  makeUpdate,
  makeUpsert,
  SqlFilterMap,
} from '@bsquare/companion-service-common';
import * as Argon2 from 'argon2';
import * as MySQL from 'mysql2/promise';
import Path from 'path';

const TOKEN_SECRET_LENGTH_BYTES = 32;

export interface OobAssetDb {
  tenantId: string;
  assetId: string;
  bootId?: string;
  lastActive?: Date;
  secretHash: string;
}

export interface OperationUpdateDb {
  status: OobOperationStatusCode;
  additionalDetails?: string | null;
  progress?: { position: number; size?: number } | null;
  tries?: number;
}

export interface OobAssetUpdateDb {
  bootId: string;
}

export interface OobTenant {
  id: string;
  version?: number | null;
}

// This will be used when there's operations on the table.
export interface OobOperationDb<T = unknown> {
  tenantId: string;
  assetId: string;
  id: LongObjectId;
  name: string;
  status: OobOperationStatusCode;
  tries: number;
  additionalDetails?: string;
  parameters?: T;
  progress?: { position: number; size?: number };
}

const OPERATION_FILTER_MAP: SqlFilterMap = {
  id: { type: 'id' },
  asset_id: { type: 'string', name: 'assetId' },
  name: { type: 'string' },
  status: { type: 'string' },
  tries: { type: 'number' },
};

const ASSET_FILTER_MAP: SqlFilterMap = {
  asset_id: { name: 'assetId', type: 'string' },
  boot_id: { name: 'bootId', type: 'string' },
  last_active: { name: 'lastActive', type: 'date' },
};

export const IN_PROGRESS_OPERATION_STATUSES = [
  OobOperationStatusCode.Created,
  OobOperationStatusCode.Pending,
  OobOperationStatusCode.InProgress,
];

export class OutOfBandDb extends Database {
  public override async connect(): Promise<void> {
    await super.connect([]);
    await this.applyUpdate('oob_001_init', '001_init.sql');
  }

  public override async applyUpdate(patchName: string, file: string): Promise<void> {
    // Makes the paths relative
    await super.applyUpdate(patchName, Path.resolve(Path.dirname(__filename), 'updates', file));
  }

  public getTenants(): Promise<AsyncIterable<OobTenant>> {
    return this.streamQuery('SELECT * FROM `oob_tenants`');
  }

  public async updateTenantVersion(tenantId: string, version: number): Promise<void> {
    await this.query('UPDATE `oob_tenants` SET `version` = ? WHERE `id` = ?', [version, tenantId], {
      checkTenant: false,
    });
  }

  public async deleteAsset(tenantId: string, assetId: string): Promise<void> {
    // Also deletes any operations attached to the asset.
    await this.query(
      'DELETE FROM `oob_assets` WHERE `tenant_id` = ? AND `asset_id` = ?',
      [tenantId, assetId],
      { transaction: false },
    );
  }

  public iterateOperations(
    tenantId: string | undefined,
    options: OobOperationRequest,
  ): AsyncIterable<OobOperationDb> {
    return new GenericIterator<LongObjectId, OobOperationDb>(
      async (size: number, afterId?: LongObjectId) => {
        const operations = await this.getOperations(tenantId, {
          ...options,
          size,
          sortBy: 'id',
          sortDirection: 'ASC',
          ...(afterId ? { id: { after: afterId.toHexString() } } : {}),
        });
        const newAfterId = operations[operations.length - 1]?.id;
        return { items: operations, ...(newAfterId ? { afterId: newAfterId } : {}) };
      },
    );
  }

  public async deleteOperation(id: LongObjectId): Promise<void> {
    await super.query('DELETE FROM `oob_operations` WHERE `id` = ?', [id.toBSON()], {
      checkTenant: false,
      transaction: false,
    });
  }

  public async getOperations(
    tenantId: string | undefined,
    options: OobOperationRequest,
  ): Promise<OobOperationDb[]> {
    const filter = createSqlWrapper(
      {
        query: tenantId
          ? 'SELECT * FROM `oob_operations` WHERE `tenant_id` = ?'
          : 'SELECT * FROM `oob_operations`',
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
      [...(tenantId ? [tenantId] : []), ...(filter.values || [])],
      { transaction: false, removeNulls: true, checkTenant: false },
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

  // Returns true if any rows match the criteria.
  public async updateOperation(
    tenantId: string,
    assetId: string,
    operationId: string,
    request: OperationUpdateDb,
    whereStatuses?: OobOperationStatusCode[],
  ): Promise<boolean> {
    let whereQuery = '`tenant_id` = ? AND `asset_id` = ? AND `id` = ?';
    const whereValues: unknown[] = [tenantId, assetId, new LongObjectId(operationId).toBSON()];
    if (whereStatuses) {
      whereQuery = `${whereQuery} AND \`status\` IN (${whereStatuses.map(() => '?').join(', ')})`;
      whereValues.push(...whereStatuses);
    }

    const { query, values } = makeUpdate('oob_operations', whereQuery, [
      { name: 'status', value: request.status },
      { name: 'additional_details', value: request.additionalDetails },
      {
        name: 'progress',
        value: request.progress ? JSON.stringify(request.progress) : request.progress,
      },
      { name: 'tries', value: request.tries },
    ]);

    const res: MySQL.ResultSetHeader = await this.query(
      query,
      // If null, which it shouldn't be, it should be an empty array.
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
      [...(values || []), ...whereValues],
      { transaction: false },
    );
    return res.affectedRows > 0;
  }

  public async increaseOperationTries(operationIds: LongObjectId[]): Promise<void> {
    if (operationIds.length > 0) {
      const query = [
        'UPDATE `oob_operations` SET `tries` = `tries` + 1 WHERE `id` IN (',
        operationIds.map(() => '?').join(', '),
        ')',
      ].join('');
      await super.query(
        query,
        operationIds.map((id) => id.toBSON()),
        { transaction: false, checkTenant: false },
      );
    }
  }

  public getAssets(tenantId: string, options: OobAssetRequest): Promise<OobAssetDb[]> {
    const filter = createSqlWrapper(
      {
        query: 'SELECT * FROM `oob_assets` WHERE `tenant_id` = ?',
      },
      ASSET_FILTER_MAP,
      options,
    );

    return this.query<OobAssetDb[]>(
      filter.query,
      // If null, which it shouldn't be, it should be an empty array.
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
      [tenantId, ...(filter.values || [])],
      { transaction: false, removeNulls: true },
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

  public async updateAsset(
    tenantId: string,
    assetId: string,
    request: OobAssetUpdateDb,
  ): Promise<void> {
    const { query, values } = makeUpdate('oob_assets', '`tenant_id` = ? AND `asset_id` = ?', [
      { name: 'boot_id', value: request.bootId },
    ]);

    await this.query(
      query,
      // If null, which it shouldn't be, it should be an empty array.
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
      [...(values || []), tenantId, assetId],
      { transaction: false },
    );
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
