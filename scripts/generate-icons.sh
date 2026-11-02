#!/bin/sh
# Deterministic librsvg rasterization of the checked-in brand SVG. No network.
set -eu
cd "$(dirname "$0")/.."
rsvg-convert --width 192 --height 192 web/icon.svg > web/icon-192.png
rsvg-convert --width 512 --height 512 web/icon.svg > web/icon-512.png
# An opaque background and inset mark keep the artwork inside the maskable safe circle.
sed 's/rx="42" //; s/<path /<path transform="translate(19.2 19.2) scale(.8)" /' web/icon.svg | rsvg-convert --width 512 --height 512 > web/icon-maskable-512.png
