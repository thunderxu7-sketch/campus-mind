import { inflateRawSync } from 'node:zlib';
import { DomainError } from './errors.js';

function u16(buffer: Buffer, offset: number): number { return buffer.readUInt16LE(offset); }
function u32(buffer: Buffer, offset: number): number { return buffer.readUInt32LE(offset); }
function xmlDecode(value: string): string {
  return value.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
function entryMap(buffer: Buffer): Map<string, Buffer> {
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new DomainError('IMPORT_INVALID', 'XLSX 压缩包目录无效');
  const directorySize = u32(buffer, eocd + 12);
  const directoryOffset = u32(buffer, eocd + 16);
  if (directoryOffset + directorySize > buffer.length) throw new DomainError('IMPORT_INVALID', 'XLSX 目录超出文件范围');
  const entries = new Map<string, Buffer>();
  let totalUncompressed = 0;
  let entryCount = 0;
  let offset = directoryOffset;
  const end = directoryOffset + directorySize;
  while (offset < end) {
    entryCount += 1;
    if (entryCount > 200) throw new DomainError('IMPORT_INVALID', 'XLSX 文件项数量超出限制');
    if (u32(buffer, offset) !== 0x02014b50) throw new DomainError('IMPORT_INVALID', 'XLSX 文件项无效');
    const compression = u16(buffer, offset + 10);
    const compressedSize = u32(buffer, offset + 20);
    const uncompressedSize = u32(buffer, offset + 24);
    if (uncompressedSize > 20_000_000) throw new DomainError('IMPORT_INVALID', 'XLSX 解压后文件过大');
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > 50_000_000) throw new DomainError('IMPORT_INVALID', 'XLSX 总解压大小超出限制');
    const nameLength = u16(buffer, offset + 28);
    const extraLength = u16(buffer, offset + 30);
    const commentLength = u16(buffer, offset + 32);
    const localOffset = u32(buffer, offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    const localNameLength = u16(buffer, localOffset + 26);
    const localExtraLength = u16(buffer, localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(start, start + compressedSize);
    if (start + compressedSize > buffer.length) throw new DomainError('IMPORT_INVALID', 'XLSX 文件项超出范围');
    if (compression !== 0 && compression !== 8) throw new DomainError('IMPORT_INVALID', 'XLSX 使用了不支持的压缩方式');
    entries.set(name, compression === 8 ? inflateRawSync(compressed) : Buffer.from(compressed));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function cellValue(xml: string, type: string | undefined, shared: string[]): string {
  if (type === 'inlineStr') return xmlDecode([...xml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((match) => match[1]).join(''));
  const value = xml.match(/<v[^>]*>([\s\S]*?)<\/v>/)?.[1] ?? '';
  if (type === 's') return xmlDecode(shared[Number(value)] ?? '');
  return xmlDecode(value);
}

function columnIndex(reference: string): number {
  const letters = reference.match(/[A-Z]+/i)?.[0]?.toUpperCase() ?? '';
  let value = 0; for (const letter of letters) value = value * 26 + letter.charCodeAt(0) - 64; return Math.max(0, value - 1);
}

/** Parse the first worksheet of a bounded XLSX upload without executing formulas or macros. */
export function parseXlsxBase64(encoded: string, maxBytes = 2_000_000): Array<Record<string, string>> {
  let buffer: Buffer;
  if (!encoded || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(encoded) || encoded.replace(/=+$/, '').length % 4 === 1) throw new DomainError('IMPORT_INVALID', 'XLSX 编码无效');
  try { buffer = Buffer.from(encoded.replace(/-/g, '+').replace(/_/g, '/'), 'base64'); } catch { throw new DomainError('IMPORT_INVALID', 'XLSX 编码无效'); }
  if (!buffer.length || buffer.length > maxBytes) throw new DomainError('IMPORT_INVALID', 'XLSX 文件大小超出限制');
  let entries: Map<string, Buffer>;
  try { entries = entryMap(buffer); } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError('IMPORT_INVALID', 'XLSX 文件结构无效');
  }
  const sheet = entries.get('xl/worksheets/sheet1.xml');
  if (!sheet) throw new DomainError('IMPORT_INVALID', 'XLSX 缺少首个工作表');
  const sharedXml = entries.get('xl/sharedStrings.xml')?.toString('utf8') ?? '';
  const shared = [...sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((match) => { const body = match[1] ?? ''; return xmlDecode([...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1] ?? '').join('')); });
  const rows: string[][] = [];
  for (const rowMatch of sheet.toString('utf8').matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    if (rows.length >= 10_001) throw new DomainError('IMPORT_INVALID', 'XLSX 行数超出限制');
    const cells: string[] = [];
    for (const cellMatch of (rowMatch[1] ?? '').matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      if (cells.length >= 100) throw new DomainError('IMPORT_INVALID', 'XLSX 列数超出限制');
      const attrs = cellMatch[1] ?? '';
      const ref = attrs.match(/\br="([A-Z]+\d+)"/)?.[1] ?? '';
      const index = columnIndex(ref);
      if (index >= 100) throw new DomainError('IMPORT_INVALID', 'XLSX 列数超出限制');
      const type = attrs.match(/\bt="([^"]+)"/)?.[1];
      while (cells.length <= index) cells.push('');
      cells[index] = cellValue(cellMatch[2] ?? '', type, shared);
    }
    rows.push(cells);
  }
  if (rows.length < 2 || !rows[0]?.length) throw new DomainError('IMPORT_INVALID', 'XLSX 至少需要表头和一行数据');
  const headers = rows[0].map((header) => header.trim());
  if (headers.some((header) => !header)) throw new DomainError('IMPORT_INVALID', 'XLSX 表头不能为空');
  return rows.slice(1).filter((row) => row.some((value) => value.trim())).map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ''])));
}
