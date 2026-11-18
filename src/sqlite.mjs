// A minimal read-only SQLite reader, just enough for the cookies database:
// the file header, the schema row that names the table, one table b-tree,
// its leaf pages, and the rows' record format. No writes, no indexes, no
// overflow chains longer than one hop's worth of scanning, no views. The
// browser holds the live database locked, so callers hand a copied file
// (openDbCopy in browser-token.mjs rides the WAL along, which carries the
// newest cookies until a checkpoint).
//
// The formats come from https://www.sqlite.org/fileformat2.html. Page sizes,
// cell pointers and varints are the whole trick; the rest is bookkeeping.

// varint reads SQLite's big-endian base-128 length: up to 9 bytes, the 9th
// contributing all 8 of its bits. The accumulator stays a BigInt until the
// end: a 9-byte varint overflows Number's safe range.
function varint(buffer, at) {
  let value = 0n
  for (let i = 0; i < 9; i++) {
    const byte = buffer[at + i]
    if (byte === undefined) return [Number(value), at + i]
    if (i === 8) return [Number((value << 8n) | BigInt(byte)), at + i + 1]
    value = (value << 7n) | BigInt(byte & 0x7f)
    if ((byte & 0x80) === 0) return [Number(value), at + i + 1]
  }
  return [Number(value), at]
}

// readRecord decodes one row's serial-type record into JS values: null,
// integers, floats, text and blobs, in column order. A record whose header
// does not parse (a payload read past the buffer's end) reads as empty
// rather than throwing: a garbage row is the caller's to skip.
function readRecord(buffer, at) {
  const [headerSize] = varint(buffer, at)
  if (headerSize <= 0 || headerSize > buffer.length - at) return []
  const types = []
  let cursor = at + headerSize
  let head = at + 1
  while (head < at + headerSize && head < buffer.length) {
    const [serial, next] = varint(buffer, head)
    head = next
    if (!Number.isSafeInteger(serial) || serial < 0) return []
    types.push(serial)
  }
  const values = []
  for (const serial of types) {
    if (serial === 0) {
      values.push(null)
    } else if (serial >= 1 && serial <= 6) {
      // Serial sizes: 1→1, 2→2, 3→3, 4→4, 5→6, 6→8 bytes (two's complement).
      const size = [1, 2, 3, 4, 6, 8][serial - 1]
      if (cursor + size > buffer.length) return []
      let value = 0n
      for (let i = 0; i < size; i++) value = (value << 8n) | BigInt(buffer[cursor + i])
      // SQLite's integers are signed two's complement.
      const bits = BigInt(size * 8)
      if (value >= 1n << (bits - 1n)) value -= 1n << bits
      values.push(Number(value))
      cursor += size
    } else if (serial === 7) {
      if (cursor + 8 > buffer.length) return []
      let value = 0n
      for (let i = 0; i < 8; i++) value = (value << 8n) | BigInt(buffer[cursor + i])
      values.push(new Float64Array(new BigUint64Array([value]).buffer)[0])
      cursor += 8
    } else if (serial === 8) {
      values.push(0)
    } else if (serial === 9) {
      values.push(1)
    } else if (serial >= 12 && serial % 2 === 0) {
      const size = (serial - 12) / 2
      if (cursor + size > buffer.length) return []
      values.push(buffer.subarray(cursor, cursor + size))
      cursor += size
    } else if (serial >= 13) {
      const size = (serial - 13) / 2
      if (cursor + size > buffer.length) return []
      values.push(buffer.subarray(cursor, cursor + size).toString("utf8"))
      cursor += size
    } else {
      // serial 10, 11: reserved, never on disk
      values.push(null)
    }
  }
  return values
}

class SqliteReader {
  constructor(buffer) {
    this.buffer = buffer
    // The page size sits at offset 16, big-endian; the value 1 means 65536.
    const size = buffer.readUInt16BE(16)
    this.pageSize = size === 1 ? 65_536 : size
    // The first page's 100-byte header offsets the b-tree structures.
    this.headerSize = 100
  }

  // page returns one page's buffer.
  page(number) {
    const start = (number - 1) * this.pageSize
    return this.buffer.subarray(start, start + this.pageSize)
  }

  // walkTable visits every row of a table b-tree rooted at `root`, in order.
  // Interior pages point at children first, then carry one row of their own
  // (a table interior's cells are pointers only, with no rows); leaf pages
  // carry the rows. A root past the file's pages (a root page number the
  // truncated or hand-built file does not carry) reads as empty.
  walkTable(root, visit) {
    const start = (root - 1) * this.pageSize
    if (root < 1 || start + 12 > this.buffer.length) return
    const page = this.page(root)
    const offset = root === 1 ? this.headerSize : 0
    const type = page[offset]
    const cellCount = page.readUInt16BE(offset + 3)
    const cellPointers = offset + (type === 2 || type === 5 ? 12 : 8)
    if (type === 5) {
      // interior table page: each cell is (left child page, varint key).
      // Cell pointers are absolute page offsets (page 1's header sits before
      // them, not under them), so no offset goes into the cell reads.
      for (let i = 0; i < cellCount; i++) {
        const cell = page.readUInt16BE(cellPointers + i * 2)
        const child = page.readUInt32BE(cell)
        this.walkTable(child, visit)
      }
      // the right-most pointer sits in the page header
      const rightMost = page.readUInt32BE(offset + 8)
      this.walkTable(rightMost, visit)
      return
    }
    if (type !== 13) return // not a table leaf: nothing to visit
    for (let i = 0; i < cellCount; i++) {
      const cell = page.readUInt16BE(cellPointers + i * 2)
      // Cell pointers are absolute page offsets already (the first page's
      // 100-byte header sits before them, not under them).
      const [payloadSize, afterSize] = varint(page, cell)
      const [rowId, afterId] = varint(page, afterSize)
      // An overflowing payload continues on overflow pages: how much fits on
      // the leaf follows the file format's formula, and the four bytes after
      // the local part name the first overflow page.
      const usable = this.pageSize
      const maxLocal = usable - 35
      let payload
      if (payloadSize <= maxLocal) {
        payload = page.subarray(afterId, afterId + payloadSize)
      } else {
        const minLocal = ((usable - 12) * 32) / 255 - 23
        const local = minLocal + ((payloadSize - minLocal) % (usable - 4))
        const inPage = page.subarray(afterId, afterId + local)
        const parts = [inPage]
        let got = inPage.length
        let next = page.readUInt32BE(afterId + local)
        let hops = 0
        while (next !== 0 && got < payloadSize && hops < 100_000) {
          const overflow = this.page(next)
          const following = overflow.readUInt32BE(0)
          const take = Math.min(usable - 4, payloadSize - got)
          parts.push(overflow.subarray(4, 4 + take))
          got += take
          next = following
          hops += 1
        }
        payload = Buffer.concat(parts)
      }
      visit(rowId, readRecord(payload, 0))
    }
  }

  // findTable locates a table's root page by name through the schema table
  // (rooted at page 1), and its CREATE statement's column order.
  findTable(name) {
    const wanted = name.toLowerCase()
    let found = null
    this.walkTable(1, (_rowId, row) => {
      if (found) return
      const [type, tableName, _tblName, rootPage, sql] = row
      if (typeof type === "string" && type === "table" && typeof tableName === "string" && tableName.toLowerCase() === wanted && Number.isFinite(rootPage)) {
        found = { rootPage, sql: typeof sql === "string" ? sql : "" }
      }
    })
    return found
  }

  // readRows reads every row of one table as arrays of column values, in the
  // CREATE statement's column order (the record stores values positionally).
  readRows(name) {
    const table = this.findTable(name)
    if (!table) return []
    const rows = []
    this.walkTable(table.rootPage, (_rowId, row) => rows.push(row))
    return rows
  }
}

// open reads one SQLite file's bytes into a reader; a file that is not a
// database (the 16-byte magic) reads as empty rather than throwing.
import { readFileSync } from "node:fs"

function open(path) {
  let buffer
  try {
    buffer = readFileSync(path)
  } catch {
    return null
  }
  if (buffer.length < 100 || !buffer.subarray(0, 16).toString("latin1").startsWith("SQLite format 3")) return null
  return new SqliteReader(buffer)
}

export { open, SqliteReader, varint, readRecord }
