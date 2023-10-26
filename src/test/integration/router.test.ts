import {
  OobAsset,
  OobAssetRequest,
  OobOperation,
  OobOperationCreateRequest,
  OobOperationName,
  OobOperationRequest,
  OobOperationStatusCode,
} from '@bsquare/companion-common';
import { appendParams, exchangeSystemToken } from '@bsquare/companion-service-common';
import Assert from 'assert';
import { expect } from 'chai';
import { describe, it } from 'mocha';
import Fetch from 'node-fetch';
import { MAX_PENDING_OPERATIONS_PER_ASSET } from '../../config';
import { OOB_API_URI, oobApi } from '../integration-wrapper';

const systemToken = 'system@test-token';

async function getAssets(tenantId: string, request?: OobAssetRequest): Promise<OobAsset[]> {
  let url = `${OOB_API_URI}/v1/api/oob/assets`;
  if (request) {
    url = appendParams(url, request as unknown as Record<string, unknown>);
  }
  const res = await Fetch(url, {
    headers: {
      'Authorization': `Bearer ${await exchangeSystemToken(systemToken)}`,
      'X-Tenant': tenantId,
    },
  });
  if (!res.ok) {
    throw new Error(`Request failed: ${await res.text()}`);
  }
  return res.json() as Promise<OobAsset[]>;
}

async function getOperations(
  tenantId: string,
  request?: OobOperationRequest,
): Promise<OobOperation[]> {
  let url = `${OOB_API_URI}/v1/api/oob/operations`;
  if (request) {
    url = appendParams(url, request as unknown as Record<string, unknown>);
  }
  const res = await Fetch(url, {
    headers: {
      'Authorization': `Bearer ${await exchangeSystemToken(systemToken)}`,
      'X-Tenant': tenantId,
    },
  });
  if (!res.ok) {
    throw new Error(`Request failed: ${await res.text()}`);
  }
  return res.json() as Promise<OobOperation[]>;
}

async function createOperation(
  tenantId: string,
  assetId: string,
  request: OobOperationCreateRequest,
): Promise<string> {
  const res = await Fetch(`${OOB_API_URI}/v1/api/oob/assets/${assetId}/operations`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${await exchangeSystemToken(systemToken)}`,
      'X-Tenant': tenantId,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(request),
  });
  if (!res.ok) {
    throw new Error(`Request failed: ${await res.text()}`);
  }
  expect(res.status).to.equal(201);
  const operationId = (await res.json()) as string;
  expect(operationId).to.be.a('string');
  return operationId;
}

describe('Management Router tests', () => {
  afterEach(async () => {
    await oobApi.db.query('DELETE FROM `oob_assets`', [], {
      transaction: false,
      checkTenant: false,
    });
  });

  it('List assets', async () => {
    await oobApi.db.createAsset('tenant-a', 'asset-a');
    await oobApi.db.createAsset('tenant-a', 'asset-b');
    await oobApi.db.createAsset('tenant-a', 'asset-c');

    const assets = await getAssets('tenant-a');
    // Check they're all there
    for (const assetId of ['asset-a', 'asset-b', 'asset-c']) {
      expect(assets.find((asset) => asset.assetId === assetId)).to.be.an('object');
    }
    // Check only these fields are present and nothing has leaked.
    expect(assets[0]).to.deep.equal({
      assetId: assets[0]?.assetId,
      lastActive: assets[0]?.lastActive,
    });

    // Check that all the sql filters are at least valid sql.
    expect(
      await getAssets('tenant-a', {
        assetId: 'test',
        bootId: 'test',
        lastActive: { equals: new Date() },
      }),
    ).to.deep.equal([]);
  });

  it('List operations', async () => {
    await oobApi.db.createAsset('tenant-a', 'asset-a');
    await oobApi.db.createAsset('tenant-a', 'asset-b');

    const operationIdA = await oobApi.db.createOperation('tenant-a', 'asset-a', {
      name: OobOperationName.Reboot,
    });
    const operationIdB = await oobApi.db.createOperation('tenant-a', 'asset-a', {
      name: OobOperationName.RestartServices,
    });
    const operationIdC = await oobApi.db.createOperation('tenant-a', 'asset-b', {
      name: OobOperationName.Reboot,
    });

    expect(await getOperations('tenant-a', { sortBy: 'id', sortDirection: 'ASC' })).to.deep.equal([
      {
        id: operationIdA,
        assetId: 'asset-a',
        name: OobOperationName.Reboot,
        tries: 0,
        status: OobOperationStatusCode.Created,
      },
      {
        id: operationIdB,
        assetId: 'asset-a',
        name: OobOperationName.RestartServices,
        tries: 0,
        status: OobOperationStatusCode.Created,
      },
      {
        id: operationIdC,
        assetId: 'asset-b',
        name: OobOperationName.Reboot,
        tries: 0,
        status: OobOperationStatusCode.Created,
      },
    ]);

    // Filter by asset ID
    expect(
      await getOperations('tenant-a', { assetId: 'asset-a' }).then((res) => res.length),
    ).to.equal(2);

    // Filter by all the fields for SQL sanity checking.
    expect(
      await getOperations('tenant-a', {
        id: operationIdA,
        assetId: 'asset-a',
        name: OobOperationName.Reboot,
        status: OobOperationStatusCode.Created,
        tries: { equals: 0 },
      }).then((res) => res.length),
    ).to.equal(1);
  });

  it('Create operation', async () => {
    await oobApi.db.createAsset('tenant-a', 'asset-a');

    const operationId = await createOperation('tenant-a', 'asset-a', {
      name: OobOperationName.RestartServices,
    });

    expect(await getOperations('tenant-a')).to.deep.equal([
      {
        id: operationId,
        name: OobOperationName.RestartServices,
        tries: 0,
        status: OobOperationStatusCode.Created,
        assetId: 'asset-a',
      },
    ]);
  });

  it('Cant create too many operations', async () => {
    await oobApi.db.createAsset('tenant-a', 'asset-a');
    await oobApi.db.createAsset('tenant-a', 'asset-b');

    let firstOperationId = undefined as string | undefined;
    // Max out the pending operations per asset
    for (let i = 0; i < MAX_PENDING_OPERATIONS_PER_ASSET; i++) {
      const operationId = await createOperation('tenant-a', 'asset-a', {
        name: OobOperationName.RestartServices,
      });
      if (firstOperationId === undefined) {
        firstOperationId = operationId;
      }
    }
    // Make sure more can't be created for that asset
    await Assert.rejects(
      createOperation('tenant-a', 'asset-a', {
        name: OobOperationName.RestartServices,
      }),
    );

    // Make sure the limit doesn't apply accross assets
    await createOperation('tenant-a', 'asset-b', {
      name: OobOperationName.RestartServices,
    });

    // Cancel an operation and make sure creating another works.
    expect(firstOperationId).to.be.a('string');
    await oobApi.db.updateOperation('tenant-a', 'asset-a', firstOperationId as string, {
      status: OobOperationStatusCode.Cancelled,
    });
    await createOperation('tenant-a', 'asset-a', {
      name: OobOperationName.RestartServices,
    });
  });
});
