import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
} from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Keypair {
  privateKeyPem: string;
  publicKeyPem: string;
}

/**
 * Load Handshake's Ed25519 signing keypair from `dir`, creating it on first run.
 * The public key ships inside every signed report so anyone can verify offline.
 */
export function loadOrCreateKeypair(dir = '.keys'): Keypair {
  const privPath = join(dir, 'handshake-ed25519.pem');
  const pubPath = join(dir, 'handshake-ed25519.pub.pem');
  if (existsSync(privPath) && existsSync(pubPath)) {
    return {
      privateKeyPem: readFileSync(privPath, 'utf8'),
      publicKeyPem: readFileSync(pubPath, 'utf8'),
    };
  }
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  mkdirSync(dir, { recursive: true });
  writeFileSync(privPath, privateKeyPem, { mode: 0o600 });
  writeFileSync(pubPath, publicKeyPem);
  return { privateKeyPem, publicKeyPem };
}

/** Sign a canonical string; returns hex signature. */
export function signPayload(canonical: string, privateKeyPem: string): string {
  const key = createPrivateKey(privateKeyPem);
  return edSign(null, Buffer.from(canonical, 'utf8'), key).toString('hex');
}

/** Verify a hex signature over a canonical string. */
export function verifyPayload(canonical: string, signatureHex: string, publicKeyPem: string): boolean {
  try {
    const key = createPublicKey(publicKeyPem);
    return edVerify(null, Buffer.from(canonical, 'utf8'), key, Buffer.from(signatureHex, 'hex'));
  } catch {
    return false;
  }
}
