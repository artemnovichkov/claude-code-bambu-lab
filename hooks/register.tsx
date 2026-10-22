import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { AmsUnit, PrinterView, Tone } from '../types'

const PANE = 'bambu'
const view = atom({ plugin: 'bambu', key: 'view' } as const, null as PrinterView | null)
const commands = atom({ plugin: 'bambu', key: 'commands' } as const, '')
const confirm = atom({ plugin: 'bambu', key: 'confirm' } as const, '')

const TONES: Record<Tone, string | undefined> = {
  ok: 'success',
  info: 'suggestion',
  warn: 'warning',
  bad: 'error',
  dim: undefined,
}
const BAR = 24
const THUMB_PX = 150

// The plate thumbnails the bridge wrote, base64 by path; a path is one task's.
const thumbs = new Map<string, string>()

function bar(percent: number): string {
  const full = Math.round((Math.max(0, Math.min(100, percent)) / 100) * BAR)

  return '█'.repeat(full) + '░'.repeat(BAR - full)
}

/** A filament's colour, or a theme grey where it would vanish into a dark background. */
function swatch(hex: string): string | undefined {
  const rgb = /^#([0-9A-F]{2})([0-9A-F]{2})([0-9A-F]{2})$/i.exec(hex)
  if (!rgb) return undefined
  const [r, g, b] = rgb.slice(1).map(c => parseInt(c ?? '0', 16) / 255) as [number, number, number]
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b

  return luminance < 0.12 ? 'inactive' : hex
}

type AmsStyle = 'full' | 'types' | 'glyphs'

/** Cells one unit's row takes in a style, as drawn below. */
function amsWidth(unit: AmsUnit, style: AmsStyle): number {
  return unit.slots.reduce((sum, slot, i) => {
    const gap = i ? (style === 'glyphs' ? 1 : 2) : 0
    if (style === 'glyphs') return sum + gap + 1 + (slot.active ? 1 : 0)
    const text = slot.empty ? '—' : slot.type + (style === 'full' && slot.remain >= 0 ? ` ${slot.remain}%` : '')
    return sum + gap + 2 + text.length
  }, unit.label.length + 1)
}

function thumbSvg(png: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
    `width="${THUMB_PX}" height="${THUMB_PX}" viewBox="0 0 ${THUMB_PX} ${THUMB_PX}">` +
    `<image width="${THUMB_PX}" height="${THUMB_PX}" preserveAspectRatio="xMidYMid meet" ` +
    `href="data:image/png;base64,${png}" xlink:href="data:image/png;base64,${png}"/></svg>`
  )
}

/** Drops a command file where the bridge picks it up. */
async function sendCommand($: EngineInterface, cmd: string) {
  await update($, confirm, () => '')
  const dir = await read($, commands)
  if (!dir) {
    $.ui.toast('Bambu: the bridge is not running')
    return
  }
  await $.fs.write(`${dir}/${await $.clock.now()}-${cmd}.json`, JSON.stringify({ cmd }))
}

/** Runs bridge/bridge.py for the session's life, restarting it when it dies. */
async function runBridge($: EngineInterface, options: PluginOptions) {
  const env = { BAMBU_REGION: String(options.region ?? 'global'), BAMBU_PRINTER: String(options.printer ?? '') }
  for (let attempt = 0; attempt < 20; attempt++) {
    let buffer = ''
    try {
      const bridge = $.process.spawn({ argv: ['python3', '-I', `${$.plugin.root}/bridge/bridge.py`], env })
      for await (const { stream, text } of bridge) {
        if (stream === 'stderr') {
          $.ui.log(`bambu: ${text.trim()}`, { to: 'debug' })
          continue
        }
        buffer += text
        let end = buffer.indexOf('\n')
        while (end >= 0) {
          const line = buffer.slice(0, end)
          buffer = buffer.slice(end + 1)
          end = buffer.indexOf('\n')
          let message: { view?: PrinterView; commands?: string; toast?: string; error?: string }
          try {
            message = JSON.parse(line)
          } catch {
            continue
          }
          if (message.view) await update($, view, () => message.view ?? null)
          if (message.commands) await update($, commands, () => message.commands ?? '')
          if (message.toast) $.ui.toast(message.toast)
          if (message.error) $.ui.toast(`Bambu: ${message.error}`)
        }
      }
    } catch (error) {
      $.ui.log(`bambu: bridge stopped: ${String(error)}`, { to: 'debug' })
    }
    try {
      await $.clock.sleep(5000)
    } catch {
      return // unloaded
    }
  }
  await update($, view, () => ({
    kind: 'looking' as const,
    message: 'The bridge keeps stopping; see ~/Library/Application Support/claude-bambu/bridge.log',
  }))
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'bambu',
      description: 'Show the Bambu Lab printer pane, or sign in or out',
      argumentHint: '[sign-in | sign-out | refresh]',
    })
    if (options.pane !== 'command') void $.ui.open({ id: PANE, title: 'Bambu' })
    void runBridge($, options)

    return started
  })

  on('command.run', { command: 'bambu' }, async ($, e) => {
    const cmd = e.args.trim()
    if (cmd === 'sign-in' || cmd === 'sign-out' || cmd === 'refresh') {
      await sendCommand($, cmd)

      return { text: cmd === 'sign-in' ? 'Sign in through the Bambu Lab dialogs.' : `Bambu: ${cmd} sent.` }
    }
    await $.ui.open({ id: PANE, title: 'Bambu' })

    return { text: 'Bambu pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const v = await read($, view)
    const asking = await read($, confirm)

    const send = (cmd: string) => sendCommand($, cmd)

    if (!v) return <Text dimColor>Starting…</Text>
    if (v.kind === 'looking') return <Text dimColor>{v.message}</Text>
    if (v.kind === 'signed-out') {
      return (
        <Box flexDirection="column" gap={1}>
          <Text>{v.message}</Text>
          <Text dimColor>The password goes to Bambu Lab only, through a macOS dialog; the tokens stay in your Keychain.</Text>
          <Box>
            <Button key="sign-in" label="Sign in to Bambu Lab" variant="primary" autoFocus onPress={() => send('sign-in')} />
          </Box>
        </Box>
      )
    }

    let picture = null
    if (v.thumb) {
      let png = thumbs.get(v.thumb)
      if (!png) {
        try {
          png = (await $.fs.read(v.thumb, { as: 'bytes' })).base64
          thumbs.set(v.thumb, png)
        } catch {
          png = undefined
        }
      }
      if (png) {
        if (e.surface === 'terminal') {
          const { Image } = $.ui.resolve(e)
          picture = <Image source={{ png }} columns={20} rows={10} alt=" " />
        } else {
          const { Svg } = $.ui.resolve(e)
          picture = <Svg source={thumbSvg(png)} alt="Plate thumbnail" width={THUMB_PX} height={THUMB_PX} />
        }
      }
    }

    const stage = v.stage ?? { label: 'Idle', tone: 'dim' as Tone }
    const active = v.kind === 'active'
    const head = (
      <Text>
        <Text color={active ? TONES[stage.tone] : undefined} dimColor={!active}>● </Text>
        <Text bold dimColor={v.kind === 'offline' || v.kind === 'waiting'}>
          {active ? stage.label : v.kind === 'offline' ? 'Offline' : v.kind === 'waiting' ? v.message ?? (v.connected ? 'Waiting for the printer…' : 'Connecting…') : 'Idle'}
        </Text>
        {active && v.layers ? <Text dimColor> · layer {v.layer}/{v.layers}</Text> : null}
        {active && v.speed ? <Text color="suggestion"> · {v.speed}</Text> : null}
        {v.device ? <Text dimColor> · {v.device}</Text> : null}
      </Text>
    )

    const temps = v.temps?.length ? (
      <Text>
        {v.temps.map((t, i) => (
          <Text>
            {i ? '  ' : ''}
            <Text dimColor>{t.label} </Text>
            <Text color={t.heating ? 'warning' : undefined}>{t.current}</Text>
            <Text dimColor>{t.target ? `/${t.target}°` : '°'}</Text>
          </Text>
        ))}
      </Text>
    ) : null

    // Each unit on one row, dropping the percentages, then the types, when the row runs out of room.
    const room = Math.max(16, e.props.bodyColumns || 80)
    const ams = (v.ams ?? []).map(unit => {
      const style = (['full', 'types', 'glyphs'] as const).find(s => amsWidth(unit, s) <= room) ?? 'glyphs'

      return (
        <Text wrap="truncate-end">
          <Text dimColor>{unit.label} </Text>
          {unit.slots.map((slot, i) => (
            <Text>
              {i ? (style === 'glyphs' ? ' ' : '  ') : ''}
              <Text color={slot.empty ? undefined : swatch(slot.color)} dimColor={slot.empty}>
                {slot.empty ? '□' : '■'}
              </Text>
              {style === 'glyphs' ? (
                slot.active ? <Text bold>◂</Text> : null
              ) : (
                <Text bold={slot.active} dimColor={!slot.active}>
                  {' '}
                  {slot.empty ? '—' : slot.type}
                  {style === 'full' && !slot.empty && slot.remain >= 0 ? ` ${slot.remain}%` : ''}
                </Text>
              )}
            </Text>
          ))}
        </Text>
      )
    })

    const hms = (v.hms ?? []).map(text => <Text color="error">⚠ {text}</Text>)

    const body = active ? (
      <Box flexDirection="column" flexShrink={1}>
        <Text bold>{v.name}</Text>
        {head}
        <Text>
          <Text bold tabular>{v.percent ?? 0}% </Text>
          {/* Monospaced: █ and ░ differ in width in a proportional face, and the bar grew as it filled. */}
          <Text color={TONES[stage.tone === 'info' ? 'ok' : stage.tone]} mono>
            {bar(v.percent ?? 0)}
          </Text>
        </Text>
        {v.left ? (
          <Text>
            {v.left}
            {v.done ? <Text dimColor> · {v.done}</Text> : null}
          </Text>
        ) : null}
        {hms}
      </Box>
    ) : (
      <Box flexDirection="column" flexShrink={1}>
        {head}
        {v.error && v.kind === 'waiting' ? <Text color="warning">{v.error}</Text> : null}
        {v.last ? (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>Last print</Text>
            <Text bold>{v.last.name}</Text>
            <Text color={TONES[v.last.tone]} dimColor={v.last.tone === 'dim'}>
              {v.last.tone === 'ok' ? '✓ ' : v.last.tone === 'bad' ? '✗ ' : ''}
              {v.last.verb}
              {v.last.when ? ` ${v.last.when}` : ''}
            </Text>
          </Box>
        ) : null}
        {hms}
      </Box>
    )

    const controls = []
    if (asking) {
      controls.push(
        <Button key="confirm" label={asking === 'stop' ? 'Stop the print' : 'Pause the print'} variant="primary" onPress={() => send(asking)} />,
        <Button key="cancel" label="Cancel" onPress={() => update($, confirm, () => '')} />,
      )
    } else {
      if (active && v.connected) {
        if (v.paused) {
          controls.push(<Button key="resume" label="Resume" hotkey="p" onPress={() => send('resume')} />)
        } else {
          controls.push(<Button key="pause" label="Pause" hotkey="p" onPress={() => update($, confirm, () => 'pause')} />)
        }
        controls.push(<Button key="stop" label="Stop" hotkey="x" onPress={() => update($, confirm, () => 'stop')} />)
      }
      if (v.connected && v.kind !== 'offline') {
        controls.push(
          <Button key="light" label={v.light ? 'Turn the light off' : 'Turn the light on'} hotkey="i" onPress={() => send('light')} />,
        )
      }
      controls.push(
        <Button
          key="studio"
          label="Open Bambu Studio"
          hotkey="o"
          onPress={async () => {
            const { exitCode } = await $.process.run(['open', '-a', 'BambuStudio'])
            if (exitCode !== 0) $.ui.toast("Bambu Studio isn't installed")
          }}
        />,
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={2} alignItems="center">
          {picture}
          {body}
        </Box>
        {temps || ams.length ? (
          <Box flexDirection="column">
            {temps}
            {ams}
          </Box>
        ) : null}
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          {controls}
        </Box>
      </Box>
    )
  })
}
