#!/usr/bin/env python3
"""Turn Markdown into per-block speech for the md-reader mod.

Usage:
    speak.py <file.md>                 # read a file
    speak.py --stdin --title <name>    # read text from standard input
    speak.py --view <file.md>          # the text alone, nothing synthesized
    speak.py --retime 1.5 <clip>       # a clip at another tempo, pitch kept
    speak.py --voices                  # the voices to choose from

--voice picks the voice: silero:<speaker>, say:<system voice>, or an id from
voices.json. Reading prints one JSON object:
{"title", "blocks": [{"md", "audio"}], "skipped"}.
A block with "audio": null is shown but not spoken (a code block).
Retiming prints the path of the clip at that tempo.
Exit code 3 means Silero is not installed yet: engine/setup.sh installs it.
"""

import argparse
import contextlib
import hashlib
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import warnings
from pathlib import Path

HOME_DIR = Path.home() / ".local" / "share" / "md-reader"
CACHE_DIR = HOME_DIR / "cache"
DICT_PATH = HOME_DIR / "pronunciation.json"
VOICES_PATH = HOME_DIR / "voices.json"

MODEL_ID = "v5_5_ru"
SILERO_SPEAKERS = ("xenia", "kseniya", "baya", "aidar", "eugene")
DEFAULT_VOICE = "silero:xenia"
VOICE_MISSING = 3
SAMPLE_RATE = 48000
# Silero refuses text of about 1000 characters and more.
MAX_CHUNK = 900
PAUSE_SECONDS = 0.35
# Words per minute at normal speed; {rate} in a command scales with the speed.
BASE_RATE = 175
SAY_COMMAND = [
    "say", "-v", "{name}", "-r", "{rate}", "-o", "{out}",
    "--data-format=LEI16@22050", "-f", "-",
]

# Replacements applied to the speech text, never to what the panel shows.
# A Cyrillic key matches the start of a word, so it also covers declensions.
# "+" goes before the stressed vowel. Edit pronunciation.json, not this seed.
DEFAULT_DICT = {
    "Claude Code": "Клод Код",
    "Claude": "Клод",
    "Discord": "Дискорд",
    "GitHub": "Гитхаб",
    "Markdown": "Маркдаун",
}

EMOJI = re.compile(
    "[\U0001F000-\U0001FAFF←-⇿⌀-⏿①-➿"
    "⬀-⯿️‍]"
)
LATIN_WORD = re.compile(r"[A-Za-z]+")
LETTER_NAMES = dict(zip(
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    "эй би си ди и эф джи эйч ай джей кей эл эм эн оу пи кью ар эс ти ю ви дабл-ю экс уай зи".split(),
))
LATIN_PAIRS = [
    ("sch", "щ"), ("sh", "ш"), ("ch", "ч"), ("th", "т"), ("ph", "ф"),
    ("zh", "ж"), ("kh", "х"), ("ts", "ц"), ("ck", "к"), ("oo", "у"),
    ("ee", "и"), ("qu", "кв"), ("ya", "я"), ("yu", "ю"),
]
LATIN_LETTERS = dict(zip(
    "abcdefghijklmnopqrstuvwxyz",
    "а б к д е ф г х и дж к л м н о п к р с т у в в кс и з".split(),
))


def load_dictionary():
    if not DICT_PATH.exists():
        DICT_PATH.parent.mkdir(parents=True, exist_ok=True)
        DICT_PATH.write_text(
            json.dumps(DEFAULT_DICT, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    return json.loads(DICT_PATH.read_text(encoding="utf-8"))


def split_blocks(text):
    """Split Markdown into (kind, source) blocks: text, table or code."""
    # The panel's Markdown element refuses control characters but tab and newline.
    text = re.sub(r"[\x00-\x08\x0b-\x1f\x7f]", "", text.replace("\r\n", "\n"))
    lines = text.split("\n")
    if lines and lines[0].strip() == "---":
        for i in range(1, len(lines)):
            if lines[i].strip() == "---":
                lines = lines[i + 1:]
                break

    blocks, paragraph = [], []

    def flush():
        if paragraph:
            blocks.append(("text", "\n".join(paragraph)))
            paragraph.clear()

    i = 0
    while i < len(lines):
        stripped = lines[i].strip()
        if stripped.startswith(("```", "~~~")):
            flush()
            fence = stripped[:3]
            j = i + 1
            while j < len(lines) and not lines[j].strip().startswith(fence):
                j += 1
            blocks.append(("code", "\n".join(lines[i:j + 1])))
            i = j + 1
        elif not stripped or re.fullmatch(r"[-*_]{3,}", stripped):
            flush()
            i += 1
        elif stripped.startswith("#"):
            flush()
            blocks.append(("text", stripped))
            i += 1
        elif stripped.startswith("|"):
            flush()
            j = i
            while j < len(lines) and lines[j].strip().startswith("|"):
                j += 1
            blocks.append(("table", "\n".join(lines[i:j])))
            i = j
        elif re.match(r"(?:[-*+]|\d+[.)])\s", stripped):
            flush()
            j = i + 1
            while (
                j < len(lines)
                and lines[j][:1] in (" ", "\t")
                and lines[j].strip()
                and not re.match(r"(?:[-*+]|\d+[.)])\s", lines[j].strip())
            ):
                j += 1
            blocks.append(("text", "\n".join(lines[i:j])))
            i = j
        else:
            paragraph.append(lines[i])
            i += 1
    flush()
    return blocks


def spell_number(match):
    raw = match.group(0)
    digits = re.sub(r"\D", "", raw)
    if len(digits) > 12:
        return "длинное число"
    from num2words import num2words

    value = float(raw.replace(",", ".")) if re.search(r"[.,]", raw) else int(raw)
    return num2words(value, lang="ru")


def transliterate(match):
    word = match.group(0)
    if word.isupper() and len(word) <= 5:
        return " ".join(LETTER_NAMES[c] for c in word)
    out = word.lower()
    for latin, cyrillic in LATIN_PAIRS:
        out = out.replace(latin, cyrillic)
    return "".join(LATIN_LETTERS.get(c, c) for c in out)


def apply_dictionary(text, words):
    for source in sorted(words, key=len, reverse=True):
        if re.search(r"[A-Za-z]", source):
            pattern = rf"(?<![A-Za-z]){re.escape(source)}(?![A-Za-z])"
        else:
            pattern = rf"(?<![\w+]){re.escape(source)}"
        text = re.sub(pattern, lambda _: words[source], text)
    return text


def table_to_prose(source):
    rows = []
    for line in source.split("\n"):
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if all(re.fullmatch(r":?-+:?", c or "-") for c in cells):
            continue
        rows.append(", ".join(c for c in cells if c))
    return ". ".join(rows)


def plain_text(kind, source, link=" "):
    """The words of one block with the Markdown gone; empty when nothing is said."""
    if kind == "code":
        return ""
    text = table_to_prose(source) if kind == "table" else source
    text = re.sub(r"^\s*>\s?", "", text, flags=re.M)
    text = re.sub(r"^\s*#{1,6}\s*", "", text, flags=re.M)
    text = re.sub(r"^\s*(?:[-*+]|\d+[.)])\s+", "", text, flags=re.M)
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"https?://\S+", link, text)
    text = text.replace("`", "").replace("**", "").replace("__", "")
    text = re.sub(r"(?<!\w)\*(?=\S)|(?<=\S)\*(?!\w)", "", text)
    text = re.sub(r"(?<!\w)_(?=\S)|(?<=\S)_(?!\w)", "", text)
    for symbol, word in (
        ("→", " — "), ("←", " — "), ("=>", " — "), ("->", " — "),
        ("|", ", "), ("@", " "),
    ):
        text = text.replace(symbol, word)
    text = EMOJI.sub("", text)
    text = re.sub(r"[/\\_=+~^{}\[\]]", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text if re.search(r"\w", text) else ""


def to_speech(kind, source, words):
    """Text for Silero, which says nothing of digits and Latin and takes stress marks."""
    text = plain_text(kind, source, " ссылка ")
    for symbol, word in (("&", " и "), ("№", " номер "), ("%", " процентов ")):
        text = text.replace(symbol, word)
    text = apply_dictionary(text, words)
    text = re.sub(r"\d+(?:[.,]\d+)?", spell_number, text)
    text = LATIN_WORD.sub(transliterate, text)
    text = re.sub(r"\s+", " ", text).strip()
    return text if re.search(r"[А-Яа-яЁё]", text) else ""


def chunks_of(text):
    """Split speech text into pieces Silero accepts, at sentence ends if it can."""
    pieces = []
    for sentence in re.split(r"(?<=[.!?…»])\s+", text):
        while len(sentence) > MAX_CHUNK:
            cut = sentence.rfind(",", 0, MAX_CHUNK)
            if cut < MAX_CHUNK // 2:
                cut = sentence.rfind(" ", 0, MAX_CHUNK)
            if cut < 1:
                cut = MAX_CHUNK
            pieces.append(sentence[:cut + 1].strip())
            sentence = sentence[cut + 1:].strip()
        if sentence:
            pieces.append(sentence)

    chunks, current = [], ""
    for piece in pieces:
        if current and len(current) + len(piece) + 1 > MAX_CHUNK:
            chunks.append(current)
            current = piece
        else:
            current = f"{current} {piece}".strip()
    if current:
        chunks.append(current)
    return chunks


def find_ffmpeg():
    for candidate in (
        shutil.which("ffmpeg"),
        "/opt/homebrew/bin/ffmpeg",
        "/usr/local/bin/ffmpeg",
    ):
        if candidate and os.path.exists(candidate):
            return candidate
    try:
        import imageio_ffmpeg
    except ImportError:
        sys.exit("ffmpeg not found")
    return imageio_ffmpeg.get_ffmpeg_exe()


def has_silero():
    return all(importlib.util.find_spec(name) for name in ("silero", "num2words"))


class SileroVoice:
    """Loads the model on first use, so a fully cached text starts at once."""

    suffix = ".mp3"

    def __init__(self, speaker):
        self.speaker = speaker
        self.words = load_dictionary()
        self.model = None

    def is_ready(self):
        return has_silero()

    def speech(self, kind, source):
        return to_speech(kind, source, self.words)

    def cache_key(self, speech):
        return f"{MODEL_ID}|{self.speaker}|{speech}"

    def render(self, speech, target):
        pcm, failed = self.speak(speech)
        if pcm:
            encode_mp3(pcm, target, find_ffmpeg())
        return failed

    def retime(self, source, target, speed):
        retime_with_ffmpeg(source, target, speed)

    def speak(self, text):
        import numpy as np

        if self.model is None:
            warnings.filterwarnings("ignore")
            import torch
            from silero import silero_tts

            torch.set_num_threads(4)
            # The package writes its list of models into the current folder.
            os.chdir(HOME_DIR)
            # The package prints a download progress bar to stdout.
            with contextlib.redirect_stdout(sys.stderr):
                self.model, _ = silero_tts(language="ru", speaker=MODEL_ID)

        pause = np.zeros(int(SAMPLE_RATE * PAUSE_SECONDS), dtype=np.float32)
        parts, failed = [], 0
        for chunk in chunks_of(text):
            try:
                audio = self.model.apply_tts(
                    text=chunk,
                    speaker=self.speaker,
                    sample_rate=SAMPLE_RATE,
                    put_accent=True,
                    put_yo=True,
                    put_stress_homo=True,
                    put_yo_homo=True,
                )
            except Exception as error:
                print(f"skipped: {error}: {chunk[:80]}", file=sys.stderr)
                failed += 1
                continue
            parts += [audio.numpy(), pause]
        if not parts:
            return None, failed
        pcm = np.clip(np.concatenate(parts), -1, 1) * 32767
        return pcm.astype(np.int16).tobytes(), failed


def encode_mp3(pcm, target, ffmpeg):
    partial = target.with_suffix(".partial.mp3")
    subprocess.run(
        [
            ffmpeg, "-nostdin", "-loglevel", "error", "-y",
            "-f", "s16le", "-ar", str(SAMPLE_RATE), "-ac", "1", "-i", "pipe:0",
            "-ac", "1", "-b:a", "64k", str(partial),
        ],
        input=pcm,
        check=True,
    )
    partial.rename(target)


def retime_with_ffmpeg(source, target, speed):
    partial = target.with_suffix(".partial" + target.suffix)
    subprocess.run(
        [
            find_ffmpeg(), "-nostdin", "-loglevel", "error", "-y", "-i", str(source),
            "-filter:a", f"atempo={speed:g}", "-ac", "1", "-b:a", "64k",
            str(partial),
        ],
        check=True,
    )
    partial.rename(target)


class CommandVoice:
    """A program that reads text on stdin and writes a sound file to {out}."""

    def __init__(self, voice_id, command, suffix=".wav"):
        self.voice_id = voice_id
        self.command = command
        self.suffix = suffix

    def is_ready(self):
        return True

    def speech(self, kind, source):
        return plain_text(kind, source)

    def cache_key(self, speech):
        return f"{self.voice_id}|{speech}"

    def run(self, text, target, rate=BASE_RATE):
        partial = target.with_suffix(".partial" + target.suffix)
        argv = [
            part.replace("{out}", str(partial)).replace("{rate}", str(rate))
            for part in self.command
        ]
        subprocess.run(argv, input=text.encode("utf-8"), check=True)
        partial.rename(target)

    def render(self, speech, target):
        self.run(speech, target)
        target.with_suffix(".txt").write_text(speech, encoding="utf-8")
        return 0

    def retime(self, source, target, speed):
        if any("{rate}" in part for part in self.command):
            text = source.with_suffix(".txt").read_text(encoding="utf-8")
            self.run(text, target, round(BASE_RATE * speed))
        else:
            retime_with_ffmpeg(source, target, speed)


def custom_voices():
    if not VOICES_PATH.exists():
        return []
    return json.loads(VOICES_PATH.read_text(encoding="utf-8"))


def system_languages():
    listed = subprocess.run(
        ["defaults", "read", "-g", "AppleLanguages"], capture_output=True, text=True,
    ).stdout
    return {"ru", *re.findall(r"\b[a-z]{2}\b", listed)}


def system_voices():
    """The voices of macOS in Russian and in the languages of this system."""
    if not shutil.which("say"):
        return []
    listed = subprocess.run(["say", "-v", "?"], capture_output=True, text=True).stdout
    languages = system_languages()
    found = {}
    for name, language in re.findall(r"^(.+?)\s+([a-z]{2})_\w+\s+#", listed, flags=re.M):
        if language in languages:
            found[name] = {
                "id": f"say:{name}",
                "label": f"macOS: {name.split(' (')[0]} ({language})",
                "isReady": True,
            }
    return list(found.values())


def available_voices():
    silero = [
        {
            "id": f"silero:{speaker}",
            "label": f"Silero: {speaker.capitalize()}",
            "isReady": has_silero(),
        }
        for speaker in SILERO_SPEAKERS
    ]
    custom = [
        {"id": voice["id"], "label": voice["label"], "isReady": True}
        for voice in custom_voices()
    ]
    return silero + system_voices() + custom


def voice_by_id(voice_id):
    family, _, name = voice_id.partition(":")
    if family == "silero":
        return SileroVoice(name)
    if family == "say":
        return CommandVoice(voice_id, [part.replace("{name}", name) for part in SAY_COMMAND])
    for voice in custom_voices():
        if voice["id"] == voice_id:
            return CommandVoice(voice_id, voice["command"], "." + voice.get("format", "wav"))
    sys.exit(f"Voice not found: {voice_id}")


def at_speed(clip, speed, voice):
    """The clip at another tempo; made once, beside the original."""
    # A clip already retimed counts from its original, not from its own tempo.
    base = re.sub(r"\.x[\d.]+$", "", clip.stem)
    source = clip.with_name(f"{base}{clip.suffix}")
    if speed == 1:
        return source
    target = clip.with_name(f"{base}.x{speed:g}{clip.suffix}")
    if not target.exists():
        voice.retime(source, target, speed)
    return target


def build(text, title, voice, is_spoken=True):
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    blocks, skipped = [], 0
    for kind, source in split_blocks(text):
        speech = voice.speech(kind, source) if is_spoken else ""
        audio = None
        if speech:
            key = hashlib.sha1(voice.cache_key(speech).encode()).hexdigest()
            target = CACHE_DIR / f"{key}{voice.suffix}"
            if not target.exists():
                skipped += voice.render(speech, target)
            if target.exists():
                audio = str(target)
        blocks.append({"md": source, "audio": audio})
    return {"title": title, "blocks": blocks, "skipped": skipped, "isSpoken": is_spoken}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", nargs="?")
    parser.add_argument("--stdin", action="store_true")
    parser.add_argument("--title", default="Selected text")
    parser.add_argument("--retime", type=float)
    parser.add_argument("--view", action="store_true")
    parser.add_argument("--voice", default=DEFAULT_VOICE)
    parser.add_argument("--voices", action="store_true")
    args = parser.parse_args()

    if args.voices:
        print(json.dumps(available_voices(), ensure_ascii=False))
        return

    voice = voice_by_id(args.voice)
    if args.retime is not None:
        print(at_speed(Path(args.path), args.retime, voice))
        return
    if not args.view and not voice.is_ready():
        sys.exit(VOICE_MISSING)

    if args.stdin:
        text, title = sys.stdin.read(), args.title
    else:
        path = Path(args.path).expanduser()
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            sys.exit(f"Cannot read the file: {path}")
        heading = re.search(r"^#{1,6}\s+(.+)$", text, flags=re.M)
        title = EMOJI.sub("", heading.group(1)).strip() if heading else path.name

    print(json.dumps(build(text, title, voice, not args.view), ensure_ascii=False))


if __name__ == "__main__":
    main()
