import { describe, expect, it } from 'vitest';
import {
  CUSTOM_ID_ACTIONS,
  CUSTOM_ID_MAX,
  CUSTOM_ID_SPECS,
  buildCustomId,
  parseCustomId,
  type CustomIdAction,
  type CustomIdSpec,
} from '../src/discord/commands/custom-id.js';

// custom_id versionado de botones/selects/modales: ida y vuelta, topes de Discord y rechazo de lo que
// no salió de roz (cualquiera puede mandar un custom_id inventado).

const UUID = '33333333-3333-4333-8333-333333333333';
const SNOW = '400000000000000002';
const SNOW2 = '500000000000000099';

function sampleArgs(action: CustomIdAction): string[] {
  const spec: CustomIdSpec = CUSTOM_ID_SPECS[action];
  // Snowflakes de 25 dígitos: el caso más largo que acepta el formato.
  return spec.args.map((k) => (k === 'snowflake' ? '9'.repeat(25) : UUID));
}

describe('custom_id', () => {
  it('ida y vuelta de cada acción, siempre ≤ 100 caracteres', () => {
    for (const action of CUSTOM_ID_ACTIONS) {
      const args = sampleArgs(action);
      const id = buildCustomId(action, ...args);
      expect(id.length).toBeLessThanOrEqual(CUSTOM_ID_MAX);
      expect(id.startsWith(`roz1:${action}`)).toBe(true);
      expect(parseCustomId(id)).toEqual({ ok: true, id: { action, args } });
    }
  });

  it('formato exacto', () => {
    expect(buildCustomId('tarea.tomar', UUID)).toBe(`roz1:tarea.tomar:${UUID}`);
    expect(buildCustomId('msg.tarea.modal', SNOW, SNOW2)).toBe(`roz1:msg.tarea.modal:${SNOW}:${SNOW2}`);
    expect(buildCustomId('status.elegir')).toBe('roz1:status.elegir');
  });

  it('`_` = sin valor en los args opcionales', () => {
    expect(buildCustomId('ticket.modal', null)).toBe('roz1:ticket.modal:_');
    expect(parseCustomId('roz1:ticket.modal:_')).toEqual({ ok: true, id: { action: 'ticket.modal', args: [null] } });
    expect(parseCustomId(`roz1:junta.modal:${UUID}`)).toEqual({ ok: true, id: { action: 'junta.modal', args: [UUID] } });
  });

  it('el uuid se normaliza a minúsculas', () => {
    expect(buildCustomId('plan.aprobar', UUID.toUpperCase())).toBe(`roz1:plan.aprobar:${UUID}`);
  });

  it('armar con args que no calzan es un error de programación', () => {
    expect(() => buildCustomId('tarea.tomar', 'WAT-44')).toThrow();
    expect(() => buildCustomId('tarea.tomar')).toThrow();
    expect(() => buildCustomId('tarea.tomar', null)).toThrow(); // uuid obligatorio
    expect(() => buildCustomId('msg.tarea.modal', SNOW, UUID)).toThrow();
  });

  it('rechaza lo que no es de roz, otra versión, acción desconocida o args raros', () => {
    expect(parseCustomId(undefined)).toEqual({ ok: false, reason: 'not_roz' });
    expect(parseCustomId('')).toEqual({ ok: false, reason: 'not_roz' });
    expect(parseCustomId('otra-app:boton')).toEqual({ ok: false, reason: 'not_roz' });
    expect(parseCustomId(`roz0:tarea.tomar:${UUID}`)).toEqual({ ok: false, reason: 'old_version' });
    expect(parseCustomId(`roz2:tarea.tomar:${UUID}`)).toEqual({ ok: false, reason: 'old_version' });
    expect(parseCustomId(`roz1:tarea.borrar:${UUID}`)).toEqual({ ok: false, reason: 'unknown_action' });
    expect(parseCustomId('roz1:toString')).toEqual({ ok: false, reason: 'unknown_action' });
    expect(parseCustomId('roz1:tarea.tomar:WAT-44')).toEqual({ ok: false, reason: 'bad_args' });
    expect(parseCustomId(`roz1:tarea.tomar:${UUID}:extra`)).toEqual({ ok: false, reason: 'bad_args' });
    expect(parseCustomId('roz1:tarea.tomar')).toEqual({ ok: false, reason: 'bad_args' });
    expect(parseCustomId('roz1:tarea.tomar:_')).toEqual({ ok: false, reason: 'bad_args' });
    expect(parseCustomId(`roz1:msg.tarea.modal:${SNOW}:abc`)).toEqual({ ok: false, reason: 'bad_args' });
    expect(parseCustomId(`roz1:tarea.tomar:${'a'.repeat(120)}`)).toEqual({ ok: false, reason: 'not_roz' });
  });

  it('cada acción tiene superficie y dueño conocidos', () => {
    const owners = new Set(['tarea', 'ticket', 'status', 'mensaje-crear-tarea', 'mensaje-citar', 'plan', 'pulso', 'infra', 'junta', 'mensaje-decision']);
    for (const action of CUSTOM_ID_ACTIONS) {
      const spec: CustomIdSpec = CUSTOM_ID_SPECS[action];
      expect(['button', 'select', 'modal']).toContain(spec.surface);
      expect(owners.has(spec.owner)).toBe(true);
      // Solo ids en los args: nunca texto libre.
      for (const k of spec.args) expect(['uuid', 'uuid?', 'snowflake']).toContain(k);
    }
  });
});
