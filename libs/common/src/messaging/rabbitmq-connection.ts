import { Logger } from '@nestjs/common';
import { connect } from 'amqplib';
import type { ChannelModel, ConfirmChannel } from 'amqplib';

export const RECONNECT_DELAY_MS = 5000;

/** Se llama cada vez que hay un canal listo (la primera conexión y cada reconexión). */
export type OnConnect = (channel: ConfirmChannel) => Promise<void> | void;

/**
 * Conexión a RabbitMQ con un canal de confirmaciones y reconexión automática.
 * Es lo único del workspace que importa `amqplib`.
 *
 * `start()` nunca lanza: con el broker caído la app arranca igual y se reintenta cada 5 s.
 * Los logs llevan solo el mensaje del error, nunca la URI.
 */
export class RabbitMqConnection {
  private readonly logger = new Logger(RabbitMqConnection.name);
  private readonly listeners: OnConnect[] = [];
  private current?: ChannelModel;
  private channel?: ConfirmChannel;
  private timer?: NodeJS.Timeout;
  private closing = false;

  constructor(
    private readonly uri: string,
    private readonly retryDelayMs = RECONNECT_DELAY_MS,
  ) {}

  /** Registra qué hacer con cada canal nuevo (declarar topología, suscribirse...). */
  onConnect(listener: OnConnect): void {
    this.listeners.push(listener);
  }

  isConnected(): boolean {
    return this.channel !== undefined;
  }

  getChannel(): ConfirmChannel {
    if (!this.channel) {
      throw new Error('RabbitMQ no está conectado');
    }
    return this.channel;
  }

  async start(): Promise<void> {
    this.closing = false;
    await this.connectOnce();
  }

  async close(): Promise<void> {
    this.closing = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    const connection = this.current;
    this.current = undefined;
    this.channel = undefined;
    try {
      await connection?.close();
    } catch {
      // ya estaba cerrada
    }
  }

  private async connectOnce(): Promise<void> {
    let connection: ChannelModel | undefined;
    try {
      connection = await connect(this.uri);
      this.current = connection;
      connection.on('error', (err: Error) => {
        this.logger.warn(`Error de conexión con RabbitMQ: ${err.message}`);
      });
      connection.on('close', () => this.handleClose(connection!));

      const channel = await connection.createConfirmChannel();
      channel.on('error', (err: Error) => {
        this.logger.warn(`Error de canal de RabbitMQ: ${err.message}`);
      });
      channel.on('close', () => this.handleClose(connection!));

      this.channel = channel;
      for (const listener of this.listeners) {
        await listener(channel);
      }
      this.logger.log('Conectado a RabbitMQ');
    } catch (err) {
      this.logger.warn(
        `No se pudo conectar a RabbitMQ: ${(err as Error).message}`,
      );
      // Se ignora el 'close' de esta conexión: el reintento lo programamos aquí.
      this.current = undefined;
      this.channel = undefined;
      try {
        await connection?.close();
      } catch {
        // ya estaba cerrada
      }
      this.scheduleReconnect();
    }
  }

  private handleClose(connection: ChannelModel): void {
    if (this.current !== connection) {
      return; // evento de una conexión que ya descartamos
    }
    this.current = undefined;
    this.channel = undefined;
    if (!this.closing) {
      this.logger.warn('Conexión con RabbitMQ cerrada; se reintentará');
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.closing || this.timer) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.connectOnce();
    }, this.retryDelayMs);
  }
}
