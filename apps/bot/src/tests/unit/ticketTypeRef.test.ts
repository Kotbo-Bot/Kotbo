import { describe, expect, test } from 'bun:test';
import { findTicketType } from '../../services/features/workflow/ticketTypeRef';

const types = [
  { id: 'support', label: 'Support' },
  { id: 'type-2', label: 'Convocation' },
];

describe('findTicketType', () => {
  test('trouve un type par son identifiant', () => {
    expect(findTicketType(types, 'type-2')?.label).toBe('Convocation');
  });

  test('trouve un type par son nom, sans tenir compte de la casse ni des espaces', () => {
    expect(findTicketType(types, '  convocation ')?.id).toBe('type-2');
  });

  test('un nom inconnu ne donne rien', () => {
    expect(findTicketType(types, 'Recrutement')).toBe(null);
  });

  test('une référence vide ne donne rien', () => {
    expect(findTicketType(types, '   ')).toBe(null);
  });
});
