// Genera un par RSA 2048 para firmar JWT (RS256) e imprime las dos líneas
// listas para pegar en `.env`. No escribe nada en disco.
import { generateKeyPairSync } from 'node:crypto';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const enUnaLinea = (pem) => pem.trim().replace(/\n/g, '\\n');

console.log(`JWT_PRIVATE_KEY="${enUnaLinea(privateKey)}"`);
console.log(`JWT_PUBLIC_KEY="${enUnaLinea(publicKey)}"`);
