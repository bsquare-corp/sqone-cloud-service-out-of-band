import {
  OobEdgeOperation,
  OobEdgeOperationUpdate,
  OobOperationName,
  OobOperationStatusCode,
  SendFilesKnownPath,
} from '@bsquare/companion-common';
import { exchangeSystemToken } from '@bsquare/companion-service-common';
import { expect } from 'chai';
import { describe, it } from 'mocha';
import Fetch from 'node-fetch';
import { MAX_OPERATION_TRIES } from '../../config';
import { OOB_API_URI, oobApi } from '../integration-wrapper';

const regToken = 'reg@test-token';

async function getEdgeOperations(token: string, bootId: string): Promise<OobEdgeOperation[]> {
  const response = await Fetch(`${OOB_API_URI}/v1/api/oob/edge/operations`, {
    headers: { 'Authorization': `Bearer ${token}`, 'X-OOB': `uuid '${bootId}';` },
  });
  if (!response.ok) {
    throw new Error(`Fetch operations failed: ${await response.text()}`);
  }
  return response.json() as Promise<OobEdgeOperation[]>;
}

async function updateEdgeOperation(
  token: string,
  operationId: string,
  update: OobEdgeOperationUpdate,
): Promise<void> {
  const updatePendingResponse = await Fetch(
    `${OOB_API_URI}/v1/api/oob/edge/operations/${operationId}`,
    {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(update),
    },
  );
  if (!updatePendingResponse.ok) {
    throw new Error(`Fetch operations failed: ${await updatePendingResponse.text()}`);
  }
  expect(updatePendingResponse.status).to.equal(204);
}

describe('Edge Router tests', () => {
  afterEach(async () => {
    await oobApi.db.query('DELETE FROM `oob_assets`', [], {
      transaction: false,
      checkTenant: false,
    });
  });

  it('Create asset and get operations as asset', async () => {
    const createRes = await Fetch(`${OOB_API_URI}/v1/api/oob/assets/asset-b`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${await exchangeSystemToken(regToken)}`,
        'X-Tenant': 'tenant-b',
      },
    });
    if (!createRes.ok) {
      throw new Error(`Create asset failed: ${await createRes.text()}`);
    }
    const token = (await createRes.json()) as string;
    expect(token).to.be.a('string');

    const getRes = await Fetch(`${OOB_API_URI}/v1/api/oob/edge/operations`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!getRes.ok) {
      throw new Error(`Fetch operations failed: ${await getRes.text()}`);
    }
    expect(await getRes.json()).to.deep.equal([]);
  });

  it('Reboot device success', async () => {
    // Create an asset and operation for the device to see.
    const token = await oobApi.db.createAsset('tenant-a', 'asset-a');
    const operationId = await oobApi.db.createOperation('tenant-a', 'asset-a', {
      name: OobOperationName.Reboot,
    });

    // Get the operation which sets the initial boot ID.
    expect(await getEdgeOperations(token, 'boot-a')).to.deep.equal([
      {
        id: operationId,
        name: OobOperationName.Reboot,
      },
    ]);

    // Mark it as pending.
    await updateEdgeOperation(token, operationId, { status: OobOperationStatusCode.Pending });
    expect(
      await oobApi.db.getOperations('tenant-a', { id: operationId }).then((res) => res[0]),
    ).to.deep.include({
      status: OobOperationStatusCode.Pending,
      tries: 1,
    });

    // Fetch with a new boot ID which should mark the operation as succesful and it shouldn't be returned.
    expect(await getEdgeOperations(token, 'boot-b')).to.deep.equal([]);

    expect(
      await oobApi.db.getOperations('tenant-a', { id: operationId }).then((res) => res[0]),
    ).to.deep.include({
      status: OobOperationStatusCode.Success,
      tries: 1,
    });
  });

  it('Restart services success (no services list)', async () => {
    const token = await oobApi.db.createAsset('tenant-a', 'asset-a');
    const operationId = await oobApi.db.createOperation('tenant-a', 'asset-a', {
      name: OobOperationName.RestartServices,
    });

    expect(await getEdgeOperations(token, 'boot-a')).to.deep.equal([
      {
        id: operationId,
        name: OobOperationName.RestartServices,
      },
    ]);

    await updateEdgeOperation(token, operationId, { status: OobOperationStatusCode.Pending });
    expect(
      await oobApi.db.getOperations('tenant-a', { id: operationId }).then((res) => res[0]),
    ).to.deep.include({
      status: OobOperationStatusCode.Pending,
      tries: 1,
    });
    await updateEdgeOperation(token, operationId, { status: OobOperationStatusCode.Success });
    expect(
      await oobApi.db.getOperations('tenant-a', { id: operationId }).then((res) => res[0]),
    ).to.deep.include({
      status: OobOperationStatusCode.Success,
      tries: 1,
    });

    expect(await getEdgeOperations(token, 'boot-a')).to.deep.equal([]);
  });

  it('Restart services success (with services list)', async () => {
    const token = await oobApi.db.createAsset('tenant-a', 'asset-a');
    const operationId = await oobApi.db.createOperation('tenant-a', 'asset-a', {
      name: OobOperationName.RestartServices,
      parameters: { services: ['RemoteAccess'] },
    });

    expect(await getEdgeOperations(token, 'boot-a')).to.deep.equal([
      {
        id: operationId,
        name: OobOperationName.RestartServices,
        parameters: { services: ['RemoteAccess'] },
      },
    ]);

    await updateEdgeOperation(token, operationId, { status: OobOperationStatusCode.Pending });
    expect(
      await oobApi.db.getOperations('tenant-a', { id: operationId }).then((res) => res[0]),
    ).to.deep.include({
      status: OobOperationStatusCode.Pending,
      tries: 1,
    });
    await updateEdgeOperation(token, operationId, { status: OobOperationStatusCode.Success });
    expect(
      await oobApi.db.getOperations('tenant-a', { id: operationId }).then((res) => res[0]),
    ).to.deep.include({
      status: OobOperationStatusCode.Success,
      tries: 1,
    });

    expect(await getEdgeOperations(token, 'boot-a')).to.deep.equal([]);
  });

  it('Send files success', async () => {
    const token = await oobApi.db.createAsset('tenant-a', 'asset-a');
    const operationId = await oobApi.db.createOperation('tenant-a', 'asset-a', {
      name: OobOperationName.SendFiles,
      parameters: { paths: ['/var/lib/datav'], knownPaths: [SendFilesKnownPath.SystemConfig] },
    });

    expect(await getEdgeOperations(token, 'boot-a')).to.deep.equal([
      {
        id: operationId,
        name: OobOperationName.SendFiles,
        parameters: {
          paths: ['/var/lib/datav'],
          knownPaths: [SendFilesKnownPath.SystemConfig],
          method: 'PUT',
          destination: `https://s3/tenant-a/${operationId}`,
        },
      },
    ]);

    await updateEdgeOperation(token, operationId, { status: OobOperationStatusCode.Pending });
    await updateEdgeOperation(token, operationId, { status: OobOperationStatusCode.Pending });
    expect(
      await oobApi.db.getOperations('tenant-a', { id: operationId }).then((res) => res[0]),
    ).to.deep.include({
      status: OobOperationStatusCode.Pending,
      tries: 1,
    });
    await updateEdgeOperation(token, operationId, {
      status: OobOperationStatusCode.InProgress,
      progress: { position: 0, size: 2 },
    });
    expect(
      await oobApi.db.getOperations('tenant-a', { id: operationId }).then((res) => res[0]),
    ).to.deep.include({
      status: OobOperationStatusCode.InProgress,
      progress: { position: 0, size: 2 },
    });
    await updateEdgeOperation(token, operationId, {
      status: OobOperationStatusCode.InProgress,
      progress: { position: 1, size: 2 },
    });
    await updateEdgeOperation(token, operationId, {
      status: OobOperationStatusCode.Success,
      progress: { position: 2, size: 2 },
    });
    expect(
      await oobApi.db.getOperations('tenant-a', { id: operationId }).then((res) => res[0]),
    ).to.deep.include({
      status: OobOperationStatusCode.Success,
      progress: { position: 2, size: 2 },
    });

    expect(await getEdgeOperations(token, 'boot-a')).to.deep.equal([]);
  });

  it('Multiple operations in order', async () => {
    const token = await oobApi.db.createAsset('tenant-a', 'asset-a');
    const operationIdA = await oobApi.db.createOperation('tenant-a', 'asset-a', {
      name: OobOperationName.RestartServices,
    });
    const operationIdB = await oobApi.db.createOperation('tenant-a', 'asset-a', {
      name: OobOperationName.RestartServices,
    });
    expect(await getEdgeOperations(token, 'boot-a')).to.deep.equal([
      {
        id: operationIdA,
        name: OobOperationName.RestartServices,
      },
      {
        id: operationIdB,
        name: OobOperationName.RestartServices,
      },
    ]);

    await updateEdgeOperation(token, operationIdA, { status: OobOperationStatusCode.Pending });
    await updateEdgeOperation(token, operationIdA, { status: OobOperationStatusCode.Success });

    expect(await getEdgeOperations(token, 'boot-a')).to.deep.equal([
      {
        id: operationIdB,
        name: OobOperationName.RestartServices,
      },
    ]);

    await updateEdgeOperation(token, operationIdB, { status: OobOperationStatusCode.Pending });
    await updateEdgeOperation(token, operationIdB, { status: OobOperationStatusCode.Success });

    expect(await getEdgeOperations(token, 'boot-a')).to.deep.equal([]);
  });

  it('Generic operation failure with additional details', async () => {
    const token = await oobApi.db.createAsset('tenant-a', 'asset-a');
    const operationId = await oobApi.db.createOperation('tenant-a', 'asset-a', {
      name: OobOperationName.RestartServices,
    });

    expect(await getEdgeOperations(token, 'boot-a')).to.deep.equal([
      {
        id: operationId,
        name: OobOperationName.RestartServices,
      },
    ]);

    await updateEdgeOperation(token, operationId, { status: OobOperationStatusCode.Pending });
    await updateEdgeOperation(token, operationId, {
      status: OobOperationStatusCode.Failed,
      additionalDetails: 'Service failed to restart',
    });

    expect(await getEdgeOperations(token, 'boot-a')).to.deep.equal([]);
    expect(
      await oobApi.db.getOperations('tenant-a', { id: operationId }).then((res) => res[0]),
    ).to.deep.include({
      status: OobOperationStatusCode.Failed,
      additionalDetails: 'Service failed to restart',
    });
  });

  it('Operation fails after multiple attempts', async () => {
    const token = await oobApi.db.createAsset('tenant-a', 'asset-a');
    const operationId = await oobApi.db.createOperation('tenant-a', 'asset-a', {
      name: OobOperationName.RestartServices,
    });

    expect(await getEdgeOperations(token, 'boot-a')).to.deep.equal([
      {
        id: operationId,
        name: OobOperationName.RestartServices,
      },
    ]);

    for (let i = 0; i < MAX_OPERATION_TRIES; i++) {
      expect(await getEdgeOperations(token, `boot-${i}`)).to.deep.equal([
        {
          id: operationId,
          name: OobOperationName.RestartServices,
          ...(i > 0 ? { status: OobOperationStatusCode.Pending } : {}),
        },
      ]);
      await updateEdgeOperation(token, operationId, { status: OobOperationStatusCode.Pending });
    }

    expect(await getEdgeOperations(token, 'boot-b')).to.deep.equal([]);

    expect(
      await oobApi.db.getOperations('tenant-a', { id: operationId }).then((res) => res[0]),
    ).to.deep.include({
      status: OobOperationStatusCode.Failed,
      additionalDetails: `Device failed to complete operation after ${MAX_OPERATION_TRIES} tries`,
    });
  });
});
