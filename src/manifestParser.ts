// Epic binary/JSON manifest parser. Resolves the second half of docs/api-surface.md §3.4:
// given a signed manifest URL, returns the chunk database + per-file chunk-part list needed
// to reconstruct real on-disk files.
//
// Format references cross-checked from:
//   - Legendary `legendary/models/manifest.py` + `json_manifest.py` (canonical)
//   - VastBlast/EpicManifestDownloader `lib/index.js` (JSON-only, less complete)
//   - Legendary `legendary/models/chunk.py` (chunk-file header layout)
//
// The brief's format summary had two field-layout mistakes vs Legendary; the layout below
// follows Legendary verbatim. See parseBinaryManifest() for the corrected u32-only header
// and the stored_as-then-version order (brief said version was u8 and came before stored_as).

import { inflateSync } from "node:zlib";

const MANIFEST_MAGIC = 0x44bec00c;

const STORED_AS_COMPRESSED = 0x1;
const STORED_AS_ENCRYPTED = 0x2;

export interface BinaryManifest {
  version: number;
  buildVersion: string;
  appName: string;
  chunkDataList: ChunkInfo[];
  fileManifestList: FileEntry[];
}

export interface ChunkInfo {
  guid: string;
  hash: string;
  shaHash: string;
  groupNumber: number;
  windowSize: number;
  fileSize: number;
}

export interface FileEntry {
  filename: string;
  fileSize: number;
  fileHash: string;
  chunkParts: ChunkPart[];
}

export interface ChunkPart {
  guid: string;
  offset: number;
  size: number;
}

class Reader {
  private offset = 0;
  constructor(private readonly view: DataView) {}

  get pos(): number {
    return this.offset;
  }

  seek(absolute: number): void {
    this.offset = absolute;
  }

  skip(bytes: number): void {
    this.offset += bytes;
  }

  remaining(): number {
    return this.view.byteLength - this.offset;
  }

  u8(): number {
    const v = this.view.getUint8(this.offset);
    this.offset += 1;
    return v;
  }

  u32(): number {
    const v = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return v;
  }

  i32(): number {
    const v = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return v;
  }

  u64(): bigint {
    const v = this.view.getBigUint64(this.offset, true);
    this.offset += 8;
    return v;
  }

  i64(): bigint {
    const v = this.view.getBigInt64(this.offset, true);
    this.offset += 8;
    return v;
  }

  bytes(length: number): Uint8Array {
    const out = new Uint8Array(this.view.buffer, this.view.byteOffset + this.offset, length).slice();
    this.offset += length;
    return out;
  }

  // Epic's FString: int32 length prefix. Positive = ASCII (length includes null terminator);
  // negative = UTF-16LE (abs(length) is char count, includes null terminator). See
  // legendary/models/manifest.py read_fstring().
  fstring(): string {
    const length = this.i32();
    if (length === 0) return "";
    if (length > 0) {
      const data = this.bytes(length - 1);
      this.skip(1); // null terminator
      // ASCII is a strict subset of UTF-8 for codepoints 0–127, which Epic FStrings honor.
      return new TextDecoder("utf-8").decode(data);
    }
    const charCount = -length;
    const data = this.bytes((charCount - 1) * 2);
    this.skip(2); // 2-byte null terminator
    // "utf-16le" isn't in the lib type's accepted encoding union, but the runtime accepts it;
    // use a constructed encoding label that TextDecoder honors at runtime.
    return decodeUtf16Le(data);
  }
}

// Manual UTF-16LE decode to avoid the TextDecoder encoding-name type narrowing in
// @types/bun's lib.dom shim. FString UTF-16 is always BMP for asset paths in practice.
function decodeUtf16Le(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    out += String.fromCharCode((bytes[i] ?? 0) | ((bytes[i + 1] ?? 0) << 8));
  }
  return out;
}

function guidToString(parts: [number, number, number, number]): string {
  // Canonical Fab/Epic GUID rendering for chunk filenames: uppercase 32-char hex, no separators.
  // chunk.py guid_str uses lowercase-with-dashes; chunk PATH uses uppercase-no-dashes.
  // Internally we standardize on uppercase-no-dashes everywhere so map lookups are unambiguous.
  return parts.map((p) => p.toString(16).toUpperCase().padStart(8, "0")).join("");
}

function readGuidLE(reader: Reader): string {
  const a = reader.u32();
  const b = reader.u32();
  const c = reader.u32();
  const d = reader.u32();
  return guidToString([a, b, c, d]);
}

function bytesToHex(bytes: Uint8Array, upper = false): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return upper ? out.toUpperCase() : out;
}

function u64ToHexUpper(value: bigint): string {
  return value.toString(16).toUpperCase().padStart(16, "0");
}

// JSON manifests encode integers as concatenated %03d little-endian byte triplets — e.g.
// "012000000000" decodes to 12. See legendary/models/json_manifest.py blob_to_num().
function blobToBigInt(blob: string): bigint {
  let result = 0n;
  let shift = 0n;
  for (let i = 0; i < blob.length; i += 3) {
    const byte = BigInt(parseInt(blob.slice(i, i + 3), 10));
    result += byte << shift;
    shift += 8n;
  }
  return result;
}

function blobToNumber(blob: string): number {
  // Used for fields that fit in a Number (offsets, sizes, group numbers). Caller asserts range.
  return Number(blobToBigInt(blob));
}

// JSON GUIDs are 32-char hex parsed BIG-endian (`>IIII` in legendary/json_manifest.py) —
// opposite of the binary format's little-endian parse. The chunk-filename rendering uses the
// same 4-tuple in both cases.
function guidFromJsonHex(hex: string): string {
  const parts: [number, number, number, number] = [
    parseInt(hex.slice(0, 8), 16),
    parseInt(hex.slice(8, 16), 16),
    parseInt(hex.slice(16, 24), 16),
    parseInt(hex.slice(24, 32), 16),
  ];
  return guidToString(parts);
}

// docs/api-surface.md §3.4 step 2 — body may be JSON or Epic's binary format. zlib-wrap, no wrap,
// and JSON-after-decompress all observed in the wild. parseManifest() dispatches by sniffing
// the magic.
async function fetchManifestBytes(manifestUrl: string): Promise<Uint8Array> {
  const response = await fetch(manifestUrl);
  if (!response.ok) {
    throw new Error(`Manifest fetch failed: HTTP ${response.status} for ${manifestUrl}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

export async function parseManifest(manifestUrl: string): Promise<BinaryManifest> {
  const bytes = await fetchManifestBytes(manifestUrl);
  if (bytes.length < 4) {
    throw new Error("Manifest too short to inspect");
  }

  // Binary manifests start with 0x44BEC00C little-endian. Anything else is treated as JSON
  // (matches Legendary's dispatch — JSON manifests have no magic header).
  const head = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
  if (head === MANIFEST_MAGIC) {
    return parseBinaryManifest(bytes);
  }
  return parseJsonManifest(bytes);
}

function parseBinaryManifest(bytes: Uint8Array): BinaryManifest {
  const reader = new Reader(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));

  // Header layout per legendary/models/manifest.py Manifest.read(). Brief had this wrong:
  // sizes are u32 (not u64), and `stored_as` precedes `version`.
  const magic = reader.u32();
  if (magic !== MANIFEST_MAGIC) {
    throw new Error(`Bad manifest magic: 0x${magic.toString(16)}`);
  }
  const headerSize = reader.u32();
  const sizeUncompressed = reader.u32();
  const sizeCompressed = reader.u32();
  const shaHashHeader = reader.bytes(20);
  const storedAs = reader.u8();
  const version = reader.u32();

  if ((storedAs & STORED_AS_ENCRYPTED) !== 0) {
    // Encrypted manifests need per-GUID AES-GCM secrets out of band. Fab assets aren't
    // currently observed to ship encrypted, so refuse rather than silently emit junk.
    throw new Error("Encrypted manifests are not supported");
  }

  if (version >= 22) {
    // secret_guid (16 bytes) + encryption_tag (16 bytes) precede the body.
    reader.skip(32);
  }

  // Header may carry trailing fields for future versions; jump to the declared body offset.
  if (reader.pos !== headerSize) {
    reader.seek(headerSize);
  }

  const compressedBody = reader.bytes(reader.remaining());
  const compressed = (storedAs & STORED_AS_COMPRESSED) !== 0;
  const body = compressed ? inflateSync(compressedBody) : compressedBody;

  if (compressed) {
    const got = Bun.SHA1.hash(body, "hex");
    const want = bytesToHex(shaHashHeader);
    if (got !== want) {
      throw new Error(`Manifest body SHA1 mismatch: got ${got}, want ${want}`);
    }
  }

  void sizeUncompressed;
  void sizeCompressed;

  return readManifestBody(new Uint8Array(body), version);
}

function readManifestBody(body: Uint8Array, manifestVersion: number): BinaryManifest {
  const reader = new Reader(new DataView(body.buffer, body.byteOffset, body.byteLength));

  const meta = readManifestMeta(reader);
  const chunkDataList = readChunkDataList(reader, manifestVersion);
  const fileManifestList = readFileManifestList(reader);

  return {
    version: manifestVersion,
    buildVersion: meta.buildVersion,
    appName: meta.appName,
    chunkDataList,
    fileManifestList,
  };
}

interface ManifestMetaView {
  appName: string;
  buildVersion: string;
  featureLevel: number;
  dataVersion: number;
}

function readManifestMeta(reader: Reader): ManifestMetaView {
  const start = reader.pos;
  const size = reader.u32();
  const dataVersion = reader.u8();
  const featureLevel = reader.u32();
  reader.u8(); // is_file_data
  reader.u32(); // app_id
  const appName = reader.fstring();
  const buildVersion = reader.fstring();
  reader.fstring(); // launch_exe
  reader.fstring(); // launch_command

  const prereqCount = reader.u32();
  for (let i = 0; i < prereqCount; i++) reader.fstring();
  reader.fstring(); // prereq_name
  reader.fstring(); // prereq_path
  reader.fstring(); // prereq_args

  if (dataVersion >= 1) reader.fstring(); // build_id
  if (dataVersion >= 2) {
    reader.fstring(); // uninstall_action_path
    reader.fstring(); // uninstall_action_args
  }

  // Forward-compat: skip any trailing meta bytes from versions we don't model yet.
  const consumed = reader.pos - start;
  if (consumed < size) reader.skip(size - consumed);

  return { appName, buildVersion, featureLevel, dataVersion };
}

function readChunkDataList(reader: Reader, manifestVersion: number): ChunkInfo[] {
  const start = reader.pos;
  const size = reader.u32();
  reader.u8(); // version
  const count = reader.u32();

  type ChunkRaw = {
    guid: string;
    guidParts: [number, number, number, number];
    hash: bigint;
    shaHash: Uint8Array;
    groupNumber: number;
    windowSize: number;
    fileSize: number;
  };

  const chunks: ChunkRaw[] = [];

  // Parallel-array layout: every field stored as N values back-to-back, not interleaved.
  // Matches legendary/models/manifest.py CDL.read().
  for (let i = 0; i < count; i++) {
    const a = reader.u32();
    const b = reader.u32();
    const c = reader.u32();
    const d = reader.u32();
    chunks.push({
      guid: guidToString([a, b, c, d]),
      guidParts: [a, b, c, d],
      hash: 0n,
      shaHash: new Uint8Array(),
      groupNumber: 0,
      windowSize: 0,
      fileSize: 0,
    });
  }
  for (const ck of chunks) ck.hash = reader.u64();
  for (const ck of chunks) ck.shaHash = reader.bytes(20);
  for (const ck of chunks) ck.groupNumber = reader.u8();
  for (const ck of chunks) ck.windowSize = reader.u32();
  for (const ck of chunks) ck.fileSize = Number(reader.i64()); // <q in py == signed 64

  if (manifestVersion >= 22) {
    for (const ck of chunks) {
      void ck;
      reader.skip(16); // secret_guid
    }
    for (const ck of chunks) {
      void ck;
      reader.skip(4); // window_size_compressed
    }
    for (const ck of chunks) {
      void ck;
      reader.skip(16); // encryption_tag
    }
  }

  const consumed = reader.pos - start;
  if (consumed < size) reader.skip(size - consumed);

  return chunks.map((ck) => ({
    guid: ck.guid,
    hash: u64ToHexUpper(ck.hash),
    shaHash: bytesToHex(ck.shaHash),
    groupNumber: ck.groupNumber,
    windowSize: ck.windowSize,
    fileSize: ck.fileSize,
  }));
}

function readFileManifestList(reader: Reader): FileEntry[] {
  const start = reader.pos;
  const size = reader.u32();
  const version = reader.u8();
  const count = reader.u32();

  type FileRaw = {
    filename: string;
    symlink: string;
    fileHash: Uint8Array;
    flags: number;
    installTags: string[];
    chunkParts: ChunkPart[];
  };

  const files: FileRaw[] = [];
  for (let i = 0; i < count; i++) {
    files.push({
      filename: "",
      symlink: "",
      fileHash: new Uint8Array(),
      flags: 0,
      installTags: [],
      chunkParts: [],
    });
  }

  for (const f of files) f.filename = reader.fstring();
  for (const f of files) f.symlink = reader.fstring();
  for (const f of files) f.fileHash = reader.bytes(20);
  for (const f of files) f.flags = reader.u8();
  for (const f of files) {
    const tagCount = reader.u32();
    for (let i = 0; i < tagCount; i++) f.installTags.push(reader.fstring());
  }
  for (const f of files) {
    const partCount = reader.u32();
    for (let i = 0; i < partCount; i++) {
      // Each ChunkPart prefixes its own size — Epic uses this to forward-extend the struct.
      // Legendary asserts it's 28 (4 size + 16 guid + 4 offset + 4 size); if longer, skip.
      const partStart = reader.pos;
      const partSize = reader.u32();
      const guid = readGuidLE(reader);
      const offset = reader.u32();
      const partLen = reader.u32();
      f.chunkParts.push({ guid, offset, size: partLen });
      const partConsumed = reader.pos - partStart;
      if (partConsumed < partSize) reader.skip(partSize - partConsumed);
    }
  }

  if (version >= 1) {
    for (const f of files) {
      void f;
      const hasMd5 = reader.u32();
      if (hasMd5 !== 0) reader.skip(16);
    }
    for (const f of files) {
      void f;
      reader.fstring(); // mime_type
    }
  }
  if (version >= 2) {
    for (const f of files) {
      void f;
      reader.skip(32); // hash_sha256
    }
  }

  const consumed = reader.pos - start;
  if (consumed < size) reader.skip(size - consumed);

  return files.map((f) => {
    const fileSize = f.chunkParts.reduce((acc, cp) => acc + cp.size, 0);
    return {
      filename: f.filename,
      fileSize,
      // FileHash on disk is little-endian SHA1 (matches the chunk reassembly hash check).
      // Reverse to canonical big-endian hex so downstream SHA1 comparisons line up.
      fileHash: bytesToHex(reverseBytes(f.fileHash)),
      chunkParts: f.chunkParts,
    };
  });
}

function reverseBytes(input: Uint8Array): Uint8Array {
  const out = new Uint8Array(input.length);
  for (let i = 0; i < input.length; i++) out[i] = input[input.length - 1 - i] ?? 0;
  return out;
}

interface JsonManifestShape {
  ManifestFileVersion?: string;
  AppNameString?: string;
  BuildVersionString?: string;
  ChunkFilesizeList?: Record<string, string>;
  ChunkHashList?: Record<string, string>;
  ChunkShaList?: Record<string, string>;
  DataGroupList?: Record<string, string>;
  FileManifestList?: ReadonlyArray<{
    Filename?: string;
    FileHash?: string;
    FileChunkParts?: ReadonlyArray<{ Guid?: string; Offset?: string; Size?: string }>;
  }>;
}

function parseJsonManifest(bytes: Uint8Array): BinaryManifest {
  const text = new TextDecoder().decode(bytes);
  const data = JSON.parse(text) as JsonManifestShape;

  const version = Number(blobToBigInt(data.ManifestFileVersion ?? "013000000000"));
  const cfl = data.ChunkFilesizeList ?? {};
  const chl = data.ChunkHashList ?? {};
  const csl = data.ChunkShaList ?? {};
  const dgl = data.DataGroupList ?? {};

  const chunkDataList: ChunkInfo[] = Object.keys(cfl).map((guidHex) => {
    const hashBlob = chl[guidHex] ?? "";
    const shaHex = csl[guidHex] ?? "";
    const groupBlob = dgl[guidHex] ?? "";
    return {
      guid: guidFromJsonHex(guidHex),
      hash: u64ToHexUpper(blobToBigInt(hashBlob)),
      shaHash: shaHex,
      groupNumber: blobToNumber(groupBlob),
      windowSize: 1024 * 1024,
      fileSize: blobToNumber(cfl[guidHex] ?? ""),
    };
  });

  const fileManifestList: FileEntry[] = (data.FileManifestList ?? []).map((entry) => {
    const chunkParts: ChunkPart[] = (entry.FileChunkParts ?? []).map((cp) => ({
      guid: guidFromJsonHex(cp.Guid ?? ""),
      offset: blobToNumber(cp.Offset ?? ""),
      size: blobToNumber(cp.Size ?? ""),
    }));
    const fileSize = chunkParts.reduce((acc, cp) => acc + cp.size, 0);
    // JSON FileHash is a blob-encoded 160-bit little-endian integer; reverse to canonical hex.
    const hashLeBytes = bigintToLeBytes(blobToBigInt(entry.FileHash ?? ""), 20);
    return {
      filename: entry.Filename ?? "",
      fileSize,
      fileHash: bytesToHex(reverseBytes(hashLeBytes)),
      chunkParts,
    };
  });

  return {
    version,
    buildVersion: data.BuildVersionString ?? "",
    appName: data.AppNameString ?? "",
    chunkDataList,
    fileManifestList,
  };
}

function bigintToLeBytes(value: bigint, byteLength: number): Uint8Array {
  const out = new Uint8Array(byteLength);
  let v = value;
  for (let i = 0; i < byteLength; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function chunkDirForVersion(manifestVersion: number): string {
  // Per legendary/models/manifest.py get_chunk_dir(). Fab assets in 2025+ are version ≥17, so
  // ChunksV4 is the common case; the other branches stay for forward/backward compatibility.
  if (manifestVersion >= 22) return "ChunksV5";
  if (manifestVersion >= 15) return "ChunksV4";
  if (manifestVersion >= 6) return "ChunksV3";
  if (manifestVersion >= 3) return "ChunksV2";
  return "Chunks";
}

export function chunkPath(
  chunk: ChunkInfo,
  distributionBaseUrl: string,
  manifestVersion: number,
): string {
  // {base}/{ChunksVN}/{group:02}/{hash16hexUpper}_{guid32hexUpper}.chunk
  // Hash and guid are already uppercase per guidToString/u64ToHexUpper. See chunk.py path prop.
  const dir = chunkDirForVersion(manifestVersion);
  const group = chunk.groupNumber.toString().padStart(2, "0");
  const base = distributionBaseUrl.replace(/\/+$/, "");
  return `${base}/${dir}/${group}/${chunk.hash}_${chunk.guid}.chunk`;
}

// Chunk-file payload extractor. Chunk files have their own header starting with magic 0xB1FE3AA2
// (see legendary/models/chunk.py Chunk.read). The payload at `header_size` may be zlib-compressed
// per the chunk's own `stored_as` bit. Returns the uncompressed payload bytes.
export function decodeChunkPayload(chunkBytes: Uint8Array): Uint8Array {
  const CHUNK_MAGIC = 0xb1fe3aa2;
  const reader = new Reader(
    new DataView(chunkBytes.buffer, chunkBytes.byteOffset, chunkBytes.byteLength),
  );
  const magic = reader.u32();
  if (magic !== CHUNK_MAGIC) {
    throw new Error(`Bad chunk magic: 0x${magic.toString(16)}`);
  }
  reader.u32(); // header_version
  const headerSize = reader.u32();
  reader.u32(); // compressed_size
  reader.skip(16); // guid
  reader.skip(8); // hash
  const storedAs = reader.u8();

  if ((storedAs & STORED_AS_ENCRYPTED) !== 0) {
    throw new Error("Encrypted chunks are not supported");
  }

  // Skip the rest of the header (sha_hash, hash_type, uncompressed_size, possibly secret bits).
  reader.seek(headerSize);
  const payload = chunkBytes.subarray(headerSize);
  return (storedAs & STORED_AS_COMPRESSED) !== 0 ? new Uint8Array(inflateSync(payload)) : payload;
}
