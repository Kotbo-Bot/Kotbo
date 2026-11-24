import { describe, expect, test } from 'bun:test';
import { executorAuditUser, executorTag } from '../../utils/logExecutor';

describe('auteur d\'un log', () => {
  test('avec son identifiant, le journal le garde à côté du pseudo pour rendre l\'auteur cliquable', () => {
    expect(executorAuditUser({ tag: 'klaynight', id: '123456789012345678' })).toBe('klaynight (<@123456789012345678>)');
  });

  test('un simple pseudo reste tel quel', () => {
    expect(executorAuditUser('staar')).toBe('staar');
  });

  test('sans auteur, c\'est le système', () => {
    expect(executorAuditUser(null)).toBe('Système');
    expect(executorAuditUser(undefined)).toBe('Système');
  });

  test('le pied de page de l\'embed ne montre que le pseudo', () => {
    expect(executorTag({ tag: 'klaynight', id: '123456789012345678' })).toBe('klaynight');
    expect(executorTag('staar')).toBe('staar');
    expect(executorTag(null)).toBe(null);
  });
});
