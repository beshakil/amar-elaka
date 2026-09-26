import { inBatches } from './job-batches';

describe('inBatches', () => {
  it('stops at the first short batch: nothing left', async () => {
    const sizes = [3, 3, 1, 3];
    const batch = jest.fn((limit: number) => Promise.resolve(Math.min(limit, sizes.shift()!)));
    await expect(inBatches({ batchSize: 3, maxBatches: 10 }, batch)).resolves.toEqual({
      rows: 7,
      capped: false,
    });
    expect(batch).toHaveBeenCalledTimes(3);
  });

  it('stops at the cap with work left, and says so', async () => {
    const batch = jest.fn((limit: number) => Promise.resolve(limit));
    await expect(inBatches({ batchSize: 5, maxBatches: 2 }, batch)).resolves.toEqual({
      rows: 10,
      capped: true,
    });
    expect(batch).toHaveBeenCalledTimes(2);
  });

  it('passes the batch size as the limit, and an empty first batch ends the run', async () => {
    const batch = jest.fn(() => Promise.resolve(0));
    await expect(inBatches({ batchSize: 50, maxBatches: 9 }, batch)).resolves.toEqual({
      rows: 0,
      capped: false,
    });
    expect(batch).toHaveBeenCalledWith(50);
  });

  it('lets a failing batch fail the run (the runner records it)', async () => {
    const batch = jest.fn().mockResolvedValueOnce(2).mockRejectedValueOnce(new Error('boom'));
    await expect(inBatches({ batchSize: 2, maxBatches: 5 }, batch)).rejects.toThrow('boom');
  });
});
