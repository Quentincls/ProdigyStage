// The palette, for the parts of the UI that are painted rather than styled.
//
// The timeline, the mini-map and the DMX monitor draw into a canvas, where CSS
// variables do not reach. They used to carry their own copies of the hex codes,
// which is how a stylesheet and a canvas drift apart. These read the same
// `:root` variables the stylesheet defines, so the palette keeps one definition.
//
// Resolved once: the theme does not change while the app runs, and this is read
// from inside 60 fps draw loops.

const cache = new Map<string, string>()

export function cssVar(name: string, fallback: string): string {
  const hit = cache.get(name)
  if (hit !== undefined) return hit
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  const resolved = value || fallback
  cache.set(name, resolved)
  return resolved
}

export const theme = {
  get text(): string {
    return cssVar('--text', '#f4f5f7')
  },
  get textDim(): string {
    return cssVar('--text-dim', '#858b96')
  },
  get panel(): string {
    return cssVar('--panel', '#08090b')
  },
  get border(): string {
    return cssVar('--border', '#1c1f26')
  },
  get borderStrong(): string {
    return cssVar('--border-strong', '#2c313b')
  },
  get accent(): string {
    return cssVar('--accent', '#2563ff')
  },
  get accentBright(): string {
    return cssVar('--accent-bright', '#7aa2ff')
  },
  get ok(): string {
    return cssVar('--ok', '#3ecf8e')
  },
  get warn(): string {
    return cssVar('--warn', '#f5a623')
  },
  get down(): string {
    return cssVar('--down', '#e5484d')
  },
  get edit(): string {
    return cssVar('--edit', '#a78bfa')
  },
}
