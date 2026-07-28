// The server always lives on 4480 (HTTP + WebSocket). In dev the UI runs on
// the Vite port; packaged, it is served by the server itself. Using
// location.hostname keeps both cases (and future LAN access) working.
//
// EVERY request to the server goes through here -- fetches, and the audio
// element's src. A relative path works packaged and silently returns Vite's
// index.html in dev, which surfaces as "Unexpected token '<'" somewhere far
// from the mistake. There is no exception to this rule.
export const SERVER_PORT = 4480

export const wsUrl = () => `ws://${location.hostname}:${SERVER_PORT}`
export const apiUrl = (path: string) => `http://${location.hostname}:${SERVER_PORT}${path}`
