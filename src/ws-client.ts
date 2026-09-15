/**
 * WebSocket client — connects to the elegoo-web service instead of
 * directly to the printer's MQTT broker.
 *
 * Provides the same interface as the old CC2MqttClient so the UI
 * modules don't need to change.
 */

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

/** Minimal interface that UI modules need for sending commands */
export interface CommandSender {
  sendCommand(method: number, params: Record<string, unknown>): void;
  readonly printerIp: string;
}

export interface WsClientOptions {
  serviceUrl: string;
  onStateChange: (state: ConnectionState) => void;
  onRegistered: (sn: string, printerIp: string) => void;
  onMessage: (method: number, data: unknown) => void;
  onStatusEvent: (data: unknown) => void;
  onRawMessage?: (direction: 'sent' | 'received', topic: string, data: unknown) => void;
  /** Called with full init snapshot from service */
  onInit?: (data: Record<string, unknown>) => void;
  /** Called with service health status updates */
  onServiceStatus?: (data: Record<string, unknown>) => void;
  /** Called with chart data points from service */
  onChartData?: (t: number, values: Record<string, number>) => void;
  /** Called with AI analysis results */
  onAIAnalysis?: (data: Record<string, unknown>) => void;
  /** Called with AI alerts (threshold reached) */
  onAIAlert?: (data: Record<string, unknown>) => void;
  /** Called with AI chart data (motion + classification scores) */
  onAIChartData?: (t: number, motion: number, scores: Record<string, number>) => void;
  /** Called with event log entries */
  onEventLog?: (entry: { ts: number; event: Record<string, unknown> }) => void;
  /** Called when server records a new layer time */
  onLayerTime?: (entry: { layer: number; duration: number; timestamp: number }) => void;
  /** Called when server clears layer data (new print) */
  onLayerClear?: () => void;
  /** Called with filament usage updates per spool */
  onFilamentUsage?: (
    usage: Array<{
      trayKey: string;
      filamentType: string;
      color: string;
      extruded_mm: number;
      grams: number;
      meters: number;
    }>,
  ) => void;
  /** Called when the service's print queue changes (ELEG-35) */
  onPrintQueue?: (queue: unknown) => void;
  /** Called when toolhead enters a different zone */
  onZoneChange?: (data: {
    from: string;
    to: string;
    x: number;
    y: number;
    timestamp: number;
  }) => void;
}

export class WsClient {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private shouldReconnect = true;
  private _sn = '';
  private _printerIp = '';
  private opts: WsClientOptions;

  constructor(opts: WsClientOptions) {
    this.opts = opts;
  }

  connect(): void {
    this.opts.onStateChange('connecting');

    this.ws = new WebSocket(this.opts.serviceUrl);

    this.ws.onopen = () => {
      this.reconnectDelay = 1000;
      // Don't set 'connected' yet — wait for init message
    };

    this.ws.onmessage = (event) => {
      this.handleMessage(event.data as string);
    };

    this.ws.onerror = () => {
      this.opts.onStateChange('error');
    };

    this.ws.onclose = () => {
      this.opts.onStateChange('disconnected');
      this.scheduleReconnect();
    };
  }

  private handleMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    const type = msg.type as string;

    switch (type) {
      case 'init': {
        // Full state snapshot from service
        this._sn = (msg.sn as string) || '';
        this._printerIp = (msg.printerIp as string) || '';
        const connected = msg.connected as boolean;
        if (connected && this._sn) {
          this.opts.onStateChange('connected');
          this.opts.onRegistered(this._sn, this._printerIp);
        }
        this.opts.onInit?.(msg);
        break;
      }

      case 'connection': {
        const connected = msg.connected as boolean;
        if (connected) {
          this._sn = (msg.sn as string) || this._sn;
          this.opts.onStateChange('connected');
          this.opts.onRegistered(this._sn, this._printerIp);
        } else {
          this.opts.onStateChange('disconnected');
        }
        break;
      }

      case 'response': {
        const method = msg.method as number;
        const data = msg.data as unknown;
        this.opts.onMessage(method, data);
        break;
      }

      case 'status': {
        const data = msg.data as unknown;
        this.opts.onStatusEvent(data);
        break;
      }

      case 'raw': {
        const direction = msg.direction as 'sent' | 'received';
        const topic = msg.topic as string;
        const data = msg.data as unknown;
        this.opts.onRawMessage?.(direction, topic, data);
        break;
      }

      case 'service_status': {
        this.opts.onServiceStatus?.(msg);
        break;
      }

      case 'chart_data': {
        const t = msg.t as number;
        const values = msg.values as Record<string, number>;
        if (t && values) {
          this.opts.onChartData?.(t, values);
        }
        break;
      }

      case 'ai_analysis': {
        this.opts.onAIAnalysis?.(msg);
        break;
      }

      case 'ai_alert': {
        this.opts.onAIAlert?.(msg);
        break;
      }

      case 'ai_chart_data': {
        const t = msg.t as number;
        const motion = msg.motion as number;
        const scores = msg.scores as Record<string, number>;
        if (t && scores) {
          this.opts.onAIChartData?.(t, motion ?? 0, scores);
        }
        break;
      }

      case 'event_log': {
        const ts = msg.ts as number;
        const event = msg.event as Record<string, unknown>;
        if (ts && event) {
          this.opts.onEventLog?.({ ts, event });
        }
        break;
      }

      case 'layer_time': {
        const layer = msg.layer as number;
        const duration = msg.duration as number;
        const timestamp = msg.timestamp as number;
        if (layer != null && duration != null && timestamp) {
          this.opts.onLayerTime?.({ layer, duration, timestamp });
        }
        break;
      }

      case 'layer_clear': {
        this.opts.onLayerClear?.();
        break;
      }

      case 'filament_usage': {
        const usage = msg.usage as Array<{
          trayKey: string;
          filamentType: string;
          color: string;
          extruded_mm: number;
          grams: number;
          meters: number;
        }>;
        if (Array.isArray(usage)) {
          this.opts.onFilamentUsage?.(usage);
        }
        break;
      }

      case 'print_queue': {
        this.opts.onPrintQueue?.(msg.queue);
        break;
      }

      case 'zone_change': {
        this.opts.onZoneChange?.(
          msg as unknown as { from: string; to: string; x: number; y: number; timestamp: number },
        );
        break;
      }
    }
  }

  sendCommand(method: number, params: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: 'command', method, params }));
  }

  disconnect(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return;
    if (this.reconnectTimer) return;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.shouldReconnect) return;
      this.connect();
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
    }, this.reconnectDelay);
  }

  get serialNumber(): string {
    return this._sn;
  }
  get printerIp(): string {
    return this._printerIp;
  }
}
