import cors from 'cors';
import express from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const app = express();
const PORT = 8788;
const HOST = '127.0.0.1';
const ROOT = path.resolve('local-data');
const INCOMING = path.join(ROOT, 'incoming');
const JOBS_ROOT = path.join(ROOT, 'jobs');
const jobs = new Map();
const queue = [];
let queueRunning = false;
const FLOW_HOSTS = new Set(['flowmusic.app', 'www.flowmusic.app']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

await mkdir(INCOMING, { recursive: true });
await mkdir(JOBS_ROOT, { recursive: true });

app.use(cors({ origin: ['http://localhost:3000', 'http://127.0.0.1:3000'] }));
app.use(express.json());

const storage = multer.diskStorage({
  destination: (_req, _file, callback) => callback(null, INCOMING),
  filename: (_req, file, callback) => {
    const extension = path.extname(file.originalname).slice(0, 12);
    callback(null, `${randomUUID()}${extension}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 * 1024, files: 101 },
});

function clamp(value, min, max) {
  return Math.min(Math.max(Number(value) || 0, min), max);
}

function safeName(value, fallback) {
  const cleaned = String(value || fallback)
    .normalize('NFKC')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return cleaned || fallback;
}

function flowPlaylistId(value) {
  let parsed;
  try { parsed = new URL(String(value || '')); } catch { throw new Error('Cole um link válido de playlist do Flow Music.'); }
  if (parsed.protocol !== 'https:' || !FLOW_HOSTS.has(parsed.hostname)) throw new Error('Use um link de playlist do Flow Music.');
  const match = parsed.pathname.match(/^\/playlist\/([0-9a-f-]{36})\/?$/i);
  if (!match || !UUID_PATTERN.test(match[1])) throw new Error('O link não contém uma playlist válida do Flow Music.');
  return match[1];
}

async function flowFetch(url, options = {}) {
  const { timeoutMs = 45_000, ...fetchOptions } = options;
  const response = await fetch(url, {
    ...fetchOptions,
    headers: { 'user-agent': 'LoopLab/1.0', ...(fetchOptions.headers || {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`O Flow Music respondeu com erro ${response.status}.`);
  return response;
}

async function inspectFlowPlaylist(link) {
  const id = flowPlaylistId(link);
  const apiBase = 'https://www.flowmusic.app/__api';
  const [playlistResponse, pageResponse] = await Promise.all([
    flowFetch(`${apiBase}/playlists/${id}`),
    flowFetch(`https://www.flowmusic.app/playlist/${id}`),
  ]);
  const playlist = await playlistResponse.json();
  const pageHtml = await pageResponse.text();
  const clipIds = Array.isArray(playlist.clips) ? playlist.clips.map((item) => item.clip_id).filter((clipId) => UUID_PATTERN.test(clipId)) : [];
  if (!clipIds.length) throw new Error('Essa playlist não tem faixas públicas disponíveis.');

  const clipsResponse = await flowFetch(`${apiBase}/clips`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clip_ids: clipIds }),
  });
  const clipsBody = await clipsResponse.json();
  const clips = clipsBody.clips || {};
  const tracks = clipIds.map((clipId, index) => {
    const clip = clips[clipId];
    if (!clip) throw new Error(`A faixa ${index + 1} não está disponível para download.`);
    return {
      clipId,
      title: safeName(clip.title, `Faixa ${index + 1}`),
      duration: Number(clip.duration?.value || 0),
    };
  });

  let name = 'Playlist do Flow Music';
  const nextData = pageHtml.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (nextData) {
    try {
      const pageData = JSON.parse(nextData[1]);
      const query = pageData?.props?.sdc?.queryClient?.queries?.find((item) => item.queryKey?.[0] === 'playlist');
      name = safeName(query?.state?.data?.name, name);
    } catch { /* mantém o nome padrão */ }
  }
  return { id, name, tracks };
}

async function downloadFlowTrack(clipId, destination) {
  if (!UUID_PATTERN.test(clipId)) throw new Error('Identificador de faixa inválido.');
  const response = await flowFetch(`https://storage.googleapis.com/producer-app-public/clips/${clipId}.wav`, { timeoutMs: 300_000 });
  if (!response.body) throw new Error('O Flow Music não retornou o arquivo WAV.');
  await pipeline(response.body, createWriteStream(destination));
}

function formatTime(seconds, decimals = false) {
  const safe = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const rawSeconds = safe % 60;
  const secondsText = decimals
    ? rawSeconds.toFixed(3).padStart(6, '0')
    : String(Math.round(rawSeconds)).padStart(2, '0');
  return `${hours ? `${String(hours).padStart(2, '0')}:` : ''}${String(minutes).padStart(2, '0')}:${secondsText}`;
}

async function probe(filePath) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error', '-show_entries',
    'format=duration:stream=codec_name,codec_type,width,height,r_frame_rate,sample_rate,channels',
    '-of', 'json', filePath,
  ], { maxBuffer: 8 * 1024 * 1024 });
  const data = JSON.parse(stdout);
  const video = data.streams?.find((stream) => stream.codec_type === 'video');
  const audio = data.streams?.find((stream) => stream.codec_type === 'audio');
  return {
    duration: Number(data.format?.duration || 0),
    video,
    audio,
  };
}

function parseFps(value) {
  if (!value || typeof value !== 'string') return 24;
  const [left, right = '1'] = value.split('/').map(Number);
  const fps = right ? left / right : left;
  return Number.isFinite(fps) && fps > 0 ? Math.min(fps, 60) : 24;
}

function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    error: job.error || null,
    timeline: job.timeline,
    totalDuration: job.totalDuration,
    outputName: job.outputName,
    createdAt: job.createdAt,
  };
}

function setJob(job, update) {
  Object.assign(job, update);
}

function runFfmpeg(job, args, duration, baseProgress, progressSpan) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    job.process = child;
    let stderr = '';
    let progressBuffer = '';

    child.stdout.on('data', (chunk) => {
      progressBuffer += chunk.toString();
      const lines = progressBuffer.split('\n');
      progressBuffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('out_time_ms=')) continue;
        const microseconds = Number(line.slice('out_time_ms='.length));
        const seconds = microseconds / 1_000_000;
        const ratio = duration > 0 ? Math.min(seconds / duration, 1) : 0;
        job.progress = Math.round((baseProgress + ratio * progressSpan) * 10) / 10;
      }
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 32_000) stderr = stderr.slice(-32_000);
    });

    child.on('error', reject);
    child.on('close', (code, signal) => {
      job.process = null;
      if (job.status === 'cancelled') return resolve();
      if (code === 0) return resolve();
      reject(new Error(`FFmpeg encerrou com código ${code ?? signal}. ${stderr.slice(-1500)}`));
    });
  });
}

async function buildTitleCard(title, width, index, jobDir) {
  const fontSize = Math.round(clamp(width * 0.027, 28, 48));
  const cardWidth = Math.min(
    width - Math.round(width * 0.075),
    Math.max(230, Math.round(title.length * fontSize * 0.62 + 46)),
  );
  const cardHeight = Math.round(fontSize * 1.75);
  const svg = `
    <svg width="${cardWidth}" height="${cardHeight}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" rx="12" fill="rgba(0,0,0,.62)" />
      <text x="22" y="${Math.round(cardHeight * 0.68)}" fill="#fff"
        font-family="Arial, Helvetica, sans-serif" font-size="${fontSize}" font-weight="700">${xmlEscape(title)}</text>
    </svg>`;
  const output = path.join(jobDir, `title-${String(index + 1).padStart(2, '0')}.png`);
  await sharp(Buffer.from(svg)).png().toFile(output);
  return output;
}

async function writeReports(job, jobDir) {
  const csv = [
    'ordem,musica,inicio,fim,duracao_segundos',
    ...job.timeline.map((item) => [
      item.order,
      `"${item.title.replaceAll('"', '""')}"`,
      item.startLabel,
      item.endLabel,
      item.duration.toFixed(3),
    ].join(',')),
  ].join('\n');

  const txt = [
    `LoopLab — relatório de músicas`,
    `Duração total: ${formatTime(job.totalDuration)}`,
    `Intervalo: ${job.settings.gapSeconds}s`,
    '',
    ...job.timeline.map((item) => `${String(item.order).padStart(2, '0')}. ${item.startLabel} — ${item.title} (${formatTime(item.duration)})`),
  ].join('\n');

  const json = JSON.stringify({
    totalDuration: job.totalDuration,
    gapSeconds: job.settings.gapSeconds,
    tracks: job.timeline,
  }, null, 2);

  job.reports = {
    csv: path.join(jobDir, 'relatorio.csv'),
    txt: path.join(jobDir, 'relatorio.txt'),
    json: path.join(jobDir, 'relatorio.json'),
  };
  await Promise.all([
    writeFile(job.reports.csv, csv),
    writeFile(job.reports.txt, txt),
    writeFile(job.reports.json, json),
  ]);
}

async function processJob(job) {
  const jobDir = job.jobDir;
  try {
    setJob(job, { status: 'processing', stage: 'Preparando os arquivos', progress: 1 });

    const flowTracks = job.tracks.filter((track) => track.source === 'flow');
    for (let index = 0; index < flowTracks.length; index += 1) {
      setJob(job, {
        stage: `Baixando faixa ${index + 1} de ${flowTracks.length} do Flow Music`,
        progress: Math.round((1 + ((index + 1) / flowTracks.length) * 10) * 10) / 10,
      });
      await downloadFlowTrack(flowTracks[index].clipId, flowTracks[index].path);
    }

    setJob(job, { stage: 'Analisando os arquivos', progress: flowTracks.length ? 12 : 1 });

    const [videoInfo, ...trackInfo] = await Promise.all([
      probe(job.video.path),
      ...job.tracks.map((track) => probe(track.path)),
    ]);

    if (!videoInfo.video) throw new Error('O arquivo selecionado não contém uma faixa de vídeo válida.');
    if (trackInfo.some((info) => !info.audio || !info.duration)) throw new Error('Uma ou mais músicas não puderam ser analisadas.');

    let cursor = 0;
    job.timeline = job.tracks.map((track, index) => {
      const duration = trackInfo[index].duration;
      const item = {
        order: index + 1,
        title: track.title,
        start: cursor,
        end: cursor + duration,
        duration,
        startLabel: formatTime(cursor),
        startPrecise: formatTime(cursor, true),
        endLabel: formatTime(cursor + duration),
      };
      cursor += duration + (index < job.tracks.length - 1 ? job.settings.gapSeconds : 0);
      return item;
    });
    job.totalDuration = cursor;
    await writeReports(job, jobDir);

    setJob(job, { stage: 'Preparando as músicas', progress: 15 });
    const audioFilterPath = path.join(jobDir, 'audio.filter');
    const audioPath = path.join(jobDir, 'playlist.m4a');
    const filterLines = [];
    const concatInputs = [];
    for (let index = 0; index < job.tracks.length; index += 1) {
      filterLines.push(`[${index}:a]aformat=sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS[a${index}]`);
      concatInputs.push(`[a${index}]`);
      if (index < job.tracks.length - 1 && job.settings.gapSeconds > 0) {
        filterLines.push(`anullsrc=r=48000:cl=stereo:d=${job.settings.gapSeconds}[s${index}]`);
        concatInputs.push(`[s${index}]`);
      }
    }
    filterLines.push(`${concatInputs.join('')}concat=n=${concatInputs.length}:v=0:a=1[outa]`);
    await writeFile(audioFilterPath, filterLines.join(';\n'));

    const audioArgs = ['-hide_banner', '-y'];
    for (const track of job.tracks) audioArgs.push('-i', track.path);
    audioArgs.push(
      '-filter_complex_script', audioFilterPath,
      '-map', '[outa]', '-c:a', 'aac', '-b:a', '256k',
      '-progress', 'pipe:1', '-nostats', audioPath,
    );
    await runFfmpeg(job, audioArgs, job.totalDuration, 15, 15);
    if (job.status === 'cancelled') return;

    const fps = parseFps(videoInfo.video.r_frame_rate);
    const width = Number(videoInfo.video.width || 1280);
    const outputBase = safeName(job.settings.outputName, 'LoopLab - video final');
    job.outputName = outputBase.toLowerCase().endsWith('.mp4') ? outputBase : `${outputBase}.mp4`;
    job.outputPath = path.join(jobDir, job.outputName);

    const renderArgs = ['-hide_banner', '-y', '-stream_loop', '-1', '-i', job.video.path];
    let outputVideoLabel = '0:v:0';
    let audioInputIndex = 1;

    if (job.settings.titlesEnabled) {
      setJob(job, { stage: 'Criando os títulos', progress: 31 });
      const cards = [];
      for (let index = 0; index < job.timeline.length; index += 1) {
        cards.push(await buildTitleCard(job.timeline[index].title, width, index, jobDir));
      }
      for (const card of cards) {
        renderArgs.push('-loop', '1', '-framerate', String(fps), '-t', String(job.settings.titleDuration), '-i', card);
      }
      audioInputIndex = cards.length + 1;
      renderArgs.push('-i', audioPath);

      const margin = Math.round(width * 0.038);
      const fade = Math.min(job.settings.fadeDuration, job.settings.titleDuration / 2);
      const videoFilterPath = path.join(jobDir, 'video.filter');
      const videoFilters = ['[0:v]setpts=PTS-STARTPTS[v0]'];
      for (let index = 0; index < cards.length; index += 1) {
        const start = job.timeline[index].start;
        const fadeOutStart = Math.max(job.settings.titleDuration - fade, fade);
        videoFilters.push(
          `[${index + 1}:v]format=rgba,fade=t=in:st=0:d=${fade}:alpha=1,fade=t=out:st=${fadeOutStart}:d=${fade}:alpha=1,setpts=PTS+${start.toFixed(6)}/TB[t${index}]`,
        );
        videoFilters.push(
          `[v${index}][t${index}]overlay=x=${margin}:y=main_h-overlay_h-${margin}:eof_action=pass:repeatlast=0[v${index + 1}]`,
        );
      }
      await writeFile(videoFilterPath, videoFilters.join(';\n'));
      renderArgs.push('-filter_complex_script', videoFilterPath);
      outputVideoLabel = `[v${cards.length}]`;
    } else {
      renderArgs.push('-i', audioPath);
    }

    setJob(job, { stage: 'Renderizando o vídeo', progress: 32 });
    renderArgs.push('-map', outputVideoLabel, '-map', `${audioInputIndex}:a:0`);

    const canCopyVideo = !job.settings.titlesEnabled && ['h264', 'hevc'].includes(videoInfo.video.codec_name);
    if (canCopyVideo) {
      renderArgs.push('-c:v', 'copy');
    } else {
      const high = job.settings.quality === 'high';
      renderArgs.push(
        '-c:v', 'libx264', '-preset', high ? 'slow' : 'medium', '-crf', high ? '16' : '20',
        '-profile:v', 'high', '-pix_fmt', 'yuv420p',
      );
    }
    renderArgs.push(
      '-c:a', 'copy', '-shortest', '-movflags', '+faststart',
      '-progress', 'pipe:1', '-nostats', job.outputPath,
    );

    await runFfmpeg(job, renderArgs, job.totalDuration, 32, 67);
    if (job.status === 'cancelled') return;
    setJob(job, { status: 'completed', stage: 'Concluído', progress: 100 });
  } catch (error) {
    console.error(error);
    setJob(job, {
      status: 'failed',
      stage: 'Falha no processamento',
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function drainQueue() {
  if (queueRunning) return;
  queueRunning = true;
  while (queue.length) {
    const job = queue.shift();
    if (job.status !== 'cancelled') await processJob(job);
  }
  queueRunning = false;
}

app.get('/api/health', async (_req, res) => {
  try {
    await Promise.all([
      execFileAsync('ffmpeg', ['-version']),
      execFileAsync('ffprobe', ['-version']),
    ]);
    res.json({ ok: true, ffmpeg: true });
  } catch {
    res.status(503).json({ ok: false, error: 'FFmpeg não foi encontrado neste Mac.' });
  }
});

app.post('/api/flow/playlist', async (req, res) => {
  try {
    res.json(await inspectFlowPlaylist(req.body?.url));
  } catch (error) {
    console.error(error);
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/jobs', upload.fields([
  { name: 'video', maxCount: 1 },
  { name: 'tracks', maxCount: 100 },
]), async (req, res) => {
  try {
    const videoFile = req.files?.video?.[0];
    const trackFiles = req.files?.tracks || [];
    const rawSettings = JSON.parse(req.body.settings || '{}');
    const titles = Array.isArray(rawSettings.trackTitles) ? rawSettings.trackTitles : [];
    const sources = Array.isArray(rawSettings.trackSources) ? rawSettings.trackSources : trackFiles.map((_file, uploadIndex) => ({ type: 'local', uploadIndex }));
    if (!videoFile || !sources.length) return res.status(400).json({ error: 'Selecione um vídeo e pelo menos uma música.' });
    const settings = {
      gapSeconds: clamp(rawSettings.gapSeconds, 0, 30),
      titlesEnabled: rawSettings.titlesEnabled !== false,
      titleDuration: clamp(rawSettings.titleDuration || 5, 1, 20),
      fadeDuration: clamp(rawSettings.fadeDuration ?? 0.5, 0, 5),
      quality: rawSettings.quality === 'balanced' ? 'balanced' : 'high',
      outputName: safeName(rawSettings.outputName, 'LoopLab - video final'),
    };

    const id = randomUUID();
    const jobDir = path.join(JOBS_ROOT, id);
    await mkdir(jobDir, { recursive: true });
    const videoPath = path.join(jobDir, `video${path.extname(videoFile.originalname)}`);
    await rename(videoFile.path, videoPath);

    const tracks = [];
    for (let index = 0; index < sources.length; index += 1) {
      const source = sources[index];
      if (source?.type === 'flow') {
        if (!UUID_PATTERN.test(source.clipId || '')) throw new Error(`A faixa ${index + 1} do Flow Music é inválida.`);
        tracks.push({
          source: 'flow',
          clipId: source.clipId,
          path: path.join(jobDir, `track-${String(index + 1).padStart(3, '0')}.wav`),
          originalName: `${source.clipId}.wav`,
          title: safeName(titles[index], `Faixa ${index + 1}`),
        });
        continue;
      }
      const file = trackFiles[Number(source?.uploadIndex)];
      if (!file) throw new Error(`O arquivo da faixa ${index + 1} não foi recebido.`);
      const destination = path.join(jobDir, `track-${String(index + 1).padStart(3, '0')}${path.extname(file.originalname)}`);
      await rename(file.path, destination);
      tracks.push({
        source: 'local',
        path: destination,
        originalName: file.originalname,
        title: safeName(titles[index] || path.basename(file.originalname, path.extname(file.originalname)), `Faixa ${index + 1}`),
      });
    }

    const job = {
      id,
      jobDir,
      video: { path: videoPath, originalName: videoFile.originalname },
      tracks,
      settings,
      status: 'queued',
      stage: 'Na fila',
      progress: 0,
      timeline: [],
      totalDuration: 0,
      outputName: null,
      createdAt: new Date().toISOString(),
      process: null,
    };
    jobs.set(id, job);
    queue.push(job);
    void drainQueue();
    res.status(202).json(publicJob(job));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Processamento não encontrado.' });
  res.json(publicJob(job));
});

app.post('/api/jobs/:id/cancel', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Processamento não encontrado.' });
  job.status = 'cancelled';
  job.stage = 'Cancelado';
  job.process?.kill('SIGINT');
  res.json(publicJob(job));
});

app.get('/api/jobs/:id/download', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job?.outputPath || !existsSync(job.outputPath)) return res.status(404).json({ error: 'O vídeo ainda não está disponível.' });
  res.download(job.outputPath, job.outputName);
});

app.get('/api/jobs/:id/report/:format', (req, res) => {
  const job = jobs.get(req.params.id);
  const format = req.params.format;
  const report = job?.reports?.[format];
  if (!report || !existsSync(report)) return res.status(404).json({ error: 'Relatório não disponível.' });
  res.download(report, `relatorio-musicas.${format}`);
});

const server = app.listen(PORT, HOST, () => {
  console.log(`LoopLab video engine: http://${HOST}:${PORT}`);
});

server.on('error', (error) => {
  console.error('Não foi possível iniciar o motor de vídeo:', error);
  process.exit(1);
});
