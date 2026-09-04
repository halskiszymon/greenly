#!/bin/sh
# Rasterize public/img/*.svg into the PNG sizes the manifest expects.
# Uses whichever tool is available: rsvg-convert, ImageMagick (magick/convert) or macOS qlmanage.
set -e
cd "$(dirname "$0")/../public/img"

render() { # render <svg> <size> <out.png>
  if command -v rsvg-convert >/dev/null 2>&1; then
    rsvg-convert -w "$2" -h "$2" "$1" -o "$3"
  elif command -v magick >/dev/null 2>&1; then
    magick -background none -density 384 "$1" -resize "$2x$2" "$3"
  elif command -v convert >/dev/null 2>&1; then
    convert -background none -density 384 "$1" -resize "$2x$2" "$3"
  elif command -v qlmanage >/dev/null 2>&1; then
    qlmanage -t -s "$2" -o . "$1" >/dev/null 2>&1 && mv "$1.png" "$3"
  else
    echo "No SVG rasterizer found (rsvg-convert, magick, convert or qlmanage)." >&2
    exit 1
  fi
  echo "wrote $3"
}

render icon.svg 192 icon-192.png
render icon.svg 512 icon-512.png
render icon-maskable.svg 512 icon-512-maskable.png
