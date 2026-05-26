# DPAgent Android Client

This is a minimal native Android WebView client for DPAgent frontends.

## Behavior

- Add, edit, and delete client entries manually.
- Each client entry stores a display name, IP, and port, for example `192.168.1.20` and `3000`.
- The WebView opens configured client endpoints with `http://` automatically.
- Add DPAgent shared links from the clipboard when copied text contains `/dpagent-share/<token>`.
- Android `SEND text/plain` and `VIEW http(s)` intents can open valid DPAgent shared links directly.
- Client entries and shared links are stored and displayed separately.
- Expired or unauthorized shared links are removed from the shared-link list after the WebView receives a main-frame 401, 403, 404, or 410 response.
- Tapping `打开` loads the configured frontend or shared link inside the app WebView.
- Entries are stored locally with Android `SharedPreferences`.
- WebView cookie acceptance and third-party cookies are explicitly enabled.

## Build

From this directory:

```powershell
gradle :app:assembleDebug
```

The debug APK is generated at:

```text
app/build/outputs/apk/debug/app-debug.apk
```

For a release APK signed with the same project keystore:

```powershell
gradle :app:assembleRelease
```

Release signing material is intentionally not committed. Copy
`signing/dpagent-client.example.properties` to
`signing/dpagent-client.properties`, place the matching keystore under
`signing/`, and fill in the local passwords before building a release APK.
