const path = require('path')

const RF_COMMANDS = {
  doorToggleCode: 'Door State Toggle',
  automaticModeCode: 'Automatic Mode',
  manualModeCode: 'Manual Mode',
}

let RequestErrorClass

class ConsoleLogger {
  info(...args) {
    console.log(...args)
  }

  warn(...args) {
    console.warn(...args)
  }

  error(...args) {
    console.error(...args)
  }

  debug(...args) {
    if (process.env.DEBUG) console.debug(...args)
  }
}

function requestError(message, status = 400) {
  if (RequestErrorClass) return new RequestErrorClass(message, { status })

  const err = new Error(message)
  err.requestError = { status }
  return err
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function requireBuiltModule(modulePath) {
  try {
    return require(path.join(__dirname, '..', 'dist', ...modulePath))
  } catch (err) {
    throw requestError(`Could not load ${modulePath.join('/')}. Run npm run build before using this setup action.`, 500)
  }
}

function getRfHelpers() {
  return requireBuiltModule(['protocol', 'TuyaRfRemote.js'])
}

function getTuyaAccessoryClass() {
  const module = requireBuiltModule(['protocol', 'TuyaAccessory.js'])
  return module.default || module
}

function getRequiredString(device, field, label) {
  const value = String(device?.[field] || '').trim()
  if (!value) throw requestError(`${label} is required.`)
  return value
}

function buildTuyaContext(device) {
  return {
    ...device,
    type: 'UniversalRemoteDoor',
    name: String(device?.name || 'Universal Remote Door').trim(),
    id: getRequiredString(device, 'id', 'Tuya ID'),
    key: getRequiredString(device, 'key', 'Tuya Key'),
    ip: getRequiredString(device, 'ip', 'Tuya IP address'),
    version: String(device?.version || '3.3').trim(),
    port: Number(device?.port) || 6668,
    connectTimeout: Number(device?.connectTimeout) || 10,
    intro: false,
  }
}

function clearSocketTimer(socket, key) {
  if (socket?.[key]) {
    clearTimeout(socket[key])
    socket[key] = null
  }
}

function closeTuyaDevice(device) {
  const socket = device?._socket
  clearSocketTimer(socket, '_pinger')
  clearSocketTimer(socket, '_connTimeout')
  clearSocketTimer(socket, '_errorReconnect')

  try {
    socket?.destroy()
  } catch (_err) {
    // Nothing useful to do during shutdown.
  }

  device?.removeAllListeners?.()
}

function connectTuyaDevice(deviceConfig) {
  const TuyaAccessory = getTuyaAccessoryClass()
  const context = buildTuyaContext(deviceConfig)
  console.log(
    `[UniversalRemoteDoor UI] Connecting to ${context.name} (${context.id}) at ${context.ip} with Tuya protocol ${context.version}.`,
  )
  const device = new TuyaAccessory({
    ...context,
    log: new ConsoleLogger(),
    connect: false,
  })

  return new Promise((resolve, reject) => {
    let settled = false
    const timeout = setTimeout(() => {
      finish(new Error('Timed out while connecting to the Tuya universal remote.'))
    }, device.context.connectTimeout * 1000)

    const finish = (err) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      device.removeListener('connect', onConnect)
      device._socket?.removeListener('error', onError)

      if (err) {
        closeTuyaDevice(device)
        reject(err)
      } else {
        resolve(device)
      }
    }

    const onConnect = () => {
      console.log(`[UniversalRemoteDoor UI] Connected to ${context.name}.`)
      finish()
    }
    const onError = (err) => finish(err)

    device.once('connect', onConnect)

    try {
      device._connect()
      device._socket?.once('error', onError)
    } catch (err) {
      finish(err)
    }
  })
}

function sendRfCommand(device, command, label) {
  const { DP_SEND_IR } = getRfHelpers()
  console.log(`[UniversalRemoteDoor UI] Sending RF command: ${label}.`)
  const success = device.update({ [DP_SEND_IR]: JSON.stringify(command) })
  if (!success) throw requestError(`Failed to send ${label}.`, 500)
}

function waitForLearnedRfCode(device, timeoutSeconds) {
  const { DP_LEARNED_ID, DP_LEARNED_REPORT } = getRfHelpers()
  console.log(`[UniversalRemoteDoor UI] Waiting up to ${timeoutSeconds} seconds for learned RF code.`)

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      console.warn('[UniversalRemoteDoor UI] RF learning timed out before a learned code was reported.')
      reject(new Error('RF learning timed out before a code was received.'))
    }, timeoutSeconds * 1000)

    const cleanup = () => {
      clearTimeout(timeout)
      device.removeListener('change', onChange)
    }

    const onChange = (changes) => {
      const learnedCode = changes?.[DP_LEARNED_ID] || changes?.[DP_LEARNED_REPORT]
      if (!learnedCode) return

      cleanup()
      console.log(`[UniversalRemoteDoor UI] Learned RF code received (${String(learnedCode).length} characters).`)
      resolve(String(learnedCode))
    }

    device.on('change', onChange)
  })
}

async function createDirigeraClient(payload) {
  const gatewayIP = getRequiredString(payload, 'gatewayIP', 'DIRIGERA gateway IP')
  const { createDirigeraClient } = await import('dirigera')

  return createDirigeraClient({
    gatewayIP,
    accessToken: payload?.accessToken,
    rejectUnauthorized: false,
  })
}

;(async () => {
  const { HomebridgePluginUiServer, RequestError } = await import('@homebridge/plugin-ui-utils')
  RequestErrorClass = RequestError

  class UniversalRemoteDoorUiServer extends HomebridgePluginUiServer {
    constructor() {
      super()

      this.onRequest('/learn-rf', this.learnRf.bind(this))
      this.onRequest('/send-rf', this.sendRf.bind(this))
      this.onRequest('/dirigera-authenticate', this.authenticateDirigera.bind(this))
      this.onRequest('/dirigera-open-close-sensors', this.listDirigeraOpenCloseSensors.bind(this))

      this.ready()
    }

    async learnRf(payload) {
      const codeKey = String(payload?.codeKey || '')
      const label = RF_COMMANDS[codeKey]
      if (!label) throw requestError('Choose one of the three supported RF commands.')

      const { buildRfStudyCommand, buildRfStudyExitCommand } = getRfHelpers()
      const timeoutSeconds = Math.max(5, Math.min(Number(payload?.timeoutSeconds) || 30, 120))
      console.log(`[UniversalRemoteDoor UI] Starting RF learning for ${label}.`)
      const device = await connectTuyaDevice(payload?.device)

      try {
        sendRfCommand(device, buildRfStudyExitCommand(), 'exit RF learning')
        await delay(500)

        const learnedCodePromise = waitForLearnedRfCode(device, timeoutSeconds)
        sendRfCommand(device, buildRfStudyCommand(), `learn ${label}`)
        console.log(`[UniversalRemoteDoor UI] RF learning mode is active for ${label}.`)

        let code
        try {
          code = await learnedCodePromise
        } catch (err) {
          try {
            sendRfCommand(device, buildRfStudyExitCommand(), 'cancel RF learning')
          } catch (exitErr) {
            console.warn(
              'RF learning timed out, and exiting RF learning reported an error:',
              exitErr.message || exitErr,
            )
          }
          throw err
        }

        try {
          sendRfCommand(device, buildRfStudyExitCommand(), 'finish RF learning')
        } catch (err) {
          console.warn('RF code was learned, but exiting RF learning reported an error:', err.message || err)
        }

        console.log(`[UniversalRemoteDoor UI] Finished RF learning for ${label}.`)
        return { codeKey, code, label }
      } finally {
        closeTuyaDevice(device)
      }
    }

    async sendRf(payload) {
      const code = String(payload?.code || '').trim()
      if (!code) throw requestError('A learned RF code is required before testing.')

      const { buildRfSendButtonCommand } = getRfHelpers()
      const device = await connectTuyaDevice(payload?.device)

      try {
        sendRfCommand(device, buildRfSendButtonCommand(code), 'test RF command')
        return { ok: true }
      } finally {
        closeTuyaDevice(device)
      }
    }

    async authenticateDirigera(payload) {
      const client = await createDirigeraClient(payload)
      const accessToken = await client.authenticate({ verbose: false })

      return { accessToken }
    }

    async listDirigeraOpenCloseSensors(payload) {
      const accessToken = getRequiredString(payload, 'accessToken', 'DIRIGERA access token')
      const client = await createDirigeraClient({ ...payload, accessToken })
      const sensors = await client.openCloseSensors.list()

      return sensors.map((sensor) => ({
        id: sensor.id,
        name: sensor.attributes?.customName || sensor.attributes?.model || sensor.id,
        model: sensor.attributes?.model || '',
        manufacturer: sensor.attributes?.manufacturer || '',
        batteryPercentage: sensor.attributes?.batteryPercentage,
        isOpen: sensor.attributes?.isOpen,
        isReachable: Boolean(sensor.isReachable),
        roomName: sensor.room?.name || '',
      }))
    }
  }

  return new UniversalRemoteDoorUiServer()
})().catch((err) => {
  console.error(err)
  process.exit(1)
})
