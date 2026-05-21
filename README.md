<div align="center">

  <br />

  <img src="docs/public/logo.svg" alt="Nubisco" width="96" />

<br /><br />

# Homebridge Tuya Local

**Control Tuya smart devices locally over LAN through Apple HomeKit. No cloud, no latency.**

  <br />

[![CI](https://github.com/nubisco/homebridge-tuya-local/actions/workflows/ci.yml/badge.svg)](https://github.com/nubisco/homebridge-tuya-local/actions/workflows/ci.yml)
[![Coverage](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/nubisco/homebridge-tuya-local/badges/coverage.json)](https://github.com/nubisco/homebridge-tuya-local/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/node-22%20%7C%2024-339933)](https://nodejs.org)
[![Homebridge](https://img.shields.io/badge/homebridge-1.6%20%7C%202.0-blue)](https://homebridge.io)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

</div>

---

## Table of Contents

- [Homebridge Tuya Local](#homebridge-tuya-local)
  - [Table of Contents](#table-of-contents)
  - [Quick Start](#quick-start)
  - [Why Local Control?](#why-local-control)
  - [Features](#features)
  - [Supported Devices](#supported-devices)
  - [Local Documentation](#local-documentation)
  - [Contributing](#contributing)
  - [Security](#security)
  - [Support this project](#support-this-project)
  - [License](#license)

---

## Quick Start

This fork is private/local-use only. Build it from this checkout, then install the package into the Homebridge Node environment:

```bash
npm install
npm run build
npm install -g .
```

Add to your Homebridge `config.json`:

```json
{
  "platforms": [
    {
      "platform": "TuyaLocalPlatform",
      "devices": [
        {
          "name": "My Light",
          "type": "SimpleLight",
          "id": "<device-id>",
          "key": "<local-key>"
        }
      ]
    }
  ]
}
```

> **Need your device credentials?** See the [Getting Local Keys](docs/get-local-keys.md) guide.

---

## Why Local Control?

Tuya's cloud relies on remote servers. Any outage, policy change, or internet disruption can leave your automations unresponsive. This plugin talks directly to your devices over your LAN using the Tuya protocol (v3.1, v3.3, v3.4):

- **Works offline:** your smart home keeps working even when the internet is down
- **Instant response:** no round-trip to the cloud; commands execute in milliseconds
- **No subscription:** zero dependency on Tuya's infrastructure or account

---

## Features

- **Local LAN Control:** Communicates directly with devices; no cloud, no internet dependency
- **24 Device Types:** Outlets, lights, dimmers, fans, sensors, climate control, and more
- **Adaptive Lighting:** HomeKit Adaptive Lighting on compatible tunable white and RGBTW accessories
- **Energy Monitoring:** Real-time voltage, current, and power readings on supported devices
- **Automatic Discovery:** UDP broadcast discovery finds devices on your local network automatically
- **Flexible Configuration:** Override DataPoints (DPs) and tune device behavior per accessory
- **Multi-protocol Support:** Full encryption and authentication for Tuya protocol v3.1, v3.3, and v3.4
- **TypeScript:** Fully typed codebase with comprehensive test coverage

---

## Supported Devices

| Device                                |        Type key         |
| :------------------------------------ | :---------------------: |
| Air Conditioner                       |    `AirConditioner`     |
| Air Purifier                          |      `AirPurifier`      |
| Circuit Breaker Monitor _(read-only)_ | `CircuitBreakerMonitor` |
| Heat Convector                        |       `Convector`       |
| Non-sequential Power Strip            |   `CustomMultiOutlet`   |
| Dehumidifier                          |     `Dehumidifier`      |
| Smart Fan Regulator                   |          `Fan`          |
| Smart Fan with Light                  |       `FanLight`        |
| Garage Door                           |      `GarageDoor`       |
| Universal Remote Door                 |  `UniversalRemoteDoor`  |
| Mapped Heat Pump Heater               | `MappedHeatPumpHeater`  |
| Smart Power Strip                     |      `MultiOutlet`      |
| Oil Diffuser                          |      `OilDiffuser`      |
| Smart Plug                            |        `Outlet`         |
| Smart Plug w/ Color Lights            |      `RGBTWOutlet`      |
| White and Color Light Bulb            |      `RGBTWLight`       |
| Simple Blinds                         |     `SimpleBlinds`      |
| Simple Dimmer                         |     `SimpleDimmer`      |
| Simple Dimmer 2                       |     `SimpleDimmer2`     |
| Simple Heater                         |     `SimpleHeater`      |
| Simple Light Bulb                     |      `SimpleLight`      |
| Multi-Switch                          |        `Switch`         |
| Tunable White Light Bulb              |        `TWLight`        |
| Water Valve                           |      `WaterValve`       |

> The `type` value is **case-insensitive**. `"SimpleLight"`, `"simplelight"`, and `"SIMPLELIGHT"` all work.

Full per-device configuration details and DataPoint overrides are covered in [docs/device-types.md](docs/device-types.md).

---

## Local Documentation

Markdown documentation is kept in this repository:

- [Installation](docs/installation.md)
- [Getting Local Keys](docs/get-local-keys.md)
- [Configuration](docs/configuration.md)
- [Supported Device Types](docs/device-types.md)
- [Troubleshooting](docs/troubleshooting.md)

---

## Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, coding standards, and pull request guidelines.

---

## Security

For security vulnerabilities, please see [SECURITY.md](SECURITY.md) for responsible disclosure procedures.

---

## Support this project

If this plugin helps your Homebridge setup, consider sponsoring development. Maintaining device integrations, testing hardware, and providing support takes significant time. GitHub Sponsors helps ensure long-term maintenance.

- ❤️ [Sponsor via GitHub](https://github.com/sponsors/joseporto)
- ⭐ [Star the repository](https://github.com/nubisco/homebridge-tuya-local)

---

## License

[MIT](LICENSE)
