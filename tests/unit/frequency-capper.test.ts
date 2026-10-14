import { loadPolicy } from '../../src/config/policy';
import {
  InMemoryFrequencyCapper,
  type CapRequest,
} from '../../src/compliance/frequency-cap/frequency-capper';
import { capperContract } from '../helpers/capper-contract';

const policy = loadPolicy();

describe('InMemoryFrequencyCapper (reference model)', () => {
  capperContract(() => new InMemoryFrequencyCapper(policy.frequencyCaps));

  it('ignores channels that are never counted (in-app)', async () => {
    const capper = new InMemoryFrequencyCapper(policy.frequencyCaps);
    const req: CapRequest = {
      userId: 'u',
      eventRef: 'e',
      category: 'SIP',
      cooldownSubject: 'x',
      channels: ['inapp'],
      exempt: false,
      now: new Date(),
    };
    for (let i = 0; i < 50; i++)
      expect(
        (await capper.checkAndConsume({ ...req, eventRef: `e${i}`, cooldownSubject: `s${i}` }))
          .allowedChannels,
      ).toEqual(['inapp']);
  });
});
