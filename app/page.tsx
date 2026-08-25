'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

const API = 'http://127.0.0.1:8788/api';
const ACTIVE_JOB_KEY = 'looplab-active-job-id';

type Track = {
  id: string;
  source: 'local' | 'flow';
  file?: File;
  clipId?: string;
  title: string;
  duration: number | null;
};

type FlowPlaylist = {
  id: string;
  name: string;
  tracks: Array<{
    clipId: string;
    title: string;
    duration: number;
  }>;
};

type TimelineItem = {
  order: number;
  title: string;
  start: number;
  end: number;
  duration: number;
  startLabel: string;
  endLabel: string;
};

type Job = {
  id: string;
  status: 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';
  stage: string;
  progress: number;
  error?: string | null;
  timeline: TimelineItem[];
  totalDuration: number;
  outputName?: string | null;
};

function fileSize(bytes: number) {
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(bytes > 1024 ** 3 ? 0 : 1)} MB`;
}

function formatTime(seconds: number, precise = false) {
  const safe = Math.max(0, seconds || 0);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const rawSeconds = safe % 60;
  const secondText = precise
    ? rawSeconds.toFixed(1).padStart(4, '0')
    : String(Math.round(rawSeconds)).padStart(2, '0');
  return `${hours ? `${String(hours).padStart(2, '0')}:` : ''}${String(minutes).padStart(2, '0')}:${secondText}`;
}

function mediaDuration(file: File, kind: 'audio' | 'video') {
  return new Promise<number | null>((resolve) => {
    const media = document.createElement(kind);
    const url = URL.createObjectURL(file);
    media.preload = 'metadata';
    media.onloadedmetadata = () => {
      const duration = Number.isFinite(media.duration) ? media.duration : null;
      URL.revokeObjectURL(url);
      resolve(duration);
    };
    media.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    media.src = url;
  });
}

function uploadJob(form: FormData, onProgress: (value: number) => void) {
  return new Promise<Job>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', `${API}/jobs`);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    request.onload = () => {
      let body: Job | { error?: string; activeJob?: Job };
      try { body = JSON.parse(request.responseText); } catch { return reject(new Error('Resposta inválida do servidor.')); }
      if (request.status >= 200 && request.status < 300) return resolve(body as Job);
      const failure = new Error((body as { error?: string }).error || 'Não foi possível iniciar o processamento.') as Error & { activeJob?: Job };
      failure.activeJob = (body as { activeJob?: Job }).activeJob;
      reject(failure);
    };
    request.onerror = () => reject(new Error('O motor de vídeo não está acessível.'));
    request.send(form);
  });
}

export default function Home() {
  const [video, setVideo] = useState<File | null>(null);
  const [videoDuration, setVideoDuration] = useState<number | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [playlistUrl, setPlaylistUrl] = useState('');
  const [playlistName, setPlaylistName] = useState('');
  const [playlistLoading, setPlaylistLoading] = useState(false);
  const [gap, setGap] = useState(2);
  const [titlesEnabled, setTitlesEnabled] = useState(true);
  const [titleDuration, setTitleDuration] = useState(5);
  const [fadeDuration, setFadeDuration] = useState(0.5);
  const [quality, setQuality] = useState<'high' | 'balanced'>('high');
  const [outputName, setOutputName] = useState('LoopLab - vídeo final');
  const [serverReady, setServerReady] = useState<boolean | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [error, setError] = useState('');
  const dragIndex = useRef<number | null>(null);
  const activeJobId = job?.id;
  const activeJobStatus = job?.status;

  function keepActiveJob() {
    setJob((current) => current && ['queued', 'processing'].includes(current.status) ? current : null);
  }

  async function loadActiveJobById(id: string | null) {
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return null;
    try {
      const response = await fetch(`${API}/jobs/${id}`);
      if (!response.ok) return null;
      const candidate = await response.json() as Job;
      if (!['queued', 'processing'].includes(candidate.status)) return null;
      window.localStorage.setItem(ACTIVE_JOB_KEY, candidate.id);
      return candidate;
    } catch {
      return null;
    }
  }

  async function findActiveJob() {
    try {
      const response = await fetch(`${API}/jobs/active`);
      if (response.ok) {
        const active = await response.json() as Job;
        window.localStorage.setItem(ACTIVE_JOB_KEY, active.id);
        return active;
      }
    } catch { /* tenta recuperar pelo identificador salvo */ }

    const savedJob = await loadActiveJobById(window.localStorage.getItem(ACTIVE_JOB_KEY));
    if (savedJob) return savedJob;

    try {
      const response = await fetch('/looplab-active-job.txt', { cache: 'no-store' });
      if (response.ok) return await loadActiveJobById((await response.text()).trim());
    } catch {
      /* o arquivo só existe enquanto uma renderização antiga está ativa */
    }
    return null;
  }

  useEffect(() => {
    fetch(`${API}/health`)
      .then((response) => { if (!response.ok) throw new Error(); return response.json(); })
      .then(() => setServerReady(true))
      .catch(() => setServerReady(false));
    void findActiveJob().then((active) => { if (active) setJob(active); });
  }, []);

  useEffect(() => {
    if (!job?.id) return;
    if (['queued', 'processing'].includes(job.status)) {
      window.localStorage.setItem(ACTIVE_JOB_KEY, job.id);
    } else if (window.localStorage.getItem(ACTIVE_JOB_KEY) === job.id) {
      window.localStorage.removeItem(ACTIVE_JOB_KEY);
    }
  }, [job?.id, job?.status]);

  useEffect(() => {
    if (activeJobId && activeJobStatus && ['queued', 'processing'].includes(activeJobStatus)) return;
    const recover = () => { void findActiveJob().then((active) => { if (active) setJob(active); }); };
    const timer = window.setInterval(recover, 2000);
    window.addEventListener('storage', recover);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('storage', recover);
    };
  }, [activeJobId, activeJobStatus]);

  useEffect(() => {
    if (!activeJobId || !activeJobStatus || !['queued', 'processing'].includes(activeJobStatus)) return;
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(`${API}/jobs/${activeJobId}`);
        const next = await response.json();
        if (!response.ok) throw new Error(next.error);
        setJob(next);
      } catch (pollError) {
        const recovered = await findActiveJob();
        if (recovered) {
          setJob(recovered);
          setError('');
        } else {
          setError(pollError instanceof Error ? pollError.message : 'Falha ao consultar o processamento.');
        }
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [activeJobId, activeJobStatus]);

  const localTimeline = useMemo(() => {
    const result = tracks.reduce<{ cursor: number; items: TimelineItem[] }>((state, track, index) => {
      const duration = track.duration || 0;
      const item: TimelineItem = {
        order: index + 1,
        title: track.title,
        start: state.cursor,
        end: state.cursor + duration,
        duration,
        startLabel: formatTime(state.cursor),
        endLabel: formatTime(state.cursor + duration),
      };
      return {
        cursor: state.cursor + duration + (index < tracks.length - 1 ? gap : 0),
        items: [...state.items, item],
      };
    }, { cursor: 0, items: [] });
    return result.items;
  }, [tracks, gap]);

  const estimatedDuration = localTimeline.length ? localTimeline.at(-1)?.end || 0 : 0;
  const finalTimeline = job?.timeline?.length ? job.timeline : localTimeline;
  const busy = job && ['queued', 'processing'].includes(job.status);

  async function chooseVideo(file?: File) {
    if (!file) return;
    setVideo(file);
    setVideoDuration(await mediaDuration(file, 'video'));
    keepActiveJob();
    setError('');
  }

  async function chooseTracks(files: FileList | null) {
    if (!files?.length) return;
    const selected = await Promise.all(Array.from(files).map(async (file) => ({
      id: crypto.randomUUID(),
      source: 'local' as const,
      file,
      title: file.name.replace(/\.[^.]+$/, ''),
      duration: await mediaDuration(file, 'audio'),
    })));
    setTracks((current) => [...current, ...selected]);
    keepActiveJob();
    setError('');
  }

  async function loadFlowPlaylist() {
    const link = playlistUrl.trim();
    if (!link) return;
    setPlaylistLoading(true);
    setError('');
    keepActiveJob();
    try {
      const response = await fetch(`${API}/flow/playlist`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: link }),
      });
      const body = await response.json() as FlowPlaylist & { error?: string };
      if (!response.ok) throw new Error(body.error || 'Não foi possível ler essa playlist.');
      const imported: Track[] = body.tracks.map((track) => ({
        id: `flow-${track.clipId}`,
        source: 'flow',
        clipId: track.clipId,
        title: track.title,
        duration: track.duration,
      }));
      setTracks((current) => {
        const existing = new Set(current.map((track) => track.clipId).filter(Boolean));
        return [...current, ...imported.filter((track) => !existing.has(track.clipId))];
      });
      setPlaylistName(body.name);
      if (outputName === 'LoopLab - vídeo final') setOutputName(`${body.name} - vídeo`);
    } catch (playlistError) {
      setError(playlistError instanceof Error ? playlistError.message : 'Falha ao importar a playlist.');
    } finally {
      setPlaylistLoading(false);
    }
  }

  function reorder(from: number, to: number) {
    if (from === to || from < 0 || to < 0 || from >= tracks.length || to >= tracks.length) return;
    setTracks((current) => {
      const next = [...current];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }

  async function generate() {
    if (!video || !tracks.length) return;
    setError('');
    const alreadyActive = await findActiveJob();
    if (alreadyActive) {
      setJob(alreadyActive);
      setError('Já existe um vídeo sendo processado. O progresso atual foi restaurado.');
      return;
    }
    setJob(null);
    setUploadProgress(0);
    const form = new FormData();
    form.append('video', video);
    let uploadIndex = 0;
    const trackSources = tracks.map((track) => {
      if (track.source === 'flow') return { type: 'flow', clipId: track.clipId };
      form.append('tracks', track.file as File);
      const source = { type: 'local', uploadIndex };
      uploadIndex += 1;
      return source;
    });
    form.append('settings', JSON.stringify({
      gapSeconds: gap,
      titlesEnabled,
      titleDuration,
      fadeDuration,
      quality,
      outputName,
      trackTitles: tracks.map((track) => track.title),
      trackSources,
    }));
    try {
      setJob({ id: '', status: 'queued', stage: 'Copiando os arquivos para o motor de vídeo', progress: 0, timeline: [], totalDuration: estimatedDuration });
      const created = await uploadJob(form, setUploadProgress);
      setJob(created);
    } catch (generationError) {
      const active = (generationError as Error & { activeJob?: Job }).activeJob;
      if (active) {
        setJob(active);
      } else {
        const recovered = await findActiveJob();
        setJob(recovered);
      }
      setError(generationError instanceof Error ? generationError.message : 'Falha ao iniciar o processamento.');
    }
  }

  async function cancelJob() {
    if (!job?.id || !window.confirm('Cancelar a renderização atual?')) return;
    const response = await fetch(`${API}/jobs/${job.id}/cancel`, { method: 'POST' });
    setJob(await response.json());
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-mark">L</div>
        <div><strong>LoopLab</strong><span>Estúdio de vídeo</span></div>
        <div className={`privacy-pill ${serverReady === false ? 'offline' : ''}`}>
          <i /> {serverReady === false ? 'Motor de vídeo desconectado' : serverReady ? 'Pronto neste Mac' : 'Conectando…'}
        </div>
      </header>

      <section className="hero">
        <div>
          <p className="eyebrow">VÍDEO + PLAYLIST, SEM COMPLICAÇÃO</p>
          <h1>Transforme um loop e suas músicas em um vídeo pronto.</h1>
          <p className="hero-copy">Organize as faixas, escolha os intervalos e gere um MP4 em alta qualidade — com títulos e relatório de tempos.</p>
        </div>
        <div className="hero-metric"><span>Processamento</span><strong>Feito no Mac</strong><small>Só o download das faixas usa internet</small></div>
      </section>

      <section className="workspace-grid">
        <div className="stack">
          <article className="panel">
            <div className="panel-heading"><span className="step">1</span><div><h2>Vídeo e músicas</h2><p>Escolha o vídeo-base e carregue a playlist pelo link.</p></div></div>
            <div className="upload-grid">
              <label className={`dropzone primary-drop ${video ? 'has-file' : ''}`}>
                <input type="file" accept="video/*" onChange={(event) => { void chooseVideo(event.target.files?.[0]); event.target.value = ''; }} />
                <span className="drop-icon">▶</span>
                <strong>{video ? video.name : 'Escolher vídeo'}</strong>
                <small>{video ? `${fileSize(video.size)}${videoDuration ? ` · ${formatTime(videoDuration, true)}` : ''}` : 'MP4, MOV ou WebM'}</small>
              </label>
              <div className="flow-import">
                <div className="flow-import-top"><span className="source-badge">PRINCIPAL</span><span>Flow Music</span></div>
                <strong>Carregar playlist pelo link</strong>
                <p>O LoopLab identifica a ordem e usa os WAVs oficiais em alta qualidade.</p>
                <div className="link-field">
                  <input aria-label="Link da playlist do Flow Music" type="url" placeholder="https://www.flowmusic.app/playlist/..." value={playlistUrl} onChange={(event) => setPlaylistUrl(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void loadFlowPlaylist(); }} />
                  <button disabled={!playlistUrl.trim() || playlistLoading || !serverReady} onClick={() => { void loadFlowPlaylist(); }}>{playlistLoading ? 'Lendo…' : 'Carregar'}</button>
                </div>
                <small>{playlistName ? `${playlistName} · ${tracks.filter((track) => track.source === 'flow').length} faixas carregadas` : 'Compatível com playlists públicas do Flow Music'}</small>
              </div>
            </div>
            <details className="manual-import">
              <summary>Anexar músicas do Mac <span>opção alternativa</span></summary>
              <label className={`manual-drop ${tracks.some((track) => track.source === 'local') ? 'has-file' : ''}`}>
                <input type="file" accept="audio/*" multiple onChange={(event) => { void chooseTracks(event.target.files); event.target.value = ''; }} />
                <span className="drop-icon">♫</span>
                <div><strong>Escolher arquivos de música</strong><small>MP3, M4A, WAV ou FLAC · você pode misturar com faixas do link</small></div>
              </label>
            </details>
          </article>

          <article className="panel">
            <div className="panel-heading compact-heading"><span className="step">2</span><div><h2>Ordem das faixas</h2><p>Arraste ou use as setas para definir a sequência final.</p></div></div>
            {tracks.length === 0 ? (
              <div className="empty-playlist"><span>♫</span><p>Suas músicas aparecerão aqui</p><small>Você poderá reorganizar, renomear ou remover cada faixa.</small></div>
            ) : (
              <div className="playlist">
                {tracks.map((track, index) => (
                  <div
                    className="track-row"
                    key={track.id}
                    draggable
                    onDragStart={() => { dragIndex.current = index; }}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={() => { if (dragIndex.current !== null) reorder(dragIndex.current, index); dragIndex.current = null; }}
                  >
                    <span className="drag-handle" title="Arrastar">⋮⋮</span>
                    <span className="track-number">{String(index + 1).padStart(2, '0')}</span>
                    <div className="track-main">
                      <input
                        aria-label={`Nome da faixa ${index + 1}`}
                        value={track.title}
                        onChange={(event) => setTracks((current) => current.map((item) => item.id === track.id ? { ...item, title: event.target.value } : item))}
                      />
                      <small>{track.source === 'flow' ? 'Flow Music · WAV' : 'Arquivo do Mac'} · {track.duration ? formatTime(track.duration, true) : 'Duração será analisada'}</small>
                    </div>
                    <div className="track-actions">
                      <button onClick={() => reorder(index, index - 1)} disabled={index === 0} aria-label="Mover para cima">↑</button>
                      <button onClick={() => reorder(index, index + 1)} disabled={index === tracks.length - 1} aria-label="Mover para baixo">↓</button>
                      <button className="remove-track" onClick={() => setTracks((current) => current.filter((item) => item.id !== track.id))} aria-label="Remover faixa">×</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </article>

          {finalTimeline.length > 0 && (
            <article className="panel report-panel">
              <div className="panel-heading compact-heading"><span className="step report-step">✓</span><div><h2>Relatório de tempos</h2><p>Início, fim e duração de cada música.</p></div></div>
              <div className="timeline-table">
                <div className="timeline-head"><span>#</span><span>Música</span><span>Início</span><span>Duração</span></div>
                {finalTimeline.map((item) => (
                  <div className="timeline-row" key={`${item.order}-${item.title}`}>
                    <span>{String(item.order).padStart(2, '0')}</span><strong>{item.title}</strong><code>{item.startLabel}</code><code>{formatTime(item.duration)}</code>
                  </div>
                ))}
              </div>
              {job?.status === 'completed' && (
                <div className="report-downloads">
                  <a href={`${API}/jobs/${job.id}/report/txt`}>Baixar TXT</a>
                  <a href={`${API}/jobs/${job.id}/report/csv`}>Baixar CSV</a>
                  <a href={`${API}/jobs/${job.id}/report/json`}>Baixar JSON</a>
                </div>
              )}
            </article>
          )}
        </div>

        <aside className="panel settings-panel">
          <div className="panel-heading compact-heading"><span className="step">3</span><div><h2>Configuração</h2><p>Defina como o vídeo será gerado.</p></div></div>
          <label className="field-label" htmlFor="gap">Intervalo entre músicas</label>
          <div className="number-field"><input id="gap" type="number" value={gap} min="0" max="30" step="0.5" onChange={(event) => setGap(Math.min(30, Math.max(0, Number(event.target.value))))} /><span>segundos</span></div>

          <div className="setting-row">
            <div><strong>Exibir nome da música</strong><small>Surge no início de cada faixa</small></div>
            <button className={`toggle ${titlesEnabled ? 'on' : ''}`} onClick={() => setTitlesEnabled((value) => !value)} aria-pressed={titlesEnabled} aria-label="Exibir nome da música"><span /></button>
          </div>

          {titlesEnabled && (
            <div className="two-fields">
              <div><label className="field-label" htmlFor="title-duration">Tempo do título</label><div className="number-field"><input id="title-duration" type="number" value={titleDuration} min="1" max="20" onChange={(event) => setTitleDuration(Math.min(20, Math.max(1, Number(event.target.value))))} /><span>s</span></div></div>
              <div><label className="field-label" htmlFor="fade-duration">Fade</label><div className="number-field"><input id="fade-duration" type="number" value={fadeDuration} min="0" max="5" step="0.1" onChange={(event) => setFadeDuration(Math.min(5, Math.max(0, Number(event.target.value))))} /><span>s</span></div></div>
            </div>
          )}

          <label className="field-label">Qualidade</label>
          <div className="quality-options">
            <button className={`quality ${quality === 'high' ? 'active' : ''}`} onClick={() => setQuality('high')}><strong>Alta</strong><small>Melhor imagem</small></button>
            <button className={`quality ${quality === 'balanced' ? 'active' : ''}`} onClick={() => setQuality('balanced')}><strong>Equilibrada</strong><small>Arquivo menor</small></button>
          </div>

          <label className="field-label" htmlFor="output-name">Nome do arquivo</label>
          <input className="text-field" id="output-name" value={outputName} maxLength={100} onChange={(event) => setOutputName(event.target.value)} />

          <div className="summary-box"><span>Duração estimada</span><strong>{estimatedDuration ? formatTime(estimatedDuration) : '—'}</strong><small>{tracks.length ? `${tracks.length} faixas · ${Math.max(tracks.length - 1, 0)} intervalos` : 'Adicione suas músicas para calcular.'}</small></div>

          {error && <div className="error-box">{error}</div>}

          {job && (busy || job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') ? (
            <div className={`job-card ${job.status}`}>
              <div className="job-status"><span>{job.stage}</span><strong>{job.status === 'completed' ? '100%' : `${job.progress || uploadProgress}%`}</strong></div>
              <div className="progress-track"><i style={{ width: `${job.status === 'completed' ? 100 : job.progress || uploadProgress}%` }} /></div>
              {job.status === 'completed' && <a className="download-video" href={`${API}/jobs/${job.id}/download`}>Baixar MP4 final</a>}
              {busy && job.id && <button className="cancel-button" onClick={() => { void cancelJob(); }}>Cancelar</button>}
              {job.status === 'failed' && <p className="job-error">{job.error}</p>}
            </div>
          ) : (
            <button className="render-button" disabled={!video || !tracks.length || !serverReady} onClick={() => { void generate(); }}>Gerar vídeo</button>
          )}
          <p className="button-note">O vídeo é processado neste computador. Faixas do Flow Music são baixadas somente ao gerar.</p>
        </aside>
      </section>
    </main>
  );
}
