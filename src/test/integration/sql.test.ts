import { expect } from 'chai';
import { describe, it } from 'mocha';
import { oobApi } from '../integration-wrapper';

describe('Database tests', () => {
  afterEach(async () => {
    await oobApi.db.query('DELETE FROM `oob_assets`', [], {
      transaction: false,
      checkTenant: false,
    });
  });

  it('Create and authenticate asset', async () => {
    const token = await oobApi.db.createAsset('tenant-a', 'asset-a');
    expect(token).to.be.a('string');
    console.time('authenticateAsset');
    const asset = await oobApi.db.authenticateAsset(token);
    console.timeEnd('authenticateAsset');
    expect(asset).to.deep.include({
      tenantId: 'tenant-a',
      assetId: 'asset-a',
    });
    expect(asset.lastActive).to.be.a('Date');
    expect(asset.secretHash).to.be.a('string');
    expect(asset.bootId).to.equal(undefined);
  });
});
