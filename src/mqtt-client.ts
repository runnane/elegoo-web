import mqtt from 'mqtt';

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface MqttClientOptions {
  printerIp: string;
  password: string;
  onStateChange: (state: ConnectionState) => void;
  onRegistered: (sn: string) => void;
  onMessage: (method: number, data: unknown) => void;
  onStatusEvent: (data: unknown) => void;
}

export class CC2MqttClient {
  private client: mqtt.MqttClient | null = null;
  private clientId: string;
  private requestId: string;
  private sn = '';
  private commandId = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private opts: MqttClientOptions;

  constructor(opts: MqttClientOptions) {
    this.opts = opts;
    this.clientId = this.generateClientId();
    this.requestId = this.generateRequestId();
  }

  private generateClientId(): string {
    const tsHex = Math.floor(Date.now()).toString(16).slice(-5);
    const rndHex = Math.floor(Math.random() * 4096).toString(16);
    return `0cli${tsHex}${rndHex}`.slice(0, 10);
  }

  private generateRequestId(): string {
    const uuid = Array.from({ length: 16 }, () =>
      Math.floor(Math.random() * 16).toString(16)
    ).join('');
    const tsHex = Date.now().toString(16);
    return `${uuid}${tsHex}`;
  }

  async discover(): Promise<string> {
    // Discovery is UDP — can't do from browser.
    // We do a direct MQTT connect and get SN from attributes.
    return '';
  }

  connect(): void {
    const { printerIp, password } = this.opts;
    this.opts.onStateChange('connecting');

    const url = `ws://${printerIp}:9001`;
    this.client = mqtt.connect(url, {
      clientId: this.clientId,
      username: 'elegoo',
      password,
      keepalive: 60,
      clean: true,
      reconnectPeriod: 5000,
      protocolVersion: 4, // MQTT 3.1.1
    });

    this.client.on('connect', () => {
      this.opts.onStateChange('connected');
      // We don't know SN yet — subscribe to wildcard to discover it
      this.client!.subscribe('elegoo/+/api_status');
      // Also try registration if we already know the SN
      if (this.sn) {
        this.register();
      }
    });

    this.client.on('message', (topic: string, payload: Buffer) => {
      this.handleMessage(topic, payload);
    });

    this.client.on('error', () => {
      this.opts.onStateChange('error');
    });

    this.client.on('close', () => {
      this.stopHeartbeat();
      this.opts.onStateChange('disconnected');
    });
  }

  private handleMessage(topic: string, payload: Buffer): void {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(payload.toString());
    } catch {
      return;
    }

    // Discover SN from status topic
    if (topic.includes('/api_status') && !this.sn) {
      const parts = topic.split('/');
      if (parts.length >= 3) {
        this.sn = parts[1];
        // Now register properly
        this.client!.unsubscribe('elegoo/+/api_status');
        this.register();
      }
    }

    if (topic.includes('/register_response')) {
      const error = data.error as string;
      if (error === 'ok') {
        this.opts.onRegistered(this.sn);
        this.subscribeAll();
        this.startHeartbeat();
        // Request initial data
        this.sendCommand(1001, {}); // GET_ATTRIBUTES
        this.sendCommand(1002, {}); // GET_STATUS
        this.sendCommand(2005, {}); // GET_CANVAS_STATUS
      }
    } else if (topic.includes('/api_response')) {
      const method = data.method as number;
      this.opts.onMessage(method, data);
    } else if (topic.includes('/api_status')) {
      this.opts.onStatusEvent(data);
    }
  }

  private register(): void {
    if (!this.client || !this.sn) return;
    this.client.subscribe(`elegoo/${this.sn}/${this.requestId}/register_response`);
    this.client.publish(
      `elegoo/${this.sn}/api_register`,
      JSON.stringify({ client_id: this.clientId, request_id: this.requestId })
    );
  }

  private subscribeAll(): void {
    if (!this.client || !this.sn) return;
    this.client.subscribe(`elegoo/${this.sn}/api_status`);
    this.client.subscribe(`elegoo/${this.sn}/${this.clientId}/api_response`);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.client && this.sn) {
        this.client.publish(
          `elegoo/${this.sn}/${this.clientId}/api_request`,
          JSON.stringify({ type: 'PING' })
        );
      }
    }, 10_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  sendCommand(method: number, params: Record<string, unknown>): void {
    if (!this.client || !this.sn) return;
    this.commandId++;
    this.client.publish(
      `elegoo/${this.sn}/${this.clientId}/api_request`,
      JSON.stringify({ id: this.commandId, method, params })
    );
  }

  disconnect(): void {
    this.stopHeartbeat();
    if (this.client) {
      this.client.end();
      this.client = null;
    }
    this.sn = '';
  }

  get serialNumber(): string {
    return this.sn;
  }

  get printerIp(): string {
    return this.opts.printerIp;
  }
}
