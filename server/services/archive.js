import { createReadStream, createWriteStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';

/**
 * A tar writer, because nothing else here needs one.
 *
 * The runtime image is node:22-bookworm-slim: no zip, and betting on the `tar`
 * binary being on the PATH of a slim image is the kind of assumption that holds
 * until the base image changes and the backup quietly stops running. ustar is a
 * fixed 512-byte header and 512-byte-padded bodies, which is about forty lines
 * and is verified against real tar in the test suite.
 */

const BLOCK = 512;

const padding = (size) => {
  const over = size % BLOCK;
  return over === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - over);
};

const pad = (text, length) => {
  const buffer = Buffer.alloc(length);
  buffer.write(text, 0, 'utf8');
  return buffer;
};

/** Octal, NUL-terminated, right-aligned with leading zeros -- the ustar way. */
const octal = (value, length) => pad(value.toString(8).padStart(length - 1, '0'), length);

function headerBlock({ name, prefix = '', size, mode = 0o644, mtime, type = '0' }) {
  const block = Buffer.alloc(BLOCK);
  pad(name, 100).copy(block, 0);
  octal(mode, 8).copy(block, 100);
  octal(0, 8).copy(block, 108); // uid
  octal(0, 8).copy(block, 116); // gid
  octal(size, 12).copy(block, 124);
  octal(Math.floor(mtime / 1000), 12).copy(block, 136);
  block.write('        ', 148, 8, 'binary'); // the checksum counts as spaces
  block.write(type, 156, 1, 'binary');
  block.write('ustar\0', 257, 6, 'binary');
  block.write('00', 263, 2, 'binary');
  pad(prefix, 155).copy(block, 345);

  let sum = 0;
  for (const byte of block) sum += byte;
  // Six octal digits, a NUL, then a space. Not the seven-digits-plus-NUL shape
  // the other numeric fields use -- getting this wrong makes every archive
  // unreadable by real tar, which is the sort of thing a backup only finds out
  // about on the day it is needed.
  block.write(sum.toString(8).padStart(6, '0'), 148, 6, 'binary');
  block.write('\0 ', 154, 2, 'binary');
  return block;
}

/**
 * ustar splits a path across a 155-byte prefix and a 100-byte name, which tops
 * out at 256 characters. Rather than fail the whole backup over one long file
 * name, anything that will not fit gets GNU's long-name record: a header with
 * type 'L' whose body is the real path, which both GNU tar and bsdtar read.
 */
function fileHeaders(name, meta) {
  if (Buffer.byteLength(name) <= 100) return [headerBlock({ ...meta, name })];

  for (let at = name.lastIndexOf('/'); at > 0; at = name.lastIndexOf('/', at - 1)) {
    const head = name.slice(0, at);
    const tail = name.slice(at + 1);
    if (Buffer.byteLength(tail) <= 100 && Buffer.byteLength(head) <= 155) {
      return [headerBlock({ ...meta, name: tail, prefix: head })];
    }
  }

  const path = Buffer.from(name, 'utf8');
  return [
    headerBlock({
      name: '././@LongLink',
      size: path.length + 1,
      mode: 0o644,
      mtime: meta.mtime,
      type: 'L',
    }),
    Buffer.concat([path, Buffer.alloc(1)]),
    padding(path.length + 1),
    headerBlock({ ...meta, name: name.slice(0, 100) }),
  ];
}

/** Every regular file under `dir`, depth first, as paths relative to it. */
async function walk(dir, base = dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return out;
    throw err;
  }
  // Sorted, so two runs over unchanged data produce byte-identical archives and
  // a diff between two backups means something really changed.
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full, base)));
    else if (entry.isFile()) out.push(relative(base, full).split(sep).join('/'));
  }
  return out;
}

/**
 * Packs files into a gzipped tar at `destination`.
 * `entries` are { path, name } -- where it is now, and where it goes in the tar.
 */
export async function writeArchive(destination, entries) {
  const gzip = createGzip({ level: 6 });
  const out = createWriteStream(destination);
  const done = pipeline(gzip, out);

  for (const entry of entries) {
    const info = await stat(entry.path);
    for (const block of fileHeaders(entry.name, { size: info.size, mtime: info.mtimeMs })) {
      gzip.write(block);
    }
    // Streamed rather than read into memory: a chapter archive is much larger
    // than anything worth holding in a buffer.
    for await (const chunk of createReadStream(entry.path)) gzip.write(chunk);
    gzip.write(padding(info.size));
  }

  // Two empty blocks mark the end of a tar.
  gzip.write(Buffer.alloc(BLOCK * 2));
  gzip.end();
  await done;

  return (await stat(destination)).size;
}

export { walk, fileHeaders };
