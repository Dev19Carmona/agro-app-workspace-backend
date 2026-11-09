import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { HttpNotificationsReader } from '../services/http-notifications-reader.service.js';

const TOKEN = 's'.repeat(32);
const USER = '64b7f0c2a1b2c3d4e5f60718';
const STORE = '64b7f0c2a1b2c3d4e5f60719';
const ID = '64b7f0c2a1b2c3d4e5f60700';

const view = {
  id: ID,
  plantilla: 'PAYMENT_APPROVED',
  destinatarioTipo: 'USER',
  titulo: 'Pago aprobado',
  mensaje: 'Tu pago fue aprobado',
  orderId: '64b7f0c2a1b2c3d4e5f60711',
  sentAt: '2026-11-09T10:00:00.000Z',
  readAt: null,
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

describe('HttpNotificationsReader', () => {
  const fetchMock = vi.fn();
  const config = {
    get: (key: string) =>
      key === 'INTERNAL_SERVICE_TOKEN' ? TOKEN : 'http://notifications:3005/',
  };
  let reader: HttpNotificationsReader;
  let warn: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    reader = new HttpNotificationsReader(config as never);
    warn = vi.spyOn(reader['logger'], 'warn').mockImplementation(() => {});
    error = vi.spyOn(reader['logger'], 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const lastCall = () => {
    const [url, init] = fetchMock.mock.calls[0];
    return { url: new URL(url as string), init: init as RequestInit };
  };

  describe('éxito', () => {
    it('list: GET con token de servicio, query y timeout', async () => {
      fetchMock.mockResolvedValue(json({ data: [view], nextCursor: ID }));

      const page = await reader.list(
        { userId: USER, storeId: STORE },
        { limit: 5, cursor: ID },
      );

      expect(page).toEqual({ data: [view], nextCursor: ID });
      const { url, init } = lastCall();
      expect(url.origin + url.pathname).toBe(
        'http://notifications:3005/internal/notifications',
      );
      expect(Object.fromEntries(url.searchParams)).toEqual({
        userId: USER,
        storeId: STORE,
        limit: '5',
        cursor: ID,
      });
      expect(init.method).toBe('GET');
      expect(init.headers).toMatchObject({ 'X-Service-Token': TOKEN });
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it('list omite storeId y cursor si no vienen', async () => {
      fetchMock.mockResolvedValue(json({ data: [], nextCursor: null }));

      await reader.list({ userId: USER }, { limit: 20 });

      expect(Object.fromEntries(lastCall().url.searchParams)).toEqual({
        userId: USER,
        limit: '20',
      });
    });

    it('unreadCount: GET /unread-count', async () => {
      fetchMock.mockResolvedValue(json({ count: 3 }));

      expect(await reader.unreadCount({ userId: USER })).toEqual({ count: 3 });
      expect(lastCall().url.pathname).toBe(
        '/internal/notifications/unread-count',
      );
    });

    it('markRead: PATCH /:id/read con el actor en el body', async () => {
      fetchMock.mockResolvedValue(json(view));

      expect(await reader.markRead({ userId: USER }, ID)).toEqual(view);
      const { url, init } = lastCall();
      expect(url.pathname).toBe(`/internal/notifications/${ID}/read`);
      expect(init.method).toBe('PATCH');
      expect(JSON.parse(init.body as string)).toEqual({ userId: USER });
      expect(init.headers).toMatchObject({
        'Content-Type': 'application/json',
      });
    });

    it('markAllRead: POST /read-all', async () => {
      fetchMock.mockResolvedValue(json({ updated: 4 }));

      expect(await reader.markAllRead({ userId: USER })).toEqual({
        updated: 4,
      });
      expect(lastCall().url.pathname).toBe('/internal/notifications/read-all');
      expect(lastCall().init.method).toBe('POST');
    });

    it('descarta los campos de más que trae notifications', async () => {
      fetchMock.mockResolvedValue(
        json({
          data: [
            {
              ...view,
              eventId: 'evt',
              eventType: 'payment.approved',
              correlationId: 'c',
              destinatarioId: USER,
              canal: 'SIMULATED',
            },
          ],
          nextCursor: null,
          extra: true,
        }),
      );

      const page = await reader.list({ userId: USER }, { limit: 20 });

      expect(page).toEqual({ data: [view], nextCursor: null });
      for (const campo of [
        'eventId',
        'eventType',
        'correlationId',
        'destinatarioId',
        'canal',
      ]) {
        expect(page.data[0]).not.toHaveProperty(campo);
      }
    });
  });

  describe('errores', () => {
    const casos = async () => {
      await expect(
        reader.list({ userId: USER }, { limit: 20 }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    };

    it('timeout: 503 con warn', async () => {
      fetchMock.mockRejectedValue(new DOMException('timeout', 'TimeoutError'));

      await casos();

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('timeout'));
    });

    it('conexión rechazada: 503 con warn', async () => {
      fetchMock.mockRejectedValue(new TypeError('fetch failed'));

      await casos();

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('conexión'));
    });

    it('el mensaje del 503 es el acordado', async () => {
      fetchMock.mockRejectedValue(new TypeError('fetch failed'));

      await expect(
        reader.list({ userId: USER }, { limit: 20 }),
      ).rejects.toThrow('Servicio de notificaciones no disponible');
    });

    it('401 de notifications: 503 con error sin el token', async () => {
      fetchMock.mockResolvedValue(json({}, 401));

      await casos();

      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('token de servicio rechazado'),
      );
      expect(JSON.stringify(error.mock.calls)).not.toContain(TOKEN);
    });

    it('404 de notifications: 404 sin registro', async () => {
      fetchMock.mockResolvedValue(json({}, 404));

      await expect(
        reader.markRead({ userId: USER }, ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    });

    it('5xx: 503 con warn y el estado', async () => {
      fetchMock.mockResolvedValue(json({}, 502));

      await casos();

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('502'));
    });

    it('400: 503 con error y el estado, sin cuerpo', async () => {
      fetchMock.mockResolvedValue(json({ message: 'secreto-del-cuerpo' }, 400));

      await casos();

      expect(error).toHaveBeenCalledWith(expect.stringContaining('400'));
      expect(JSON.stringify(error.mock.calls)).not.toContain(
        'secreto-del-cuerpo',
      );
    });

    it('cuerpo con otra forma: 503 con error', async () => {
      fetchMock.mockResolvedValue(json({ data: 'nada' }));

      await casos();

      expect(error).toHaveBeenCalled();
    });

    it('cuerpo que no es JSON: 503', async () => {
      fetchMock.mockResolvedValue(new Response('<html>', { status: 200 }));

      await casos();
    });

    it('nunca registra el token ni el actor', async () => {
      fetchMock.mockRejectedValue(new TypeError('fetch failed'));

      await casos();

      const registro = JSON.stringify([warn.mock.calls, error.mock.calls]);
      expect(registro).not.toContain(TOKEN);
      expect(registro).not.toContain(USER);
    });
  });
});
