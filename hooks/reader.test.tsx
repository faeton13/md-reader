import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'md-reader',
  component: 'Pane',
  requestId: 'md-reader',
  props: {
    title: 'Чтение вслух',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const DOC = {
  title: 'Глава',
  skipped: 0,
  blocks: [
    { md: '```\nкод\n```', audio: null },
    { md: 'Первая часть', audio: '/cache/1.mp3' },
    { md: 'Вторая часть', audio: '/cache/2.mp3' },
  ],
}

const engineAnswers = (stdout: string, exitCode = 0, stderr = '') => ({
  value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
})

const session = { cwd: '/', surface: 'desktop', isInteractive: true } as const

const stand = (on, played: string[], engine = engineAnswers(JSON.stringify(DOC))) => {
  on('command.register', () => ({ value: { command: 'read' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__md-reader__read_aloud' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('process.run', () => engine)
  on('fs.read', (_, e) => ({ value: { base64: String(e.path) } }))
  on('audio.play', (_, e) => {
    played.push(String(e.clip?.base64 ?? e.base64))

    return { value: undefined }
  })
}

test('a path typed in the panel plays the spoken blocks and skips code', async ($, on) => {
  const played: string[] = []
  stand(on, played)
  await $.session.start(session)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.input({ key: 'path', text: 'a.md' })

  expect(played).toEqual(['/cache/1.mp3', '/cache/2.mp3'])
  await ui.unmount()
})

test('/read starts reading and says what it reads', async ($, on) => {
  const played: string[] = []
  let finished = () => {}
  const done = new Promise<void>(resolve => {
    finished = resolve
  })
  stand(on, played)
  on('state.set', (_, e, next) => {
    if (e.key === 'reader' && e.value?.value?.phase === 'idle' && played.length === 2) finished()

    return next(e)
  })
  await $.session.start(session)

  const ran = await $.command.run({ command: 'read', args: 'a.md' })
  await done

  expect(ran.text).toBe('Читаю вслух: a.md')
  expect(played).toEqual(['/cache/1.mp3', '/cache/2.mp3'])
})

test('the panel says which part is read, on every surface', async ($, on) => {
  stand(on, [])
  await $.session.start(session)

  const first = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await first.input({ key: 'path', text: 'a.md' })
  await first.unmount()

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /Глава/ }))?.text).toBe('Глава')
    expect((await ui.find({ type: 'Text', text: /Часть/ }))?.text).toBe('Часть 1 из 2')
    await ui.unmount()
  }
})

test('an engine failure is shown and nothing plays', async ($, on) => {
  const played: string[] = []
  stand(on, played, engineAnswers('', 1, 'trace\nffmpeg not found'))
  await $.session.start(session)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.input({ key: 'path', text: 'a.md' })

  expect((await ui.find({ type: 'Text', text: /ffmpeg/ }))?.text).toBe('ffmpeg not found')
  expect(played).toEqual([])
  await ui.unmount()
})

// Stands for the engine: a retime answers the clip at that tempo.
const engineFor = (calls: string[][] = []) => (_, e) => {
  calls.push([...e.argv])
  const retime = e.argv.indexOf('--retime')
  if (retime < 0) return engineAnswers(JSON.stringify(DOC))

  return engineAnswers(`${e.argv.at(-1).replace('.mp3', `.x${e.argv[retime + 1]}.mp3`)}\n`)
}

test('a speed picked while reading restarts the part at that speed', async ($, on) => {
  const played: string[] = []
  const calls: string[][] = []
  let press = async () => {}
  on('command.register', () => ({ value: { command: 'read' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__md-reader__read_aloud' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', engineFor(calls))
  on('fs.read', (_, e) => ({ value: { base64: String(e.path) } }))
  on('audio.play', async (_, e) => {
    played.push(String(e.clip?.base64 ?? e.base64))
    if (played.length === 2) await press()

    return { value: undefined }
  })
  await $.session.start(session)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  press = () => ui.press({ key: 'speed-1.5' })
  await ui.input({ key: 'path', text: 'a.md' })
  await until(() => played.length === 3)

  expect(played).toEqual(['/cache/1.mp3', '/cache/2.mp3', '/cache/2.x1.5.mp3'])
  expect(calls.filter(argv => !argv.includes('--retime'))).toHaveLength(1)
  await ui.unmount()
})

test('a speed picked before reading holds from the first part', async ($, on) => {
  const played: string[] = []
  on('command.register', () => ({ value: { command: 'read' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__md-reader__read_aloud' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', engineFor())
  on('fs.read', (_, e) => ({ value: { base64: String(e.path) } }))
  on('audio.play', (_, e) => {
    played.push(String(e.clip?.base64 ?? e.base64))

    return { value: undefined }
  })
  await $.session.start(session)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'speed-2' })
  await settled()
  await ui.input({ key: 'path', text: 'a.md' })
  await until(() => played.length === 2)

  expect(played).toEqual(['/cache/1.x2.mp3', '/cache/2.x2.mp3'])
  await ui.unmount()
})

test('a speed needs no file path, so it works on a panel reopened with /read', async ($, on) => {
  const played: string[] = []
  const calls: string[][] = []
  on('command.register', () => ({ value: { command: 'read' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__md-reader__read_aloud' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('process.run', engineFor(calls))
  on('fs.read', (_, e) => ({ value: { base64: String(e.path) } }))
  on('audio.play', (_, e) => {
    played.push(String(e.clip?.base64 ?? e.base64))

    return { value: undefined }
  })
  await $.session.start(session)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.input({ key: 'path', text: 'a.md' })
  await until(() => played.length === 2)
  await $.command.run({ command: 'read', args: '' })
  await ui.press({ key: 'speed-0.75' })
  await settled()
  await ui.press({ key: 'play' })
  await until(() => played.length === 4)

  expect(played.slice(2)).toEqual(['/cache/1.x0.75.mp3', '/cache/2.x0.75.mp3'])
  expect(calls.filter(argv => !argv.includes('--retime'))).toHaveLength(1)
  await ui.unmount()
})

test('a file pressed in the list is read, and the list leaves only MD and folders', async ($, on) => {
  const played: string[] = []
  const calls: string[][] = []
  const entry = (name: string, kind: string) => ({ name, kind, size: 0, mtimeMs: 0, isLink: false })
  on('command.register', () => ({ value: { command: 'read' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__md-reader__read_aloud' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.list', (_, e) => ({
    value: e.path.endsWith('docs')
      ? [entry('c.md', 'file')]
      : [
          entry('docs', 'dir'),
          entry('.git', 'dir'),
          entry('a.md', 'file'),
          entry('b.txt', 'file'),
          { ...entry('current', 'other'), isLink: true },
        ],
  }))
  on('process.run', (_, e) => {
    calls.push([...e.argv])

    return engineAnswers(JSON.stringify(DOC))
  })
  on('fs.read', (_, e) => ({ value: { base64: String(e.path) } }))
  on('audio.play', (_, e) => {
    played.push(String(e.clip?.base64 ?? e.base64))

    return { value: undefined }
  })
  await $.session.start(session)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'files' })
  expect(await ui.find({ key: 'entry-a.md' })).toBeTruthy()
  expect(await ui.find({ key: 'entry-b.txt' })).toBeFalsy()
  expect(await ui.find({ key: 'entry-.git' })).toBeFalsy()
  expect(await ui.find({ key: 'entry-current' })).toBeTruthy()

  await ui.press({ key: 'entry-docs' })
  await ui.press({ key: 'entry-c.md' })

  expect(calls[0].slice(-2)).toEqual(['--', 'docs/c.md'])
  expect(played).toEqual(['/cache/1.mp3', '/cache/2.mp3'])
  expect(await ui.find({ key: 'entry-c.md' })).toBeFalsy()
  await ui.unmount()
})

const BAND = {
  plugin: 'md-reader',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 60,
    isFocused: false,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const settled = () => new Promise(resolve => setTimeout(resolve, 5))

// Work a press starts runs on past the press, so a test waits for its outcome.
const until = async (isDone: () => boolean) => {
  for (let i = 0; i < 200 && !isDone(); i++) await settled()
  await settled()
}

const reading = (
  on,
  played: string[],
  whilePlaying: () => Promise<void>,
  opened: string[] = [],
  calls: string[][] = [],
) => {
  let tick = 0
  on('clock.now', () => ({ value: ++tick }))
  on('clock.after', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'read' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__md-reader__read_aloud' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.open', (_, e) => {
    opened.push(e.id)

    return { value: { isPlaced: true } }
  })
  on('process.run', (_, e) => {
    calls.push([...e.argv])

    return engineAnswers(JSON.stringify(DOC))
  })
  on('fs.read', (_, e) => ({ value: { base64: String(e.path) } }))
  on('audio.play', async (_, e) => {
    played.push(String(e.clip?.base64 ?? e.base64))
    await whilePlaying()

    return { value: undefined }
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })
}

test('a panel folded while reading goes to the band and the voice goes on', async ($, on) => {
  const played: string[] = []
  let shown: unknown
  let step = async () => {}
  reading(on, played, () => step())
  await $.session.start(session)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  step = async () => {
    if (played.length === 1) await ui.press({ key: 'collapse' })
    if (played.length === 2) {
      await settled()
      const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
      shown = (await band.find({ key: 'stop' })) && (await band.find({ type: 'Text', text: /часть 2 из 2/ }))
      await band.unmount()
    }
  }
  await ui.input({ key: 'path', text: 'a.md' })
  await until(() => shown !== undefined)

  expect(played).toEqual(['/cache/1.mp3', '/cache/2.mp3'])
  expect(shown).toBeTruthy()
  await ui.unmount()

  const done = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await done.find({ key: 'stop' })).toBeFalsy()
  await done.unmount()
})

test('the fold button is there only while reading', async ($, on) => {
  const played: string[] = []
  let seen: unknown
  let step = async () => {}
  reading(on, played, () => step())
  await $.session.start(session)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'collapse' })).toBeFalsy()
  step = async () => {
    await settled()
    seen = seen ?? (await ui.find({ key: 'collapse' }))
  }
  await ui.input({ key: 'path', text: 'a.md' })
  await until(() => played.length === 2)
  await settled()
  await settled()

  expect(seen).toBeTruthy()
  expect(await ui.find({ key: 'collapse' })).toBeFalsy()
  await ui.unmount()
})

for (const [element, parts, isBandLeft] of [
  ['stop', 1, true],
  ['dismiss', 1, false],
] as const) {
  test(`${element} in the band silences the voice`, async ($, on) => {
    const played: string[] = []
    let step = async () => {}
    let left: unknown
    let isDone = false
    reading(on, played, () => step())
    await $.session.start(session)

    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    step = async () => {
      step = async () => {}
      await ui.press({ key: 'collapse' })
      await settled()
      const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
      await band.press({ key: element })
      await settled()
      left = await band.find({ key: 'panel' })
      await band.unmount()
      isDone = true
    }
    await ui.input({ key: 'path', text: 'a.md' })
    await until(() => isDone)

    expect(played).toHaveLength(parts)
    expect(Boolean(left)).toBe(isBandLeft)
    await ui.unmount()
  })
}

test('the band brings the panel back', async ($, on) => {
  const opened: string[] = []
  let left: unknown = true
  let isDone = false
  let step = async () => {}
  reading(on, [], () => step(), opened)
  await $.session.start(session)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  step = async () => {
    step = async () => {}
    await ui.press({ key: 'collapse' })
    await settled()
    const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
    await band.press({ key: 'panel' })
    await settled()
    left = await band.find({ key: 'panel' })
    await band.unmount()
    isDone = true
  }
  await ui.input({ key: 'path', text: 'a.md' })
  await until(() => isDone)

  expect(left).toBeFalsy()

  expect(opened).toEqual(['md-reader'])
  await ui.unmount()
})

for (const [name, silence] of [
  ['/read stop', $ => $.command.run({ command: 'read', args: 'stop' })],
  ['/read стоп', $ => $.command.run({ command: 'read', args: 'Стоп' })],
] as const) {
  test(`${name} ends the reading`, async ($, on) => {
    const played: string[] = []
    let quiet = async () => {}
    on('command.register', () => ({ value: { command: 'read' } }))
    on('tool.register', () => ({ value: { tool: 'mcp__md-reader__read_aloud' } }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('ui.close', () => ({ value: undefined }))
    on('process.run', () => engineAnswers(JSON.stringify(DOC)))
    on('fs.read', (_, e) => ({ value: { base64: String(e.path) } }))
    on('audio.play', async (_, e) => {
      played.push(String(e.clip?.base64 ?? e.base64))
      await quiet()

      return { value: undefined }
    })
    await $.session.start(session)

    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    quiet = () => silence($)
    await ui.input({ key: 'path', text: 'a.md' })

    expect(played).toEqual(['/cache/1.mp3'])
    await ui.unmount()
  })
}

test('a sent Markdown file is offered above the prompt and plays from there', async ($, on) => {
  const played: string[] = []
  const calls: string[][] = []
  const opened: string[] = []
  reading(on, played, async () => {}, opened, calls)
  on('tool.call', () => ({ result: {} }))
  await $.session.start(session)

  await $.tool.call({
    tool: 'SendUserFile',
    tool_use_id: 'call-1',
    files: ['docs/вариант_Т.md', 'picture.png'],
    status: 'normal',
  })

  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await band.find({ key: 'file:/docs/вариант_Т.md' }))?.text).toBe('▶ вариант_Т')
  expect(await band.find({ key: 'file:/picture.png' })).toBeFalsy()

  await band.press({ key: 'file:/docs/вариант_Т.md' })
  await until(() => played.length === 2)

  expect(opened).toEqual(['md-reader'])
  expect(calls.find(argv => argv.includes('--'))?.slice(-2)).toEqual(['--', '/docs/вариант_Т.md'])
  expect(await band.find({ key: 'file:/docs/вариант_Т.md' })).toBeTruthy()
  await band.unmount()
})

const variants = (...names: string[]) => ({
  tool: 'SendUserFile',
  tool_use_id: 'c',
  files: names,
  status: 'normal',
})

test('variants are compared by going back and forth, each from where it was left', async ($, on) => {
  const played: string[] = []
  const reads: string[] = []
  let step = async () => {}
  reading(on, played, () => step())
  on('tool.call', () => ({ result: {} }))
  on('state.set', (_, e, next) => next(e))
  await $.session.start(session)
  await $.tool.call(variants('к.md', 'л.md'))

  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  let isSwitched = false
  step = async () => {
    reads.push(String(played.length))
    if (played.length === 2 && !isSwitched) {
      isSwitched = true
      step = async () => {}
      await band.press({ key: 'file:/л.md' })
    }
  }
  await band.press({ key: 'file:/к.md' })
  await until(() => played.length >= 4)
  expect(played.slice(0, 2)).toEqual(['/cache/1.mp3', '/cache/2.mp3'])

  step = async () => {}
  const before = played.length
  await band.press({ key: 'file:/к.md' })
  await until(() => played.length > before)

  expect(played[before]).toBe('/cache/2.mp3')
  expect(await band.find({ key: 'file:/л.md' })).toBeTruthy()
  await band.unmount()
})

test('pressing the file being read stops it, and pressing again goes on', async ($, on) => {
  const played: string[] = []
  let step = async () => {}
  reading(on, played, () => step())
  on('tool.call', () => ({ result: {} }))
  await $.session.start(session)
  await $.tool.call(variants('к.md'))

  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  step = async () => {
    step = async () => {}
    await settled()
    await band.press({ key: 'file:/к.md' })
    await settled()
  }
  await band.press({ key: 'file:/к.md' })
  await until(() => played.length === 1)
  await settled()
  await settled()
  await settled()

  expect(played).toEqual(['/cache/1.mp3'])
  expect((await band.find({ key: 'file:/к.md' }))?.text).toBe('▶ к')
  await band.press({ key: 'file:/к.md' })
  await until(() => played.length === 3)

  expect(played.slice(1)).toEqual(['/cache/1.mp3', '/cache/2.mp3'])
  await band.unmount()
})

test('the file buttons stay beside the controls of a folded panel', async ($, on) => {
  const played: string[] = []
  let step = async () => {}
  let seen: unknown
  reading(on, played, () => step())
  on('tool.call', () => ({ result: {} }))
  await $.session.start(session)
  await $.tool.call(variants('к.md'))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  step = async () => {
    step = async () => {}
    await ui.press({ key: 'collapse' })
    await settled()
    const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
    seen = (await band.find({ key: 'stop' })) && (await band.find({ key: 'file:/к.md' }))
    await band.unmount()
  }
  await ui.input({ key: 'path', text: 'a.md' })
  await until(() => seen !== undefined)

  expect(seen).toBeTruthy()
  await ui.unmount()
})

test('/read with a folder offers its Markdown files', async ($, on) => {
  const played: string[] = []
  const entry = (name: string, kind: string) => ({ name, kind, size: 0, mtimeMs: 0, isLink: false })
  reading(on, played, async () => {})
  on('fs.list', () => ({
    value: [entry('в.md', 'file'), entry('б.md', 'file'), entry('ключ.txt', 'file'), entry('sub', 'dir')],
  }))
  await $.session.start(session)

  const ran = await $.command.run({ command: 'read', args: 'jobs/варианты/' })
  expect(ran.text).toBe('Кнопки файлов над полем ввода: 2')
  expect(played).toEqual([])

  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await band.find({ key: 'file:/jobs/варианты/б.md' })).toBeTruthy()
  expect(await band.find({ key: 'file:/jobs/варианты/в.md' })).toBeTruthy()
  expect(await band.find({ key: 'file:/jobs/варианты/ключ.txt' })).toBeFalsy()
  await band.unmount()
})

test('an earlier set of files can be brought back from the panel', async ($, on) => {
  reading(on, [], async () => {})
  on('tool.call', () => ({ result: {} }))
  await $.session.start(session)
  await $.tool.call({ ...variants('к.md', 'л.md'), caption: 'Глава 19' })
  await $.tool.call({ ...variants('новый.md'), caption: 'Другое' })

  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await band.find({ key: 'file:/к.md' })).toBeFalsy()

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'sets' })
  await settled()
  expect((await ui.find({ key: 'set-1' }))?.text).toBe('Глава 19 (2)')

  await ui.press({ key: 'set-1' })
  await settled()
  expect(await band.find({ key: 'file:/к.md' })).toBeTruthy()
  expect(await band.find({ key: 'file:/новый.md' })).toBeFalsy()
  await band.unmount()
  await ui.unmount()
})

const reply = (id: string) =>
  ({
    plugin: 'md-reader',
    component: 'AssistantMessage',
    requestId: id,
    surface: 'desktop',
    props: { text: 'Ответ', isFirstOfReply: true },
  }) as const

test('sent files put a button for each under the reply that follows', async ($, on) => {
  const played: string[] = []
  reading(on, played, async () => {})
  on('tool.call', () => ({ result: {} }))
  await $.session.start(session)

  const earlier = await $.ui.mount(reply('before'))
  await $.tool.call(variants('к.md', 'л.md', 'картинка.png'))
  expect(await earlier.findAll({ type: 'Button' })).toHaveLength(0)
  await earlier.unmount()

  const next = await $.ui.mount(reply('after'))
  expect((await next.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  expect((await next.find({ key: 'file:/к.md' }))?.text).toBe('▶ к')
  expect(await next.find({ key: 'file:/картинка.png' })).toBeFalsy()

  await next.press({ key: 'file:/л.md' })
  await until(() => played.length === 2)
  await next.unmount()

  const again = await $.ui.mount(reply('after'))
  expect(await again.find({ key: 'file:/к.md' })).toBeTruthy()
  await again.unmount()

  const later = await $.ui.mount(reply('later'))
  expect(await later.findAll({ type: 'Button' })).toHaveLength(0)
  await later.unmount()
})

test('buttons under a reply come back in a new session', async ($, on) => {
  reading(on, [], async () => {})
  on('store.get', (_, e) => ({
    value: e.key === 'messages' ? { old: ['/x/а.md'] } : undefined,
  }))
  await $.session.start(session)

  const row = await $.ui.mount(reply('old'))
  expect((await row.find({ key: 'file:/x/а.md' }))?.text).toBe('▶ а')
  await row.unmount()
})

const VIEW = {
  title: 'Глава',
  skipped: 0,
  isSpoken: false,
  blocks: [
    { md: 'Первая часть', audio: null },
    { md: 'Вторая часть', audio: null },
    { md: 'Третья часть', audio: null },
    { md: 'Четвёртая часть', audio: null },
    { md: 'Пятая часть', audio: null },
    { md: 'Шестая часть', audio: null },
    { md: 'Седьмая часть', audio: null },
    { md: 'Восьмая часть', audio: null },
    { md: 'Девятая часть', audio: null },
    { md: 'Десятая часть', audio: null },
  ],
}

const viewing = (on, played: string[], calls: string[][]) => {
  on('clock.now', () => ({ value: 1 }))
  on('clock.after', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'read' } }))
  on('tool.register', () => ({ value: { tool: 'x' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('tool.call', () => ({ result: {} }))
  on('process.run', (_, e) => {
    calls.push([...e.argv])

    return engineAnswers(JSON.stringify(e.argv.includes('--view') ? VIEW : DOC))
  })
  on('fs.read', (_, e) => ({ value: { base64: String(e.path) } }))
  on('audio.play', (_, e) => {
    played.push(String(e.clip?.base64 ?? e.base64))

    return { value: undefined }
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })
}

test('a tab shows the whole text at once, with nothing synthesized or played', async ($, on) => {
  const played: string[] = []
  const calls: string[][] = []
  viewing(on, played, calls)
  await $.session.start(session)
  await $.tool.call(variants('к.md', 'л.md', 'картинка.png'))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: 'open:/к.md' }))?.text).toBe('к')
  expect(await ui.find({ key: 'open:/картинка.png' })).toBeFalsy()

  await ui.press({ key: 'open:/к.md' })
  await settled()

  expect(calls.at(-1)?.slice(-3)).toEqual(['--view', '--', '/к.md'])
  expect(played).toEqual([])
  expect(await ui.findAll({ type: 'Markdown' })).toHaveLength(VIEW.blocks.length)
  expect(await ui.find({ key: 'play' })).toBeTruthy()
  expect(await ui.find({ key: 'prev' })).toBeFalsy()
  await ui.unmount()
})

test('hiding the band leaves the tabs in the panel', async ($, on) => {
  viewing(on, [], [])
  await $.session.start(session)
  await $.tool.call(variants('к.md', 'л.md'))

  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.press({ key: 'forget' })
  await settled()
  expect(await band.find({ key: 'file:/к.md' })).toBeFalsy()
  await band.unmount()

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'open:/к.md' })).toBeTruthy()
  expect(await ui.find({ key: 'open:/л.md' })).toBeTruthy()
  await ui.unmount()
})

test('play on an opened text prepares the voice and reads it', async ($, on) => {
  const played: string[] = []
  const calls: string[][] = []
  viewing(on, played, calls)
  await $.session.start(session)
  await $.tool.call(variants('к.md'))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'open:/к.md' })
  await settled()
  await ui.press({ key: 'play' })
  await until(() => played.length === 2)

  expect(calls.at(-1)?.slice(-2)).toEqual(['--', '/к.md'])
  expect(calls.at(-1)).not.toContain('--view')
  await ui.unmount()
})

test('the chat button of an opened text still starts the voice', async ($, on) => {
  const played: string[] = []
  viewing(on, played, [])
  await $.session.start(session)
  await $.tool.call(variants('к.md'))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'open:/к.md' })
  await settled()

  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.press({ key: 'file:/к.md' })
  await until(() => played.length === 2)

  expect(played).toEqual(['/cache/1.mp3', '/cache/2.mp3'])
  await band.unmount()
  await ui.unmount()
})

test('the band leads to the earlier sets', async ($, on) => {
  const opened: string[] = []
  reading(on, [], async () => {}, opened)
  on('tool.call', () => ({ result: {} }))
  await $.session.start(session)
  await $.tool.call({ ...variants('к.md'), caption: 'Глава 19' })

  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.press({ key: 'history' })
  await settled()
  await band.unmount()

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(opened).toEqual(['md-reader'])
  expect(await ui.find({ key: 'set-0' })).toBeTruthy()
  await ui.unmount()
})

test('sets are kept across sessions', async ($, on) => {
  const stored: unknown[] = []
  let inStore: unknown = [{ title: 'Старый набор', files: ['/x/а.md'] }]
  reading(on, [], async () => {})
  on('tool.call', () => ({ result: {} }))
  on('store.get', () => ({ value: inStore }))
  on('store.set', (_, e) => {
    inStore = e.value
    stored.push(e.value)

    return { value: undefined }
  })
  await $.session.start(session)
  await $.tool.call({ ...variants('к.md'), caption: 'Новый' })

  expect((stored.at(-1) as { title: string }[]).map(set => set.title)).toEqual(['Новый', 'Старый набор'])

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'sets' })
  await settled()
  expect((await ui.find({ key: 'set-1' }))?.text).toBe('Старый набор (1)')
  await ui.unmount()
})

test('a set sent by another session is not overwritten', async ($, on) => {
  const stored: unknown[] = []
  let inStore = [{ title: 'Из другой сессии', files: ['/x/а.md'] }]
  reading(on, [], async () => {})
  on('tool.call', () => ({ result: {} }))
  on('store.get', () => ({ value: inStore }))
  on('store.set', (_, e) => {
    stored.push(e.value)

    return { value: undefined }
  })
  await $.session.start(session)
  inStore = [{ title: 'Позже в другой сессии', files: ['/x/б.md'] }, ...inStore]
  await $.tool.call({ ...variants('к.md'), caption: 'Здесь' })

  expect((stored.at(-1) as { title: string }[]).map(set => set.title)).toEqual([
    'Здесь',
    'Позже в другой сессии',
    'Из другой сессии',
  ])
})

test('the offer goes away when hidden', async ($, on) => {
  reading(on, [], async () => {})
  on('tool.call', () => ({ result: {} }))
  await $.session.start(session)

  await $.tool.call({ tool: 'SendUserFile', tool_use_id: 'c', files: ['a.md'], status: 'normal' })
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.press({ key: 'forget' })
  await settled()

  expect(await band.find({ key: 'file:/a.md' })).toBeFalsy()
  await band.unmount()
})

test('a sent file that is no Markdown offers nothing', async ($, on) => {
  reading(on, [], async () => {})
  on('tool.call', () => ({ result: {} }))
  await $.session.start(session)

  await $.tool.call({ tool: 'SendUserFile', tool_use_id: 'c', files: ['a.pdf'], status: 'normal' })
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect(await band.findAll({ type: 'Button' })).toHaveLength(0)
  await band.unmount()
})

test('stop ends the reading and the next part never starts', async ($, on) => {
  const played: string[] = []
  let press = async () => {}
  on('command.register', () => ({ value: { command: 'read' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__md-reader__read_aloud' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', () => engineAnswers(JSON.stringify(DOC)))
  on('fs.read', (_, e) => ({ value: { base64: String(e.path) } }))
  on('audio.play', async (_, e) => {
    played.push(String(e.clip?.base64 ?? e.base64))
    await press()

    return { value: undefined }
  })
  await $.session.start(session)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  press = () => ui.press({ key: 'stop' })
  await ui.input({ key: 'path', text: 'a.md' })

  expect(played).toEqual(['/cache/1.mp3'])
  expect(await ui.find({ key: 'play' })).toBeTruthy()
  await ui.unmount()
})

const VOICES = [
  { id: 'silero:xenia', label: 'Silero: Xenia', isReady: false },
  { id: 'say:Milena', label: 'macOS: Milena (ru)', isReady: true },
]

const voiced = (on, played: { clip: string; mime?: string }[], answer) => {
  on('command.register', () => ({ value: { command: 'read' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__md-reader__read_aloud' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('process.run', answer)
  on('fs.read', (_, e) => ({ value: { base64: String(e.path) } }))
  on('audio.play', (_, e) => {
    played.push({ clip: String(e.clip?.base64 ?? e.base64), mime: e.clip?.mime ?? e.mime })

    return { value: undefined }
  })
}

test('a voice not installed is offered, and the file is read once it is in', async ($, on) => {
  const played: { clip: string }[] = []
  let isInstalled = false
  on('process.spawn', async function* (_, e) {
    expect(e.argv.at(-1)).toEndWith('engine/setup.sh')
    isInstalled = true

    return { value: { code: 0, signal: null } }
  })
  voiced(on, played, () =>
    isInstalled ? engineAnswers(JSON.stringify(DOC)) : engineAnswers('', 3),
  )
  await $.session.start(session)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.input({ key: 'path', text: 'a.md' })
  expect(played).toEqual([])
  expect(await ui.find({ type: 'Text', text: /нужна установка/ })).toBeTruthy()

  await ui.press({ key: 'install' })
  await until(() => played.length === 2)

  expect(played.map(one => one.clip)).toEqual(['/cache/1.mp3', '/cache/2.mp3'])
  expect(await ui.find({ key: 'install' })).toBeFalsy()
  await ui.unmount()
})

test('a failed install says why and keeps the offer', async ($, on) => {
  on('process.spawn', async function* () {
    yield { stream: 'stdout', text: 'не то\n' }
    yield { stream: 'stderr', text: 'pip\nНужен Python ' }
    yield { stream: 'stderr', text: '3.11-3.13\n' }

    return { value: { code: 1, signal: null } }
  })
  voiced(on, [], () => engineAnswers('', 3))
  await $.session.start(session)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.input({ key: 'path', text: 'a.md' })
  await ui.press({ key: 'install' })
  await settled()

  expect((await ui.find({ type: 'Text', text: /Python/ }))?.text).toBe('Нужен Python 3.11-3.13')
  expect(await ui.find({ key: 'install' })).toBeTruthy()
  await ui.unmount()
})

test('a picked voice reads the waiting file, plays wav and outlives the session', async ($, on) => {
  const played: { clip: string; mime?: string }[] = []
  const calls: string[][] = []
  const inStore: Record<string, unknown> = {}
  on('store.get', (_, e) => ({ value: inStore[e.key] }))
  on('store.set', (_, e) => {
    inStore[e.key] = e.value

    return { value: undefined }
  })
  voiced(on, played, (_, e) => {
    calls.push([...e.argv])
    if (e.argv.includes('--voices')) return engineAnswers(JSON.stringify(VOICES))
    if (e.argv.includes('silero:xenia')) return engineAnswers('', 3)

    return engineAnswers(
      JSON.stringify({ ...DOC, blocks: [{ md: 'Часть', audio: '/cache/1.wav' }] }),
    )
  })
  await $.session.start(session)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.input({ key: 'path', text: 'a.md' })
  await ui.press({ key: 'voices' })
  expect((await ui.find({ key: 'voice-0' }))?.text).toBe('● Silero: Xenia (нужна установка)')

  await ui.press({ key: 'voice-1' })
  await until(() => played.length === 1)

  expect(played).toEqual([{ clip: '/cache/1.wav', mime: 'audio/wav' }])
  expect(calls.at(-1)).toContain('say:Milena')
  expect(inStore.voice).toEqual({ id: 'say:Milena', label: 'macOS: Milena (ru)' })
  expect((await ui.find({ key: 'voices' }))?.text).toBe('Голос: macOS: Milena (ru)')
  await ui.unmount()
})

test('the voice kept from an earlier session is the one asked for', async ($, on) => {
  const calls: string[][] = []
  on('store.get', (_, e) => ({
    value: e.key === 'voice' ? { id: 'say:Milena', label: 'macOS: Milena (ru)' } : undefined,
  }))
  voiced(on, [], (_, e) => {
    calls.push([...e.argv])

    return engineAnswers(JSON.stringify(DOC))
  })
  await $.session.start(session)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.input({ key: 'path', text: 'a.md' })

  expect(calls[0]).toContain('say:Milena')
  await ui.unmount()
})

test('a new voice drops the clips of the old one', async ($, on) => {
  const played: { clip: string }[] = []
  const calls: string[][] = []
  voiced(on, played, (_, e) => {
    calls.push([...e.argv])

    return e.argv.includes('--voices')
      ? engineAnswers(JSON.stringify(VOICES))
      : engineAnswers(JSON.stringify(DOC))
  })
  await $.session.start(session)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.input({ key: 'path', text: 'a.md' })
  await until(() => played.length === 2)
  await ui.press({ key: 'voices' })
  await ui.press({ key: 'voice-1' })
  await ui.press({ key: 'play' })
  await until(() => played.length === 4)

  expect(calls.at(-1)).toContain('say:Milena')
  await ui.unmount()
})
