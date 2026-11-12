import { describe, expect, it } from 'vitest';
import {
  CHAT_INPUT_NAME_RE,
  MESSAGE_COMMAND_KEYS,
  MESSAGE_COMMAND_NAMES,
  ROZ_COMMAND,
  ROZ_SUBCOMMANDS,
  commandCharCount,
  commandDefinitions,
  commandMenu,
  commandsHash,
  definitionsHash,
  messageCommandKeyOf,
  normalizeCommand,
  validateDefinitions,
  type CommandDef,
} from '../src/discord/commands/definitions.js';
import { COMMAND_TYPE, OPTION_TYPE } from '../src/discord/commands/types.js';

// Definición de /roz y de las acciones de mensaje contra las reglas de Discord (nombres, longitudes,
// orden de opciones, topes) y el hash con el que se decide si hay que volver a registrar.

describe('definición de comandos', () => {
  it('cumple las reglas de Discord', () => {
    expect(validateDefinitions()).toEqual([]);
  });

  it('/roz trae los 7 subcomandos en el orden del desplegable', () => {
    expect(ROZ_COMMAND.name).toBe('roz');
    expect(ROZ_COMMAND.type).toBe(COMMAND_TYPE.CHAT_INPUT);
    expect(ROZ_COMMAND.options!.map((o) => o.name)).toEqual([...ROZ_SUBCOMMANDS]);
    expect(ROZ_COMMAND.options!.every((o) => o.type === OPTION_TYPE.SUB_COMMAND)).toBe(true);
  });

  it('nombres en minúsculas, válidos y descripciones de 1 a 100', () => {
    const walk = (opts: CommandDef['options']) => {
      for (const o of opts ?? []) {
        expect(o.name).toMatch(CHAT_INPUT_NAME_RE);
        expect(o.name).toBe(o.name.toLowerCase());
        expect(o.description.length).toBeGreaterThan(0);
        expect(o.description.length).toBeLessThanOrEqual(100);
        walk(o.options);
      }
    };
    expect(ROZ_COMMAND.description.length).toBeLessThanOrEqual(100);
    walk(ROZ_COMMAND.options);
  });

  it('/roz tarea: buscar requerida con autocompletado, persona opcional', () => {
    const tarea = ROZ_COMMAND.options!.find((o) => o.name === 'tarea')!;
    expect(tarea.options!.map((o) => [o.name, !!o.required, !!o.autocomplete])).toEqual([
      ['buscar', true, true],
      ['persona', false, true],
    ]);
  });

  it('status no tiene opciones; los demás solo opciones de texto con autocompletado', () => {
    for (const sub of ROZ_COMMAND.options!) {
      if (sub.name === 'status') expect(sub.options).toBeUndefined();
      for (const o of sub.options ?? []) {
        expect(o.type).toBe(OPTION_TYPE.STRING);
        expect(o.autocomplete).toBe(true);
        expect(o.max_length).toBeLessThanOrEqual(100);
      }
    }
  });

  it('acciones de mensaje: nombres ≤ 32, sin descripción, ida y vuelta por nombre', () => {
    const msgs = commandDefinitions().filter((c) => c.type === COMMAND_TYPE.MESSAGE);
    expect(msgs.map((c) => c.name)).toEqual(['Crear tarea con roz', 'Guardar como decisión', 'Citar tareas']);
    for (const c of msgs) {
      expect(c.name.length).toBeLessThanOrEqual(32);
      expect(c.description).toBe('');
    }
    for (const key of MESSAGE_COMMAND_KEYS) expect(messageCommandKeyOf(MESSAGE_COMMAND_NAMES[key])).toBe(key);
    expect(messageCommandKeyOf('Otra cosa')).toBeNull();
  });

  it('cada comando cabe en 4000 caracteres', () => {
    for (const c of commandDefinitions()) expect(commandCharCount(c)).toBeLessThanOrEqual(4000);
  });
});

describe('validateDefinitions detecta lo que Discord rechazaría', () => {
  const base = (): CommandDef => JSON.parse(JSON.stringify(ROZ_COMMAND));

  it('nombre con mayúsculas o espacios', () => {
    const c = base();
    c.options![0]!.name = 'Tarea';
    expect(validateDefinitions([c]).join()).toMatch(/nombre inválido/);
    const d = base();
    d.name = 'roz bot';
    expect(validateDefinitions([d]).join()).toMatch(/nombre inválido/);
  });

  it('descripción vacía o de más de 100', () => {
    const c = base();
    c.options![1]!.description = 'x'.repeat(101);
    expect(validateDefinitions([c]).join()).toMatch(/descripción fuera de 1-100/);
    const d = base();
    d.description = '';
    expect(validateDefinitions([d]).join()).toMatch(/descripción fuera de 1-100/);
  });

  it('requerida después de una opcional', () => {
    const c = base();
    const tarea = c.options!.find((o) => o.name === 'tarea')!;
    tarea.options = [tarea.options![1]!, { ...tarea.options![0]!, required: true }];
    expect(validateDefinitions([c]).join()).toMatch(/requerida después de una opcional/);
  });

  it('autocompletado con choices, y más de 25 opciones', () => {
    const c = base();
    c.options![0]!.options![0]!.choices = [{ name: 'a', value: 'a' }];
    expect(validateDefinitions([c]).join()).toMatch(/autocomplete y choices/);
    const d = base();
    d.options = Array.from({ length: 26 }, (_, i) => ({ type: OPTION_TYPE.SUB_COMMAND, name: `s${i}`, description: 'x' }));
    expect(validateDefinitions([d]).join()).toMatch(/más de 25 opciones/);
  });

  it('comando de mensaje con descripción, nombre largo o más de 5', () => {
    const m = (name: string, description = ''): CommandDef => ({ type: COMMAND_TYPE.MESSAGE, name, description });
    expect(validateDefinitions([m('Algo', 'no va')]).join()).toMatch(/no lleva descripción/);
    expect(validateDefinitions([m('x'.repeat(33))]).join()).toMatch(/fuera de 1-32/);
    expect(validateDefinitions(['a', 'b', 'c', 'd', 'e', 'f'].map((n) => m(n))).join()).toMatch(/más de 5/);
  });

  it('más de 4000 caracteres', () => {
    const c = base();
    c.options = Array.from({ length: 25 }, (_, i) => ({
      type: OPTION_TYPE.SUB_COMMAND,
      name: `sub${i}`,
      description: 'd'.repeat(100),
      options: Array.from({ length: 2 }, (__, j) => ({ type: OPTION_TYPE.STRING, name: `o${j}`, description: 'e'.repeat(100) })),
    }));
    expect(validateDefinitions([c]).join()).toMatch(/más de 4000/);
  });
});

describe('hash de la definición', () => {
  it('es estable', () => {
    expect(definitionsHash()).toBe(definitionsHash());
    expect(definitionsHash()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('lo que devuelve Discord (con ids, versiones y false/null) hashea igual que lo nuestro', () => {
    // Forma típica de GET /applications/{app}/guilds/{guild}/commands: campos extra, `required`
    // omitido o false, localizaciones null, y los comandos en otro orden.
    const remote = commandDefinitions()
      .map((c, n) => ({
        id: `12345678901234567${n}`,
        application_id: '900000000000000001',
        guild_id: '100000000000000001',
        version: '1300000000000000000',
        default_member_permissions: null,
        nsfw: false,
        name_localizations: null,
        description_localizations: null,
        ...c,
        options: c.options?.map((o) => ({
          ...o,
          name_localizations: null,
          options: o.options?.map((x) => ({ ...x, required: x.required ?? false, autocomplete: x.autocomplete ?? false })),
        })),
      }))
      .reverse();
    expect(commandsHash(remote)).toBe(definitionsHash());
  });

  it('cambia si cambia una descripción, el orden de los subcomandos o se borra un comando', () => {
    const defs = commandDefinitions();
    const a = JSON.parse(JSON.stringify(defs)) as CommandDef[];
    a[0]!.options![0]!.description = 'Otra descripción';
    expect(commandsHash(a)).not.toBe(definitionsHash());
    const b = JSON.parse(JSON.stringify(defs)) as CommandDef[];
    b[0]!.options!.reverse();
    expect(commandsHash(b)).not.toBe(definitionsHash());
    expect(commandsHash(defs.slice(0, -1))).not.toBe(definitionsHash());
    expect(commandsHash([])).not.toBe(definitionsHash());
  });

  it('normalizeCommand descarta lo que no definimos', () => {
    expect(normalizeCommand({ id: '1', type: 3, name: 'X', description: '', version: '2', dm_permission: true })).toEqual({ type: 3, name: 'X', description: '' });
  });
});

describe('menú "/" del compositor de roz', () => {
  it('lista los mismos subcomandos con sus opciones', () => {
    const menu = commandMenu();
    expect(menu.map((m) => m.command)).toEqual(ROZ_SUBCOMMANDS.map((s) => `/roz ${s}`));
    expect(menu.find((m) => m.subcommand === 'tarea')!.options).toEqual([
      { name: 'buscar', description: 'Texto, ID (WAT-44) o persona', required: true },
      { name: 'persona', description: 'Solo tareas de esta persona', required: false },
    ]);
  });
});
