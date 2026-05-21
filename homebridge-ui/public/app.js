;(function () {
  const PLUGIN_NAME = 'homebridge-tuya-local'
  const PLATFORM_NAME = 'TuyaLocalPlatform'
  const QUALIFIED_PLATFORM_NAME = `${PLUGIN_NAME}.${PLATFORM_NAME}`
  const PLATFORM_NAME_ALIASES = new Set([
    PLATFORM_NAME,
    QUALIFIED_PLATFORM_NAME,
    '@nubisco/homebridge-tuya-local.TuyaLocalPlatform',
  ])
  const DEVICE_TYPE = 'UniversalRemoteDoor'
  const REQUIRED_DETAIL_FIELDS = ['name', 'id', 'key', 'ip', 'manufacturer', 'model']
  const STANDARD_REQUIRED_FIELDS = ['type', 'name', 'id', 'key']
  const NUMERIC_CONFIG_FIELDS = new Set([
    'pollingInterval',
    'dpPower',
    'dpBrightness',
    'dpColorTemperature',
    'dpMode',
    'dpColor',
    'dpLight',
    'minWhiteColor',
    'maxWhiteColor',
    'scaleBrightness',
    'scaleWhiteColor',
    'outletCount',
    'voltsId',
    'ampsId',
    'wattsId',
    'voltsDivisor',
    'ampsDivisor',
    'wattsDivisor',
    'doorMovementTimeout',
  ])

  const STANDARD_DEVICE_TYPES = [
    {
      type: 'Outlet',
      label: 'Smart Outlet',
      detail: 'Single on/off outlet, with optional energy data points.',
    },
    {
      type: 'SimpleLight',
      label: 'Simple Bulb',
      detail: 'On/off light bulb.',
    },
    {
      type: 'TWLight',
      label: 'Tunable White Bulb',
      detail: 'Brightness and white temperature control.',
    },
    {
      type: 'RGBTWLight',
      label: 'Color Bulb',
      detail: 'RGB color, tunable white, and brightness control.',
    },
    {
      type: 'MultiOutlet',
      label: 'Power Strip',
      detail: 'Sequential outlet data points, starting at DP 1.',
    },
    {
      type: 'CustomMultiOutlet',
      label: 'Custom Power Strip',
      detail: 'Named outlets with explicit data points.',
    },
    {
      type: 'RGBTWOutlet',
      label: 'Outlet With Light',
      detail: 'One outlet plus a controllable white/color light.',
    },
  ]

  const STANDARD_DEVICE_TYPE_LABELS = STANDARD_DEVICE_TYPES.reduce((labels, item) => {
    labels[item.type] = item.label
    return labels
  }, {})

  const COLOR_FUNCTIONS = [
    { value: '', label: 'Auto / HEXHSB default' },
    { value: 'HEXHSB', label: 'HEXHSB' },
    { value: 'HSB', label: 'HSB' },
  ]

  const TUYA_PROTOCOL_OPTIONS = [
    { value: '', label: 'Default / Auto' },
    { value: '3.1', label: '3.1' },
    { value: '3.3', label: '3.3' },
    { value: '3.4', label: '3.4' },
    { value: '3.5', label: '3.5' },
  ]

  const RF_COMMANDS = [
    {
      key: 'doorToggleCode',
      label: 'Door State Toggle',
      help: 'Sends the open or close command when the door is in Away/Automatic mode.',
    },
    {
      key: 'automaticModeCode',
      label: 'Automatic Mode',
      help: 'Switches the motor to automatic mode. The motor may run its own full cycle.',
    },
    {
      key: 'manualModeCode',
      label: 'Manual Mode',
      help: 'Switches the motor to manual mode without changing the current door position.',
    },
  ]

  const app = document.getElementById('app')
  const hb = window.homebridge
  const state = {
    pluginConfig: [],
    platformConfig: null,
    device: null,
    updateTimer: null,
    modal: null,
    sensors: [],
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  }

  function getFieldValue(field) {
    const value = state.device?.[field]
    return value === undefined || value === null ? '' : String(value)
  }

  function parseConfigFieldValue(field, value, inputType = '') {
    const text = String(value ?? '').trim()
    if (!text) return { hasValue: false }

    if (inputType === 'number' || NUMERIC_CONFIG_FIELDS.has(field)) {
      const numberValue = Number(text)
      if (!Number.isFinite(numberValue)) return { hasValue: false }
      return { hasValue: true, value: numberValue }
    }

    return { hasValue: true, value: text }
  }

  function isFilled(field) {
    return getFieldValue(field).trim().length > 0
  }

  function isDeviceReady() {
    return REQUIRED_DETAIL_FIELDS.every(isFilled)
  }

  function doorConfigComplete(device) {
    return REQUIRED_DETAIL_FIELDS.every((field) => {
      const value = device?.[field]
      return value !== undefined && value !== null && String(value).trim()
    })
  }

  function getMissingDetails() {
    const names = {
      name: 'Name',
      id: 'Tuya ID',
      key: 'Tuya Key',
      ip: 'IP address',
      manufacturer: 'Manufacturer',
      model: 'Model',
    }

    return REQUIRED_DETAIL_FIELDS.filter((field) => !isFilled(field)).map((field) => names[field])
  }

  function truncateMiddle(value, head = 12, tail = 8) {
    const text = String(value || '')
    if (text.length <= head + tail + 3) return text
    return `${text.slice(0, head)}...${text.slice(-tail)}`
  }

  function ensurePlatformConfig(pluginConfig) {
    const blocks = Array.isArray(pluginConfig) ? pluginConfig : []
    let platformConfig = blocks.find((block) => PLATFORM_NAME_ALIASES.has(block.platform))

    if (!platformConfig) {
      platformConfig = blocks.find((block) => Array.isArray(block.devices))
    }

    if (!platformConfig) {
      platformConfig = {
        platform: QUALIFIED_PLATFORM_NAME,
        name: PLATFORM_NAME,
        devices: [],
      }
      blocks.push(platformConfig)
    }

    platformConfig.platform = QUALIFIED_PLATFORM_NAME
    platformConfig.name = platformConfig.name || PLATFORM_NAME
    platformConfig.devices = Array.isArray(platformConfig.devices) ? platformConfig.devices : []
    migratePlatformPollingInterval(platformConfig)

    let device = platformConfig.devices.find((item) => item.type === DEVICE_TYPE)
    if (!device) {
      device = {
        type: DEVICE_TYPE,
        name: '',
        version: '3.3',
        intro: false,
      }
      platformConfig.devices.push(device)
    }

    device.type = DEVICE_TYPE
    device.version = device.version || '3.3'
    device.intro = false
    delete device.useDirigeraContactSensor

    state.pluginConfig = blocks
    state.platformConfig = platformConfig
    state.device = device
  }

  function migratePlatformPollingInterval(platformConfig) {
    if (String(platformConfig.pollingInterval ?? '').trim()) return

    const deviceWithPolling = platformConfig.devices.find((device) => String(device?.pollingInterval ?? '').trim())
    if (deviceWithPolling) platformConfig.pollingInterval = deviceWithPolling.pollingInterval
  }

  function isStandardDeviceType(type) {
    return STANDARD_DEVICE_TYPES.some((item) => item.type === type)
  }

  function getStandardDevices() {
    return state.platformConfig.devices.filter((device) => device !== state.device && isStandardDeviceType(device.type))
  }

  function getUnsupportedDevices() {
    return state.platformConfig.devices.filter(
      (device) => device !== state.device && !isStandardDeviceType(device.type),
    )
  }

  function getDeviceIndex(device) {
    return state.platformConfig.devices.indexOf(device)
  }

  function getStandardFieldValue(device, field) {
    const value = device?.[field]
    return value === undefined || value === null ? '' : String(value)
  }

  function getPlatformFieldValue(field) {
    const value = state.platformConfig?.[field]
    return value === undefined || value === null ? '' : String(value)
  }

  function standardDeviceComplete(device) {
    return STANDARD_REQUIRED_FIELDS.every((field) => getStandardFieldValue(device, field).trim())
  }

  function standardDeviceTitle(device) {
    return getStandardFieldValue(device, 'name').trim() || 'Unnamed Device'
  }

  function standardDeviceTypeLabel(type) {
    return STANDARD_DEVICE_TYPE_LABELS[type] || type || 'Device'
  }

  function getStandardDeviceMeta(type) {
    return STANDARD_DEVICE_TYPES.find((item) => item.type === type) || STANDARD_DEVICE_TYPES[0]
  }

  function defaultProtocolForType(type) {
    return ['SimpleLight', 'TWLight', 'RGBTWLight'].includes(type) ? '3.5' : '3.3'
  }

  function fieldHtml(field, label, options = {}) {
    const required = options.required !== false
    const type = options.type || 'text'
    const value = escapeHtml(getFieldValue(field))
    const note = options.note ? `<div class="field-note">${escapeHtml(options.note)}</div>` : ''
    const autoComplete = type === 'password' ? 'new-password' : 'off'

    return `
      <div class="${options.wide ? 'wide' : ''}">
        <label class="form-label" for="${field}">
          ${escapeHtml(label)}${required ? '<span class="required-mark">*</span>' : ''}
        </label>
        <input
          id="${field}"
          class="form-control"
          data-field="${field}"
          type="${type}"
          value="${value}"
          autocomplete="${autoComplete}"
        />
        ${note}
      </div>
    `
  }

  function selectHtml(field, label, options) {
    const value = getFieldValue(field)
    const note = options.note ? `<div class="field-note">${escapeHtml(options.note)}</div>` : ''

    return `
      <div class="${options.wide ? 'wide' : ''}">
        <label class="form-label" for="${field}">
          ${escapeHtml(label)}${options.required === false ? '' : '<span class="required-mark">*</span>'}
        </label>
        <select id="${field}" class="form-control" data-field="${field}">
          ${options.items
            .map(
              (item) => `
                <option value="${escapeHtml(item.value)}" ${item.value === value ? 'selected' : ''}>
                  ${escapeHtml(item.label)}
                </option>
              `,
            )
            .join('')}
        </select>
        ${note}
      </div>
    `
  }

  function readonlyFieldHtml(label, value, options = {}) {
    const type = options.type || 'text'
    const displayValue = options.displayValue || value

    return `
      <div class="${options.wide ? 'wide' : ''}">
        <label class="form-label">${escapeHtml(label)}</label>
        <input
          class="form-control ${options.secret ? 'secret-value' : ''}"
          type="${type}"
          value="${escapeHtml(displayValue)}"
          readonly
        />
        ${options.note ? `<div class="field-note">${escapeHtml(options.note)}</div>` : ''}
      </div>
    `
  }

  function standardFieldHtml(deviceIndex, device, field, label, options = {}) {
    const required = options.required === true
    const type = options.type || 'text'
    const value = escapeHtml(getStandardFieldValue(device, field))
    const note = options.note ? `<div class="field-note">${escapeHtml(options.note)}</div>` : ''
    const placeholder = options.placeholder ? `placeholder="${escapeHtml(options.placeholder)}"` : ''
    const autoComplete = type === 'password' ? 'new-password' : 'off'

    return `
      <div class="${options.wide ? 'wide' : ''}">
        <label class="form-label" for="device-${deviceIndex}-${field}">
          ${escapeHtml(label)}${required ? '<span class="required-mark">*</span>' : ''}
        </label>
        <input
          id="device-${deviceIndex}-${field}"
          class="form-control"
          data-standard-field="${field}"
          data-device-index="${deviceIndex}"
          type="${type}"
          value="${value}"
          ${placeholder}
          autocomplete="${autoComplete}"
        />
        ${note}
      </div>
    `
  }

  function standardSelectHtml(deviceIndex, device, field, label, options) {
    const value = getStandardFieldValue(device, field)

    return `
      <div class="${options?.wide ? 'wide' : ''}">
        <label class="form-label" for="device-${deviceIndex}-${field}">
          ${escapeHtml(label)}${options?.required ? '<span class="required-mark">*</span>' : ''}
        </label>
        <select id="device-${deviceIndex}-${field}" class="form-control" data-standard-field="${field}" data-device-index="${deviceIndex}">
          ${options.items
            .map(
              (item) => `
                <option value="${escapeHtml(item.value)}" ${item.value === value ? 'selected' : ''}>
                  ${escapeHtml(item.label)}
                </option>
              `,
            )
            .join('')}
        </select>
        ${options?.note ? `<div class="field-note">${escapeHtml(options.note)}</div>` : ''}
      </div>
    `
  }

  function platformFieldHtml(field, label, options = {}) {
    const required = options.required === true
    const type = options.type || 'text'
    const value = escapeHtml(getPlatformFieldValue(field))
    const note = options.note ? `<div class="field-note">${escapeHtml(options.note)}</div>` : ''
    const placeholder = options.placeholder ? `placeholder="${escapeHtml(options.placeholder)}"` : ''

    return `
      <div class="${options.wide ? 'wide' : ''}">
        <label class="form-label" for="platform-${field}">
          ${escapeHtml(label)}${required ? '<span class="required-mark">*</span>' : ''}
        </label>
        <input
          id="platform-${field}"
          class="form-control"
          data-platform-field="${field}"
          type="${type}"
          value="${value}"
          ${placeholder}
          autocomplete="off"
        />
        ${note}
      </div>
    `
  }

  function renderDeviceDetails() {
    return `
      <section class="panel">
        <div class="section-heading">
          <span class="section-number">1</span>
          <div>
            <h3>Universal Remote</h3>
            <p>These fields create the Tuya universal remote door device.</p>
          </div>
        </div>
        <div class="field-grid">
          ${fieldHtml('name', 'Name', { wide: true })}
          ${fieldHtml('id', 'Tuya ID')}
          ${fieldHtml('key', 'Tuya Key', { type: 'password' })}
          ${fieldHtml('ip', 'IP Address')}
          ${selectHtml('version', 'Tuya Protocol', {
            required: false,
            items: TUYA_PROTOCOL_OPTIONS,
            note: 'Universal remotes usually use 3.3.',
          })}
          ${fieldHtml('manufacturer', 'Manufacturer')}
          ${fieldHtml('model', 'Model')}
        </div>
      </section>
    `
  }

  function renderRfCommands() {
    const ready = isDeviceReady()
    const learnedCommands = RF_COMMANDS.filter((command) => isFilled(command.key))
    const missing = getMissingDetails()

    return `
      <section class="panel">
        <div class="section-heading">
          <span class="section-number">2</span>
          <div>
            <h3>Universal Remote RF Commands</h3>
            <p>Learn the three remote buttons from the UI after the Tuya device details are filled in.</p>
          </div>
        </div>

        <div class="setup-status">
          <div>
            <strong id="rf-status-title">${ready ? 'Ready to learn RF codes.' : 'Finish device details first.'}</strong>
            <p class="inline-note" id="rf-status-note">
              ${
                ready
                  ? 'The button below will connect to the universal remote and listen for one RF command.'
                  : `Missing: ${escapeHtml(missing.join(', '))}.`
              }
            </p>
          </div>
          <span id="rf-status-pill" class="status-pill ${ready ? 'ready' : 'blocked'}">${ready ? 'Ready' : 'Locked'}</span>
        </div>

        <div class="action-row">
          <button
            id="learn-rf-button"
            type="button"
            class="btn btn-primary"
            data-action="open-learn-modal"
            ${ready ? '' : 'disabled'}
          >
            Learn RF Code
          </button>
        </div>

        ${
          learnedCommands.length
            ? `<div class="learned-list">${learnedCommands.map(renderLearnedCommand).join('')}</div>`
            : '<div class="empty-state mt-3">No RF codes have been learned yet. The stored fields will appear here after each command is learned.</div>'
        }
      </section>
    `
  }

  function renderLearnedCommand(command) {
    const value = getFieldValue(command.key)

    return `
      <div class="learned-command">
        <div>
          <label>${escapeHtml(command.label)}</label>
          <input class="form-control secret-value" type="text" value="${escapeHtml(value)}" readonly />
          <div class="field-note">${escapeHtml(command.help)}</div>
        </div>
        <div class="learned-actions">
          <button type="button" class="btn btn-outline-primary" data-action="confirm-test-rf" data-code-key="${command.key}">
            Test
          </button>
          <button type="button" class="btn btn-outline-danger" data-action="confirm-clear-rf" data-code-key="${command.key}">
            Clear
          </button>
        </div>
      </div>
    `
  }

  function renderDirigera() {
    const gatewayIP = getFieldValue('dirigeraGatewayIP').trim()
    const token = getFieldValue('dirigeraAccessToken').trim()
    const deviceId = getFieldValue('dirigeraDeviceId').trim()
    const deviceName = getFieldValue('dirigeraDeviceName').trim() || deviceId
    const sensorLabel = deviceName && deviceName !== deviceId ? `${deviceName} (${deviceId})` : deviceId

    return `
      <section class="panel">
        <div class="section-heading">
          <span class="section-number">3</span>
          <div>
            <h3>DIRIGERA Contact Sensor</h3>
            <p>Attach the IKEA contact sensor that reports the actual door state.</p>
          </div>
        </div>

        <div class="field-grid">
          ${fieldHtml('dirigeraGatewayIP', 'DIRIGERA Gateway IP', {
            required: true,
            wide: true,
            note: 'Use the local IP address for the DIRIGERA gateway.',
          })}
          ${
            token
              ? readonlyFieldHtml('DIRIGERA Access Token', token, {
                  type: 'password',
                  secret: true,
                  note: `Stored token: ${truncateMiddle(token)}`,
                })
              : ''
          }
          ${
            deviceId
              ? readonlyFieldHtml('DIRIGERA Contact Sensor', sensorLabel, {
                  wide: true,
                  note: 'This sensor id is stored in the plugin config.',
                })
              : ''
          }
        </div>
        <div class="button-row">
          <button id="pair-dirigera-button" type="button" class="btn btn-primary" data-action="open-dirigera-auth" ${gatewayIP ? '' : 'disabled'}>
            Pair DIRIGERA
          </button>
          <button
            id="find-dirigera-button"
            type="button"
            class="btn btn-outline-primary"
            data-action="find-dirigera-sensors"
            ${gatewayIP && token ? '' : 'disabled'}
          >
            Find Contact Sensors
          </button>
        </div>
      </section>
    `
  }

  function renderStandardDevices() {
    const devices = getStandardDevices()
    const unsupported = getUnsupportedDevices()

    return `
      <section class="panel">
        <div class="section-heading section-heading-action">
          <span class="section-number">4</span>
          <div>
            <h3>Outlets and Bulbs</h3>
            <p>Add the regular Tuya outlets and bulbs that should live in this same platform config.</p>
          </div>
          <button type="button" class="btn btn-primary" data-action="open-add-standard-device">
            Add Device
          </button>
        </div>

        ${
          devices.length
            ? `<div class="standard-device-list">${devices.map(renderStandardDevice).join('')}</div>`
            : '<div class="empty-state">No outlets or bulbs are configured yet.</div>'
        }

        ${
          unsupported.length
            ? `<div class="preserved-note">${unsupported.length} configured device${unsupported.length === 1 ? ' is' : 's are'} preserved here but edited in the generated schema or config file.</div>`
            : ''
        }
      </section>
    `
  }

  function renderPlatformSettings() {
    return `
      <section class="panel">
        <div class="section-heading">
          <span class="section-number">5</span>
          <div>
            <h3>Platform Settings</h3>
            <p>Shared settings for all configured Tuya devices.</p>
          </div>
        </div>
        <div class="field-grid">
          ${platformFieldHtml('pollingInterval', 'Polling Interval', {
            type: 'number',
            placeholder: '5',
            note: 'Seconds between local state refreshes. Use 0 to disable.',
          })}
        </div>
      </section>
    `
  }

  function renderStandardDevice(device) {
    const deviceIndex = getDeviceIndex(device)
    const complete = standardDeviceComplete(device)
    const meta = getStandardDeviceMeta(device.type)
    const summary = `${standardDeviceTitle(device)} - ${standardDeviceTypeLabel(device.type)}`

    return `
      <details class="standard-device" ${complete ? '' : 'open'}>
        <summary>
          <span class="summary-main">
            <span class="choice-title">${escapeHtml(summary)}</span>
            <span class="choice-meta">${escapeHtml(meta.detail)}</span>
          </span>
          <span class="status-pill ${complete ? 'ready' : 'blocked'}">${complete ? 'Ready' : 'Needs Details'}</span>
        </summary>
        <div class="standard-device-body">
          <div class="field-grid">
            ${standardSelectHtml(deviceIndex, device, 'type', 'Device Type', {
              required: true,
              wide: true,
              items: STANDARD_DEVICE_TYPES.map((item) => ({ value: item.type, label: item.label })),
            })}
            ${standardFieldHtml(deviceIndex, device, 'name', 'Name', { required: true, wide: true })}
            ${standardFieldHtml(deviceIndex, device, 'id', 'Tuya ID', { required: true })}
            ${standardFieldHtml(deviceIndex, device, 'key', 'Tuya Key', { required: true, type: 'password' })}
            ${standardFieldHtml(deviceIndex, device, 'ip', 'IP Address', {
              note: 'Optional if discovery works reliably.',
            })}
            ${standardSelectHtml(deviceIndex, device, 'version', 'Tuya Protocol', {
              items: TUYA_PROTOCOL_OPTIONS,
            })}
            ${standardFieldHtml(deviceIndex, device, 'manufacturer', 'Manufacturer')}
            ${standardFieldHtml(deviceIndex, device, 'model', 'Model')}
          </div>

          ${renderStandardDeviceOptions(deviceIndex, device)}

          <div class="button-row">
            <button type="button" class="btn btn-outline-danger" data-action="confirm-delete-standard-device" data-device-index="${deviceIndex}">
              Remove Device
            </button>
          </div>
        </div>
      </details>
    `
  }

  function renderStandardDeviceOptions(deviceIndex, device) {
    switch (device.type) {
      case 'Outlet':
        return renderAdvancedFields('Outlet Options', [
          standardFieldHtml(deviceIndex, device, 'dpPower', 'Power DP', { type: 'number', placeholder: '1' }),
          ...renderEnergyFields(deviceIndex, device),
        ])
      case 'SimpleLight':
        return renderAdvancedFields('Bulb Options', [
          standardFieldHtml(deviceIndex, device, 'dpPower', 'Power DP', { type: 'number', placeholder: '1' }),
        ])
      case 'TWLight':
        return renderAdvancedFields('Tunable White Options', [
          standardFieldHtml(deviceIndex, device, 'dpPower', 'Power DP', { type: 'number', placeholder: '1' }),
          standardFieldHtml(deviceIndex, device, 'dpBrightness', 'Brightness DP', { type: 'number', placeholder: '2' }),
          standardFieldHtml(deviceIndex, device, 'dpColorTemperature', 'Color Temperature DP', {
            type: 'number',
            placeholder: '3',
          }),
          standardFieldHtml(deviceIndex, device, 'minWhiteColor', 'Minimum White Mired', {
            type: 'number',
            placeholder: '140',
          }),
          standardFieldHtml(deviceIndex, device, 'maxWhiteColor', 'Maximum White Mired', {
            type: 'number',
            placeholder: '400',
          }),
        ])
      case 'RGBTWLight':
        return renderAdvancedFields('Color Bulb Options', renderColorLightFields(deviceIndex, device, false))
      case 'MultiOutlet':
        return renderAdvancedFields('Power Strip Options', [
          standardFieldHtml(deviceIndex, device, 'outletCount', 'Outlet Count', {
            type: 'number',
            placeholder: '1',
            note: 'Sequential data points are used: outlet 1 uses DP 1, outlet 2 uses DP 2, and so on.',
            wide: true,
          }),
        ])
      case 'CustomMultiOutlet':
        return renderCustomOutletEditor(deviceIndex, device)
      case 'RGBTWOutlet':
        return renderAdvancedFields('Outlet With Light Options', [
          ...renderEnergyFields(deviceIndex, device),
          ...renderColorLightFields(deviceIndex, device, true),
        ])
      default:
        return ''
    }
  }

  function renderAdvancedFields(title, fields) {
    return `
      <details class="advanced-fields">
        <summary>${escapeHtml(title)}</summary>
        <div class="field-grid">
          ${fields.join('')}
        </div>
      </details>
    `
  }

  function renderEnergyFields(deviceIndex, device) {
    return [
      standardFieldHtml(deviceIndex, device, 'voltsId', 'Voltage DP', { type: 'number', placeholder: '9' }),
      standardFieldHtml(deviceIndex, device, 'ampsId', 'Current DP', { type: 'number', placeholder: '8' }),
      standardFieldHtml(deviceIndex, device, 'wattsId', 'Power Reading DP', { type: 'number', placeholder: '7' }),
      standardFieldHtml(deviceIndex, device, 'voltsDivisor', 'Voltage Divisor', { type: 'number', placeholder: '10' }),
      standardFieldHtml(deviceIndex, device, 'ampsDivisor', 'Current Divisor', { type: 'number', placeholder: '1000' }),
      standardFieldHtml(deviceIndex, device, 'wattsDivisor', 'Power Divisor', { type: 'number', placeholder: '10' }),
    ]
  }

  function renderColorLightFields(deviceIndex, device, hasOutletPower) {
    return [
      standardFieldHtml(
        deviceIndex,
        device,
        hasOutletPower ? 'dpLight' : 'dpPower',
        hasOutletPower ? 'Light Power DP' : 'Power DP',
        {
          type: 'number',
          placeholder: '1',
        },
      ),
      ...(hasOutletPower
        ? [
            standardFieldHtml(deviceIndex, device, 'dpPower', 'Outlet Power DP', {
              type: 'number',
              placeholder: '101',
            }),
          ]
        : []),
      standardFieldHtml(deviceIndex, device, 'dpMode', 'Mode DP', { type: 'number', placeholder: '2' }),
      standardFieldHtml(deviceIndex, device, 'dpBrightness', 'Brightness DP', { type: 'number', placeholder: '3' }),
      standardFieldHtml(deviceIndex, device, 'dpColorTemperature', 'Color Temperature DP', {
        type: 'number',
        placeholder: '4',
      }),
      standardFieldHtml(deviceIndex, device, 'dpColor', 'Color DP', { type: 'number', placeholder: '5' }),
      standardFieldHtml(deviceIndex, device, 'minWhiteColor', 'Minimum White Mired', {
        type: 'number',
        placeholder: '140',
      }),
      standardFieldHtml(deviceIndex, device, 'maxWhiteColor', 'Maximum White Mired', {
        type: 'number',
        placeholder: '400',
      }),
      standardSelectHtml(deviceIndex, device, 'colorFunction', 'Color Format', {
        items: COLOR_FUNCTIONS,
      }),
      standardFieldHtml(deviceIndex, device, 'scaleBrightness', 'Brightness Scale', {
        type: 'number',
        placeholder: '255',
      }),
      standardFieldHtml(deviceIndex, device, 'scaleWhiteColor', 'White Color Scale', {
        type: 'number',
        placeholder: '255',
      }),
    ]
  }

  function renderCustomOutletEditor(deviceIndex, device) {
    const outlets = Array.isArray(device.outlets) ? device.outlets : []

    return `
      <details class="advanced-fields" open>
        <summary>Custom Outlet Data Points</summary>
        <div class="custom-outlet-list">
          ${
            outlets.length
              ? outlets
                  .map(
                    (outlet, outletIndex) => `
                      <div class="custom-outlet-row">
                        <div>
                          <label class="form-label" for="device-${deviceIndex}-outlet-${outletIndex}-name">Outlet Name</label>
                          <input
                            id="device-${deviceIndex}-outlet-${outletIndex}-name"
                            class="form-control"
                            data-custom-outlet-field="name"
                            data-device-index="${deviceIndex}"
                            data-outlet-index="${outletIndex}"
                            value="${escapeHtml(outlet.name || '')}"
                          />
                        </div>
                        <div>
                          <label class="form-label" for="device-${deviceIndex}-outlet-${outletIndex}-dp">DP</label>
                          <input
                            id="device-${deviceIndex}-outlet-${outletIndex}-dp"
                            class="form-control"
                            type="number"
                            data-custom-outlet-field="dp"
                            data-device-index="${deviceIndex}"
                            data-outlet-index="${outletIndex}"
                            value="${escapeHtml(outlet.dp ?? '')}"
                          />
                        </div>
                        <button type="button" class="btn btn-outline-danger" data-action="remove-custom-outlet" data-device-index="${deviceIndex}" data-outlet-index="${outletIndex}">
                          Remove
                        </button>
                      </div>
                    `,
                  )
                  .join('')
              : '<div class="empty-state">Add at least one outlet data point for this power strip.</div>'
          }
        </div>
        <div class="button-row">
          <button type="button" class="btn btn-outline-primary" data-action="add-custom-outlet" data-device-index="${deviceIndex}">
            Add Outlet Row
          </button>
        </div>
      </details>
    `
  }

  function render() {
    app.innerHTML = `
      <div class="ui-shell">
        <div class="topbar">
          <div>
            <h2>Tuya Local</h2>
          </div>
        </div>
        ${renderDeviceDetails()}
        ${renderRfCommands()}
        ${renderDirigera()}
        ${renderStandardDevices()}
        ${renderPlatformSettings()}
      </div>
    `
  }

  function renderError(message) {
    app.innerHTML = `
      <div class="ui-shell">
        <section class="panel">
          <h3>Setup could not load</h3>
          <p class="inline-note">${escapeHtml(message)}</p>
        </section>
      </div>
    `
  }

  function syncReadiness() {
    const ready = isDeviceReady()
    const missing = getMissingDetails()
    const statusTitle = document.getElementById('rf-status-title')
    const statusNote = document.getElementById('rf-status-note')
    const statusPill = document.getElementById('rf-status-pill')
    const learnButton = document.getElementById('learn-rf-button')

    if (statusTitle) statusTitle.textContent = ready ? 'Ready to learn RF codes.' : 'Finish device details first.'
    if (statusNote) {
      statusNote.textContent = ready
        ? 'The button below will connect to the universal remote and listen for one RF command.'
        : `Missing: ${missing.join(', ')}.`
    }
    if (statusPill) {
      statusPill.textContent = ready ? 'Ready' : 'Locked'
      statusPill.className = `status-pill ${ready ? 'ready' : 'blocked'}`
    }
    if (learnButton) learnButton.disabled = !ready
  }

  function syncDirigeraActions() {
    const gatewayIP = getFieldValue('dirigeraGatewayIP').trim()
    const accessToken = getFieldValue('dirigeraAccessToken').trim()
    const pairButton = document.getElementById('pair-dirigera-button')
    const findButton = document.getElementById('find-dirigera-button')

    if (pairButton) pairButton.disabled = !gatewayIP
    if (findButton) findButton.disabled = !(gatewayIP && accessToken)
  }

  function notify(type, message, title) {
    if (hb?.toast?.[type]) {
      hb.toast[type](message, title)
    }
  }

  function getErrorMessage(err) {
    if (!err) return 'Unknown error'
    if (typeof err === 'string') return err
    if (err.message) return err.message
    if (err.error) return err.error
    return JSON.stringify(err)
  }

  function scheduleUpdate() {
    clearTimeout(state.updateTimer)
    state.updateTimer = setTimeout(() => {
      updateConfig().catch((err) => notify('error', getErrorMessage(err), 'Config Update Failed'))
    }, 350)
  }

  async function flushUpdate() {
    clearTimeout(state.updateTimer)
    await updateConfig()
  }

  async function updateConfig() {
    state.device.type = DEVICE_TYPE
    state.device.version = state.device.version || '3.3'
    state.device.intro = false
    await hb.updatePluginConfig(getSanitizedPluginConfig())
  }

  function getSanitizedPluginConfig() {
    return state.pluginConfig.map((block) => {
      if (block !== state.platformConfig) return block

      const sanitizedBlock = {
        ...block,
        devices: state.platformConfig.devices.filter(shouldSaveDevice).map(cloneDeviceForSave),
      }

      const parsedPollingInterval = parseConfigFieldValue('pollingInterval', sanitizedBlock.pollingInterval, 'number')
      if (parsedPollingInterval.hasValue) sanitizedBlock.pollingInterval = parsedPollingInterval.value
      else delete sanitizedBlock.pollingInterval

      return sanitizedBlock
    })
  }

  function shouldSaveDevice(device) {
    if (device === state.device) return doorConfigComplete(device)
    if (isStandardDeviceType(device.type)) return standardDeviceComplete(device)

    return Boolean(getStandardFieldValue(device, 'type').trim() && getStandardFieldValue(device, 'id').trim())
  }

  function cloneDeviceForSave(device) {
    const clone = { ...device }

    Object.keys(clone).forEach((key) => {
      if (clone[key] === '') delete clone[key]
      if (!NUMERIC_CONFIG_FIELDS.has(key)) return

      const parsed = parseConfigFieldValue(key, clone[key], 'number')
      if (parsed.hasValue) clone[key] = parsed.value
      else delete clone[key]
    })

    delete clone.pollingInterval

    if (clone.type === DEVICE_TYPE) {
      clone.type = DEVICE_TYPE
      clone.version = clone.version || '3.3'
      delete clone.intro
      delete clone.useDirigeraContactSensor
      delete clone.dirigeraDeviceModel
    }

    return clone
  }

  function requestDevice() {
    return {
      ...state.device,
      type: DEVICE_TYPE,
      version: state.device.version || '3.3',
      intro: false,
    }
  }

  function openModal(title, body, footer) {
    closeModal()

    const modal = document.createElement('div')
    modal.className = 'modal-backdrop-custom'
    modal.innerHTML = `
      <div class="modal-panel" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
        <div class="modal-header-custom">
          <h4>${escapeHtml(title)}</h4>
          <button type="button" class="btn-close" aria-label="Close" data-action="close-modal"></button>
        </div>
        <div class="modal-body-custom">
          ${body}
          ${footer || '<div class="button-row"><button type="button" class="btn btn-secondary" data-action="close-modal">Close</button></div>'}
        </div>
      </div>
    `

    document.body.appendChild(modal)
    state.modal = modal
  }

  function closeModal() {
    state.modal?.remove()
    state.modal = null
  }

  function loadingHtml(message) {
    return `
      <div class="spinner-inline">
        <span class="spinner-border spinner-border-sm" role="status"></span>
        <span>${escapeHtml(message)}</span>
      </div>
    `
  }

  function openLearnModal() {
    if (!isDeviceReady()) return

    openModal(
      'Learn RF Code',
      `
        <p class="inline-note mb-3">Choose the command to learn, then press the matching button on the physical remote when prompted.</p>
        <div class="command-choice-grid">
          ${RF_COMMANDS.map(
            (command) => `
              <button type="button" class="command-choice" data-action="learn-rf" data-code-key="${command.key}">
                <span class="choice-title">${escapeHtml(command.label)}</span>
                <span class="choice-meta">${escapeHtml(command.help)}</span>
              </button>
            `,
          ).join('')}
        </div>
      `,
    )
  }

  async function learnRfCode(codeKey) {
    const command = RF_COMMANDS.find((item) => item.key === codeKey)
    if (!command) return

    openModal(
      `Learn ${command.label}`,
      `
        ${loadingHtml(`Listening for ${command.label}. Press the physical remote button now.`)}
        <p class="inline-note mt-3">This can take up to 30 seconds. Leave this window open while the code is being learned.</p>
      `,
      '',
    )

    try {
      await flushUpdate()
      const result = await hb.request('/learn-rf', {
        device: requestDevice(),
        codeKey,
        timeoutSeconds: 30,
      })

      state.device[result.codeKey] = result.code
      await updateConfig()
      notify('success', `${result.label} is staged. Use the Homebridge Save button to write it.`, 'RF Code Learned')
      closeModal()
      render()
    } catch (err) {
      openModal(
        `Could Not Learn ${command.label}`,
        `<p>${escapeHtml(getErrorMessage(err))}</p>`,
        `<div class="button-row">
          <button type="button" class="btn btn-primary" data-action="open-learn-modal">Try Again</button>
          <button type="button" class="btn btn-secondary" data-action="close-modal">Close</button>
        </div>`,
      )
    }
  }

  function confirmTestRf(codeKey) {
    const command = RF_COMMANDS.find((item) => item.key === codeKey)
    if (!command) return

    openModal(
      `Test ${command.label}`,
      `
        <p>This sends the stored RF command to the door motor.</p>
        <p class="inline-note">The door may move. Automatic Mode may trigger the motor's built-in open/close cycle.</p>
      `,
      `<div class="button-row">
        <button type="button" class="btn btn-primary" data-action="run-test-rf" data-code-key="${command.key}">Send Command</button>
        <button type="button" class="btn btn-secondary" data-action="close-modal">Cancel</button>
      </div>`,
    )
  }

  async function runTestRf(codeKey) {
    const command = RF_COMMANDS.find((item) => item.key === codeKey)
    if (!command) return

    openModal(`Testing ${command.label}`, loadingHtml('Sending RF command...'), '')

    try {
      await flushUpdate()
      await hb.request('/send-rf', {
        device: requestDevice(),
        code: state.device[codeKey],
      })
      notify('success', `${command.label} was sent.`, 'RF Test Sent')
      closeModal()
    } catch (err) {
      openModal(`Could Not Test ${command.label}`, `<p>${escapeHtml(getErrorMessage(err))}</p>`)
    }
  }

  function confirmClearRf(codeKey) {
    const command = RF_COMMANDS.find((item) => item.key === codeKey)
    if (!command) return

    openModal(
      `Clear ${command.label}`,
      '<p>This removes the learned code from the plugin config.</p>',
      `<div class="button-row">
        <button type="button" class="btn btn-danger" data-action="clear-rf" data-code-key="${command.key}">Clear Code</button>
        <button type="button" class="btn btn-secondary" data-action="close-modal">Cancel</button>
      </div>`,
    )
  }

  async function clearRf(codeKey) {
    const command = RF_COMMANDS.find((item) => item.key === codeKey)
    if (!command) return

    state.device[codeKey] = ''
    await updateConfig()
    notify('success', `${command.label} is cleared. Use the Homebridge Save button to write it.`, 'RF Code Cleared')
    closeModal()
    render()
  }

  function openDirigeraAuthModal() {
    openModal(
      'Pair DIRIGERA',
      `
        <p>Press the Action Button on the bottom of the DIRIGERA gateway within 60 seconds after starting pairing.</p>
        <p class="inline-note">The access token will be saved read-only in the plugin config when pairing succeeds.</p>
      `,
      `<div class="button-row">
        <button type="button" class="btn btn-primary" data-action="start-dirigera-auth">Start Pairing</button>
        <button type="button" class="btn btn-secondary" data-action="close-modal">Cancel</button>
      </div>`,
    )
  }

  async function startDirigeraAuth() {
    const gatewayIP = getFieldValue('dirigeraGatewayIP').trim()
    if (!gatewayIP) return

    openModal('Pairing DIRIGERA', loadingHtml('Waiting for the gateway button press...'), '')

    try {
      const result = await hb.request('/dirigera-authenticate', { gatewayIP })
      state.device.dirigeraAccessToken = result.accessToken
      await updateConfig()
      notify(
        'success',
        'DIRIGERA access token is staged. Use the Homebridge Save button to write it.',
        'Gateway Paired',
      )
      await findDirigeraSensors()
    } catch (err) {
      openModal(
        'DIRIGERA Pairing Failed',
        `<p>${escapeHtml(getErrorMessage(err))}</p>`,
        `<div class="button-row">
          <button type="button" class="btn btn-primary" data-action="open-dirigera-auth">Try Again</button>
          <button type="button" class="btn btn-secondary" data-action="close-modal">Close</button>
        </div>`,
      )
    }
  }

  async function findDirigeraSensors() {
    const gatewayIP = getFieldValue('dirigeraGatewayIP').trim()
    const accessToken = getFieldValue('dirigeraAccessToken').trim()
    if (!gatewayIP || !accessToken) return

    openModal('Finding Contact Sensors', loadingHtml('Reading open/close sensors from DIRIGERA...'), '')

    try {
      state.sensors = await hb.request('/dirigera-open-close-sensors', {
        gatewayIP,
        accessToken,
      })

      openModal(
        'Choose Contact Sensor',
        state.sensors.length
          ? `<div class="sensor-grid">${state.sensors.map(renderSensorChoice).join('')}</div>`
          : '<div class="empty-state">No DIRIGERA open/close sensors were found.</div>',
      )
    } catch (err) {
      openModal('Could Not Find Sensors', `<p>${escapeHtml(getErrorMessage(err))}</p>`)
    }
  }

  function renderSensorChoice(sensor, index) {
    const stateLabel = typeof sensor.isOpen === 'boolean' ? (sensor.isOpen ? 'Open' : 'Closed') : 'Unknown'
    const reachability = sensor.isReachable ? 'Reachable' : 'Not reachable'
    const battery =
      typeof sensor.batteryPercentage === 'number' ? `Battery ${sensor.batteryPercentage}%` : 'Battery unknown'
    const meta = [sensor.roomName, sensor.model, stateLabel, reachability, battery].filter(Boolean).join(' | ')

    return `
      <button type="button" class="sensor-choice" data-action="select-sensor" data-sensor-index="${index}">
        <span class="choice-title">${escapeHtml(sensor.name || sensor.id)}</span>
        <span class="choice-meta">${escapeHtml(meta)}</span>
        <span class="choice-meta">${escapeHtml(sensor.id)}</span>
      </button>
    `
  }

  async function selectSensor(index) {
    const sensor = state.sensors[index]
    if (!sensor) return

    state.device.dirigeraDeviceId = sensor.id
    state.device.dirigeraDeviceName = sensor.name || sensor.id

    await updateConfig()
    notify(
      'success',
      `${sensor.name || sensor.id} is staged. Use the Homebridge Save button to write it.`,
      'Sensor Stored',
    )
    closeModal()
    render()
  }

  function getPlatformDeviceByIndex(index) {
    return state.platformConfig.devices[Number(index)]
  }

  function setOptionalField(object, field, value, options = {}) {
    const parsed = parseConfigFieldValue(field, value, options.inputType)
    const requiredFields = options.requiredFields || STANDARD_REQUIRED_FIELDS

    if (parsed.hasValue) {
      object[field] = parsed.value
    } else if (!requiredFields.includes(field)) {
      delete object[field]
    } else {
      object[field] = ''
    }
  }

  function setStandardDeviceField(target) {
    const device = getPlatformDeviceByIndex(target.getAttribute('data-device-index'))
    const field = target.getAttribute('data-standard-field')
    if (!device || !field) return false

    if (field === 'type') {
      device.type = target.value
      device.version = defaultProtocolForType(device.type)
      if (!device.name) device.name = ''
      if (!device.id) device.id = ''
      if (!device.key) device.key = ''
      if (device.type === 'CustomMultiOutlet' && !Array.isArray(device.outlets)) {
        device.outlets = []
      }
      scheduleUpdate()
      render()
      return true
    }

    setOptionalField(device, field, target.value, { inputType: target.type })
    scheduleUpdate()
    return true
  }

  function setPlatformField(target) {
    const field = target.getAttribute('data-platform-field')
    if (!field) return false

    setOptionalField(state.platformConfig, field, target.value, {
      inputType: target.type,
      requiredFields: [],
    })
    scheduleUpdate()
    return true
  }

  function setCustomOutletField(target) {
    const device = getPlatformDeviceByIndex(target.getAttribute('data-device-index'))
    const outletIndex = Number(target.getAttribute('data-outlet-index'))
    const field = target.getAttribute('data-custom-outlet-field')
    if (!device || !field || !Array.isArray(device.outlets) || !device.outlets[outletIndex]) return false

    if (field === 'dp') {
      const dp = Number(target.value)
      if (Number.isFinite(dp) && dp > 0) device.outlets[outletIndex].dp = dp
      else delete device.outlets[outletIndex].dp
    } else {
      device.outlets[outletIndex][field] = target.value
    }

    scheduleUpdate()
    return true
  }

  function openAddStandardDeviceModal() {
    openModal(
      'Add Outlet or Bulb',
      `
        <p class="inline-note mb-3">Choose the HomeKit device shape. The fields shown afterward map directly to this plugin's existing device types.</p>
        <div class="command-choice-grid">
          ${STANDARD_DEVICE_TYPES.map(
            (item) => `
              <button type="button" class="command-choice" data-action="add-standard-device" data-device-type="${item.type}">
                <span class="choice-title">${escapeHtml(item.label)}</span>
                <span class="choice-meta">${escapeHtml(item.detail)}</span>
              </button>
            `,
          ).join('')}
        </div>
      `,
    )
  }

  function addStandardDevice(type) {
    if (!isStandardDeviceType(type)) return

    const device = {
      type,
      name: '',
      id: '',
      key: '',
      version: defaultProtocolForType(type),
    }

    if (type === 'CustomMultiOutlet') {
      device.outlets = [{ name: 'Outlet 1', dp: 1 }]
    }

    state.platformConfig.devices.push(device)
    closeModal()
    scheduleUpdate()
    render()
  }

  function confirmDeleteStandardDevice(deviceIndex) {
    const device = getPlatformDeviceByIndex(deviceIndex)
    if (!device || device === state.device) return

    openModal(
      `Remove ${standardDeviceTitle(device)}`,
      '<p>This removes the device from the Tuya Local config.</p>',
      `<div class="button-row">
        <button type="button" class="btn btn-danger" data-action="delete-standard-device" data-device-index="${deviceIndex}">Remove Device</button>
        <button type="button" class="btn btn-secondary" data-action="close-modal">Cancel</button>
      </div>`,
    )
  }

  function deleteStandardDevice(deviceIndex) {
    const index = Number(deviceIndex)
    const device = getPlatformDeviceByIndex(index)
    if (!device || device === state.device) return

    state.platformConfig.devices.splice(index, 1)
    closeModal()
    scheduleUpdate()
    render()
  }

  function addCustomOutletRow(deviceIndex) {
    const device = getPlatformDeviceByIndex(deviceIndex)
    if (!device) return

    device.outlets = Array.isArray(device.outlets) ? device.outlets : []
    device.outlets.push({
      name: `Outlet ${device.outlets.length + 1}`,
      dp: device.outlets.length + 1,
    })
    scheduleUpdate()
    render()
  }

  function removeCustomOutletRow(deviceIndex, outletIndex) {
    const device = getPlatformDeviceByIndex(deviceIndex)
    if (!device || !Array.isArray(device.outlets)) return

    device.outlets.splice(Number(outletIndex), 1)
    scheduleUpdate()
    render()
  }

  function handleInput(event) {
    const target = event.target
    if (target?.matches?.('[data-standard-field]')) {
      setStandardDeviceField(target)
      return
    }

    if (target?.matches?.('[data-platform-field]')) {
      setPlatformField(target)
      return
    }

    if (target?.matches?.('[data-custom-outlet-field]')) {
      setCustomOutletField(target)
      return
    }

    if (!target?.matches?.('[data-field]')) return

    const field = target.getAttribute('data-field')
    if (!field) return

    state.device[field] = target.type === 'checkbox' ? target.checked : target.value
    syncReadiness()
    syncDirigeraActions()
    scheduleUpdate()
  }

  function handleChange(event) {
    const target = event.target
    if (target?.matches?.('[data-standard-field]')) {
      setStandardDeviceField(target)
      return
    }

    if (target?.matches?.('[data-platform-field]')) {
      setPlatformField(target)
      return
    }

    if (target?.matches?.('[data-field]') && target.type !== 'checkbox') {
      const field = target.getAttribute('data-field')
      if (field) {
        setOptionalField(state.device, field, target.value, {
          inputType: target.type,
          requiredFields: REQUIRED_DETAIL_FIELDS,
        })
        syncReadiness()
        syncDirigeraActions()
        scheduleUpdate()
      }
      return
    }

    if (target?.matches?.('[data-field]')) {
      scheduleUpdate()
      render()
    }
  }

  function handleClick(event) {
    const actionTarget = event.target.closest('[data-action]')
    if (!actionTarget || actionTarget.disabled) {
      if (event.target.classList.contains('modal-backdrop-custom')) closeModal()
      return
    }

    const action = actionTarget.getAttribute('data-action')
    const codeKey = actionTarget.getAttribute('data-code-key')

    switch (action) {
      case 'close-modal':
        closeModal()
        break
      case 'open-add-standard-device':
        openAddStandardDeviceModal()
        break
      case 'add-standard-device':
        addStandardDevice(actionTarget.getAttribute('data-device-type'))
        break
      case 'confirm-delete-standard-device':
        confirmDeleteStandardDevice(actionTarget.getAttribute('data-device-index'))
        break
      case 'delete-standard-device':
        deleteStandardDevice(actionTarget.getAttribute('data-device-index'))
        break
      case 'add-custom-outlet':
        addCustomOutletRow(actionTarget.getAttribute('data-device-index'))
        break
      case 'remove-custom-outlet':
        removeCustomOutletRow(
          actionTarget.getAttribute('data-device-index'),
          actionTarget.getAttribute('data-outlet-index'),
        )
        break
      case 'open-learn-modal':
        openLearnModal()
        break
      case 'learn-rf':
        learnRfCode(codeKey)
        break
      case 'confirm-test-rf':
        confirmTestRf(codeKey)
        break
      case 'run-test-rf':
        runTestRf(codeKey)
        break
      case 'confirm-clear-rf':
        confirmClearRf(codeKey)
        break
      case 'clear-rf':
        clearRf(codeKey).catch((err) => notify('error', getErrorMessage(err), 'Clear Failed'))
        break
      case 'open-dirigera-auth':
        openDirigeraAuthModal()
        break
      case 'start-dirigera-auth':
        startDirigeraAuth()
        break
      case 'find-dirigera-sensors':
        findDirigeraSensors()
        break
      case 'select-sensor':
        selectSensor(Number(actionTarget.getAttribute('data-sensor-index'))).catch((err) =>
          notify('error', getErrorMessage(err), 'Sensor Save Failed'),
        )
        break
    }
  }

  async function init() {
    if (!hb) {
      renderError('The Homebridge custom UI API is not available in this window.')
      return
    }

    try {
      const pluginConfig = await hb.getPluginConfig()
      ensurePlatformConfig(pluginConfig)
      render()
    } catch (err) {
      renderError(getErrorMessage(err))
    }
  }

  app.addEventListener('input', handleInput)
  app.addEventListener('change', handleChange)
  document.addEventListener('click', handleClick)

  init()
})()
