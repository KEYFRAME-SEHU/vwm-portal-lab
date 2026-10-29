# IWSDK Project Schema (`iwsdk-project.v1`)

Reference for the JSON Schema shipped in `node_modules/@iwsdk/core/dist/schemas/`, which validates this repo's `iwsdk.config.json`.

## Overview

| | |
|---|---|
| Folder contents | `iwsdk-project.v1.schema.json` (only file) |
| Package | `@iwsdk/core` 0.5.3 |
| Dialect | JSON Schema draft 2020-12 |
| `$id` | `https://iwsdk.dev/schemas/iwsdk-project.v1.schema.json` |
| Title | IWSDK Project Manifest v1 |

`iwsdk.config.json` points at the schema with a relative path:

```json
"$schema": "./node_modules/@iwsdk/core/dist/schemas/iwsdk-project.v1.schema.json"
```

Editors (VS Code etc.) use this for validation and autocomplete. Because the path is relative to `node_modules`, it only resolves after `npm install`.

The manifest is consumed by `@iwsdk/vite-plugin-dev` (the `iwsdkDev()` plugin in `vite.config.ts`) and `@iwsdk/cli`.

> **Strict objects:** every object in the schema sets `additionalProperties: false`. Any unknown or misspelled key is a validation error.

> **Boolean-or-options pattern:** many feature settings accept either `true`/`false` or an options object. Where this doc says *bool | object*, both forms are valid.

## Top-level fields

| Field | Required | Type | Notes |
|---|---|---|---|
| `$schema` | no | string | Path/URL to this schema. |
| `version` | **yes** | const `"iwsdk.project.v1"` | Must be exactly this string. |
| `scene` | **yes** | string | Path to a scene file under `public/scenes/` ending in `.iwsdk.scene.json`. Optional leading `./`. No `.`/`..` segments, `//`, `?`, `#`, or `\`. |
| `assets` | no | `{ module }` | Module declaration (see below). |
| `components` | no | `{ module }` | Module declaration (see below). |
| `world` | **yes** | object | See [`world`](#world). |
| `dev` | no | object | See [`dev`](#dev). |

### Module declaration (`assets`, `components`)

```json
{ "module": "src/components" }
```

`module` (required) is a relative path, optionally prefixed with `./`, with **no file extension** on the last segment. It must not start/end with whitespace and must not contain `.`/`..` segments, `//`, `?`, `#`, or `\`.

## `world`

| Field | Required | Type |
|---|---|---|
| `xr` | **yes** | `false` \| object |
| `input` | no | object |
| `render` | no | object |
| `features` | no | object |

### `world.xr`

Either `false` (no XR) or an object:

| Field | Required | Values |
|---|---|---|
| `mode` | **yes** | `"vr"` \| `"ar"` |
| `offer` | no | `"none"` \| `"once"` \| `"always"` |
| `referenceSpace` | no | reference space type string, or object (below) |
| `restoreCameraOnExit` | no | boolean |
| `features` | no | object (below) |

**Reference space types:** `bounded-floor`, `local`, `local-floor`, `unbounded`, `viewer`.

Object form of `referenceSpace`:

```json
{ "type": "local-floor", "required": false, "fallbackOrder": ["local", "viewer"] }
```

#### `world.xr.features`

| Feature | Type | Object options |
|---|---|---|
| `handTracking` | bool \| object | `required` |
| `anchors` | bool \| object | `required` |
| `hitTest` | bool \| object | `required` |
| `planeDetection` | bool \| object | `required` |
| `meshDetection` | bool \| object | `required` |
| `layers` | bool \| object | `required` |
| `unbounded` | bool \| object | `required` |
| `depthSensing` | bool \| object | `required`, `usage` (`"cpu-optimized"` \| `"gpu-optimized"`), `format` (`"luminance-alpha"` \| `"float32"`) |

### `world.input`

| Field | Type | Object options |
|---|---|---|
| `canvasPointerEvents` | bool \| object | `enabled` (bool), `activeDuringXR` (bool) |

### `world.render`

| Field | Type |
|---|---|
| `fov` | number |
| `near` | number |
| `far` | number |
| `stencil` | boolean |
| `camera` | object |

`render.camera` fields (vec3 = array of exactly 3 numbers, vec4 = exactly 4):

| Field | Type |
|---|---|
| `position` | vec3 |
| `rotation` | vec3 |
| `quaternion` | vec4 |
| `lookAt` | vec3 |

### `world.features`

| Feature | Type | Object options |
|---|---|---|
| `locomotion` | bool \| object | `useWorker` (bool), `initialPlayerPosition` (vec3), `comfortAssistLevel` (number), `turningMethod` (`"snap"` \| `"smooth"`), `enableJumping` (bool), `browserControls` (bool \| `{ keyboard, gamepad }`) |
| `grabbing` | bool \| object | `useHandPinchForGrab` (bool) |
| `physics` | boolean | — |
| `sceneUnderstanding` | bool \| object | `showWireFrame` (bool) |
| `environmentRaycast` | boolean | — |
| `camera` | boolean | — |
| `spatialUI` | bool \| object | `forwardHtmlEvents` (bool), `kit` (`"default"` \| `"horizon"`), `preferredColorScheme` (`"system"` \| `"light"` \| `"dark"`) |

## `dev`

Only one key: `emulator`.

### `dev.emulator`

| Field | Type / values |
|---|---|
| `device` | `"metaQuest2"` \| `"metaQuest3"` \| `"metaQuestPro"` \| `"oculusQuest1"` |
| `iwer` | boolean |
| `environment` | `"living_room"` \| `"meeting_room"` \| `"music_room"` \| `"office_large"` \| `"office_small"` |
| `activation` | `"localhost"` \| `"always"` \| regex object |
| `injectOnBuild` | boolean |
| `userAgentException` | regex object |

Regex object:

```json
{ "source": "Quest", "flags": "i" }
```

`source` is a required non-empty string. `flags` is optional and may contain each of `d g i m s u v y` at most once, and not both `u` and `v`.

## This project's config

Current `iwsdk.config.json`:

```json
{
  "$schema": "./node_modules/@iwsdk/core/dist/schemas/iwsdk-project.v1.schema.json",
  "version": "iwsdk.project.v1",
  "scene": "./public/scenes/main.iwsdk.scene.json",
  "world": {
    "xr": {
      "mode": "vr",
      "offer": "none",
      "features": {
        "handTracking": true
      }
    },
    "features": {
      "locomotion": true
    }
  },
  "dev": {
    "emulator": {
      "device": "metaQuest3"
    }
  }
}
```

- **Scene:** `public/scenes/main.iwsdk.scene.json`.
- **XR:** immersive VR; `offer: "none"` means the session isn't offered automatically; hand tracking enabled.
- **Features:** locomotion on with default options.
- **Dev:** emulates a Meta Quest 3.

## Validation and upgrades

- Editors validate automatically through `$schema`.
- From the command line:

  ```sh
  npx ajv-cli validate --spec=draft2020 \
    -s node_modules/@iwsdk/core/dist/schemas/iwsdk-project.v1.schema.json \
    -d iwsdk.config.json
  ```

- When upgrading `@iwsdk/core`, check `node_modules/@iwsdk/core/dist/schemas/` for a new schema version (e.g. `v2`). If one appears, update both `version` and `$schema` in `iwsdk.config.json` and revise this doc.
