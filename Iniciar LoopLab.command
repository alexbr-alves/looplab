#!/bin/zsh

cd "$(dirname "$0")"

if ! command -v ffmpeg >/dev/null 2>&1 || ! command -v ffprobe >/dev/null 2>&1; then
  echo "O LoopLab precisa do FFmpeg instalado neste Mac."
  echo "Instale com: brew install ffmpeg"
  read -r "?Pressione Enter para fechar."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Preparando o LoopLab pela primeira vez..."
  npm install || exit 1
fi

(sleep 3; open "http://localhost:3000") &
npm run dev
