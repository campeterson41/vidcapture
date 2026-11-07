# Camera profiles

VidCapture works with any webcam. A camera profile adds optional tuning for one
camera model. Profiles are JSON files read from this folder and from
`~/.config/vidcapture/camera-profiles/`. A profile in your config folder
replaces one here with the same `match`.

Profiles in this folder are personal hardware tuning and are not part of public
releases. Put your own in the config folder.

| Field | Required | What it does |
| --- | --- | --- |
| `name` | yes | Shown in Camera settings. |
| `match` | yes | `usb:VVVV:PPPP`, the camera's USB vendor and product ID (`lsusb`). |
| `note` | no | One short line shown under the camera's settings. |
| `extensionUnit` | no | Vendor commands sent through the camera's UVC extension unit each time it opens. Nothing is written to camera flash. |
| `lensCorrection` | no | GPU lens correction: `radial` (3 numbers) and `offset` (2 numbers) in half-image-height units, with `fittedAt` naming the zoom and focus values it was measured at. Adds a Lens correction setting. |
| `gpuDecode` | no | `"intel"` decodes MJPEG on the Intel GPU for a low-latency 4K preview. |

`extensionUnit` has `guid`, `size` (bytes per command), `setSelector`,
`getSelector`, a `status` command, and `ensure` rules. Each rule says which
byte of the status reply should equal which value, and the command to `send`
when it does not. The status is read again afterwards and every rule must hold.

See `example.json.sample` for the shape. Rename it to `.json` to use it.
