import { SimulatedGatewayService } from '../services/simulated-gateway.service.js';

const input = (token: string) => ({
  monto: 50000,
  moneda: 'COP' as const,
  metodo: 'CARD' as const,
  token,
});

describe('SimulatedGatewayService', () => {
  const service = new SimulatedGatewayService();

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('no responde antes de 1 s y responde a 1 s con el azar en el mínimo', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    let listo = false;
    const p = service.charge(input('tok_test_approved')).then((r) => {
      listo = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(listo).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await p).resultado).toBe('APPROVED');
  });

  it('con el azar en el máximo responde a los 3 s y no antes', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.999999);
    let listo = false;
    const p = service.charge(input('tok_test_approved')).then((r) => {
      listo = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(2999);
    expect(listo).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(listo).toBe(true);
  });

  it.each([
    ['tok_test_approved', 'APPROVED', undefined],
    ['tok_test_declined', 'DECLINED', 'INSUFFICIENT_FUNDS'],
    ['tok_test_error', 'ERROR', 'GATEWAY_ERROR'],
    ['tok_test_pending', 'PROCESSING', undefined],
    ['tok_desconocido', 'DECLINED', 'INVALID_TOKEN'],
  ])('token %s → %s', async (token, resultado, motivo) => {
    const p = service.charge(input(token));
    await vi.advanceTimersByTimeAsync(3000);
    const r = await p;
    expect(r.resultado).toBe(resultado);
    expect(r.motivo).toBe(motivo);
    expect(r.referencia).toMatch(
      /^SIM-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('no devuelve el token ni la clave motivo cuando no aplica', async () => {
    const p = service.charge(input('tok_test_approved'));
    await vi.advanceTimersByTimeAsync(3000);
    const r = await p;
    expect(Object.keys(r).sort()).toEqual(['referencia', 'resultado']);
  });

  it('cada cobro recibe una referencia distinta', async () => {
    const a = service.charge(input('tok_test_approved'));
    const b = service.charge(input('tok_test_approved'));
    await vi.advanceTimersByTimeAsync(3000);
    expect((await a).referencia).not.toBe((await b).referencia);
  });
});
