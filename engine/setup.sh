#!/bin/sh
# Installs Silero for the md-reader mod into ~/.local/share/md-reader:
# a virtualenv with PyTorch and the model, about 800 MB in all.
set -eu

HOME_DIR="$HOME/.local/share/md-reader"
PYTHON="$HOME_DIR/venv/bin/python"
ENGINE="$(dirname "$0")"

find_python() {
  for version in 3.12 3.13 3.11; do
    for python in \
      "python$version" \
      "/opt/homebrew/bin/python$version" \
      "/usr/local/bin/python$version" \
      "/Library/Frameworks/Python.framework/Versions/$version/bin/python$version"
    do
      if command -v "$python" >/dev/null 2>&1; then
        echo "$python"
        return
      fi
    done
  done
}

if [ ! -x "$PYTHON" ]; then
  python="$(find_python)"
  if [ -z "$python" ]; then
    echo "Python 3.11-3.13 is needed: https://www.python.org/downloads/" >&2
    exit 1
  fi
  mkdir -p "$HOME_DIR"
  "$python" -m venv "$HOME_DIR/venv"
fi

# PyPI's Linux builds of PyTorch bring CUDA, gigabytes of it.
if [ "$(uname -s)" = Linux ]; then
  "$PYTHON" -m pip install --quiet --disable-pip-version-check \
    --index-url https://download.pytorch.org/whl/cpu "$(grep '^torch==' "$ENGINE/requirements.txt")"
fi
"$PYTHON" -m pip install --quiet --disable-pip-version-check -r "$ENGINE/requirements.txt"

# One sentence fetches the model and proves the whole chain works.
printf 'Голос установлен.' | "$PYTHON" "$ENGINE/speak.py" --stdin >/dev/null
