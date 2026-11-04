import { atom, read, update } from 'claude-code'
import type { EngineInterface, FsEntry, Register } from 'claude-code'

import type { Browser, Doc, FileSet, Phase, Reader, Source, VoiceChoice, VoiceMenu } from '../types'

const PANE = 'md-reader'
// The first two-letter tag: `"en-RU",` from macOS, `ru_RU.UTF-8` from Linux.
const LANGUAGE_TAG = /(?:^|[^a-z])([a-z]{2})(?:[^a-z]|$)/
const SYSTEM_LANGUAGE = [
  '/bin/sh',
  '-c',
  'defaults read -g AppleLanguages 2>/dev/null || echo "${LC_ALL:-$LANG}"',
]
const TOOL = 'read_aloud'
const BLOCKS_BEHIND = 1
const BLOCKS_AHEAD = 6
const ENGINE_TIMEOUT_MS = 600_000
const KEPT_OUTPUT = 2000
const SPEEDS = [0.75, 1, 1.5, 2]
const ROOT = '.'
const HIDDEN_FOLDERS = ['node_modules', '__pycache__']
const LIST_LIMIT = 300
const KEPT_SETS = 30
const TITLE_LIMIT = 70
const SPEED_KEY = 'speed-'
const ENTRY_KEY = 'entry-'
const BLOCK_KEY = 'go-'
const FILE_KEY = 'file:'
const OPEN_KEY = 'open:'
const SET_KEY = 'set-'
const VOICE_KEY = 'voice-'
// The engine's exit code when Silero is not installed yet.
const VOICE_MISSING = 3
const STOP_WORDS = ['stop', 'стоп']
// A shell only to reach $HOME: the arguments stay separate words. Until Silero
// is installed any Python shows the text and speaks with the system voices.
const PYTHON = [
  '/bin/sh',
  '-c',
  'python="$HOME/.local/share/md-reader/venv/bin/python"; [ -x "$python" ] || python=python3; exec "$python" "$@"',
  'md-reader',
]

const TEXTS = {
  en: {
    title: 'Read aloud',
    commandHelp: 'Read a Markdown file aloud or pick files from a folder; /read stop stops it',
    commandHint: '<file or folder> | stop',
    stopped: 'Reading stopped.',
    panelOpened: 'Reader panel opened.',
    readingAloud: (path: string) => `Reading aloud: ${path}`,
    filesOffered: (count: number) => `File buttons above the prompt: ${count}`,
    play: '▶ Read',
    stop: '⏹ Stop',
    preparing: 'Preparing the speech…',
    installing: 'Installing the voice, this takes a few minutes…',
    engineSilent: 'The engine did not answer',
    partsSkipped: (count: number) => `Parts not spoken: ${count}`,
    speedFailed: 'The speed did not change',
    selectedText: 'Selected text',
    nothingSelected: 'No text is selected',
    installFailed: 'The install failed',
    voicesFailed: 'The list of voices did not open',
    part: (heard: number, spoken: number) => `Part ${heard} of ${spoken}`,
    titledPart: (title: string, heard: number, spoken: number) =>
      `${title}: part ${heard} of ${spoken}`,
    panel: 'Panel',
    close: 'Close',
    earlier: 'Earlier',
    hide: 'Hide',
    file: 'File',
    filePlaceholder: 'Path to .md, then Enter',
    fileSubmit: 'read',
    collapse: 'Minimize',
    selection: 'Selection',
    files: 'Files',
    hideFiles: 'Hide files',
    sets: 'Sets',
    noSets: 'No file sets yet',
    projectFolder: 'Project folder',
    back: '⬆ Back',
    noFiles: 'No Markdown files here',
    firstOf: (shown: number, total: number) => `Showing the first ${shown} of ${total}`,
    voice: (label: string) => `Voice: ${label}`,
    needsInstall: ' (needs installing)',
    voiceOffer:
      'Silero needs installing: about 1 GB downloads once. ' +
      'The text and the other voices work without it.',
    install: 'Install Silero',
  },
  ru: {
    title: 'Чтение вслух',
    commandHelp: 'Читать вслух MD-файл или выбрать файлы из папки; /read stop останавливает',
    commandHint: '<файл или папка> | stop',
    stopped: 'Чтение остановлено.',
    panelOpened: 'Панель чтения открыта.',
    readingAloud: (path: string) => `Читаю вслух: ${path}`,
    filesOffered: (count: number) => `Кнопки файлов над полем ввода: ${count}`,
    play: '▶ Читать',
    stop: '⏹ Стоп',
    preparing: 'Готовлю озвучку…',
    installing: 'Устанавливаю голос, это несколько минут…',
    engineSilent: 'Движок не ответил',
    partsSkipped: (count: number) => `Не озвучено кусков: ${count}`,
    speedFailed: 'Скорость не изменилась',
    selectedText: 'Выделенный текст',
    nothingSelected: 'Выделенного текста нет',
    installFailed: 'Установка не удалась',
    voicesFailed: 'Список голосов не открылся',
    part: (heard: number, spoken: number) => `Часть ${heard} из ${spoken}`,
    titledPart: (title: string, heard: number, spoken: number) =>
      `${title}: часть ${heard} из ${spoken}`,
    panel: 'Панель',
    close: 'Закрыть',
    earlier: 'Ранее',
    hide: 'Скрыть',
    file: 'Файл',
    filePlaceholder: 'Путь к .md, потом Enter',
    fileSubmit: 'читать',
    collapse: 'Свернуть',
    selection: 'Выделенное',
    files: 'Файлы',
    hideFiles: 'Скрыть файлы',
    sets: 'Наборы',
    noSets: 'Наборов файлов пока нет',
    projectFolder: 'Папка проекта',
    back: '⬆ Назад',
    noFiles: 'Здесь нет MD-файлов',
    firstOf: (shown: number, total: number) => `Показаны первые ${shown} из ${total}`,
    voice: (label: string) => `Голос: ${label}`,
    needsInstall: ' (нужна установка)',
    voiceOffer:
      'Голосу Silero нужна установка: один раз скачается около 1 ГБ. ' +
      'Текст и другие голоса работают без неё.',
    install: 'Установить Silero',
  },
}

const doc = atom({ plugin: 'md-reader', key: 'doc' } as const, null as Doc | null, {
  shape: 'doc-1',
})
const reader = atom(
  { plugin: 'md-reader', key: 'reader' } as const,
  { phase: 'idle', position: 0, note: '', speed: 1, isCollapsed: false, path: null } as Reader,
  { shape: 'reader-4' },
)
// Where each file was left, so variants can be compared by going back and forth.
const spots = atom({ plugin: 'md-reader', key: 'spots' } as const, {} as Record<string, number>, {
  shape: 'spots-1',
})
const browser = atom(
  { plugin: 'md-reader', key: 'browser' } as const,
  { isOpen: false, isSetsOpen: false, folder: ROOT, entries: [] } as Browser,
  { shape: 'browser-2' },
)
// Every set of files sent or picked, newest first; `$.store` keeps it across sessions.
const sets = atom({ plugin: 'md-reader', key: 'sets' } as const, [] as FileSet[], {
  shape: 'sets-1',
})

// The voice to read with; `$.store` keeps it across sessions.
const voice = atom(
  { plugin: 'md-reader', key: 'voice' } as const,
  { id: 'silero:xenia', label: 'Silero: Xenia' } as VoiceChoice,
  { shape: 'voice-1' },
)
const voices = atom(
  { plugin: 'md-reader', key: 'voices' } as const,
  { isOpen: false, list: [] } as VoiceMenu,
  { shape: 'voices-1' },
)

// The panel's tabs: files just sent to the person, then each file opened since.
// The app draws a file's card itself and draws its tool row before the input
// arrives, so a play button cannot stand beside the card; the band above the
// prompt offers these instead.
const offered = atom({ plugin: 'md-reader', key: 'offered' } as const, [] as string[], {
  shape: 'offered-1',
})
// Hiding the band keeps the tabs; the next files sent bring the band back.
const isBandHidden = atom({ plugin: 'md-reader', key: 'isBandHidden' } as const, false, {
  shape: 'band-1',
})

// Not state: read at each session start, before anything is drawn.
let texts = TEXTS.en
// Not state: a reload drops the running clip's owner with the module.
let playback: AbortController | undefined
// A set outlives the session, so its relative paths are resolved against this.
let sessionFolder = ''
// The app draws a file's card itself and a tool row before its input arrives, so
// buttons go under the reply that follows the files: the next message not drawn yet.
let filesWaiting: string[] = []
const drawnMessages = new Set<string>()
const messageFiles = new Map<string, string[]>()
// What the person asked to hear when the voice turned out to need installing.
let waiting: Source | undefined

const setReader = ($: EngineInterface, patch: Partial<Reader>) =>
  update($, reader, now => ({ ...now, ...patch }))

// The engine forgets an element's closure at each redraw while the app can
// still press the drawing before it, so presses are answered by key in the
// `ui.press` and `ui.input` hooks. These props only satisfy the elements.
const answeredByKey = () => {}

// A press outlives its hook, so a failure has to reach the panel by itself.
const answer = ($: EngineInterface, work: () => Promise<unknown>) => {
  void work().catch(error => setReader($, { phase: 'failed', note: String(error) }))
}

const isBusy = (phase: Phase) => phase === 'preparing' || phase === 'installing'

const lastLine = (text: string) => text.trim().split('\n').pop()

const halt = () => {
  playback?.abort()
  playback = undefined
}

const firstSpoken = (loaded: Doc, from = 0) =>
  loaded.blocks.findIndex((block, i) => i >= from && block.audio !== null)

const partsOf = (blocks: Doc['blocks'], position: number) => ({
  spoken: blocks.filter(block => block.audio !== null).length,
  heard: blocks.slice(0, position + 1).filter(block => block.audio !== null).length,
})

const transport = (isPlaying: boolean) => [
  isPlaying
    ? { key: 'stop', label: texts.stop, variant: 'primary' as const }
    : { key: 'play', label: texts.play, variant: 'primary' as const },
  { key: 'prev', label: '⏮' },
  { key: 'next', label: '⏭' },
]

const fileChoices = (files: string[], current: string | null, isPlaying: boolean) =>
  files.map(file => ({
    key: `${FILE_KEY}${file}`,
    label: `${file === current && isPlaying ? '⏹' : '▶'} ${fileName(file)}`,
    variant: file === current ? ('primary' as const) : ('secondary' as const),
  }))

const tabChoices = (files: string[], current: string | null) =>
  files.map(file => ({
    key: `${OPEN_KEY}${file}`,
    label: fileName(file),
    variant: file === current ? ('primary' as const) : ('secondary' as const),
  }))

const speedChoices = (speed: number) =>
  SPEEDS.map(value => ({
    key: `${SPEED_KEY}${value}`,
    label: `×${String(value).replace('.', ',')}`,
    variant: value === speed ? ('primary' as const) : ('secondary' as const),
  }))

const engine = ($: EngineInterface) => [...PYTHON, `${$.plugin.root}/engine/speak.py`]

async function prepare($: EngineInterface, source: Source, isViewOnly = false) {
  halt()
  await setReader($, { phase: 'preparing', note: isViewOnly ? '' : texts.preparing })
  const isText = 'text' in source
  // Absolute, so a file typed as `a.md` is the same tab as one sent as `/x/a.md`.
  const path = isText ? null : absolute(source.path)
  const argv = [
    ...engine($),
    '--voice',
    (await read($, voice)).id,
    ...(isViewOnly ? ['--view'] : []),
    ...(path === null ? ['--stdin', '--title', texts.selectedText] : ['--', path]),
  ]

  try {
    const run = await $.process.run(argv, {
      timeoutMs: ENGINE_TIMEOUT_MS,
      ...(isText ? { stdin: source.text } : {}),
    })
    if (run.exitCode === VOICE_MISSING) {
      waiting = source
      await setReader($, { phase: 'needsVoice', note: '' })

      return false
    }
    if (run.exitCode !== 0 || run.isStdoutTruncated) {
      const reason = lastLine(run.stderr) || texts.engineSilent
      await setReader($, { phase: 'failed', note: reason })

      return false
    }
    const loaded: Doc = JSON.parse(run.stdout)
    const start = firstSpoken(loaded)
    const left = path === null ? undefined : (await read($, spots))[path]
    await update($, doc, () => loaded)
    if (path !== null) {
      await update($, offered, tabs => (tabs.includes(path) ? tabs : [...tabs, path]))
    }
    await setReader($, {
      phase: 'idle',
      path,
      position: Math.max(left !== undefined && left < loaded.blocks.length ? left : start, 0),
      note: loaded.skipped > 0 ? texts.partsSkipped(loaded.skipped) : '',
    })

    return start >= 0
  } catch (error) {
    await setReader($, { phase: 'failed', note: String(error) })

    return false
  }
}

async function atSpeed($: EngineInterface, audio: string, speed: number) {
  if (speed === 1) return audio

  const { id } = await read($, voice)
  const run = await $.process.run([...engine($), '--voice', id, '--retime', String(speed), '--', audio])
  if (run.exitCode !== 0) {
    throw new Error(lastLine(run.stderr) || texts.speedFailed)
  }

  return run.stdout.trim()
}

async function playFrom($: EngineInterface, start: number) {
  halt()
  const mine = new AbortController()
  playback = mine
  const loaded = await read($, doc)
  if (!loaded) return
  const { path } = await read($, reader)

  try {
    await setReader($, { phase: 'playing', note: '' })
    for (let i = start; i < loaded.blocks.length; i++) {
      const audio = loaded.blocks[i]?.audio
      if (!audio) continue
      await setReader($, { position: i })
      if (path !== null) await update($, spots, left => ({ ...left, [path]: i }))
      // Read per part: a speed picked between parts holds from the next one.
      const clip = await atSpeed($, audio, (await read($, reader)).speed)
      const { base64 } = await $.fs.read(clip, { as: 'bytes' })
      if (mine.signal.aborted) return
      await $.audio.play(
        { base64, mime: clip.endsWith('.wav') ? 'audio/wav' : 'audio/mpeg' },
        { signal: mine.signal },
      )
      if (mine.signal.aborted) return
    }
    if (path !== null) {
      await update($, spots, left =>
        Object.fromEntries(Object.entries(left).filter(([one]) => one !== path)),
      )
    }
    await setReader($, {
      phase: 'idle',
      position: Math.max(firstSpoken(loaded), 0),
      isCollapsed: false,
    })
  } catch (error) {
    if (!mine.signal.aborted) {
      await setReader($, { phase: 'failed', note: String(error) })
    }
  }
}

async function readAloud($: EngineInterface, source: Source) {
  if (isBusy((await read($, reader)).phase)) return
  if (await prepare($, source)) {
    await playFrom($, (await read($, reader)).position)
  }
}

async function openText($: EngineInterface, path: string) {
  if (isBusy((await read($, reader)).phase)) return
  await openPane($)
  await prepare($, { path }, true)
}

async function installVoice($: EngineInterface) {
  await setReader($, { phase: 'installing', note: texts.installing })
  // Not `process.run`: it allows ten minutes, a slow download takes longer.
  const setup = $.process.spawn({ argv: ['/bin/sh', `${$.plugin.root}/engine/setup.sh`] })
  let said = ''
  let piece = await setup.next()
  while (!piece.done) {
    if (piece.value.stream === 'stderr') said = (said + piece.value.text).slice(-KEPT_OUTPUT)
    piece = await setup.next()
  }
  if (piece.value.code !== 0) {
    return setReader($, { phase: 'needsVoice', note: lastLine(said) || texts.installFailed })
  }
  await setReader($, { phase: 'idle', note: '' })
  const source = waiting
  waiting = undefined

  return source ? readAloud($, source) : undefined
}

async function toggleVoices($: EngineInterface) {
  if ((await read($, voices)).isOpen) {
    return update($, voices, now => ({ ...now, isOpen: false }))
  }
  const run = await $.process.run([...engine($), '--voices'])
  if (run.exitCode !== 0) throw new Error(lastLine(run.stderr) || texts.voicesFailed)

  return update($, voices, () => ({ isOpen: true, list: JSON.parse(run.stdout) }))
}

// Clips made by the old voice go: the next reading speaks with the new one.
async function pickVoice($: EngineInterface, { id, label }: VoiceChoice) {
  await stop($)
  await update($, voice, () => ({ id, label }))
  await $.store.set('voice', { id, label }).catch(() => undefined)
  await update($, voices, now => ({ ...now, isOpen: false }))
  await update($, doc, now =>
    now && { ...now, isSpoken: false, blocks: now.blocks.map(block => ({ ...block, audio: null })) },
  )
  const source = waiting
  waiting = undefined

  return source ? readAloud($, source) : undefined
}

async function readSelection($: EngineInterface) {
  const selected = await $.ui.selection()
  if (selected?.text.trim()) {
    await readAloud($, { text: selected.text })
  } else {
    await setReader($, { phase: 'idle', note: texts.nothingSelected })
  }
}

async function step($: EngineInterface, delta: 1 | -1) {
  const loaded = await read($, doc)
  const { phase, position } = await read($, reader)
  if (!loaded) return

  let target = position + delta
  while (loaded.blocks[target]?.audio === null) target += delta
  if (!loaded.blocks[target]) return

  if (phase === 'playing') {
    void playFrom($, target)
  } else {
    await setReader($, { position: target })
  }
}

async function changeSpeed($: EngineInterface, speed: number) {
  const { phase, position } = await read($, reader)
  await setReader($, { speed })
  if (phase === 'playing') await playFrom($, position)
}

const isMarkdown = (name: string) => /\.md$/i.test(name)

const fileName = (path: string) => (path.split('/').pop() ?? path).replace(/\.md$/i, '')


// A link lists as `other`, and a project may link in a folder of files.
const kindOf = ({ isLink, kind, name }: FsEntry) =>
  isLink ? (isMarkdown(name) ? 'file' : 'dir') : kind

const isListed = (entry: FsEntry) =>
  !entry.name.startsWith('.') &&
  (kindOf(entry) === 'dir'
    ? !HIDDEN_FOLDERS.includes(entry.name)
    : kindOf(entry) === 'file' && isMarkdown(entry.name))

const inFolder = (folder: string, name: string) =>
  folder === ROOT ? name : `${folder}/${name}`

const parentOf = (folder: string) =>
  folder.split('/').slice(0, -1).join('/') || ROOT

async function showFolder($: EngineInterface, folder: string) {
  try {
    const listed = (await $.fs.list(folder)).filter(isListed)
    const names = (kind: FsEntry['kind']) =>
      listed.filter(entry => kindOf(entry) === kind).map(entry => entry.name).sort()
    // Dated archive folders read newest first.
    const entries = [
      ...names('dir').reverse().map(name => ({ name, isFolder: true })),
      ...names('file').map(name => ({ name, isFolder: false })),
    ]
    await update($, browser, () => ({ isOpen: true, folder, entries }))
  } catch (error) {
    await setReader($, { phase: 'failed', note: String(error) })
  }
}

async function toggleFiles($: EngineInterface) {
  const { folder, isOpen } = await read($, browser)
  if (isOpen) {
    await update($, browser, now => ({ ...now, isOpen: false }))
  } else {
    await showFolder($, folder)
  }
}

async function openFile($: EngineInterface, path: string) {
  await update($, browser, now => ({ ...now, isOpen: false }))
  await readAloud($, { path })
}

async function stop($: EngineInterface) {
  halt()
  await setReader($, { phase: 'idle' })
}

// The engine names no interface language, so the panel follows the system's first one.
async function chooseLanguage($: EngineInterface) {
  const listed = await $.process.run(SYSTEM_LANGUAGE).catch(() => undefined)
  texts = LANGUAGE_TAG.exec(listed?.stdout ?? '')?.[1] === 'ru' ? TEXTS.ru : TEXTS.en
}

async function openPane($: EngineInterface) {
  await setReader($, { isCollapsed: false })
  await $.ui.open({ id: PANE, title: texts.title })
}

async function markdownIn($: EngineInterface, folder: string) {
  const listed = await $.fs.list(folder).catch(() => [])

  return listed
    .filter(entry => isListed(entry) && kindOf(entry) === 'file')
    .map(entry => inFolder(folder.replace(/\/+$/, ''), entry.name))
    .sort()
}

// `~` is left for the engine to expand; a leading `./` would make a second tab.
const absolute = (path: string) =>
  path.startsWith('/') || path.startsWith('~')
    ? path
    : `${sessionFolder.replace(/\/+$/, '')}/${path.replace(/^(\.\/)+/, '')}`

// The store, not the session's copy: another session may have added a set.
async function storedSets($: EngineInterface) {
  const saved = await $.store.get('sets').catch(() => undefined)

  return Array.isArray(saved) ? (saved as FileSet[]) : read($, sets)
}

async function offerSet($: EngineInterface, title: string, files: string[]) {
  const full = files.map(absolute)
  const key = full.join('\n')
  await update($, offered, () => full)
  await update($, isBandHidden, () => false)
  const id = String(await $.clock.now())
  const kept = [
    { id, title: title.slice(0, TITLE_LIMIT), files: full },
    ...(await storedSets($)).filter(set => set.files.join('\n') !== key),
  ].slice(0, KEPT_SETS)
  await update($, sets, () => kept)
  await $.store.set('sets', kept).catch(() => undefined)

  return full
}

// A path to a folder offers its files; a path to a file starts reading it.
async function begin($: EngineInterface, path: string) {
  const files = isMarkdown(path) ? [] : await markdownIn($, path)
  if (files.length > 0) {
    await offerSet($, fileName(path.replace(/\/+$/, '')), files)

    return texts.filesOffered(files.length)
  }
  await openPane($)
  answer($, () => readAloud($, { path }))

  return texts.readingAloud(path)
}

async function press($: EngineInterface, element: string) {
  const { path: current, phase, position } = await read($, reader)
  const { entries, folder } = await read($, browser)
  const loaded = await read($, doc)
  const isHeard = loaded !== null && loaded.isSpoken !== false

  if (element === 'panel') return openPane($)
  if (element === 'dismiss') {
    await stop($)

    return setReader($, { isCollapsed: false })
  }
  if (element === 'forget') return update($, isBandHidden, () => true)
  if (element === 'sets') {
    const known = await storedSets($)
    await update($, sets, () => known)

    return update($, browser, now => ({ ...now, isSetsOpen: !now.isSetsOpen }))
  }
  if (element === 'history') {
    const known = await storedSets($)
    await update($, sets, () => known)
    await update($, browser, now => ({ ...now, isSetsOpen: true }))

    return openPane($)
  }
  if (element.startsWith(SET_KEY)) {
    const picked = (await read($, sets))[Number(element.slice(SET_KEY.length))]
    await update($, browser, now => ({ ...now, isSetsOpen: false }))
    if (!picked) return
    await update($, isBandHidden, () => false)

    return update($, offered, () => picked.files)
  }
  if (element === 'voices') return toggleVoices($)
  if (element === 'install') return phase === 'needsVoice' ? installVoice($) : undefined
  if (element.startsWith(OPEN_KEY)) return openText($, element.slice(OPEN_KEY.length))
  if (element.startsWith(FILE_KEY)) {
    const path = element.slice(FILE_KEY.length)
    const isCurrent = path === current && isHeard
    if (isCurrent && phase === 'playing') return stop($)
    await openPane($)

    return isCurrent ? playFrom($, position) : readAloud($, { path })
  }
  if (element === 'stop') return stop($)
  if (element === 'prev') return step($, -1)
  if (element === 'next') return step($, 1)
  if (element === 'files') return toggleFiles($)
  if (element === 'up') return showFolder($, parentOf(folder))
  if (element.startsWith(SPEED_KEY)) {
    return changeSpeed($, Number(element.slice(SPEED_KEY.length)))
  }
  if (element.startsWith(ENTRY_KEY)) {
    const name = element.slice(ENTRY_KEY.length)
    const path = inFolder(folder, name)
    const isFolder = entries.find(entry => entry.name === name)?.isFolder

    return isFolder ? showFolder($, path) : openFile($, path)
  }
  if (isBusy(phase)) return undefined
  if (element.startsWith(VOICE_KEY)) {
    const picked = (await read($, voices)).list[Number(element.slice(VOICE_KEY.length))]

    return picked ? pickVoice($, picked) : undefined
  }
  if (element === 'play') {
    return !isHeard && current !== null ? readAloud($, { path: current }) : playFrom($, position)
  }
  if (element === 'selection') return readSelection($)
  if (element.startsWith(BLOCK_KEY)) {
    return playFrom($, Number(element.slice(BLOCK_KEY.length)))
  }

  return undefined
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await chooseLanguage($)
    await $.command.register({
      name: 'read',
      description: texts.commandHelp,
      argumentHint: texts.commandHint,
    })
    await $.tool.register({
      name: TOOL,
      description:
        'Reads a Markdown file aloud to the person in the reader panel. ' +
        'Use when they ask to read or listen to a file.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Path to the file' } },
        required: ['path'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'stop_reading',
      description:
        'Stops the reading aloud. Use when the person asks to stop or silence it.',
      isDeferred: false,
    })
    sessionFolder = e.cwd
    const known = await storedSets($)
    await update($, sets, () => known)
    const chosen = (await $.store.get('voice').catch(() => undefined)) as VoiceChoice | undefined
    if (typeof chosen?.id === 'string') await update($, voice, () => chosen)
    const saved = await $.store.get('messages').catch(() => undefined)
    if (saved && typeof saved === 'object') {
      for (const [id, files] of Object.entries(saved)) messageFiles.set(id, files as string[])
    }
    const started = await next(e)
    // State outlives a reload, the running work does not.
    await setReader($, { phase: 'idle', note: '', isCollapsed: false })

    return started
  })

  on('command.run', { command: 'read' }, async ($, e) => {
    const path = e.args.trim()
    if (STOP_WORDS.includes(path.toLowerCase())) {
      await stop($)

      return { text: texts.stopped }
    }
    if (path) return { text: await begin($, path) }
    await openPane($)

    return { text: texts.panelOpened }
  })

  on('tool.call', { tool: 'mcp__md-reader__read_aloud' }, async ($, e) => {
    const { path } = e as unknown as { path: string }

    return { result: await begin($, path) }
  })

  on('tool.call', { tool: 'mcp__md-reader__stop_reading' }, async $ => {
    await stop($)

    return { result: 'Reading stopped.' }
  })

  // A panel closed mid-reading folds into the band, so the controls stay in reach.
  on('ui.close', async ($, e, next) => {
    const { phase } = await read($, reader)
    if (e.id === PANE && (phase === 'playing' || phase === 'preparing')) {
      await setReader($, { isCollapsed: true })
    }

    return next(e)
  })

  on('ui.press', { plugin: 'md-reader' }, async ($, e) => {
    if (e.element === 'collapse') {
      await $.ui.close({ id: PANE })
    } else {
      answer($, () => press($, e.element))
    }

    return { element: e.element }
  })

  on('ui.input', { plugin: 'md-reader' }, ($, e) => {
    const path = e.value.trim()
    if (e.kind === 'submit' && path) answer($, () => readAloud($, { path }))

    return { element: e.element, value: e.value }
  })

  on('tool.call', { tool: 'SendUserFile' }, async ($, e, next) => {
    const paths = e.files.filter(isMarkdown)
    const ran = await next(e)
    if (paths.length > 0 && ran.deny === undefined && !ran.isError) {
      filesWaiting = await offerSet($, e.caption || fileName(paths[0] ?? ''), paths)
    }

    return ran
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const id = e.requestId
    if (filesWaiting.length > 0 && !drawnMessages.has(id)) {
      messageFiles.set(id, filesWaiting)
      filesWaiting = []
      $.clock.after(0, () => {
        void $.store.set('messages', Object.fromEntries(messageFiles)).catch(() => undefined)
      })
    }
    drawnMessages.add(id)
    const row = await next(e)
    const files = messageFiles.get(id)
    if (!files) return row

    const { Box, Button } = $.ui.resolve(e)

    return (
      <Box flexDirection="column" gap={1}>
        {row}
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          {files.map(file => (
            <Button key={`${FILE_KEY}${file}`} label={`▶ ${fileName(file)}`} onPress={answeredByKey} />
          ))}
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const { isCollapsed, note, path, phase, position, speed } = await read($, reader)
    const loaded = await read($, doc)
    const files = (await read($, isBandHidden)) ? [] : await read($, offered)
    const isPlaying = phase === 'playing'
    const hasControls = isCollapsed && loaded !== null
    if (!hasControls && files.length === 0) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const { heard, spoken } = partsOf(loaded?.blocks ?? [], position)

    return (
      <Box flexDirection="column" gap={1}>
        {hasControls && (
          <Text wrap="truncate-end">{texts.titledPart(loaded.title, heard, spoken)}</Text>
        )}
        {hasControls && note !== '' && (
          <Text color={phase === 'failed' ? 'error' : undefined}>{note}</Text>
        )}
        {hasControls && (
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            {transport(isPlaying).map(props => (
              <Button {...props} onPress={answeredByKey} />
            ))}
            {speedChoices(speed).map(props => (
              <Button {...props} onPress={answeredByKey} />
            ))}
            <Button key="panel" label={texts.panel} onPress={answeredByKey} />
            <Button key="dismiss" label={texts.close} onPress={answeredByKey} />
          </Box>
        )}
        {files.length > 0 && (
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            {fileChoices(files, path, isPlaying).map(props => (
              <Button {...props} onPress={answeredByKey} />
            ))}
            <Button key="history" label={texts.earlier} onPress={answeredByKey} />
            <Button key="forget" label={texts.hide} onPress={answeredByKey} />
          </Box>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Button, Markdown, Text } = ui
    const loaded = await read($, doc)
    const { note, path, phase, position, speed } = await read($, reader)
    const files = await read($, browser)
    const chosen = await read($, voice)
    const chooser = await read($, voices)
    const fileSets = await read($, sets)
    // A new session starts with no tabs; earlier sets wait under "Sets".
    const chatFiles = await read($, offered)
    const isPlaying = phase === 'playing'
    const blocks = loaded?.blocks ?? []
    const { heard, spoken } = partsOf(blocks, position)
    // Reading follows the voice; otherwise the whole text is there to read.
    const first = isPlaying ? Math.max(position - BLOCKS_BEHIND, 0) : 0
    const visible = isPlaying ? blocks.slice(first, position + BLOCKS_AHEAD + 1) : blocks
    const controls = loaded?.isSpoken === false ? transport(false).slice(0, 1) : transport(isPlaying)

    return (
      <Box flexDirection="column" gap={1}>
        {chatFiles.length > 0 && (
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            {tabChoices(chatFiles, path).map(props => (
              <Button {...props} onPress={answeredByKey} />
            ))}
          </Box>
        )}
        {'Input' in ui && (
          <ui.Input
            key="path"
            label={texts.file}
            placeholder={texts.filePlaceholder}
            submitLabel={texts.fileSubmit}
            onSubmit={answeredByKey}
          />
        )}
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          {blocks.length > 0 &&
            controls.map(props => <Button {...props} onPress={answeredByKey} />)}
          {isPlaying && <Button key="collapse" label={texts.collapse} onPress={answeredByKey} />}
          <Button key="selection" label={texts.selection} onPress={answeredByKey} />
          <Button
            key="files"
            label={files.isOpen ? texts.hideFiles : texts.files}
            onPress={answeredByKey}
          />
          <Button key="sets" label={texts.sets} onPress={answeredByKey} />
        </Box>
        {files.isSetsOpen && (
          <Box flexDirection="column">
            {fileSets.length === 0 && <Text dimColor>{texts.noSets}</Text>}
            {fileSets.map((set, index) => (
              <Button
                key={`${SET_KEY}${index}`}
                plain
                label={`${set.title} (${set.files.length})`}
                onPress={answeredByKey}
              />
            ))}
          </Box>
        )}
        {files.isOpen && (
          <Box flexDirection="column">
            <Text dimColor>{files.folder === ROOT ? texts.projectFolder : files.folder}</Text>
            {files.folder !== ROOT && (
              <Button key="up" plain label={texts.back} onPress={answeredByKey} />
            )}
            {files.entries.length === 0 && <Text dimColor>{texts.noFiles}</Text>}
            {files.entries.length > LIST_LIMIT && (
              <Text dimColor>{texts.firstOf(LIST_LIMIT, files.entries.length)}</Text>
            )}
            {files.entries.slice(0, LIST_LIMIT).map(entry => (
              <Button
                key={`${ENTRY_KEY}${entry.name}`}
                plain
                label={`${entry.isFolder ? '📁' : '📄'} ${entry.name}`}
                onPress={answeredByKey}
              />
            ))}
          </Box>
        )}
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          {speedChoices(speed).map(props => (
            <Button {...props} onPress={answeredByKey} />
          ))}
          <Button key="voices" label={texts.voice(chosen.label)} onPress={answeredByKey} />
        </Box>
        {chooser.isOpen && (
          <Box flexDirection="column">
            {chooser.list.map((one, index) => (
              <Button
                key={`${VOICE_KEY}${index}`}
                plain
                label={`${one.id === chosen.id ? '● ' : ''}${one.label}${one.isReady ? '' : texts.needsInstall}`}
                onPress={answeredByKey}
              />
            ))}
          </Box>
        )}
        {phase === 'needsVoice' && <Text>{texts.voiceOffer}</Text>}
        {phase === 'needsVoice' && (
          <Button key="install" label={texts.install} variant="primary" onPress={answeredByKey} />
        )}
        {loaded && <Text bold>{loaded.title}</Text>}
        {spoken > 0 && (
          <Text dimColor>{texts.part(heard, spoken)}</Text>
        )}
        {note !== '' && (
          <Text color={phase === 'failed' || phase === 'needsVoice' ? 'error' : undefined}>{note}</Text>
        )}
        {visible.map((block, offset) => {
          const index = first + offset

          return (
            <Box key={`block-${index}`} flexDirection="row" gap={1}>
              {block.audio !== null && (
                <Button
                  key={`${BLOCK_KEY}${index}`}
                  plain
                  dimColor
                  label="▶"
                  onPress={answeredByKey}
                />
              )}
              <Box flexGrow={1} flexShrink={1}>
                <Markdown text={block.md} dimColor={isPlaying && index !== position} />
              </Box>
            </Box>
          )
        })}
      </Box>
    )
  })
}
