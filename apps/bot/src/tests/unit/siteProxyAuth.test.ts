import { describe, expect, test } from 'bun:test';
import { isTrustedSiteProxy } from '../../services/site/siteProxyAuth.js';

describe('isTrustedSiteProxy', () => {
  test('sans secret configuré, le contrôle est désactivé', () => {
    expect(isTrustedSiteProxy(undefined, undefined)).toBeTrue();
    expect(isTrustedSiteProxy('quelconque', '')).toBeTrue();
    expect(isTrustedSiteProxy(null, '   ')).toBeTrue();
  });

  test('avec un secret configuré, seul le bon secret passe', () => {
    expect(isTrustedSiteProxy('s3cret', 's3cret')).toBeTrue();
    expect(isTrustedSiteProxy(' s3cret ', 's3cret')).toBeTrue();
    expect(isTrustedSiteProxy('autre!', 's3cret')).toBeFalse();
    expect(isTrustedSiteProxy('s3cre', 's3cret')).toBeFalse();
    expect(isTrustedSiteProxy(undefined, 's3cret')).toBeFalse();
    expect(isTrustedSiteProxy('', 's3cret')).toBeFalse();
  });

  test('un secret multi-octets de même longueur en caractères refuse sans lever', () => {
    expect(() => isTrustedSiteProxy('sécret', 'secret')).not.toThrow();
    expect(isTrustedSiteProxy('sécret', 'secret')).toBeFalse();
  });
});
