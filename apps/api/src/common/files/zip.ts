import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

/**
 * ZIP read and write on Node's zlib (ADR 056: no dependency). Reading goes
 * through the central directory, supports stored and deflated entries, and
 * refuses archives over the caller's entry and size limits before inflating
 * anything (ZIP bombs). Writing makes plain deflated archives (the XLSX
 * template). No ZIP64, no encryption: those are refused, not guessed.
 */

export class ZipFormatError extends Error {}
export class ZipLimitError extends Error {}

export interface ZipLimits {
  maxEntries: number;
  maxUnpackedBytes: number;
}

export interface ZipEntry {
  name: string;
  /** Uncompressed size as the archive declares it (checked again after inflating). */
  size: number;
  read(): Buffer;
}

// settings-exempt: ZIP file-format constants (APPNOTE.TXT), not business numbers
const EOCD_SIGNATURE = 0x06054b50;
// settings-exempt: see above
const CENTRAL_SIGNATURE = 0x02014b50;
// settings-exempt: see above
const LOCAL_SIGNATURE = 0x04034b50;
// settings-exempt: see above
const EOCD_MIN = 22;
// settings-exempt: see above (the comment after the EOCD is at most 65535 bytes)
const EOCD_SEARCH = EOCD_MIN + 0xffff;
// settings-exempt: see above
const CENTRAL_HEADER = 46;
// settings-exempt: see above
const LOCAL_HEADER = 30;
// settings-exempt: see above
const METHOD_STORED = 0;
// settings-exempt: see above
const METHOD_DEFLATE = 8;
// settings-exempt: see above (general-purpose flag bit 0)
const FLAG_ENCRYPTED = 1;
// settings-exempt: see above (general-purpose flag bit 11: names are UTF-8)
const FLAG_UTF8 = 0x800;
// settings-exempt: see above
const VERSION = 20;
// settings-exempt: see above (ZIP64 marks sizes and offsets with all ones)
const ZIP64_MARK = 0xffffffff;

export function readZip(buffer: Buffer, limits: ZipLimits): ZipEntry[] {
  const searchFrom = Math.max(0, buffer.length - EOCD_SEARCH);
  let eocd = -1;
  for (let i = buffer.length - EOCD_MIN; i >= searchFrom; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipFormatError('not a ZIP archive');
  const count = buffer.readUInt16LE(eocd + 10);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (centralOffset === ZIP64_MARK) throw new ZipFormatError('ZIP64 archives are not supported');
  if (count > limits.maxEntries) throw new ZipLimitError(`more than ${limits.maxEntries} files`);

  const entries: ZipEntry[] = [];
  let total = 0;
  let at = centralOffset;
  for (let n = 0; n < count; n++) {
    if (at + CENTRAL_HEADER > buffer.length || buffer.readUInt32LE(at) !== CENTRAL_SIGNATURE) {
      throw new ZipFormatError('damaged central directory');
    }
    const flags = buffer.readUInt16LE(at + 8);
    const method = buffer.readUInt16LE(at + 10);
    const compressedSize = buffer.readUInt32LE(at + 20);
    const size = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const localOffset = buffer.readUInt32LE(at + 42);
    const rawName = buffer.subarray(at + CENTRAL_HEADER, at + CENTRAL_HEADER + nameLength);
    const name = rawName.toString(flags & FLAG_UTF8 ? 'utf8' : 'latin1');
    at += CENTRAL_HEADER + nameLength + extraLength + commentLength;

    if (name.endsWith('/')) continue; // a directory
    if (flags & FLAG_ENCRYPTED)
      throw new ZipFormatError(`${name}: encrypted entries are not supported`);
    if (size === ZIP64_MARK || compressedSize === ZIP64_MARK) {
      throw new ZipFormatError('ZIP64 archives are not supported');
    }
    if (method !== METHOD_STORED && method !== METHOD_DEFLATE) {
      throw new ZipFormatError(`${name}: compression method ${method} is not supported`);
    }
    total += size;
    if (total > limits.maxUnpackedBytes)
      throw new ZipLimitError(`unpacks to more than ${limits.maxUnpackedBytes} bytes`);

    entries.push({
      name,
      size,
      read: () => {
        if (buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE)
          throw new ZipFormatError(`${name}: damaged entry`);
        const start =
          localOffset +
          LOCAL_HEADER +
          buffer.readUInt16LE(localOffset + 26) +
          buffer.readUInt16LE(localOffset + 28);
        const raw = buffer.subarray(start, start + compressedSize);
        const data =
          method === METHOD_STORED
            ? Buffer.from(raw)
            : inflateRawSync(raw, { maxOutputLength: size + 1 });
        if (data.length !== size)
          throw new ZipFormatError(`${name}: size does not match the directory`);
        return data;
      },
    });
  }
  return entries;
}

/** A deflated archive of these files, names UTF-8. */
export function writeZip(files: readonly { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const compressed = deflateRawSync(file.data);
    const crc = crc32(file.data);
    const local = Buffer.alloc(LOCAL_HEADER);
    local.writeUInt32LE(LOCAL_SIGNATURE, 0);
    local.writeUInt16LE(VERSION, 4);
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(METHOD_DEFLATE, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, compressed);

    const central = Buffer.alloc(CENTRAL_HEADER);
    central.writeUInt32LE(CENTRAL_SIGNATURE, 0);
    central.writeUInt16LE(VERSION, 4);
    central.writeUInt16LE(VERSION, 6);
    central.writeUInt16LE(FLAG_UTF8, 8);
    central.writeUInt16LE(METHOD_DEFLATE, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += LOCAL_HEADER + name.length + compressed.length;
  }
  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(EOCD_MIN);
  eocd.writeUInt32LE(EOCD_SIGNATURE, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, eocd]);
}
