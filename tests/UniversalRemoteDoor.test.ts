import { afterEach, describe, expect, it, vi } from 'vitest'
import UniversalRemoteDoorAccessory from '../src/accessories/UniversalRemoteDoor.accessory'
import { DP_SEND_IR } from '../src/protocol/TuyaRfRemote'
import {
  createMockCategories,
  createMockCharacteristic,
  createMockLogger,
  createMockPlatformAccessory,
  createMockService,
  createMockTuyaDevice,
} from './helpers'

const DOOR_TOGGLE_CODE = Buffer.from(JSON.stringify({ ver: '2', name: 'door' })).toString('base64')
const AUTOMATIC_MODE_CODE = Buffer.from(JSON.stringify({ ver: '2', name: 'automatic' })).toString('base64')
const MANUAL_MODE_CODE = Buffer.from(JSON.stringify({ ver: '2', name: 'manual' })).toString('base64')

function createDoorAccessory(
  accessoryContext: Record<string, unknown> = {},
  deviceContext: Record<string, unknown> = {},
) {
  const log = createMockLogger()
  const device = createMockTuyaDevice({
    name: 'Test Door',
    type: 'UniversalRemoteDoor',
    doorToggleCode: DOOR_TOGGLE_CODE,
    automaticModeCode: AUTOMATIC_MODE_CODE,
    manualModeCode: MANUAL_MODE_CODE,
    ...deviceContext,
  } as any)
  device.connected = true

  const accessory = createMockPlatformAccessory({
    name: 'Test Door',
    ...accessoryContext,
  })
  const hap = {
    Characteristic: createMockCharacteristic(),
    Service: createMockService(),
    Categories: createMockCategories(),
  }
  const platform = {
    log,
    api: { hap },
    registerPlatformAccessories: vi.fn(),
  }

  const door = new UniversalRemoteDoorAccessory(platform, accessory, device, false) as any
  door._registerCharacteristics({})

  return { accessory, device, door, hap, log }
}

function getSentRfCode(device: any): string {
  const update = device.update.mock.calls.at(-1)?.[0]
  expect(update).toHaveProperty(DP_SEND_IR)
  return JSON.parse(update[DP_SEND_IR]).key1.code
}

describe('UniversalRemoteDoorAccessory', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('uses the cached DIRIGERA contact state while loading', () => {
    const { accessory, door, hap } = createDoorAccessory({ contactOpen: true })

    expect(door.contactOpen).toBe(true)
    expect(door.targetPosition).toBe(100)
    expect(door.characteristicCurrentPosition.value).toBe(100)
    expect(accessory.getService(hap.Service.ContactSensor)).toBeUndefined()
  })

  it('removes an exposed HomeKit contact sensor from cached door accessories', () => {
    const log = createMockLogger()
    const device = createMockTuyaDevice({
      name: 'Test Door',
      type: 'UniversalRemoteDoor',
      doorToggleCode: DOOR_TOGGLE_CODE,
      automaticModeCode: AUTOMATIC_MODE_CODE,
      manualModeCode: MANUAL_MODE_CODE,
    } as any)
    const accessory = createMockPlatformAccessory({ name: 'Test Door' })
    const hap = {
      Characteristic: createMockCharacteristic(),
      Service: createMockService(),
      Categories: createMockCategories(),
    }
    const legacyContactSensor = accessory.addService(hap.Service.ContactSensor, 'Test Door Contact')
    const platform = {
      log,
      api: { hap },
      registerPlatformAccessories: vi.fn(),
    }

    const door = new UniversalRemoteDoorAccessory(platform, accessory, device, false) as any
    door._registerCharacteristics({})

    expect(accessory.removeService).toHaveBeenCalledWith(legacyContactSensor)
    expect(accessory.getService(hap.Service.ContactSensor)).toBeUndefined()
  })

  it('stores DIRIGERA contact state updates for the next accessory load', () => {
    const { accessory, door, log } = createDoorAccessory()

    door.applyContactState(true)

    expect(accessory.context.contactOpen).toBe(true)
    expect(log.info).toHaveBeenCalledWith(
      '[UniversalRemoteDoor] Door state for %s is %s from the DIRIGERA contact sensor.',
      'Test Door',
      'open',
    )
  })

  it('ignores HomeKit door target requests while in Home/Manual mode', () => {
    const { device, door, hap } = createDoorAccessory({ doorMode: 'manual' })
    door.applyContactState(false)

    const callback = vi.fn()
    door.setTargetPosition(100, callback)

    expect(device.update).not.toHaveBeenCalled()
    expect(callback).toHaveBeenCalledWith(null)
  })

  it('sends the door toggle RF code for door target requests in Away/Automatic mode', () => {
    const { device, door, log } = createDoorAccessory({ doorMode: 'automatic' })
    door.applyContactState(false)

    const callback = vi.fn()
    door.setTargetPosition(100, callback)

    expect(getSentRfCode(device)).toBe(DOOR_TOGGLE_CODE)
    expect(callback).toHaveBeenCalledWith(null)
    expect(log.info).toHaveBeenCalledWith('[UniversalRemoteDoor] Sending RF command for %s.', 'door open request')
  })

  it('treats any non-zero slider value as open when the contact sensor says closed', () => {
    const { device, door, hap } = createDoorAccessory({ doorMode: 'automatic' })
    door.applyContactState(false)

    const callback = vi.fn()
    door.setTargetPosition(1, callback)

    expect(getSentRfCode(device)).toBe(DOOR_TOGGLE_CODE)
    expect(door.movement).toBe('opening')
    expect(door.targetPosition).toBe(100)
    expect(door.characteristicCurrentPosition.value).toBe(0)
    expect(door.characteristicTargetPosition.value).toBe(100)
    expect(door.characteristicPositionState.value).toBe(hap.Characteristic.PositionState.INCREASING)
    expect(callback).toHaveBeenCalledWith(null)

    door.applyContactState(true)

    expect(door.movement).toBe('idle')
    expect(door.characteristicCurrentPosition.value).toBe(100)
    expect(door.characteristicTargetPosition.value).toBe(100)
    expect(door.characteristicPositionState.value).toBe(hap.Characteristic.PositionState.STOPPED)
  })

  it('resets an unconfirmed opening request back to the contact sensor state after timeout', () => {
    vi.useFakeTimers()
    const { device, door, hap, log } = createDoorAccessory({ doorMode: 'automatic' }, { doorMovementTimeout: 1 })
    door.applyContactState(false)

    const callback = vi.fn()
    door.setTargetPosition(100, callback)

    expect(getSentRfCode(device)).toBe(DOOR_TOGGLE_CODE)
    expect(door.movement).toBe('opening')
    expect(door.targetPosition).toBe(100)
    expect(door.characteristicPositionState.value).toBe(hap.Characteristic.PositionState.INCREASING)

    vi.advanceTimersByTime(1000)

    expect(door.movement).toBe('idle')
    expect(door.targetPosition).toBe(0)
    expect(door.characteristicCurrentPosition.value).toBe(0)
    expect(door.characteristicTargetPosition.value).toBe(0)
    expect(door.characteristicPositionState.value).toBe(hap.Characteristic.PositionState.STOPPED)
    expect(log.warn).toHaveBeenCalledWith(
      '[UniversalRemoteDoor] Door did not report %s within %s seconds for %s; keeping HomeKit state at the DIRIGERA contact sensor state.',
      'open',
      1,
      'Test Door',
    )
  })

  it('treats any less-than-full slider value as closed when the contact sensor says open', () => {
    const { device, door, hap } = createDoorAccessory({ doorMode: 'automatic' })
    door.applyContactState(true)

    const callback = vi.fn()
    door.setTargetPosition(99, callback)

    expect(getSentRfCode(device)).toBe(DOOR_TOGGLE_CODE)
    expect(door.movement).toBe('closing')
    expect(door.targetPosition).toBe(0)
    expect(door.characteristicCurrentPosition.value).toBe(100)
    expect(door.characteristicTargetPosition.value).toBe(0)
    expect(door.characteristicPositionState.value).toBe(hap.Characteristic.PositionState.DECREASING)
    expect(callback).toHaveBeenCalledWith(null)

    door.applyContactState(false)

    expect(door.movement).toBe('idle')
    expect(door.characteristicCurrentPosition.value).toBe(0)
    expect(door.characteristicTargetPosition.value).toBe(0)
    expect(door.characteristicPositionState.value).toBe(hap.Characteristic.PositionState.STOPPED)
  })

  it('resets an unconfirmed closing request back to the contact sensor state after timeout', () => {
    vi.useFakeTimers()
    const { device, door, hap, log } = createDoorAccessory({ doorMode: 'automatic' }, { doorMovementTimeout: 1 })
    door.applyContactState(true)

    const callback = vi.fn()
    door.setTargetPosition(0, callback)

    expect(getSentRfCode(device)).toBe(DOOR_TOGGLE_CODE)
    expect(door.movement).toBe('closing')
    expect(door.targetPosition).toBe(0)
    expect(door.characteristicPositionState.value).toBe(hap.Characteristic.PositionState.DECREASING)

    vi.advanceTimersByTime(1000)

    expect(door.movement).toBe('idle')
    expect(door.targetPosition).toBe(100)
    expect(door.characteristicCurrentPosition.value).toBe(100)
    expect(door.characteristicTargetPosition.value).toBe(100)
    expect(door.characteristicPositionState.value).toBe(hap.Characteristic.PositionState.STOPPED)
    expect(log.warn).toHaveBeenCalledWith(
      '[UniversalRemoteDoor] Door did not report %s within %s seconds for %s; keeping HomeKit state at the DIRIGERA contact sensor state.',
      'closed',
      1,
      'Test Door',
    )
  })

  it('sends the automatic mode RF code when Security System target changes to Away', () => {
    const { accessory, device, door, hap, log } = createDoorAccessory({ doorMode: 'manual' })
    door.applyContactState(false)

    const callback = vi.fn()
    door.setTargetSecuritySystemState(hap.Characteristic.SecuritySystemTargetState.AWAY_ARM, callback)

    expect(getSentRfCode(device)).toBe(AUTOMATIC_MODE_CODE)
    expect(accessory.context.doorMode).toBe('automatic')
    expect(door.movement).toBe('idle')
    expect(door.targetPosition).toBe(0)
    expect(door.characteristicCurrentPosition.value).toBe(0)
    expect(door.characteristicTargetPosition.value).toBe(0)
    expect(door.characteristicPositionState.value).toBe(hap.Characteristic.PositionState.STOPPED)
    expect(callback).toHaveBeenCalledWith(null)
    expect(log.info).toHaveBeenCalledWith(
      '[UniversalRemoteDoor] Security mode for %s is now %s.',
      'Test Door',
      'Away/Automatic',
    )
  })

  it('keeps the Door service contact-driven after switching to Away', () => {
    const { device, door, hap } = createDoorAccessory({ doorMode: 'manual' })
    door.applyContactState(false)

    const callback = vi.fn()
    door.setTargetSecuritySystemState(hap.Characteristic.SecuritySystemTargetState.AWAY_ARM, callback)
    door.applyContactState(true)

    expect(getSentRfCode(device)).toBe(AUTOMATIC_MODE_CODE)
    expect(door.movement).toBe('idle')
    expect(door.targetPosition).toBe(100)
    expect(door.characteristicCurrentPosition.value).toBe(100)
    expect(door.characteristicTargetPosition.value).toBe(100)
    expect(door.characteristicPositionState.value).toBe(hap.Characteristic.PositionState.STOPPED)
  })

  it('does not send door toggle RF commands for contact sensor updates in Away mode', () => {
    const { device, door, hap } = createDoorAccessory({ doorMode: 'manual' })
    door.applyContactState(false)

    door.setTargetSecuritySystemState(hap.Characteristic.SecuritySystemTargetState.AWAY_ARM, vi.fn())
    device.update.mockClear()

    door.applyContactState(true)
    door.applyContactState(false)

    expect(device.update).not.toHaveBeenCalled()
    expect(door.targetPosition).toBe(0)
    expect(door.characteristicCurrentPosition.value).toBe(0)
    expect(door.characteristicTargetPosition.value).toBe(0)
  })

  it('keeps Home mode responsive when the automatic RF code has not been learned yet', () => {
    const { accessory, device, door, hap } = createDoorAccessory({ doorMode: 'manual' }, { automaticModeCode: '' })
    door.applyContactState(false)

    const callback = vi.fn()
    door.setTargetSecuritySystemState(hap.Characteristic.SecuritySystemTargetState.AWAY_ARM, callback)

    expect(device.update).not.toHaveBeenCalled()
    expect(accessory.context.doorMode).toBe('manual')
    expect(callback).toHaveBeenCalledWith(null)
  })

  it('sends the manual mode RF code when Security System target changes to Home', () => {
    const { accessory, device, door, hap, log } = createDoorAccessory({ doorMode: 'automatic' })
    door.applyContactState(true)

    const callback = vi.fn()
    door.setTargetSecuritySystemState(hap.Characteristic.SecuritySystemTargetState.STAY_ARM, callback)

    expect(getSentRfCode(device)).toBe(MANUAL_MODE_CODE)
    expect(accessory.context.doorMode).toBe('manual')
    expect(callback).toHaveBeenCalledWith(null)
    expect(log.info).toHaveBeenCalledWith(
      '[UniversalRemoteDoor] Security mode for %s is now %s.',
      'Test Door',
      'Home/Manual',
    )
  })

  it('keeps Away mode responsive when the manual RF code has not been learned yet', () => {
    const { accessory, device, door, hap } = createDoorAccessory({ doorMode: 'automatic' }, { manualModeCode: '' })
    door.applyContactState(true)

    const callback = vi.fn()
    door.setTargetSecuritySystemState(hap.Characteristic.SecuritySystemTargetState.STAY_ARM, callback)

    expect(device.update).not.toHaveBeenCalled()
    expect(accessory.context.doorMode).toBe('automatic')
    expect(callback).toHaveBeenCalledWith(null)
  })
})
