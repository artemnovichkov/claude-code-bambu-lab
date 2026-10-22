import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'bambu',
  component: 'Pane',
  requestId: 'bambu',
  props: {
    title: 'Bambu',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const PRINTING = {
  kind: 'active',
  device: 'Workshop P2S',
  connected: true,
  error: '',
  light: true,
  thumb: '/tmp/plate.png',
  stage: { label: 'Printing', tone: 'ok' },
  hms: [],
  notices: ['Recalibrate the motor noise cancellation.'],
  name: '3DBenchy',
  settings: '0.2mm layer, 2 walls, 15% infill',
  objects: [
    { id: 81, name: 'Hull', box: [40, 40, 100, 100], skipped: false },
    { id: 82, name: 'Hull', box: [140, 40, 200, 100], skipped: false },
    { id: 83, name: 'Hull', box: [90, 140, 150, 200], skipped: true },
  ],
  bed: [0, 0, 256, 256],
  percent: 19,
  layer: 223,
  layers: 386,
  speed: '',
  paused: false,
  left: '2h 37m left',
  done: 'done 17:23',
  temps: [{ label: 'Nozzle', current: 216, target: 220, heating: false }],
  ams: [{ label: 'AMS', slots: [{ type: 'PLA', color: '#FFFFFF', remain: 90, active: true, empty: false, name: 'A1' }] }],
}

const IDLE = {
  kind: 'idle',
  device: 'Workshop P2S',
  connected: true,
  light: true,
  thumb: '',
  stage: { label: 'Finished', tone: 'ok' },
  hms: [],
  last: { name: '0.2mm layer, 2 walls, 15% infill', verb: 'Finished', tone: 'ok', when: '3h ago' },
  temps: [],
  ams: [
    {
      label: 'AMS',
      humidity: 25,
      slots: [
        { type: 'PLA', color: '#161616', remain: 90, active: false, empty: false, name: 'A1' },
        { type: 'PETG', color: '#F5E6A8', remain: -1, active: false, empty: false, name: 'A2' },
        { type: 'PLA', color: '#F95D73', remain: 100, active: true, empty: false, name: 'A3' },
        { type: 'PLA', color: '#FFFFFF', remain: 52, active: false, empty: false, name: 'A4' },
      ],
    },
  ],
}

for (const [name, view] of [['printing', PRINTING], ['idle', IDLE]] as const) {
  test(`the pane draws a ${name} printer on every surface`, async ($, on) => {
    on('command.register', () => ({ value: { command: 'bambu' } }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('fs.read', () => ({ value: { base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==' } }))
    on('ui.log', () => ({ value: undefined }))
    on('ui.toast', () => ({ value: undefined }))
    on('process.spawn', async function* () {
      yield { stream: 'stdout' as const, text: JSON.stringify({ commands: '/tmp/cmd' }) + '\n' }
      yield { stream: 'stdout' as const, text: JSON.stringify({ view }) + '\n' }
      return { value: { code: 0, signal: null } }
    })

    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      if (name === 'printing') {
        expect(await ui.find({ type: 'Text', text: /3DBenchy/ })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: /19%/ })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: /0\.2mm layer, 2 walls, 15% infill/ })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: /Layer 223\/386/ })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: /2h 37m left/ })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: /^! Recalibrate the motor noise/ })).toBeDefined()
        expect(await ui.find({ key: 'stop' })).toBeDefined()
        // Temperatures: icons where Svg draws, names on the terminal.
        expect((await ui.findAll({ type: 'Svg' })).some(svg => svg.props.alt === 'Nozzle')).toBe(surface === 'desktop')
        expect(Boolean(await ui.find({ type: 'Text', text: /^Nozzle 216\/220°C$/ }))).toBe(surface === 'terminal')
        expect(await ui.find({ type: surface === 'terminal' ? 'Image' : 'Svg' })).toBeDefined()
      } else {
        expect(await ui.find({ type: 'Text', text: /Last print/ })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: /3h ago/ })).toBeDefined()
        expect(await ui.find({ key: 'light' })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: /^AMS-A$/ })).toBeDefined()
        if (surface === 'terminal') {
          // Four slots fit 80 columns whole, less the card's frame: one row, with percentages.
          expect(await ui.find({ type: 'Text', text: /^■ PLA 90%.*PLA 52%$/ })).toBeDefined()
          expect(await ui.find({ type: 'Text', text: /^Humidity 25%$/ })).toBeDefined()
        } else {
          // Spools drawn, named for a reader that can't see them.
          const spools = (await ui.findAll({ type: 'Svg' })).map(svg => String(svg.props.alt)).filter(alt => /^A\d /.test(alt))
          expect(spools).toEqual(['A1 PLA 90%', 'A2 PETG', 'A3 PLA 100%', 'A4 PLA 52%'])
          expect(await ui.find({ type: 'Text', text: /^25%$/ })).toBeDefined()
        }
      }
      await ui.unmount()
    }
  })
}

test('a narrow terminal pane drops the AMS percentages, then the types', async ($, on) => {
  on('command.register', () => ({ value: { command: 'bambu' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.log', () => ({ value: undefined }))
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: JSON.stringify({ commands: '/tmp/cmd' }) + '\n' }
    yield { stream: 'stdout' as const, text: JSON.stringify({ view: IDLE }) + '\n' }
    return { value: { code: 0, signal: null } }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const [columns, text] of [[36, /^■ PLA  ■ PETG  ■ PLA  ■ PLA$/], [20, /^■ ■ ■◂ ■$/]] as const) {
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: columns } })
    expect(await ui.find({ type: 'Text', text })).toBeDefined()
    await ui.unmount()
  }
})

test('signed out, the pane offers sign-in and hands it to the bridge', { options: { region: 'china', printer: 'Workshop P2S' } }, async ($, on) => {
  const written: string[] = []
  let env: Record<string, string> | undefined
  on('command.register', () => ({ value: { command: 'bambu' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.log', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 1 }))
  on('fs.write', (_, e) => {
    written.push(`${e.path} ${e.text}`)
    return { value: undefined }
  })
  on('process.spawn', async function* (_, e) {
    env = e.env
    yield { stream: 'stdout' as const, text: JSON.stringify({ commands: '/tmp/cmd' }) + '\n' }
    yield { stream: 'stdout' as const, text: JSON.stringify({ view: { kind: 'signed-out', message: 'Sign in to Bambu Lab' } }) + '\n' }
    return { value: { code: 0, signal: null } }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(env).toEqual({ BAMBU_REGION: 'china', BAMBU_PRINTER: 'Workshop P2S' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'sign-in' })
    await ui.unmount()
  }
  expect(written).toEqual(['/tmp/cmd/1-sign-in.json {"cmd":"sign-in"}', '/tmp/cmd/1-sign-in.json {"cmd":"sign-in"}'])
})

test('skipping objects takes a pick and a second press, then hands the ids to the bridge', async ($, on) => {
  const written: string[] = []
  on('command.register', () => ({ value: { command: 'bambu' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('fs.read', () => ({ value: { base64: '' } }))
  on('clock.now', () => ({ value: 1 }))
  on('fs.write', (_, e) => {
    written.push(`${e.path} ${e.text}`)
    return { value: undefined }
  })
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: JSON.stringify({ commands: '/tmp/cmd' }) + '\n' }
    yield { stream: 'stdout' as const, text: JSON.stringify({ view: PRINTING }) + '\n' }
    return { value: { code: 0, signal: null } }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'skip' })
    // The plate drawing where a surface draws Svg; the terminal has the list alone.
    const plate = (await ui.findAll({ type: 'Svg' })).filter(svg => /plate/.test(String(svg.props.alt)))
    expect(plate).toHaveLength(surface === 'desktop' ? 1 : 0)
    // The skipped object is listed, not offered.
    expect(await ui.find({ key: 'object-83' })).toBeUndefined()
    await ui.press({ key: 'object-81' })
    await ui.press({ key: 'skip-picked' })
    expect(await ui.find({ key: 'skip-confirm' })).toBeDefined()
    await ui.press({ key: 'skip-confirm' })
    expect(await ui.find({ key: 'skip-confirm' })).toBeUndefined()
    await ui.unmount()
  }
  expect(written).toEqual(['/tmp/cmd/1-skip.json {"objects":[81],"cmd":"skip"}', '/tmp/cmd/1-skip.json {"objects":[81],"cmd":"skip"}'])
})

test('picking every object left offers no skip', async ($, on) => {
  const written: string[] = []
  on('command.register', () => ({ value: { command: 'bambu' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.log', () => ({ value: undefined }))
  on('fs.read', () => ({ value: { base64: '' } }))
  on('fs.write', (_, e) => {
    written.push(e.path)
    return { value: undefined }
  })
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: JSON.stringify({ commands: '/tmp/cmd' }) + '\n' }
    yield { stream: 'stdout' as const, text: JSON.stringify({ view: PRINTING }) + '\n' }
    return { value: { code: 0, signal: null } }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'skip' })
  await ui.press({ key: 'object-81' })
  await ui.press({ key: 'object-82' })
  expect(await ui.find({ type: 'Text', text: /every object left/ })).toBeDefined()
  await ui.press({ key: 'skip-picked' })
  expect(await ui.find({ key: 'skip-confirm' })).toBeUndefined()
  await ui.unmount()
  expect(written).toEqual([])
})
