// The server always lives on 4480 (HTTP + WebSocket). In dev the UI runs on
// the Vite port; packaged, it is served by the server itself. Using
// location.hostname keeps both cases (and future LAN access) working.
export const SERVER_PORT = 4480

export const wsUrl = () => `ws://${location.hostname}:${SERVER_PORT}`
export const apiUrl = (path: string) => `http://${location.hostname}:${SERVER_PORT}${path}`
