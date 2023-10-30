import { LongObjectId } from '@bsquare/base-service';
import { OobOperationName, OobOperationStatusCode } from '@bsquare/companion-common';
import { expect } from 'chai';
import { describe, it } from 'mocha';
import { oobApi, serviceEvents } from '../integration-wrapper';

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

  it('Delete asset', async () => {
    await oobApi.db.createAsset('tenant-a', 'asset-a');
    await oobApi.db.createOperation('tenant-a', 'asset-a', {
      name: OobOperationName.Reboot,
    });
    await oobApi.db.createOperation('tenant-a', 'asset-a', {
      name: OobOperationName.Reboot,
    });
    const operationId = await oobApi.db.createOperation('tenant-a', 'asset-a', {
      name: OobOperationName.SendFiles,
      parameters: { paths: ['/var/lib/datav'] },
    });
    await oobApi.db.updateOperation('tenant-a', 'asset-a', operationId, {
      status: OobOperationStatusCode.InProgress,
    });

    let deletedFileId = undefined as string | undefined;
    serviceEvents.once('deleteFile', (fileId) => {
      deletedFileId = fileId;
    });

    await oobApi.deleteAsset('tenant-a', 'asset-a', () => Promise.resolve());
    expect(deletedFileId).to.equal(`tenant-a/${operationId}`);
  });

  it('Delete operation', async () => {
    await oobApi.db.createAsset('tenant-a', 'asset-a');
    const operationId = await oobApi.db.createOperation('tenant-a', 'asset-a', {
      name: OobOperationName.Reboot,
    });
    await oobApi.db.deleteOperation(new LongObjectId(operationId));
  });
});
