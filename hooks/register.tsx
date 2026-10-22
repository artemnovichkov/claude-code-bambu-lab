import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { AmsUnit, PlateObject, PrinterView, Slot, Tone } from '../types'

const PANE = 'bambu'
const view = atom({ plugin: 'bambu', key: 'view' } as const, null as PrinterView | null)
const commands = atom({ plugin: 'bambu', key: 'commands' } as const, '')
const confirm = atom({ plugin: 'bambu', key: 'confirm' } as const, '')
const skip = atom({ plugin: 'bambu', key: 'skip' } as const, null as number[] | null)

const TONES: Record<Tone, string | undefined> = {
  ok: 'success',
  info: 'suggestion',
  warn: 'warning',
  bad: 'error',
  dim: undefined,
}
const THUMB_PX = 150
// Square in cells half as wide as tall, and as tall as the text beside it.
const THUMB_COLUMNS = 14
const PLATE_PX = 220
const BAR_PX = 360
const SLOT_PX = 84
const FONT = 'font-family="-apple-system, Helvetica, sans-serif"'
// Bambu's own green, for the progress bar and picked objects.
const GREEN = '#00AE42'
// Text presentation, so a desktop draws the glyph rather than an emoji.
const TEXT_GLYPH = '\uFE0E'

const icon = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#9A9A9A" ` +
  `stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
const wave = (x: number, y: number, h: number) => `M${x} ${y}q1.1 ${h / 4} 0 ${h / 2}t0 ${h / 2}`

/** Drawn for this mod, after the shapes Bambu's app uses: a hotend, a heated plate, a heated box. */
const ICONS: Record<string, string> = {
  Nozzle: icon(`<rect x="3.5" y="1.5" width="9" height="7" rx="1.2"/><path d="M6 8.5l1 4h2l1-4M8 12.5v2"/>`),
  Bed: icon(`<path d="${wave(4.5, 1.5, 7)}${wave(8, 1.5, 7)}${wave(11.5, 1.5, 7)}"/><rect x="1.5" y="11" width="13" height="3" rx="1"/>`),
  Humidity: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">` +
    `<path d="M8 1.5S3 7.2 3 10.2a5 5 0 0 0 10 0C13 7.2 8 1.5 8 1.5Z" fill="#4A90E2"/></svg>`,
  Chamber: icon(`<rect x="1.5" y="1.5" width="13" height="13" rx="2.5"/><path d="${wave(5.2, 5, 6)}${wave(8, 5, 6)}${wave(10.8, 5, 6)}"/>`),
}

// The plate thumbnails the bridge wrote, base64 by path; a path is one task's.
const thumbs = new Map<string, string>()

/** The filled and the empty part of a bar `cells` long: one glyph for both, so they share a width in any face. */
function bar(percent: number, cells: number): [string, string] {
  const full = Math.round((Math.max(0, Math.min(100, percent)) / 100) * cells)

  return ['━'.repeat(full), '━'.repeat(cells - full)]
}

/** 0 for black to 1 for white; undefined for anything but `#RRGGBB`. */
function luminance(hex: string): number | undefined {
  const rgb = /^#([0-9A-F]{2})([0-9A-F]{2})([0-9A-F]{2})$/i.exec(hex)
  if (!rgb) return undefined
  const [r, g, b] = rgb.slice(1).map(c => parseInt(c ?? '0', 16) / 255) as [number, number, number]

  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** A filament's colour, or a theme grey where it would vanish into a dark background. */
function swatch(hex: string): string | undefined {
  const l = luminance(hex)
  if (l === undefined) return undefined

  return l < 0.12 ? 'inactive' : hex
}

/** One spool from the side in its filament's colour, as the app draws an AMS slot. */
function spoolSvg(slot: Slot): string {
  const width = SLOT_PX
  const height = 150
  const cx = width / 2
  const cy = 84
  // The front flange right of centre, so the back one and the winding's round end show on the left.
  const front = cx + 14
  const color = slot.color || '#9A9A9A'
  let out = ''
  if (!slot.empty) {
    out += `<text x="${cx}" y="13" ${FONT} font-size="13" fill="#9A9A9A" text-anchor="middle">${slot.type.replace(/[<>&"]/g, '')}</text>`
  }
  if (slot.remain >= 0) {
    const w = 34
    out +=
      `<rect x="${cx - w / 2}" y="21" width="${w}" height="5" rx="2.5" fill="#80808033" stroke="#8C8C8C" stroke-width="0.5"/>` +
      `<rect x="${cx - w / 2}" y="21" width="${Math.max(2.5, (w * Math.min(100, slot.remain)) / 100)}" height="5" rx="2.5" fill="${color}"/>`
  }
  // The filament feeding the nozzle hangs below its spool, from behind the winding, in the gap between the flanges.
  if (slot.active && !slot.empty) {
    out +=
      `<defs><linearGradient id="feed" x1="0" y1="0" x2="0" y2="1"><stop offset="0.45" stop-color="${color}"/>` +
      `<stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>` +
      `<rect x="${front - 17}" y="${cy}" width="4" height="${height - cy}" fill="url(#feed)" stroke="#00000033" stroke-width="0.5"/>`
  }
  // An empty slot is just its name where the spool would be.
  if (slot.empty) {
    out += `<text x="${cx}" y="${cy + 5}" ${FONT} font-size="14" font-weight="600" fill="#9A9A9A" text-anchor="middle">${slot.name}</text>`

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${out}</svg>`
  }
  // The back flange, the winding (a cylinder, shaded round), the front flange and its hub.
  out += `<ellipse cx="${front - 30}" cy="${cy}" rx="14" ry="38" fill="#353535"/>`
  if (!slot.empty) {
    const winding = `M${front} ${cy - 31}H${front - 29}A10 31 0 0 0 ${front - 29} ${cy + 31}H${front}Z`
    out +=
      `<defs><linearGradient id="round" x1="0" y1="0" x2="0" y2="1">` +
      `<stop offset="0" stop-color="#000" stop-opacity="0.35"/><stop offset="0.3" stop-color="#fff" stop-opacity="0.12"/>` +
      `<stop offset="0.55" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.4"/></linearGradient></defs>` +
      `<path d="${winding}" fill="${color}"/><path d="${winding}" fill="url(#round)"/>`
  }
  const ink = slot.empty ? '#9A9A9A' : (luminance(color) ?? 0) > 0.6 ? '#1A1A1A' : '#FFFFFF'
  out +=
    `<ellipse cx="${front}" cy="${cy}" rx="14" ry="38" fill="#4E4E4E"/>` +
    `<ellipse cx="${front + 1}" cy="${cy}" rx="3" ry="9" fill="#2E2E2E"/>` +
    `<text x="${front - 24}" y="${cy + 5}" ${FONT} font-size="14" font-weight="600" fill="${ink}" text-anchor="middle">${slot.name}</text>`

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${out}</svg>`
}

type AmsStyle = 'full' | 'types' | 'glyphs'

/** Cells one unit's row takes in a style, as drawn below. */
function amsWidth(unit: AmsUnit, style: AmsStyle): number {
  return unit.slots.reduce((sum, slot, i) => {
    const gap = i ? (style === 'glyphs' ? 1 : 2) : 0
    if (style === 'glyphs') return sum + gap + 1 + (slot.active ? 1 : 0)
    const text = slot.empty ? '—' : slot.type + (style === 'full' && slot.remain >= 0 ? ` ${slot.remain}%` : '')
    return sum + gap + 2 + text.length
  }, 0)
}

/** The thumbnail on a plate-like square, as the app shows it. */
function thumbSvg(png: string): string {
  const inset = 14

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
    `width="${THUMB_PX}" height="${THUMB_PX}" viewBox="0 0 ${THUMB_PX} ${THUMB_PX}">` +
    `<rect width="${THUMB_PX}" height="${THUMB_PX}" rx="10" fill="#80808026"/>` +
    `<image x="${inset}" y="${inset}" width="${THUMB_PX - 2 * inset}" height="${THUMB_PX - 2 * inset}" preserveAspectRatio="xMidYMid meet" ` +
    `href="data:image/png;base64,${png}" xlink:href="data:image/png;base64,${png}"/></svg>`
  )
}

/** A rounded progress bar; the surface scales it down to a narrower column. */
function barSvg(percent: number, color: string): string {
  const fill = (Math.max(0, Math.min(100, percent)) / 100) * BAR_PX

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${BAR_PX}" height="8" viewBox="0 0 ${BAR_PX} 8">` +
    `<rect width="${BAR_PX}" height="8" rx="4" fill="#80808040"/>` +
    (fill > 0 ? `<rect width="${Math.max(8, fill)}" height="8" rx="4" fill="${color}"/>` : '') +
    `</svg>`
  )
}

/** The bed seen from above, front edge down, each object numbered as the picker lists it. */
function plateSvg(objects: PlateObject[], bed: number[], picked: number[]): string {
  const [x0 = 0, y0 = 0, x1 = 256, y1 = 256] = bed
  const scale = (PLATE_PX - 8) / Math.max(x1 - x0, y1 - y0, 1)
  const width = Math.round((x1 - x0) * scale) + 8
  const height = Math.round((y1 - y0) * scale) + 8
  const shapes = objects.map((o, i) => {
    const [ax = 0, ay = 0, bx = 0, by = 0] = o.box
    const x = 4 + (ax - x0) * scale
    const y = 4 + (y1 - by) * scale
    const w = Math.max(4, (bx - ax) * scale)
    const h = Math.max(4, (by - ay) * scale)
    const size = Math.max(9, Math.min(16, Math.min(w, h) * 0.6))
    const on = picked.includes(o.id)
    const rect = o.skipped
      ? `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3" fill="none" stroke="#8C8C8C" stroke-dasharray="3 3"/>`
      : `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3" fill="${on ? GREEN : '#9A9A9A'}" stroke="${on ? GREEN : '#6E6E6E'}"/>`

    return (
      rect +
      `<text x="${x + w / 2}" y="${y + h / 2}" font-family="-apple-system, Helvetica, sans-serif" font-size="${size}" font-weight="600" ` +
      `fill="${o.skipped ? '#8C8C8C' : '#FFFFFF'}" text-anchor="middle" dominant-baseline="central">${i + 1}</text>`
    )
  })

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="6" fill="#8080801F" stroke="#80808066"/>` +
    shapes.join('') +
    `</svg>`
  )
}

/** Drops a command file where the bridge picks it up. */
async function sendCommand($: EngineInterface, cmd: string, extra: Record<string, unknown> = {}) {
  await update($, confirm, () => '')
  const dir = await read($, commands)
  if (!dir) {
    $.ui.toast('Bambu: the bridge is not running')
    return
  }
  await $.fs.write(`${dir}/${await $.clock.now()}-${cmd}.json`, JSON.stringify({ ...extra, cmd }))
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
          if (message.view) {
            await update($, view, () => message.view ?? null)
            // A pick belongs to one print.
            if (message.view.kind !== 'active') await update($, skip, () => null)
          }
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
    const picking = await read($, skip)

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
          picture = <Image source={{ png }} columns={THUMB_COLUMNS} rows={THUMB_COLUMNS / 2} alt=" " />
        } else {
          const { Svg } = $.ui.resolve(e)
          picture = <Svg source={thumbSvg(png)} alt="Plate thumbnail" width={THUMB_PX} height={THUMB_PX} />
        }
      }
    }

    const stage = v.stage ?? { label: 'Idle', tone: 'dim' as Tone }
    const active = v.kind === 'active'
    const room = Math.max(16, e.props.bodyColumns || 80)
    // A terminal's gap is a whole blank row, on top of the rows the frames take: between framed blocks the frames space it enough.
    const spacing = e.surface === 'terminal' ? 0 : 1

    const head = (
      <Text>
        <Text color={active ? TONES[stage.tone] : undefined} dimColor={!active}>● </Text>
        <Text bold dimColor={v.kind === 'offline' || v.kind === 'waiting'}>
          {active ? stage.label : v.kind === 'offline' ? 'Offline' : v.kind === 'waiting' ? v.message ?? (v.connected ? 'Waiting for the printer…' : 'Connecting…') : 'Idle'}
        </Text>
        {active && v.speed ? <Text color="suggestion"> · {v.speed}</Text> : null}
        {v.device ? <Text dimColor> · {v.device}</Text> : null}
      </Text>
    )

    // Chips, as the printer's screen and the app draw them: an icon where the surface draws Svg, else the name.
    const chip = (t: NonNullable<PrinterView['temps']>[number]) => {
      const reading = (
        <Text>
          {e.surface === 'terminal' || !ICONS[t.label] ? <Text dimColor>{t.label} </Text> : null}
          <Text size="heading" weight="bold" color={t.heating ? 'warning' : undefined} tabular>
            {t.current}
          </Text>
          <Text dimColor size="footnote">
            {t.target ? `/${t.target}°C` : '°C'}
          </Text>
        </Text>
      )
      if (e.surface === 'terminal' || !ICONS[t.label]) return reading
      const { Svg } = $.ui.resolve(e)

      return (
        <Box flexDirection="row" alignItems="center" gap="xs">
          <Svg source={ICONS[t.label] ?? ''} alt={t.label} width={16} height={16} />
          {reading}
        </Box>
      )
    }
    const temps = v.temps?.length ? (
      <Box flexDirection="row" flexWrap="wrap" gap={1}>
        {v.temps.map(t => (
          <Box borderStyle="round" borderDimColor paddingX={1}>
            {chip(t)}
          </Box>
        ))}
      </Box>
    ) : null

    // One card per unit, titled as the app does, with its humidity in the corner.
    const amsCard = (unit: AmsUnit) => {
      let humidity = null
      let slots
      if (e.surface === 'terminal') {
        // A row of slots, dropping the percentages, then the types, when it runs out of room inside the frame.
        const style = (['full', 'types', 'glyphs'] as const).find(s => amsWidth(unit, s) <= room - 4) ?? 'glyphs'
        if (unit.humidity !== undefined) {
          humidity = (
            <Text>
              <Text dimColor>Humidity </Text>
              {unit.humidity}%
            </Text>
          )
        }
        slots = (
          <Text wrap="truncate-end">
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
      } else {
        // Spools, spread across the card.
        const { Svg } = $.ui.resolve(e)
        if (unit.humidity !== undefined) {
          humidity = (
            <Box flexDirection="row" alignItems="center" gap="xs">
              <Svg source={ICONS.Humidity ?? ''} alt="Humidity" width={14} height={14} />
              <Text>{unit.humidity}%</Text>
            </Box>
          )
        }
        slots = (
          <Box flexDirection="row" justifyContent="space-around">
            {unit.slots.map(slot => (
              <Svg source={spoolSvg(slot)} alt={`${slot.name} ${slot.empty ? 'empty' : slot.type}${slot.remain >= 0 ? ` ${slot.remain}%` : ''}`} />
            ))}
          </Box>
        )
      }

      return (
        <Box flexDirection="column" flexGrow={unit.slots.length} gap={spacing} borderStyle="round" borderDimColor paddingX={1}>
          <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={2}>
            <Text bold>{unit.label.startsWith('AMS') ? `AMS-${unit.slots[0]?.name.slice(0, 1) ?? 'A'}` : unit.label}</Text>
            {humidity}
          </Box>
          {slots}
        </Box>
      )
    }
    const ams = v.ams?.length ? (
      <Box flexDirection="row" flexWrap="wrap" gap={1}>
        {v.ams.map(amsCard)}
      </Box>
    ) : null

    const hms = (v.hms ?? []).map(text => (
      <Box borderStyle="round" borderColor="error" paddingX={1}>
        <Text color="error">⚠ {text}</Text>
      </Box>
    ))
    // The printer's notices, in the app's green banner.
    const notices = (v.notices ?? []).map(text => (
      <Box borderStyle="round" borderColor="success" paddingX={1}>
        <Text>
          <Text color="success" bold>
            !{' '}
          </Text>
          {text}
        </Text>
      </Box>
    ))

    // Hotkeys where a keyboard drives the pane; a desktop draws them as badges that crowd the buttons.
    const key = (letter: string) => (e.surface === 'terminal' ? { hotkey: letter } : {})

    const objects = v.objects ?? []
    const left = objects.filter(o => !o.skipped)
    const picks = (picking ?? []).filter(id => left.some(o => o.id === id))

    const jobButtons = []
    if (asking === 'pause' || asking === 'stop') {
      jobButtons.push(
        <Button key="confirm" label={asking === 'stop' ? 'Stop the print' : 'Pause the print'} variant="primary" onPress={() => send(asking)} />,
        <Button key="cancel" label="Cancel" onPress={() => update($, confirm, () => '')} />,
      )
    } else if (active && v.connected) {
      jobButtons.push(
        <Button
          key="skip"
          // A terminal draws ⏭ two cells wide over the space after it; ⇥ is one cell everywhere.
          label={e.surface === 'terminal' ? '⇥ Skip' : `⏭${TEXT_GLYPH} Skip`}
          {...key('s')}
          dimColor={left.length < 2}
          onPress={() =>
            left.length < 2
              ? $.ui.toast(objects.length ? 'Bambu: one object left on the plate; nothing to skip' : "Bambu: this print's objects aren't known yet")
              : update($, skip, p => (p ? null : []))
          }
        />,
      )
      if (v.paused) {
        jobButtons.push(<Button key="resume" label={`▶${TEXT_GLYPH} Resume`} {...key('p')} onPress={() => send('resume')} />)
      } else {
        jobButtons.push(<Button key="pause" label={`⏸${TEXT_GLYPH} Pause`} {...key('p')} onPress={() => update($, confirm, () => 'pause')} />)
      }
      jobButtons.push(<Button key="stop" label={`⏹${TEXT_GLYPH} Stop`} {...key('x')} onPress={() => update($, confirm, () => 'stop')} />)
    }

    let card
    if (active) {
      // The bar fills the text column: the pane less the card's frame and the thumbnail beside it.
      const cells = Math.max(8, Math.min(48, room - 4 - (picture ? THUMB_COLUMNS + 2 : 0)))
      const [filled, empty] = bar(v.percent ?? 0, cells)
      const tone = stage.tone === 'warn' ? 'warning' : stage.tone === 'bad' ? 'error' : GREEN
      let progress = (
        <Text mono wrap="truncate-end">
          <Text color={tone}>{filled}</Text>
          <Text dimColor>{empty}</Text>
        </Text>
      )
      if (e.surface !== 'terminal') {
        const { Svg } = $.ui.resolve(e)
        const hex = tone === 'warning' ? '#E5A50A' : tone === 'error' ? '#E5484D' : GREEN
        progress = <Svg source={barSvg(v.percent ?? 0, hex)} alt={`${v.percent ?? 0}% printed`} />
      }
      card = (
        <Box flexDirection="column" gap={1} borderStyle="round" borderDimColor paddingX={1}>
          <Box flexDirection="row" gap={2} alignItems="center">
            {picture}
            {/* minWidth 0: the bar's own width must not hold the column wider than a narrow pane. */}
            <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
              <Text bold wrap="truncate-end">
                {v.name}
              </Text>
              {v.settings ? (
                <Text dimColor wrap="truncate-end">
                  {v.settings}
                </Text>
              ) : null}
              <Box flexDirection="row" justifyContent="space-between" alignItems="flex-end" gap={2} marginTop={1}>
                <Text weight="bold">
                  <Text size="title" tabular>
                    {v.percent ?? 0}
                  </Text>
                  <Text size="heading">%</Text>
                </Text>
                {v.left ? <Text>{v.left}</Text> : null}
              </Box>
              {progress}
              <Text dimColor>
                {v.layers ? `Layer ${v.layer}/${v.layers}` : stage.label}
                {v.done ? ` · ${v.done}` : ''}
              </Text>
            </Box>
          </Box>
          {jobButtons.length ? (
            <Box flexDirection="row" gap={1} flexWrap="wrap">
              {jobButtons}
            </Box>
          ) : null}
        </Box>
      )
    } else if (picture || v.last || (v.error && v.kind === 'waiting')) {
      card = (
        <Box flexDirection="row" gap={2} alignItems="center">
          {picture}
          <Box flexDirection="column" flexShrink={1}>
            {v.error && v.kind === 'waiting' ? <Text color="warning">{v.error}</Text> : null}
            {v.last ? (
              <Box flexDirection="column">
                <Text dimColor>Last print</Text>
                <Text bold>{v.last.name}</Text>
                <Text color={TONES[v.last.tone]} dimColor={v.last.tone === 'dim'}>
                  {v.last.tone === 'ok' ? '✓ ' : v.last.tone === 'bad' ? '✗ ' : ''}
                  {v.last.verb}
                  {v.last.when ? ` ${v.last.when}` : ''}
                </Text>
              </Box>
            ) : null}
          </Box>
        </Box>
      )
    }

    // Skipping is for good, so it takes a pick and then a second press.
    let picker = null
    if (active && picking && left.length > 1) {
      const every = picks.length >= left.length
      const count = `${picks.length} object${picks.length === 1 ? '' : 's'}`
      let plate = null
      if (e.surface !== 'terminal') {
        const { Svg } = $.ui.resolve(e)
        plate = <Svg source={plateSvg(objects, v.bed ?? [], picks)} alt="The plate, its objects numbered" />
      }
      picker = (
        <Box flexDirection="column" gap={1} borderStyle="round" borderDimColor paddingX={1}>
          <Text>
            <Text bold>Skip objects</Text>
            <Text dimColor> · the printer leaves the picked ones unfinished</Text>
          </Text>
          {plate}
          <Box flexDirection="row" flexWrap="wrap" gap={1}>
            {objects.map((o, i) =>
              o.skipped ? (
                <Text dimColor strikethrough>
                  {i + 1} {o.name}
                </Text>
              ) : (
                <Button
                  key={`object-${o.id}`}
                  label={`${picks.includes(o.id) ? '✓' : '○'} ${i + 1} ${o.name}`}
                  variant={picks.includes(o.id) ? 'primary' : undefined}
                  onPress={async () => {
                    await update($, confirm, () => '')
                    await update($, skip, p => (p ? (p.includes(o.id) ? p.filter(id => id !== o.id) : [...p, o.id]) : p))
                  }}
                />
              ),
            )}
          </Box>
          {every ? <Text color="warning">That's every object left; stop the print instead.</Text> : null}
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            {asking === 'skip'
              ? [
                  <Button
                    key="skip-confirm"
                    label={`Skip ${count} for good`}
                    variant="primary"
                    onPress={async () => {
                      let ids: number[] = []
                      await update($, skip, p => {
                        ids = p ?? []
                        return null
                      })
                      await sendCommand($, 'skip', { objects: ids })
                    }}
                  />,
                  <Button key="skip-back" label="Back" onPress={() => update($, confirm, () => '')} />,
                ]
              : [
                  <Button
                    key="skip-picked"
                    label={picks.length ? `Skip ${count}…` : 'Pick objects to skip'}
                    variant={picks.length && !every ? 'primary' : undefined}
                    dimColor={!picks.length || every}
                    onPress={() => (picks.length && !every ? update($, confirm, () => 'skip') : undefined)}
                  />,
                  <Button
                    key="skip-cancel"
                    label="Cancel"
                    onPress={async () => {
                      await update($, confirm, () => '')
                      await update($, skip, () => null)
                    }}
                  />,
                ]}
          </Box>
        </Box>
      )
    }

    const controls = []
    if (v.connected && v.kind !== 'offline') {
      controls.push(
        <Button key="light" label={v.light ? 'Turn the light off' : 'Turn the light on'} {...key('i')} onPress={() => send('light')} />,
      )
    }
    controls.push(
      <Button
        key="studio"
        label="Open Bambu Studio"
        {...key('o')}
        onPress={async () => {
          const { exitCode } = await $.process.run(['open', '-a', 'BambuStudio'])
          if (exitCode !== 0) $.ui.toast("Bambu Studio isn't installed")
        }}
      />,
    )

    return (
      <Box flexDirection="column" gap={spacing}>
        {head}
        {temps}
        {hms.length || notices.length ? (
          <Box flexDirection="column">
            {hms}
            {notices}
          </Box>
        ) : null}
        {card}
        {picker}
        {ams}
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          {controls}
        </Box>
      </Box>
    )
  })
}
