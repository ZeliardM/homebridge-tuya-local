import { EventEmitter } from 'events'

export interface DirigeraContactSensorConfig {
  gatewayIP?: string
  accessToken: string
  deviceId: string
  rejectUnauthorized?: boolean
}

export interface ContactSensorUpdate {
  isOpen: boolean
  batteryPercentage?: number
}

class DirigeraContactSensorClient extends EventEmitter {
  private client: any
  private currentOpen: boolean | undefined

  constructor(
    private readonly config: DirigeraContactSensorConfig,
    private readonly log: any,
  ) {
    super()
  }

  get isOpen(): boolean | undefined {
    return this.currentOpen
  }

  async start(): Promise<void> {
    if (!this.config.accessToken || !this.config.deviceId) {
      throw new Error('DIRIGERA access token and device id are required')
    }

    const { createDirigeraClient } = await import('dirigera')

    this.client = await createDirigeraClient({
      gatewayIP: this.config.gatewayIP,
      accessToken: this.config.accessToken,
      rejectUnauthorized: this.config.rejectUnauthorized ?? false,
    })

    this.log.info(
      'DIRIGERA - Connected to gateway%s for contact sensor %s.',
      this.config.gatewayIP ? ` at ${this.config.gatewayIP}` : '',
      this.config.deviceId,
    )

    const sensor = await this.client.openCloseSensors.get({ id: this.config.deviceId })
    this.applyUpdate({
      isOpen: Boolean(sensor.attributes.isOpen),
      batteryPercentage: sensor.attributes.batteryPercentage,
    })
    this.log.info(
      'DIRIGERA - Contact sensor %s initial state is %s%s.',
      sensor.attributes?.customName || sensor.attributes?.model || this.config.deviceId,
      sensor.attributes?.isOpen ? 'open' : 'closed',
      typeof sensor.attributes?.batteryPercentage === 'number'
        ? ` with ${sensor.attributes.batteryPercentage}% battery`
        : '',
    )

    this.client.startListeningForUpdates((event: any) => {
      if (event?.type !== 'deviceStateChanged') return
      if (event.data?.id !== this.config.deviceId) return
      if (typeof event.data?.attributes?.isOpen !== 'boolean') return

      this.applyUpdate({
        isOpen: event.data.attributes.isOpen,
        batteryPercentage: event.data.attributes.batteryPercentage,
      })
    })
  }

  stop(): void {
    try {
      this.client?.stopListeningForUpdates()
    } catch (ex) {
      this.log.debug('Failed to stop DIRIGERA listener:', ex)
    }
  }

  private applyUpdate(update: ContactSensorUpdate): void {
    this.currentOpen = update.isOpen
    this.emit('change', update)
  }
}

export default DirigeraContactSensorClient
