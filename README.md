# LoopLab

Aplicativo para transformar um vídeo curto e uma playlist em um MP4 longo, com intervalos, títulos e relatório de tempos. A fonte principal pode ser um link público de playlist do Flow Music; anexos de áudio do Mac continuam disponíveis como alternativa.

## Como abrir

1. Dê dois cliques em **Iniciar LoopLab.command**.
2. Aguarde o navegador abrir em `http://localhost:3000`.
3. Mantenha a janela do Terminal aberta enquanto estiver usando o aplicativo.
4. Para encerrar, feche o Terminal ou pressione `Control + C` nele.

O vídeo é processado apenas neste Mac. Quando você usa um link do Flow Music, o LoopLab acessa a playlist pública e baixa os WAVs oficiais diretamente para a pasta do trabalho. Nada é publicado ou enviado pelo LoopLab.

## Fluxo

1. Escolha o vídeo-base.
2. Cole o link público da playlist do Flow Music e clique em **Carregar**. Se preferir, abra **Anexar músicas do Mac**.
3. Arraste as faixas ou use as setas para ordenar.
4. Edite os nomes que aparecerão no vídeo e no relatório.
5. Defina intervalo, títulos, fade e qualidade.
6. Clique em **Gerar vídeo**.
7. Baixe o MP4 e o relatório em TXT, CSV ou JSON.

## Requisitos

- macOS
- Node.js 22 ou superior
- FFmpeg e FFprobe disponíveis no sistema

Os arquivos temporários e resultados ficam em `local-data/`, dentro desta pasta. Eles não são apagados automaticamente.

Playlists privadas ou links que exigem login não podem ser importados automaticamente.
