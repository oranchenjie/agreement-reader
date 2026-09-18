/**
 * 极简 ZIP 读取器（零依赖，仅用 node:zlib）。
 *
 * 用途：DOCX / XLSX / PPTX 本质都是 ZIP 包，需要先把内部 XML 取出来。
 * 只实现读取所需的子集：中央目录解析、本地头解析、stored / deflate 解压，以及基础 ZIP64。
 */
import zlib from './zlib-compat.js'

const EOCD_SIG = 0x06054b50
const EOCD64_LOCATOR_SIG = 0x07064b50
const EOCD64_SIG = 0x06064b50
const CEN_SIG = 0x02014b50
const LOC_SIG = 0x04034b50

function findEocd(buf) {
  const maxBack = Math.min(buf.length, 65_557 + 64)
  for (let i = buf.length - 22; i >= buf.length - maxBack && i >= 0; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i
  }
  return -1
}

function readZip64Extra(extra, entry) {
  // extra field id 0x0001 按顺序补齐被置为 0xFFFFFFFF 的字段
  let off = 0
  while (off + 4 <= extra.length) {
    const id = extra.readUInt16LE(off)
    const size = extra.readUInt16LE(off + 2)
    const body = extra.subarray(off + 4, off + 4 + size)
    if (id === 0x0001) {
      let p = 0
      const next = () => {
        if (p + 8 > body.length) return undefined
        const v = Number(body.readBigUInt64LE(p))
        p += 8
        return v
      }
      if (entry.uncompressedSize === 0xffffffff) entry.uncompressedSize = next() ?? entry.uncompressedSize
      if (entry.compressedSize === 0xffffffff) entry.compressedSize = next() ?? entry.compressedSize
      if (entry.localHeaderOffset === 0xffffffff) entry.localHeaderOffset = next() ?? entry.localHeaderOffset
      return entry
    }
    off += 4 + size
  }
  return entry
}

/**
 * 列出 ZIP 中的所有条目。
 * @param {Buffer} buf
 * @returns {Array<{name:string,compressionMethod:number,compressedSize:number,uncompressedSize:number,localHeaderOffset:number,crc32:number}>}
 */
export function listZipEntries(buf) {
  const eocd = findEocd(buf)
  if (eocd === -1) throw new Error('不是有效的 ZIP 文件（未找到中央目录）')

  let entryCount = buf.readUInt16LE(eocd + 10)
  let cenOffset = buf.readUInt32LE(eocd + 16)

  // ZIP64：当字段溢出时，从 ZIP64 EOCD 读取真实值
  if (entryCount === 0xffff || cenOffset === 0xffffffff) {
    const locator = eocd - 20
    if (locator >= 0 && buf.readUInt32LE(locator) === EOCD64_LOCATOR_SIG) {
      const eocd64Off = Number(buf.readBigUInt64LE(locator + 8))
      if (eocd64Off >= 0 && eocd64Off + 56 <= buf.length && buf.readUInt32LE(eocd64Off) === EOCD64_SIG) {
        entryCount = Number(buf.readBigUInt64LE(eocd64Off + 32))
        cenOffset = Number(buf.readBigUInt64LE(eocd64Off + 48))
      }
    }
  }

  const entries = []
  let p = cenOffset
  while (p + 46 <= buf.length && entries.length < entryCount + 8) {
    if (buf.readUInt32LE(p) !== CEN_SIG) break
    const compressionMethod = buf.readUInt16LE(p + 10)
    const crc32 = buf.readUInt32LE(p + 16)
    const compressedSize = buf.readUInt32LE(p + 20)
    const uncompressedSize = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localHeaderOffset = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    const extra = buf.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen)

    const entry = { name, compressionMethod, compressedSize, uncompressedSize, localHeaderOffset, crc32 }
    readZip64Extra(extra, entry)
    // 目录条目以 / 结尾，跳过
    if (!name.endsWith('/')) entries.push(entry)

    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

/** 读取单个条目的原始数据并解压 */
export function readZipEntry(buf, entry) {
  const off = entry.localHeaderOffset
  if (off + 30 > buf.length || buf.readUInt32LE(off) !== LOC_SIG) {
    throw new Error(`ZIP 本地头损坏：${entry.name}`)
  }
  const nameLen = buf.readUInt16LE(off + 26)
  const extraLen = buf.readUInt16LE(off + 28)
  const dataStart = off + 30 + nameLen + extraLen
  const data = buf.subarray(dataStart, dataStart + entry.compressedSize)

  switch (entry.compressionMethod) {
    case 0:
      return Buffer.from(data)
    case 8:
      try {
        return zlib.inflateRawSync(data)
      } catch {
        // 少数写入器不带 zlib 头
        return zlib.inflateSync(data)
      }
    default:
      throw new Error(`不支持的 ZIP 压缩方式 ${entry.compressionMethod}（${entry.name}）`)
  }
}

/** 便捷方法：按名称取条目内容（找不到返回 null） */
export function readZipEntryByName(buf, name) {
  const entry = listZipEntries(buf).find((e) => e.name === name)
  if (!entry) return null
  return readZipEntry(buf, entry)
}
