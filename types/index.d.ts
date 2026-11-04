export type Block = { md: string; audio: string | null }

export type Doc = { title: string; blocks: Block[]; skipped: number; isSpoken?: boolean }

export type Phase = 'idle' | 'preparing' | 'playing' | 'failed' | 'needsVoice' | 'installing'

export type Reader = {
  phase: Phase
  position: number
  note: string
  speed: number
  isCollapsed: boolean
  path: string | null
}

export type Source = { path: string } | { text: string }

export type Entry = { name: string; isFolder: boolean }

export type Browser = {
  isOpen: boolean
  isSetsOpen: boolean
  folder: string
  entries: Entry[]
}

export type FileSet = { id: string; title: string; files: string[] }

export type VoiceChoice = { id: string; label: string }

export type VoiceMenu = { isOpen: boolean; list: (VoiceChoice & { isReady: boolean })[] }

declare module 'claude-code' {
  interface PluginState {
    'md-reader': {
      browser: Shaped<Browser>
      doc: Shaped<Doc | null>
      isBandHidden: Shaped<boolean>
      offered: Shaped<string[]>
      reader: Shaped<Reader>
      sets: Shaped<FileSet[]>
      spots: Shaped<Record<string, number>>
      voice: Shaped<VoiceChoice>
      voices: Shaped<VoiceMenu>
    }
  }
}
