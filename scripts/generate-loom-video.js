#!/usr/bin/env node
/**
 * Hackathon Product + Technical Challenges & Architectural Decisions Walkthrough Generator
 * for HydraScope (~3m45s, 1920x1080 @ 24fps, ElevenLabs `eleven_turbo_v2_5` voiceover).
 *
 * Combines live cursor-driven interaction on the simplified HydraScope React app
 * (`http://127.0.0.1:4190`) with crisp Engineering Deep-Dive overlays explaining the
 * architectural decisions and the 5 real HydraDB v0.4.0 technical challenges solved.
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

const FPS = 24;
const WIDTH = 1920;
const HEIGHT = 1080;
const SAMPLE_RATE = 44_100;

const DEFAULT_VOICE_ID = 'CwhRBWXzGAHq8TQ4Fs17'; // Roger (premade conversational)
const DEFAULT_MODEL_ID = 'eleven_turbo_v2_5'; // 0.5 credit/char

/**
 * Note: Scenes s1_blast_radius, s2_supersedes, s3_trap_gate, and s4_benchmarks preserve
 * the exact spoken strings already cached on disk so 0 duplicate ElevenLabs credits are spent.
 */
const SCENES = [
  {
    id: 's1_blast_radius',
    cacheSlot: 1,
    leadIn: 0.45,
    tailOut: 0.70,
    spoken:
      'Most coding agents either dump dozens of M C P tool schemas into every prompt, or rely on vector search that misses connected code dependencies. I built HydraScope on self-hosted HydraDB zero point four so agents traverse real dependency graphs instead of burning tokens. On a partner fee rounding change, vector search misses the downstream SOX reconciler completely, while HydraDB walks two hops to catch every affected file in eight hundred forty-one tokens.',
    srt: 'Most coding agents either dump dozens of MCP tool schemas into every prompt or rely on vector search that misses connected code dependencies. I built HydraScope on self-hosted HydraDB v0.4.0 so agents traverse real dependency graphs instead of burning tokens. On a partner fee rounding change, vector search misses the downstream SOX reconciler completely, while HydraDB walks two hops to catch every affected file in 841 tokens.',
    caption: '01 · Product Demo: 2-hop HydraDB traversal catches downstream SOX dependencies missed by vector search'
  },
  {
    id: 's2_supersedes',
    cacheSlot: 2,
    leadIn: 0.38,
    tailOut: 0.68,
    spoken:
      'Vector search also suffers from outdated rule poisoning. When I ask how to verify Stripe webhooks, embeddings pull a retired SHA-one A D R at rank one because it repeats the prompt keywords. HydraScope follows the supersedes edge in HydraDB, blocks the retired rule automatically, and serves only the active H-MAC policy, with one-click time-travel for historical audits.',
    srt: 'Vector search also suffers from outdated rule poisoning. When I ask how to verify Stripe webhooks, embeddings pull a retired SHA-1 ADR at rank #1 because it repeats the prompt keywords. HydraScope follows the :SUPERSEDES edge in HydraDB, blocks the retired rule automatically, and serves only the active HMAC policy, with one-click time-travel for historical audits.',
    caption: '02 · Temporal Lineage: :SUPERSEDES blocks retired SHA-1 ADRs automatically + 1-click historical replay'
  },
  {
    id: 's3_trap_gate',
    cacheSlot: 3,
    leadIn: 0.36,
    tailOut: 0.68,
    spoken:
      'When asked about a subsystem that does not exist, like Kafka, vector search still returns false matches that invite hallucinations. HydraScope checks the graph ontology first and stops pre-flight at zero tokens, with the live OpenCypher query tucked cleanly in the technical drawer.',
    srt: 'When asked about a subsystem that does not exist, like Kafka, vector search still returns false matches that invite hallucinations. HydraScope checks the graph ontology first and stops pre-flight at 0 tokens, with the live OpenCypher query tucked cleanly in the technical drawer.',
    caption: '03 · Zero-Token Ontology Gate: Halts non-existent subsystem traps (Kafka) before calling the LLM'
  },
  {
    id: 's4_arch_unified_graph',
    cacheSlot: 6,
    leadIn: 0.40,
    tailOut: 0.72,
    spoken:
      'A core architectural decision behind HydraScope was unifying skills, sixty-four M C P tool schemas, A S T code symbols, and resolved entity aliases under a single GraphNode vertex model in HydraDB. In embedding space, mandatory post-check tools like cent conservation score below zero point two cosine similarity to an invoice refund prompt. By linking skills, post-check tools, and newly learned entity I Ds via directed impacts edges, one two-hop OpenCypher query retrieves the exact active tools and resolved partner accounts in a single pass, pruning lookup tools on repeat runs.',
    srt: 'A core architectural decision behind HydraScope was unifying skills, 64 MCP tool schemas, AST code symbols, and resolved entity aliases under a single GraphNode vertex model in HydraDB. Mandatory post-check tools score <0.20 cosine similarity to an invoice refund prompt. Linking skills, post-check tools, and resolved entity IDs via :IMPACTS*1..2 lets one OpenCypher query fetch active tools and account IDs in a single pass.',
    caption: '04 · Architecture Decision: Unified GraphNode + :IMPACTS*1..2 schema for single-query tool & entity retrieval',
    slide: {
      eyebrow: 'ARCHITECTURAL DECISION 01 · UNIFIED GRAPH SCHEMA',
      title: 'Why One Unified GraphNode Model Beats Separate Tool & Memory Stores',
      leftTitle: 'The Retrieval & Round-Trip Problem',
      leftPoints: [
        'Preloading 8 MCP servers (64 tool schemas) burns 12,412 tokens before Turn 1.',
        'Mandatory post-checks (ledger_verify_cent_conservation, audit_append_signed_receipt) score < 0.20 cosine to "partner invoice refund" (0% vector recall).',
        'Flat vector stores forget resolved entities ("Acme Logistics" -> acct_partner_99281), repeating lookup tool calls on every run.'
      ],
      rightTitle: 'src/engines/agent-context-layer.js (Single-Query 2-Hop Traversal)',
      code: `// Skills, active v2 MCP tools, AST files, ADRs, and resolved entities
// share one GraphNode label so 1 OpenCypher query fetches everything:
MATCH (s:GraphNode {id: $skillSeedId})-[:IMPACTS*1..2]->(d:GraphNode)
WHERE d.id <> $skillSeedId
RETURN d.logicalId AS id, d.kind AS kind, d.isCurrent AS isCurrent

// Post-run continual writeback (1-hop MERGE):
// Links resolved_entity directly to skill -> drops lookup tools next run!
MERGE (s:GraphNode {id: $skillId})-[:IMPACTS]->(e:GraphNode {id: $entityId})`
    }
  },
  {
    id: 's5_benchmarks',
    cacheSlot: 4,
    leadIn: 0.38,
    tailOut: 0.72,
    spoken:
      'In Benchmarks, HydraScope passes one hundred percent of codebase tasks with zero outdated rules, compared to twelve point five percent for vector search. Across sixty-four M C P tools, HydraScope writes resolved entity I Ds and verified tool chains back into HydraDB after each run, lifting tool accuracy from eighty-five point seven percent to one hundred percent, cutting agent turns from five down to one, and shrinking prompt tokens by ninety-four percent at over four hundred OpenCypher operations per second.',
    srt: 'In Benchmarks, HydraScope passes 100% of codebase tasks with 0% outdated rules (vs. 12.5% for vector search). Across 64 MCP tools, HydraScope writes resolved entity IDs and verified tool chains back into HydraDB after each run, lifting tool F1 from 85.7% to 100%, cutting agent turns from 5.0 down to 1.0, and shrinking prompt tokens by 94.2% at 400+ OpenCypher ops/sec.',
    caption: '05 · Measured Benchmarks: 8/8 tasks · 64-tool F1 85.7% -> 100% · 5.0 -> 1.0 turns · 400+ OpenCypher ops/s'
  },
  {
    id: 's6_challenges_cypher_ids',
    cacheSlot: 7,
    leadIn: 0.42,
    tailOut: 0.75,
    spoken:
      'Building directly against self-hosted HydraDB zero point four surfaced real engine constraints that shaped my connector. First, during my initial sixty-four-worker stress test, standalone node upserts returned H T T P four hundred because HydraDBs query-engine merge requires one-hop directed edge patterns, and mutation projections only allow return count. I solved this by anchoring every vertex upsert to an idempotent WorkspaceRoot via a one-hop contains edge and using detach delete return count for clean Epoch-one resets, bringing concurrent load tests to sixty-four out of sixty-four succeeded. Second, because J S O N loses integer precision above two to the fifty-three, I built deterministic forty-eight-bit S H A two-fifty-six surrogate vertex I Ds so string logical I Ds round-trip losslessly between JavaScript and Rust.',
    srt: 'Integrating self-hosted HydraDB v0.4.0 surfaced real engine constraints. (1) Standalone node MERGE returned HTTP 400 ("only one-hop edge patterns are executable in Query engine MERGE") and mutations restrict projections to RETURN count(n). Anchoring upserts to WorkspaceRoot via 1-hop :CONTAINS brought load tests to 64/64 (100%). (2) 48-bit SHA-256 surrogate IDs prevent IEEE-754 JSON integer precision loss.',
    caption: '06 · Technical Challenges #1 & #2: 1-Hop MERGE dialect alignment + 48-bit SHA-256 safe integer vertex IDs',
    slide: {
      eyebrow: 'TECHNICAL CHALLENGES 01 & 02 · HYDRADB v0.4.0 ENGINE CONSTRAINTS',
      title: '1-Hop MERGE Planner Alignment & Lossless 48-Bit Surrogate Vertex IDs',
      leftTitle: 'What Broke Under Live 64-Worker Load',
      leftPoints: [
        'Challenge 1: Standalone MERGE (n:GraphNode) returned HTTP 400 ("only one-hop edge patterns are executable in Query engine MERGE"), and mutations only project RETURN count(e).',
        'Fix 1: Anchored all vertex writes to (root:WorkspaceRoot)-[:CONTAINS]->(n:GraphNode) -> jumped to 64/64 (100%) at 416 ops/sec (P50 11.2ms).',
        'Challenge 2: HydraDB requires integer vertex IDs, while 63-bit hashes overflow IEEE-754 Number.MAX_SAFE_INTEGER over HTTP JSON.'
      ],
      rightTitle: 'src/connectors/hydradb-client.js (Production Fix)',
      code: `// Collision-free 48-bit integer in [1000, 281474976711655] <= 2^53 - 1
export function surrogateVertexId(namespace, logicalId) {
  const digest = crypto.createHash('sha256')
    .update(\`\${namespace}\\0\${logicalId}\`, 'utf8').digest();
  return digest.readUIntBE(0, 6) + 1000;
}

// 1-hop directed MERGE + count() projection valid on hydradb:0.4.0:
MERGE (root:WorkspaceRoot {id: 1000, namespace: $ns})
  -[:CONTAINS]->(n:GraphNode {id: $id, logicalId: $lid, isCurrent: $cur})
RETURN count(n) AS written`
    }
  },
  {
    id: 's7_challenges_docker_sec',
    cacheSlot: 8,
    leadIn: 0.40,
    tailOut: 0.75,
    spoken:
      'Three more engineering challenges hardened the stack for production. HydraDB rejects null write parameters and wraps returned cells in typed envelopes alongside monotonic read-epoch bookmarks, so I wrote a recursive null stripper and cell decoder. In Docker Compose, minting a bootstrap token on a fresh volume left a root-owned directory that crashed HydraDB startup with permission denied on the shared disk cache, which I solved with a health-gated hydradb-init container. Finally, fuzzing user A D R titles exposed a classic V eight prototype bug where words like length or constructor collided with Object prototype, so I migrated every ontology map to null-prototype objects and simplified the UI from four dense tabs down to three calm, progressive-disclosure views.',
    srt: 'Three more fixes hardened production: (3) Recursive null-stripping + typed cell & sgk:1:... bookmark decoding; (4) A gated hydradb-init container in docker-compose.yml fixing /data/node-data-cache/shared permissions (os error 13); and (5) Migrating ontology maps to Object.create(null) to block V8 "length"/"constructor" prototype collisions, while simplifying the UI into 3 progressive-disclosure tabs.',
    caption: '07 · Technical Challenges #3-#5: Typed cell decoder, Docker cache init gate, V8 prototype safety & UI clarity',
    slide: {
      eyebrow: 'TECHNICAL CHALLENGES 03, 04 & 05 · RELIABILITY, SECURITY & UX DECISIONS',
      title: 'Typed Cell Envelopes, Docker Volume Permissions, V8 Safety & UI Simplification',
      leftTitle: 'Root Causes Caught in Testing',
      leftPoints: [
        'Challenge 3: HydraDB rejects null write props and returns {"type":"string","value":...} cells + sgk:1:... read_epoch bookmarks -> solved with recursive sanitizer + decoder.',
        'Challenge 4: Fresh Docker volume hit CorruptValue Permission denied (os error 13) on /data/node-data-cache/shared -> solved via one-shot hydradb-init service.',
        'Challenge 5 & UX: Fixed V8 "length"/__proto__ ontology collisions via Object.create(null), and simplified a dense 4-tab UI into 3 calm, prompt-first views.'
      ],
      rightTitle: 'docker-compose.yml & src/engines/structural-retriever.js',
      code: `# Health-gated volume bootstrap before ghcr.io/hydra-db/hydradb:0.4.0:
hydradb-init:
  image: alpine:3.20
  command: ["sh", "-c", "mkdir -p /data/store /data/node-data-cache/shared && chmod -R 0777 /data"]

// Prototype-safe ontology index (immune to "length" / "__proto__"):
const terms = Object.create(null);
if (!FORBIDDEN_OBJECT_KEYS.has(tok)) {
  if (!Object.hasOwn(terms, tok)) terms[tok] = [];
  terms[tok].push(node.id);
}`
    }
  },
  {
    id: 's8_studio_outro',
    cacheSlot: 9,
    leadIn: 0.38,
    tailOut: 1.25,
    spoken:
      'Here in Studio, all of those pieces come together: I can publish A D R twenty-five directly into HydraDB without re-embedding a single file, retire A D R fourteen via a live supersedes edge, and immediately verify the updated lineage in Compare. HydraScope also ships a six-tool stdio M C P server, a zero-config C L I with an offline mirror so benchmarks run anywhere, and is live under the M I T license.',
    srt: 'In Studio, all of those pieces come together: I can publish ADR-025 directly into HydraDB without re-embedding a single file, retire ADR-014 via a live :SUPERSEDES edge, and immediately verify the updated lineage in Compare. HydraScope also ships a 6-tool stdio MCP server and CLI, and is MIT open source at hydrascope.krusch.dev.',
    caption: '08 · Live Studio Mutation & MCP/CLI Stack · hydrascope.krusch.dev · github.com/kruschdev/HydraScope'
  }
];

function parseArgs(argv) {
  const defaultOut = path.join(os.homedir(), 'Downloads', 'hydrascope-loom-walkthrough.mp4');
  const opts = {
    appUrl: `http://127.0.0.1:${envOr('PORT', '4190', '4190')}`,
    outMp4: defaultOut,
    outSrt: defaultOut.replace(/\.mp4$/i, '.srt'),
    cacheDir: path.join(os.tmpdir(), 'hydrascope-loom-tts-cache'),
    keyframesDir: path.join(os.tmpdir(), 'hydrascope-loom-keyframes'),
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
    } else if (arg === '--voice-id' && argv[i + 1]) {
      opts.voiceId = argv[++i];
    }
  }
  return opts;
}

async function ensureSceneVoiceWav(scene, opts) {
  fs.mkdirSync(opts.cacheDir, { recursive: true });
  const slot = scene.cacheSlot;
  const hash = crypto
    .createHash('sha256')
    .update(`${opts.voiceId}::${opts.modelId}::${scene.spoken}`)
    .digest('hex')
    .slice(0, 12);
  const wav44Path = path.join(
    opts.cacheDir,
    `scene_${String(slot).padStart(2, '0')}_${hash}_44k.wav`
  );

  // Also check if any existing cached file matches `_*_${hash}_44k.wav` regardless of slot number
  const existingByHash = fs
    .readdirSync(opts.cacheDir)
    .find((f) => f.endsWith(`_${hash}_44k.wav`));
  if (existingByHash) {
    const fullExisting = path.join(opts.cacheDir, existingByHash);
    if (fs.statSync(fullExisting).size > 2048) {
      console.log(`[TTS] Reusing cached WAV for ${scene.id} (${existingByHash})`);
      return fullExisting;
    }
  }

  const rawMp3Path = path.join(opts.cacheDir, `raw_${slot}_${hash}.mp3`);
  const rawGemWav = path.join(opts.cacheDir, `raw_${slot}_${hash}_gem.wav`);
  let sourceAudioPath = null;

  if (opts.apiKey) {
    const ttsUrl = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(opts.voiceId)}`;
    console.log(`[TTS] Synthesizing ${scene.id} via ElevenLabs (${opts.modelId}, ${scene.spoken.length} chars)...`);
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
          text: scene.spoken,
          model_id: opts.modelId,
          voice_settings: {
            stability: 0.56,
            similarity_boost: 0.78,
            style: 0.12,
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
        tool: 'hydrascope.loom_tts'
      }
    );

    if (res.ok && res.data.status >= 200 && res.data.status < 300) {
      const buf = Buffer.from(await res.data.response.arrayBuffer());
      if (buf.byteLength > 1024) {
        fs.writeFileSync(rawMp3Path, buf);
        sourceAudioPath = rawMp3Path;
      }
    } else {
      const status = res.ok ? res.data.status : res.error?.code;
      console.warn(`[TTS] ElevenLabs returned ${status}; falling back to local gemini-api tts.`);
    }
  }

  if (!sourceAudioPath) {
    execFileSync(
      'gemini-api',
      ['tts', scene.spoken, '--voice', 'Charon', '--language', 'en-US', '--out', rawGemWav],
      { stdio: 'inherit' }
    );
    sourceAudioPath = rawGemWav;
  }

  execFileSync(
    'ffmpeg',
    [
      '-y',
      '-loglevel',
      'error',
      '-i',
      sourceAudioPath,
      '-af',
      'silenceremove=start_periods=1:start_silence=0.04:start_threshold=-48dB,areverse,silenceremove=start_periods=1:start_silence=0.08:start_threshold=-48dB,areverse',
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
  const parsed = parseWavHeader(bytes, { tool: 'hydrascope.loom_wav' });
  if (!parsed.ok) {
    throw new Error(`Invalid WAV ${wavPath}: ${parsed.error.message}`);
  }
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
    const scale = 0.88 / peak;
    for (let i = 0; i < sampleCount; i += 1) {
      out[i] = Math.max(-0.98, Math.min(0.98, out[i] * scale));
    }
  }
  return out;
}

function buildMasterAudioAndTimeline(scenesWithSamples, masterWavPath, srtPath) {
  let cursorFrames = 0;
  const timeline = [];

  for (let i = 0; i < scenesWithSamples.length; i += 1) {
    const s = scenesWithSamples[i];
    const speechSeconds = s.samples.length / SAMPLE_RATE;
    const totalSceneSec = s.leadIn + speechSeconds + s.tailOut;
    const sceneFrames = Math.ceil(totalSceneSec * FPS);
    const startFrame = cursorFrames;
    const endFrame = startFrame + sceneFrames;
    const startSec = startFrame / FPS;
    const speechStartSec = startSec + s.leadIn;
    const speechEndSec = speechStartSec + speechSeconds;

    timeline.push({
      ...s,
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
  const attack = 1 - Math.exp(-1 / (SAMPLE_RATE * 0.015));
  const release = 1 - Math.exp(-1 / (SAMPLE_RATE * 0.20));
  for (let i = 0; i < totalSamples; i += 1) {
    const absV = Math.abs(voiceTrack[i]);
    env += (absV - env) * (absV > env ? attack : release);
    voiceEnv[i] = env;
  }

  const frameVoiceLevels = new Array(totalFrames).fill(0);
  const samplesPerFrame = SAMPLE_RATE / FPS;
  for (let f = 0; f < totalFrames; f += 1) {
    const s0 = Math.floor(f * samplesPerFrame);
    const s1 = Math.min(totalSamples, Math.floor((f + 1) * samplesPerFrame));
    let sumSq = 0;
    for (let k = s0; k < s1; k += 1) {
      sumSq += voiceTrack[k] * voiceTrack[k];
    }
    const rms = s1 > s0 ? Math.sqrt(sumSq / (s1 - s0)) : 0;
    frameVoiceLevels[f] = Number(Math.min(1, rms * 3.6).toFixed(3));
  }

  const masterStereo = new Float32Array(totalSamples * 2);
  let lpL = 0;
  let lpR = 0;
  const lpAlpha = 0.08;
  const voices = [
    { freq: 73.416, amp: 0.24, pan: 0.0 },
    { freq: 110.0, amp: 0.18, pan: -0.3 },
    { freq: 146.832, amp: 0.15, pan: 0.3 },
    { freq: 220.0, amp: 0.09, pan: -0.2 }
  ];

  for (let i = 0; i < totalSamples; i += 1) {
    const t = i / SAMPLE_RATE;
    let rawL = 0;
    let rawR = 0;
    for (const pv of voices) {
      const sig = Math.sin(2 * Math.PI * pv.freq * t) * pv.amp;
      rawL += sig * Math.sqrt(0.5 * (1 - pv.pan));
      rawR += sig * Math.sqrt(0.5 * (1 + pv.pan));
    }
    lpL += lpAlpha * (rawL - lpL);
    lpR += lpAlpha * (rawR - lpR);

    const fadeIn = Math.min(1, t / 0.8);
    const fadeOut = Math.min(1, (totalSeconds - t) / 1.4);
    const duck = 1 - Math.min(0.62, voiceEnv[i] * 2.5);
    const ambGain = 0.060 * duck * Math.max(0, fadeIn * fadeOut);
    const vSample = voiceTrack[i] * 0.94;

    masterStereo[i * 2] = Math.max(-0.99, Math.min(0.99, vSample + lpL * ambGain));
    masterStereo[i * 2 + 1] = Math.max(-0.99, Math.min(0.99, vSample + lpR * ambGain));
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
      `${idx + 1}\n${formatSrtTime(item.speechStartSec)} --> ${formatSrtTime(item.speechEndSec + 0.2)}\n${item.srt}\n`
  );
  fs.writeFileSync(srtPath, srtBlocks.join('\n'), 'utf8');

  return { timeline, totalFrames, totalSeconds, frameVoiceLevels };
}

function easeInOutCubic(t) {
  const x = Math.max(0, Math.min(1, t));
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

async function injectLoomOverlay(page) {
  await page.evaluate(() => {
    document.documentElement.style.zoom = '1.16';
    const existing = document.getElementById('hs-loom-overlay-root');
    if (existing) existing.remove();

    const style = document.createElement('style');
    style.textContent = `
      * { caret-color: transparent !important; }
      ::-webkit-scrollbar { width: 0px; height: 0px; }
      #hs-loom-overlay-root {
        position: fixed;
        inset: 0;
        pointer-events: none;
        z-index: 999999;
        zoom: 0.8620689;
      }
      #hs-loom-slide-backdrop {
        position: absolute;
        inset: 0;
        background: rgba(9, 9, 11, 0.86);
        backdrop-filter: blur(10px);
        display: none;
        align-items: center;
        justify-content: center;
        padding: 48px 72px 96px;
      }
      #hs-loom-slide-backdrop.is-open {
        display: flex;
      }
      .hs-slide-card {
        width: 100%;
        max-width: 1580px;
        background: #111114;
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 18px;
        padding: 38px 44px;
        box-shadow: 0 28px 80px rgba(0, 0, 0, 0.75);
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
        color: #fafafa;
      }
      .hs-slide-eyebrow {
        font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 13px;
        font-weight: 600;
        letter-spacing: 0.08em;
        color: #34d399;
        margin-bottom: 10px;
      }
      .hs-slide-title {
        margin: 0 0 26px;
        font-size: 30px;
        font-weight: 700;
        letter-spacing: -0.02em;
        color: #fafafa;
      }
      .hs-slide-cols {
        display: grid;
        grid-template-columns: 0.95fr 1.05fr;
        gap: 28px;
        align-items: stretch;
      }
      .hs-slide-pane {
        background: #09090b;
        border: 1px solid rgba(255, 255, 255, 0.09);
        border-radius: 12px;
        padding: 24px 26px;
        display: flex;
        flex-direction: column;
      }
      .hs-slide-pane-title {
        font-size: 15px;
        font-weight: 600;
        color: #e4e4e7;
        margin: 0 0 14px;
        padding-bottom: 10px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      }
      .hs-slide-list {
        margin: 0;
        padding: 0;
        list-style: none;
        display: flex;
        flex-direction: column;
        gap: 14px;
      }
      .hs-slide-list li {
        font-size: 16px;
        line-height: 1.52;
        color: #d4d4d8;
        padding-left: 18px;
        position: relative;
      }
      .hs-slide-list li::before {
        content: '';
        position: absolute;
        left: 0;
        top: 9px;
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: #10b981;
      }
      .hs-slide-pre {
        margin: 0;
        font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 14.5px;
        line-height: 1.58;
        color: #a7f3d0;
        white-space: pre-wrap;
      }
      #hs-loom-cursor {
        position: absolute;
        left: 960px;
        top: 540px;
        width: 28px;
        height: 28px;
        transform: translate(-3px, -2px);
        filter: drop-shadow(0 3px 8px rgba(0, 0, 0, 0.65));
      }
      #hs-loom-ripple {
        position: absolute;
        width: 44px;
        height: 44px;
        margin-left: -22px;
        margin-top: -22px;
        border-radius: 50%;
        border: 2.5px solid #10b981;
        background: rgba(16, 185, 129, 0.16);
        opacity: 0;
        transform: scale(0.3);
      }
      #hs-loom-caption-bar {
        position: absolute;
        left: 50%;
        bottom: 22px;
        transform: translateX(-50%);
        background: rgba(17, 17, 20, 0.94);
        border: 1px solid rgba(255, 255, 255, 0.15);
        border-radius: 999px;
        padding: 9px 22px;
        display: flex;
        align-items: center;
        gap: 12px;
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.65);
        max-width: 1640px;
        white-space: nowrap;
      }
      .hs-loom-eq {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        height: 16px;
      }
      .hs-loom-eq span {
        display: block;
        width: 3px;
        border-radius: 2px;
        background: #10b981;
        height: 4px;
      }
      #hs-loom-caption-text {
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
        font-size: 15px;
        font-weight: 500;
        color: #fafafa;
        letter-spacing: -0.01em;
      }
    `;
    document.head.appendChild(style);

    const root = document.createElement('div');
    root.id = 'hs-loom-overlay-root';
    root.innerHTML = `
      <div id="hs-loom-slide-backdrop">
        <div class="hs-slide-card">
          <div class="hs-slide-eyebrow" id="hs-slide-eyebrow"></div>
          <h2 class="hs-slide-title" id="hs-slide-title"></h2>
          <div class="hs-slide-cols">
            <div class="hs-slide-pane">
              <h3 class="hs-slide-pane-title" id="hs-slide-left-title"></h3>
              <ul class="hs-slide-list" id="hs-slide-list"></ul>
            </div>
            <div class="hs-slide-pane">
              <h3 class="hs-slide-pane-title" id="hs-slide-right-title"></h3>
              <pre class="hs-slide-pre" id="hs-slide-code"></pre>
            </div>
          </div>
        </div>
      </div>
      <div id="hs-loom-ripple"></div>
      <div id="hs-loom-cursor">
        <svg viewBox="0 0 28 28" width="28" height="28" fill="none">
          <path d="M4 3L12.5 24L15.8 15.8L24 12.5L4 3Z" fill="#FAFAFA" stroke="#09090B" stroke-width="2" stroke-linejoin="round"/>
        </svg>
      </div>
      <div id="hs-loom-caption-bar">
        <div class="hs-loom-eq" id="hs-loom-eq">
          <span></span><span></span><span></span><span></span><span></span>
        </div>
        <div id="hs-loom-caption-text"></div>
      </div>
    `;
    document.body.appendChild(root);

    let activeSlideKey = '';
    window.__setLoomFrame = ({ x, y, rippleProgress, caption, voiceLevel, slide, slideKey }) => {
      const cur = document.getElementById('hs-loom-cursor');
      const rip = document.getElementById('hs-loom-ripple');
      const cap = document.getElementById('hs-loom-caption-text');
      const bars = document.querySelectorAll('#hs-loom-eq span');
      const backdrop = document.getElementById('hs-loom-slide-backdrop');

      if (backdrop) {
        if (slide) {
          backdrop.classList.add('is-open');
          if (cur) cur.style.display = 'none';
          if (activeSlideKey !== slideKey) {
            activeSlideKey = slideKey;
            document.getElementById('hs-slide-eyebrow').textContent = slide.eyebrow || '';
            document.getElementById('hs-slide-title').textContent = slide.title || '';
            document.getElementById('hs-slide-left-title').textContent = slide.leftTitle || '';
            document.getElementById('hs-slide-right-title').textContent = slide.rightTitle || '';
            document.getElementById('hs-slide-code').textContent = slide.code || '';
            const ul = document.getElementById('hs-slide-list');
            ul.innerHTML = '';
            for (const pt of slide.leftPoints || []) {
              const li = document.createElement('li');
              li.textContent = pt;
              ul.appendChild(li);
            }
          }
        } else {
          backdrop.classList.remove('is-open');
          activeSlideKey = '';
          if (cur) cur.style.display = 'block';
        }
      }

      if (cur && !slide) {
        cur.style.left = `${Math.round(x)}px`;
        cur.style.top = `${Math.round(y)}px`;
      }
      if (rip) {
        if (!slide && rippleProgress > 0 && rippleProgress < 1) {
          rip.style.left = `${Math.round(x)}px`;
          rip.style.top = `${Math.round(y)}px`;
          rip.style.opacity = String(Number((1 - rippleProgress).toFixed(3)));
          rip.style.transform = `scale(${(0.35 + rippleProgress * 1.15).toFixed(3)})`;
        } else {
          rip.style.opacity = '0';
        }
      }
      if (cap && cap.textContent !== caption) {
        cap.textContent = caption;
      }
      if (bars.length === 5) {
        const weights = [0.55, 0.9, 1.0, 0.8, 0.5];
        bars.forEach((b, idx) => {
          const h = Math.max(4, Math.round(4 + voiceLevel * 13 * weights[idx]));
          b.style.height = `${h}px`;
        });
      }
    };
  });
}

async function getViewportTargetCenter(page, finderType, finderArg) {
  return page.evaluate(
    ({ type, arg }) => {
      const zoom = parseFloat(document.documentElement.style.zoom || '1') || 1;
      let el = null;
      if (type === 'selector') {
        el = document.querySelector(arg);
      } else if (type === 'buttonText') {
        const buttons = Array.from(document.querySelectorAll('button, [role="button"], select'));
        el = buttons.find((b) => (b.textContent || '').trim().includes(arg)) || null;
      }
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return {
        x: (rect.left + rect.width * 0.5) * zoom,
        y: (rect.top + rect.height * 0.5) * zoom
      };
    },
    { type: finderType, arg: finderArg }
  );
}

async function clickTargetAndSettle(page, finderType, finderArg, waitMs = 320) {
  await page.evaluate(
    ({ type, arg }) => {
      let el = null;
      if (type === 'selector') {
        el = document.querySelector(arg);
      } else if (type === 'buttonText') {
        const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
        el = buttons.find((b) => (b.textContent || '').trim().includes(arg)) || null;
      }
      if (el) el.click();
    },
    { type: finderType, arg: finderArg }
  );
  await new Promise((r) => setTimeout(r, waitMs));
}

async function resetDemoWorkspace(page) {
  await clickTargetAndSettle(page, 'selector', '#hs-tab-studio', 180);
  await clickTargetAndSettle(page, 'buttonText', 'Reset demo', 450);
  await clickTargetAndSettle(page, 'selector', '#hs-tab-compare', 450);
  await page.evaluate(() => window.scrollTo(0, 0));
}

async function main() {
  const opts = parseArgs(process.argv);
  fs.mkdirSync(path.dirname(opts.outMp4), { recursive: true });
  fs.mkdirSync(opts.keyframesDir, { recursive: true });

  // 1. Synthesize or reuse cached voiceover clips across all 8 chapters
  const scenesWithSamples = [];
  for (let i = 0; i < SCENES.length; i += 1) {
    const wavPath = await ensureSceneVoiceWav(SCENES[i], opts);
    const samples = readMonoFloatSamples(wavPath);
    scenesWithSamples.push({ ...SCENES[i], wavPath, samples });
  }

  const masterWavPath = path.join(opts.cacheDir, 'hydrascope_hackathon_master_44k.wav');
  const { timeline, totalFrames, totalSeconds, frameVoiceLevels } = buildMasterAudioAndTimeline(
    scenesWithSamples,
    masterWavPath,
    opts.outSrt
  );
  console.log(
    `[Audio] Master timeline locked: ${timeline.length} chapters, ${totalFrames} frames (${totalSeconds.toFixed(2)}s / ${(totalSeconds / 60).toFixed(2)}m)`
  );

  // 2. Launch headless Chrome on live HydraScope UI
  const browser = await launchBrowser();
  const page = await browser.newPage();
  await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 });
  await page.goto(opts.appUrl, { waitUntil: 'networkidle0' });
  await resetDemoWorkspace(page);
  await injectLoomOverlay(page);
  await new Promise((r) => setTimeout(r, 400));

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
    '20',
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

  let curX = 960;
  let curY = 260;
  let fromX = 960;
  let fromY = 260;
  let toX = 960;
  let toY = 260;
  let moveStartFrame = 0;
  let moveEndFrame = 1;
  let lastClickFrame = -999;

  let scrollFrom = 0;
  let scrollTo = 0;
  let scrollStartFrame = 0;
  let scrollEndFrame = 1;
  let curScroll = 0;

  const scheduleMoveTo = async (frame, durationFrames, finderType, finderArg, fallbackPos) => {
    const pos = finderType ? await getViewportTargetCenter(page, finderType, finderArg) : null;
    const target = pos || fallbackPos || { x: curX, y: curY };
    fromX = curX;
    fromY = curY;
    toX = target.x;
    toY = target.y;
    moveStartFrame = frame;
    moveEndFrame = frame + Math.max(1, durationFrames);
  };

  const scheduleScrollTo = (frame, durationFrames, targetY) => {
    scrollFrom = curScroll;
    scrollTo = targetY;
    scrollStartFrame = frame;
    scrollEndFrame = frame + Math.max(1, durationFrames);
  };

  const [s1, s2, s3, , s5, , , s8] = timeline;
  const fAt = (scene, pct) => scene.startFrame + Math.round(scene.sceneFrames * pct);
  const fired = new Set();
  const onceAt = (key, cond) => {
    if (!cond || fired.has(key)) return false;
    fired.add(key);
    return true;
  };

  try {
    for (let f = 0; f < totalFrames; f += 1) {
      const activeScene =
        timeline.find((s) => f >= s.startFrame && f < s.endFrame) || timeline[timeline.length - 1];

      // Chapter 1: Fee rounding blast radius
      if (onceAt('s1_stat', f >= fAt(s1, 0.14))) {
        await scheduleMoveTo(f, 18, 'selector', '.hs-verdict-grid .hs-stat-card:nth-child(2)', { x: 960, y: 420 });
      }
      if (onceAt('s1_vec_miss', f >= fAt(s1, 0.42))) {
        await scheduleMoveTo(f, 20, 'selector', '.hs-callout-fail', { x: 560, y: 585 });
      }
      if (onceAt('s1_hydra_win', f >= fAt(s1, 0.62))) {
        await scheduleMoveTo(f, 20, 'selector', '.hs-pane-hydra .hs-item:nth-child(4)', { x: 1320, y: 760 });
      }
      if (onceAt('s1_scroll_graph', f >= fAt(s1, 0.76))) {
        scheduleScrollTo(f, 20, 300);
      }
      if (onceAt('s1_hover_svg', f >= fAt(s1, 0.85))) {
        await scheduleMoveTo(f, 16, 'selector', '.hs-graph-card', { x: 1260, y: 690 });
      }

      // Chapter 2: Stripe webhook retired ADR + time-travel
      if (onceAt('s2_scroll_top', f >= s2.startFrame + 1)) {
        scheduleScrollTo(f, 14, 0);
      }
      if (onceAt('s2_move_stripe', f >= fAt(s2, 0.06))) {
        await scheduleMoveTo(f, 15, 'buttonText', 'Stripe webhook rule', { x: 650, y: 250 });
      }
      if (onceAt('s2_click_stripe', f >= fAt(s2, 0.14))) {
        lastClickFrame = f;
        await clickTargetAndSettle(page, 'buttonText', 'Stripe webhook rule', 420);
      }
      if (onceAt('s2_stat_poison', f >= fAt(s2, 0.28))) {
        await scheduleMoveTo(f, 16, 'selector', '.hs-verdict-grid .hs-stat-card:nth-child(3)', { x: 1360, y: 420 });
      }
      if (onceAt('s2_vec_adr003', f >= fAt(s2, 0.45))) {
        await scheduleMoveTo(f, 16, 'selector', '.hs-item-fail', { x: 580, y: 590 });
      }
      if (onceAt('s2_hydra_clean', f >= fAt(s2, 0.62))) {
        await scheduleMoveTo(f, 16, 'selector', '.hs-pane-hydra .hs-callout-win', { x: 1300, y: 580 });
      }
      if (onceAt('s2_move_opts', f >= fAt(s2, 0.74))) {
        await scheduleMoveTo(f, 12, 'buttonText', 'Options & time-travel', { x: 1490, y: 122 });
      }
      if (onceAt('s2_click_opts', f >= fAt(s2, 0.80))) {
        lastClickFrame = f;
        await clickTargetAndSettle(page, 'buttonText', 'Options & time-travel', 180);
        await scheduleMoveTo(f + 1, 10, 'buttonText', '2026-03-01', { x: 640, y: 315 });
      }
      if (onceAt('s2_click_past', f >= fAt(s2, 0.87))) {
        lastClickFrame = f;
        await clickTargetAndSettle(page, 'buttonText', '2026-03-01', 360);
      }
      if (onceAt('s2_reset_today', f >= fAt(s2, 0.96))) {
        await clickTargetAndSettle(page, 'buttonText', 'Today (HEAD)', 260);
        await clickTargetAndSettle(page, 'buttonText', 'Hide options', 120);
      }

      // Chapter 3: Fake Kafka trap + Technical details drawer
      if (onceAt('s3_move_kafka', f >= fAt(s3, 0.05))) {
        await scheduleMoveTo(f, 15, 'buttonText', 'Fake Kafka trap', { x: 930, y: 250 });
      }
      if (onceAt('s3_click_kafka', f >= fAt(s3, 0.14))) {
        lastClickFrame = f;
        await clickTargetAndSettle(page, 'buttonText', 'Fake Kafka trap', 380);
      }
      if (onceAt('s3_hover_zero', f >= fAt(s3, 0.30))) {
        await scheduleMoveTo(f, 16, 'selector', '.hs-verdict-grid .hs-stat-card:nth-child(1)', { x: 520, y: 410 });
      }
      if (onceAt('s3_hover_block', f >= fAt(s3, 0.48))) {
        await scheduleMoveTo(f, 16, 'selector', '.hs-pane-hydra .hs-callout-win', { x: 1300, y: 580 });
      }
      if (onceAt('s3_scroll_tech', f >= fAt(s3, 0.62))) {
        scheduleScrollTo(f, 15, 220);
      }
      if (onceAt('s3_move_tech', f >= fAt(s3, 0.70))) {
        await scheduleMoveTo(f, 12, 'selector', '.hs-disclosure-btn', { x: 860, y: 820 });
      }
      if (onceAt('s3_click_tech', f >= fAt(s3, 0.77))) {
        lastClickFrame = f;
        await clickTargetAndSettle(page, 'selector', '.hs-disclosure-btn', 220);
        scheduleScrollTo(f + 1, 14, 360);
      }

      // Chapter 4 is Architecture Decision Slide (s4_arch_unified_graph) - handled automatically by activeScene.slide

      // Chapter 5: Benchmarks tab (8-task scorecard + 64-tool curve + 64-op stress test)
      if (onceAt('s5_top', f >= s5.startFrame + 1)) {
        scheduleScrollTo(f, 12, 0);
      }
      if (onceAt('s5_move_tab', f >= fAt(s5, 0.04))) {
        await scheduleMoveTo(f, 14, 'selector', '#hs-tab-benchmarks', { x: 1030, y: 36 });
      }
      if (onceAt('s5_click_tab', f >= fAt(s5, 0.10))) {
        lastClickFrame = f;
        await clickTargetAndSettle(page, 'selector', '#hs-tab-benchmarks', 280);
      }
      if (onceAt('s5_hover_hydra_row', f >= fAt(s5, 0.22))) {
        await scheduleMoveTo(f, 18, 'selector', '.hs-row-win', { x: 840, y: 390 });
      }
      if (onceAt('s5_scroll_continual', f >= fAt(s5, 0.38))) {
        scheduleScrollTo(f, 18, 340);
      }
      if (onceAt('s5_hover_f1', f >= fAt(s5, 0.48))) {
        await scheduleMoveTo(f, 16, 'selector', 'section[aria-label="64-tool continual learning benchmark"] .hs-stat-card:nth-child(1)', { x: 520, y: 320 });
      }
      if (onceAt('s5_hover_turns', f >= fAt(s5, 0.62))) {
        await scheduleMoveTo(f, 16, 'selector', 'section[aria-label="64-tool continual learning benchmark"] .hs-stat-card:nth-child(2)', { x: 960, y: 320 });
      }
      if (onceAt('s5_open_stress', f >= fAt(s5, 0.74))) {
        scheduleScrollTo(f, 14, 520);
        await clickTargetAndSettle(page, 'selector', 'section[aria-label="Concurrent OpenCypher throughput test"] .hs-disclosure-btn', 200);
        await scheduleMoveTo(f + 1, 12, 'buttonText', 'Run 64-query stress test', { x: 1460, y: 780 });
      }
      if (onceAt('s5_click_stress', f >= fAt(s5, 0.83))) {
        lastClickFrame = f;
        await clickTargetAndSettle(page, 'buttonText', 'Run 64-query stress test', 650);
      }

      // Chapters 6 & 7 are Technical Challenges Deep-Dive Slides - handled automatically by activeScene.slide

      // Chapter 8: Studio tab (Publish ADR-025 -> Test in Compare)
      if (onceAt('s8_top', f >= s8.startFrame + 1)) {
        scheduleScrollTo(f, 12, 0);
      }
      if (onceAt('s8_move_tab', f >= fAt(s8, 0.05))) {
        await scheduleMoveTo(f, 14, 'selector', '#hs-tab-studio', { x: 1120, y: 36 });
      }
      if (onceAt('s8_click_tab', f >= fAt(s8, 0.12))) {
        lastClickFrame = f;
        await clickTargetAndSettle(page, 'selector', '#hs-tab-studio', 260);
      }
      if (onceAt('s8_move_publish', f >= fAt(s8, 0.26))) {
        await scheduleMoveTo(f, 16, 'buttonText', 'Publish & retire old rule', { x: 440, y: 470 });
      }
      if (onceAt('s8_click_publish', f >= fAt(s8, 0.36))) {
        lastClickFrame = f;
        await clickTargetAndSettle(page, 'buttonText', 'Publish & retire old rule', 520);
      }
      if (onceAt('s8_move_test_cmp', f >= fAt(s8, 0.50))) {
        await scheduleMoveTo(f, 14, 'buttonText', 'Test in Compare', { x: 960, y: 205 });
      }
      if (onceAt('s8_click_test_cmp', f >= fAt(s8, 0.58))) {
        lastClickFrame = f;
        await clickTargetAndSettle(page, 'buttonText', 'Test in Compare', 520);
      }
      if (onceAt('s8_hover_adr025', f >= fAt(s8, 0.72))) {
        await scheduleMoveTo(f, 18, 'selector', '.hs-pane-hydra .hs-callout-win', { x: 1300, y: 580 });
      }

      if (f <= scrollEndFrame && scrollEndFrame > scrollStartFrame) {
        const sp = easeInOutCubic((f - scrollStartFrame) / (scrollEndFrame - scrollStartFrame));
        curScroll = scrollFrom + (scrollTo - scrollFrom) * sp;
        await page.evaluate((y) => window.scrollTo(0, y), Math.round(curScroll));
      }

      if (f <= moveEndFrame && moveEndFrame > moveStartFrame) {
        const mp = easeInOutCubic((f - moveStartFrame) / (moveEndFrame - moveStartFrame));
        curX = fromX + (toX - fromX) * mp;
        curY = fromY + (toY - fromY) * mp;
      }

      const rippleProgress =
        f >= lastClickFrame && f < lastClickFrame + 12 ? (f - lastClickFrame) / 12 : 0;

      await page.evaluate((payload) => {
        if (typeof window.__setLoomFrame === 'function') window.__setLoomFrame(payload);
      }, {
        x: curX,
        y: curY,
        rippleProgress,
        caption: activeScene.caption,
        voiceLevel: frameVoiceLevels[f] || 0,
        slide: activeScene.slide || null,
        slideKey: activeScene.id
      });

      const jpegBuf = await page.screenshot({ type: 'jpeg', quality: 92 });

      const midFrame = activeScene.startFrame + Math.floor(activeScene.sceneFrames * 0.65);
      if (f === midFrame) {
        fs.writeFileSync(
          path.join(opts.keyframesDir, `${String(activeScene.index + 1).padStart(2, '0')}_${activeScene.id}.jpg`),
          jpegBuf
        );
      }

      if (!ffmpeg.stdin.write(jpegBuf)) {
        await once(ffmpeg.stdin, 'drain');
      }

      if (f > 0 && f % 480 === 0) {
        console.log(`[Render] Frame ${f} / ${totalFrames} (${Math.round((f / totalFrames) * 100)}%)`);
      }
    }

    ffmpeg.stdin.end();
    const [exitCode] = await once(ffmpeg, 'close');
    if (exitCode !== 0) {
      throw new Error(`FFmpeg exited with code ${exitCode}`);
    }
  } finally {
    try {
      await resetDemoWorkspace(page);
    } catch {
      // ignore cleanup errors
    }
    await browser.close();
  }

  const stat = fs.statSync(opts.outMp4);
  console.log(
    `[Done] Wrote ${opts.outMp4} (${(stat.size / (1024 * 1024)).toFixed(2)} MiB, ${totalSeconds.toFixed(2)}s) + ${opts.outSrt}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
