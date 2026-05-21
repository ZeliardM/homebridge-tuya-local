# Installation

## Option 1: Homebridge Config UI X

1. Open the Homebridge UI.
2. Go to **Plugins**.
3. Search for `homebridge-tuya-local`.
4. Click **Install**.
5. Restart Homebridge.

## Option 2: Manual (npm)

```bash
npm install -g homebridge-tuya-local
```

Restart Homebridge after installation.

## Verify Installation

Check that the plugin is registered:

```bash
npm list -g homebridge-tuya-local
```

## Upgrading from `homebridge-tuya` / `TuyaLocalPlatform`

If you previously used the `homebridge-tuya` plugin with `"platform": "TuyaLocalPlatform"`:

1. Uninstall the old plugin.
2. Install this plugin.
3. Update your `config.json` — change `"platform": "TuyaLocalPlatform"` to `"platform": "TuyaLocalPlatform"`.
4. Restart Homebridge.

All device configurations remain compatible.
