import {
  sanitizeForTransport,
  UnsupportedEventTypeError,
} from '../policies/event-sanitizer.policy.js';

describe('event-sanitizer.policy', () => {
  it('provider.approved deja solo userId y reviewedBy', () => {
    expect(
      sanitizeForTransport('provider.approved', {
        userId: 'u1',
        reviewedBy: 'a1',
        email: 'x@y.co',
        otro: 1,
      }),
    ).toEqual({ userId: 'u1', reviewedBy: 'a1' });
  });

  it('descarta email aunque sea el único campo extra', () => {
    const out = sanitizeForTransport('provider.approved', {
      userId: 'u1',
      email: 'x@y.co',
    });
    expect(out).not.toHaveProperty('email');
    expect(out).toEqual({ userId: 'u1' });
  });

  it('rechaza un tipo sin entrada', () => {
    expect(() => sanitizeForTransport('user.registered', { a: 1 })).toThrow(
      UnsupportedEventTypeError,
    );
  });

  it('rechaza nombres heredados de Object.prototype', () => {
    expect(() => sanitizeForTransport('constructor', {})).toThrow(
      UnsupportedEventTypeError,
    );
  });
});
