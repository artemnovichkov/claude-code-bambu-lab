export type Tone = 'ok' | 'info' | 'warn' | 'bad' | 'dim'

export type Temperature = { label: string; current: number; target: number; heating: boolean }

export type Slot = { type: string; color: string; remain: number; active: boolean; empty: boolean }

export type AmsUnit = { label: string; slots: Slot[] }

/** What bridge/bridge.py prints as `{"view": ...}`. */
export type PrinterView = {
  kind: 'signed-out' | 'looking' | 'offline' | 'waiting' | 'active' | 'idle'
  message?: string
  device?: string
  connected?: boolean
  error?: string
  light?: boolean | null
  thumb?: string
  stage?: { label: string; tone: Tone }
  hms?: string[]
  name?: string
  percent?: number
  layer?: number
  layers?: number
  speed?: string
  paused?: boolean
  left?: string
  done?: string
  temps?: Temperature[]
  ams?: AmsUnit[]
  last?: { name: string; verb: string; tone: Tone; when: string }
}

declare module 'claude-code' {
  interface PluginState {
    bambu: {
      view: PrinterView | null
      commands: string
      confirm: string
    }
  }
}
