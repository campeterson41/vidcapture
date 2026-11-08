# Install the VidCapture Chrome extension

Version 0.3.0. For Chrome or Chromium on Omarchy/Linux, with the VidCapture desktop app from v0.1.0-alpha.7 or newer. The desktop app owns recording, camera effects, and local files; this extension is its control panel. This is an unpacked extension, not a Chrome Web Store installation. Mac and Windows recording are not supported.

Install the desktop app first using the [release README](https://github.com/campeterson41/vidcapture/tree/v0.1.0-alpha.7#install). System Node.js must be available at `/usr/bin/node`, and the executable desktop launcher at `~/.local/bin/capture`.

## Download and install

1. Download `vidcapture-extension-v0.3.0.zip` and its `.sha256` file from the [alpha.7 release](https://github.com/campeterson41/vidcapture/releases/tag/v0.1.0-alpha.7). Check the ZIP with `sha256sum -c vidcapture-extension-v0.3.0.zip.sha256` in that download folder.
2. Extract the ZIP into a lasting folder, such as `~/.local/share/vidcapture-extension`. Keep that folder in place; it contains `manifest.json` directly.
3. In a terminal, register the local connection:

   ```bash
   bash "$HOME/.local/share/vidcapture-extension/native/install.sh" --browser chromium
   ```

   Use `--browser chrome` for Google Chrome. Registration preserves previous host registration when changed and does not edit browser flags, start recording, or restart anything.
4. Enter `chrome://extensions` in the browser address bar. Turn on Developer mode, choose **Load unpacked**, and select the folder containing `manifest.json`.
5. Pin VidCapture from the extensions puzzle menu. Open it and verify **Connected to desktop app**. Open Camera & background and confirm its settings load without connection errors. Its footer should read **Extension 0.3.0**. The expected extension ID is `dagpaflngbhbgpeichcnhalplkdmkfie`.

For a fresh ZIP install, steps 2 and 3 can also be run together:

```bash
mkdir -p "$HOME/.local/share/vidcapture-extension"
unzip "$HOME/Downloads/vidcapture-extension-v0.3.0.zip" -d "$HOME/.local/share/vidcapture-extension"
bash "$HOME/.local/share/vidcapture-extension/native/install.sh" --browser chromium
```

Adjust the ZIP path if your browser saves elsewhere. If the lasting folder already contains an installation or edits, inspect and preserve it before replacing files. Keep browser loading in step 4; terminal registration alone does not install or pin an unpacked extension.

## Already using the desktop source checkout?

Use its `extension/` folder instead of downloading a second copy. From the updated v0.1.0-alpha.7 or newer checkout:

```bash
bash "./extension/native/install.sh" --browser chromium
```

Then load that checkout’s `extension/` directory using step 4. Pick either the ZIP folder or the checkout folder as your lasting installation, not both.

## Custom browser data location

For a browser launched with a custom `--user-data-dir`, register there explicitly:

```bash
bash "./native/install.sh" --browser chromium --user-data-dir "/absolute/path/to/browser data"
```

The default native manifests are in `${XDG_CONFIG_HOME:-$HOME/.config}/chromium/NativeMessagingHosts` or `google-chrome/NativeMessagingHosts`. No system-wide registration or sudo is needed. Managed browser policy may prevent unpacked installation; do not bypass it.

## Updates and connection checks

Keep the installation folder in place, preserve local edits before updating, then use the extension’s Reload control on `chrome://extensions`. Re-register the native host if the folder moved. A newly rendered popup or version on disk is not proof that the manifest reloaded: verify the version shown in the settings footer.

If the popup cannot connect, check that the desktop app and native registration are current and use the same browser data location. Registration only confirms files were written, not that a browser-to-app connection succeeded. The popup’s connected status is the final check. Preserve active recordings and work; do not force a browser or recorder restart. Background effects additionally require the desktop effects runtime and supported GPU, and are not available for camera-only capture.

Official installation reference: [Chrome’s unpacked-extension guide](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world). Connection registration reference: [Chrome native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging).
