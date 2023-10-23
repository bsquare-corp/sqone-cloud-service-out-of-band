import { exchangeSystemToken } from '@bsquare/companion-service-common';
import { expect } from 'chai';
import { describe, it } from 'mocha';
import Fetch from 'node-fetch';
import { OOB_API_URI } from '../integration-wrapper';

const regToken = 'reg@test-token';

describe('Router tests', () => {
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
});
