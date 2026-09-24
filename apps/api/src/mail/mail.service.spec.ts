import type { Queue } from 'bullmq';
import { MailService } from './mail.service';
import { JOB_SEND_EMAIL, type SendEmailJob } from '../queue/queue.types';

describe('MailService', () => {
  function buildService(): { service: MailService; addSpy: jest.Mock } {
    const addSpy = jest.fn().mockResolvedValue(undefined);
    const queue = { add: addSpy } as unknown as Queue<SendEmailJob>;
    return { service: new MailService(queue), addSpy };
  }

  it('only enqueues a job — never sends anything itself', async () => {
    const { service, addSpy } = buildService();

    await service.send('user@example.com', 'notice', { heading: 'শিরোনাম', body: 'বার্তা' });

    expect(addSpy).toHaveBeenCalledTimes(1);
    expect(addSpy).toHaveBeenCalledWith(JOB_SEND_EMAIL, {
      to: 'user@example.com',
      template: 'notice',
      params: { heading: 'শিরোনাম', body: 'বার্তা' },
    });
  });
});
