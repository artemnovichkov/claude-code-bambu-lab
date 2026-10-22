export type Tone = 'ok' | 'info' | 'warn' | 'bad' | 'dim'

export type Temperature = { label: string; current: number; target: number; heating: boolean }

/** `name` is the slot's as the printer labels it: A1…A4, HT, Ext. */
export type Slot = { type: string; color: string; remain: number; active: boolean; empty: boolean; name: string }

/** `humidity` in percent, where the AMS reports it. */
export type AmsUnit = { label: string; slots: Slot[]; humidity?: number }

/** An object on the plate: `id` is what `skip_objects` takes, `box` its corners on the bed in mm. */
export type PlateObject = { id: number; name: string; box: number[]; skipped: boolean }

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
  notices?: string[]
  name?: string
  settings?: string
  objects?: PlateObject[]
  bed?: number[]
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
      /** The object ids picked to skip while the picker is open; null when it's closed. */
      skip: number[] | null
    }
  }
}
