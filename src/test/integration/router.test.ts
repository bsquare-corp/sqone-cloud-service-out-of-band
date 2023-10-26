import {
  OobAsset,
  OobAssetRequest,
  OobOperation,
  OobOperationName,
  OobOperationRequest,
  OobOperationStatusCode,
} from '@bsquare/companion-common';
import { appendParams, exchangeSystemToken } from '@bsquare/companion-service-common';
import { expect } from 'chai';
import { describe, it } from 'mocha';
import Fetch from 'node-fetch';
import { OOB_API_URI, oobApi } from '../integration-wrapper';

const regToken = 'reg@test-token';

async function getAssets(tenantId: string, request?: OobAssetRequest): Promise<OobAsset[]> {
  let url = `${OOB_API_URI}/v1/api/oob/assets`;
  if (request) {
    url = appendParams(url, request as unknown as Record<string, unknown>);
  }
  const res = await Fetch(url, {
    headers: {
      'Authorization': `Bearer ${await exchangeSystemToken(regToken)}`,
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
      'Authorization': `Bearer ${await exchangeSystemToken(regToken)}`,
      'X-Tenant': tenantId,
    },
  });
  if (!res.ok) {
    throw new Error(`Request failed: ${await res.text()}`);
  }
  return res.json() as Promise<OobOperation[]>;
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
});
