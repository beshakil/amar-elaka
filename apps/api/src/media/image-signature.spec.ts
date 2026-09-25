import sharp from 'sharp';
import { sniffImageType, sniffMediaType } from './image-signature';

const blank = (format: 'jpeg' | 'png' | 'webp' | 'gif') =>
  sharp({ create: { width: 4, height: 4, channels: 3, background: '#000' } })
    .toFormat(format)
    .toBuffer();

describe('magic-byte sniffing', () => {
  it('recognises real JPEG, PNG and WebP files by content', async () => {
    expect(sniffImageType(await blank('jpeg'))).toBe('image/jpeg');
    expect(sniffImageType(await blank('png'))).toBe('image/png');
    expect(sniffImageType(await blank('webp'))).toBe('image/webp');
  });

  it('rejects what only claims to be an image', async () => {
    expect(sniffImageType(Buffer.from('<html><script>alert(1)</script>'))).toBeUndefined();
    expect(sniffImageType(Buffer.from('%PDF-1.7'))).toBeUndefined();
    expect(sniffImageType(await blank('gif'))).toBeUndefined(); // valid image, unsupported format
    expect(sniffImageType(Buffer.from([0xff, 0xd8]))).toBeUndefined(); // truncated
    expect(sniffImageType(Buffer.from('RIFF\0\0\0\0WAVE'))).toBeUndefined(); // RIFF, not WebP
  });

  it('checks documents and videos against their own formats', async () => {
    expect(sniffMediaType('document', Buffer.from('%PDF-1.7\n'))).toBe('application/pdf');
    expect(sniffMediaType('document', await blank('png'))).toBe('image/png');
    expect(sniffMediaType('document', await blank('webp'))).toBeUndefined();
    expect(sniffMediaType('video', Buffer.from('\0\0\0\x18ftypmp42'))).toBe('video/mp4');
    expect(sniffMediaType('video', Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01]))).toBe('video/webm');
    expect(sniffMediaType('video', await blank('jpeg'))).toBeUndefined();
    expect(sniffMediaType('image', Buffer.from('%PDF-1.7'))).toBeUndefined();
  });
});
