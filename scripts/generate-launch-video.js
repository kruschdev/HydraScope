#!/usr/bin/env node
/**
 * High-Impact 1080p Product Launch Video Generator for HydraScope (~65s, 30fps).
 *
 * Renders deterministic Linear/Vercel-style motion graphics in headless Chromium
 * (`window.renderFrame(f)`), paired with ElevenLabs (`eleven_turbo_v2_5`) voiceover,
 * harmonic transition chimes, and vocal-ducked stereo synth bed via `@krusch/toolkit/audio`.
 */

import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodeWavPcm16, parseWavHeader } from '@krusch/toolkit/audio';
import { launchBrowser } from '@krusch/toolkit/browser';
import { loadProjectConfig, envOr } from '@krusch/toolkit/config';
import { safeFetch } from '@krusch/toolkit/security';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, '..');

await loadProjectConfig(ROOT_DIR, { port: 4190, serviceName: 'hydrascope' });

const FPS = 30;
const WIDTH = 1920;
const HEIGHT = 1080;
const SAMPLE_RATE = 44_100;

const DEFAULT_VOICE_ID = 'CwhRBWXzGAHq8TQ4Fs17'; // Roger
const DEFAULT_MODEL_ID = 'eleven_turbo_v2_5'; // 0.5 credit/char

const BEATS = [
  {
    id: 'hook',
    leadIn: 0.35,
    tailOut: 0.55,
    spoken:
      'Every time an A I coding agent starts a task, it burns twelve thousand tokens stuffing tool schemas into the prompt, or gambles on vector search that misses critical dependencies and injects retired rules.',
    srt: 'Every time an AI coding agent starts a task, it burns 12,000+ tokens stuffing tool schemas into the prompt, or gambles on vector search that misses critical dependencies and injects retired rules.'
  },
  {
    id: 'reveal',
    leadIn: 0.32,
    tailOut: 0.58,
    spoken:
      'Meet HydraScope: a live structural context layer for A I agents, built on open-source HydraDB. Instead of guessing with text similarity, HydraScope walks real code, skill, and rule graphs in milliseconds.',
    srt: 'Meet HydraScope: a live structural context layer for AI agents, built on open-source HydraDB. Instead of guessing with text similarity, HydraScope walks real code, skill, and rule graphs in milliseconds.'
  },
  {
    id: 'proof',
    leadIn: 0.30,
    tailOut: 0.58,
    spoken:
      'Two-hop code blast radius? One hundred percent recall. Retired S H A-one security rules? Blocked automatically via supersedes edges, with instant time-travel replay. Non-existent subsystems like Kafka? Halted pre-flight at zero tokens.',
    srt: '2-hop code blast radius? 100% recall. Retired SHA-1 security rules? Blocked automatically via :SUPERSEDES edges, with instant time-travel replay. Non-existent subsystems like Kafka? Halted pre-flight at 0 tokens.'
  },
  {
    id: 'continual',
    leadIn: 0.32,
    tailOut: 0.62,
    spoken:
      'And HydraScope gets sharper after every run. As your agent resolves partner accounts and verified tool chains, HydraScope writes them back into HydraDB, lifting tool accuracy to one hundred percent, collapsing five turns into one, and cutting prompt tokens by ninety-four percent.',
    srt: 'And HydraScope gets sharper after every run. As your agent resolves partner accounts and verified tool chains, HydraScope writes them back into HydraDB, lifting tool accuracy to 100%, collapsing 5 turns into 1, and cutting prompt tokens by 94.2%.'
  },
  {
    id: 'cta',
    leadIn: 0.32,
    tailOut: 1.25,
    spoken:
      'Attach HydraScope to Claude Code, Cursor, or any M C P agent in thirty seconds. Try the live playground today, open source under the M I T license.',
    srt: 'Attach HydraScope to Claude Code, Cursor, or any MCP agent in 30 seconds. Try the live playground today at hydrascope.krusch.dev (MIT Open Source).'
  }
];

function parseArgs(argv) {
  const defaultOut = path.join(os.homedir(), 'Downloads', 'hydrascope-product-launch.mp4');
  const opts = {
    outMp4: defaultOut,
    outSrt: defaultOut.replace(/\.mp4$/i, '.srt'),
    cacheDir: path.join(os.tmpdir(), 'hydrascope-launch-tts-cache'),
    keyframesDir: path.join(os.tmpdir(), 'hydrascope-launch-keyframes'),
    heroImgPath: path.join(ROOT_DIR, 'docs', 'hydrascope-ui.jpg'),
    voiceId: envOr('ELEVENLABS_VOICE_ID', DEFAULT_VOICE_ID, DEFAULT_VOICE_ID),
    modelId: envOr('ELEVENLABS_MODEL_ID', DEFAULT_MODEL_ID, DEFAULT_MODEL_ID),
    apiKey: envOr('ELEVENLABS_API_KEY', '', '')
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out' && argv[i + 1]) {
      opts.outMp4 = path.resolve(argv[++i]);
      opts.outSrt = opts.outMp4.replace(/\.mp4$/i, '.srt');
    } else if (arg === '--keyframes-dir' && argv[i + 1]) {
      opts.keyframesDir = path.resolve(argv[++i]);
    }
  }
  return opts;
}

async function ensureBeatVoiceWav(beat, idx, opts) {
  fs.mkdirSync(opts.cacheDir, { recursive: true });
  const hash = crypto
    .createHash('sha256')
    .update(`${opts.voiceId}::${opts.modelId}::${beat.spoken}`)
    .digest('hex')
    .slice(0, 12);
  const wav44Path = path.join(opts.cacheDir, `launch_${idx + 1}_${hash}_44k.wav`);

  if (fs.existsSync(wav44Path) && fs.statSync(wav44Path).size > 2048) {
    console.log(`[Launch TTS] Reusing cached WAV for ${beat.id}`);
    return wav44Path;
  }

  const rawMp3Path = path.join(opts.cacheDir, `raw_launch_${idx + 1}_${hash}.mp3`);
  const rawGemWav = path.join(opts.cacheDir, `raw_launch_${idx + 1}_${hash}_gem.wav`);
  let sourceAudio = null;

  if (opts.apiKey) {
    const ttsUrl = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(opts.voiceId)}`;
    console.log(`[Launch TTS] Synthesizing ${beat.id} via ElevenLabs (${beat.spoken.length} chars)...`);
    const res = await safeFetch(
      ttsUrl,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
          'xi-api-key': opts.apiKey
        },
        body: JSON.stringify({
          text: beat.spoken,
          model_id: opts.modelId,
          voice_settings: {
            stability: 0.48,
            similarity_boost: 0.80,
            style: 0.22,
            use_speaker_boost: true
          }
        })
      },
      {
        allowedProtocols: ['https:'],
        allowedHosts: ['api.elevenlabs.io'],
        allowPrivateLan: false,
        allowTailscale: false,
        maxRedirects: 0,
        timeoutMs: 25000,
        tool: 'hydrascope.launch_tts'
      }
    );

    if (res.ok && res.data.status >= 200 && res.data.status < 300) {
      const buf = Buffer.from(await res.data.response.arrayBuffer());
      if (buf.byteLength > 1024) {
        fs.writeFileSync(rawMp3Path, buf);
        sourceAudio = rawMp3Path;
      }
    }
  }

  if (!sourceAudio) {
    execFileSync(
      'gemini-api',
      ['tts', beat.spoken, '--voice', 'Charon', '--language', 'en-US', '--out', rawGemWav],
      { stdio: 'inherit' }
    );
    sourceAudio = rawGemWav;
  }

  execFileSync(
    'ffmpeg',
    [
      '-y',
      '-loglevel',
      'error',
      '-i',
      sourceAudio,
      '-af',
      'silenceremove=start_periods=1:start_silence=0.03:start_threshold=-48dB,areverse,silenceremove=start_periods=1:start_silence=0.06:start_threshold=-48dB,areverse',
      '-ar',
      String(SAMPLE_RATE),
      '-ac',
      '1',
      '-c:a',
      'pcm_s16le',
      wav44Path
    ],
    { stdio: 'inherit' }
  );

  return wav44Path;
}

function readMonoFloatSamples(wavPath) {
  const bytes = new Uint8Array(fs.readFileSync(wavPath));
  const parsed = parseWavHeader(bytes, { tool: 'hydrascope.launch_wav' });
  if (!parsed.ok) throw new Error(`Invalid WAV ${wavPath}`);
  const { dataOffset, dataBytes } = parsed.data;
  const sampleCount = Math.floor(dataBytes / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset + dataOffset, sampleCount * 2);
  const out = new Float32Array(sampleCount);
  let peak = 0;
  for (let i = 0; i < sampleCount; i += 1) {
    const v = view.getInt16(i * 2, true) / 32768;
    out[i] = v;
    const av = Math.abs(v);
    if (av > peak) peak = av;
  }
  if (peak > 0.01) {
    const scale = 0.89 / peak;
    for (let i = 0; i < sampleCount; i += 1) {
      out[i] = Math.max(-0.98, Math.min(0.98, out[i] * scale));
    }
  }
  return out;
}

function buildLaunchAudioAndTimeline(beatsWithSamples, masterWavPath, srtPath) {
  let cursorFrames = 0;
  const timeline = [];

  for (let i = 0; i < beatsWithSamples.length; i += 1) {
    const b = beatsWithSamples[i];
    const speechSeconds = b.samples.length / SAMPLE_RATE;
    const sceneFrames = Math.ceil((b.leadIn + speechSeconds + b.tailOut) * FPS);
    const startFrame = cursorFrames;
    const endFrame = startFrame + sceneFrames;
    const startSec = startFrame / FPS;
    const speechStartSec = startSec + b.leadIn;
    const speechEndSec = speechStartSec + speechSeconds;

    timeline.push({
      ...b,
      index: i,
      startFrame,
      endFrame,
      sceneFrames,
      startSec,
      endSec: endFrame / FPS,
      speechStartSec,
      speechEndSec
    });
    cursorFrames = endFrame;
  }

  const totalFrames = cursorFrames;
  const totalSeconds = totalFrames / FPS;
  const totalSamples = Math.ceil(totalSeconds * SAMPLE_RATE);

  const voiceTrack = new Float32Array(totalSamples);
  for (const item of timeline) {
    const offset = Math.round(item.speechStartSec * SAMPLE_RATE);
    const maxCopy = Math.min(item.samples.length, totalSamples - offset);
    for (let j = 0; j < maxCopy; j += 1) {
      voiceTrack[offset + j] += item.samples[j];
    }
  }

  const voiceEnv = new Float32Array(totalSamples);
  let env = 0;
  const attack = 1 - Math.exp(-1 / (SAMPLE_RATE * 0.012));
  const release = 1 - Math.exp(-1 / (SAMPLE_RATE * 0.18));
  for (let i = 0; i < totalSamples; i += 1) {
    const absV = Math.abs(voiceTrack[i]);
    env += (absV - env) * (absV > env ? attack : release);
    voiceEnv[i] = env;
  }

  // Energetic warm synth chord progression + tactile beat transition chimes
  const masterStereo = new Float32Array(totalSamples * 2);
  let lpL = 0;
  let lpR = 0;
  const lpAlpha = 0.095;
  const transitionTimes = timeline.map((t) => t.startSec);
  const voices = [
    { freq: 82.407, amp: 0.28, pan: 0.0, lfo: 0.09 },  // E2
    { freq: 123.471, amp: 0.21, pan: -0.35, lfo: 0.11 }, // B2
    { freq: 164.814, amp: 0.18, pan: 0.35, lfo: 0.08 },  // E3
    { freq: 246.942, amp: 0.12, pan: -0.25, lfo: 0.07 }, // B3
    { freq: 311.127, amp: 0.08, pan: 0.28, lfo: 0.06 }   // D#4 maj7 shimmer
  ];

  for (let i = 0; i < totalSamples; i += 1) {
    const t = i / SAMPLE_RATE;
    let rawL = 0;
    let rawR = 0;
    for (const pv of voices) {
      const mod = 1 + 0.18 * Math.sin(2 * Math.PI * pv.lfo * t);
      const sig = (Math.sin(2 * Math.PI * pv.freq * t) + 0.15 * Math.sin(4 * Math.PI * pv.freq * t)) * pv.amp * mod;
      rawL += sig * Math.sqrt(0.5 * (1 - pv.pan));
      rawR += sig * Math.sqrt(0.5 * (1 + pv.pan));
    }
    lpL += lpAlpha * (rawL - lpL);
    lpR += lpAlpha * (rawR - lpR);

    let chimeL = 0;
    let chimeR = 0;
    for (let c = 0; c < transitionTimes.length; c += 1) {
      const dt = t - transitionTimes[c];
      if (dt >= 0 && dt < 1.0) {
        const cEnv = Math.sin(Math.min(1, dt / 0.02) * (Math.PI / 2)) * Math.exp(-dt * 4.2);
        const fBase = c === 1 ? 587.33 : c === 3 ? 659.25 : 493.88;
        chimeL += Math.sin(2 * Math.PI * fBase * dt) * 0.045 * cEnv;
        chimeR += Math.sin(2 * Math.PI * (fBase * 1.5) * dt) * 0.038 * cEnv;
      }
    }

    const fadeIn = Math.min(1, t / 0.6);
    const fadeOut = Math.min(1, (totalSeconds - t) / 1.4);
    const masterFade = Math.max(0, fadeIn * fadeOut);
    const duck = 1 - Math.min(0.58, voiceEnv[i] * 2.4);
    const ambGain = 0.11 * duck * masterFade;
    const vSample = voiceTrack[i] * 0.93;

    masterStereo[i * 2] = Math.max(-0.99, Math.min(0.99, vSample + lpL * ambGain + chimeL * masterFade));
    masterStereo[i * 2 + 1] = Math.max(-0.99, Math.min(0.99, vSample + lpR * ambGain + chimeR * masterFade));
  }

  fs.writeFileSync(masterWavPath, encodeWavPcm16(masterStereo, { sampleRate: SAMPLE_RATE, channels: 2 }));

  const formatSrtTime = (sec) => {
    const msTotal = Math.max(0, Math.round(sec * 1000));
    const hrs = Math.floor(msTotal / 3_600_000);
    const mins = Math.floor((msTotal % 3_600_000) / 60_000);
    const secs = Math.floor((msTotal % 60_000) / 1000);
    const ms = msTotal % 1000;
    return (
      `${String(hrs).padStart(2, '0')}:` +
      `${String(mins).padStart(2, '0')}:` +
      `${String(secs).padStart(2, '0')},` +
      `${String(ms).padStart(3, '0')}`
    );
  };

  const srtBlocks = timeline.map(
    (item, idx) =>
      `${idx + 1}\n${formatSrtTime(item.speechStartSec)} --> ${formatSrtTime(item.speechEndSec + 0.18)}\n${item.srt}\n`
  );
  fs.writeFileSync(srtPath, srtBlocks.join('\n'), 'utf8');

  return { timeline, totalFrames, totalSeconds };
}

function buildLaunchStageHtml(timeline, totalFrames, heroDataUri) {
  const metaJson = JSON.stringify({
    fps: FPS,
    totalFrames,
    beats: timeline.map((b) => ({
      id: b.id,
      index: b.index,
      startFrame: b.startFrame,
      endFrame: b.endFrame,
      sceneFrames: b.sceneFrames
    }))
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    width: 1920px;
    height: 1080px;
    overflow: hidden;
    background: #09090b;
    color: #fafafa;
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .stage {
    position: relative;
    width: 1920px;
    height: 1080px;
    padding: 56px 88px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    background:
      radial-gradient(950px 500px at 50% -8%, rgba(16, 185, 129, 0.11), transparent 70%),
      #09090b;
  }
  .topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .brand {
    display: inline-flex;
    align-items: center;
    gap: 14px;
  }
  .brand-icon {
    width: 42px;
    height: 42px;
    border-radius: 10px;
    background: #141418;
    border: 1px solid rgba(255,255,255,0.16);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .brand-title {
    font-size: 22px;
    font-weight: 700;
    letter-spacing: -0.02em;
  }
  .pill {
    font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 14px;
    padding: 8px 16px;
    border-radius: 999px;
    background: #111114;
    border: 1px solid rgba(255,255,255,0.12);
    color: #a1a1aa;
  }
  .pill-green {
    background: rgba(16, 185, 129, 0.12);
    border-color: rgba(16, 185, 129, 0.34);
    color: #34d399;
  }
  .beat {
    display: none;
    flex: 1;
    flex-direction: column;
    justify-content: center;
    gap: 36px;
  }
  .beat.is-active {
    display: flex;
  }
  .eyebrow {
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 15px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #34d399;
  }
  .eyebrow-red {
    color: #f87171;
  }
  .hero-h1 {
    font-size: 68px;
    font-weight: 800;
    line-height: 1.06;
    letter-spacing: -0.035em;
    max-width: 1520px;
  }
  .muted { color: #a1a1aa; }
  .green { color: #34d399; }
  .red { color: #f87171; }

  .hook-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 28px;
    margin-top: 8px;
  }
  .card {
    background: #111114;
    border: 1px solid rgba(255,255,255,0.10);
    border-radius: 18px;
    padding: 32px 36px;
  }
  .card-red {
    border-color: rgba(239, 68, 68, 0.35);
    background: linear-gradient(180deg, rgba(239,68,68,0.08), #111114);
  }
  .card-green {
    border-color: rgba(16, 185, 129, 0.35);
    background: linear-gradient(180deg, rgba(16,185,129,0.08), #111114);
  }
  .big-num {
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 56px;
    font-weight: 800;
    letter-spacing: -0.03em;
  }
  .card-title {
    margin-top: 10px;
    font-size: 24px;
    font-weight: 700;
  }
  .card-desc {
    margin-top: 8px;
    font-size: 18px;
    line-height: 1.5;
    color: #a1a1aa;
  }

  /* Beat 2 Reveal */
  .reveal-split {
    display: grid;
    grid-template-columns: 0.85fr 1.15fr;
    gap: 36px;
    align-items: center;
  }
  .ui-frame {
    border-radius: 18px;
    overflow: hidden;
    border: 1px solid rgba(255,255,255,0.16);
    box-shadow: 0 30px 90px rgba(0,0,0,0.8);
    background: #111114;
  }
  .ui-frame img {
    display: block;
    width: 100%;
    height: auto;
  }

  /* Beat 3 Proof 3-Col */
  .proof-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 26px;
  }

  /* Beat 4 Continual */
  .cont-split {
    display: grid;
    grid-template-columns: 0.78fr 1.22fr;
    gap: 32px;
    align-items: stretch;
  }
  .kpi-stack {
    display: flex;
    flex-direction: column;
    gap: 18px;
    justify-content: space-between;
  }

  /* Beat 5 CTA */
  .cta-box {
    background: #111114;
    border: 1px solid rgba(16, 185, 129, 0.38);
    border-radius: 22px;
    padding: 46px 52px;
    display: grid;
    grid-template-columns: 1.1fr 0.9fr;
    gap: 36px;
    align-items: center;
  }
  .term {
    background: #09090b;
    border: 1px solid rgba(255,255,255,0.12);
    border-radius: 14px;
    padding: 26px 30px;
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 18px;
    line-height: 1.75;
    color: #e4e4e7;
  }

  .footer-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    color: #71717a;
    font-size: 15px;
  }
  .progress-track {
    width: 340px;
    height: 5px;
    background: #18181b;
    border-radius: 999px;
    overflow: hidden;
  }
  .progress-fill {
    height: 100%;
    background: #10b981;
    width: 0%;
  }
</style>
</head>
<body>
  <div class="stage">
    <div class="topbar">
      <div class="brand">
        <div class="brand-icon">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
            <circle cx="5" cy="12" r="2.5" fill="#fafafa" />
            <circle cx="14" cy="6" r="2.3" fill="#a1a1aa" />
            <circle cx="14" cy="18" r="2.3" fill="#10b981" />
            <circle cx="20" cy="12" r="2.5" fill="#10b981" />
            <path d="M7.3 10.8L11.8 7.2M7.3 13.2L11.8 16.8M15.8 7.5L18.2 10.4M15.8 16.5L18.2 13.6" stroke="#a1a1aa" stroke-width="1.7" stroke-linecap="round"/>
          </svg>
        </div>
        <span class="brand-title">HydraScope</span>
      </div>
      <span class="pill pill-green" id="top-pill">Powered by Open-Source HydraDB v0.4.0</span>
    </div>

    <!-- BEAT 1: HOOK -->
    <div class="beat" id="beat-hook">
      <div>
        <div class="eyebrow eyebrow-red">THE AGENT CONTEXT TAX</div>
        <h1 class="hero-h1" style="margin-top:14px;">
          Stop stuffing <span class="red" id="tok-counter">12,412</span> tokens of tools into every prompt.
        </h1>
      </div>
      <div class="hook-grid">
        <div class="card card-red" id="hook-card-1">
          <div class="big-num red">12,412 tok</div>
          <div class="card-title">Full 64-Tool Window Preload</div>
          <div class="card-desc">Burns context budget before Turn 1 and exposes deprecated v1 tools to the model.</div>
        </div>
        <div class="card card-red" id="hook-card-2">
          <div class="big-num red">25.0% F1</div>
          <div class="card-title">Flat Cosine Vector Search</div>
          <div class="card-desc">Misses zero-overlap safety checks 2 hops away and ranks retired SHA-1 ADRs at #1.</div>
        </div>
      </div>
    </div>

    <!-- BEAT 2: REVEAL -->
    <div class="beat" id="beat-reveal">
      <div class="reveal-split">
        <div style="display:flex;flex-direction:column;gap:22px;">
          <div class="eyebrow">INTRODUCING HYDRASCOPE</div>
          <h1 class="hero-h1" style="font-size:58px;">
            Traverse structure.<br/><span class="green">Stop burning tokens.</span>
          </h1>
          <p class="card-desc" style="font-size:21px;color:#d4d4d8;">
            Compiles agent skills, 64 MCP tools, AST call graphs, and temporal ADRs into self-hosted <strong>HydraDB v0.4.0</strong>, serving exact 520-to-841 token slices in milliseconds.
          </p>
          <div style="display:flex;gap:12px;flex-wrap:wrap;">
            <span class="pill pill-green">OpenCypher :8443</span>
            <span class="pill">MCP + CLI + Web UI</span>
            <span class="pill">416 ops/sec (P50 11ms)</span>
          </div>
        </div>
        <div class="ui-frame" id="reveal-ui">
          <img src="${heroDataUri}" alt="HydraScope UI" />
        </div>
      </div>
    </div>

    <!-- BEAT 3: PROOF -->
    <div class="beat" id="beat-proof">
      <div>
        <div class="eyebrow">EARNING ITS PLACE OVER VECTOR SEARCH</div>
        <h1 class="hero-h1" style="font-size:56px;margin-top:12px;">
          Three structural blind spots. <span class="green">Solved deterministically.</span>
        </h1>
      </div>
      <div class="proof-grid">
        <div class="card card-green" id="proof-1">
          <div class="big-num green">100%</div>
          <div class="card-title">2-Hop Blast Radius</div>
          <div class="card-desc">Walks fee-engine -&gt; settlement-batch -&gt; sox-reconciler even with 0% shared prompt words.</div>
        </div>
        <div class="card card-green" id="proof-2">
          <div class="big-num green">0.0%</div>
          <div class="card-title">Retired Rule Poisoning</div>
          <div class="card-desc">Filters superseded SHA-1 ADRs via :SUPERSEDES while preserving exact ISO asOf time-travel.</div>
        </div>
        <div class="card card-green" id="proof-3">
          <div class="big-num green">0 tok</div>
          <div class="card-title">Hallucination Trap Gate</div>
          <div class="card-desc">Grounds domain nouns against the HydraDB ontology pre-flight and blocks fake Kafka/K8s prompts.</div>
        </div>
      </div>
    </div>

    <!-- BEAT 4: CONTINUAL LEARNING -->
    <div class="beat" id="beat-continual">
      <div>
        <div class="eyebrow">SELF-SHARPENING AGENT MEMORY</div>
        <h1 class="hero-h1" style="font-size:54px;margin-top:10px;">
          Gets smarter and faster <span class="green">every time your agent runs.</span>
        </h1>
      </div>
      <div class="cont-split">
        <div class="kpi-stack">
          <div class="card card-green" style="padding:24px 28px;">
            <div class="big-num green" style="font-size:44px;">85.7% -&gt; 100%</div>
            <div class="card-desc">Tool Selection F1 across 4 runs (vs. 25.0% Vector)</div>
          </div>
          <div class="card card-green" style="padding:24px 28px;">
            <div class="big-num green" style="font-size:44px;">5.0 -&gt; 1.0 turns</div>
            <div class="card-desc">Persists :RESOLVED_TO entity IDs in HydraDB</div>
          </div>
          <div class="card card-green" style="padding:24px 28px;">
            <div class="big-num green" style="font-size:44px;">-94.2% tokens</div>
            <div class="card-desc">721 tokens vs. 12,412-token full MCP preload</div>
          </div>
        </div>
        <div class="card" style="display:flex;flex-direction:column;justify-content:space-between;">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <span style="font-size:18px;font-weight:600;">64-Tool Continual Convergence on HydraDB</span>
            <span class="pill pill-green">1-Hop MERGE Writeback</span>
          </div>
          <svg viewBox="0 0 820 340" style="width:100%;height:auto;margin-top:14px;">
            <line x1="64" y1="44" x2="780" y2="44" stroke="rgba(255,255,255,0.08)" />
            <line x1="64" y1="164" x2="780" y2="164" stroke="rgba(255,255,255,0.08)" />
            <line x1="64" y1="284" x2="780" y2="284" stroke="rgba(255,255,255,0.08)" />
            <text x="50" y="49" text-anchor="end" fill="#71717a" font-size="13">100%</text>
            <text x="50" y="169" text-anchor="end" fill="#71717a" font-size="13">50%</text>
            <text x="50" y="289" text-anchor="end" fill="#71717a" font-size="13">0%</text>

            <!-- Static Vector Baseline 25% (y=224) -->
            <line x1="64" y1="224" x2="780" y2="224" stroke="#ef4444" stroke-width="2.2" stroke-dasharray="7 5" />
            <text x="774" y="213" text-anchor="end" fill="#f87171" font-size="14" font-weight="600">Static Vector Tool-RAG (25.0%)</text>

            <!-- Animated HydraScope Polyline -->
            <polyline id="cont-line" fill="none" stroke="#10b981" stroke-width="4.5" stroke-linecap="round" points="140,78 340,60 540,52 740,44" />
            <circle cx="140" cy="78" r="7" fill="#10b981" />
            <circle cx="340" cy="60" r="7" fill="#10b981" />
            <circle cx="540" cy="52" r="7" fill="#10b981" />
            <circle cx="740" cy="44" r="8" fill="#34d399" />

            <text x="140" y="60" text-anchor="middle" fill="#34d399" font-size="15" font-weight="700">85.7%</text>
            <text x="340" y="42" text-anchor="middle" fill="#34d399" font-size="15" font-weight="700">93.3%</text>
            <text x="540" y="34" text-anchor="middle" fill="#34d399" font-size="15" font-weight="700">96.8%</text>
            <text x="740" y="26" text-anchor="middle" fill="#34d399" font-size="16" font-weight="800">100.0%</text>

            <text x="140" y="318" text-anchor="middle" fill="#d4d4d8" font-size="14">Run 1 (2.5t)</text>
            <text x="340" y="318" text-anchor="middle" fill="#d4d4d8" font-size="14">Run 2 (1.8t)</text>
            <text x="540" y="318" text-anchor="middle" fill="#d4d4d8" font-size="14">Run 3 (1.4t)</text>
            <text x="740" y="318" text-anchor="middle" fill="#34d399" font-size="14" font-weight="700">Run 4 (1.0t)</text>
          </svg>
        </div>
      </div>
    </div>

    <!-- BEAT 5: CTA -->
    <div class="beat" id="beat-cta">
      <div class="cta-box">
        <div style="display:flex;flex-direction:column;gap:20px;">
          <div class="eyebrow">OPEN SOURCE · MIT LICENSE</div>
          <h1 class="hero-h1" style="font-size:60px;">
            Ready for Claude Code,<br/>Cursor, &amp; MCP today.
          </h1>
          <div style="display:flex;flex-direction:column;gap:8px;margin-top:6px;">
            <div style="font-size:28px;font-weight:700;color:#34d399;">hydrascope.krusch.dev</div>
            <div style="font-family:'JetBrains Mono',monospace;font-size:20px;color:#a1a1aa;">github.com/kruschdev/HydraScope</div>
          </div>
        </div>
        <div class="term">
          <div style="color:#71717a;"># Start self-hosted HydraDB v0.4.0</div>
          <div><span class="green">$</span> docker compose --profile hydradb up -d</div>
          <div style="margin-top:14px;color:#71717a;"># Audit any repo in 30 seconds</div>
          <div><span class="green">$</span> npx hydrascope bench</div>
          <div style="margin-top:14px;color:#71717a;"># Attach 6-tool stdio MCP server</div>
          <div><span class="green">$</span> npx hydrascope-mcp</div>
        </div>
      </div>
    </div>

    <div class="footer-bar">
      <span>HydraScope · Live Agent Context Layer on HydraDB</span>
      <div class="progress-track"><div class="progress-fill" id="prog-fill"></div></div>
      <span>hydrascope.krusch.dev</span>
    </div>
  </div>

  <script>
    const META = ${metaJson};
    function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
    function easeOut(t) { const x = clamp(t, 0, 1); return 1 - Math.pow(1 - x, 3); }

    window.renderFrame = function(f) {
      const pct = ((f + 1) / META.totalFrames) * 100;
      document.getElementById('prog-fill').style.width = pct.toFixed(2) + '%';

      const beat = META.beats.find(b => f >= b.startFrame && f < b.endFrame) || META.beats[META.beats.length - 1];
      const localP = (f - beat.startFrame) / Math.max(1, beat.sceneFrames);

      for (const b of META.beats) {
        const el = document.getElementById('beat-' + b.id);
        if (el) el.classList.toggle('is-active', b.id === beat.id);
      }

      if (beat.id === 'hook') {
        const countVal = Math.round(12412 * easeOut(localP * 3.2));
        document.getElementById('tok-counter').textContent = countVal.toLocaleString();
        const c1 = easeOut((localP - 0.08) * 3.5);
        const c2 = easeOut((localP - 0.24) * 3.5);
        document.getElementById('hook-card-1').style.opacity = String(c1);
        document.getElementById('hook-card-1').style.transform = 'translateY(' + ((1 - c1) * 24).toFixed(1) + 'px)';
        document.getElementById('hook-card-2').style.opacity = String(c2);
        document.getElementById('hook-card-2').style.transform = 'translateY(' + ((1 - c2) * 24).toFixed(1) + 'px)';
      }

      if (beat.id === 'reveal') {
        const u = easeOut(localP * 2.4);
        const ui = document.getElementById('reveal-ui');
        ui.style.opacity = String(u);
        ui.style.transform = 'scale(' + (0.94 + 0.06 * u).toFixed(4) + ')';
      }

      if (beat.id === 'proof') {
        ['proof-1', 'proof-2', 'proof-3'].forEach((id, idx) => {
          const p = easeOut((localP - idx * 0.14) * 3.2);
          const el = document.getElementById(id);
          el.style.opacity = String(p);
          el.style.transform = 'translateY(' + ((1 - p) * 26).toFixed(1) + 'px)';
        });
      }

      if (beat.id === 'continual') {
        const draw = easeOut(localP * 1.9);
        const line = document.getElementById('cont-line');
        line.style.strokeDasharray = '700';
        line.style.strokeDashoffset = String((700 * (1 - draw)).toFixed(1));
      }
    };
  </script>
</body>
</html>`;
}

async function main() {
  const opts = parseArgs(process.argv);
  fs.mkdirSync(path.dirname(opts.outMp4), { recursive: true });
  fs.mkdirSync(opts.keyframesDir, { recursive: true });

  const beatsWithSamples = [];
  for (let i = 0; i < BEATS.length; i += 1) {
    const wavPath = await ensureBeatVoiceWav(BEATS[i], i, opts);
    const samples = readMonoFloatSamples(wavPath);
    beatsWithSamples.push({ ...BEATS[i], wavPath, samples });
  }

  const masterWavPath = path.join(opts.cacheDir, 'hydrascope_launch_master_44k.wav');
  const { timeline, totalFrames, totalSeconds } = buildLaunchAudioAndTimeline(
    beatsWithSamples,
    masterWavPath,
    opts.outSrt
  );
  console.log(
    `[Launch Audio] Master timeline locked: ${timeline.length} beats, ${totalFrames} frames (${totalSeconds.toFixed(2)}s)`
  );

  const heroBase64 = fs.readFileSync(opts.heroImgPath).toString('base64');
  const heroDataUri = `data:image/jpeg;base64,${heroBase64}`;
  const htmlPath = path.join(opts.cacheDir, 'launch_stage.html');
  fs.writeFileSync(htmlPath, buildLaunchStageHtml(timeline, totalFrames, heroDataUri), 'utf8');

  const browser = await launchBrowser();
  const page = await browser.newPage();
  await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 });
  await page.goto(`file://${htmlPath}`, { waitUntil: 'load' });

  const ffArgs = [
    '-y',
    '-loglevel',
    'error',
    '-f',
    'image2pipe',
    '-vcodec',
    'mjpeg',
    '-framerate',
    String(FPS),
    '-i',
    '-',
    '-i',
    masterWavPath,
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    '19',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-shortest',
    '-movflags',
    '+faststart',
    opts.outMp4
  ];
  const ffmpeg = spawn('ffmpeg', ffArgs, { stdio: ['pipe', 'inherit', 'inherit'] });

  try {
    for (let f = 0; f < totalFrames; f += 1) {
      await page.evaluate((frameIdx) => window.renderFrame(frameIdx), f);
      const jpegBuf = await page.screenshot({ type: 'jpeg', quality: 93 });

      const activeBeat = timeline.find((b) => f >= b.startFrame && f < b.endFrame);
      if (activeBeat && f === activeBeat.startFrame + Math.floor(activeBeat.sceneFrames * 0.65)) {
        fs.writeFileSync(
          path.join(opts.keyframesDir, `0${activeBeat.index + 1}_${activeBeat.id}.jpg`),
          jpegBuf
        );
      }

      if (!ffmpeg.stdin.write(jpegBuf)) {
        await once(ffmpeg.stdin, 'drain');
      }
      if (f > 0 && f % 450 === 0) {
        console.log(`[Launch Render] Frame ${f} / ${totalFrames} (${Math.round((f / totalFrames) * 100)}%)`);
      }
    }

    ffmpeg.stdin.end();
    const [exitCode] = await once(ffmpeg, 'close');
    if (exitCode !== 0) throw new Error(`FFmpeg exited with code ${exitCode}`);
  } finally {
    await browser.close();
  }

  const stat = fs.statSync(opts.outMp4);
  console.log(
    `[Launch Done] Wrote ${opts.outMp4} (${(stat.size / (1024 * 1024)).toFixed(2)} MiB, ${totalSeconds.toFixed(2)}s) + ${opts.outSrt}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
