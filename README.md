# md-reader

A mod for Claude Code: a panel beside the chat that opens Markdown files and reads them aloud. It is built for comparing several versions of a text, by eye and by ear.

- Files Claude sends to the chat become tabs in the panel, and every file you open joins them. A tab opens the text at once, without generating speech. A new session starts with no tabs.
- Every part of the text has its own ▶ button.
- Your place is remembered separately for each file.
- Speed: ×0.75, ×1, ×1.5 and ×2.
- Sets of files are kept between sessions, and the "Sets" button brings them back.
- The voice is chosen in the panel.

The panel follows your system language: Russian on a Russian system, English on any other.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install md-reader --marketplace faeton13/md-reader
```

From a shell:

```
claude plugin install md-reader --marketplace faeton13/md-reader
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then Plugins, Add marketplace with `faeton13/md-reader`, then Add plugin.

The `/read` command opens the panel. `/read path/to/file.md` reads a file right away, and `/read path/to/folder` offers the files in that folder. `/read stop` stops reading.

## Voices

Pick a voice with the "Voice" button in the panel. The choice is kept between sessions.

| Module | What it needs | Languages |
| --- | --- | --- |
| Silero: Xenia, Kseniya, Baya, Aidar, Eugene | One-click install from the panel: about 1 GB, Python 3.11–3.13 | Russian |
| macOS | Nothing, these are the system voices | Russian and your system languages |
| Your own program | An entry in `voices.json` | Any |

Silero offers to install itself the first time it is needed. The install takes a few minutes and happens once. After that Silero works offline.

### Your own program

Any program that reads text from standard input and writes a sound file will do. Describe it in `~/.local/share/md-reader/voices.json`:

```json
[
  {
    "id": "piper-ru",
    "label": "Piper: Irina",
    "command": ["piper", "--model", "/path/to/ru_RU-irina-medium.onnx", "--output_file", "{out}"],
    "format": "wav"
  }
]
```

- `{out}` is the file to write.
- `{rate}` is the tempo in words per minute, 175 at normal speed. It is optional.
- `format` is `wav` or `mp3`.

Without `{rate}` in the command, changing the speed needs ffmpeg.

## Pronunciation dictionary

For Silero, you can correct how words are spoken in `~/.local/share/md-reader/pronunciation.json`. Put `+` before the stressed vowel:

```json
{ "Кафка": "К+афка" }
```

A Russian key matches the start of a word, so it covers the case endings too.

## Where it runs

| System | Status |
| --- | --- |
| macOS on Apple Silicon | Tested |
| Linux | Silero and your own program should work, but are untested |
| Windows | Does not work |

`python3` is required. On macOS it comes with the Xcode Command Line Tools.

## Your data

Text is processed on your computer. Silero and the macOS voices send it nowhere, and your own program does whatever it was built to do. Internet access is needed only to install Silero.

Everything is kept in `~/.local/share/md-reader`: the voice, the dictionary and the generated audio. To remove it, disable the plugin and run:

```
rm -rf ~/.local/share/md-reader
```

## License

The mod's code is under the MIT License, see [LICENSE](LICENSE).

The Silero voices are not part of the mod: they are downloaded during the install. The `v5_5_ru` model belongs to [Silero](https://github.com/snakers4/silero-models) and is licensed under CC BY-NC-SA 4.0, which allows non-commercial use with attribution only.
