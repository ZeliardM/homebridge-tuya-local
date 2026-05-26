import BaseAccessory from './Base.accessory'
import DirigeraContactSensorClient from '../protocol/DirigeraContactSensor'
import { DP_SEND_IR, buildRfSendButtonCommand } from '../protocol/TuyaRfRemote'
import type { DPSState, DPSValue, HomebridgeCallback } from '../types'

type DoorMode = 'manual' | 'automatic'
type DoorMovement = 'idle' | 'opening' | 'closing' | 'stopped'

const CLOSED_POSITION = 0
const OPEN_POSITION = 100
const DEFAULT_MOVEMENT_TIMEOUT_SECONDS = 30
const LOW_BATTERY_THRESHOLD = 20

class UniversalRemoteDoorAccessory extends BaseAccessory {
  static getCategory(Categories: any): number {
    return Categories.DOOR
  }

  private doorService: any
  private batteryService: any
  private securitySystemService: any
  private characteristicTargetPosition: any
  private characteristicCurrentPosition: any
  private characteristicPositionState: any
  private characteristicBatteryLevel: any
  private characteristicChargingState: any
  private characteristicStatusLowBattery: any
  private characteristicTargetSecuritySystemState: any
  private characteristicCurrentSecuritySystemState: any

  private contactClient?: DirigeraContactSensorClient
  private contactOpen?: boolean
  private batteryPercentage?: number
  private mode: DoorMode = 'manual'
  private movement: DoorMovement = 'idle'
  private targetPosition!: number
  private expectedContactOpen?: boolean
  private movementTimer?: ReturnType<typeof setTimeout> | null

  constructor(...props: any[]) {
    super(...props)
  }

  _registerPlatformAccessory(): void {
    const { Service } = this.hap
    this.accessory.addService(Service.Door, this.device.context.name)
    this.accessory.addService(Service.Battery, `${this.device.context.name} Battery`)
    this.accessory.addService(Service.SecuritySystem, `${this.device.context.name} Mode`)
    super._registerPlatformAccessory()
  }

  _registerCharacteristics(_dps: DPSState): void {
    const { Service, Characteristic } = this.hap

    this.doorService =
      this.accessory.getService(Service.Door) || this.accessory.addService(Service.Door, this.device.context.name)
    this._checkServiceName(this.doorService, this.device.context.name)

    this.batteryService =
      this.accessory.getService(Service.Battery) ||
      this.accessory.addService(Service.Battery, `${this.device.context.name} Battery`)
    this._checkServiceName(this.batteryService, `${this.device.context.name} Battery`)
    this.linkBatteryServiceToDoor()

    const legacyContactSensorService = this.accessory.getService(Service.ContactSensor)
    if (legacyContactSensorService) {
      this.accessory.removeService(legacyContactSensorService)
      this.log.info('[UniversalRemoteDoor] Removed exposed HomeKit contact sensor for %s.', this.device.context.name)
    }

    this.securitySystemService =
      this.accessory.getService(Service.SecuritySystem) ||
      this.accessory.addService(Service.SecuritySystem, `${this.device.context.name} Mode`)
    this._checkServiceName(this.securitySystemService, `${this.device.context.name} Mode`)

    this.mode = this.getStoredMode()
    this.contactOpen = this.getStoredContactOpen()
    this.batteryPercentage = this.getStoredBatteryPercentage()
    this.targetPosition = this.contactOpen === undefined ? CLOSED_POSITION : this.getPositionForContact()

    this.characteristicTargetPosition = this.doorService
      .getCharacteristic(Characteristic.TargetPosition)
      .setProps({ minValue: CLOSED_POSITION, maxValue: OPEN_POSITION, minStep: OPEN_POSITION })
      .updateValue(this.targetPosition)
      .on('get', this.getTargetPosition.bind(this))
      .on('set', this.setTargetPosition.bind(this))

    this.characteristicCurrentPosition = this.doorService
      .getCharacteristic(Characteristic.CurrentPosition)
      .updateValue(
        this.contactOpen === undefined ? this.getContactSensorNotReportedError() : this.getCurrentPositionValue(),
      )
      .on('get', this.getCurrentPosition.bind(this))

    this.characteristicPositionState = this.doorService
      .getCharacteristic(Characteristic.PositionState)
      .updateValue(Characteristic.PositionState.STOPPED)
      .on('get', this.getPositionState.bind(this))

    this.characteristicBatteryLevel = this.batteryService
      .getCharacteristic(Characteristic.BatteryLevel)
      .updateValue(
        this.batteryPercentage === undefined ? this.getBatteryLevelNotReportedError() : this.batteryPercentage,
      )
      .on('get', this.getBatteryLevel.bind(this))

    this.characteristicChargingState = this.batteryService
      .getCharacteristic(Characteristic.ChargingState)
      .updateValue(Characteristic.ChargingState.NOT_CHARGEABLE)
      .on('get', this.getChargingState.bind(this))

    this.characteristicStatusLowBattery = this.batteryService
      .getCharacteristic(Characteristic.StatusLowBattery)
      .updateValue(
        this.batteryPercentage === undefined ? this.getBatteryLevelNotReportedError() : this.getLowBatteryValue(),
      )
      .on('get', this.getStatusLowBattery.bind(this))

    this.characteristicCurrentSecuritySystemState = this.securitySystemService
      .getCharacteristic(Characteristic.SecuritySystemCurrentState)
      .setProps({
        validValues: [
          Characteristic.SecuritySystemCurrentState.STAY_ARM,
          Characteristic.SecuritySystemCurrentState.AWAY_ARM,
        ],
      })
      .updateValue(this.getCurrentSecuritySystemStateValue())
      .on('get', this.getCurrentSecuritySystemState.bind(this))

    this.characteristicTargetSecuritySystemState = this.securitySystemService
      .getCharacteristic(Characteristic.SecuritySystemTargetState)
      .setProps({
        validValues: [
          Characteristic.SecuritySystemTargetState.STAY_ARM,
          Characteristic.SecuritySystemTargetState.AWAY_ARM,
        ],
      })
      .updateValue(this.getTargetSecuritySystemStateValue())
      .on('get', this.getTargetSecuritySystemState.bind(this))
      .on('set', this.setTargetSecuritySystemState.bind(this))

    this.startContactSensor()
  }

  getTargetPosition(callback: HomebridgeCallback): void {
    if (this.contactOpen === undefined) return callback(this.getContactSensorNotReportedError())
    callback(null, this.targetPosition)
  }

  setTargetPosition(value: DPSValue, callback: HomebridgeCallback): void {
    const requestedTarget = Number(value)

    if (!Number.isFinite(requestedTarget)) {
      this.log.warn('[UniversalRemoteDoor] Ignoring unsupported target position:', value)
      return callback(null)
    }

    if (this.contactOpen === undefined) {
      return this.failDoorRequest(
        'Ignoring HomeKit door request because the DIRIGERA contact sensor has not reported yet.',
        callback,
      )
    }

    const desiredOpen = this.contactOpen ? requestedTarget === OPEN_POSITION : requestedTarget !== CLOSED_POSITION
    const desiredTarget = desiredOpen ? OPEN_POSITION : CLOSED_POSITION

    if (this.mode === 'manual') {
      this.log.info(
        '[UniversalRemoteDoor] Ignoring HomeKit door request for %s because security mode is Home/Manual.',
        this.device.context.name,
      )
      this.clearMovementTimeout()
      this.movement = 'idle'
      this.targetPosition = this.getPositionForContact()
      this.syncDoorCharacteristics()
      return callback(null)
    }

    if (this.contactOpen === desiredOpen) {
      this.log.info(
        '[UniversalRemoteDoor] Door is already %s for %s; no RF command needed.',
        desiredOpen ? 'open' : 'closed',
        this.device.context.name,
      )
      this.clearMovementTimeout()
      this.movement = 'idle'
      this.targetPosition = desiredTarget
      this.syncDoorCharacteristics()
      return callback(null)
    }

    const doorToggleCode = this.getDoorToggleCode()
    if (!doorToggleCode) {
      return this.failDoorRequest(
        'Ignoring HomeKit door request because the Door State Toggle RF code has not been learned yet.',
        callback,
      )
    }

    this.targetPosition = desiredTarget
    this.movement = desiredOpen ? 'opening' : 'closing'
    this.syncDoorCharacteristics()

    this.sendRfCode(doorToggleCode, desiredOpen ? 'door open request' : 'door close request', (err) => {
      if (err) {
        return this.failDoorRequest(`Could not send door toggle RF command: ${err.message || err}`, callback)
      }

      this.startMovementTimeout(desiredOpen)
      callback(null)
    })
  }

  getCurrentPosition(callback: HomebridgeCallback): void {
    if (this.contactOpen === undefined) return callback(this.getContactSensorNotReportedError())
    callback(null, this.getCurrentPositionValue())
  }

  getPositionState(callback: HomebridgeCallback): void {
    callback(null, this.getPositionStateValue())
  }

  getBatteryLevel(callback: HomebridgeCallback): void {
    if (this.batteryPercentage === undefined) return callback(this.getBatteryLevelNotReportedError())
    callback(null, this.batteryPercentage)
  }

  getChargingState(callback: HomebridgeCallback): void {
    callback(null, this.hap.Characteristic.ChargingState.NOT_CHARGEABLE)
  }

  getStatusLowBattery(callback: HomebridgeCallback): void {
    if (this.batteryPercentage === undefined) return callback(this.getBatteryLevelNotReportedError())
    callback(null, this.getLowBatteryValue())
  }

  getCurrentSecuritySystemState(callback: HomebridgeCallback): void {
    callback(null, this.getCurrentSecuritySystemStateValue())
  }

  getTargetSecuritySystemState(callback: HomebridgeCallback): void {
    callback(null, this.getTargetSecuritySystemStateValue())
  }

  setTargetSecuritySystemState(value: DPSValue, callback: HomebridgeCallback): void {
    const { Characteristic } = this.hap
    const nextState = Number(value)

    if (
      nextState !== Characteristic.SecuritySystemTargetState.STAY_ARM &&
      nextState !== Characteristic.SecuritySystemTargetState.AWAY_ARM
    ) {
      this.log.warn('[UniversalRemoteDoor] Ignoring unsupported security mode:', value)
      this.syncSecuritySystemCharacteristics()
      return callback(null)
    }

    const nextMode = nextState === Characteristic.SecuritySystemTargetState.AWAY_ARM ? 'automatic' : 'manual'
    if (nextMode === this.mode) {
      this.syncSecuritySystemCharacteristics()
      return callback(null)
    }

    if (nextMode === 'automatic') {
      return this.setAutomaticMode(callback)
    }

    return this.setManualMode(callback)
  }

  private setAutomaticMode(callback: HomebridgeCallback): void {
    if (this.contactOpen === undefined) {
      return this.failModeRequest(
        'Keeping the mode in Home/Manual because the DIRIGERA contact sensor has not reported yet.',
        callback,
      )
    }

    const automaticModeCode = this.getAutomaticModeCode()
    if (!automaticModeCode) {
      return this.failModeRequest(
        'Keeping the mode in Home/Manual because the Automatic Mode RF code has not been learned yet.',
        callback,
      )
    }

    this.sendRfCode(automaticModeCode, 'automatic mode request', (err) => {
      if (err) {
        return this.failModeRequest(`Could not send automatic mode RF command: ${err.message || err}`, callback)
      }

      this.setMode('automatic')
      this.movement = 'idle'
      this.targetPosition = this.getPositionForContact()
      this.syncDoorCharacteristics()
      callback(null)
    })
  }

  private setManualMode(callback: HomebridgeCallback): void {
    const manualModeCode = this.getManualModeCode()
    if (!manualModeCode) {
      return this.failModeRequest(
        'Keeping the mode in Away/Automatic because the Manual Mode RF code has not been learned yet.',
        callback,
      )
    }

    this.sendRfCode(manualModeCode, 'manual mode request', (err) => {
      if (err) {
        return this.failModeRequest(`Could not send manual mode RF command: ${err.message || err}`, callback)
      }

      this.setMode('manual')
      this.movement = 'idle'
      if (this.contactOpen !== undefined) {
        this.targetPosition = this.getPositionForContact()
      }
      this.syncDoorCharacteristics()
      callback(null)
    })
  }

  private startContactSensor(): void {
    const contactSensorConfig = this.getNestedConfig('contactSensor')
    const accessToken = this.getStringConfig('dirigeraAccessToken') || contactSensorConfig.token
    const deviceId = this.getStringConfig('dirigeraDeviceId') || contactSensorConfig.deviceId
    const gatewayIP =
      this.getStringConfig('dirigeraGatewayIP') || contactSensorConfig.gatewayIP || contactSensorConfig.host

    const missing = [
      ['gateway IP', gatewayIP],
      ['access token', accessToken],
      ['contact sensor device id', deviceId],
    ]
      .filter(([, value]) => !value)
      .map(([label]) => label)

    if (missing.length) {
      this.log.warn(
        '[UniversalRemoteDoor] DIRIGERA contact sensor setup is incomplete. Missing: %s.',
        missing.join(', '),
      )
      return
    }

    this.log.info(
      '[UniversalRemoteDoor] Starting DIRIGERA contact sensor for %s (%s).',
      this.device.context.name,
      deviceId,
    )

    this.contactClient = new DirigeraContactSensorClient(
      {
        gatewayIP,
        accessToken,
        deviceId,
        rejectUnauthorized: this.getBooleanConfig('dirigeraRejectUnauthorized', false),
      },
      this.log,
    )

    this.contactClient.on('change', (update) => {
      if (typeof update.isOpen === 'boolean') this.applyContactState(update.isOpen)
      if (typeof update.batteryPercentage === 'number') this.applyBatteryLevel(update.batteryPercentage)
    })

    this.contactClient.start().catch((err) => {
      this.log.warn('[UniversalRemoteDoor] Failed to start DIRIGERA contact sensor:', err.message || err)
    })
  }

  private applyContactState(isOpen: boolean): void {
    const previous = this.contactOpen
    this.contactOpen = isOpen
    this.accessory.context.contactOpen = isOpen

    if ((this.movement === 'opening' && isOpen) || (this.movement === 'closing' && !isOpen)) {
      this.clearMovementTimeout()
      this.movement = 'idle'
      this.targetPosition = this.getPositionForContact()
    } else if (this.movement === 'idle') {
      this.targetPosition = this.getPositionForContact()
    }

    if (previous === undefined) {
      this.log.info(
        '[UniversalRemoteDoor] Door state for %s is %s from the DIRIGERA contact sensor.',
        this.device.context.name,
        isOpen ? 'open' : 'closed',
      )
    } else if (previous !== isOpen) {
      this.log.info(
        '[UniversalRemoteDoor] Door state changed for %s: %s.',
        this.device.context.name,
        isOpen ? 'open' : 'closed',
      )
    } else {
      this.log.debug(
        '[UniversalRemoteDoor] Door state for %s remains %s.',
        this.device.context.name,
        isOpen ? 'open' : 'closed',
      )
    }

    this.syncDoorCharacteristics()
  }

  private applyBatteryLevel(batteryPercentage: number): void {
    if (!Number.isFinite(batteryPercentage)) return

    const previous = this.batteryPercentage
    const next = Math.max(0, Math.min(100, Math.round(batteryPercentage)))

    this.batteryPercentage = next
    this.accessory.context.dirigeraBatteryPercentage = next

    if (previous === undefined) {
      this.log.info(
        '[UniversalRemoteDoor] Battery level for %s is %s%% from the DIRIGERA contact sensor.',
        this.device.context.name,
        next,
      )
    } else if (previous !== next) {
      this.log.info('[UniversalRemoteDoor] Battery level changed for %s: %s%%.', this.device.context.name, next)
    } else {
      this.log.debug('[UniversalRemoteDoor] Battery level for %s remains %s%%.', this.device.context.name, next)
    }

    this.syncBatteryCharacteristics()
  }

  private getCurrentPositionValue(): number {
    return this.getPositionForContact()
  }

  private getPositionForContact(): number {
    return this.contactOpen ? OPEN_POSITION : CLOSED_POSITION
  }

  private getPositionStateValue(): number {
    const { Characteristic } = this.hap

    switch (this.movement) {
      case 'opening':
        return Characteristic.PositionState.INCREASING
      case 'closing':
        return Characteristic.PositionState.DECREASING
      default:
        return Characteristic.PositionState.STOPPED
    }
  }

  private getCurrentSecuritySystemStateValue(): number {
    const { Characteristic } = this.hap
    return this.mode === 'automatic'
      ? Characteristic.SecuritySystemCurrentState.AWAY_ARM
      : Characteristic.SecuritySystemCurrentState.STAY_ARM
  }

  private getTargetSecuritySystemStateValue(): number {
    const { Characteristic } = this.hap
    return this.mode === 'automatic'
      ? Characteristic.SecuritySystemTargetState.AWAY_ARM
      : Characteristic.SecuritySystemTargetState.STAY_ARM
  }

  private syncDoorCharacteristics(): void {
    if (this.contactOpen === undefined) {
      const error = this.getContactSensorNotReportedError()
      this.characteristicCurrentPosition?.updateValue(error)
      return
    }

    const current = this.getCurrentPositionValue()
    if (this.characteristicCurrentPosition?.value !== current) {
      this.characteristicCurrentPosition?.updateValue(current)
    }

    if (this.characteristicTargetPosition?.value !== this.targetPosition) {
      this.characteristicTargetPosition?.updateValue(this.targetPosition)
    }

    const positionState = this.getPositionStateValue()
    if (this.characteristicPositionState?.value !== positionState) {
      this.characteristicPositionState?.updateValue(positionState)
    }
  }

  private syncSecuritySystemCharacteristics(): void {
    const current = this.getCurrentSecuritySystemStateValue()
    if (this.characteristicCurrentSecuritySystemState?.value !== current) {
      this.characteristicCurrentSecuritySystemState?.updateValue(current)
    }

    const target = this.getTargetSecuritySystemStateValue()
    if (this.characteristicTargetSecuritySystemState?.value !== target) {
      this.characteristicTargetSecuritySystemState?.updateValue(target)
    }
  }

  private syncBatteryCharacteristics(): void {
    if (this.batteryPercentage === undefined) {
      const error = this.getBatteryLevelNotReportedError()
      this.characteristicBatteryLevel?.updateValue(error)
      this.characteristicStatusLowBattery?.updateValue(error)
      return
    }

    if (this.characteristicBatteryLevel?.value !== this.batteryPercentage) {
      this.characteristicBatteryLevel?.updateValue(this.batteryPercentage)
    }

    const statusLowBattery = this.getLowBatteryValue()
    if (this.characteristicStatusLowBattery?.value !== statusLowBattery) {
      this.characteristicStatusLowBattery?.updateValue(statusLowBattery)
    }

    const chargingState = this.hap.Characteristic.ChargingState.NOT_CHARGEABLE
    if (this.characteristicChargingState?.value !== chargingState) {
      this.characteristicChargingState?.updateValue(chargingState)
    }
  }

  private setMode(mode: DoorMode): void {
    this.clearMovementTimeout()
    this.mode = mode
    this.accessory.context.doorMode = mode
    this.syncSecuritySystemCharacteristics()
    this.log.info(
      '[UniversalRemoteDoor] Security mode for %s is now %s.',
      this.device.context.name,
      mode === 'automatic' ? 'Away/Automatic' : 'Home/Manual',
    )
  }

  private failDoorRequest(message: string, callback: HomebridgeCallback): void {
    this.log.warn('[UniversalRemoteDoor] %s', message)
    this.clearMovementTimeout()
    this.movement = 'idle'
    if (this.contactOpen !== undefined) {
      this.targetPosition = this.getPositionForContact()
    }
    this.syncDoorCharacteristics()
    callback(null)
  }

  private failModeRequest(message: string, callback: HomebridgeCallback): void {
    this.log.warn('[UniversalRemoteDoor] %s', message)
    this.clearMovementTimeout()
    this.movement = 'idle'
    if (this.contactOpen !== undefined) {
      this.targetPosition = this.getPositionForContact()
    }
    this.syncDoorCharacteristics()
    this.syncSecuritySystemCharacteristics()
    callback(null)
  }

  private sendRfCode(base64Code: string, label: string, callback?: HomebridgeCallback): void {
    this.sendRfCommand(buildRfSendButtonCommand(base64Code), label, callback)
  }

  private sendRfCommand(command: Record<string, unknown>, label: string, callback?: HomebridgeCallback): void {
    if (!this.device.connected) {
      callback?.(new Error('Not connected'))
      return
    }

    this.log.info('[UniversalRemoteDoor] Sending RF command for %s.', label)
    this.log.debug('[UniversalRemoteDoor] Sending RF command for %s: %s', label, JSON.stringify(command))
    const result = this.device.update({ [DP_SEND_IR]: JSON.stringify(command) })
    callback?.(!result ? new Error(`RF command failed for ${label}`) : null)
  }

  private startMovementTimeout(expectedOpen: boolean): void {
    this.clearMovementTimeout()

    const timeoutSeconds = this.getDoorMovementTimeoutSeconds()
    if (!timeoutSeconds) return

    this.expectedContactOpen = expectedOpen
    this.movementTimer = setTimeout(() => {
      this.movementTimer = null

      if (this.expectedContactOpen !== expectedOpen || this.contactOpen === expectedOpen) {
        this.expectedContactOpen = undefined
        return
      }

      this.expectedContactOpen = undefined
      this.movement = 'idle'
      if (this.contactOpen !== undefined) {
        this.targetPosition = this.getPositionForContact()
      }

      this.log.warn(
        '[UniversalRemoteDoor] Door did not report %s within %s seconds for %s; keeping HomeKit state at the DIRIGERA contact sensor state.',
        expectedOpen ? 'open' : 'closed',
        timeoutSeconds,
        this.device.context.name,
      )
      this.syncDoorCharacteristics()
    }, timeoutSeconds * 1000)
    ;(this.movementTimer as any).unref?.()
  }

  private clearMovementTimeout(): void {
    if (this.movementTimer) {
      clearTimeout(this.movementTimer)
      this.movementTimer = null
    }
    this.expectedContactOpen = undefined
  }

  private getStoredMode(): DoorMode {
    return this.accessory.context.doorMode === 'automatic' ? 'automatic' : 'manual'
  }

  private getStoredContactOpen(): boolean | undefined {
    return typeof this.accessory.context.contactOpen === 'boolean' ? this.accessory.context.contactOpen : undefined
  }

  private getStoredBatteryPercentage(): number | undefined {
    const value = Number(this.accessory.context.dirigeraBatteryPercentage)
    if (!Number.isFinite(value)) return undefined
    return Math.max(0, Math.min(100, Math.round(value)))
  }

  private getContactSensorNotReportedError(): Error {
    return new Error('DIRIGERA contact sensor has not reported yet')
  }

  private getBatteryLevelNotReportedError(): Error {
    return new Error('DIRIGERA contact sensor battery level has not reported yet')
  }

  private getLowBatteryValue(): number {
    const { Characteristic } = this.hap
    return this.batteryPercentage !== undefined && this.batteryPercentage <= LOW_BATTERY_THRESHOLD
      ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
      : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL
  }

  private linkBatteryServiceToDoor(): void {
    if (!this.doorService || !this.batteryService || typeof this.doorService.addLinkedService !== 'function') return

    const linkedServices = this.doorService.linkedServices
    if (Array.isArray(linkedServices) && linkedServices.includes(this.batteryService)) return

    this.doorService.addLinkedService(this.batteryService)
  }

  private getDoorToggleCode(): string | undefined {
    return this.getStringConfig('doorToggleCode')
  }

  private getAutomaticModeCode(): string | undefined {
    return this.getStringConfig('automaticModeCode')
  }

  private getManualModeCode(): string | undefined {
    return this.getStringConfig('manualModeCode')
  }

  private getDoorMovementTimeoutSeconds(): number {
    const configured = Number(this.device.context.doorMovementTimeout)
    if (Number.isFinite(configured) && configured >= 0) return configured
    return DEFAULT_MOVEMENT_TIMEOUT_SECONDS
  }

  private getNestedConfig(key: string): Record<string, any> {
    const value = this.device.context[key]
    return value && typeof value === 'object' ? value : {}
  }

  private getStringConfig(key: string): string | undefined {
    const value = this.device.context[key]
    if (value === undefined || value === null) return undefined
    const stringValue = String(value).trim()
    return stringValue ? stringValue : undefined
  }

  private getBooleanConfig(key: string, defaultValue: boolean): boolean {
    const value = this.device.context[key]
    if (typeof value === 'boolean') return value
    if (typeof value === 'number') return value !== 0
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase()
      if (['true', '1', 'yes', 'on'].includes(normalized)) return true
      if (['false', '0', 'no', 'off'].includes(normalized)) return false
    }
    return defaultValue
  }
}

export default UniversalRemoteDoorAccessory
