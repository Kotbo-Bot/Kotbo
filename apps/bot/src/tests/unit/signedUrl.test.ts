import { beforeAll, describe, expect, test } from 'bun:test';
import {
  generateEvidenceFileSignature,
  generateTranscriptSignature,
  verifyEvidenceFileSignature,
  verifyTranscriptSignature,
} from '@kotbo/core';

beforeAll(() => {
  process.env.TRANSCRIPT_SIGNING_SECRET = 'test-signing-secret';
});

describe('liens signés', () => {
  test('une signature valide est acceptée, une altérée refusée', () => {
    const { expires, signature } = generateTranscriptSignature('abc123', 60);
    expect(verifyTranscriptSignature('abc123', String(expires), signature)).toBeTrue();
    expect(verifyTranscriptSignature('autre', String(expires), signature)).toBeFalse();
    expect(verifyTranscriptSignature('abc123', String(expires), `${signature.slice(0, -1)}0`)).toBeFalse();
  });

  test('un lien expiré est refusé', () => {
    const { expires, signature } = generateTranscriptSignature('abc123', -10);
    expect(verifyTranscriptSignature('abc123', String(expires), signature)).toBeFalse();
  });

  test('une signature de même longueur en caractères mais pas en octets refuse sans lever', () => {
    const { expires, signature } = generateTranscriptSignature('abc123', 60);
    const multiByte = `é${signature.slice(1)}`;
    expect(multiByte.length).toBe(signature.length);
    expect(() => verifyTranscriptSignature('abc123', String(expires), multiByte)).not.toThrow();
    expect(verifyTranscriptSignature('abc123', String(expires), multiByte)).toBeFalse();
    expect(verifyEvidenceFileSignature('f1', String(expires), multiByte)).toBeFalse();
  });

  test('une signature de transcription ne vaut pas pour une preuve', () => {
    const { expires, signature } = generateTranscriptSignature('same-id', 60);
    expect(verifyEvidenceFileSignature('same-id', String(expires), signature)).toBeFalse();
    const evidence = generateEvidenceFileSignature('same-id', 60);
    expect(verifyEvidenceFileSignature('same-id', String(evidence.expires), evidence.signature)).toBeTrue();
  });
});
