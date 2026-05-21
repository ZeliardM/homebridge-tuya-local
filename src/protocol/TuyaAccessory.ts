import net from 'net'
import async from 'async'
import crypto from 'crypto'
import { EventEmitter } from 'events'
import type { Logger } from 'homebridge'
import type { DPSState, DPSValue, TuyaDeviceContext } from '../types'

const isNonEmptyPlainObject = (o: unknown): o is Record<string, unknown> => {
  if (!o || typeof o !== 'object') return false
  for (const _i in o) return true
  return false
}

interface TuyaSocket extends net.Socket {
  _pinger?: ReturnType<typeof setTimeout> | null
  _connTimeout?: ReturnType<typeof setTimeout> | null
  _errorReconnect?: ReturnType<typeof setTimeout> | null
  reconnect: () => void
  _ping: () => void
}

interface MessageTask {
  msg: Buffer
}

interface SendPayload {
  cmd: number
  data?: Buffer | Record<string, unknown> | string
  encrypted?: boolean
}

const PREFIX_55AA = Buffer.from('000055aa', 'hex')
const PREFIX_6699 = Buffer.from('00006699', 'hex')
const SUFFIX_6699 = Buffer.from('00009966', 'hex')
const PROTOCOL_HEADER_PADDING = Buffer.alloc(12)
const NO_PROTOCOL_HEADER_COMMANDS = new Set([3, 4, 5, 9, 10, 16, 18, 64])
const PROTOCOL_35_LOCAL_NONCE = Buffer.from('0123456789abcdef')
const PROTOCOL_35_COMMON_DPS = [1, 2, 3, 4, 5, 20, 21, 22, 23, 24, 25, 26]

class TuyaAccessory extends EventEmitter {
  log!: Logger
  context!: TuyaDeviceContext & {
    port: number
    pingGap?: number
    pingTimeout?: number
    connectTimeout?: number
    intro?: boolean
    sendEmptyUpdate?: boolean
    fake?: boolean
    pollingInterval?: number
  }
  state: DPSState = {}
  connected = false

  private _cachedBuffer: Buffer = Buffer.allocUnsafe(0)
  private _msgQueue!: async.QueueObject<MessageTask>
  private _socket!: TuyaSocket
  private _connectionAttempts = 0
  private _sendCounter = 0
  private _tmpLocalKey: Buffer | null = null
  private _tmpRemoteKey: Buffer | null = null
  private _protocol35DpsRefreshCount = 0
  private _protocol35EmptyStateLogged = false
  private _poller?: ReturnType<typeof setTimeout> | null
  private _lastReceivedAt?: number
  private _lastSentAt?: number
  private _lastSentCommand?: number
  session_key: Buffer | null = null

  constructor(props: Partial<TuyaDeviceContext> & { log: Logger; fake?: boolean; port?: number; connect?: boolean }) {
    super()

    if (!(props.id && props.key && props.ip) && !props.fake) {
      if (props.log) props.log.info('Insufficient details to initialize:', JSON.stringify(props))
      return
    }

    this.log = props.log
    this.context = { version: '3.1', port: 6668, ...props } as TuyaAccessory['context']
    this.state = {}
    this._cachedBuffer = Buffer.allocUnsafe(0)

    const version = parseFloat(this.context.version || '3.1')
    const handlerName =
      version < 3.2
        ? '_msgHandler_3_1'
        : this._isProtocol35()
          ? '_msgHandler_3_5'
          : this._requiresSessionKeyNegotiation()
            ? '_msgHandler_3_4'
            : '_msgHandler_3_3'
    this._msgQueue = async.queue(this[handlerName].bind(this) as async.AsyncWorker<MessageTask>, 1)

    if (version >= 3.2) {
      this.context.pingGap = Math.min(this.context.pingGap || 9, 9)
    }

    this.connected = false
    if (props.connect !== false) this._connect()

    this._connectionAttempts = 0
    this._sendCounter = 0

    this._tmpLocalKey = null
    this._tmpRemoteKey = null
    this.session_key = null
  }

  _connect(): void {
    if (this.context.fake) {
      this.connected = true
      return void setTimeout(() => {
        this.emit('change', {}, this.state)
      }, 1000)
    }

    this._socket = new net.Socket() as TuyaSocket

    this._incrementAttemptCounter()
    ;(this._socket.reconnect = () => {
      if (this._socket._pinger) {
        clearTimeout(this._socket._pinger)
        this._socket._pinger = null
      }

      if (this._socket._connTimeout) {
        clearTimeout(this._socket._connTimeout)
        this._socket._connTimeout = null
      }

      if (this._socket._errorReconnect) {
        clearTimeout(this._socket._errorReconnect)
        this._socket._errorReconnect = null
      }
      this._clearPoller()

      this._socket.setKeepAlive(true)
      this._socket.setNoDelay(true)

      this._socket._connTimeout = setTimeout(
        () => {
          this._socket.emit('error', new Error('ERR_CONNECTION_TIMED_OUT'))
        },
        (this.context.connectTimeout || 30) * 1000,
      )

      this._incrementAttemptCounter()

      this._socket.connect(this.context.port, this.context.ip!)
    })()

    this._socket._ping = () => {
      if (this._socket._pinger) clearTimeout(this._socket._pinger)
      this._socket._pinger = setTimeout(
        () => {
          this._socket._pinger = setTimeout(() => {
            this._socket.emit('error', new Error('ERR_PING_TIMED_OUT'))
          }, 5000)

          if (this._isProtocol35() && !isNonEmptyPlainObject(this.state)) {
            this.log.warn(
              `${this.context.name} (${this.context.version}) heartbeat timed out before state was reported. ${this._diagnosticSummary()}`,
            )
          }
          this._send({ cmd: 9 })
        },
        (this.context.pingTimeout || 30) * 1000,
      )

      this._send({ cmd: 9 })
    }

    this._socket.on('connect', () => {
      if (!this._requiresSessionKeyNegotiation()) {
        clearTimeout(this._socket._connTimeout!)

        this.connected = true
        this.emit('connect')
        if (this._socket._pinger) clearTimeout(this._socket._pinger)
        this._socket._pinger = setTimeout(() => this._socket._ping(), 1000)

        if (this.context.intro === false) {
          this.emit('change', {}, this.state)
          process.nextTick(this.update.bind(this))
        }
      }
    })

    this._socket.on('ready', () => {
      if (this.context.intro === false) return
      this.connected = true

      if (this._requiresSessionKeyNegotiation()) {
        this._tmpLocalKey = this._isProtocol35() ? Buffer.from(PROTOCOL_35_LOCAL_NONCE) : crypto.randomBytes(16)
        const payload: SendPayload = {
          data: this._tmpLocalKey,
          encrypted: true,
          cmd: 3,
        }
        this._send(payload)
      } else {
        this.update()
      }
    })

    this._socket.on('data', (msg: Buffer) => {
      this._lastReceivedAt = Date.now()
      this._cachedBuffer = Buffer.concat([this._cachedBuffer, msg])

      do {
        const frame = this._dequeueFrame()
        if (!frame) break
        this._msgQueue.push({ msg: frame })
      } while (this._cachedBuffer.length)
    })

    this._socket.on('error', (err: NodeJS.ErrnoException) => {
      this._markDisconnected(err instanceof Error ? err : new Error(String(err)))
      this.log.info(
        `Socket had a problem and will reconnect to ${this.context.name} (${(err && err.code) || err})${this._diagnosticSuffix()}`,
      )

      if (err && (err.code === 'ECONNRESET' || err.code === 'EPIPE') && this._connectionAttempts < 10) {
        this.log.debug(`Reconnecting with connection attempts =  ${this._connectionAttempts}`)
        return process.nextTick(this._socket.reconnect.bind(this))
      }

      this._socket.destroy()

      let delay = 5000
      if (err) {
        if (err.code === 'ENOBUFS') {
          this.log.warn('Operating system complained of resource exhaustion; did I open too many sockets?')
          this.log.info(
            'Slowing down retry attempts; if you see this happening often, it could mean some sort of incompatibility.',
          )
          delay = 60000
        } else if (this._connectionAttempts > 10) {
          this.log.info(
            'Slowing down retry attempts; if you see this happening often, it could mean some sort of incompatibility.',
          )
          delay = 60000
        }
      }

      if (!this._socket._errorReconnect) {
        this.log.debug(`after error setting _connect in ${delay}ms`)
        this._socket._errorReconnect = setTimeout(() => {
          this.log.debug(`executing _connect after ${delay}ms delay`)
          process.nextTick(this._connect.bind(this))
        }, delay)
      }
    })

    this._socket.on('close', () => {
      this._markDisconnected(new Error('Disconnected'))
    })

    this._socket.on('end', () => {
      this._markDisconnected(new Error('Disconnected'))
      this.log.info(`Disconnected from ${this.context.name}${this._diagnosticSuffix()}`)
    })
  }

  private _incrementAttemptCounter(): void {
    this._connectionAttempts++
    setTimeout(() => {
      this.log.debug(`decrementing this._connectionAttempts, currently ${this._connectionAttempts}`)
      this._connectionAttempts--
    }, 10000)
  }

  private _requiresSessionKeyNegotiation(): boolean {
    return parseFloat(this.context.version || '3.1') >= 3.4
  }

  private _isProtocol35(): boolean {
    return String(this.context.version) === '3.5'
  }

  private _dequeueFrame(): Buffer | null {
    const prefix55Index = this._cachedBuffer.indexOf(PREFIX_55AA)
    const prefix66Index = this._cachedBuffer.indexOf(PREFIX_6699)
    let startingIndex: number

    if (prefix55Index !== -1 && prefix66Index !== -1) {
      startingIndex = Math.min(prefix55Index, prefix66Index)
    } else {
      startingIndex = Math.max(prefix55Index, prefix66Index)
    }

    if (startingIndex === -1) {
      this._cachedBuffer = Buffer.allocUnsafe(0)
      return null
    }

    if (startingIndex !== 0) this._cachedBuffer = this._cachedBuffer.slice(startingIndex)

    if (this._cachedBuffer.indexOf(PREFIX_6699) === 0) {
      if (this._cachedBuffer.length < 18) return null
      const size = this._cachedBuffer.readUInt32BE(14)
      const frameLength = 18 + size + SUFFIX_6699.length
      if (this._cachedBuffer.length < frameLength) return null
      const frame = this._cachedBuffer.slice(0, frameLength)
      this._cachedBuffer = this._cachedBuffer.slice(frameLength)
      return frame
    }

    if (this._cachedBuffer.length < 16) return null
    const size = this._cachedBuffer.readUInt32BE(12)
    const frameLength = 16 + size
    if (this._cachedBuffer.length < frameLength) return null
    const frame = this._cachedBuffer.slice(0, frameLength)
    this._cachedBuffer = this._cachedBuffer.slice(frameLength)
    return frame
  }

  private _msgHandler_3_1(task: MessageTask, callback: () => void): void {
    if (!(task.msg instanceof Buffer)) return callback()

    const len = task.msg.length
    if (len < 16 || task.msg.readUInt32BE(0) !== 0x000055aa || task.msg.readUInt32BE(len - 4) !== 0x0000aa55)
      return callback()

    const size = task.msg.readUInt32BE(12)
    if (len - 8 < size) return callback()

    const cmd = task.msg.readUInt32BE(8)
    let data: string | { dps?: DPSState } = task.msg
      .slice(len - size, len - 8)
      .toString('utf8')
      .trim()
      .replace(/\0/g, '')

    if (this.context.intro === false && cmd !== 9) this.log.info('Message from', this.context.name + ':', data)

    switch (cmd) {
      case 7:
        break

      case 9:
        if (this._socket._pinger) clearTimeout(this._socket._pinger)
        this._socket._pinger = setTimeout(
          () => {
            this._socket._ping()
          },
          ((this.context.pingGap || 20) as number) * 1000,
        )
        break

      case 8: {
        let decryptedMsg: string
        try {
          const decipher = crypto.createDecipheriv('aes-128-ecb', this.context.key, '')
          decryptedMsg = decipher.update((data as string).substr(19), 'base64', 'utf8')
          decryptedMsg += decipher.final('utf8')
        } catch (_ex) {
          decryptedMsg = (data as string).substr(19).toString()
        }

        try {
          data = JSON.parse(decryptedMsg)
        } catch (_ex) {
          data = decryptedMsg
          this.log.debug(`Odd message from ${this.context.name} with command ${cmd}:`, data)
          this.log.debug(
            `Raw message from ${this.context.name} (${this.context.version}) with command ${cmd}:`,
            task.msg.toString('hex'),
          )
          break
        }

        if (data && typeof data === 'object' && data.dps) {
          this._change(data.dps)
        }
        break
      }

      case 10:
        if (data) {
          if (data === 'json obj data unvalid') {
            this._handleNoCurrentStateResponse()
            break
          }

          try {
            data = JSON.parse(data as string)
          } catch (_ex) {
            this.log.debug(`Malformed update from ${this.context.name} with command ${cmd}:`, data)
            this.log.debug(
              `Raw update from ${this.context.name} (${this.context.version}) with command ${cmd}:`,
              task.msg.toString('hex'),
            )
            break
          }

          if (data && typeof data === 'object' && data.dps) this._change(data.dps)
        }
        break

      default:
        this.log.debug(`Odd message from ${this.context.name} with command ${cmd}:`, data)
        this.log.debug(
          `Raw message from ${this.context.name} (${this.context.version}) with command ${cmd}:`,
          task.msg.toString('hex'),
        )
    }

    callback()
  }

  private _msgHandler_3_3(task: MessageTask, callback: () => void): void {
    if (!(task.msg instanceof Buffer)) return callback()

    const len = task.msg.length
    if (len < 16 || task.msg.readUInt32BE(0) !== 0x000055aa || task.msg.readUInt32BE(len - 4) !== 0x0000aa55)
      return callback()

    const size = task.msg.readUInt32BE(12)
    if (len - 8 < size) return callback()

    const cmd = task.msg.readUInt32BE(8)

    if (cmd === 7) return callback()
    if (cmd === 9) {
      if (this._socket._pinger) clearTimeout(this._socket._pinger)
      this._socket._pinger = setTimeout(
        () => {
          this._socket._ping()
        },
        ((this.context.pingGap || 20) as number) * 1000,
      )

      return callback()
    }

    let versionPos = task.msg.indexOf('3.3')
    if (versionPos === -1) versionPos = task.msg.indexOf('3.2')
    const cleanMsg = task.msg.slice(
      versionPos === -1 ? len - size + (task.msg.readUInt32BE(16) & 0xffffff00 ? 0 : 4) : 15 + versionPos,
      len - 8,
    )

    let decryptedMsg: string
    try {
      const decipher = crypto.createDecipheriv('aes-128-ecb', this.context.key, '')
      decryptedMsg = decipher.update(cleanMsg, undefined, 'utf8')
      decryptedMsg += decipher.final('utf8')
    } catch (_ex) {
      decryptedMsg = cleanMsg.toString('utf8')
    }

    if (cmd === 10 && decryptedMsg === 'json obj data unvalid') {
      this._handleNoCurrentStateResponse()
      return callback()
    }

    let data: { dps?: DPSState }
    try {
      data = JSON.parse(decryptedMsg)
    } catch (_ex) {
      this.log.debug(`Odd message from ${this.context.name} with command ${cmd}:`, decryptedMsg)
      this.log.debug(
        `Raw message from ${this.context.name} (${this.context.version}) with command ${cmd}:`,
        task.msg.toString('hex'),
      )
      return callback()
    }

    switch (cmd) {
      case 8:
      case 10:
        if (data) {
          if (data.dps) {
            this._change(data.dps)
          } else {
            this.log.debug(`Malformed message from ${this.context.name} with command ${cmd}:`, decryptedMsg)
            this.log.debug(
              `Raw message from ${this.context.name} (${this.context.version}) with command ${cmd}:`,
              task.msg.toString('hex'),
            )
          }
        }
        break

      default:
        this.log.debug(`Odd message from ${this.context.name} with command ${cmd}:`, decryptedMsg)
        this.log.debug(
          `Raw message from ${this.context.name} (${this.context.version}) with command ${cmd}:`,
          task.msg.toString('hex'),
        )
    }

    callback()
  }

  private _msgHandler_3_4(task: MessageTask, callback: () => void): void {
    if (!(task.msg instanceof Buffer)) return callback()

    const len = task.msg.length
    if (len < 16 || task.msg.readUInt32BE(0) !== 0x000055aa || task.msg.readUInt32BE(len - 4) !== 0x0000aa55)
      return callback()

    const size = task.msg.readUInt32BE(12)
    if (len - 8 < size) return callback()

    const cmd = task.msg.readUInt32BE(8)

    if (cmd === 7 || cmd === 13) return callback()
    if (cmd === 9) {
      if (this._socket._pinger) clearTimeout(this._socket._pinger)
      this._socket._pinger = setTimeout(
        () => {
          this._socket._ping()
        },
        ((this.context.pingGap || 20) as number) * 1000,
      )

      return callback()
    }

    const versionPos = task.msg.indexOf('3.4')
    const cleanMsg = task.msg.slice(
      versionPos === -1 ? len - size + (task.msg.readUInt32BE(16) & 0xffffff00 ? 0 : 4) : 15 + versionPos,
      len - 0x24,
    )

    const expectedCrc = task.msg.slice(len - 0x24, task.msg.length - 4).toString('hex')
    const computedCrc = hmac(task.msg.slice(0, len - 0x24), this.session_key ?? this.context.key).toString('hex')

    if (expectedCrc !== computedCrc) {
      throw new Error(`HMAC mismatch: expected ${expectedCrc}, was ${computedCrc}. ${task.msg.toString('hex')}`)
    }

    const decipher = crypto.createDecipheriv('aes-128-ecb', this.session_key ?? this.context.key, null)
    decipher.setAutoPadding(false)
    let decryptedMsg: Buffer = decipher.update(cleanMsg)
    decipher.final()
    decryptedMsg = decryptedMsg.slice(0, decryptedMsg.length - decryptedMsg[decryptedMsg.length - 1])

    let parsedPayload: any
    try {
      let sliced = decryptedMsg
      if (decryptedMsg.indexOf(String(this.context.version || '3.4')) === 0) {
        sliced = decryptedMsg.slice(15)
      }
      const res = JSON.parse(sliced.toString())
      if ('data' in res) {
        const resdata = res.data
        resdata.t = res.t
        parsedPayload = resdata
      } else {
        parsedPayload = res
      }
    } catch (_) {
      parsedPayload = decryptedMsg
    }

    if (cmd === 4) {
      this._tmpRemoteKey = parsedPayload.subarray(0, 16)
      const calcLocalHmac = hmac(this._tmpLocalKey!, this.session_key ?? this.context.key).toString('hex')
      const expLocalHmac = parsedPayload.slice(16, 16 + 32).toString('hex')
      if (expLocalHmac !== calcLocalHmac) {
        throw new Error(
          `HMAC mismatch(keys): expected ${expLocalHmac}, was ${calcLocalHmac}. ${parsedPayload.toString('hex')}`,
        )
      }
      const payload: SendPayload = {
        data: hmac(this._tmpRemoteKey!, this.context.key) as unknown as Buffer,
        encrypted: true,
        cmd: 5,
      }
      this._send(payload)
      clearTimeout(this._socket._connTimeout!)

      this.session_key = Buffer.from(this._tmpLocalKey!)
      for (let i = 0; i < this._tmpLocalKey!.length; i++) {
        this.session_key[i] = this._tmpLocalKey![i] ^ this._tmpRemoteKey![i]
      }

      this.session_key = encrypt34(this.session_key, this.context.key)
      clearTimeout(this._socket._connTimeout!)

      this.connected = true
      this.update()
      this.emit('connect')
      if (this._socket._pinger) clearTimeout(this._socket._pinger)
      this._socket._pinger = setTimeout(() => this._socket._ping(), 1000)

      return callback()
    }

    if (cmd === 10 && parsedPayload === 'json obj data unvalid') {
      this._handleNoCurrentStateResponse()
      return callback()
    }

    switch (cmd) {
      case 8:
      case 10:
      case 16:
      case 18:
        if (parsedPayload) {
          if (parsedPayload.dps) {
            this._change(parsedPayload.dps)
          } else {
            this.log.debug(`Malformed message from ${this.context.name} with command ${cmd}:`, decryptedMsg)
            this.log.debug(
              `Raw message from ${this.context.name} (${this.context.version}) with command ${cmd}:`,
              task.msg.toString('hex'),
            )
          }
        }
        break

      default:
        this.log.debug(`Odd message from ${this.context.name} with command ${cmd}:`, decryptedMsg)
        this.log.debug(
          `Raw message from ${this.context.name} (${this.context.version}) with command ${cmd}:`,
          task.msg.toString('hex'),
        )
    }

    callback()
  }

  private _msgHandler_3_5(task: MessageTask, callback: () => void): void {
    if (!(task.msg instanceof Buffer)) return callback()

    const len = task.msg.length
    if (len < 22 || task.msg.readUInt32BE(0) !== 0x00006699 || task.msg.readUInt32BE(len - 4) !== 0x00009966)
      return callback()

    const size = task.msg.readUInt32BE(14)
    if (len < 18 + size + 4) return callback()

    const cmd = task.msg.readUInt32BE(10)

    if (cmd === 9) {
      if (this._socket._pinger) clearTimeout(this._socket._pinger)
      this._socket._pinger = setTimeout(
        () => {
          this._socket._ping()
        },
        ((this.context.pingGap || 20) as number) * 1000,
      )
    }

    let parsedPayload: any
    try {
      parsedPayload = this._decrypt_3_5(task.msg)
    } catch (_ex) {
      this.log.info(
        `Failed to decrypt message from ${this.context.name} (${this.context.version}) with command ${cmd}.`,
      )
      this.log.debug(
        `Raw message from ${this.context.name} (${this.context.version}) with command ${cmd}:`,
        task.msg.toString('hex'),
      )
      return callback()
    }

    if (cmd === 4) {
      this._tmpRemoteKey = parsedPayload.subarray(0, 16)
      const calcLocalHmac = hmac(this._tmpLocalKey!, this.context.key)
      const expLocalHmac = parsedPayload.slice(16, 16 + 32)
      if (!calcLocalHmac.equals(expLocalHmac)) {
        throw new Error(
          `HMAC mismatch(keys): expected ${expLocalHmac.toString('hex')}, was ${calcLocalHmac.toString('hex')}. ${parsedPayload.toString('hex')}`,
        )
      }

      const payload: SendPayload = {
        data: hmac(this._tmpRemoteKey!, this.context.key) as unknown as Buffer,
        encrypted: true,
        cmd: 5,
      }
      this._send(payload)
      clearTimeout(this._socket._connTimeout!)

      const xorKey = Buffer.from(this._tmpLocalKey!)
      for (let i = 0; i < xorKey.length; i++) {
        xorKey[i] = this._tmpLocalKey![i] ^ this._tmpRemoteKey![i]
      }

      this.session_key = encrypt35SessionKey(xorKey, this.context.key, this._tmpLocalKey!.slice(0, 12))
      clearTimeout(this._socket._connTimeout!)

      this.connected = true
      this.emit('connect')
      this.log.info(`${this.context.name} (${this.context.version}) session key negotiated; requesting initial status.`)
      setTimeout(() => this.update(), 250)
      setTimeout(() => this._requestProtocol35CommonDps('startup refresh'), 2500)
      setTimeout(() => this._requestProtocol35CommonDps('follow-up refresh'), 8000)
      setTimeout(() => this._logProtocol35NoDps(), 15000)
      if (this._socket._pinger) clearTimeout(this._socket._pinger)
      this._socket._pinger = setTimeout(() => this._socket._ping(), 1000)

      return callback()
    }

    if (cmd === 10 && parsedPayload === 'json obj data unvalid') {
      this._handleNoCurrentStateResponse()
      return callback()
    }

    switch (cmd) {
      case 8:
      case 10:
      case 13:
      case 16:
      case 18:
        if (parsedPayload) {
          if (parsedPayload.dps) {
            this._change(parsedPayload.dps)
          } else if (parsedPayload.data?.dps) {
            this._change(parsedPayload.data.dps)
          } else if (!this._isEmptyPayload(parsedPayload)) {
            this.log.debug(`Malformed message from ${this.context.name} with command ${cmd}:`, parsedPayload)
            this.log.debug(
              `Raw message from ${this.context.name} (${this.context.version}) with command ${cmd}:`,
              task.msg.toString('hex'),
            )
          }
        }
        break

      default:
        if (cmd !== 9) {
          this.log.debug(`Odd message from ${this.context.name} with command ${cmd}:`, parsedPayload)
          this.log.debug(
            `Raw message from ${this.context.name} (${this.context.version}) with command ${cmd}:`,
            task.msg.toString('hex'),
          )
        }
    }

    callback()
  }

  private _decrypt_3_5(message: Buffer): any {
    const headerLength = 18
    const payloadLength = message.readUInt32BE(14)
    const payloadStart = headerLength
    const payloadEnd = headerLength + payloadLength
    const payload = message.slice(payloadStart, payloadEnd)
    const iv = payload.slice(0, 12)
    const tag = payload.slice(payload.length - 16)
    const encrypted = payload.slice(12, payload.length - 16)
    const key = this.session_key ?? Buffer.from(this.context.key, 'latin1')

    const decipher = crypto.createDecipheriv('aes-128-gcm', key, iv)
    decipher.setAAD(message.slice(4, headerLength))
    decipher.setAuthTag(tag)

    let decryptedMsg = decipher.update(encrypted)
    decryptedMsg = Buffer.concat([decryptedMsg, decipher.final()])

    if (decryptedMsg.length >= 4) {
      const maybePayload = decryptedMsg.slice(4)
      if (
        decryptedMsg.readUInt32BE(0) === 0 ||
        maybePayload[0] === 0x7b ||
        maybePayload.indexOf(String(this.context.version || '3.5')) === 0
      ) {
        decryptedMsg = maybePayload
      }
    }

    try {
      if (decryptedMsg.indexOf(String(this.context.version || '3.5')) === 0) {
        decryptedMsg = decryptedMsg.slice(15)
      }

      const res = JSON.parse(decryptedMsg.toString())
      if ('data' in res) {
        const resdata = res.data
        resdata.t = res.t
        return resdata
      }

      return res
    } catch (_) {
      return decryptedMsg
    }
  }

  update(o?: Record<string, DPSValue>): boolean {
    const dps: DPSState = {}
    let hasDataPoint = false
    if (o) {
      Object.keys(o).forEach((key) => {
        if (!isNaN(Number(key))) {
          dps['' + key] = o[key]
          hasDataPoint = true
        }
      })
    }

    if (this.context.fake) {
      if (hasDataPoint) this._fakeUpdate(dps)
      return true
    }

    let result: boolean | undefined
    if (hasDataPoint) {
      const t = (Date.now() / 1000).toFixed(0)
      const protocolTime = this._isProtocol35() ? Number(t) : t
      const payload: Record<string, unknown> = {
        devId: this.context.id,
        uid: '',
        t,
        dps,
      }
      const data = this._requiresSessionKeyNegotiation()
        ? this._isProtocol35()
          ? {
              data: { dps },
              protocol: 5,
              t: protocolTime,
            }
          : {
              data: { ...payload, ctype: 0, t: undefined },
              protocol: 5,
              t,
            }
        : payload
      result = this._send({
        data: data as Record<string, unknown>,
        cmd: this._requiresSessionKeyNegotiation() ? 13 : 7,
      })
      if (result !== true) this.log.info(' Result', result)
      if (this.context.sendEmptyUpdate) {
        this._send({ cmd: this._requiresSessionKeyNegotiation() ? 13 : 7 })
      }
    } else {
      result = this._send({
        data: this._isProtocol35()
          ? {}
          : {
              gwId: this.context.id,
              devId: this.context.id,
            },
        cmd: this._requiresSessionKeyNegotiation() ? 16 : 10,
      })
    }

    return result as boolean
  }

  private _change(data: DPSState): void {
    if (!isNonEmptyPlainObject(data)) return

    const firstState = !isNonEmptyPlainObject(this.state)
    const changes: DPSState = {}
    Object.keys(data).forEach((key) => {
      if (data[key] !== this.state[key]) {
        changes[key] = data[key]
      }
    })

    if (isNonEmptyPlainObject(changes)) {
      this.state = { ...this.state, ...data }
      if (firstState) {
        this.log.info(
          `${this.context.name} (${this.context.version}) reported initial state: ${this._formatStateForLog(this.state)}`,
        )
      } else if (!firstState) {
        this.log.info(
          `${this.context.name} (${this.context.version}) state changed: ${this._formatStateForLog(changes)}`,
        )
      }
      this.emit('change', changes, this.state)
      if (firstState) this._schedulePoll()
    }
  }

  private _schedulePoll(): void {
    this._clearPoller()

    const interval = this._getPollingInterval()
    if (!interval || !this.connected || this.context.fake) return

    this._poller = setTimeout(() => {
      this._poller = null
      if (!this.connected) return

      this.log.debug(`${this.context.name} (${this.context.version}) polling current state.`)
      this.update()
      this._schedulePoll()
    }, interval * 1000)
  }

  private _clearPoller(): void {
    if (!this._poller) return
    clearTimeout(this._poller)
    this._poller = null
  }

  private _getPollingInterval(): number {
    const configured = Number(this.context.pollingInterval)
    if (Number.isFinite(configured) && configured >= 0) return configured
    return 5
  }

  private _isEmptyPayload(payload: unknown): boolean {
    return (
      payload === undefined || payload === null || payload === '' || (Buffer.isBuffer(payload) && payload.length === 0)
    )
  }

  private _requestProtocol35CommonDps(reason: string): void {
    if (!this.connected || !this._isProtocol35() || isNonEmptyPlainObject(this.state)) return

    this._protocol35DpsRefreshCount += 1
    this.log.info(
      `${this.context.name} (${this.context.version}) has not reported state yet; requesting common bulb state (${reason}, attempt ${this._protocol35DpsRefreshCount}).`,
    )

    this._send({ cmd: 18, data: { dpId: PROTOCOL_35_COMMON_DPS } })
  }

  private _logProtocol35NoDps(): void {
    if (
      !this.connected ||
      !this._isProtocol35() ||
      isNonEmptyPlainObject(this.state) ||
      this._protocol35EmptyStateLogged
    ) {
      return
    }

    this._protocol35EmptyStateLogged = true
    this.log.warn(
      `${this.context.name} (${this.context.version}) still has not reported state after startup. ${this._diagnosticSummary()}`,
    )
  }

  private _markDisconnected(reason: Error): void {
    const wasConnected = this.connected
    this.connected = false
    this.session_key = null
    this._clearPoller()
    if (wasConnected) this.emit('disconnect', reason)
  }

  private _formatStateForLog(state: DPSState): string {
    return Object.keys(state)
      .sort((a, b) => Number(a) - Number(b))
      .map((key) => `${this._stateLabel(key)}: ${this._formatStateValue(key, state[key])}`)
      .join(', ')
  }

  private _stateLabel(key: string): string {
    return this._stateLabels()[key] || 'State'
  }

  private _stateLabels(): Record<string, string> {
    const labels: Record<string, string> = {}
    const type = (this.context.type || '').toLowerCase()
    const protocol35 = this._isProtocol35()
    const add = (key: unknown, label: string) => {
      if (key === undefined || key === null || key === false || key === '') return
      labels[String(key)] = label
    }

    if (type === 'outlet') {
      add('1', 'Power')
      add('9', 'Countdown')
      add('38', 'Power-on behavior')
      add('40', 'Relay mode')
      add('41', 'Child lock')
      add('42', 'Cycle timer')
      add('43', 'Random timer')
      add('44', 'Inching')
    }

    if (type === 'rgbtwoutlet') {
      add('1', 'Light power')
      add('2', 'Mode')
      add('3', 'Brightness')
      add('4', 'Color temperature')
      add('5', 'Color')
      add('101', 'Outlet power')
    }

    if (['simplelight', 'twlight', 'rgbtwlight', 'simpledimmer', 'simpledimmer2'].includes(type)) {
      if (protocol35 || this.context.dpPower === 20) {
        add('20', 'Power')
        add('21', 'Mode')
        add('22', 'Brightness')
        add('23', 'Color temperature')
        add('24', 'Color')
        add('25', 'Scene')
        add('26', 'Countdown')
        add('34', 'Do not disturb')
      } else {
        add('1', 'Power')
        add('2', type === 'rgbtwlight' ? 'Mode' : 'Brightness')
        add('3', type === 'rgbtwlight' ? 'Brightness' : 'Color temperature')
        add('4', 'Color temperature')
        add('5', 'Color')
        add('6', 'Scene')
        add('7', 'Countdown')
      }
    }

    if (type === 'universalremotedoor') {
      add('201', 'RF learning')
      add('202', 'RF command')
    }

    add(this.context.dpPower, type === 'rgbtwoutlet' ? 'Outlet power' : 'Power')
    add(this.context.dpLight, 'Light power')
    add(this.context.dpMode, 'Mode')
    add(this.context.dpBrightness, 'Brightness')
    add(this.context.dpColorTemperature, 'Color temperature')
    add(this.context.dpColor, 'Color')
    add(this.context.voltsId, 'Voltage')
    add(this.context.ampsId, 'Current')
    add(this.context.wattsId, 'Power usage')

    return labels
  }

  private _formatStateValue(key: string, value: DPSValue): string {
    const label = this._stateLabel(key)

    if (typeof value === 'boolean') return value ? 'on' : 'off'
    if (value === undefined || value === null || value === '') return 'empty'

    if (label === 'Mode') return this._formatModeValue(value)
    if (label === 'Power-on behavior') return this._formatPowerOnBehavior(value)
    if (label === 'Brightness') return this._formatScaledPercent(value, this._brightnessScale())
    if (label === 'Color temperature') return this._formatScaledPercent(value, this._whiteColorScale())
    if (label === 'Color') return this._formatColorValue(value)
    if (label === 'Scene') return 'custom scene'
    if (label === 'Countdown') return `${Number(value) || 0} seconds`
    if (label === 'Voltage') return this._formatDividedValue(value, this.context.voltsDivisor || 10, 'V')
    if (label === 'Current') return this._formatDividedValue(value, this.context.ampsDivisor || 1000, 'A')
    if (label === 'Power usage') return this._formatDividedValue(value, this.context.wattsDivisor || 10, 'W')

    if (typeof value === 'string') return this._humanizeToken(value)
    return String(value)
  }

  private _formatModeValue(value: DPSValue): string {
    const normalized = String(value).trim().toLowerCase()
    if (normalized === 'colour') return 'color'
    return this._humanizeToken(normalized)
  }

  private _formatPowerOnBehavior(value: DPSValue): string {
    const normalized = String(value).trim().toLowerCase()
    if (normalized === 'memory') return 'restore previous state'
    return this._humanizeToken(normalized)
  }

  private _formatScaledPercent(value: DPSValue, scale: number): string {
    const numeric = Number(value)
    if (!Number.isFinite(numeric) || !scale) return String(value)
    return `${Math.round((numeric / scale) * 100)}%`
  }

  private _formatDividedValue(value: DPSValue, divisor: number, unit: string): string {
    const numeric = Number(value)
    const normalizedDivisor = Number(divisor) || 1
    if (!Number.isFinite(numeric)) return String(value)
    return `${Math.round((numeric / normalizedDivisor) * 100) / 100}${unit}`
  }

  private _formatColorValue(value: DPSValue): string {
    const color = String(value || '')
    if (/^[0-9a-f]{12}$/i.test(color)) {
      const hue = parseInt(color.slice(0, 4), 16)
      const saturation = Math.round((parseInt(color.slice(4, 8), 16) / this._brightnessScale()) * 100)
      const brightness = Math.round((parseInt(color.slice(8, 12), 16) / this._brightnessScale()) * 100)
      return `hue ${hue}, saturation ${saturation}%, brightness ${brightness}%`
    }

    if (/^[0-9a-f]{14}$/i.test(color)) {
      const hue = parseInt(color.slice(6, 10), 16)
      const saturation = Math.round((parseInt(color.slice(10, 12), 16) / 255) * 100)
      const brightness = Math.round((parseInt(color.slice(12, 14), 16) / 255) * 100)
      return `hue ${hue}, saturation ${saturation}%, brightness ${brightness}%`
    }

    return color ? 'set' : 'empty'
  }

  private _brightnessScale(): number {
    const configured = Number(this.context.scaleBrightness)
    if (Number.isFinite(configured) && configured > 0) return configured
    return this._isProtocol35() ? 1000 : 255
  }

  private _whiteColorScale(): number {
    const configured = Number(this.context.scaleWhiteColor)
    if (Number.isFinite(configured) && configured > 0) return configured
    return this._isProtocol35() ? 1000 : 255
  }

  private _humanizeToken(value: string): string {
    return value.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()
  }

  private _send(o: SendPayload): boolean | undefined {
    if (this.context.fake) return
    if (!this.connected) return false

    this._lastSentAt = Date.now()
    this._lastSentCommand = o.cmd

    const version = parseFloat(this.context.version || '3.1')
    if (version < 3.2) return this._send_3_1(o)
    if (version < 3.4) return this._send_3_3(o)
    if (this._isProtocol35()) return this._send_3_5(o)
    return this._send_3_4(o)
  }

  private _send_3_1(o: SendPayload): boolean {
    const { cmd, data } = { ...o }

    let msg = ''

    if (data && typeof data !== 'string' && !(data instanceof Buffer)) {
      switch (cmd) {
        case 7: {
          const cipher = crypto.createCipheriv('aes-128-ecb', this.context.key, '')
          let encrypted = cipher.update(JSON.stringify(data), 'utf8', 'base64')
          encrypted += cipher.final('base64')

          const hash = crypto
            .createHash('md5')
            .update(`data=${encrypted}||lpv=${this.context.version}||${this.context.key}`, 'utf8')
            .digest('hex')
            .substr(8, 16)

          msg = this.context.version + hash + encrypted
          break
        }

        case 10:
          msg = JSON.stringify(data)
          break
      }
    }

    const payload = Buffer.from(msg)
    const prefix = Buffer.from('000055aa00000000000000' + cmd.toString(16).padStart(2, '0'), 'hex')
    const suffix = Buffer.concat([payload, Buffer.from('000000000000aa55', 'hex')])

    const len = Buffer.allocUnsafe(4)
    len.writeInt32BE(suffix.length, 0)

    return this._socket.write(Buffer.concat([prefix, len, suffix]))
  }

  private _send_3_3(o: SendPayload): boolean {
    const { cmd, data } = { ...o }

    if (cmd !== 7 || data) this._sendCounter++

    const hex: string[] = [
      '000055aa',
      this._sendCounter.toString(16).padStart(8, '0'),
      cmd.toString(16).padStart(8, '0'),
      '00000000',
    ]

    if (cmd === 7 && !data) hex.push('00000000')
    else if (cmd !== 9 && cmd !== 10) hex.push('332e33000000000000000000000000')

    if (data && !(data instanceof Buffer)) {
      const cipher = crypto.createCipheriv('aes-128-ecb', this.context.key, '')
      let encrypted = cipher.update(Buffer.from(JSON.stringify(data)), undefined, 'hex')
      encrypted += cipher.final('hex')
      hex.push(encrypted)
    }

    hex.push('00000000')
    hex.push('0000aa55')

    const payload = Buffer.from(hex.join(''), 'hex')
    payload.writeUInt32BE(payload.length - 16, 12)
    payload.writeInt32BE(getCRC32(payload.slice(0, payload.length - 8)), payload.length - 8)

    return this._socket.write(payload)
  }

  private _fakeUpdate(dps: DPSState): void {
    this.log.info('Fake update:', JSON.stringify(dps))
    Object.keys(dps).forEach((dp) => {
      this.state[dp] = dps[dp]
    })
    setTimeout(() => {
      this.emit('change', dps, this.state)
    }, 1000)
  }

  private _send_3_4(o: SendPayload): boolean {
    const { cmd, data: _data } = { ...o }
    let data = _data

    if (!data) {
      data = Buffer.allocUnsafe(0)
    }
    if (!(data instanceof Buffer)) {
      if (typeof data !== 'string') {
        data = JSON.stringify(data)
      }
      data = Buffer.from(data)
    }

    if (cmd !== 10 && cmd !== 9 && cmd !== 16 && cmd !== 3 && cmd !== 5 && cmd !== 18) {
      const buffer = Buffer.alloc((data as Buffer).length + 15)
      Buffer.from('3.4').copy(buffer, 0)
      ;(data as Buffer).copy(buffer, 15)
      data = buffer
    }

    const padding = 0x10 - ((data as Buffer).length & 0xf)
    const buf34 = Buffer.alloc((data as Buffer).length + padding, padding)
    ;(data as Buffer).copy(buf34)
    data = buf34
    const encrypted = encrypt34(data as Buffer, this.session_key ?? this.context.key)

    const encryptedBuffer = Buffer.from(encrypted)
    const buffer = Buffer.alloc(encryptedBuffer.length + 52)
    buffer.writeUInt32BE(0x000055aa, 0)
    buffer.writeUInt32BE(cmd, 8)
    buffer.writeUInt32BE(encryptedBuffer.length + 0x24, 12)

    if ((cmd !== 7 && cmd !== 13) || data) {
      this._sendCounter++
      buffer.writeUInt32BE(this._sendCounter, 4)
    }

    encryptedBuffer.copy(buffer, 16)
    const calculatedCrc = hmac(buffer.slice(0, encryptedBuffer.length + 16), this.session_key ?? this.context.key)
    calculatedCrc.copy(buffer, encryptedBuffer.length + 16)
    buffer.writeUInt32BE(0x0000aa55, encryptedBuffer.length + 48)

    return this._socket.write(buffer)
  }

  private _send_3_5(o: SendPayload): boolean {
    const { cmd, data: _data } = { ...o }
    let data = _data

    if (!data) {
      data = Buffer.allocUnsafe(0)
    }
    if (!(data instanceof Buffer)) {
      if (typeof data !== 'string') {
        data = JSON.stringify(data)
      }
      data = Buffer.from(data)
    }

    if (!NO_PROTOCOL_HEADER_COMMANDS.has(cmd)) {
      data = Buffer.concat([
        Buffer.from(String(this.context.version || '3.5')),
        PROTOCOL_HEADER_PADDING,
        data as Buffer,
      ])
    }

    this._sendCounter++

    const iv = crypto.randomBytes(12)
    const key = this.session_key ?? Buffer.from(this.context.key, 'latin1')
    const header = Buffer.alloc(18)
    header.writeUInt32BE(0x00006699, 0)
    header.writeUInt16BE(0, 4)
    header.writeUInt32BE(this._sendCounter, 6)
    header.writeUInt32BE(cmd, 10)
    header.writeUInt32BE((data as Buffer).length + 28, 14)

    const cipher = crypto.createCipheriv('aes-128-gcm', key, iv)
    cipher.setAAD(header.slice(4))
    const encrypted = Buffer.concat([cipher.update(data as Buffer), cipher.final()])
    const tag = cipher.getAuthTag()

    return this._socket.write(Buffer.concat([header, iv, encrypted, tag, SUFFIX_6699]))
  }

  private _handleNoCurrentStateResponse(): void {
    const message = `${this.context.name} (${this.context.version}) didn't respond with its current state.`
    if ((this.context.type || '').toLowerCase() === 'universalremotedoor') {
      this.log.debug(message)
    } else {
      this.log.info(message)
    }
    this.emit('change', {}, this.state)
    this._schedulePoll()
  }

  private _diagnosticSuffix(): string {
    if (!this._isProtocol35() && isNonEmptyPlainObject(this.state)) return ''
    return ` ${this._diagnosticSummary()}`
  }

  private _diagnosticSummary(): string {
    const hasState = isNonEmptyPlainObject(this.state)
    return [
      `diagnostics: version=${this.context.version}`,
      `type=${this.context.type}`,
      `ip=${this.context.ip}`,
      `session=${this.session_key ? 'yes' : 'no'}`,
      `state=${hasState ? 'reported' : 'not reported'}`,
      `lastTx=${this._lastSentCommand ?? 'none'}${this._lastSentAt ? `/${Math.round((Date.now() - this._lastSentAt) / 1000)}s ago` : ''}`,
      `lastRx=${this._lastReceivedAt ? `${Math.round((Date.now() - this._lastReceivedAt) / 1000)}s ago` : 'none'}`,
    ].join(', ')
  }
}

const encrypt34 = (data: Buffer, encryptKey: string | Buffer): Buffer => {
  const cipher = crypto.createCipheriv('aes-128-ecb', encryptKey, null)
  cipher.setAutoPadding(false)
  const encrypted = cipher.update(data)
  cipher.final()
  return encrypted
}

const encrypt35SessionKey = (data: Buffer, encryptKey: string | Buffer, iv: Buffer): Buffer => {
  const cipher = crypto.createCipheriv('aes-128-gcm', encryptKey, iv)
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()])
  return encrypted
}

const hmac = (data: Buffer, hmacKey: string | Buffer): Buffer => {
  return crypto.createHmac('sha256', hmacKey).update(data).digest()
}

const crc32LookupTable: number[] = []
;(() => {
  for (let i = 0; i < 256; i++) {
    let crc = i
    for (let j = 8; j > 0; j--) crc = crc & 1 ? (crc >>> 1) ^ 3988292384 : crc >>> 1
    crc32LookupTable.push(crc)
  }
})()

const getCRC32 = (buffer: Buffer): number => {
  let crc = 0xffffffff
  for (let i = 0, len = buffer.length; i < len; i++) crc = crc32LookupTable[buffer[i] ^ (crc & 0xff)] ^ (crc >>> 8)
  return ~crc
}

export default TuyaAccessory
