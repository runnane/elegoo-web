/**
 * AI Print Monitor — analyzes camera frames during prints to detect failures.
 *
 * Two analysis backends:
 *   1. VLM (Vision Language Model) — OpenAI-compatible API (OpenAI, Ollama, etc.)
 *   2. Local — CLIP zero-shot image classification via @huggingface/transformers
 *              (runs on CPU, no GPU or external API needed)
 *
 * Also includes:
 *   - Motion detection (frame-to-frame pixel diff via sharp)
 *   - Classification score tracking (CLIP labels → 5 chart groups)
 *
 * Results are stored in a ring buffer and exposed via events.
 * Consecutive warnings trigger alerts sent to Telegram and WS clients.
 */

import { EventEmitter } from 'events';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import type { ServiceConfig } from './config.js';
import type { StateStore, PrintEvent } from './state-store.js';
import { getSnapshot } from './rest-api.js';
import sharp from 'sharp';
import { getLogger } from './logger.js';
import { isFilamentChangeSubStatus } from '../types.js';

const log = getLogger('AI');

// ---- Types ----

export interface AIIssue {
  type: string;
  description: string;
  confidence: number;
}

export interface AIAnalysis {
  timestamp: number;
  source: 'vlm' | 'local' | 'motion';
  status: 'ok' | 'warning' | 'critical';
  confidence: number;
  issues: AIIssue[];
  description: string;
  durationMs: number;
  /** Per-group classification scores (0-100) for charting */
  classificationScores?: Record<string, number>;
  /** Raw per-label scores from zero-shot classification (0-1) */
  labelScores?: Array<{ label: string; score: number }>;
}

export interface AIAlert {
  timestamp: number;
  status: 'warning' | 'critical';
  issues: AIIssue[];
  description: string;
  consecutiveWarnings: number;
}

/** Chart data point emitted with each analysis cycle */
export interface AIChartData {
  t: number;
  motion: number;                        // 0-100 percentage
  scores: Record<string, number>;        // group name → 0-100
}

// ---- Classification Groups (for charting) ----

const CLASSIFICATION_GROUPS = [
  'Print in Progress',
  'Spaghetti/Failure',
  'Empty Bed',
  'Paused/Stopped',
  'Other',
] as const;

type ClassificationGroup = typeof CLASSIFICATION_GROUPS[number];

/** Map a CLIP label to one of the 5 chart groups (fallback for configs without group field) */
function categorizeLabel(label: string): ClassificationGroup {
  const l = label.toLowerCase();
  if (l.includes('actively printing') || l.includes('being extruded') || l.includes('starting layers')) return 'Print in Progress';
  if (l.includes('spaghetti') || l.includes('tangled') || l.includes('disaster') ||
      l.includes('layer shift') || l.includes('warping') || l.includes('stringing') || l.includes('strings') ||
      l.includes('blob') || l.includes('fell off') || l.includes('unstuck'))
    return 'Spaghetti/Failure';
  if (l.includes('empty') && l.includes('bed')) return 'Empty Bed';
  return 'Other';
}

// ---- CLIP Labels (zero-shot classification) ----

/** Descriptive labels for CLIP zero-shot classification.
 *  NOTE: 'print_stalled' / 'paused nozzle' was removed — CLIP cannot determine
 *  motion or stalling from a single image. Stall detection now uses the motion
 *  detector (consecutive low-motion frames while printing). */
const DEFAULT_CLIP_LABELS: readonly string[] = [
  'inside an enclosed 3D printer, a solid plastic object with clean uniform horizontal layer lines sits on a dark textured build plate, the metal printhead gantry is above it, normal successful print in progress',
  'inside an enclosed 3D printer, loose tangled curly strands of plastic filament scattered randomly across the dark textured build plate, no solid object present, failed spaghetti print',
  'inside an enclosed 3D printer, a messy pile of thin plastic noodles and loops dragged across the dark bed by the printhead, filament not sticking, print failure in progress',
  'inside an enclosed 3D printer, a knocked over or tilted plastic object lying on its side on the dark textured build plate, the part has detached and fallen from where it was printing',
  'inside an enclosed 3D printer, thin wispy cobweb-like strings of plastic hanging between parts of a 3D printed object on the dark build plate, stringing defect',
  'inside an enclosed 3D printer, a 3D printed object on the dark build plate with visibly misaligned layers, the top portion is shifted sideways relative to the bottom, layer shift defect',
  'inside an enclosed 3D printer, the corners or edges of a flat printed part are curling upward and lifting off the dark textured build plate, warping defect',
  'inside an enclosed 3D printer, a shapeless irregular mass of melted plastic has accumulated around the nozzle and hotend, no layer structure visible, the blob is engulfing the printhead',
  'inside an enclosed 3D printer, the dark textured build plate is completely empty with nothing on it, no printed objects and no filament visible, just the bare bed surface',
] as const;

/** Map CLIP label indices to issue types and severity */
const DEFAULT_LABEL_ISSUE_MAP: Record<number, { type: string; severity: 'warning' | 'critical' }> = {
  1: { type: 'spaghetti', severity: 'critical' },
  2: { type: 'spaghetti', severity: 'critical' },
  3: { type: 'bed_adhesion', severity: 'critical' },
  4: { type: 'stringing', severity: 'warning' },
  5: { type: 'layer_shift', severity: 'critical' },
  6: { type: 'warping', severity: 'warning' },
  7: { type: 'blob', severity: 'critical' },
  8: { type: 'empty_bed', severity: 'critical' },
};

const DEFAULT_WARN_THRESHOLD = 0.25;
const DEFAULT_CRIT_THRESHOLD = 0.40;

// ---- AI Label Configuration (persisted to disk) ----

export interface AILabelConfig {
  label: string;
  issueType: string;
  severity: 'ok' | 'warning' | 'critical';
  warnThreshold: number;
  critThreshold: number;
  /** Chart group for classification display */
  group: ClassificationGroup;
}

/** Build default label configs from hardcoded values */
function buildDefaultLabelConfigs(): AILabelConfig[] {
  return DEFAULT_CLIP_LABELS.map((label, idx) => {
    const mapping = DEFAULT_LABEL_ISSUE_MAP[idx];
    return {
      label,
      issueType: mapping?.type ?? 'ok',
      severity: mapping?.severity ?? 'ok',
      warnThreshold: mapping ? DEFAULT_WARN_THRESHOLD : 1,
      critThreshold: mapping ? DEFAULT_CRIT_THRESHOLD : 1,
      group: categorizeLabel(label),
    };
  });
}

/** Threshold for motion % below which the printer is considered "not moving" */
const MOTION_STALL_THRESHOLD = 0.5;
/** How many consecutive low-motion readings before we flag print_stalled */
const MOTION_STALL_COUNT = 3;

// ---- Motion Detector (sharp-based pixel diff) ----

const MOTION_WIDTH = 160;
const MOTION_HEIGHT = 120;

class MotionDetector {
  private prevFrame: Buffer | null = null;

  /** Compare current frame to previous, returns motion percentage 0-100 */
  async detect(jpeg: Buffer): Promise<number> {
    // Convert to small grayscale buffer for fast comparison
    const current = await sharp(jpeg)
      .resize(MOTION_WIDTH, MOTION_HEIGHT, { fit: 'fill' })
      .grayscale()
      .raw()
      .toBuffer();

    if (!this.prevFrame || this.prevFrame.length !== current.length) {
      this.prevFrame = current;
      return 0;
    }

    // Count pixels that differ beyond threshold
    const threshold = 25; // ~10% of 255
    let diffCount = 0;
    const total = current.length;
    for (let i = 0; i < total; i++) {
      if (Math.abs(current[i] - this.prevFrame[i]) > threshold) {
        diffCount++;
      }
    }

    this.prevFrame = current;
    return (diffCount / total) * 100;
  }

  reset(): void {
    this.prevFrame = null;
  }
}

// ---- VLM Prompt ----

const VLM_SYSTEM_PROMPT = `You are a 3D print quality monitor. Analyze the camera image of a running FDM 3D printer and detect any print failures or issues.

Respond with ONLY valid JSON matching this schema:
{
  "status": "ok" | "warning" | "critical",
  "confidence": 0.0 to 1.0,
  "issues": [
    { "type": "<issue_type>", "description": "<brief description>", "confidence": 0.0 to 1.0 }
  ],
  "description": "<one sentence summary of what you see>"
}

Issue types to check for:
- spaghetti: filament extruding into air, tangled mess of filament
- bed_adhesion: print detached from build plate, shifted or knocked over
- layer_shift: visible misalignment between layers
- blob: large blob of melted plastic accumulating
- under_extrusion: gaps, holes, or missing sections in print walls
- warping: corners or edges lifting from bed
- stringing: thin strings of filament between parts
- nozzle_clog: no filament coming out despite movement
- print_stalled: no visible progress or movement
- other: any other defect not listed above

If everything looks normal, return status "ok" with an empty issues array.
Be conservative — only flag issues you're confident about. Minor cosmetic issues are "warning", print-threatening issues are "critical".`;

const VLM_USER_PROMPT = 'Analyze this 3D print camera image for print quality issues:';

// ---- Local CLIP Analyzer ----

type CLIPClassifier = (image: Blob, labels: string[]) => Promise<Array<{ label: string; score: number }>>;

class LocalAnalyzer {
  private classifier: CLIPClassifier | null = null;
  private loading = false;
  private _ready = false;
  private model: string;

  constructor(model: string) {
    this.model = model;
  }

  get ready(): boolean { return this._ready; }

  async initialize(): Promise<void> {
    if (this._ready || this.loading) return;
    this.loading = true;

    try {
      log.info(`Loading model ${this.model}...`);
      const start = Date.now();

      // Dynamic import to avoid loading transformers.js at module level
      const { pipeline, env } = await import('@huggingface/transformers');

      // Configure for Node.js server usage
      env.useBrowserCache = false;
      env.allowLocalModels = true;
      env.cacheDir = '.cache/models';

      this.classifier = await pipeline(
        'zero-shot-image-classification',
        this.model,
        { dtype: 'q8', device: 'cpu' },
      ) as unknown as CLIPClassifier;

      this._ready = true;
      log.info(`Model loaded in ${Date.now() - start}ms`);
    } catch (err) {
      log.error('Failed to load model:', (err as Error).message);
      this.loading = false;
    }
  }

  async analyze(jpeg: Buffer, labelConfigs: AILabelConfig[]): Promise<AIAnalysis> {
    const start = Date.now();

    if (!this.classifier) {
      return {
        timestamp: start,
        source: 'local',
        status: 'ok',
        confidence: 0,
        issues: [],
        description: 'CLIP model not loaded yet',
        durationMs: Date.now() - start,
      };
    }

    try {
      const labels = labelConfigs.map(c => c.label);
      const blob = new Blob([new Uint8Array(jpeg)], { type: 'image/jpeg' });
      const rawResults = await this.classifier(blob, labels);

      // SigLIP uses per-label sigmoid scores (each 0-1 independently).
      // Normalize to a relative distribution (like CLIP softmax) so that
      // existing thresholds (15%, 30%) remain meaningful.
      const sumRaw = rawResults.reduce((s, r) => s + r.score, 0);
      const results = sumRaw > 0
        ? rawResults.map(r => ({ label: r.label, score: r.score / sumRaw }))
        : rawResults;

      // Results are sorted by score descending
      const top = results[0];

      const issues: AIIssue[] = [];
      let status: 'ok' | 'warning' | 'critical' = 'ok';

      // Build classification group scores for charting
      const groupScores: Record<string, number> = {};
      for (const g of CLASSIFICATION_GROUPS) groupScores[g] = 0;

      // Find the best "ok" label score — defects must exceed this to trigger.
      // This prevents false positives when CLIP spreads residual probability
      // across defect labels while the top match is clearly a normal print.
      const bestOkScore = results.reduce((max, r) => {
        const idx = labels.indexOf(r.label);
        const c = idx >= 0 ? labelConfigs[idx] : undefined;
        return (c?.severity === 'ok' && r.score > max) ? r.score : max;
      }, 0);

      // Check all results for issue labels above confidence threshold
      for (const r of results) {
        const cfgIdx = labels.indexOf(r.label);
        const cfg = cfgIdx >= 0 ? labelConfigs[cfgIdx] : undefined;

        // Accumulate into chart groups — use configured group, fallback to keyword matching
        const group = cfg?.group ?? categorizeLabel(r.label);
        groupScores[group] = (groupScores[group] || 0) + r.score * 100;

        // Defect must exceed both its configured threshold AND the best "ok" label score
        if (cfg && cfg.severity !== 'ok' && r.score > cfg.warnThreshold && r.score > bestOkScore) {
          issues.push({
            type: cfg.issueType,
            description: r.label,
            confidence: r.score,
          });
          if (cfg.severity === 'critical' && r.score > cfg.critThreshold) {
            status = 'critical';
          } else if (status !== 'critical') {
            status = 'warning';
          }
        }
      }

      // Short description from top result
      const topLabel = top.label.length > 60 ? top.label.slice(0, 57) + '...' : top.label;

      return {
        timestamp: start,
        source: 'local',
        status,
        confidence: top.score,
        issues,
        description: `${topLabel} (${Math.round(top.score * 100)}%)`,
        durationMs: Date.now() - start,
        classificationScores: groupScores,
        labelScores: results.map(r => ({ label: r.label, score: r.score })),
      };
    } catch (err) {
      const msg = (err as Error).message;
      log.warn(`Analysis failed: ${msg}`);
      return {
        timestamp: start,
        source: 'local',
        status: 'ok',
        confidence: 0,
        issues: [],
        description: `Local model error: ${msg.slice(0, 100)}`,
        durationMs: Date.now() - start,
      };
    }
  }

  reset(): void {
    // CLIP is stateless per-frame, nothing to reset
  }
}

// ---- VLM Analyzer ----

async function analyzeWithVlm(
  jpeg: Buffer,
  config: ServiceConfig,
): Promise<AIAnalysis> {
  const start = Date.now();
  const base64 = jpeg.toString('base64');
  const isOllama = config.aiVlmProvider === 'ollama';

  try {
    // Build request body — Ollama and OpenAI use different image formats
    const body = isOllama ? {
      model: config.aiVlmModel,
      messages: [
        { role: 'system', content: VLM_SYSTEM_PROMPT },
        { role: 'user', content: VLM_USER_PROMPT, images: [base64] },
      ],
      stream: false,
      options: { temperature: 0.1 },
    } : {
      model: config.aiVlmModel,
      messages: [
        { role: 'system', content: VLM_SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: VLM_USER_PROMPT },
            {
              type: 'image_url',
              image_url: {
                url: `data:image/jpeg;base64,${base64}`,
                detail: 'low',
              },
            },
          ],
        },
      ],
      max_tokens: 500,
      temperature: 0.1,
    };

    // Build endpoint URL
    const endpoint = isOllama
      ? `${config.aiVlmBaseUrl}/api/chat`
      : `${config.aiVlmBaseUrl}/chat/completions`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (config.aiVlmApiKey) {
      headers['Authorization'] = `Bearer ${config.aiVlmApiKey}`;
    }

    const controller = new AbortController();
    // Ollama can be slow, especially on first request (model loading) — 120s timeout
    const timeoutMs = isOllama ? 120_000 : 30_000;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`VLM API ${res.status}: ${errText.slice(0, 200)}`);
    }

    const data = await res.json() as Record<string, unknown>;

    // Extract content — Ollama uses data.message.content, OpenAI uses data.choices[0].message.content
    let content: string;
    if (isOllama) {
      const msg = data.message as { content?: string } | undefined;
      content = msg?.content ?? '';
    } else {
      const choices = data.choices as Array<{ message?: { content?: string } }> | undefined;
      content = choices?.[0]?.message?.content ?? '';
    }

    // Extract JSON from response (may have markdown fences)
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error(`VLM returned non-JSON: ${content.slice(0, 200)}`);
    }

    const parsed = JSON.parse(jsonMatch[0]) as {
      status?: string;
      confidence?: number;
      issues?: AIIssue[];
      description?: string;
    };

    return {
      timestamp: start,
      source: 'vlm',
      status: (parsed.status as 'ok' | 'warning' | 'critical') || 'ok',
      confidence: parsed.confidence ?? 0.5,
      issues: parsed.issues ?? [],
      description: parsed.description ?? content.slice(0, 200),
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const msg = (err as Error).message;
    log.warn(`VLM analysis failed: ${msg}`);
    return {
      timestamp: start,
      source: 'vlm',
      status: 'ok',
      confidence: 0,
      issues: [],
      description: `VLM error: ${msg.slice(0, 100)}`,
      durationMs: Date.now() - start,
    };
  }
}

// ---- Main Monitor ----

const MAX_HISTORY = 100;

export class AIMonitor extends EventEmitter {
  private analysisHistory: AIAnalysis[] = [];
  private localAnalyzer: LocalAnalyzer;
  private motionDetector = new MotionDetector();
  private timer: ReturnType<typeof setInterval> | null = null;
  private isPrinting = false;
  private consecutiveWarnings = 0;
  private consecutiveLowMotion = 0;
  private lastAlertTime = 0;
  private _running = false;
  private labelConfigs: AILabelConfig[] = buildDefaultLabelConfigs();
  private labelConfigPath: string;

  constructor(
    private store: StateStore,
    private config: ServiceConfig,
  ) {
    super();
    this.localAnalyzer = new LocalAnalyzer(config.aiLocalModel);
    this.labelConfigPath = join(config.dataDir, 'ai-labels.json');

    // Listen for print state changes
    store.on('print_event', (event: PrintEvent) => {
      if (event.type === 'print_started') {
        this.onPrintStarted();
      } else if (event.type === 'print_completed' || event.type === 'print_failed') {
        this.onPrintEnded();
      }
    });
  }

  private onPrintStarted(): void {
    log.info('Print started — beginning monitoring');
    this.isPrinting = true;
    this.consecutiveWarnings = 0;
    this.consecutiveLowMotion = 0;
    this.localAnalyzer.reset();
    this.motionDetector.reset();
    this.startAnalysisLoop();
  }

  private onPrintEnded(): void {
    log.info('Print ended — stopping monitoring');
    this.isPrinting = false;
    this.stopAnalysisLoop();
  }

  private startAnalysisLoop(): void {
    if (this.timer) return;
    // Run first analysis after a short delay (let print settle)
    setTimeout(() => this.runAnalysis(), 10_000);
    this.timer = setInterval(() => this.runAnalysis(), this.config.aiIntervalSec * 1000);
  }

  private stopAnalysisLoop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async runAnalysis(): Promise<void> {
    if (!this.isPrinting) return;

    // Skip analysis during warmup/heating/filament change — only analyze when actively printing
    const subStatus = this.store.status?.machine_status?.sub_status ?? 0;
    const currentZone = this.store.zones?.current ?? 'outside';
    if (subStatus !== 2075 || currentZone !== 'print_area') {
      // Reset stall counter so filament changes don't accumulate as stall evidence
      this.consecutiveLowMotion = 0;
      log.debug?.(`Skipping analysis — sub_status ${subStatus}, zone ${currentZone}`);
      return;
    }

    const snapshot = await getSnapshot(this.config);
    if (!snapshot) {
      log.warn('No snapshot available for analysis');
      return;
    }

    // Motion detection (always runs, even if CLIP/VLM disabled)
    const motion = await this.motionDetector.detect(snapshot);

    // Track consecutive low-motion frames for stall detection
    if (motion < MOTION_STALL_THRESHOLD) {
      this.consecutiveLowMotion++;
    } else {
      this.consecutiveLowMotion = 0;
    }

    const results: AIAnalysis[] = [];

    // Run enabled analyzers in parallel
    const promises: Promise<AIAnalysis>[] = [];

    if (this.config.aiLocalEnabled) {
      // Local CLIP is now async
      promises.push(this.localAnalyzer.analyze(snapshot, this.labelConfigs));
    }

    if (this.config.aiVlmEnabled && (this.config.aiVlmApiKey || this.config.aiVlmBaseUrl)) {
      promises.push(analyzeWithVlm(snapshot, this.config));
    }

    const settled = await Promise.allSettled(promises);
    for (const result of settled) {
      if (result.status === 'fulfilled') {
        results.push(result.value);
        this.analysisHistory.push(result.value);
      }
    }

    // Keep history bounded
    while (this.analysisHistory.length > MAX_HISTORY) {
      this.analysisHistory.shift();
    }

    // Broadcast all results to WS clients
    for (const r of results) {
      this.emit('analysis', r);
      const statusIcon = r.status === 'ok' ? '✅' : r.status === 'warning' ? '⚠️' : '🚨';
      log.info(`${r.source}: ${statusIcon} ${r.description} (${r.durationMs}ms)`);
    }

    // Motion-based stall detection: inject a print_stalled issue if motion
    // has been near-zero for several consecutive cycles while printing
    if (this.consecutiveLowMotion >= MOTION_STALL_COUNT && this.isPrinting) {
      const stallResult: AIAnalysis = {
        timestamp: Date.now(),
        source: 'motion',
        status: 'warning',
        confidence: Math.min(0.9, 0.3 + this.consecutiveLowMotion * 0.1),
        issues: [{
          type: 'print_stalled',
          description: `No motion detected for ${this.consecutiveLowMotion} consecutive frames`,
          confidence: Math.min(0.9, 0.3 + this.consecutiveLowMotion * 0.1),
        }],
        description: `Print may be stalled — no motion for ${this.consecutiveLowMotion} frames`,
        durationMs: 0,
      };
      results.push(stallResult);
      this.analysisHistory.push(stallResult);
      this.emit('analysis', stallResult);
      log.info(`motion: ⚠️ ${stallResult.description}`);
    }

    // Emit chart data (motion + classification scores)
    const classScores: Record<string, number> = {};
    for (const g of CLASSIFICATION_GROUPS) classScores[g] = 0;
    // Use local CLIP scores if available, otherwise leave at 0
    const localResult = results.find(r => r.source === 'local');
    if (localResult?.classificationScores) {
      Object.assign(classScores, localResult.classificationScores);
    }
    // Add stall score to Paused/Stopped chart group based on motion detection
    if (this.consecutiveLowMotion >= MOTION_STALL_COUNT) {
      classScores['Paused/Stopped'] = Math.min(100, this.consecutiveLowMotion * 20);
    }
    const chartData: AIChartData = {
      t: Date.now(),
      motion: Math.round(motion * 100) / 100,
      scores: classScores,
    };
    this.emit('ai_chart_data', chartData);

    // Determine worst status from this round
    const worstStatus = results.reduce<'ok' | 'warning' | 'critical'>((worst, r) => {
      if (r.status === 'critical') return 'critical';
      if (r.status === 'warning' && worst !== 'critical') return 'warning';
      return worst;
    }, 'ok');

    // Track consecutive warnings/criticals
    if (worstStatus === 'critical') {
      this.consecutiveWarnings += 2; // Critical counts double
    } else if (worstStatus === 'warning') {
      this.consecutiveWarnings++;
    } else {
      this.consecutiveWarnings = Math.max(0, this.consecutiveWarnings - 1); // Decay
    }

    // Check if alert threshold reached
    if (this.consecutiveWarnings >= this.config.aiAlertThreshold) {
      const now = Date.now();
      const cooldown = this.config.aiAlertCooldownSec * 1000;
      if (now - this.lastAlertTime > cooldown) {
        this.lastAlertTime = now;
        const allIssues = results.flatMap(r => r.issues);
        const alert: AIAlert = {
          timestamp: now,
          status: worstStatus === 'ok' ? 'warning' : worstStatus,
          issues: allIssues,
          description: results.map(r => r.description).join(' | '),
          consecutiveWarnings: this.consecutiveWarnings,
        };
        log.info(`🚨 ALERT: ${alert.description}`);
        this.emit('alert', alert);
      }
    }
  }

  /** Get recent analysis history */
  getHistory(): AIAnalysis[] {
    return this.analysisHistory;
  }

  /** Get latest analysis per source */
  getLatest(): Record<string, AIAnalysis> {
    const latest: Record<string, AIAnalysis> = {};
    for (let i = this.analysisHistory.length - 1; i >= 0; i--) {
      const a = this.analysisHistory[i];
      if (!latest[a.source]) latest[a.source] = a;
      if (Object.keys(latest).length >= 2) break;
    }
    return latest;
  }

  get isRunning(): boolean { return this._running; }
  get monitoring(): boolean { return this.isPrinting && this.timer !== null; }

  /** Config summary for UI display */
  getConfigSummary(): Record<string, unknown> {
    return {
      vlmEnabled: this.config.aiVlmEnabled,
      vlmModel: this.config.aiVlmModel,
      vlmProvider: this.config.aiVlmProvider,
      vlmBaseUrl: this.config.aiVlmBaseUrl,
      localEnabled: this.config.aiLocalEnabled,
      localModel: this.config.aiLocalModel,
      localReady: this.localAnalyzer.ready,
      intervalSec: this.config.aiIntervalSec,
      alertThreshold: this.config.aiAlertThreshold,
      alertCooldownSec: this.config.aiAlertCooldownSec,
      analysisCount: this.analysisHistory.length,
      consecutiveWarnings: this.consecutiveWarnings,
    };
  }

  /** Get current label configs */
  getLabelConfigs(): AILabelConfig[] {
    return this.labelConfigs;
  }

  /** Update label configs and persist to disk */
  async setLabelConfigs(configs: AILabelConfig[]): Promise<void> {
    this.labelConfigs = configs;
    await this.saveLabelConfigs();
  }

  /** Reset label configs to defaults */
  async resetLabelConfigs(): Promise<void> {
    this.labelConfigs = buildDefaultLabelConfigs();
    await this.saveLabelConfigs();
  }

  /** Load label configs from disk (called during start) */
  async loadLabelConfigs(): Promise<void> {
    try {
      const raw = await readFile(this.labelConfigPath, 'utf-8');
      const parsed = JSON.parse(raw) as AILabelConfig[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        // Migrate old configs without group field
        for (const lc of parsed) {
          if (!lc.group) {
            lc.group = categorizeLabel(lc.label);
          }
        }
        this.labelConfigs = parsed;
        log.info(`Loaded ${parsed.length} label configs from ${this.labelConfigPath}`);
      }
    } catch {
      // File doesn't exist — use defaults
      log.info('No saved label configs found, using defaults');
    }
  }

  private async saveLabelConfigs(): Promise<void> {
    try {
      await mkdir(dirname(this.labelConfigPath), { recursive: true });
      await writeFile(this.labelConfigPath, JSON.stringify(this.labelConfigs, null, 2), 'utf-8');
      log.info(`Label configs saved to ${this.labelConfigPath}`);
    } catch (err) {
      log.error('Failed to save label configs:', (err as Error).message);
    }
  }

  async start(): Promise<void> {
    this._running = true;
    log.info('Monitor started');
    log.info(`VLM: ${this.config.aiVlmEnabled ? `${this.config.aiVlmModel} @ ${this.config.aiVlmBaseUrl} (${this.config.aiVlmProvider})` : 'disabled'}`);
    log.info(`Local: ${this.config.aiLocalEnabled ? this.config.aiLocalModel : 'disabled'}`);
    log.info(`Interval: ${this.config.aiIntervalSec}s, Alert threshold: ${this.config.aiAlertThreshold}`);

    // Load persisted label configs
    await this.loadLabelConfigs();

    // Pre-load CLIP model in background (takes a few seconds on first run)
    if (this.config.aiLocalEnabled) {
      this.localAnalyzer.initialize().catch(err => {
        log.error('Failed to initialize CLIP:', (err as Error).message);
      });
    }

    // If printer is already printing when we start, begin monitoring
    const ms = this.store.status?.machine_status?.status;
    if (ms === 2) {
      this.onPrintStarted();
    }
  }

  stop(): void {
    this._running = false;
    this.stopAnalysisLoop();
  }
}
