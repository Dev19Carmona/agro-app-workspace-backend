import { model, Types } from 'mongoose';
import { PaymentAttemptSchema } from '../schemas/payment-attempt.schema.js';
import { PaymentSchema } from '../schemas/payment.schema.js';
import { PaymentProcessedEventSchema } from '../schemas/processed-event.schema.js';

type Indice = [Record<string, number>, Record<string, unknown>];
const indices = (schema: { indexes(): unknown[] }) =>
  schema.indexes() as Indice[];

const PaymentModel = model('PaymentSpec', PaymentSchema);
const AttemptModel = model('PaymentAttemptSpec', PaymentAttemptSchema);

const oid = () => new Types.ObjectId();
const valido = () => ({
  orderId: oid(),
  buyerId: oid(),
  monto: 1000,
  metodo: 'CARD',
  idempotencyKey: 'clave-0001',
  requestHash: 'h'.repeat(64),
});

describe('referencias ObjectId', () => {
  // Con `type: Types.ObjectId` Mongoose las trata como Mixed y guarda strings.
  it.each([
    [PaymentSchema, 'orderId'],
    [PaymentSchema, 'buyerId'],
    [PaymentAttemptSchema, 'paymentId'],
    [PaymentAttemptSchema, 'orderId'],
    [PaymentAttemptSchema, 'buyerId'],
  ] as const)('%s.%s es un ObjectId, no Mixed', (schema, campo) => {
    const tipo = (schema as { path(p: string): { instance: string } }).path(
      campo,
    );
    expect(tipo.instance).toBe('ObjectId');
  });

  it('castea un id en string a ObjectId al crear', () => {
    const doc = new AttemptModel({ paymentId: oid().toString() });
    expect(doc.paymentId).toBeInstanceOf(Types.ObjectId);
  });
});

describe('defaults y validación', () => {
  it('Payment nace PENDING, en COP y con eventAttempts 0', () => {
    const doc = new PaymentModel(valido());
    expect(doc.status).toBe('PENDING');
    expect(doc.moneda).toBe('COP');
    expect(doc.eventAttempts).toBe(0);
    expect(doc.eventEmittedAt).toBeUndefined();
    expect(doc.finalizedAt).toBeUndefined();
    expect(doc.validateSync()).toBeUndefined();
  });

  it.each([
    'idempotencyKey',
    'requestHash',
    'metodo',
    'monto',
    'orderId',
    'buyerId',
  ])('Payment exige %s', (campo) => {
    const datos: Record<string, unknown> = valido();
    delete datos[campo];
    expect(new PaymentModel(datos).validateSync()?.errors[campo]).toBeDefined();
  });

  it('rechaza un metodo o un status desconocido', () => {
    expect(
      new PaymentModel({ ...valido(), metodo: 'EFECTIVO' }).validateSync()
        ?.errors.metodo,
    ).toBeDefined();
    expect(
      new PaymentModel({ ...valido(), status: 'OTRO' }).validateSync()?.errors
        .status,
    ).toBeDefined();
  });

  it('PaymentAttempt valida origen y resultado; no guarda token ni updatedAt', () => {
    const base = { paymentId: oid(), orderId: oid(), buyerId: oid() };
    expect(
      new AttemptModel({
        ...base,
        origen: 'WEBHOOK',
        resultado: 'APPROVED',
      }).validateSync(),
    ).toBeUndefined();
    expect(
      new AttemptModel({
        ...base,
        origen: 'X',
        resultado: 'APPROVED',
      }).validateSync()?.errors.origen,
    ).toBeDefined();
    expect(PaymentAttemptSchema.path('updatedAt')).toBeUndefined();
    expect(PaymentAttemptSchema.path('token')).toBeUndefined();
    expect(PaymentSchema.path('token')).toBeUndefined();
  });
});

describe('índices', () => {
  it.each([
    ['payments', PaymentSchema, { buyerId: 1, idempotencyKey: 1 }, true],
    ['payments', PaymentSchema, { buyerId: 1, createdAt: -1 }, false],
    ['payments', PaymentSchema, { status: 1, createdAt: -1 }, false],
    [
      'payments',
      PaymentSchema,
      { status: 1, eventEmittedAt: 1, finalizedAt: 1 },
      false,
    ],
    [
      'payment_attempts',
      PaymentAttemptSchema,
      { paymentId: 1, createdAt: 1 },
      false,
    ],
    [
      'payment_processed_events',
      PaymentProcessedEventSchema,
      { eventId: 1 },
      true,
    ],
  ] as const)(
    '%s tiene el índice %j (único: %s)',
    (_coleccion, schema, campos, unico) => {
      expect(indices(schema)).toContainEqual([
        campos,
        expect.objectContaining(unico ? { unique: true } : {}),
      ]);
    },
  );

  it('payments tiene un índice único parcial sobre orderId para PENDING, PROCESSING y APPROVED', () => {
    expect(indices(PaymentSchema)).toContainEqual([
      { orderId: 1 },
      expect.objectContaining({
        unique: true,
        partialFilterExpression: {
          status: { $in: ['PENDING', 'PROCESSING', 'APPROVED'] },
        },
      }),
    ]);
  });
});
