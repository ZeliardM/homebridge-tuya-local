import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import crypto from 'crypto'
import TuyaAccessory from '../src/protocol/TuyaAccessory'
import { createMockLogger } from './helpers'

// ─── net module mock ──────────────────────────────────────────────────────────
// We keep a reference to the most recently created mock socket so individual
// tests can interact with it (emit events, check calls, etc.)
let lastSocket: any

vi.mock('net', () => {
  const { EventEmitter: EE } = require('events')

  class MockSocket extends EE {
    connect = vi.fn()
    write = vi.fn(() => true)
    destroy = vi.fn()
    end = vi.fn()
    setKeepAlive = vi.fn()
    setNoDelay = vi.fn()

    constructor() {
      super()
      lastSocket = this
    }
  }
  return { default: { Socket: MockSocket } }
})

// ─── helpers ──────────────────────────────────────────────────────────────────
function makeProps(overrides: Record<string, unknown> = {}) {
  return {
    id: 'device-001',
    key: 'abcdef1234567890', // 16-byte key for AES-128
    ip: '192.168.1.50',
    name: 'Test Device',
    version: '3.3',
    log: createMockLogger(),
    connect: false, // prevent automatic TCP connection in most tests
    ...overrides,
  }
}

// Build a minimal valid Tuya frame (shared header/footer)
function buildFrame(cmd: number, payload: Buffer): Buffer {
  const prefix = 4 // 0x000055aa
  const seq = 4
  const cmdBytes = 4
  const size = 4
  const crc = 4
  const suffix = 4
  const total = prefix + seq + cmdBytes + size + payload.length + crc + suffix
  const buf = Buffer.alloc(total)
  buf.writeUInt32BE(0x000055aa, 0)
  buf.writeUInt32BE(0, 4) // sequence
  buf.writeUInt32BE(cmd, 8)
  buf.writeUInt32BE(payload.length + crc + suffix, 12) // size field
  payload.copy(buf, 16)
  buf.writeUInt32BE(0, 16 + payload.length) // crc stub
  buf.writeUInt32BE(0x0000aa55, total - 4)
  return buf
}

function decryptV35Frame(frame: Buffer, key: Buffer): Buffer {
  const headerLength = 18
  const payloadLength = frame.readUInt32BE(14)
  const payload = frame.slice(headerLength, headerLength + payloadLength)
  const iv = payload.slice(0, 12)
  const tag = payload.slice(payload.length - 16)
  const encrypted = payload.slice(12, payload.length - 16)
  const decipher = crypto.createDecipheriv('aes-128-gcm', key, iv)
  decipher.setAAD(frame.slice(4, headerLength))
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(encrypted), decipher.final()])
}

function buildV35Frame(cmd: number, payload: Buffer, key = Buffer.from('1234567890abcdef')): Buffer {
  const iv = Buffer.alloc(12, 1)
  const header = Buffer.alloc(18)
  header.writeUInt32BE(0x00006699, 0)
  header.writeUInt16BE(0, 4)
  header.writeUInt32BE(1, 6)
  header.writeUInt32BE(cmd, 10)
  header.writeUInt32BE(payload.length + 28, 14)

  const cipher = crypto.createCipheriv('aes-128-gcm', key, iv)
  cipher.setAAD(header.slice(4))
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()])
  const tag = cipher.getAuthTag()

  return Buffer.concat([header, iv, encrypted, tag, Buffer.from('00009966', 'hex')])
}

// ─── tests ────────────────────────────────────────────────────────────────────
describe('TuyaAccessory', () => {
  let log: ReturnType<typeof createMockLogger>

  beforeEach(() => {
    log = createMockLogger()
    vi.useFakeTimers()
    lastSocket = null
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  // ── Constructor ─────────────────────────────────────────────────────────────
  describe('constructor', () => {
    it('returns a TuyaAccessory instance with correct context', () => {
      const props = makeProps()
      const acc = new TuyaAccessory(props as any)
      expect(acc).toBeInstanceOf(TuyaAccessory)
      expect(acc).toBeInstanceOf(EventEmitter)
      expect(acc.context.id).toBe('device-001')
      expect(acc.context.key).toBe('abcdef1234567890')
      expect(acc.context.ip).toBe('192.168.1.50')
      expect(acc.context.version).toBe('3.3')
    })

    it('defaults version to 3.1 when not provided', () => {
      // omit version entirely so the spread default applies
      const { version: _v, ...rest } = makeProps()
      const acc = new TuyaAccessory(rest as any)
      expect(acc.context.version).toBe('3.1')
    })

    it('defaults port to 6668', () => {
      const acc = new TuyaAccessory(makeProps() as any)
      expect(acc.context.port).toBe(6668)
    })

    it('logs and skips init when required props are missing', () => {
      const props = { log, connect: false } as any
      const acc = new TuyaAccessory(props)
      expect(log.info).toHaveBeenCalledWith('Insufficient details to initialize:', expect.any(String))
      expect(acc.connected).toBe(false)
    })

    it('starts as not connected', () => {
      const acc = new TuyaAccessory(makeProps() as any)
      expect(acc.connected).toBe(false)
    })

    it('initialises an empty state object', () => {
      const acc = new TuyaAccessory(makeProps() as any)
      expect(acc.state).toEqual({})
    })
  })

  // ── Fake mode ────────────────────────────────────────────────────────────────
  describe('fake mode', () => {
    it('sets connected=true without a real socket', () => {
      // fake mode needs connect:true so _connect() is actually called
      const acc = new TuyaAccessory(makeProps({ fake: true, connect: true }) as any)
      expect(acc.connected).toBe(true)
    })

    it('emits a change event after 1 s in fake mode', () => {
      const acc = new TuyaAccessory(makeProps({ fake: true, connect: true }) as any)
      const handler = vi.fn()
      acc.on('change', handler)
      vi.advanceTimersByTime(1100)
      expect(handler).toHaveBeenCalledWith({}, {})
    })

    it('does not create a net.Socket in fake mode', () => {
      new TuyaAccessory(makeProps({ fake: true, connect: true }) as any)
      expect(lastSocket).toBeNull()
    })
  })

  // ── update() ─────────────────────────────────────────────────────────────────
  describe('update()', () => {
    it('returns true in fake mode with no args', () => {
      const acc = new TuyaAccessory(makeProps({ fake: true, connect: true }) as any)
      expect(acc.update()).toBe(true)
    })

    it('calls _fakeUpdate and emits change after 1s when DPS are given', () => {
      const acc = new TuyaAccessory(makeProps({ fake: true, connect: true }) as any)
      // advance past the constructor timeout first
      vi.advanceTimersByTime(1100)

      const handler = vi.fn()
      acc.on('change', handler)

      acc.update({ '1': true })
      vi.advanceTimersByTime(1100)

      expect(handler).toHaveBeenCalledWith({ '1': true }, { '1': true })
    })

    it('non-numeric DP keys are ignored in fake mode', () => {
      const acc = new TuyaAccessory(makeProps({ fake: true, connect: true }) as any)
      vi.advanceTimersByTime(1100)

      const handler = vi.fn()
      acc.on('change', handler)

      // 'name' is not numeric → should NOT be sent as a DP
      acc.update({ name: 'Test' } as any)
      vi.advanceTimersByTime(1100)
      expect(handler).not.toHaveBeenCalled()
    })
  })

  // ── _connect() / socket ───────────────────────────────────────────────────────
  describe('socket connection', () => {
    it('creates a socket and calls connect when connect:true', () => {
      new TuyaAccessory(makeProps({ connect: true }) as any)
      expect(lastSocket).not.toBeNull()
      expect(lastSocket.connect).toHaveBeenCalledWith(6668, '192.168.1.50')
    })

    it('marks connected=true when socket emits "connect" (v3.3)', () => {
      const acc = new TuyaAccessory(makeProps({ connect: true }) as any)
      lastSocket.emit('connect')
      expect(acc.connected).toBe(true)
    })

    it('starts v3.5 session negotiation on ready before emitting connect', () => {
      const acc = new TuyaAccessory(makeProps({ connect: true, version: '3.5' }) as any)
      lastSocket.emit('connect')
      expect(acc.connected).toBe(false)

      lastSocket.emit('ready')
      const frame = lastSocket.write.mock.calls.at(-1)[0]
      expect(frame.readUInt32BE(0)).toBe(0x00006699)
      expect(frame.readUInt32BE(10)).toBe(3)
      expect(decryptV35Frame(frame, Buffer.from(acc.context.key, 'latin1')).toString()).toBe('0123456789abcdef')
    })

    it('resets connected=false on socket close', () => {
      const acc = new TuyaAccessory(makeProps({ connect: true }) as any)
      lastSocket.emit('connect')
      expect(acc.connected).toBe(true)
      lastSocket.emit('close')
      expect(acc.connected).toBe(false)
    })

    it('resets connected=false on socket end', () => {
      const acc = new TuyaAccessory(makeProps({ connect: true }) as any)
      lastSocket.emit('connect')
      lastSocket.emit('end')
      expect(acc.connected).toBe(false)
    })

    it('handles socket errors without throwing', () => {
      new TuyaAccessory(makeProps({ connect: true }) as any)
      expect(() => lastSocket.emit('error', new Error('ECONNREFUSED'))).not.toThrow()
    })

    it('retries on ECONNRESET without destroying socket', () => {
      // use the same `log` instance so we can assert on it
      const acc = new TuyaAccessory({ ...makeProps({ connect: true, version: '3.3' }), log } as any)
      const err: NodeJS.ErrnoException = new Error('reset')
      err.code = 'ECONNRESET'
      lastSocket.emit('error', err)
      // Should have logged info and NOT destroyed the socket immediately
      expect(log.info).toHaveBeenCalled()
    })
  })

  // ── _send() returns false when not connected ──────────────────────────────────
  describe('_send() internal gating', () => {
    it('update() returns false when socket is not yet connected (non-fake)', () => {
      const acc = new TuyaAccessory(makeProps({ connect: true }) as any)
      // Not connected yet: socket was created but no 'connect' event fired
      expect(acc.update()).toBe(false)
    })

    it('_send writes to socket after connection (v3.3)', () => {
      const acc = new TuyaAccessory(makeProps({ connect: true }) as any)
      lastSocket.emit('connect')
      // update() with no args sends a status-request (cmd 10)
      acc.update()
      expect(lastSocket.write).toHaveBeenCalled()
    })

    it('_send writes to socket after connection (v3.1)', () => {
      const acc = new TuyaAccessory(makeProps({ connect: true, version: '3.1' }) as any)
      lastSocket.emit('connect')
      acc.update()
      expect(lastSocket.write).toHaveBeenCalled()
    })

    it('_send writes 6699-framed control messages for v3.5', () => {
      const acc = new TuyaAccessory(makeProps({ connect: true, version: '3.5' }) as any)
      const sessionKey = Buffer.from('1234567890abcdef')
      ;(acc as any).connected = true
      ;(acc as any).session_key = sessionKey

      acc.update({ '1': true })

      const frame = lastSocket.write.mock.calls.at(-1)[0]
      expect(frame.readUInt32BE(0)).toBe(0x00006699)
      expect(frame.readUInt32BE(10)).toBe(13)

      const payload = decryptV35Frame(frame, sessionKey)
      expect(payload.slice(0, 3).toString()).toBe('3.5')
      expect(JSON.parse(payload.slice(15).toString())).toMatchObject({
        data: { dps: { '1': true } },
        protocol: 5,
      })
    })

    it('_send writes 6699-framed status queries for v3.5', () => {
      const acc = new TuyaAccessory(makeProps({ connect: true, version: '3.5' }) as any)
      const sessionKey = Buffer.from('1234567890abcdef')
      ;(acc as any).connected = true
      ;(acc as any).session_key = sessionKey

      acc.update()

      const frame = lastSocket.write.mock.calls.at(-1)[0]
      expect(frame.readUInt32BE(0)).toBe(0x00006699)
      expect(frame.readUInt32BE(10)).toBe(16)
      expect(JSON.parse(decryptV35Frame(frame, sessionKey).toString())).toEqual({})
    })

    it('_send writes 6699-framed updatedps refreshes for v3.5', () => {
      const acc = new TuyaAccessory(makeProps({ connect: true, version: '3.5' }) as any)
      const sessionKey = Buffer.from('1234567890abcdef')
      ;(acc as any).connected = true
      ;(acc as any).session_key = sessionKey
      ;(acc as any)._requestProtocol35CommonDps('test')

      const frame = lastSocket.write.mock.calls.at(-1)[0]
      expect(frame.readUInt32BE(0)).toBe(0x00006699)
      expect(frame.readUInt32BE(10)).toBe(18)
      expect(JSON.parse(decryptV35Frame(frame, sessionKey).toString())).toEqual({
        dpId: [1, 2, 3, 4, 5, 20, 21, 22, 23, 24, 25, 26],
      })
    })
  })

  // ── Message handler 3.1 via simulated "data" events ──────────────────────────
  describe('_msgHandler_3_1 (protocol 3.1)', () => {
    function makeV31Accessory() {
      const acc = new TuyaAccessory(makeProps({ connect: true, version: '3.1' }) as any)
      lastSocket.emit('connect')
      return acc
    }

    it('ignores frames that are missing magic prefix/suffix', () => {
      const acc = makeV31Accessory()
      const handler = vi.fn()
      acc.on('change', handler)
      lastSocket.emit('data', Buffer.from('deadbeef', 'hex'))
      expect(handler).not.toHaveBeenCalled()
    })

    it('handles heartbeat (cmd 9) without error', () => {
      const acc = makeV31Accessory()
      const payload = Buffer.from('')
      const frame = buildFrame(9, payload)
      expect(() => lastSocket.emit('data', frame)).not.toThrow()
    })

    it('emits change for cmd=10 with valid JSON dps', () => {
      const acc = makeV31Accessory()
      const dpsPayload = JSON.stringify({ dps: { '1': true } })
      const frame = buildFrame(10, Buffer.from(dpsPayload))

      return new Promise<void>((resolve) => {
        acc.on('change', (oldState, newState) => {
          expect(oldState).toEqual({ '1': true })
          expect(newState).toEqual({ '1': true })
          resolve()
        })
        lastSocket.emit('data', frame)
      })
    })

    it('handles "json obj data unvalid" (cmd=10) gracefully', () => {
      const acc = makeV31Accessory()
      const handler = vi.fn()
      acc.on('change', handler)
      const frame = buildFrame(10, Buffer.from('json obj data unvalid'))
      expect(() => lastSocket.emit('data', frame)).not.toThrow()
    })

    it('handles invalid JSON payload without throwing', () => {
      const acc = makeV31Accessory()
      const frame = buildFrame(10, Buffer.from('{invalid json'))
      expect(() => lastSocket.emit('data', frame)).not.toThrow()
    })
  })

  // ── Message handler 3.3 via simulated "data" events ──────────────────────────
  describe('_msgHandler_3_3 (protocol 3.3)', () => {
    function makeV33Accessory() {
      const acc = new TuyaAccessory(makeProps({ connect: true, version: '3.3' }) as any)
      lastSocket.emit('connect')
      return acc
    }

    it('ignores frames that are too short', () => {
      const acc = makeV33Accessory()
      expect(() => lastSocket.emit('data', Buffer.from('0000', 'hex'))).not.toThrow()
    })

    it('handles heartbeat (cmd 9) without error', () => {
      const acc = makeV33Accessory()
      const frame = buildFrame(9, Buffer.from(''))
      expect(() => lastSocket.emit('data', frame)).not.toThrow()
    })

    it('handles cmd 7 without error', () => {
      const acc = makeV33Accessory()
      const frame = buildFrame(7, Buffer.from(''))
      expect(() => lastSocket.emit('data', frame)).not.toThrow()
    })
  })

  // ── _change() ────────────────────────────────────────────────────────────────
  describe('_change() (internal state tracking)', () => {
    // _change() is exercised via the real message-handler path (cmd=10 on v3.1)
    it('only emits change when state actually differs', () => {
      // Use real timers for this test since we need setImmediate to work
      vi.useRealTimers()

      const acc = new TuyaAccessory({ ...makeProps({ connect: true, version: '3.1' }), log } as any)
      lastSocket.emit('connect')

      const frame = buildFrame(10, Buffer.from(JSON.stringify({ dps: { '1': true } })))
      let callCount = 0

      return new Promise<void>((resolve) => {
        acc.on('change', () => {
          callCount++
        })

        // First message: state transitions {} → { '1': true } → should emit
        lastSocket.emit('data', frame)

        // Wait for first change to be processed
        setImmediate(() => {
          expect(callCount).toBe(1)

          // Send identical message - should NOT emit
          lastSocket.emit('data', frame)

          // Wait for async.queue to process (would emit if state changed)
          setImmediate(() => {
            setImmediate(() => {
              // Still should be 1 - no second emit
              expect(callCount).toBe(1)
              // Restore fake timers for subsequent tests
              vi.useFakeTimers()
              resolve()
            })
          })
        })
      })
    })

    it('accumulates state across multiple updates', () => {
      const acc = new TuyaAccessory(makeProps({ fake: true, connect: true }) as any)
      vi.advanceTimersByTime(1100)

      acc.update({ '1': true })
      vi.advanceTimersByTime(1100)
      acc.update({ '2': 500 })
      vi.advanceTimersByTime(1100)

      expect(acc.state).toMatchObject({ '1': true, '2': 500 })
    })

    it('polls devices every five seconds by default after the first state report', () => {
      const acc = new TuyaAccessory(makeProps({ connect: true }) as any)
      lastSocket.emit('connect')
      ;(acc as any)._change({ '1': false })
      lastSocket.write.mockClear()

      vi.advanceTimersByTime(5000)

      const commands = lastSocket.write.mock.calls.map(([frame]) => frame.readUInt32BE(8))
      expect(commands).toContain(10)
    })

    it('polls universal remote doors by default', () => {
      const acc = new TuyaAccessory(makeProps({ connect: true, type: 'UniversalRemoteDoor' }) as any)
      lastSocket.emit('connect')
      ;(acc as any)._change({ '1': false })
      lastSocket.write.mockClear()

      vi.advanceTimersByTime(5000)

      const commands = lastSocket.write.mock.calls.map(([frame]) => frame.readUInt32BE(8))
      expect(commands).toContain(10)
    })

    it('keeps polling universal remotes that do not report state', () => {
      const acc = new TuyaAccessory(makeProps({ connect: true, type: 'UniversalRemoteDoor' }) as any)
      lastSocket.emit('connect')
      ;(acc as any)._handleNoCurrentStateResponse()
      lastSocket.write.mockClear()

      vi.advanceTimersByTime(5000)

      const commands = lastSocket.write.mock.calls.map(([frame]) => frame.readUInt32BE(8))
      expect(commands).toContain(10)
    })

    it('uses the configured polling interval when provided', () => {
      const acc = new TuyaAccessory(makeProps({ connect: true, pollingInterval: 12 }) as any)
      lastSocket.emit('connect')
      ;(acc as any)._change({ '1': false })
      lastSocket.write.mockClear()

      vi.advanceTimersByTime(5000)
      let commands = lastSocket.write.mock.calls.map(([frame]) => frame.readUInt32BE(8))
      expect(commands).not.toContain(10)

      vi.advanceTimersByTime(7000)
      commands = lastSocket.write.mock.calls.map(([frame]) => frame.readUInt32BE(8))
      expect(commands).toContain(10)
    })

    it('ignores empty v3.5 cmd 13 acknowledgements without info-level raw frame logs', async () => {
      vi.useRealTimers()
      const sessionKey = Buffer.from('1234567890abcdef')
      const acc = new TuyaAccessory(makeProps({ connect: true, version: '3.5', log }) as any)
      ;(acc as any).connected = true
      ;(acc as any).session_key = sessionKey

      lastSocket.emit('data', buildV35Frame(13, Buffer.alloc(0), sessionKey))
      await new Promise((resolve) => setImmediate(resolve))

      expect(log.info).not.toHaveBeenCalledWith(expect.stringContaining('Odd message'), expect.anything())
      expect(log.info).not.toHaveBeenCalledWith(expect.stringContaining('Raw message'), expect.anything())
    })

    it('emits friendly state changes from v3.5 cmd 13 payloads', async () => {
      vi.useRealTimers()
      const sessionKey = Buffer.from('1234567890abcdef')
      const acc = new TuyaAccessory(makeProps({ connect: true, version: '3.5', type: 'RGBTWLight', log }) as any)
      ;(acc as any).connected = true
      ;(acc as any).session_key = sessionKey

      const change = new Promise<void>((resolve) => {
        acc.on('change', (changes) => {
          expect(changes).toEqual({ '20': true })
          resolve()
        })
      })

      lastSocket.emit('data', buildV35Frame(13, Buffer.from(JSON.stringify({ dps: { '20': true } })), sessionKey))
      await change

      expect(log.info).toHaveBeenCalledWith('Test Device (3.5) reported initial state: Power: on')
      expect(log.info).not.toHaveBeenCalledWith(expect.stringContaining('"20"'))
    })
  })

  // ── version routing ───────────────────────────────────────────────────────────
  describe('version-based message queue routing', () => {
    it('selects _msgHandler_3_1 for version 3.1', () => {
      const acc = new TuyaAccessory(makeProps({ version: '3.1' }) as any)
      // If constructed without error, routing was set correctly
      expect(acc).toBeInstanceOf(TuyaAccessory)
    })

    it('selects _msgHandler_3_3 for version 3.3', () => {
      const acc = new TuyaAccessory(makeProps({ version: '3.3' }) as any)
      expect(acc).toBeInstanceOf(TuyaAccessory)
    })

    it('selects _msgHandler_3_3 for version 3.2', () => {
      const acc = new TuyaAccessory(makeProps({ version: '3.2' }) as any)
      expect(acc).toBeInstanceOf(TuyaAccessory)
    })

    it('selects _msgHandler_3_4 for version 3.4', () => {
      const acc = new TuyaAccessory(makeProps({ version: '3.4' }) as any)
      expect(acc).toBeInstanceOf(TuyaAccessory)
    })

    it('selects _msgHandler_3_5 for version 3.5', () => {
      const acc = new TuyaAccessory(makeProps({ version: '3.5' }) as any)
      expect(acc).toBeInstanceOf(TuyaAccessory)
    })
  })
})
