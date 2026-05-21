import TuyaAccessory from './protocol/TuyaAccessory'
import TuyaDiscovery from './protocol/TuyaDiscovery'

import {
  EnergyCharacteristicsFactory,
  OutletAccessory,
  SimpleLightAccessory,
  MultiOutletAccessory,
  CustomMultiOutletAccessory,
  RGBTWLightAccessory,
  RGBTWOutletAccessory,
  TWLightAccessory,
  AirConditionerAccessory,
  AirPurifierAccessory,
  DehumidifierAccessory,
  ConvectorAccessory,
  GarageDoorAccessory,
  UniversalRemoteDoorAccessory,
  SimpleDimmerAccessory,
  SimpleDimmer2Accessory,
  SimpleBlindsAccessory,
  SimpleHeaterAccessory,
  MappedHeatPumpHeaterAccessory,
  CircuitBreakerMonitorAccessory,
  SimpleFanAccessory,
  SimpleFanLightAccessory,
  SwitchAccessory,
  ValveAccessory,
  OilDiffuserAccessory,
} from './accessories'

import type { ClassDefMap, TuyaDeviceConfig, TuyaPlatformConfig } from './types'

const PLUGIN_NAME = 'homebridge-tuya-local'
const PLATFORM_NAME = 'TuyaLocalPlatform'

const CLASS_DEF: ClassDefMap = {
  outlet: OutletAccessory,
  simplelight: SimpleLightAccessory,
  rgbtwlight: RGBTWLightAccessory,
  rgbtwoutlet: RGBTWOutletAccessory,
  twlight: TWLightAccessory,
  multioutlet: MultiOutletAccessory,
  custommultioutlet: CustomMultiOutletAccessory,
  airconditioner: AirConditionerAccessory,
  airpurifier: AirPurifierAccessory,
  dehumidifier: DehumidifierAccessory,
  convector: ConvectorAccessory,
  garagedoor: GarageDoorAccessory,
  universalremotedoor: UniversalRemoteDoorAccessory,
  simpledimmer: SimpleDimmerAccessory,
  simpledimmer2: SimpleDimmer2Accessory,
  simpleblinds: SimpleBlindsAccessory,
  simpleheater: SimpleHeaterAccessory,
  mappedheatpumpheater: MappedHeatPumpHeaterAccessory,
  circuitbreakermonitor: CircuitBreakerMonitorAccessory,
  switch: SwitchAccessory,
  fan: SimpleFanAccessory,
  fanlight: SimpleFanLightAccessory,
  watervalve: ValveAccessory,
  oildiffuser: OilDiffuserAccessory,
}

let Characteristic: any, PlatformAccessory: any, Service: any, Categories: any, UUID: any

module.exports = function (homebridge: any): void {
  const hap = homebridge.hap || {}

  PlatformAccessory = homebridge.platformAccessory
  Characteristic = hap.Characteristic
  Service = hap.Service
  Categories = hap.Categories || hap.Accessory?.Categories
  UUID = hap.uuid

  homebridge.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, TuyaLocalPlatform, true)
}

class TuyaLocalPlatform {
  log: any
  config: TuyaPlatformConfig
  api: any
  cachedAccessories: Map<string, any>
  _expectedUUIDs?: string[]

  constructor(...props: any[]) {
    ;[this.log, this.config, this.api] = [...props]

    this.cachedAccessories = new Map()
    this.api.hap.EnergyCharacteristics = EnergyCharacteristicsFactory(this.api.hap.Characteristic)

    if (!this.config || !this.config.devices) {
      this.log('No devices found. Check that you have specified them in your config.json file.')
      return
    }

    this._expectedUUIDs = this.config.devices
      .filter((device: TuyaDeviceConfig) => this.hasRequiredDeviceIdentity(device))
      .map((device: TuyaDeviceConfig) =>
        UUID.generate(PLUGIN_NAME + (device.fake ? ':fake:' : ':') + this.trimConfigValue(device.id)),
      )

    this.api.on('didFinishLaunching', () => {
      this.discoverDevices()
    })
  }

  discoverDevices(): void {
    const devices: Record<string, TuyaDeviceConfig & { name: string }> = {}
    const connectedDevices = new Set<string>()
    const fakeDevices: (TuyaDeviceConfig & { name: string })[] = []

    this.config.devices.forEach((device: TuyaDeviceConfig) => {
      this.normalizeDeviceConfig(device)

      if (!device.type)
        return this.log.error("%s (%s) doesn't have a type defined.", device.name || 'Unnamed device', device.id)
      if (!CLASS_DEF[device.type.toLowerCase()])
        return this.log.error("%s (%s) doesn't have a valid type defined.", device.name || 'Unnamed device', device.id)
      if (!device.id)
        return this.log.error("%s doesn't have a Tuya device id defined.", device.name || 'Unnamed device')
      if (!device.fake && !device.key)
        return this.log.error(
          "%s (%s) doesn't have a Tuya local key defined.",
          device.name || 'Unnamed device',
          device.id,
        )
      if (!device.name) device.name = device.id.slice(8) || device.id

      if (device.type.toLowerCase() === 'universalremotedoor' && device.intro === undefined) {
        device.intro = false
      }

      if (device.fake) fakeDevices.push({ name: device.id.slice(8), ...device })
      else devices[device.id] = { name: device.id.slice(8), ...device }
    })

    const deviceIds = Object.keys(devices)
    if (deviceIds.length === 0) return this.log.error('No valid configured devices found.')

    this.log.info('Starting discovery...')

    const connectDevice = (deviceId: string, discoveredConfig: Partial<TuyaDeviceConfig> = {}): void => {
      const configuredDevice = devices[deviceId]
      if (!configuredDevice || connectedDevices.has(deviceId)) return

      connectedDevices.add(deviceId)

      const device = new TuyaAccessory({
        ...configuredDevice,
        ...discoveredConfig,
        id: configuredDevice.id,
        key: configuredDevice.key,
        type: configuredDevice.type,
        name: configuredDevice.name,
        ip: configuredDevice.ip || discoveredConfig.ip,
        version: configuredDevice.version || discoveredConfig.version,
        pollingInterval: this.getDevicePollingInterval(configuredDevice),
        log: this.log,
        UUID: UUID.generate(PLUGIN_NAME + ':' + deviceId),
        connect: false,
      })
      this.addAccessory(device)
    }

    TuyaDiscovery.start({ ids: deviceIds, log: this.log }).on('discover', (config: any) => {
      if (!config || !config.id) return
      if (!devices[config.id]) return
      if (connectedDevices.has(config.id)) return

      this.log.info(
        'Discovered %s (%s) identified as %s (%s)',
        devices[config.id].name,
        config.id,
        devices[config.id].type,
        config.version,
      )

      connectDevice(config.id, config)
    })

    fakeDevices.forEach((config) => {
      this.log.info('Adding fake device: %s', config.name)
      this.addAccessory(
        new TuyaAccessory({
          ...config,
          log: this.log,
          UUID: UUID.generate(PLUGIN_NAME + ':fake:' + config.id),
          connect: false,
        }),
      )
    })

    deviceIds.forEach((deviceId) => {
      if (!devices[deviceId].ip) return

      this.log.info(
        'Connecting to %s (%s) via configured IP %s.',
        devices[deviceId].name,
        deviceId,
        devices[deviceId].ip,
      )
      connectDevice(deviceId)
    })

    setTimeout(() => {
      deviceIds.forEach((deviceId) => {
        if (connectedDevices.has(deviceId)) return

        this.log.warn('Failed to discover %s (%s) in time but will keep looking.', devices[deviceId].name, deviceId)
      })
    }, 60000)
  }

  registerPlatformAccessories(platformAccessories: any | any[]): void {
    this.api.registerPlatformAccessories(
      PLUGIN_NAME,
      PLATFORM_NAME,
      Array.isArray(platformAccessories) ? platformAccessories : [platformAccessories],
    )
  }

  configureAccessory(accessory: any): void {
    if (accessory instanceof PlatformAccessory && this._expectedUUIDs && this._expectedUUIDs.includes(accessory.UUID)) {
      this.cachedAccessories.set(accessory.UUID, accessory)
    } else {
      setTimeout(() => {
        this.removeAccessory(accessory)
      }, 1000)
    }
  }

  addAccessory(device: any): void {
    const deviceConfig = device.context
    const type = (deviceConfig.type || '').toLowerCase()

    const Accessory = CLASS_DEF[type]

    let accessory = this.cachedAccessories.get(deviceConfig.UUID)
    let isCached = true

    if (accessory && accessory.category !== Accessory.getCategory(Categories)) {
      this.log.info(
        '%s has a different type (%s vs %s)',
        accessory.displayName,
        accessory.category,
        Accessory.getCategory(Categories),
      )
      this.removeAccessory(accessory)
      accessory = null
    }

    if (!accessory) {
      accessory = new PlatformAccessory(deviceConfig.name, deviceConfig.UUID, Accessory.getCategory(Categories))
      accessory
        .getService(Service.AccessoryInformation)
        .setCharacteristic(Characteristic.Manufacturer, deviceConfig.manufacturer || 'Unknown')
        .setCharacteristic(Characteristic.Model, deviceConfig.model || 'Unknown')
        .setCharacteristic(Characteristic.SerialNumber, deviceConfig.id.slice(8))

      isCached = false
    }

    if (accessory && accessory.displayName !== deviceConfig.name) {
      this.log.info(
        'Configuration name %s differs from cached displayName %s. Updating cached displayName to %s ',
        deviceConfig.name,
        accessory.displayName,
        deviceConfig.name,
      )
      accessory.displayName = deviceConfig.name
    }

    this.cachedAccessories.set(deviceConfig.UUID, new Accessory(this, accessory, device, !isCached))
  }

  removeAccessory(homebridgeAccessory: any): void {
    if (!homebridgeAccessory) return

    this.log.warn('Unregistering', homebridgeAccessory.displayName)

    this.cachedAccessories.delete(homebridgeAccessory.UUID)
    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [homebridgeAccessory])
  }

  removeAccessoryByUUID(uuid: string): void {
    if (uuid) this.removeAccessory(this.cachedAccessories.get(uuid))
  }

  private normalizeDeviceConfig(device: TuyaDeviceConfig): void {
    device.id = this.trimConfigValue(device.id)
    device.key = this.trimConfigValue(device.key)
    device.type = this.trimConfigValue(device.type)
    device.ip = this.trimConfigValue(device.ip)
    device.name = this.trimConfigValue(device.name)
  }

  private hasRequiredDeviceIdentity(device: TuyaDeviceConfig): boolean {
    return Boolean(this.trimConfigValue(device.id) && this.trimConfigValue(device.type))
  }

  private getDevicePollingInterval(device: TuyaDeviceConfig): number | undefined {
    const deviceInterval = this.parseOptionalNumber(device.pollingInterval)
    if (deviceInterval !== undefined) return deviceInterval

    return this.parseOptionalNumber(this.config.pollingInterval)
  }

  private parseOptionalNumber(value: unknown): number | undefined {
    if (value === undefined || value === null || value === '') return undefined

    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }

  private trimConfigValue(value: unknown): string {
    return value === undefined || value === null ? '' : String(value).trim()
  }
}
