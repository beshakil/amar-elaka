import { Logger } from '@nestjs/common';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  PrivateBucketException,
  UploadDoesNotMatchGrantException,
  UploadGrantRejectedException,
} from '../storage.exceptions';
import { localStorageRoutes } from './local-storage.routes';
import { LocalStorageService } from './local-storage.service';

const API = 'http://api.test';

describe('LocalStorageService (STORAGE_DRIVER=local)', () => {
  let root: string;
  let storage: LocalStorageService;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ae-local-storage-'));
    storage = new LocalStorageService({
      STORAGE_LOCAL_PATH: root,
      STORAGE_PUBLIC_URL: `${API}/media/`,
      API_PUBLIC_URL: API,
      JWT_SECRET: 'unit-test-secret-0123456789',
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('writes, heads, reads (whole and by range) and deletes, keeping the content type', async () => {
    await storage.putObject('media', 't/image/a.webp', Buffer.from('hello world'), 'image/webp');
    expect(await storage.head('media', 't/image/a.webp')).toEqual({
      byteSize: 11,
      contentType: 'image/webp',
    });
    expect((await storage.getObject('media', 't/image/a.webp')).toString()).toBe('hello world');
    expect(
      (await storage.getObject('media', 't/image/a.webp', { start: 0, end: 4 })).toString(),
    ).toBe('hello');

    await storage.deleteMany('media', ['t/image/a.webp', 't/image/missing']);
    expect(await storage.head('media', 't/image/a.webp')).toBeUndefined();
  });

  it('keeps the two buckets apart on disk', async () => {
    await storage.putObject('documents', 't/doc/x', Buffer.from('secret'), 'application/pdf');
    expect(await storage.head('media', 't/doc/x')).toBeUndefined();
    expect(await readdir(root)).toEqual(['documents']);
  });

  it('refuses keys that could escape the storage root', async () => {
    for (const key of ['../etc/passwd', '/abs', 't/../../x', 't//x', 'x.meta.json']) {
      await expect(storage.putObject('media', key, Buffer.from('x'), 'text/plain')).rejects.toThrow(
        UploadGrantRejectedException,
      );
    }
  });

  it('builds public URLs for media only', () => {
    expect(storage.getPublicUrl('media', 't/image/a.webp')).toBe(`${API}/media/t/image/a.webp`);
    expect(() => storage.getPublicUrl('documents', 't/doc/x')).toThrow(PrivateBucketException);
  });

  describe('presigned uploads', () => {
    const bytes = Buffer.from('fake-jpeg-bytes');
    const tokenOf = (url: string) => url.split('/').pop()!;

    it('issues an upload URL on the API and accepts exactly the granted upload', async () => {
      const upload = await storage.presignUpload('media', 't/image/u1', 'image/jpeg', bytes.length);
      expect(upload.url.startsWith(`${API}/api/v1/storage/uploads/`)).toBe(true);
      expect(upload.headers).toEqual({
        'Content-Type': 'image/jpeg',
        'Content-Length': String(bytes.length),
      });

      await storage.acceptUpload(
        tokenOf(upload.url),
        'image/jpeg',
        String(bytes.length),
        Readable.from([bytes]),
      );
      expect(await storage.head('media', 't/image/u1')).toEqual({
        byteSize: bytes.length,
        contentType: 'image/jpeg',
      });
    });

    it('rejects a different content type or declared size, and a body longer than granted', async () => {
      const upload = await storage.presignUpload('media', 't/image/u2', 'image/jpeg', bytes.length);
      const token = tokenOf(upload.url);
      await expect(
        storage.acceptUpload(token, 'image/png', String(bytes.length), Readable.from([bytes])),
      ).rejects.toThrow(UploadDoesNotMatchGrantException);
      await expect(
        storage.acceptUpload(token, 'image/jpeg', '1', Readable.from([bytes])),
      ).rejects.toThrow(UploadDoesNotMatchGrantException);
      await expect(
        storage.acceptUpload(
          token,
          'image/jpeg',
          String(bytes.length),
          Readable.from([bytes, Buffer.from('extra')]),
        ),
      ).rejects.toThrow(UploadDoesNotMatchGrantException);
      // Nothing half-written is left behind.
      expect(await storage.head('media', 't/image/u2')).toBeUndefined();
    });

    it('rejects a forged token', async () => {
      await expect(
        storage.acceptUpload('forged.token', 'image/jpeg', '1', Readable.from([bytes])),
      ).rejects.toThrow(UploadGrantRejectedException);
    });
  });

  describe('HTTP routes', () => {
    let app: FastifyInstance;

    beforeEach(async () => {
      app = Fastify();
      await app.register(localStorageRoutes(storage, new Logger('test')));
      await app.ready();
    });

    afterEach(async () => {
      await app.close();
    });

    it('answers the CORS preflight and accepts the PUT a browser sends', async () => {
      const bytes = Buffer.from('png-bytes');
      const upload = await storage.presignUpload('media', 't/image/h1', 'image/png', bytes.length);
      const path = new URL(upload.url).pathname;

      const preflight = await app.inject({
        method: 'OPTIONS',
        url: path,
        headers: { origin: 'https://savar.amarelaka.com' },
      });
      expect(preflight.statusCode).toBe(204);
      expect(preflight.headers['access-control-allow-origin']).toBe('*');

      const put = await app.inject({
        method: 'PUT',
        url: path,
        headers: upload.headers,
        payload: bytes,
      });
      expect(put.statusCode).toBe(200);
      expect(put.headers['access-control-allow-origin']).toBe('*');
    });

    it('answers a bad upload with the API error shape', async () => {
      const put = await app.inject({
        method: 'PUT',
        url: '/api/v1/storage/uploads/forged.token',
        headers: { 'content-type': 'image/png' },
        payload: Buffer.from('x'),
      });
      expect(put.statusCode).toBe(403);
      expect(put.json()).toMatchObject({ error: 'UPLOAD_GRANT_REJECTED' });
    });

    it('serves public media with its content type and cache policy, never documents', async () => {
      await storage.putObject(
        'media',
        't/image/v.thumb.webp',
        Buffer.from('webp'),
        'image/webp',
        'public, max-age=31536000, immutable',
      );
      await storage.putObject('documents', 't/document/nid', Buffer.from('nid'), 'application/pdf');

      const media = await app.inject({ method: 'GET', url: '/media/t/image/v.thumb.webp' });
      expect(media.statusCode).toBe(200);
      expect(media.body).toBe('webp');
      expect(media.headers['content-type']).toBe('image/webp');
      expect(media.headers['cache-control']).toBe('public, max-age=31536000, immutable');

      expect((await app.inject({ method: 'GET', url: '/media/t/document/nid' })).statusCode).toBe(
        404,
      );
      expect(
        (await app.inject({ method: 'GET', url: '/media/../documents/t/document/nid' })).statusCode,
      ).toBe(404);
      expect(
        (await app.inject({ method: 'GET', url: '/media/t/image/v.thumb.webp.meta.json' }))
          .statusCode,
      ).toBe(404);
    });
  });
});
