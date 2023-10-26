import {
  OobAssetRequest,
  OobAsset
} from '@bsquare/companion-common';
import { exchangeSystemToken, appendParams } from '@bsquare/companion-service-common';
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
      expect(assets.find(asset => asset.assetId === assetId)).to.be.an('object');
    }
    // Check only these fields are present and nothing has leaked.
    expect(assets[0]).to.deep.equal({
      assetId: assets[0]?.assetId,
      lastActive: assets[0]?.lastActive,
    });
  });
});
